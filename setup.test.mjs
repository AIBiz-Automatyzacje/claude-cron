import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  copySkillDir,
  resolveNodeBinPath,
  mergeHookIntoSettings,
  removeHookFromSettings,
  buildHookSource,
  detectPortableNodeBin,
  isClaudeInstalled,
  upsertEnvLine,
  buildVpsUrl,
  buildFolderPickerCommand,
  parseFolderPickerResult,
  buildOpenBrowserCommand,
  buildSetUserEnvCommand,
  buildNotificationSettingsPayload,
  extractChatIdFromUpdates,
  parseNotifyChannelChoice,
  matchJobIdsByName,
  NODE_VERSION,
} from './setup.mjs';

// === resolveNodeBinPath — layout .node/ spójny z install.sh / install.ps1 ===

test('resolveNodeBinPath darwin → .../bin/node pod katalogiem dist', () => {
  const result = resolveNodeBinPath('darwin', '/repo/.node', NODE_VERSION, 'arm64');
  assert.equal(
    result,
    `/repo/.node/node-v${NODE_VERSION}-darwin-arm64/bin/node`,
  );
});

test('resolveNodeBinPath linux → .../bin/node', () => {
  const result = resolveNodeBinPath('linux', '/repo/.node', NODE_VERSION, 'x64');
  assert.equal(
    result,
    `/repo/.node/node-v${NODE_VERSION}-linux-x64/bin/node`,
  );
});

test('resolveNodeBinPath win32 → ...\\node.exe w korzeniu dist', () => {
  const result = resolveNodeBinPath('win32', 'C:\\repo\\.node', NODE_VERSION, 'x64');
  assert.equal(
    result,
    `C:\\repo\\.node\\node-v${NODE_VERSION}-win-x64\\node.exe`,
  );
});

test('resolveNodeBinPath odrzuca nieobsługiwaną platformę', () => {
  assert.throws(
    () => resolveNodeBinPath('sunos', '/repo/.node', NODE_VERSION, 'x64'),
    /Nieobsługiwana platforma/,
  );
});

// === mergeHookIntoSettings — idempotentny merge do hooks.UserPromptSubmit ===

test('mergeHookIntoSettings na pustym obiekcie dodaje wpis hooka', () => {
  const command = 'node "/ws/.claude/hooks/claude-cron-autostart.js"';
  const { settings, added } = mergeHookIntoSettings({}, command);

  assert.equal(added, true);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  const entry = settings.hooks.UserPromptSubmit[0];
  assert.equal(entry.matcher, '');
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, command);
});

test('mergeHookIntoSettings zachowuje istniejące, niepowiązane wpisy', () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: 'node other.js' }] },
      ],
    },
    otherKey: 'wartość',
  };
  const { settings, added } = mergeHookIntoSettings(existing, 'node "/ws/.claude/hooks/claude-cron-autostart.js"');

  assert.equal(added, true);
  assert.equal(settings.otherKey, 'wartość');
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
});

test('mergeHookIntoSettings jest idempotentny — nie duplikuje wpisu claude-cron-autostart', () => {
  const command = 'node "/ws/.claude/hooks/claude-cron-autostart.js"';
  const first = mergeHookIntoSettings({}, command);
  const second = mergeHookIntoSettings(first.settings, command);

  assert.equal(second.added, false);
  assert.equal(second.settings.hooks.UserPromptSubmit.length, 1);
});

test('mergeHookIntoSettings wykrywa istniejący wpis nawet przy innej ścieżce node', () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: '/old/node "/ws/.claude/hooks/claude-cron-autostart.js"' }],
        },
      ],
    },
  };
  const { added } = mergeHookIntoSettings(existing, '/new/node "/ws/.claude/hooks/claude-cron-autostart.js"');

  assert.equal(added, false);
});

// === removeHookFromSettings — uninstall lustrzany do mergeHookIntoSettings ===

test('removeHookFromSettings usuwa wpis claude-cron-autostart i czyści puste hooks', () => {
  const command = 'node "/ws/.claude/hooks/claude-cron-autostart.js"';
  const { settings: withHook } = mergeHookIntoSettings({}, command);
  const { settings, removed } = removeHookFromSettings(withHook);

  assert.equal(removed, true);
  assert.equal(settings.hooks, undefined);
});

