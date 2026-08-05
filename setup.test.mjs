import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

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
  parseInviteCode,
  upsertDotenvLine,
  askInboxInvite,
  resolveInstallVersionInput,
  NODE_VERSION,
  DEFAULT_DASHBOARD_PORT,
  PORT_STATE,
  buildDashboardUrl,
  parsePortAnswer,
  isPulsStatusPayload,
  classifyPortState,
  buildPortBusyMessage,
  buildPortReuseMessage,
  resolveDashboardPort,
  probeDashboardPort,
  PORT_RESOLVE_ATTEMPTS,
  buildStaleHookPortWarning,
  isSameInstallation,
  buildOtherPulsMessage,
  pickInitialPort,
  readEnvLineValue,
  buildGetUserEnvCommand,
  mergeEnvIntoSettings,
  registerPulsHomeEnv,
  writePulsHomePointer,
  defaultPulsHomePointer,
} from './setup.mjs';

import http from 'node:http';

const require = createRequire(import.meta.url);
const db = require('./lib/db');
const { ROLE_STATE_KEY } = require('./lib/inbox-seed');

// askInboxInvite zapisuje rolę maszyny PRAWDZIWYM modułem lib/db — bez override'u ścieżki
// testy dopisywałyby do operatorskiej data/claude-cron.db. ':memory:' odpada: funkcja zamyka
// połączenie po zapisie, a baza w pamięci ginie razem z nim (nie byłoby czego odczytać).
const TEST_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-setup-db-'));
db.setDbPath(path.join(TEST_DB_DIR, 'setup-test.db'));
after(() => {
  db.close();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

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

// === mergeEnvIntoSettings + PULS_HOME — wskaźnik instalacji dla skilli w vaulcie ===

test('mergeEnvIntoSettings dodaje PULS_HOME do pustego settings.json', () => {
  const { settings, changed } = mergeEnvIntoSettings({}, 'PULS_HOME', '/opt/puls');

  assert.equal(changed, true);
  assert.equal(settings.env.PULS_HOME, '/opt/puls');
});

test('mergeEnvIntoSettings zachowuje istniejący env i wpis hooka', () => {
  const command = 'node "/ws/.claude/hooks/claude-cron-autostart.js"';
  const { settings: withHook } = mergeHookIntoSettings({ env: { INNE: 'x' } }, command);

  const { settings, changed } = mergeEnvIntoSettings(withHook, 'PULS_HOME', '/opt/puls');

  assert.equal(changed, true);
  assert.equal(settings.env.INNE, 'x');
  assert.equal(settings.env.PULS_HOME, '/opt/puls');
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, command);
});

test('mergeEnvIntoSettings z tą samą wartością nie zgłasza zmiany (idempotencja)', () => {
  const first = mergeEnvIntoSettings({}, 'PULS_HOME', '/opt/puls');
  const second = mergeEnvIntoSettings(first.settings, 'PULS_HOME', '/opt/puls');

  assert.equal(second.changed, false);
  assert.equal(second.settings.env.PULS_HOME, '/opt/puls');
});

test('registerPulsHomeEnv na re-runie nie dotyka pliku', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-home-settings-'));
  const settingsFile = path.join(dir, '.claude', 'settings.json');

  assert.equal(registerPulsHomeEnv(dir, '/opt/puls'), true);
  const firstContent = fs.readFileSync(settingsFile, 'utf-8');
  const mtimeBefore = fs.statSync(settingsFile).mtimeMs;

  assert.equal(registerPulsHomeEnv(dir, '/opt/puls'), false);
  assert.equal(fs.readFileSync(settingsFile, 'utf-8'), firstContent);
  assert.equal(fs.statSync(settingsFile).mtimeMs, mtimeBefore);
  assert.equal(JSON.parse(firstContent).env.PULS_HOME, '/opt/puls');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerPulsHomeEnv na uszkodzonym settings.json robi fail-fast i NIE tyka pliku', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-home-broken-'));
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  const broken = '{ "permissions": [ ,, }';
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, broken, 'utf-8');

  assert.throws(() => registerPulsHomeEnv(dir, '/opt/puls'), /niepoprawnym JSON-em/);
  assert.equal(fs.readFileSync(settingsFile, 'utf-8'), broken);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePulsHomePointer zapisuje FAKTYCZNY katalog instalacji, nie domyślny', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-home-pointer-'));
  const pointer = path.join(dir, '.claude-cron-home');
  const installDir = '/Users/ktoś/Documents/Kodowanie/claude-cron';

  const written = writePulsHomePointer(installDir, pointer);

  assert.equal(written, pointer);
  assert.equal(fs.readFileSync(pointer, 'utf-8').trim(), installDir);
  assert.notEqual(fs.readFileSync(pointer, 'utf-8').trim(), path.join(os.homedir(), 'claude-cron'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultPulsHomePointer trzyma konwencję ~/.claude-cron-*', () => {
  assert.equal(defaultPulsHomePointer('/home/u'), '/home/u/.claude-cron-home');
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

// === parseInviteCode — odwrotnik buildInviteCode (server.js) dla onboardingu skrzynki (IU-3.2) ===

test('parseInviteCode happy path: puls-inbox:<url>#<token> → hubUrl + token', () => {
  const result = parseInviteCode('puls-inbox:https://kacper.tail-scale.ts.net#tok-abc123');
  assert.deepEqual(result, { hubUrl: 'https://kacper.tail-scale.ts.net', token: 'tok-abc123' });
});

test('parseInviteCode trimuje otaczające białe znaki (wklejenie z bufora)', () => {
  const result = parseInviteCode('  puls-inbox:https://hub.example#tok42  ');
  assert.deepEqual(result, { hubUrl: 'https://hub.example', token: 'tok42' });
});

test('parseInviteCode error: zły prefiks → null', () => {
  assert.equal(parseInviteCode('inbox:https://hub.example#tok'), null);
  assert.equal(parseInviteCode('https://hub.example#tok'), null);
});

test('parseInviteCode error: brak `#` (brak separatora tokenu) → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example'), null);
});

