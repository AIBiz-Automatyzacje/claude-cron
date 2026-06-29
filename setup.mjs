// ============================================
//  CLAUDE-CRON — Wspólny setup (Mac/Win/Linux)
//
//  Jedna ścieżka konfiguracji uruchamiana przez portable Node z .node/
//  (handoff z install.sh / install.ps1). Zadania:
//   1. Warunek wstępny: Claude Code w PATH (handoff, NIE instaluje).
//   2. Pytania konfiguracyjne (VPS, workspace, autostart, Discord).
//   3. Generowanie hooka autostartu z ABSOLUTNĄ ścieżką portable Node
//      (koniec gołego 'node' w detached procesie) + --disable-warning.
//   4. Idempotentny merge wpisu hooka do {workspace}/.claude/settings.json.
//   5. Smoke-test typów DB (lib/db) — wczesne wykrycie niekompatybilności.
//
//  Plik jest ESM (Node test runner). Pure helpery są eksportowane i testowane
//  w setup.test.mjs; I/O (pytania, zapis plików) to cienka skorupa w main().
// ============================================

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// Pinowana wersja portable Node — MUSI być spójna z install.sh / install.ps1.
export const NODE_VERSION = '22.17.0';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_MARKER = 'claude-cron-autostart';
const EXPERIMENTAL_WARNING_FLAG = '--disable-warning=ExperimentalWarning';

// === Pure helper: ścieżka binarki portable Node (layout install.sh / install.ps1) ===
// darwin/linux: <base>/node-v<ver>-<platform>-<arch>/bin/node
// win32:        <base>\node-v<ver>-win-<arch>\node.exe
export function resolveNodeBinPath(platform, baseDir, nodeVersion, arch) {
  if (platform === 'win32') {
    const distName = `node-v${nodeVersion}-win-${arch}`;
    return path.win32.join(baseDir, distName, 'node.exe');
  }
  if (platform === 'darwin' || platform === 'linux') {
    const distName = `node-v${nodeVersion}-${platform}-${arch}`;
    return path.posix.join(baseDir, distName, 'bin', 'node');
  }
  throw new Error(`Nieobsługiwana platforma: ${platform} (oczekiwano darwin/linux/win32).`);
}

// === Pure helper: idempotentny merge wpisu hooka do settings.json ===
// Zwraca { settings, added }. added=false gdy wpis claude-cron-autostart już istnieje
// (wykrywany po markerze w komendzie, niezależnie od ścieżki node — re-run nie duplikuje).
export function mergeHookIntoSettings(existing, hookCommand) {
  const settings = existing && typeof existing === 'object' ? { ...existing } : {};
  settings.hooks = settings.hooks ? { ...settings.hooks } : {};
  const list = Array.isArray(settings.hooks.UserPromptSubmit)
    ? settings.hooks.UserPromptSubmit
    : [];

  const alreadyRegistered = list.some(
    (item) =>
      item &&
      Array.isArray(item.hooks) &&
      item.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER)),
  );

  if (alreadyRegistered) {
    settings.hooks.UserPromptSubmit = list;
    return { settings, added: false };
  }

  settings.hooks.UserPromptSubmit = [
    ...list,
    { matcher: '', hooks: [{ type: 'command', command: hookCommand }] },
  ];
  return { settings, added: true };
}

// === Pure helper: usunięcie wpisu hooka claude-cron-autostart z settings.json ===
// Lustro mergeHookIntoSettings — usuwa wszystkie wpisy UserPromptSubmit, których
// którakolwiek komenda zawiera marker (niezależnie od ścieżki node). Zwraca
// { settings, removed }. removed=false gdy nie było żadnego wpisu (idempotentny
// uninstall — drugi przebieg nie psuje). Czyści puste struktury hooks po usunięciu.
export function removeHookFromSettings(existing) {
  if (!existing || typeof existing !== 'object') {
    return { settings: {}, removed: false };
  }
  const settings = { ...existing };
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? { ...settings.hooks } : null;
  if (!hooks || !Array.isArray(hooks.UserPromptSubmit)) {
    return { settings, removed: false };
  }

  const kept = hooks.UserPromptSubmit.filter(
    (item) =>
      !(
        item &&
        Array.isArray(item.hooks) &&
        item.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER))
      ),
  );
  const removed = kept.length !== hooks.UserPromptSubmit.length;
  if (!removed) {
    return { settings, removed: false };
  }

  if (kept.length > 0) {
    hooks.UserPromptSubmit = kept;
  } else {
    delete hooks.UserPromptSubmit;
  }
  if (Object.keys(hooks).length > 0) {
    settings.hooks = hooks;
  } else {
    delete settings.hooks;
  }
  return { settings, removed: true };
}

