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

// Na Windows resolve pełnej ścieżki do binarki przez `where claude`,
// żeby uniknąć shell:true (cmd.exe rozbija wielowyrazowe argumenty -p).
// `where` zwraca WSZYSTKIE dopasowania z PATH — przy instalacji z npm są to
// `claude` (skrypt POSIX #!/bin/sh, Windows go nie odpali → ENOENT -4058)
// i `claude.cmd` (shim). Pierwsza linia to zły plik, dlatego wybór jest jawny:
//   1. `claude.exe` (natywny installer) → spawn bezpośredni,
//   2. `claude.cmd` z npm → Node NIE spawnuje .cmd bez shell:true (EINVAL od
//      18.20/20.12, łatka CVE-2024-27980), więc omijamy shim i odpalamy
//      `process.execPath <npm>\node_modules\@anthropic-ai\claude-code\cli.js`.
// Gdy `where` nie znajdzie nic użytecznego — czytelny błąd zamiast fallbacku shell:true:
// przy shell:true Node NIE escapuje argumentów, więc metaznaki cmd.exe w treści
// promptu (webhook_payload z publicznego /webhook/:token, tekst z /ask) wykonałyby
// się jako komendy. Fail-fast runu > cicha podatność na command injection.
// Zwraca { bin, argsPrefix } — argsPrefix to argumenty doklejane PRZED argumentami
// wywołującego (pusty dla .exe, [cli.js] dla npm).
// deps ({isWin, exec, exists}) wstrzykiwane dla testów — gałąź Windows jest martwa na Macu.
// path.win32 jawnie — gałąź jest testowana na Macu, a ścieżki z `where` są Windowsowe.
const NPM_CLI_REL = path.win32.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

function resolveClaudeBin({ isWin = IS_WIN, exec = execSync, exists = fs.existsSync } = {}) {
  if (binOverride) return { bin: binOverride, argsPrefix: [] };
  if (!isWin) return { bin: CLAUDE_BIN, argsPrefix: [] };

  let lines;
  try {
    lines = exec('where claude', { encoding: 'utf-8', windowsHide: true })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    throw new Error(
      'Nie znaleziono binarki `claude` w PATH (`where claude` bez wyniku). ' +
      'Zainstaluj Claude Code CLI (`irm https://claude.ai/install.ps1 | iex`) albo dodaj ją do PATH ' +
      '— celowo brak fallbacku shell:true (ryzyko command injection).'
    );
  }

  const exe = lines.find((l) => /\.exe$/i.test(l));
  if (exe) return { bin: exe, argsPrefix: [] };

  const cmd = lines.find((l) => /\.cmd$/i.test(l));
  if (cmd) {
    const cli = path.win32.join(path.win32.dirname(cmd), NPM_CLI_REL);
    if (exists(cli)) return { bin: process.execPath, argsPrefix: [cli] };
  }

  throw new Error(
    `\`where claude\` znalazło tylko: ${lines.join(', ')} — żadnego \`claude.exe\` ani shima npm z cli.js. ` +
    'Skrypt `claude` bez rozszerzenia to POSIX-owy sh, Windows go nie uruchomi. ' +
    'Zainstaluj Claude Code natywnie: `irm https://claude.ai/install.ps1 | iex`.'
  );
}

function spawnClaude(args) {
  const { bin, argsPrefix } = resolveClaudeBin();
  return spawn(bin, [...argsPrefix, ...args], {
    cwd: WORKSPACE_DIR,
    env: buildCleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

module.exports = { spawnClaude, resolveClaudeBin, buildCleanEnv, readOauthToken, setClaudeBin, OAUTH_TOKEN_FILE };