test('parseInviteCode error: pusty token → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#   '), null);
});

test('parseInviteCode error: pusty URL → null', () => {
  assert.equal(parseInviteCode('puls-inbox:#tok'), null);
});

test('parseInviteCode error: URL nie-http (śmieć / zły protokół) → null', () => {
  assert.equal(parseInviteCode('puls-inbox:ftp://hub.example#tok'), null);
  assert.equal(parseInviteCode('puls-inbox:nie-url#tok'), null);
});

test('parseInviteCode error: nie-string / puste wejście → null', () => {
  assert.equal(parseInviteCode(''), null);
  assert.equal(parseInviteCode(null), null);
  assert.equal(parseInviteCode(undefined), null);
});

// === upsertDotenvLine — idempotentny zapis KEY=value do workspace .env (format env-loader) ===

test('upsertDotenvLine dopisuje KEY="value" gdy klucza nie ma (bez export)', () => {
  const result = upsertDotenvLine('CLAUDE_CRON_WORKSPACE="/ws"\n', 'INBOX_HUB_URL', 'https://hub.example');
  assert.ok(result.includes('INBOX_HUB_URL="https://hub.example"'));
  assert.ok(result.includes('CLAUDE_CRON_WORKSPACE="/ws"'), 'istniejąca treść zachowana');
  assert.ok(!result.includes('export INBOX_HUB_URL'), 'format .env bez prefiksu export');
});

test('upsertDotenvLine podmienia istniejącą linię (idempotentny re-run, brak duplikatu)', () => {
  const initial = upsertDotenvLine('', 'INBOX_TOKEN', 'stary');
  const updated = upsertDotenvLine(initial, 'INBOX_TOKEN', 'nowy');
  const occurrences = updated.match(/INBOX_TOKEN=/g) || [];
  assert.equal(occurrences.length, 1, 'tylko jedna linia — bez duplikatu');
  assert.ok(updated.includes('INBOX_TOKEN="nowy"'));
});

test('upsertDotenvLine dokłada brakujący newline przed nową linią', () => {
  const result = upsertDotenvLine('INBOX_HUB_URL="https://hub"', 'INBOX_TOKEN', 'tok');
  assert.equal(result, 'INBOX_HUB_URL="https://hub"\nINBOX_TOKEN="tok"\n');
});

// === askInboxInvite — onboarding skrzynki: probe waliduje ZANIM zapisze (IU-3.2) ===
// Fake rl zwracający wklejony kod; lokalny serwer HTTP udaje huba (probe przez inbox-client).

function fakeRl(answer) {
  return { question: async () => answer };
}

// Snapshot env INBOX_* — probe je tymczasowo ustawia; testy nie mogą zostawić side-effectu.
function snapshotInboxEnv(t) {
  const prev = { url: process.env.INBOX_HUB_URL, token: process.env.INBOX_TOKEN };
  t.after(() => {
    if (prev.url === undefined) delete process.env.INBOX_HUB_URL;
    else process.env.INBOX_HUB_URL = prev.url;
    if (prev.token === undefined) delete process.env.INBOX_TOKEN;
    else process.env.INBOX_TOKEN = prev.token;
  });
}

