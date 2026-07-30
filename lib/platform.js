const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');
const { IS_MAC, IS_WIN, HOME, PROJECT_ROOT } = require('./config');

// JEDNA stała etykiety dla PLIST_PATH, installMac() i getStatus() — rozjazd nazw
// (instalowana `scheduler`, sprawdzana inna) był powodem panelu kłamiącego o autostarcie.
// Zostaje `scheduler`, bo to udokumentowany identyfikator techniczny (CLAUDE.md).
const PLIST_LABEL = 'com.claude-cron.scheduler';
// Etykiety, pod którymi na dysku bywają agenty postawione RĘCZNIE (np. `daemon` z 23.07).
// getStatus() je rozpoznaje, a installMac() sprząta — dwa agenty robiące to samo
// biją się o port 7777 (drugi pada na EADDRINUSE).
const LEGACY_PLIST_LABELS = ['com.claude-cron.daemon'];
const PLIST_PATH = IS_MAC ? path.join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`) : '';
const WIN_TASK_NAME = 'ClaudeCron';
// Pinowana wersja portable Node — MUSI być spójna z install.sh (NODE_VERSION)
// i setup.mjs. Używana tylko jako ostatni fallback budowy ścieżki.
const PINNED_NODE_VERSION = '22.17.0';
// Klucze env wypalane w plist. Wartości bierzemy ze środowiska INSTALACJI: launchd
// nie widzi shell RC, a env żyjącego procesu nie propaguje się do agenta.
const PLIST_ENV_KEYS = ['PATH', 'HOME', 'CLAUDE_CRON_WORKSPACE', 'CLAUDE_CRON_VPS_URL'];

function macLogFile(home = HOME) {
  // Logi POZA drzewem repo: repo stoi w ~/Documents, a launchd nie ma zgody TCC na ten
  // katalog — plist z logami w <repo>/data/ pada natychmiast z EX_CONFIG (78).
  return path.join(home, 'Library', 'Logs', 'claude-cron', 'daemon.log');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Cytowanie dla /bin/sh -c: ścieżka z apostrofem/spacją nie może rozwalić komendy.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Klucz pusty/whitespace POMIJAMY zamiast wpisywać pusty string — plist z pustym
// CLAUDE_CRON_VPS_URL wygląda na skonfigurowany i myli diagnozę proxy (503 vs 502).
function pickPlistEnv(env) {
  const picked = {};
  for (const key of PLIST_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') picked[key] = value;
  }
  return picked;
}

// Czysty generator plista (wzorzec działającego agenta z 23.07). Wrapper `/bin/sh -c`
// z `cd <repo> && exec <node> server.js` zamiast gołego ProgramArguments: daje jedno
// miejsce na cwd + flagi i jest tym, co realnie wstaje pod launchd.
function buildPlist({ label, repoDir, nodeBin, logFile, env }) {
  const command = `cd ${shellQuote(repoDir)} && exec ${shellQuote(nodeBin)} --disable-warning=ExperimentalWarning server.js`;
  const envEntries = Object.entries(pickPlistEnv(env))
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${escapeXml(command)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
</dict>
</plist>`;
}

// Ścieżka do przenośnego Node z <repo>/.node — daemon NIE może polegać na `which node`:
// launchd startuje z minimalnym PATH, a instalatory celowo nie dotykają systemowego Node.
// Kolejność: execPath (ten Node, który biegnie) → istniejący dyst w .node/ → pinowana wersja.
// Świadoma duplikacja detectPortableNodeBin z setup.mjs: tamten moduł to ESM, a ten plik
// CommonJS — synchronicznego importu nie ma, a wspólny shim byłby droższy niż 10 linii.
function resolvePortableNodeBin(execPath, repoDir) {
  const nodeBase = path.join(repoDir, '.node');
  if (execPath && execPath.includes(`${path.sep}.node${path.sep}`)) return execPath;

  // Po podbiciu wersji w .node/ potrafią leżeć DWA dysty — bierzemy pinowany, nie
  // pierwszy z brzegu (alfabetycznie pierwszy bywa tym starym, wycofywanym).
  const pinnedDist = `node-v${PINNED_NODE_VERSION}-${process.platform}-${process.arch}`;
  const installed = readNodeDistDirs(nodeBase);
  if (installed.includes(pinnedDist)) return path.join(nodeBase, pinnedDist, 'bin', 'node');
  if (installed.length > 0) return path.join(nodeBase, installed[installed.length - 1], 'bin', 'node');

  return path.join(nodeBase, pinnedDist, 'bin', 'node');
}

