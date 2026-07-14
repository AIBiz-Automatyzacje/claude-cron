const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLAUDE_BIN, WORKSPACE_DIR, IS_WIN } = require('./config');

// Wspólne elementy spawnu CLI `claude` — reużywane przez executor (joby) i ask
// (asystent głosowy). Argumenty CLI buduje wywołujący (executor: stream-json,
// ask: text + model); tu żyje wyłącznie to, co MUSI być identyczne po obu
// stronach: czysty env, resolve binarki i opcje spawnu.

// Długożyjący token OAuth (`claude setup-token`) dla headless auth — np. VPS bez
// interaktywnego loginu. Brak pliku to normalny przypadek (instalacje z loginem
// trzymają credentiale w ~/.claude), więc ENOENT nie jest błędem; inne błędy
// odczytu logujemy — token istnieje, ale nie działa, i joby padną na auth.
const OAUTH_TOKEN_FILE = path.join(os.homedir(), '.claude-cron-oauth-token');

// Override binarki dla testów (wzorzec db.setDbPath) — testy spawnują
// `node <skrypt tmp>` zamiast prawdziwego `claude`.
let binOverride = null;

function setClaudeBin(testBin) {
  binOverride = testBin;
}

function readOauthToken(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim() || null;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[claude-spawn] Nie mogę odczytać pliku tokena OAuth (${err.code}): ${filePath}`);
    }
    return null;
  }
}

// Czysty env dla spawnowanego CLI: strip wszystkich CLAUDE_CODE*/CLAUDECODE,
// żeby CLI nie myślał, że jest zagnieżdżony w sesji Claude Code.
// Token OAuth wstrzykiwany PO strip-loopie — inaczej zostałby usunięty jako CLAUDE_CODE*.
function buildCleanEnv(baseEnv = process.env, oauthTokenFile = OAUTH_TOKEN_FILE) {
  const cleanEnv = { ...baseEnv };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith('CLAUDE_CODE') || key === 'CLAUDECODE') {
      delete cleanEnv[key];
    }
  }
  const oauthToken = readOauthToken(oauthTokenFile);
  if (oauthToken) {
    cleanEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  return cleanEnv;
}

// Na Windows resolve pełnej ścieżki do claude.exe przez `where claude`,
// żeby uniknąć shell:true (cmd.exe rozbija wielowyrazowe argumenty -p).
// Gdy `where` nie znajdzie binarki — czytelny błąd zamiast fallbacku shell:true:
// przy shell:true Node NIE escapuje argumentów, więc metaznaki cmd.exe w treści
// promptu (webhook_payload z publicznego /webhook/:token, tekst z /ask) wykonałyby
// się jako komendy. Fail-fast runu > cicha podatność na command injection.
// deps ({isWin, exec}) wstrzykiwane dla testów — gałąź Windows jest martwa na Macu.
function resolveClaudeBin({ isWin = IS_WIN, exec = execSync } = {}) {
  if (binOverride) return binOverride;
  if (!isWin) return CLAUDE_BIN;
  try {
    return exec('where claude', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim();
  } catch {
    throw new Error(
      'Nie znaleziono binarki `claude` w PATH (`where claude` bez wyniku). ' +
      'Zainstaluj Claude Code CLI albo dodaj ją do PATH — celowo brak fallbacku shell:true (ryzyko command injection).'
    );
  }
}

function spawnClaude(args) {
  return spawn(resolveClaudeBin(), args, {
    cwd: WORKSPACE_DIR,
    env: buildCleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

module.exports = { spawnClaude, resolveClaudeBin, buildCleanEnv, readOauthToken, setClaudeBin, OAUTH_TOKEN_FILE };