// Lokalny hub: KAŻDE żądanie → 200 z podanym JSON body (probe trafia /inbox/v1/:token/ping).
async function startFakeHub(t, responseBody) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// Sekret skrzynki mieszka POZA vaultem (review fazy 3, P1: job auto-reply spawnuje
// `claude -p` z cwd = vault i Read/Glob/Grep, a promptem jest treść cudzej wiadomości —
// token w vaultcie = eksfiltracja tożsamości jednym pytaniem). Testy wskazują jego plik
// przez INBOX_ENV_FILE, w katalogu ROZŁĄCZNYM z workspace'em.
let currentSecretFile = null;

function makeWorkspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-inbox-ws-'));
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-inbox-secret-'));
  const prev = process.env.INBOX_ENV_FILE;
  currentSecretFile = path.join(secretDir, 'inbox.env');
  process.env.INBOX_ENV_FILE = currentSecretFile;
  t.after(() => {
    if (prev === undefined) delete process.env.INBOX_ENV_FILE;
    else process.env.INBOX_ENV_FILE = prev;
    currentSecretFile = null;
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  });
  return ws;
}

function secretPath() {
  return currentSecretFile;
}

test('askInboxInvite: puste wejście → pomija, nie tworzy .env', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);

  await askInboxInvite(fakeRl(''), ws);

  assert.equal(fs.existsSync(secretPath()), false, 'brak kodu = brak zapisu');
});

test('askInboxInvite: zły format kodu → pomija bez rzucania, .env nie powstaje', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);

  await askInboxInvite(fakeRl('nie-jest-kodem'), ws);

  assert.equal(fs.existsSync(secretPath()), false);
});

test('askInboxInvite: probe-fail (zła wersja huba) NIE rzuca i NIE zapisuje env', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 2, user: 'ktoś' }); // mismatch: klient oczekuje v:1

  // Nie rzuca (wzorzec notify-push: warn przy padzie, nie fail setupu).
  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-abc`), ws);

  assert.equal(fs.existsSync(secretPath()), false, 'pad probe = env NIE zapisany');
});

test('askInboxInvite: probe OK (v:1) → zapisuje INBOX_HUB_URL/INBOX_TOKEN do pliku sekretu POZA vaultem', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });

  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-xyz`), ws);

  const envContent = fs.readFileSync(secretPath(), 'utf-8');
  assert.ok(envContent.includes(`INBOX_HUB_URL="${hubUrl}"`), 'hub URL zapisany');
  assert.ok(envContent.includes('INBOX_TOKEN="tok-xyz"'), 'token zapisany');
  // Vault jest cwd asystenta auto-reply, który czyta pliki na polecenie obcej osoby.
  assert.equal(fs.existsSync(path.join(ws, '.env')), false, 'token NIE trafia do drzewa vaulta');
});

test('askInboxInvite: LEGACY .env z tokenem w vaultcie zostaje wyczyszczony przy onboardingu', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);
  const legacy = path.join(ws, '.env');
  fs.writeFileSync(legacy, 'INBOX_TOKEN="stary-tok"\nOBSIDIAN_KEY="zostaje"\n', 'utf-8');
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });

  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-nowy`), ws);

  const legacyContent = fs.readFileSync(legacy, 'utf-8');
  assert.ok(!legacyContent.includes('stary-tok'), 'sekret z poprzedniej wersji znika z vaulta');
  assert.ok(!legacyContent.includes('INBOX_TOKEN'), 'klucz tokenu usunięty ze starej lokalizacji');
  assert.ok(legacyContent.includes('OBSIDIAN_KEY="zostaje"'), 'cudze klucze nietknięte');
});

test('askInboxInvite: probe nie zostawia INBOX_* w process.env (bez side-effectu)', async (t) => {
  snapshotInboxEnv(t);
  delete process.env.INBOX_HUB_URL;
  delete process.env.INBOX_TOKEN;
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });

  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-xyz`), ws);

  assert.equal(process.env.INBOX_HUB_URL, undefined, 'probe przywraca env po sobie');
  assert.equal(process.env.INBOX_TOKEN, undefined);
});

// === askInboxInvite — guard .gitignore + rola maszyny (IU-2.3) ===
// Mockujemy WYŁĄCZNIE świat zewnętrzny: gita (przez `ensureIgnored`) i zapis roli tam, gdzie
// dowodem jest „state NIE został dotknięty". Zapis `.env` jest prawdziwy — to on jest dowodem.

function captureLogs(t) {
  const saved = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  t.after(() => { console.log = saved; });
  return logs;
}

// Rejestrator wywołań guardu — pozwala udowodnić, że ścieżki bez zapisu w ogóle o niego
// nie pytają (nie dotykamy `.gitignore` osoby, która skrzynki nie konfiguruje).
function guardRecorder(status, gitignoreFile = '/ws/.gitignore') {
  const calls = [];
  return {
    calls,
    ensureIgnored: (workspace) => {
      calls.push(workspace);
      return { status, gitignoreFile };
    },
  };
}