test('removeHookFromSettings zachowuje niepowiązane wpisy UserPromptSubmit', () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: 'node other.js' }] },
        { matcher: '', hooks: [{ type: 'command', command: '/p/node "/ws/.claude/hooks/claude-cron-autostart.js"' }] },
      ],
    },
    otherKey: 'wartość',
  };
  const { settings, removed } = removeHookFromSettings(existing);

  assert.equal(removed, true);
  assert.equal(settings.otherKey, 'wartość');
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'node other.js');
});

test('removeHookFromSettings wykrywa wpis niezależnie od ścieżki node', () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: '/dowolny/inny/node "/ws/.claude/hooks/claude-cron-autostart.js"' }] },
      ],
    },
  };
  const { removed } = removeHookFromSettings(existing);

  assert.equal(removed, true);
});

test('removeHookFromSettings jest idempotentny — drugi przebieg nic nie usuwa', () => {
  const command = 'node "/ws/.claude/hooks/claude-cron-autostart.js"';
  const { settings: withHook } = mergeHookIntoSettings({}, command);
  const first = removeHookFromSettings(withHook);
  const second = removeHookFromSettings(first.settings);

  assert.equal(second.removed, false);
});

test('removeHookFromSettings na pustym/niewłaściwym wejściu nie rzuca i nie usuwa', () => {
  assert.deepEqual(removeHookFromSettings({}), { settings: {}, removed: false });
  assert.deepEqual(removeHookFromSettings(null), { settings: {}, removed: false });
  const noHooks = { otherKey: 'x' };
  const result = removeHookFromSettings(noHooks);
  assert.equal(result.removed, false);
  assert.equal(result.settings.otherKey, 'x');
});

// === buildHookSource — absolutna ścieżka node + flaga --disable-warning ===

