// Odczyt zmiennej środowiskowej UTRWALONEJ przez instalator — czyli tej, którą zobaczy
// NASTĘPNY proces, nie tej, którą trzyma w pamięci proces bieżący (`lib/config.js` czyta
// `process.env` raz przy require). Różnica między tymi dwiema wartościami to udokumentowana
// pułapka: docs/solutions/deployment-issues/2026-07-07-stale-env-vps-url-hook-respawn-serwera.md
// — serwer proxował do martwego adresu, bo hook wskrzesił go z env starej sesji terminala.
//
// LUSTRO ZAPISU: `setup.mjs` → `upsertEnvLine` (Unix, format `export NAZWA=<JSON.stringify(wartość)>`)
// oraz `buildSetUserEnvCommand`/`persistUserEnvWin32` (Windows, `[Environment]::SetEnvironmentVariable(..., 'User')`).
// To ŚWIADOMA druga implementacja: `setup.mjs` jest ESM, `server.js` CommonJS — synchroniczny
// import nie przejdzie. Zmiana formatu zapisu po tamtej stronie MUSI trafić tutaj (precedens
// w repo: `INBOX_CODE_PREFIX` w `server.js` vs `scripts/inbox/invite.mjs`).
//
// Zasada nadrzędna: nieczytelne/brakujące źródło → `null` („nie wiem"), nigdy zgadywanie
// i nigdy wyjątek — `/api/status` ma żyć dalej.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// I/O wstrzykiwane w testach (wzorzec `REAL_IO` z lib/platform.js) — testy nie mogą
// dotykać prawdziwego ~/.zshrc ani rejestru maszyny usera.
const REAL_IO = {
  readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
  spawnSync,
  homedir: () => os.homedir(),
  platform: () => process.platform,
  shell: () => process.env.SHELL || '',
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Dekoduje prawą stronę `export NAZWA=...`. `setup.mjs` pisze przez `JSON.stringify`,
// więc podstawowy przypadek to literał w cudzysłowach (spacje i znaki specjalne w wartości
// są wtedy poprawnie odkodowane). Apostrofy i goły token obsłużone dla linii pisanych ręcznie.
function decodeShellValue(rawValue) {
  const raw = String(rawValue).trim();
  if (!raw) return null;

  if (raw.startsWith('"')) {
    try {
      const decoded = JSON.parse(raw);
      return typeof decoded === 'string' && decoded ? decoded : null;
    } catch {
      return null; // uszkodzona linia = „nie wiem", nie zgadywanie prefiksu
    }
  }

  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) return null;
    const inner = raw.slice(1, -1);
    return inner || null;
  }

  // Goły token: wartość kończy się na pierwszej spacji (dalej może być komentarz shellu).
  const bare = raw.split(/\s+/)[0];
  return bare || null;
}

// Pure: wyciąga wartość z treści pliku RC. Bierze OSTATNIE trafienie — w shellu wygrywa
// ostatni `export`, a ręcznie dopisana linia bywa poniżej tej z instalatora.
// Linia zakomentowana (`# export ...`) nie pasuje: regex kotwiczy `export` na początku linii.
function parsePersistedExport(rcContent, varName) {
  if (typeof rcContent !== 'string' || !rcContent) return null;
  const re = new RegExp(`^export ${escapeRegExp(varName)}=(.*)$`, 'gm');
  let last = null;
  let match;
  while ((match = re.exec(rcContent)) !== null) last = match[1];
  if (last === null) return null;
  return decodeShellValue(last);
}

// Kolejność plików RC lustrzana do `resolveShellRc` w setup.mjs (SHELL rozstrzyga zsh/bash),
// ale czytamy OBA: instalacja mogła powstać pod innym shellem niż bieżący proces daemona
// (launchd/systemd startują z minimalnym środowiskiem, bez SHELL).
function resolveRcCandidates(io) {
  const home = io.homedir();
  const preferred = String(io.shell() || '').includes('bash') ? '.bashrc' : '.zshrc';
  const other = preferred === '.bashrc' ? '.zshrc' : '.bashrc';
  return [path.join(home, preferred), path.join(home, other)];
}

function readUnixPersistedEnv(varName, io) {
  for (const rcPath of resolveRcCandidates(io)) {
    let content;
    try {
      content = io.readFile(rcPath);
    } catch {
      continue; // brak pliku RC — próbuj następnego kandydata
    }
    const value = parsePersistedExport(content, varName);
    if (value) return value;
  }
  return null;
}