function roleRecorder() {
  const calls = [];
  return { calls, setRole: () => { calls.push('setRole'); } };
}

test('askInboxInvite: guard ok → .env zapisany, rola maszyny „client" w state', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });
  const guard = guardRecorder('ok', path.join(ws, '.gitignore'));
  db.setState(ROLE_STATE_KEY, 'sentinel'); // dowód, że rolę zapisał TEN przebieg

  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-ok`), ws, { ensureIgnored: guard.ensureIgnored });

  assert.equal(fs.existsSync(secretPath()), true, 'guard przepuścił = zapisujemy');
  assert.equal(db.getState(ROLE_STATE_KEY), 'client', 'laptop człowieka to klient skrzynki');
  assert.deepEqual(guard.calls, [ws], 'guard pytany o workspace, do którego piszemy');
});

test('askInboxInvite: guard fixed → zapis wykonany, komunikat mówi o zmianie w .gitignore', async (t) => {
  snapshotInboxEnv(t);
  const logs = captureLogs(t);
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });
  const gitignoreFile = path.join(ws, '.gitignore');
  const role = roleRecorder();

  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-fix`), ws, {
    ensureIgnored: () => ({ status: 'fixed', gitignoreFile }),
    setRole: role.setRole,
  });

  assert.equal(fs.existsSync(secretPath()), true, 'naprawiony .gitignore = zapis wolno wykonać');
  assert.deepEqual(role.calls, ['setRole']);
  const output = logs.join('\n');
  assert.match(output, /\.gitignore/, 'użytkownik ma wiedzieć, że instalator zmienił jego repozytorium');
  assert.match(output, /\.env\*/, 'komunikat nazywa dopisany wzorzec');
});

test('askInboxInvite: guard unfixable → brak .env, brak roli, instrukcja naprawy, setup leci dalej', async (t) => {
  snapshotInboxEnv(t);
  const logs = captureLogs(t);
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });
  const role = roleRecorder();

  // Brak rzutu = setup kontynuowany (kontrakt: warn + pominięcie, nigdy przerwanie instalacji).
  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-bad`), ws, {
    ensureIgnored: () => ({ status: 'unfixable', gitignoreFile: path.join(ws, '.gitignore') }),
    setRole: role.setRole,
  });

  assert.equal(fs.existsSync(secretPath()), false, 'sekret w repozytorium jest nieodwracalny — nie zapisujemy');
  assert.deepEqual(role.calls, [], 'bez konfiguracji rola nie ma prawa trafić do state');
  assert.match(logs.join('\n'), /git rm --cached/, 'komunikat niesie konkretną instrukcję naprawy');
});

test('askInboxInvite: guard unknown (git niedostępny) → fail-closed, brak .env i brak roli', async (t) => {
  snapshotInboxEnv(t);
  const logs = captureLogs(t);
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });
  const role = roleRecorder();

  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-unk`), ws, {
    ensureIgnored: () => ({ status: 'unknown', gitignoreFile: path.join(ws, '.gitignore') }),
    setRole: role.setRole,
  });

  assert.equal(fs.existsSync(secretPath()), false, 'nierozstrzygnięty guard odmawia operacji');
  assert.deepEqual(role.calls, []);
  assert.match(logs.join('\n'), /git/i, 'człowiek musi wiedzieć, czego brakuje');
});

test('askInboxInvite: puste wejście → guard w ogóle nie pytany (nie dotykamy cudzego .gitignore)', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);
  const guard = guardRecorder('ok');
  const role = roleRecorder();

  await askInboxInvite(fakeRl(''), ws, { ensureIgnored: guard.ensureIgnored, setRole: role.setRole });

  assert.deepEqual(guard.calls, []);
  assert.deepEqual(role.calls, []);
});

test('askInboxInvite: zły format kodu → guard nie pytany, zero zapisów', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);
  const guard = guardRecorder('ok');
  const role = roleRecorder();

  await askInboxInvite(fakeRl('nie-jest-kodem'), ws, { ensureIgnored: guard.ensureIgnored, setRole: role.setRole });

  assert.deepEqual(guard.calls, [], 'walidacja formatu jest czysta — bez skutków ubocznych');
  assert.deepEqual(role.calls, []);
  assert.equal(fs.existsSync(secretPath()), false);
});

