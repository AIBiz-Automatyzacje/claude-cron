// ============================================
//  CLAUDE-CRON — Wspólny setup (Mac/Win/Linux)
//
//  Jedna ścieżka konfiguracji uruchamiana przez portable Node z .node/
//  (handoff z install.sh / install.ps1). Zadania:
//   1. Warunek wstępny: Claude Code w PATH (handoff, NIE instaluje).
//   2. Pytania konfiguracyjne (VPS, workspace, autostart, powiadomienia
//      Discord/Telegram, podstawowe taski).
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

// === Pure helper: odpowiedzi setupu → payload state powiadomień ===
// Klucze zgodne z NOTIFY_STATE_KEYS (lib/notify-config.js) i PUT /api/settings/notifications.
// Tylko niepuste (po trim) wartości — setup nie czyści istniejącej konfiguracji.
// Wszystko puste → null (caller pomija zapis do state i push na VPS).
export function buildNotificationSettingsPayload(answers) {
  const discord = String(answers?.discordWebhookUrl ?? '').trim();
  const token = String(answers?.telegramBotToken ?? '').trim();
  const chatId = String(answers?.telegramChatId ?? '').trim();

  const payload = {};
  if (discord) payload.discord_webhook_url = discord;
  if (token) payload.telegram_bot_token = token;
  if (chatId) payload.telegram_chat_id = chatId;
  return Object.keys(payload).length > 0 ? payload : null;
}

// === Pure helper: odpowiedź getUpdates Telegrama → chat ID (string) albo null ===
// Bot API zwraca result posortowany rosnąco po update_id, więc ostatni wpis z
// message.chat.id to najświeższa rozmowa — przy wielu czatach wygrywa najnowszy.
// ok !== true / brak update'ów z message → null (caller przechodzi na ręczne wpisanie).
// Chat ID jako string: state trzyma stringi, a ID grup bywa ujemne (-100...).
export function extractChatIdFromUpdates(json) {
  if (!json || json.ok !== true || !Array.isArray(json.result)) {
    return null;
  }
  let chatId = null;
  for (const update of json.result) {
    const id = update?.message?.chat?.id;
    if (id !== undefined && id !== null) {
      chatId = String(id);
    }
  }
  return chatId;
}

// === Pure helper: rekurencyjne kopiowanie katalogu skilla (DI ścieżek źródło/cel) ===
// Kopiowanie zamiast symlinku — symlink na Windows wymaga uprawnień administratora.
// force nadpisuje istniejące pliki (re-run setupu aktualizuje skill), recursive tworzy
// katalog docelowy razem z brakującymi rodzicami. Brak źródła → rzuca (ENOENT).
export function copySkillDir(srcDir, destDir) {
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });
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

// Timeout wywołań Bot API — setup nie może wisieć na sieci (spójny z lib/notify-push).
const TELEGRAM_API_TIMEOUT_MS = 10_000;