// === Pure helper: źródło hooka autostartu z absolutną ścieżką node + flagą ===
export function buildHookSource(repoDir, nodeBinPath) {
  return `const http = require('http');
const { spawn } = require('child_process');

// Wypalone na sztywno przez setup.mjs — absolutna ścieżka portable Node.
// NIE goły 'node': hook działa w sesji Claude Code, której PATH może nie mieć
// portable Node (brak fnm/nvm), więc detached serwer dostaje pełną ścieżkę.
const NODE_BIN = ${JSON.stringify(nodeBinPath)};
const CRON_DIR = ${JSON.stringify(repoDir)};

const req = http.get('http://localhost:7777/api/status', { timeout: 1000 }, () => {
  process.exit(0);
});

req.on('error', () => {
  const child = spawn(NODE_BIN, ['${EXPERIMENTAL_WARNING_FLAG}', 'server.js'], {
    cwd: CRON_DIR,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Caffeinate — keep Mac awake while claude-cron is alive (guard darwin)
  if (process.platform === 'darwin') {
    spawn('caffeinate', ['-w', String(child.pid)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  console.log('🕹️ Claude-Cron started in background (localhost:7777)');
  process.exit(0);
});

req.on('timeout', () => {
  req.destroy();
});
`;
}

// === Pure helper: wykrycie binarki Node do wypalenia w hooku ===
// Preferuje process.execPath (dokładnie ten portable Node, który odpalił setup.mjs).
// Fallback: zbudowanie ścieżki z layoutu .node/, gdy execPath nie wskazuje na .node/.
export function detectPortableNodeBin(execPath, platform, repoDir, arch) {
  const nodeBase = path.join(repoDir, '.node');
  if (execPath && execPath.includes(`${path.sep}.node${path.sep}`)) {
    return execPath;
  }
  return resolveNodeBinPath(platform, nodeBase, NODE_VERSION, arch);
}

// === Pure helper: wykrycie Claude CLI w PATH (DI: funkcja sprawdzająca) ===
export function isClaudeInstalled(probe) {
  const result = probe('claude');
  return result.status === 0;
}

function buildClaudeHandoffMessage() {
  return [
    '[setup] Nie znaleziono Claude Code (komenda `claude`) w PATH.',
    '',
    'Claude Code jest WYMAGANY — claude-cron uruchamia nim joby. Setup go NIE instaluje.',
    '',
    'Zrób to ręcznie (jedna komenda), potem wróć:',
    '  1. npm install -g @anthropic-ai/claude-code',
    '  2. uruchom `claude` raz i zaloguj się',
    '  3. odpal instalator ponownie',
  ].join('\n');
}

// === I/O shell ===

function defaultClaudeProbe(cmd) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(which, [cmd], { stdio: 'ignore' });
}

async function runSmokeTest() {
  // Smoke-test typów DB: getDb() tworzy + migruje domyślną bazę, assertDbReturnsNumbers
  // rzuca DbTypeError gdy node:sqlite zwraca agregat jako BigInt zamiast number.
  const db = require('./lib/db');
  const conn = db.getDb();
  db.assertDbReturnsNumbers(conn);
  db.close();
}

async function ask(rl, question, fallback = '') {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

function sanitizeDroppedPath(input) {
  // Drag & drop z Findera dodaje cudzysłowy / escape'y / spacje — czyścimy.
  let value = input.replace(/['"\\]/g, '').trim();
  if (value.startsWith('~')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return value;
}

function writeHook(workspace, repoDir, nodeBin) {
  const hooksDir = path.join(workspace, '.claude', 'hooks');
  const hookFile = path.join(hooksDir, 'claude-cron-autostart.js');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookFile, buildHookSource(repoDir, nodeBin), 'utf-8');
  return hookFile;
}

function registerHook(workspace, hookFile, nodeBin) {
  const settingsFile = path.join(workspace, '.claude', 'settings.json');
  let existing = {};
  if (fs.existsSync(settingsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    } catch {
      existing = {};
    }
  }
  const command = `${JSON.stringify(nodeBin)} ${JSON.stringify(hookFile)}`;
  const { settings, added } = mergeHookIntoSettings(existing, command);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
  return added;
}

async function main() {
  console.log('\n🕹️  CLAUDE-CRON — Setup\n========================================\n');

  if (!isClaudeInstalled(defaultClaudeProbe)) {
    console.error(buildClaudeHandoffMessage());
    process.exit(1);
  }
  console.log('[ok] Claude Code znaleziony w PATH.');

  const nodeBin = detectPortableNodeBin(process.execPath, process.platform, REPO_DIR, process.arch);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const workspaceInput = await ask(rl, 'Ścieżka do workspace [' + os.homedir() + ']: ', os.homedir());
    const workspace = path.resolve(sanitizeDroppedPath(workspaceInput));
    if (!fs.existsSync(workspace)) {
      console.error(`[error] Folder workspace nie istnieje: ${workspace}`);
      process.exit(1);
    }
    console.log(`[ok] Workspace: ${workspace}`);

    const installHook = (await ask(rl, 'Zainstalować autostart? [Y/n]: ', 'Y')).toLowerCase();
    if (installHook === 'y') {
      const hookFile = writeHook(workspace, REPO_DIR, nodeBin);
      const added = registerHook(workspace, hookFile, nodeBin);
      console.log(added ? `[ok] Hook zarejestrowany: ${hookFile}` : '[ok] Hook już zarejestrowany.');
    } else {
      console.log('[info] Pominięto autostart.');
    }
  } finally {
    rl.close();
  }

  console.log('\n[info] Smoke-test bazy danych...');
  await runSmokeTest();
  console.log('[ok] Smoke-test DB przeszedł — typy zgodne.');

  console.log('\n🕹️  Gotowe!\n');
}

// Uruchamiamy main() tylko gdy plik jest entry-pointem (nie podczas importu w testach).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[error] Setup nie powiódł się: ${error.message}`);
    process.exit(1);
  });
}