test('askInboxInvite: pad probe → guard nie pytany (walidacja kodu przed skutkami ubocznymi)', async (t) => {
  snapshotInboxEnv(t);
  const ws = makeWorkspace(t);
  const hubUrl = await startFakeHub(t, { v: 2, user: 'ktoś' }); // mismatch wersji API
  const guard = guardRecorder('ok');
  const role = roleRecorder();

  await askInboxInvite(fakeRl(`puls-inbox:${hubUrl}#tok-probe`), ws, {
    ensureIgnored: guard.ensureIgnored,
    setRole: role.setRole,
  });

  assert.deepEqual(guard.calls, [], 'zły kod nie może zmieniać .gitignore użytkownika');
  assert.deepEqual(role.calls, []);
  assert.equal(fs.existsSync(secretPath()), false);
});

// === Port dashboardu (R9) — wykrycie kolizji i wybór portu ===

test('parsePortAnswer: pusta odpowiedź → fallback (Enter zostawia bieżący port)', () => {
  assert.equal(parsePortAnswer('', 7777), 7777);
  assert.equal(parsePortAnswer('   ', 8080), 8080);
  assert.equal(parsePortAnswer(undefined, 7777), 7777);
});

test('parsePortAnswer: poprawny numer → liczba', () => {
  assert.equal(parsePortAnswer('8080', 7777), 8080);
  assert.equal(parsePortAnswer(' 1 ', 7777), 1);
  assert.equal(parsePortAnswer('65535', 7777), 65535);
});

test('parsePortAnswer: śmieć i wartości poza zakresem → null (nie cichy fallback)', () => {
  assert.equal(parsePortAnswer('7777x', 7777), null, 'śmieć nie może przejść jako 7777');
  assert.equal(parsePortAnswer('abc', 7777), null);
  assert.equal(parsePortAnswer('0', 7777), null);
  assert.equal(parsePortAnswer('65536', 7777), null);
  assert.equal(parsePortAnswer('-1', 7777), null);
});

test('isPulsStatusPayload: kontrakt GET /api/status → true', () => {
  assert.equal(
    isPulsStatusPayload({ uptime: 12, queue_length: 0, total_jobs: 4, enabled_jobs: 3 }),
    true,
  );
});

test('isPulsStatusPayload: obce JSON-owe API na tym porcie → false', () => {
  assert.equal(isPulsStatusPayload({ status: 'ok' }), false);
  assert.equal(isPulsStatusPayload({ uptime: '12', queue_length: 0, total_jobs: 1, enabled_jobs: 1 }), false);
  assert.equal(isPulsStatusPayload(null), false);
  assert.equal(isPulsStatusPayload('uptime'), false);
});

test('classifyPortState: wolny port → free', () => {
  assert.equal(classifyPortState({ bindable: true, statusPayload: null }), PORT_STATE.FREE);
});

test('classifyPortState: zajęty przez naszą starą instancję → ours (re-run, nie błąd)', () => {
  const payload = { uptime: 99, queue_length: 1, total_jobs: 2, enabled_jobs: 2 };
  assert.equal(classifyPortState({ bindable: false, statusPayload: payload }), PORT_STATE.OURS);
});

test('classifyPortState: zajęty przez cudzy proces → foreign', () => {
  assert.equal(classifyPortState({ bindable: false, statusPayload: null }), PORT_STATE.FOREIGN);
  assert.equal(classifyPortState({ bindable: false, statusPayload: { hello: 'world' } }), PORT_STATE.FOREIGN);
});

test('buildPortBusyMessage: zawiera numer portu i podpowiedź diagnostyczną', () => {
  const msg = buildPortBusyMessage(7777);
  assert.ok(msg.includes('7777'), 'komunikat MUSI podać numer portu');
  assert.ok(/lsof|Get-NetTCPConnection/.test(msg), 'komunikat MUSI podpowiedzieć, jak znaleźć winowajcę');
});

test('buildPortReuseMessage: mówi o re-runie, nie o błędzie', () => {
  const msg = buildPortReuseMessage(7777);
  assert.ok(msg.includes('7777'));
  assert.ok(!msg.toLowerCase().includes('error'));
});

test('buildDashboardUrl: URL składany z wybranego portu', () => {
  assert.equal(buildDashboardUrl(8080), 'http://localhost:8080');
  assert.equal(buildDashboardUrl(DEFAULT_DASHBOARD_PORT), 'http://localhost:7777');
});

test('resolveDashboardPort: wolny port → zwraca go bez pytania', async () => {
  const asked = [];
  const result = await resolveDashboardPort({
    initialPort: 7777,
    probePort: async () => PORT_STATE.FREE,
    askPort: async (p) => { asked.push(p); return ''; },
    log: () => {},
  });
  assert.deepEqual(result, { port: 7777, reused: false });
  assert.deepEqual(asked, [], 'wolny port nie może generować pytania');
});