// Twardy limit na spawn PowerShella. Bez niego zawieszony PowerShell (skan AV, wysycony host,
// polityka wykonania czekająca na I/O) blokuje `spawnSync` NA ZAWSZE, a z nim jednowątkowy
// serwer: dashboard, webhooki, `/inbox/v1/*` i kolejka jobów przestają odpowiadać bez logu.
// Kontrakt modułu („nieczytelne źródło = null") obejmuje więc też zwis: zabijamy i zwracamy null.
const WINDOWS_ENV_READ_TIMEOUT_MS = 3000;

function readWindowsPersistedEnv(varName, io) {
  // Lustro zapisu z `buildSetUserEnvCommand` (setup.mjs) — ten sam scope 'User' (HKCU\Environment).
  const quoted = `'${String(varName).replace(/'/g, "''")}'`;
  const script = `[Environment]::GetEnvironmentVariable(${quoted}, 'User')`;
  const result = io.spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf-8',
    timeout: WINDOWS_ENV_READ_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    // Serwer Pulsa nie ma własnej konsoli, więc BEZ tej flagi Windows daje spawnowanemu
    // PowerShellowi nowe okno: mrugało co 30 s (TTL cache) przy każdym otwartym panelu,
    // bo `/api/status` odpytuje ten moduł. Nie dotyka stdout ani kodu wyjścia — czytamy
    // `result.stdout` jak dotąd.
    windowsHide: true,
  });
  // `signal` niepuste = proces ubity timeoutem; `status` bywa wtedy `null`, więc sam warunek
  // `status !== 0` nie wystarcza jako wykrycie zwisu.
  if (!result || result.error || result.signal || result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value || null;
}

// Zwraca utrwaloną wartość albo `null` („nie wiem"). Nigdy nie rzuca.
function readPersistedEnv(varName, io = REAL_IO) {
  try {
    return io.platform() === 'win32'
      ? readWindowsPersistedEnv(varName, io)
      : readUnixPersistedEnv(varName, io);
  } catch {
    return null;
  }
}

// Cache odczytu utrwalonej wartości. `/api/status` jest odpytywane przez panel co 3 s i NIE ma
// autoryzacji ani rate limitu (a `ACAO: *` pozwala dowolnej stronie bić w localhost w pętli),
// więc odczyt per żądanie znaczy na Windowsie spawn PowerShella (~100–400 ms) blokujący pętlę
// zdarzeń serwera — heartbeat, idle-timeouty executora i drain kolejki przesuwają się, a przy
// zalewie żądań to gotowy DoS schedulera. Utrwalona wartość zmienia się wyłącznie przy
// re-runie instalatora, więc TTL rzędu pół minuty niczego praktycznie nie opóźnia.
const PERSISTED_ENV_TTL_MS = 30_000;
const persistedEnvCache = new Map();

// `now` wstrzykiwane (wzorzec czystych funkcji z argumentami) — test nie czeka 30 s.
function readPersistedEnvCached(varName, io = REAL_IO, now = Date.now()) {
  const cached = persistedEnvCache.get(varName);
  if (cached && now - cached.at < PERSISTED_ENV_TTL_MS) return cached.value;
  const value = readPersistedEnv(varName, io);
  persistedEnvCache.set(varName, { at: now, value });
  return value;
}

function clearPersistedEnvCache() {
  persistedEnvCache.clear();
}

// Pure: kształt pola dla `/api/status`. `mismatch` jest TYLKO wtedy, gdy obie wartości są
// znane i różne — brak odczytu utrwalonej wartości to „nie wiem", a nie oskarżenie o rozjazd.
function describeEnvUsage({ inUse, persisted }) {
  const used = typeof inUse === 'string' ? inUse.trim() : '';
  const saved = typeof persisted === 'string' && persisted.trim() ? persisted.trim() : null;
  return {
    in_use: used,
    persisted: saved,
    mismatch: saved !== null && saved !== used,
  };
}

module.exports = {
  PERSISTED_ENV_TTL_MS,
  REAL_IO,
  clearPersistedEnvCache,
  decodeShellValue,
  describeEnvUsage,
  parsePersistedExport,
  readPersistedEnv,
  readPersistedEnvCached,
};
