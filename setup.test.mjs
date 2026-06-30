import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
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
  const result = detectPortableNodeBin('/usr/local/bin/node', 'darwin', '/repo', 'arm64');
  assert.equal(
    result,
    path.join('/repo', '.node', `node-v${NODE_VERSION}-darwin-arm64`, 'bin', 'node'),
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