test('resolveDashboardPort: port zajęty przez NASZĄ instancję → ścieżka re-runu, bez pytania', async () => {
  const asked = [];
  const logs = [];
  const result = await resolveDashboardPort({
    initialPort: 7777,
    probePort: async () => PORT_STATE.OURS,
    askPort: async (p) => { asked.push(p); return '8080'; },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, { port: 7777, reused: true });
  assert.deepEqual(asked, [], 're-run instalatora nie jest kolizją — brak pytania o inny port');
  assert.ok(logs.join('\n').includes('7777'));
});

test('resolveDashboardPort: cudzy proces → komunikat z portem i przejście na podany port', async () => {
  const logs = [];
  const seen = [];
  const result = await resolveDashboardPort({
    initialPort: 7777,
    probePort: async (port) => { seen.push(port); return port === 7777 ? PORT_STATE.FOREIGN : PORT_STATE.FREE; },
    askPort: async () => '8080',
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, { port: 8080, reused: false });
  assert.deepEqual(seen, [7777, 8080], 'nowy port MUSI być sprawdzony, nie przyjęty na wiarę');
  assert.ok(logs.join('\n').includes('7777'), 'komunikat o kolizji zawiera zajęty port');
});

test('resolveDashboardPort: brak poprawnej odpowiedzi na zajęty port → rzuca (zero cichego sukcesu)', async () => {
  await assert.rejects(
    () =>
      resolveDashboardPort({
        initialPort: 7777,
        probePort: async () => PORT_STATE.FOREIGN,
        askPort: async () => '',
        log: () => {},
      }),
    (error) => {
      assert.ok(error.message.includes('7777'), 'błąd MUSI wskazać zajęty port');
      return true;
    },
  );
});

test('resolveDashboardPort: same zajęte porty → rzuca po wyczerpaniu prób', async () => {
  let asks = 0;
  await assert.rejects(
    () =>
      resolveDashboardPort({
        initialPort: 7777,
        probePort: async () => PORT_STATE.FOREIGN,
        askPort: async () => { asks += 1; return String(7778 + asks); },
        log: () => {},
      }),
    /port/i,
  );
  // Dokładna wartość, nie „mniej niż 50": liczba pytań jest deterministyczna
  // (PORT_RESOLVE_ATTEMPTS), a luźny warunek przepuszczał zmianę limitu albo warunku
  // pętli — czyli dokładnie tę regresję, przed którą ten test ma bronić.
  assert.equal(asks, PORT_RESOLVE_ATTEMPTS, 'pytamy dokładnie tyle razy, ile wynosi limit prób');
});

// === buildHookSource — port wypalony w hooku (dashboard i autostart = ta sama wartość) ===

test('buildHookSource: bez podanego portu zostaje domyślny 7777 (zgodność z instalacjami sprzed R9)', () => {
  const source = buildHookSource('/repo', '/repo/.node/x/bin/node');
  assert.ok(source.includes('http://localhost:7777/api/status'));
});

test('buildHookSource: wybrany port trafia i do health-checku, i do env spawnowanego serwera', () => {
  const source = buildHookSource('/repo', '/repo/.node/x/bin/node', 8123);
  assert.ok(source.includes('http://localhost:8123/api/status'), 'health-check musi pytać o wybrany port');
  assert.ok(source.includes('CLAUDE_CRON_PORT'), 'hook musi wymusić port w env serwera');
  assert.ok(source.includes('8123'));
  assert.ok(!source.includes('7777'), 'stary port nie może zostać nigdzie w hooku');
});

// === probeDashboardPort — realny bind-test na gnieździe (nie atrapa) ===

// Startuje serwer HTTP na losowym porcie i oddaje port; sprzątanie przez t.after.
function startServerOnFreePort(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    t.after(() => new Promise((done) => server.close(done)));
    server.listen(0, '0.0.0.0', () => resolve(server.address().port));
  });
}

test('probeDashboardPort: nikt nie słucha → free', async (t) => {
  // Port zajmujemy i natychmiast zwalniamy — dostajemy numer, o którym wiemy, że jest wolny.
  const server = http.createServer(() => {});
  const port = await new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve(server.address().port));
  });
  await new Promise((done) => server.close(done));

  assert.equal(await probeDashboardPort(port), PORT_STATE.FREE);
});

test('probeDashboardPort: nasz dashboard na porcie → ours (re-run instalatora)', async (t) => {
  const port = await startServerOnFreePort(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ uptime: 1, queue_length: 0, total_jobs: 0, enabled_jobs: 0 }));
  });

  assert.equal(await probeDashboardPort(port), PORT_STATE.OURS);
});