function readNodeDistDirs(nodeBase) {
  try {
    return fs.readdirSync(nodeBase)
      .filter(name => name.startsWith('node-v') && fs.existsSync(path.join(nodeBase, name, 'bin', 'node')))
      .sort();
  } catch (err) {
    // ENOENT = .node/ jeszcze nie ma (instalacja z systemowego Node) — to normalny
    // przypadek, obsługiwany fallbackiem. Inne błędy propagujemy.
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Czysty parser `launchctl list`: kolumny to PID\tStatus\tLabel. Decyduje KOLUMNA PID
// ('-' = wczytany, ale nie biegnie), nigdy substring całej linii — stara wersja robiła
// `!out.includes('-')`, a myślnik siedzi w samej nazwie `claude-cron` (running zawsze false).
// Dopasowanie po CAŁEJ etykiecie, nie po fragmencie (com.claude-cron.scheduler.backup ≠ nasz agent).
function parseLaunchctlList(output, label) {
  const miss = { found: false, running: false, pid: null };
  for (const line of String(output).split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 3 || cols[2].trim() !== label) continue;
    const pid = Number.parseInt(cols[0].trim(), 10);
    return Number.isNaN(pid)
      ? { found: true, running: false, pid: null }
      : { found: true, running: true, pid };
  }
  return miss;
}

// Czysta decyzja o statusie autostartu na macOS. Kanoniczna etykieta ma pierwszeństwo;
// dopiero gdy jej nie ma, raportujemy agenta postawionego ręcznie pod starą nazwą
// (pola `label`/`legacy` są ADDYTYWNE — kontrakt {installed, running, platform} bez zmian).
function buildMacStatus({ launchctlOutput, plistExists, legacyAgents = [] }) {
  const own = parseLaunchctlList(launchctlOutput, PLIST_LABEL);
  if (own.found || plistExists) {
    return { installed: true, running: own.running, platform: 'macos', label: PLIST_LABEL, legacy: false };
  }

  for (const agent of legacyAgents) {
    const legacy = parseLaunchctlList(launchctlOutput, agent.label);
    if (legacy.found || agent.plistExists) {
      return { installed: true, running: legacy.running, platform: 'macos', label: agent.label, legacy: true };
    }
  }

  return { installed: false, running: false, platform: 'macos', label: PLIST_LABEL, legacy: false };
}

function generatePlist() {
  return buildPlist({
    label: PLIST_LABEL,
    repoDir: PROJECT_ROOT,
    nodeBin: resolvePortableNodeBin(process.execPath, PROJECT_ROOT),
    logFile: macLogFile(),
    env: process.env,
  });
}

function installMac() {
  const dir = path.dirname(PLIST_PATH);
  fs.mkdirSync(dir, { recursive: true });
  // Katalog logów musi istnieć PRZED load — launchd nie tworzy go sam i agent
  // pada na EX_CONFIG bez żadnego wpisu w logu (bo logu nie ma gdzie zapisać).
  fs.mkdirSync(path.dirname(macLogFile()), { recursive: true });
  // Domknij poprzedni stan przed load: własną etykietę (load na już wczytanej pada)
  // oraz ręczne agenty pod starymi nazwami. Pad unloadu własnej etykiety świadomie
  // ignorujemy — przy pierwszej instalacji nie ma czego odpinać, a realny problem
  // i tak wyjdzie głośno z `launchctl load` niżej (stdio: 'inherit').
  unloadAgent(PLIST_PATH);
  removeLegacyAgents();
  fs.writeFileSync(PLIST_PATH, generatePlist(), 'utf-8');
  execFileSync('launchctl', ['load', '-w', PLIST_PATH], { stdio: 'inherit' });
  return PLIST_PATH;
}

function legacyPlistPath(label) {
  return path.join(HOME, 'Library', 'LaunchAgents', `${label}.plist`);
}

// Pełny `launchctl list` (bez grepa) — filtrowanie robi czysty parser, żeby dało się je
// przetestować bez odpalania launchctl. Pad CLI (brak sesji GUI) = brak agentów.
let launchctlWarned = false;
function readLaunchctlList() {
  try {
    return execFileSync('launchctl', ['list'], { encoding: 'utf-8' });
  } catch (err) {
    // Ostrzegamy RAZ na proces: getStatus() wisi pod /api/status, które dashboard
    // odpytuje co 3 s — logowanie przy każdym padzie zalałoby log daemona.
    if (!launchctlWarned) {
      launchctlWarned = true;
      console.warn(`[platform] launchctl list nie odpowiedział: ${err.message}`);
    }
    return '';
  }
}

// Zwraca wynik zamiast łykać błąd po cichu — o tym, czy pad jest groźny, decyduje wołający:
// przy własnej etykiecie „nie był wczytany" to norma, przy kasowaniu legacy oznacza sierotę.
function unloadAgent(plistPath) {
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Sprząta agenty postawione ręcznie pod starą etykietą. Bez tego po instalacji żyją DWA
// agenty startujące ten sam serwer — drugi pada na EADDRINUSE (port 7777), a user widzi
// „daemon działa" przy losowo wybranym zwycięzcy wyścigu.
function removeLegacyAgents() {
  for (const label of LEGACY_PLIST_LABELS) {
    const legacyPath = legacyPlistPath(label);
    if (!fs.existsSync(legacyPath)) continue;
    const unloaded = unloadAgent(legacyPath);
    fs.unlinkSync(legacyPath);
    console.log(`[platform] Usunięto stary agent launchd: ${label}`);
    // Nieudany unload przy ISTNIEJĄCYM pliku bywa niegroźny (agent nigdy nie był wczytany),
    // ale gdy jednak biegł, kasujemy plist spod żyjącego procesu — trzyma port 7777 do reboota.
    // Bez tego ostrzeżenia diagnoza EADDRINUSE zaczyna się od zera.
    if (!unloaded.ok) {
      console.warn(`[platform] launchctl unload ${label} nie powiódł się (${unloaded.error.message}) — jeśli agent biegł, ubij go ręcznie albo zrestartuj Maca`);
    }
  }
}

function uninstallMac() {
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'inherit' });
  } catch { /* already unloaded */ }
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
}