test('buildHookSource wypala absolutną ścieżkę node (nie goły node) w spawn', () => {
  const nodeBin = '/repo/.node/node-v22.17.0-darwin-arm64/bin/node';
  const source = buildHookSource('/repo', nodeBin);

  assert.ok(source.includes(nodeBin), 'hook musi zawierać absolutną ścieżkę node');
  assert.ok(!/spawn\(\s*'node'/.test(source), 'hook nie może wołać gołego node');
});

test('buildHookSource dodaje flagę --disable-warning=ExperimentalWarning do args spawn', () => {
  const source = buildHookSource('/repo', '/repo/.node/.../bin/node');
  assert.ok(
    source.includes('--disable-warning=ExperimentalWarning'),
    'hook musi wyciszać ExperimentalWarning',
  );
});

test('buildHookSource zawiera ścieżkę repo jako cwd detached procesu', () => {
  const source = buildHookSource('/repo/claude-cron', '/repo/claude-cron/.node/x/bin/node');
  assert.ok(source.includes('/repo/claude-cron'), 'hook musi znać cwd repo');
});

test('buildHookSource trzyma guard darwin dla caffeinate', () => {
  const source = buildHookSource('/repo', '/repo/.node/x/bin/node');
  assert.ok(source.includes("process.platform === 'darwin'"), 'caffeinate pod guardem darwin');
  assert.ok(source.includes('caffeinate'));
});

// === detectPortableNodeBin — execPath-match vs fallback (logika R7) ===

test('detectPortableNodeBin zwraca execPath gdy wskazuje na .node/ (portable Node odpalił setup)', () => {
  const execPath = `${path.sep}repo${path.sep}.node${path.sep}node-v${NODE_VERSION}-darwin-arm64${path.sep}bin${path.sep}node`;
  const result = detectPortableNodeBin(execPath, 'darwin', '/repo', 'arm64');
  assert.equal(result, execPath);
});

test('detectPortableNodeBin fallback buduje ścieżkę z layoutu .node/ gdy execPath spoza .node/', () => {
  // Oczekiwanie joinem platformy DOCELOWEJ (posix dla darwin), nie runnera —
  // path.join na Windows dawał backslashe i test failował mimo poprawnego kontraktu
  const result = detectPortableNodeBin('/usr/local/bin/node', 'darwin', '/repo', 'arm64');
  assert.equal(
    result,
    path.posix.join('/repo', '.node', `node-v${NODE_VERSION}-darwin-arm64`, 'bin', 'node'),
  );
});

test('detectPortableNodeBin fallback dla win32 buduje windowsową ścieżkę z node.exe', () => {
  const result = detectPortableNodeBin('C:\\Program Files\\nodejs\\node.exe', 'win32', 'C:\\repo', 'x64');
  assert.equal(
    result,
    path.win32.join('C:\\repo', '.node', `node-v${NODE_VERSION}-win-x64`, 'node.exe'),
  );
});

// === isClaudeInstalled — DI probe (rdzeń R9) ===

test('isClaudeInstalled → true gdy probe zwraca status 0 (Claude w PATH)', () => {
  const result = isClaudeInstalled(() => ({ status: 0 }));
  assert.equal(result, true);
});

test('isClaudeInstalled → false gdy probe zwraca status 1 (brak Claude)', () => {
  const result = isClaudeInstalled(() => ({ status: 1 }));
  assert.equal(result, false);
});

// === upsertEnvLine — idempotentna persystencja export VAR w shell RC ===

test('upsertEnvLine dopisuje export gdy zmiennej nie ma w treści', () => {
  const result = upsertEnvLine('# moje rc\nexport PATH=/x\n', 'CLAUDE_CRON_WORKSPACE', '/ws', 'Claude-Cron workspace');
  assert.ok(result.includes('export CLAUDE_CRON_WORKSPACE="/ws"'));
  assert.ok(result.includes('export PATH=/x'), 'istniejąca treść zachowana');
  assert.ok(result.includes('# Claude-Cron workspace'));
});

test('upsertEnvLine podmienia istniejącą linię (idempotentny re-run, brak duplikatu)', () => {
  const initial = upsertEnvLine('', 'CLAUDE_CRON_VPS_URL', 'http://old:7777');
  const updated = upsertEnvLine(initial, 'CLAUDE_CRON_VPS_URL', 'http://new:7777');
  const occurrences = updated.match(/export CLAUDE_CRON_VPS_URL=/g) || [];
  assert.equal(occurrences.length, 1, 'tylko jedna linia export — bez duplikatu');
  assert.ok(updated.includes('export CLAUDE_CRON_VPS_URL="http://new:7777"'));
});

// === buildVpsUrl — host+port → URL, pusty host → null ===

test('buildVpsUrl składa URL z hosta i portu', () => {
  assert.equal(buildVpsUrl('100.64.0.1', '7777'), 'http://100.64.0.1:7777');
});

test('buildVpsUrl domyślny port 7777 gdy port pusty', () => {
  assert.equal(buildVpsUrl('100.64.0.1', ''), 'http://100.64.0.1:7777');
});

test('buildVpsUrl zwraca null dla pustego/białego hosta (tryb tylko lokalny)', () => {
  assert.equal(buildVpsUrl('', '7777'), null);
  assert.equal(buildVpsUrl('   ', '7777'), null);
});

// === buildFolderPickerCommand — natywne okno wyboru folderu per OS ===

test('buildFolderPickerCommand darwin → osascript choose folder z promptem', () => {
  const cmd = buildFolderPickerCommand('darwin', 'Wybierz vault');
  assert.equal(cmd.cmd, 'osascript');
  assert.ok(cmd.args.join(' ').includes('choose folder'));
  assert.ok(cmd.args.join(' ').includes('Wybierz vault'));
});

test('buildFolderPickerCommand win32 → powershell FolderBrowserDialog', () => {
  const cmd = buildFolderPickerCommand('win32', 'Wybierz vault');
  assert.equal(cmd.cmd, 'powershell');
  assert.ok(cmd.args.join(' ').includes('FolderBrowserDialog'));
});

test('buildFolderPickerCommand escapuje cudzysłów w promptcie (darwin)', () => {
  const cmd = buildFolderPickerCommand('darwin', 'A "B" C');
  assert.ok(cmd.args.some((a) => a.includes('A \\"B\\" C')));
});

test('buildFolderPickerCommand zwraca null dla platformy bez GUI pickera (linux)', () => {
  assert.equal(buildFolderPickerCommand('linux', 'x'), null);
});

// === parseFolderPickerResult — wynik spawna → ścieżka albo null ===

test('parseFolderPickerResult zwraca przyciętą ścieżkę przy status 0', () => {
  assert.equal(
    parseFolderPickerResult({ status: 0, stdout: '/Users/x/vault/\n' }),
    '/Users/x/vault/',
  );
});

test('parseFolderPickerResult → null przy anulowaniu osascript (status 1)', () => {
  assert.equal(parseFolderPickerResult({ status: 1, stdout: '' }), null);
});

test('parseFolderPickerResult → null przy anulowaniu PowerShell (status 0, pusty stdout)', () => {
  assert.equal(parseFolderPickerResult({ status: 0, stdout: '  \n' }), null);
});

test('parseFolderPickerResult → null gdy brak binarki/GUI (status null, error)', () => {
  assert.equal(parseFolderPickerResult({ status: null, error: new Error('ENOENT') }), null);
  assert.equal(parseFolderPickerResult(null), null);
});

// === buildOpenBrowserCommand — auto-open URL w przeglądarce per OS (Mac/Win) ===

test('buildOpenBrowserCommand darwin → open z URL (happy path)', () => {
  const cmd = buildOpenBrowserCommand('darwin', 'http://localhost:7777');
  assert.equal(cmd.cmd, 'open');
  assert.deepEqual(cmd.args, ['http://localhost:7777']);
});

test('buildOpenBrowserCommand win32 → cmd start z URL', () => {
  const cmd = buildOpenBrowserCommand('win32', 'http://localhost:7777');
  assert.equal(cmd.cmd, 'cmd');
  assert.ok(cmd.args.includes('start'), 'win32 musi użyć start do otwarcia URL');
  assert.ok(cmd.args.includes('http://localhost:7777'), 'URL musi trafić do args');
});

test('buildOpenBrowserCommand linux → null (caller nie spawnuje, link wypisany)', () => {
  assert.equal(buildOpenBrowserCommand('linux', 'http://localhost:7777'), null);
});

// === buildSetUserEnvCommand — persystencja env do User Environment na Windows ===

test('buildSetUserEnvCommand → powershell SetEnvironmentVariable w User scope (happy path)', () => {
  const { cmd, args } = buildSetUserEnvCommand('CLAUDE_CRON_WORKSPACE', 'C:\\Users\\a\\vault');
  assert.equal(cmd, 'powershell');
  assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.ok(
    args[2].includes("[Environment]::SetEnvironmentVariable('CLAUDE_CRON_WORKSPACE', 'C:\\Users\\a\\vault', 'User')"),
    'backslashe ścieżki muszą zostać dosłowne (single-quote), scope = User',
  );
});

test('buildSetUserEnvCommand escapuje pojedynczy cudzysłów w wartości (error case: iniekcja)', () => {
  const { args } = buildSetUserEnvCommand('X', "a'b");
  assert.ok(args[2].includes("'a''b'"), "pojedynczy ' musi być podwojony na '' (literał PS)");
});

// === buildNotificationSettingsPayload — odpowiedzi setupu → payload state (Unit 6) ===

test('buildNotificationSettingsPayload zawiera tylko wypełnione pola (klucze state)', () => {
  const payload = buildNotificationSettingsPayload({
    discordWebhookUrl: 'https://discord.com/api/webhooks/1/x',
    telegramBotToken: '',
    telegramChatId: '   ',
  });
  assert.deepEqual(payload, { discord_webhook_url: 'https://discord.com/api/webhooks/1/x' });
});

test('buildNotificationSettingsPayload trimuje wartości i mapuje na klucze snake_case', () => {
  const payload = buildNotificationSettingsPayload({
    discordWebhookUrl: '',
    telegramBotToken: ' 123456:ABC-def ',
    telegramChatId: ' 42 ',
  });
  assert.deepEqual(payload, { telegram_bot_token: '123456:ABC-def', telegram_chat_id: '42' });
});

test('buildNotificationSettingsPayload → null gdy wszystko puste (pomiń zapis i push)', () => {
  assert.equal(
    buildNotificationSettingsPayload({ discordWebhookUrl: '', telegramBotToken: '', telegramChatId: '' }),
    null,
  );
  assert.equal(buildNotificationSettingsPayload({}), null);
});

// === extractChatIdFromUpdates — odpowiedź getUpdates → chat ID albo null (Unit 6) ===

test('extractChatIdFromUpdates: jedna rozmowa → chat ID jako string', () => {
  const json = { ok: true, result: [{ update_id: 10, message: { chat: { id: 123456 } } }] };
  assert.equal(extractChatIdFromUpdates(json), '123456');
});

test('extractChatIdFromUpdates: brak update\'ów → null (przejście na ręczny fallback)', () => {
  assert.equal(extractChatIdFromUpdates({ ok: true, result: [] }), null);
});

test('extractChatIdFromUpdates: wiele czatów → najnowszy (ostatni update, ujemne ID grupy)', () => {
  const json = {
    ok: true,
    result: [
      { update_id: 1, message: { chat: { id: 111 } } },
      { update_id: 2, message: { chat: { id: 222 } } },
      { update_id: 3, message: { chat: { id: -100333 } } },
    ],
  };
  assert.equal(extractChatIdFromUpdates(json), '-100333');
});

test('extractChatIdFromUpdates: ok:false / malformed / update bez message → null', () => {
  assert.equal(extractChatIdFromUpdates(null), null);
  assert.equal(extractChatIdFromUpdates({ ok: false, result: [] }), null);
  assert.equal(extractChatIdFromUpdates({ ok: true }), null);
  assert.equal(extractChatIdFromUpdates({ ok: true, result: [{ update_id: 5 }] }), null);
});

// === parseNotifyChannelChoice — wybór kanału powiadomień w setupie ===

test('parseNotifyChannelChoice: numer lub nazwa kanału → identyfikator kanału', () => {
  assert.equal(parseNotifyChannelChoice('1'), 'discord');
  assert.equal(parseNotifyChannelChoice('2'), 'telegram');
  assert.equal(parseNotifyChannelChoice(' Discord '), 'discord');
  assert.equal(parseNotifyChannelChoice('TELEGRAM'), 'telegram');
});

test('parseNotifyChannelChoice: puste / nierozpoznane → null (pomiń powiadomienia)', () => {
  assert.equal(parseNotifyChannelChoice(''), null);
  assert.equal(parseNotifyChannelChoice('3'), null);
  assert.equal(parseNotifyChannelChoice('voice'), null);
  assert.equal(parseNotifyChannelChoice(undefined), null);
});

// === copySkillDir — instalacja skilla puls do ~/.claude/skills (Unit 9) ===

// Katalog roboczy per test w tmp — testy nie dotykają repo ani ~/.claude usera.
function makeSkillFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-skill-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const src = path.join(base, 'repo', 'skills', 'puls');
  fs.mkdirSync(path.join(src, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: puls\n---\ntreść', 'utf-8');
  fs.writeFileSync(path.join(src, 'resources', 'extra.md'), 'extra', 'utf-8');
  return { base, src };
}

test('copySkillDir kopiuje całe drzewo i tworzy nieistniejący katalog docelowy', (t) => {
  const { base, src } = makeSkillFixture(t);
  // Cel z brakującymi rodzicami (.claude/skills nie istnieje) — jak świeży home.
  const dest = path.join(base, 'home', '.claude', 'skills', 'puls');

  copySkillDir(src, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8'), '---\nname: puls\n---\ntreść');
  assert.equal(fs.readFileSync(path.join(dest, 'resources', 'extra.md'), 'utf-8'), 'extra');
});

test('copySkillDir nadpisuje istniejące pliki przy re-run (aktualizacja skilla)', (t) => {
  const { base, src } = makeSkillFixture(t);
  const dest = path.join(base, 'home', '.claude', 'skills', 'puls');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), 'stara wersja', 'utf-8');

  copySkillDir(src, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8'), '---\nname: puls\n---\ntreść');
});

test('copySkillDir rzuca gdy katalog źródłowy nie istnieje (error case)', (t) => {
  const { base } = makeSkillFixture(t);
  const missingSrc = path.join(base, 'repo', 'skills', 'nie-ma');
  const dest = path.join(base, 'home', '.claude', 'skills', 'puls');

  assert.throws(() => copySkillDir(missingSrc, dest), /ENOENT/);
});

// === matchJobIdsByName — mapowanie seedowanych nazw na id-ki z GET /api/jobs ===
// (sync harmonogramów seedu z działającym serwerem przy re-run setupu)

test('matchJobIdsByName zwraca id-ki tylko jobów o seedowanych nazwach (happy path)', () => {
  const jobs = [
    { id: 1, name: 'Daily memory update' },
    { id: 2, name: 'Własny job usera' },
    { id: 3, name: 'Reflect tygodniowy' },
  ];

  const ids = matchJobIdsByName(jobs, ['Daily memory update', 'Reflect tygodniowy']);

  assert.deepEqual(ids, [1, 3]);
});

test('matchJobIdsByName → [] gdy żadna nazwa nie pasuje albo lista jobów pusta', () => {
  assert.deepEqual(matchJobIdsByName([{ id: 1, name: 'Inny' }], ['Nie ma']), []);
  assert.deepEqual(matchJobIdsByName([], ['Daily memory update']), []);
});

test('matchJobIdsByName odporny na nie-tablicowy input z API (error case)', () => {
  assert.deepEqual(matchJobIdsByName(null, ['Daily memory update']), []);
  assert.deepEqual(matchJobIdsByName({ error: 'boom' }, ['Daily memory update']), []);
});