// timeout jawny: bez capu ten test WISI, a wiszący test cicho zabiera ze sobą resztę
// pliku (99 ze 113 przypadków „przechodzi", bo nigdy się nie uruchamia). Limit zamienia
// zawieszenie w czerwony, który widać w raporcie.
test('probeDashboardPort: serwer streamujący bez końca → foreign, sondowanie się kończy (cap)', { timeout: 10_000 }, async (t) => {
  // Z review CodeRabbita (PR #2): body sklejane bez limitu, a `timeout` w http.get pilnuje
  // wyłącznie BEZCZYNNOŚCI socketu — równy strumień danych nigdy go nie wyzwala. Sondujemy
  // CUDZY port, więc po drugiej stronie może siedzieć cokolwiek: bez capu setup rósłby
  // w pamięci i nie kończył sondowania (instalacja wisi bez komunikatu).
  let stop = null;
  const port = await startServerOnFreePort(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Strumień bez końca: start wygląda jak JSON, więc nie odpada na parsowaniu.
    res.write('{"uptime":1,"filler":"');
    stop = setInterval(() => res.write('x'.repeat(8 * 1024)), 1);
    t.after(() => clearInterval(stop));
  });

  // Assert — kończy się w ogóle (bez capu: wisi aż do OOM) i nie uznaje tego za Puls.
  assert.equal(await probeDashboardPort(port), PORT_STATE.FOREIGN);
  clearInterval(stop);
});

test('probeDashboardPort: poprawny status z wielobajtowym UTF-8 przechodzi cap (bajty ≠ znaki)', async (t) => {
  // Cap liczy BAJTY (nazwa stałej), a nie jednostki UTF-16 — ale nie może przy okazji
  // odrzucać legalnej odpowiedzi z polskimi znakami. Płot po obu stronach: bufory muszą
  // wrócić poprawnie zdekodowane do JSON.parse.
  const port = await startServerOnFreePort(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      uptime: 1, queue_length: 0, total_jobs: 0, enabled_jobs: 0,
      next: { job_name: 'Zażółć gęślą jaźń — ćwierć łokcia' },
    }));
  });

  assert.equal(await probeDashboardPort(port), PORT_STATE.OURS);
});

test('probeDashboardPort: cudzy serwer na porcie → foreign (kolizja, nie re-run)', async (t) => {
  const port = await startServerOnFreePort(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>cudza aplikacja</html>');
  });

  assert.equal(await probeDashboardPort(port), PORT_STATE.FOREIGN);
});

test('probeDashboardPort: serwer TYLKO na 127.0.0.1 → nie jest portem wolnym (BSD/macOS)', async (t) => {
  // Regresja: bind-test wyłącznie na 0.0.0.0 UDAJE SIĘ przy zajętym loopbacku, więc
  // typowy dev-serwer na 127.0.0.1 był klasyfikowany jako „port wolny", a dashboard
  // po instalacji trafiał do cudzej aplikacji.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>cudzy dev-serwer</html>');
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(() => new Promise((done) => server.close(done)));

  assert.equal(await probeDashboardPort(port), PORT_STATE.FOREIGN);
});

// === Rozpoznanie CUDZEJ instalacji Pulsa na tym samym porcie ===

test('isSameInstallation: repo_dir zgodny → true, inny → false, brak pola → null', () => {
  const payload = { uptime: 1, queue_length: 0, total_jobs: 0, enabled_jobs: 0 };
  assert.equal(isSameInstallation({ ...payload, repo_dir: '/home/u/puls' }, '/home/u/puls'), true);
  assert.equal(isSameInstallation({ ...payload, repo_dir: '/home/u/puls/' }, '/home/u/puls'), true);
  assert.equal(isSameInstallation({ ...payload, repo_dir: '/home/u/puls-test' }, '/home/u/puls'), false);
  assert.equal(isSameInstallation(payload, '/home/u/puls'), null);
});

test('classifyPortState: Puls z INNEGO katalogu instalacji → other-puls (nie re-run)', () => {
  const payload = {
    uptime: 1, queue_length: 0, total_jobs: 0, enabled_jobs: 0, repo_dir: '/home/u/puls-test',
  };
  assert.equal(
    classifyPortState({ bindable: false, statusPayload: payload, repoDir: '/home/u/puls' }),
    PORT_STATE.OTHER_PULS,
  );
});

test('classifyPortState: Puls z TEGO katalogu (albo bez pola) → ours', () => {
  const base = { uptime: 1, queue_length: 0, total_jobs: 0, enabled_jobs: 0 };
  assert.equal(
    classifyPortState({
      bindable: false,
      statusPayload: { ...base, repo_dir: '/home/u/puls' },
      repoDir: '/home/u/puls',
    }),
    PORT_STATE.OURS,
  );
  // Instancja sprzed tej wersji nie zna repo_dir — zostaje re-runem, nie kolizją.
  assert.equal(
    classifyPortState({ bindable: false, statusPayload: base, repoDir: '/home/u/puls' }),
    PORT_STATE.OURS,
  );
});