function telegramApiUrl(botToken, method) {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

// === I/O shell: getUpdates Bot API → sparsowany JSON albo null (warn, bez przerywania) ===
// Komunikaty błędów NIE zawierają URL-a — w path żyje token (jak w lib/telegram.js).
async function fetchTelegramUpdates(botToken) {
  try {
    const res = await fetch(telegramApiUrl(botToken, 'getUpdates'), {
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
    return await res.json();
  } catch (error) {
    console.log(`[warn] Nie udało się pobrać getUpdates z api.telegram.org (${error.name}).`);
    return null;
  }
}

// === I/O shell: testowa wiadomość Telegram → true tylko przy ok:true w BODY odpowiedzi ===
// Stan faktyczny, nie kod HTTP (learned pattern: fałszywe sygnały statusów) — Bot API
// potrafi zwrócić 200 z ok:false. Pad wysyłki NIGDY nie przerywa setupu (warn u callera).
async function sendTelegramTestMessage(botToken, chatId) {
  try {
    const res = await fetch(telegramApiUrl(botToken, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '✅ Puls połączony z Telegramem' }),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
    const json = await res.json();
    return json?.ok === true;
  } catch (error) {
    console.log(`[warn] Wysyłka testowa do api.telegram.org nie doszła (${error.name}).`);
    return false;
  }
}

// === I/O shell: auto-detekcja chat ID przez getUpdates + potwierdzenie, ręczny fallback ===
// Mechanizm ask obsługuje tty-handoff (curl|bash) — NIE czytamy stdin bezpośrednio.
async function askTelegramChatId(rl, botToken) {
  await ask(rl, 'Napisz teraz cokolwiek do swojego bota na Telegramie, potem wciśnij Enter: ');
  const detected = extractChatIdFromUpdates(await fetchTelegramUpdates(botToken));
  if (detected) {
    const useDetected = (await ask(rl, `Wykryto chat ID: ${detected}. Użyć? [Y/n]: `, 'Y')).toLowerCase();
    if (useDetected === 'y') {
      return detected;
    }
  } else {
    console.log('[info] Nie wykryto wiadomości do bota — podaj chat ID ręcznie.');
  }
  return ask(rl, 'Chat ID (puste = pomiń Telegram): ');
}

// === I/O shell: zapis payloadu powiadomień do state lokalnej DB ===
// Wołany PO smoke-teście (baza zweryfikowana); getDb() otwiera połączenie lazy po
// db.close() ze smoke-testu, migrate() jest idempotentny.
function persistNotifySettings(payload) {
  const db = require('./lib/db');
  for (const [key, value] of Object.entries(payload)) {
    db.setState(key, value);
  }
  db.close();
}

// === I/O shell: push konfiguracji na VPS przez współdzielony lib/notify-push ===
// Kontrakt pushNotifySettings: nigdy nie rzuca — zawsze { ok, reason? }, zapis
// potwierdzany GET-em po PUT. Pad pushu NIGDY nie przerywa setupu (warn + podpowiedź).
async function pushNotifySettingsToVps(vpsUrl, payload) {
  const { pushNotifySettings } = require('./lib/notify-push');
  console.log('[info] Wysyłam konfigurację powiadomień na VPS...');
  const result = await pushNotifySettings({ vpsUrl, settings: payload });
  if (result.ok) {
    console.log('[ok] VPS ma konfigurację powiadomień (potwierdzone odczytem po zapisie).');
    return;
  }
  if (result.reason === 'endpoint_missing') {
    console.log(
      '[warn] VPS ma starszą wersję serwera (brak endpointu ustawień) — nocny auto-update (02:00) ją podniesie. '
      + 'Potem wyślij konfigurację z dashboardu: Ustawienia powiadomień → „Wyślij na VPS".',
    );
    return;
  }
  console.log(
    `[warn] Push na VPS nie powiódł się (${result.reason}) — wyślij później z dashboardu: `
    + 'Ustawienia powiadomień → „Wyślij na VPS".',
  );
}

// === I/O shell: seed podstawowych tasków + raport dodanych/pominiętych z powodem ===
// Wołany PO udanym smoke-teście DB (wzorzec persistNotifySettings). Skanowanie skilli
// (getAllSkills w lib/starter-jobs) czyta workspace z CLAUDE_CRON_WORKSPACE — ustawionego
// wcześniej w tej sesji przez persistEnvVar. Idempotencja po nazwie joba: re-run nie duplikuje.
function seedStarterJobsWithReport() {
  const { seedStarterJobs, SKIP_REASON } = require('./lib/starter-jobs');
  const db = require('./lib/db');
  const skipLabels = {
    [SKIP_REASON.EXISTS]: 'job o tej nazwie już istnieje',
    [SKIP_REASON.MISSING_SKILL]: 'brak dostępnego skilla',
  };

  const { added, skipped } = seedStarterJobs();
  db.close();

  for (const name of added) {
    console.log(`[ok] Dodano task: ${name}`);
  }
  for (const entry of skipped) {
    console.log(`[info] Pominięto „${entry.name}" — ${skipLabels[entry.reason] || entry.reason}.`);
  }
  if (added.length === 0) {
    console.log('[info] Nie dodano nowych tasków.');
  }
}

// === I/O shell: instalacja skilla `puls` do globalnych skilli Claude Code ===
// ~/.claude/skills/puls — dzięki temu agent w KAŻDEJ sesji zna REST API Pulsa
// (tworzenie/edycja jobów, diagnoza runów). Pad kopiowania nie przerywa setupu
// (warn + instrukcja ręczna) — skill to warstwa wygody, nie rdzeń instalacji.
function installPulsSkill() {
  const src = path.join(REPO_DIR, 'skills', 'puls');
  const dest = path.join(os.homedir(), '.claude', 'skills', 'puls');
  try {
    copySkillDir(src, dest);
    console.log(`[ok] Skill „puls" zainstalowany globalnie: ${dest}`);
  } catch (error) {
    console.log(
      `[warn] Nie udało się zainstalować skilla „puls" (${error.message}) — `
      + `skopiuj ręcznie: ${src} → ${dest}.`,
    );
  }
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

  // Hoisting poza try: odpowiedzi o powiadomieniach trzymamy w zmiennych, a zapis do
  // state i push na VPS robimy dopiero PO smoke-teście DB (za blokiem try/finally).
  let vpsUrl = null;
  let notifyPayload = null;
  let wantStarterJobs = false;

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
    vpsUrl = buildVpsUrl(vpsHost, vpsPort);
    if (vpsUrl) {
      const vpsLoc = persistEnvVar('CLAUDE_CRON_VPS_URL', vpsUrl, 'Claude-Cron VPS connection');
      console.log(`[ok] VPS: ${vpsUrl} (zapisano w ${vpsLoc})`);
    } else {
      console.log('[info] Tryb tylko lokalny — joby działają gdy komputer nie śpi.');
    }

    // Powiadomienia idą do state DB (nie env) — zmiana z dashboardu działa bez restartu,
    // a env DISCORD_WEBHOOK_URL/TELEGRAM_* pozostaje fallbackiem dla starych instalacji (R3).
    const discordUrl = await ask(rl, 'Discord webhook URL (puste = pomiń): ');
    if (!discordUrl) {
      console.log('[info] Pominięto Discord.');
    }

    const telegramToken = await ask(rl, 'Telegram bot token (puste = pomiń): ');
    let telegramChatId = '';
    if (telegramToken) {
      telegramChatId = await askTelegramChatId(rl, telegramToken);
      if (telegramChatId) {
        const sent = await sendTelegramTestMessage(telegramToken, telegramChatId);
        console.log(
          sent
            ? '[ok] Wiadomość testowa wysłana — sprawdź Telegram.'
            : '[warn] Wiadomość testowa nie doszła — sprawdź token i chat ID; poprawisz je w dashboardzie (Ustawienia powiadomień).',
        );
      } else {
        console.log('[info] Pominięto Telegram (brak chat ID).');
      }
    } else {
      console.log('[info] Pominięto Telegram.');
    }

    notifyPayload = buildNotificationSettingsPayload({
      discordWebhookUrl: discordUrl,
      telegramBotToken: telegramToken,
      telegramChatId,
    });

    const installHook = (await ask(rl, 'Zainstalować autostart? [Y/n]: ', 'Y')).toLowerCase();
    if (installHook === 'y') {
      const hookFile = writeHook(workspace, REPO_DIR, nodeBin);
      const added = registerHook(workspace, hookFile, nodeBin);
      console.log(added ? `[ok] Hook zarejestrowany: ${hookFile}` : '[ok] Hook już zarejestrowany.');
    } else {
      console.log('[info] Pominięto autostart.');
    }

    // Pytanie zbiorcze o podstawowe taski — sam seed dopiero PO smoke-teście DB
    // (za blokiem try/finally), bo baza jest otwierana najwcześniej przy smoke-teście.
    const starterAnswer = (
      await ask(rl, 'Dodać zestaw podstawowych tasków (memory update, reflect, skill scout)? [T/n]: ', 'T')
    ).toLowerCase();
    wantStarterJobs = starterAnswer === 't';
    if (!wantStarterJobs) {
      console.log('[info] Pominięto podstawowe taski.');
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

  // Zapis powiadomień do state dopiero teraz — baza zweryfikowana smoke-testem.
  if (notifyPayload) {
    persistNotifySettings(notifyPayload);
    console.log('[ok] Konfiguracja powiadomień zapisana lokalnie (state DB).');
    if (vpsUrl) {
      await pushNotifySettingsToVps(vpsUrl, notifyPayload);
    }
  }

  // Seed podstawowych tasków — w setupie, NIE w migrate() (learned pattern: backfill
  // w migrate() clobberowałby świadome decyzje usera przy każdym boocie).
  if (wantStarterJobs) {
    console.log('\n[info] Dodaję podstawowe taski...');
    seedStarterJobsWithReport();
  }

  // Skill `puls` do ~/.claude/skills — re-run nadpisuje (aktualizacja treści skilla).
  installPulsSkill();

  // Auto-start serwera + auto-open przeglądarki (Mac/Win). Link wypisany ZAWSZE.
  await startServerAndOpen(nodeBin, REPO_DIR);

  console.log('\n🕹️  Gotowe!\n');
}

// Uruchamiamy main() tylko gdy plik jest entry-pointem (nie podczas importu w testach).
// realpathSync po obu stronach: na macOS /var to symlink do /private/var, więc goły
// path.resolve(argv[1]) rozjeżdża się z fileURLToPath (setup pod /var/folders/... nie
// odpalałby main). realpath normalizuje symlinki → działa też dla ścieżek symlinkowanych.
const invokedRealPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedRealPath && invokedRealPath === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[error] Setup nie powiódł się: ${error.message}`);
    process.exit(1);
  });
}
