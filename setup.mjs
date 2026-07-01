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

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// Pinowana wersja portable Node — MUSI być spójna z install.sh / install.ps1.
export const NODE_VERSION = '22.17.0';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_MARKER = 'claude-cron-autostart';
const EXPERIMENTAL_WARNING_FLAG = '--disable-warning=ExperimentalWarning';

// Dashboard claude-cron — port wolny z założenia (kolizji nie obsługujemy, poza scope).
export const DASHBOARD_PORT = 7777;
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
// Limit pollowania serwera po spawnie, zanim wypiszemy link / otworzymy przeglądarkę.
const SERVER_POLL_ATTEMPTS = 20;
const SERVER_POLL_INTERVAL_MS = 500;

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

// === Pure helper: upsert `export VAR="value"` w treści shell RC (zsh/bash) ===
// Zwraca nową treść pliku. Gdy linia `export VAR=...` już istnieje — podmienia ją
// (idempotentny re-run nie duplikuje). Gdy nie ma — dopisuje na końcu z komentarzem.
// Lustro logiki ze starego setup.sh (grep -q + sed | echo >>).
export function upsertEnvLine(rcContent, varName, value, comment) {
  const content = typeof rcContent === 'string' ? rcContent : '';
  const exportLine = `export ${varName}=${JSON.stringify(value)}`;
  const lineRegex = new RegExp(`^export ${varName}=.*$`, 'm');

  if (lineRegex.test(content)) {
    return content.replace(lineRegex, exportLine);
  }

  const prefix = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  const commentLine = comment ? `# ${comment}\n` : '';
  return `${prefix}\n${commentLine}${exportLine}\n`;
}

// === Pure helper: budowa URL-a VPS z hosta + portu (lustro setup.sh:97-107) ===
// Pusty/biały host → null (tryb tylko lokalny, env nie zapisywany).
export function buildVpsUrl(host, port) {
  const trimmedHost = typeof host === 'string' ? host.trim() : '';
  if (!trimmedHost) {
    return null;
  }
  const resolvedPort = String(port || '').trim() || '7777';
  return `http://${trimmedHost}:${resolvedPort}`;
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

// === Pure helper: komenda natywnego okna wyboru folderu per OS ===
// darwin → osascript 'choose folder' (Finder); win32 → PowerShell FolderBrowserDialog.
// Zwraca null dla platform bez GUI pickera (np. linux/VPS) → caller spada do pytania tekstowego.
export function buildFolderPickerCommand(platform, promptText) {
  const text = String(promptText ?? '');
  if (platform === 'darwin') {
    const escaped = text.replace(/"/g, '\\"');
    return {
      cmd: 'osascript',
      args: ['-e', `POSIX path of (choose folder with prompt "${escaped}")`],
    };
  }
  if (platform === 'win32') {
    const escaped = text.replace(/'/g, "''");
    const script =
      'Add-Type -AssemblyName System.Windows.Forms;' +
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog;' +
      `$f.Description = '${escaped}';` +
      "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }";
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', script],
    };
  }
  return null;
}

// === Pure helper: wynik pickera → ścieżka albo null ===
// Anulowanie okna: osascript kończy status!=0; PowerShell status=0 z pustym stdout.
// Brak binarki/GUI: spawnSync zwraca { status: null, error }. Wszystkie → null (fallback).
export function parseFolderPickerResult(result) {
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  const value = result.stdout.trim();
  return value || null;
}

// === Pure helper: komenda otwarcia URL-a w domyślnej przeglądarce per OS ===
// darwin → `open <url>`; win32 → `cmd /c start "" <url>` (pusty tytuł, by start nie
// potraktował URL-a jako tytułu okna). Każda inna platforma (linux/headless) → null:
// caller NIE spawnuje i polega na wypisanym linku. Best-effort — brak detekcji DISPLAY.
export function buildOpenBrowserCommand(platform, url) {
  const target = String(url ?? '');
  if (platform === 'darwin') {
    return { cmd: 'open', args: [target] };
  }
  if (platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '', target] };
  }
  return null;
}

// === I/O shell: odpal natywne okno wyboru folderu (DI: spawn) ===
function pickFolderGui(promptText, spawn = spawnSync) {
  const command = buildFolderPickerCommand(process.platform, promptText);
  if (!command) {
    return null;
  }
  // spawnSync nie rzuca przy braku binarki — zwraca { status: null, error } → parse da null.
  const result = spawn(command.cmd, command.args, { encoding: 'utf8' });
  return parseFolderPickerResult(result);
}