test('resolveDashboardPort: cudza instancja Pulsa → pyta o inny port zamiast ją adoptować', async () => {
  const logs = [];
  const states = { 7777: PORT_STATE.OTHER_PULS, 8123: PORT_STATE.FREE };
  const result = await resolveDashboardPort({
    initialPort: 7777,
    probePort: (port) => Promise.resolve(states[port]),
    askPort: () => Promise.resolve('8123'),
    log: (line) => logs.push(line),
  });

  assert.deepEqual(result, { port: 8123, reused: false });
  assert.ok(logs.join('\n').includes(buildOtherPulsMessage(7777)));
});

// === pickInitialPort — env sesji bywa nieświeże, wartość utrwalona jest zapasem ===

test('pickInitialPort: env wygrywa nad wartością utrwaloną', () => {
  assert.equal(pickInitialPort({ envValue: '9000', persistedValue: '8080' }), 9000);
});

test('pickInitialPort: puste env → port z poprzedniej instalacji, nie domyślny 7777', () => {
  const logs = [];
  assert.equal(
    pickInitialPort({ envValue: '', persistedValue: '8080', log: (l) => logs.push(l) }),
    8080,
  );
  assert.equal(pickInitialPort({ envValue: undefined, persistedValue: '8080' }), 8080);
  assert.ok(logs.join('\n').includes('8080'));
});

test('pickInitialPort: brak obu źródeł → domyślny port; śmieć w env → warn + domyślny', () => {
  const logs = [];
  assert.equal(pickInitialPort({ envValue: '', persistedValue: null }), DEFAULT_DASHBOARD_PORT);
  assert.equal(
    pickInitialPort({ envValue: '7777x', persistedValue: '8080', log: (l) => logs.push(l) }),
    DEFAULT_DASHBOARD_PORT,
  );
  assert.ok(logs.join('\n').includes('[warn]'));
});

test('readEnvLineValue: czyta wartość zapisaną przez upsertEnvLine (round-trip)', () => {
  const rc = upsertEnvLine('# rc\n', 'CLAUDE_CRON_PORT', '8080', 'Claude-Cron dashboard port');
  assert.equal(readEnvLineValue(rc, 'CLAUDE_CRON_PORT'), '8080');
  assert.equal(readEnvLineValue(rc, 'CLAUDE_CRON_VPS_URL'), null);
  assert.equal(readEnvLineValue('', 'CLAUDE_CRON_PORT'), null);
});

test('buildGetUserEnvCommand: odczyt HKCU bez profilu, nazwa w apostrofach', () => {
  const { cmd, args } = buildGetUserEnvCommand('CLAUDE_CRON_PORT');
  assert.equal(cmd, 'powershell');
  assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.ok(args[2].includes("GetEnvironmentVariable('CLAUDE_CRON_PORT', 'User')"));
});

// === buildStaleHookPortWarning — autostart i dashboard muszą pilnować tego samego portu ===

test('buildStaleHookPortWarning: hook z tym samym portem → brak ostrzeżenia', () => {
  const source = buildHookSource('/repo', '/repo/.node/x/bin/node', 8123);
  assert.equal(buildStaleHookPortWarning(source, 8123), null);
});

test('buildStaleHookPortWarning: hook z poprzednim portem → ostrzeżenie z nowym portem', () => {
  const source = buildHookSource('/repo', '/repo/.node/x/bin/node', 7777);
  const warning = buildStaleHookPortWarning(source, 8123);
  assert.ok(warning, 'rozjazd portu hook↔dashboard musi być zgłoszony');
  assert.ok(warning.includes('8123'));
});

// === Wersja instalacji ===

test('resolveInstallVersionInput: rewizja z instalatora wygrywa z gitem', () => {
  const out = resolveInstallVersionInput(
    { CLAUDE_CRON_INSTALL_REVISION: 'a1b2c3d', CLAUDE_CRON_INSTALL_SOURCE: 'tarball' },
    'zzzzzzz',
  );
  assert.deepEqual(out, { revision: 'a1b2c3d', source: 'tarball' });
});

test('resolveInstallVersionInput: bez env spada na rewizję z gita (klon dev)', () => {
  const out = resolveInstallVersionInput({}, 'abc1234');
  assert.deepEqual(out, { revision: 'abc1234', source: 'git' });
});

test('resolveInstallVersionInput: brak obu źródeł → unknown, nigdy pusty string', () => {
  const out = resolveInstallVersionInput({ CLAUDE_CRON_INSTALL_REVISION: '  ' }, '');
  assert.deepEqual(out, { revision: 'unknown', source: 'unknown' });
});