function getStatus() {
  if (IS_MAC) {
    return buildMacStatus({
      launchctlOutput: readLaunchctlList(),
      plistExists: fs.existsSync(PLIST_PATH),
      legacyAgents: LEGACY_PLIST_LABELS.map(label => ({
        label,
        plistExists: fs.existsSync(legacyPlistPath(label)),
      })),
    });
  }
  if (IS_WIN) {
    try {
      execSync('schtasks /Query /TN "ClaudeCron"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      return { installed: true, running: true, platform: 'windows' };
    } catch {
      return { installed: false, running: false, platform: 'windows' };
    }
  }
  return { installed: false, running: false, platform: process.platform };
}

// === Windows Task Scheduler ===

function installWin() {
  const nodePath = execSync('where node', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim();
  const serverPath = path.join(PROJECT_ROOT, 'server.js');

  try {
    execSync(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F`, { stdio: 'ignore', windowsHide: true });
  } catch { /* not installed */ }

  execSync(
    `schtasks /Create /TN "${WIN_TASK_NAME}" /TR "\\"${nodePath}\\" \\"${serverPath}\\"" /SC ONLOGON /RL HIGHEST /F`,
    { stdio: 'inherit', windowsHide: true }
  );
  return WIN_TASK_NAME;
}

function uninstallWin() {
  try {
    execSync(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F`, { stdio: 'inherit', windowsHide: true });
  } catch { /* not installed */ }
}

function install() {
  if (IS_MAC) return installMac();
  if (IS_WIN) return installWin();
  throw new Error(`Autostart not supported on ${process.platform}`);
}

function uninstall() {
  if (IS_MAC) return uninstallMac();
  if (IS_WIN) return uninstallWin();
  throw new Error(`Autostart not supported on ${process.platform}`);
}

module.exports = {
  install, uninstall, installMac, uninstallMac, installWin, uninstallWin, getStatus, generatePlist,
  // Czyste funkcje wystawione dla testów (I/O zostaje w cienkiej skorupie install/getStatus).
  buildPlist, buildMacStatus, parseLaunchctlList, pickPlistEnv, resolvePortableNodeBin,
  PLIST_PATH, PLIST_LABEL,
};