// === I/O shell: ping dashboardu (HTTP GET /api/status) — true gdy serwer odpowiada ===
function pingDashboard() {
  return new Promise((resolve) => {
    const req = http.get(
      `${DASHBOARD_URL}/api/status`,
      { timeout: 1000 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// === I/O shell: spawn detached serwera portable Nodem (reuse wzorca z buildHookSource) ===
// cwd=REPO_DIR, --disable-warning, detached+unref (proces przeżyje setup). Na darwin
// caffeinate trzyma Maca wybudzonego, póki serwer żyje (guard platformy).
function spawnServer(nodeBin, repoDir) {
  const child = spawn(nodeBin, [EXPERIMENTAL_WARNING_FLAG, 'server.js'], {
    cwd: repoDir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (process.platform === 'darwin' && child.pid) {
    spawn('caffeinate', ['-w', String(child.pid)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}

// === I/O shell: poll dashboardu aż odpowie albo wyczerpie limit prób (nie crashuje) ===
async function waitForDashboard() {
  for (let attempt = 0; attempt < SERVER_POLL_ATTEMPTS; attempt += 1) {
    if (await pingDashboard()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }
  return false;
}

// === I/O shell: auto-open dashboardu w przeglądarce (best-effort, Mac/Win) ===
// Null command (linux/headless) → nic nie robimy, link już wypisany. spawnSync nie
// rzuca przy braku binarki (zwraca { error }) — auto-open padło, link i tak jest.
function openDashboard() {
  const command = buildOpenBrowserCommand(process.platform, DASHBOARD_URL);
  if (!command) {
    return;
  }
  spawnSync(command.cmd, command.args, { stdio: 'ignore' });
}

// === I/O shell: zapewnij że serwer działa, ZAWSZE wypisz link, otwórz przeglądarkę ===
// Ping → jeśli down, spawn detached + poll. Link wypisywany BEZWARUNKOWO (nawet gdy
// serwer nie wstał). Auto-open dopiero po potwierdzeniu odpowiedzi (Mac/Win, best-effort).
async function startServerAndOpen(nodeBin, repoDir) {
  let running = await pingDashboard();
  if (!running) {
    spawnServer(nodeBin, repoDir);
    running = await waitForDashboard();
  }

  console.log(`\n🫀  Dashboard: ${DASHBOARD_URL}`);
  if (!running) {
    console.log('[info] Serwer nie odpowiedział w czasie — otwórz link ręcznie po chwili.');
    return;
  }
  openDashboard();
}

function writeHook(workspace, repoDir, nodeBin) {
  const hooksDir = path.join(workspace, '.claude', 'hooks');
  const hookFile = path.join(hooksDir, 'claude-cron-autostart.js');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookFile, buildHookSource(repoDir, nodeBin), 'utf-8');
  return hookFile;
}

// Plik RC powłoki do persystencji env na Unix (zsh domyślny na macOS; bash jako fallback).
function resolveShellRc() {
  const shell = process.env.SHELL || '';
  const rcName = shell.includes('bash') ? '.bashrc' : '.zshrc';
  return path.join(os.homedir(), rcName);
}

// Pure: escape stringa do literału PowerShell w pojedynczych cudzysłowach ('' = literalny ').
function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Pure: komenda ustawienia User-scoped env var na Windows (rejestr HKCU\Environment).
// Widoczna w NOWYCH procesach bez `source`. Pojedyncze cudzysłowy: backslashe ścieżek
// (C:\Users\...) zostają dosłowne, inaczej niż przy JSON/double-quote.
export function buildSetUserEnvCommand(varName, value) {
  const script = `[Environment]::SetEnvironmentVariable(${psSingleQuote(varName)}, ${psSingleQuote(value)}, 'User')`;
  return { cmd: 'powershell', args: ['-NoProfile', '-Command', script] };
}

// Windows: zapis do User Environment (rejestr). DI na spawn dla testowalności.
function persistUserEnvWin32(varName, value, spawn = spawnSync) {
  const { cmd, args } = buildSetUserEnvCommand(varName, value);
  const result = spawn(cmd, args, { encoding: 'utf-8' });
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message || `kod ${result.status}`;
    throw new Error(`Nie udało się zapisać ${varName} w środowisku użytkownika Windows: ${detail}`);
  }
}

// Persystuje zmienną środowiskową per platforma i ustawia ją też w bieżącym procesie
// (by autostart serwera w TEJ sesji widział wartość). Zwraca opis lokalizacji do komunikatu.
// Windows → User Environment (rejestr); Unix → export w shell RC (idempotentnie).
function persistEnvVar(varName, value, comment) {
  if (process.platform === 'win32') {
    persistUserEnvWin32(varName, value);
    process.env[varName] = value;
    return 'środowisku użytkownika Windows (otwórz nowy terminal)';
  }
  const rcFile = resolveShellRc();
  const current = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf-8') : '';
  fs.writeFileSync(rcFile, upsertEnvLine(current, varName, value, comment), 'utf-8');
  process.env[varName] = value;
  return rcFile;
}

function registerHook(workspace, hookFile, nodeBin) {
  const settingsFile = path.join(workspace, '.claude', 'settings.json');
  let existing = {};
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    try {
      existing = JSON.parse(raw);
    } catch (error) {
      // Fail-fast: NIE nadpisujemy uszkodzonego settings.json — zniszczyłoby to
      // permissions/inne hooki/env usera. Każemy userowi naprawić ręcznie.
      throw new Error(
        `Plik ${settingsFile} jest niepoprawnym JSON-em (${error.message}). ` +
          'Setup NIE nadpisze go, by nie utracić Twoich permissions/hooków/env. ' +
          'Napraw plik ręcznie (albo usuń go, jeśli nie zawiera nic ważnego) i uruchom setup ponownie.',
      );
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
    const workspaceDefault = process.env.CLAUDE_CRON_WORKSPACE || os.homedir();
    let workspace;
    const pickedFolder = pickFolderGui('Wybierz folder workspace (vault) dla Claude-Cron');
    if (pickedFolder) {
      workspace = path.resolve(pickedFolder);
      console.log(`[ok] Wybrano w oknie: ${workspace}`);
    } else {
      // Brak GUI / anulowano okno → pytanie tekstowe (możliwy drag & drop z Findera).
      const workspaceInput = await ask(
        rl,
        `Ścieżka do workspace (możesz przeciągnąć folder z Findera) [${workspaceDefault}]: `,
        workspaceDefault,
      );
      workspace = path.resolve(sanitizeDroppedPath(workspaceInput));
    }
    if (!fs.existsSync(workspace)) {
      console.error(`[error] Folder workspace nie istnieje: ${workspace}`);
      process.exit(1);
    }
    console.log(`[ok] Workspace: ${workspace}`);
    const workspaceLoc = persistEnvVar('CLAUDE_CRON_WORKSPACE', workspace, 'Claude-Cron workspace');
    console.log(`[ok] Zapisano CLAUDE_CRON_WORKSPACE w ${workspaceLoc}`);

    const vpsHost = await ask(rl, 'Tailscale IP VPS-a (puste = tryb tylko lokalny): ');
    const vpsPort = vpsHost ? await ask(rl, 'Port VPS [7777]: ', '7777') : '7777';
    const vpsUrl = buildVpsUrl(vpsHost, vpsPort);
    if (vpsUrl) {
      const vpsLoc = persistEnvVar('CLAUDE_CRON_VPS_URL', vpsUrl, 'Claude-Cron VPS connection');
      console.log(`[ok] VPS: ${vpsUrl} (zapisano w ${vpsLoc})`);
    } else {
      console.log('[info] Tryb tylko lokalny — joby działają gdy komputer nie śpi.');
    }

    const discordUrl = await ask(rl, 'Discord webhook URL (puste = pomiń): ');
    if (discordUrl) {
      const discordLoc = persistEnvVar('DISCORD_WEBHOOK_URL', discordUrl, 'Claude-Cron Discord notifications');
      console.log(`[ok] Discord webhook zapisany w ${discordLoc}`);
    } else {
      console.log('[info] Pominięto Discord.');
    }

    const installHook = (await ask(rl, 'Zainstalować autostart? [Y/n]: ', 'Y')).toLowerCase();
    if (installHook === 'y') {
      const hookFile = writeHook(workspace, REPO_DIR, nodeBin);
      const added = registerHook(workspace, hookFile, nodeBin);
      console.log(added ? `[ok] Hook zarejestrowany: ${hookFile}` : '[ok] Hook już zarejestrowany.');
    } else {
      console.log('[info] Pominięto autostart.');
    }

    const reloadHint =
      process.platform === 'win32'
        ? '\n[info] Zmienne zapisane w środowisku użytkownika — otwórz NOWY terminal, by je załadować.'
        : `\n[info] Załaduj zmienne środowiskowe: source ${resolveShellRc()}`;
    console.log(reloadHint);
  } finally {
    rl.close();
  }

  console.log('\n[info] Smoke-test bazy danych...');
  await runSmokeTest();
  console.log('[ok] Smoke-test DB przeszedł — typy zgodne.');

  // Auto-start serwera + auto-open przeglądarki (Mac/Win). Link wypisany ZAWSZE.
  await startServerAndOpen(nodeBin, REPO_DIR);

  console.log('\n🕹️  Gotowe!\n');
}

// Uruchamiamy main() tylko gdy plik jest entry-pointem (nie podczas importu w testach).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[error] Setup nie powiódł się: ${error.message}`);
    process.exit(1);
  });
}
