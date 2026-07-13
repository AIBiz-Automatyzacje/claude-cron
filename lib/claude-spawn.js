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
// żeby uniknąć shell:true (cmd.exe rozbija wielowyrazowe argumenty -p);
// shell:true zostaje wyłącznie jako fallback, gdy `where` nie znajdzie binarki.
function resolveClaudeBin() {
  if (binOverride) return { bin: binOverride, useShell: false };
  let bin = CLAUDE_BIN;
  let useShell = false;
  if (IS_WIN) {
    try {
      bin = execSync('where claude', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim();
    } catch {
      useShell = true;
    }
  }
  return { bin, useShell };
}

function spawnClaude(args) {
  const { bin, useShell } = resolveClaudeBin();
  return spawn(bin, args, {
    cwd: WORKSPACE_DIR,
    env: buildCleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
    windowsHide: true,
  });
}

module.exports = { spawnClaude, buildCleanEnv, readOauthToken, setClaudeBin, OAUTH_TOKEN_FILE };
