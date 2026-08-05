// Aktualizacja Pulsa z panelu: sprawdzenie dostępności nowej wersji + uruchomienie
// podmiany kodu. Odpowiada na pytanie „czy mam najnowszą wersję" i „zaktualizuj mnie".
//
// Wersja lokalna pochodzi z `data/version.json` (lib/version.js), NIE z gita: instalacja
// zipowa/tarballowa nie ma repozytorium, a to ona jest domyślną drogą u użytkowników.
// Wersja zdalna z publicznego API GitHuba (repo jest publiczne — zero tokenu).
//
// Kontrakt stanów jest CZTEROWARTOŚCIOWY i to jest sedno tego modułu: „nie wiem"
// (lokalna rewizja `unknown` — np. VPS instalowany skryptem, który nie odpala setup.mjs)
// oraz „nie udało się sprawdzić" (API padło) NIE MOGĄ udawać „masz aktualne".
// Fałszywe „aktualne" jest gorsze niż brak odpowiedzi — user przestaje sprawdzać.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { PROJECT_ROOT } = require('./config');
const { UNKNOWN, getInstallVersion } = require('./version');

const GITHUB_API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
// Slug/gałąź z env — te same nazwy co w instalatorach (test z forka/gałęzi bez zmiany kodu).
const REPO_SLUG = process.env.CLAUDE_CRON_REPO_SLUG || 'AIBiz-Automatyzacje/claude-cron';
const REPO_REF = process.env.CLAUDE_CRON_REF || 'main';
const CHECK_TIMEOUT_MS = 10_000;
// Rewizja lokalna bywa SKRÓCONA (`git rev-parse --short` przy instalacji z klona), a zdalna
// jest zawsze pełna — porównanie po prefiksie. 7 znaków to minimum, przy którym prefiks
// jednoznacznie wskazuje commit; krócej porównywalibyśmy przypadkowe zbiegi.
const MIN_REVISION_PREFIX = 7;

const STATUS = {
  CURRENT: 'current',
  AVAILABLE: 'available',
  UNKNOWN: 'unknown',
  CHECK_FAILED: 'check_failed',
};

function normalizeRevision(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function shortRevision(revision) {
  return normalizeRevision(revision).slice(0, MIN_REVISION_PREFIX);
}

// Czy dwie rewizje wskazują ten sam commit. Prefiks liczy się TYLKO w jedną stronę
// naraz (krótsza musi być początkiem dłuższej) i tylko od MIN_REVISION_PREFIX w górę.
function revisionsMatch(a, b) {
  const left = normalizeRevision(a);
  const right = normalizeRevision(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (shorter.length < MIN_REVISION_PREFIX) return false;
  return longer.startsWith(shorter);
}

function isKnownRevision(revision) {
  const value = normalizeRevision(revision);
  return value !== '' && value !== UNKNOWN;
}

// Czysta decyzja o stanie aktualizacji — całe rozstrzyganie „co pokazać" bez I/O.
// `can_update` przy stanie `unknown` jest CELOWO true: instalacja bez znanej rewizji
// to dokładnie ta, którą warto przeinstalować, żeby wersja wreszcie się zapisała.
function buildUpdateStatus({ version, remote, now = new Date() } = {}) {
  const local = version || { revision: UNKNOWN, installed_at: null, source: UNKNOWN };
  const base = {
    local_revision: local.revision || UNKNOWN,
    installed_at: local.installed_at || null,
    source: local.source || UNKNOWN,
    remote_revision: null,
    checked_at: now.toISOString(),
  };

  if (!remote || remote.ok !== true) {
    const reason = (remote && remote.error) || 'brak odpowiedzi';
    return {
      ...base,
      status: STATUS.CHECK_FAILED,
      can_update: false,
      message: `Nie udało się sprawdzić aktualizacji (${reason}).`,
    };
  }

  base.remote_revision = remote.revision;

  if (!isKnownRevision(local.revision)) {
    return {
      ...base,
      status: STATUS.UNKNOWN,
      can_update: true,
      message: 'Nie wiem, jaka wersja jest zainstalowana — nie mogę porównać z najnowszą.',
    };
  }

  if (revisionsMatch(local.revision, remote.revision)) {
    return { ...base, status: STATUS.CURRENT, can_update: false, message: 'Masz najnowszą wersję.' };
  }

  return {
    ...base,
    status: STATUS.AVAILABLE,
    can_update: true,
    message: `Dostępna nowa wersja (${shortRevision(remote.revision)}).`,
  };
}

// Odpytanie GitHuba o SHA czoła gałęzi. NIGDY nie rzuca — pad sieci/limit API to
// normalny stan, który ma dać czytelne „nie udało się sprawdzić", a nie 500 w panelu.
// `fetchImpl` wstrzykiwany (testy nie chodzą do sieci).
async function fetchLatestRevision({
  fetchImpl = globalThis.fetch,
  slug = REPO_SLUG,
  ref = REPO_REF,
  timeoutMs = CHECK_TIMEOUT_MS,
} = {}) {
  const url = `${GITHUB_API_BASE}/repos/${slug}/commits/${ref}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'puls-updater' },
      signal: controller.signal,
    });
    if (!res || !res.ok) return { ok: false, error: `HTTP ${res ? res.status : '?'}` };

    const body = await res.json();
    const revision = normalizeRevision(body && body.sha);
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      return { ok: false, error: 'odpowiedź GitHuba bez poprawnego SHA' };
    }
    return { ok: true, revision };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `przekroczono ${timeoutMs} ms` : err.message;
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function checkForUpdate({ version, ...fetchOptions } = {}) {
  const local = version || getInstallVersion();
  const remote = await fetchLatestRevision(fetchOptions);
  return buildUpdateStatus({ version: local, remote });
}

// === Uruchomienie aktualizacji (per-OS) ===

// Cytowanie dla /bin/sh -c oraz dla PowerShell -Command. Katalog instalacji to wolne
// wejście usera (spacje, apostrofy) — świadoma duplikacja helperów z platform.js:
// prosta duplikacja jest tańsza niż wspólny moduł na dwie linijki.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Mac: `git pull --ff-only`, zgaszenie starego procesu, zapis wersji i PONOWNY START
// serwera. `kill` leci TYLKO po udanym pullu (`&&`): przy konflikcie/braku sieci serwer
// ma żyć dalej, a panel po timeoucie powie wprost, że się nie udało.
// `sleep 1` daje odpowiedzi HTTP szansę dojść do panelu, zanim zniknie proces.
//
// Dwa kroki po `kill` są OBOWIĄZKOWE (parytet z `Invoke-UpdateFinish` w install.ps1):
//  1) zapis `data/version.json` — plik wersji piszą wyłącznie instalatory, a ta ścieżka
//     ich nie odpala; bez zapisu `/api/status` po UDANEJ aktualizacji zwracałby STARĄ
//     rewizję, panel po 6 min mówiłby „nie powiodła się", a `GET /api/update` w kółko
//     raportowałby „dostępna nowa wersja";
//  2) start serwera — na Macu NIC go nie wskrzesza (launchd z platform.js nie jest wpięty
//     w ścieżkę usera, a hook Claude Code czeka na zdarzenie sesji), więc bez tego kliknięcie
//     „Zaktualizuj" zostawiałoby maszynę bez schedulera na czas nieokreślony.
//
// Restart jest oddzielony od zapisu wersji średnikiem, NIE `&&`: wersja to metadana,
// jej pad nie może zostawić maszyny bez serwera. Rewizja idzie env-em, żeby do `-e`
// nie wchodziła interpolacja shellowa.
function buildMacUpdateCommand({ repoDir, pid, nodeBin = process.execPath }) {
  const node = shellQuote(nodeBin);
  const writeVersion = [
    'CLAUDE_CRON_UPDATE_REVISION="$(git rev-parse HEAD)"',
    node,
    '--disable-warning=ExperimentalWarning',
    '-e',
    '"require(\'./lib/version\').writeVersionFile({revision:process.env.CLAUDE_CRON_UPDATE_REVISION,source:\'git\'})"',
  ].join(' ');
  const restart = `${node} --disable-warning=ExperimentalWarning server.js`;
  const script =
    `sleep 1; cd ${shellQuote(repoDir)} && git pull --ff-only && kill ${Number(pid)} && ` +
    `{ ${writeVersion}; sleep 2; exec ${restart}; }`;
  return { command: '/bin/sh', args: ['-c', script] };
}

// Windows: proces MUSI przeżyć śmierć rodzica, bo to on ubija daemona (pliki aplikacji są
// zablokowane, dopóki serwer je trzyma — learned pattern 2026-07-28). Ubijanie robi sam
// install.ps1 (`Stop-PulsProcesses`, filtr po ŚCIEŻCE instalacji, nigdy po nazwie binarki).
// Skrypt instalatora adresowany po SHA, nie po nazwie gałęzi — raw.githubusercontent
// cachuje URL-e z nazwą gałęzi i potrafi podać stary plik.
// CLAUDE_CRON_NONINTERACTIVE=1 przełącza install.ps1 w tryb bez pytań (zero setup.mjs).
//
// Gdy znamy pełny SHA, podajemy instalatorowi GOTOWE źródło zipa (`CLAUDE_CRON_ZIP_URL`
// + `CLAUDE_CRON_ZIP_TOPDIR`) i rewizję (`CLAUDE_CRON_INSTALL_REVISION`). Bez tego
// `Resolve-ZipSource` pyta api.github.com o SHA DRUGI raz na ten sam commit, a przy
// wyczerpanym limicie 60/h (panel zużył już GET i POST /api/update) schodzi na fallback
// `archive/refs/heads/<SHA>.zip` — gałąź o nazwie SHA nie istnieje, więc 404 i pad
// aktualizacji. `CLAUDE_CRON_INSTALL_REVISION` jest przy tym warunkiem zapisu
// `data/version.json` przez `Invoke-UpdateFinish`.
function buildWindowsUpdateCommand({ repoDir, revision, slug = REPO_SLUG }) {
  const ref = normalizeRevision(revision) || REPO_REF;
  const isSha = /^[0-9a-f]{40}$/.test(ref);
  const scriptUrl = `${RAW_BASE}/${slug}/${ref}/install.ps1`;
  const script = [
    'Start-Sleep -Seconds 2',
    `$env:INSTALL_DIR=${psQuote(repoDir)}`,
    "$env:CLAUDE_CRON_NONINTERACTIVE='1'",
    `$env:CLAUDE_CRON_REF=${psQuote(ref)}`,
    ...(isSha
      ? [
        `$env:CLAUDE_CRON_ZIP_URL=${psQuote(`https://github.com/${slug}/archive/${ref}.zip`)}`,
        `$env:CLAUDE_CRON_ZIP_TOPDIR=${psQuote(`claude-cron-${ref}`)}`,
        `$env:CLAUDE_CRON_INSTALL_REVISION=${psQuote(ref)}`,
      ]
      : []),
    `irm ${psQuote(scriptUrl)} | iex`,
  ].join('; ');
  return {
    command: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  };
}

// Czysty planer: co i czym odpalić na danej platformie. Zwraca `{ok:false, error}` zamiast
// rzucać — brak `.git` na Macu (instalacja zipowa) to przewidziany, opisywalny stan.
function planUpdate({ platform, repoDir, revision, pid, hasGit, nodeBin }) {
  if (platform === 'darwin') {
    if (!hasGit) {
      return {
        ok: false,
        error: 'Ta instalacja nie ma repozytorium git — zaktualizuj ją ponownym uruchomieniem instalatora.',
      };
    }
    return { ok: true, kind: 'mac', cwd: repoDir, ...buildMacUpdateCommand({ repoDir, pid, nodeBin }) };
  }
  if (platform === 'win32') {
    // cwd POZA katalogiem instalacji: Windows blokuje katalog roboczy żywego procesu,
    // a to właśnie ten proces przenosi `$InstallDir` w `Install-FreshRepo`. Z `cwd`
    // ustawionym na repo `Move-Item` pada „Proces nie moze uzyskac dostepu do pliku"
    // JUŻ PO `Stop-PulsProcesses` — daemon ubity, zadanie Task Scheduler jest ONLOGON,
    // więc maszyna zostaje bez Pulsa do następnego logowania (learned pattern 2026-07-28).
    return {
      ok: true,
      kind: 'windows',
      cwd: os.tmpdir(),
      ...buildWindowsUpdateCommand({ repoDir, revision }),
    };
  }
  return { ok: false, error: `Aktualizacja z panelu nie jest wspierana na ${platform}.` };
}

// Wstrzykiwalne I/O (wzorzec REAL_IO z platform.js) — kontraktem jest to, CO i JAK
// zostaje odpalone, a tego nie da się sprawdzić realnym spawnem ubijającym serwer.
const REAL_IO = {
  spawn: (command, args, options) => spawn(command, args, options),
  exists: file => fs.existsSync(file),
  log: message => console.log(message),
  warn: message => console.warn(message),
};

// Czy aktualizacja już biegnie. Stan in-memory (wzorzec liczników z ask.js): odczepiony
// instalator przeżywa śmierć daemona, więc DRUGI klik (np. po odświeżeniu panelu, które
// gubi blokadę w przeglądarce) odpaliłby DRUGI instalator — na Windowsie dwa równoległe
// `install.ps1` robią naraz `Stop-PulsProcesses` i `Move-Item` katalogu z bazą.
// Flagi nie trzeba czyścić po sukcesie: proces i tak zaraz ginie od aktualizacji.
let updateInProgress = false;

function isUpdateInProgress() {
  return updateInProgress;
}

// Wyłącznie dla testów (wzorzec db.setDbPath) — stan współbieżności żyje w module.
function resetUpdateState() {
  updateInProgress = false;
}

function startUpdate({
  revision,
  repoDir = PROJECT_ROOT,
  platform = process.platform,
  pid = process.pid,
  nodeBin = process.execPath,
  io = REAL_IO,
} = {}) {
  if (updateInProgress) {
    return { ok: false, busy: true, error: 'Aktualizacja już trwa — poczekaj na jej zakończenie.' };
  }

  const plan = planUpdate({
    platform,
    repoDir,
    revision,
    pid,
    nodeBin,
    hasGit: io.exists(path.join(repoDir, '.git')),
  });
  if (!plan.ok) return plan;

  // detached + stdio:'ignore' + unref — proces aktualizacji ma przeżyć śmierć rodzica
  // (na Windowsie to on ubija daemona, na Macu daemon ginie od `kill` z tego skryptu).
  const child = io.spawn(plan.command, plan.args, {
    detached: true,
    stdio: 'ignore',
    cwd: plan.cwd,
    windowsHide: true,
  });
  updateInProgress = true;
  if (child && typeof child.on === 'function') {
    child.on('error', err => {
      // Instalator w ogóle nie ruszył — blokada musi puścić, inaczej panel nigdy
      // nie pozwoliłby spróbować ponownie bez restartu daemona.
      updateInProgress = false;
      io.warn(`[updater] Nie udało się odpalić aktualizacji: ${err.message}`);
    });
  }
  if (child && typeof child.unref === 'function') child.unref();

  io.log(`[updater] Start aktualizacji (${plan.kind}) → ${shortRevision(revision) || 'najnowsza'}`);
  return { ok: true, kind: plan.kind, revision: normalizeRevision(revision) || null };
}

// === Szew HTTP (I/O to cienka skorupa w server.js — wzorzec handleInboxRequest) ===
//
// `body` przyjmujemy WYŁĄCZNIE po to, by kontrakt bezpieczeństwa dało się przetestować:
// rewizja pochodzi ZAWSZE ze świeżego sprawdzenia po stronie serwera, NIGDY z żądania —
// klient nie decyduje, jaki kod zostanie pobrany i uruchomiony na maszynie.
// Zależności wstrzykiwane, bo realne wywołanie chodzi do sieci i ubija własny proces.
async function handleUpdateRequest({
  method,
  body = null, // eslint-disable-line no-unused-vars -- świadomie ignorowane, patrz komentarz
  check = checkForUpdate,
  start = startUpdate,
} = {}) {
  if (method === 'GET') {
    return { status: 200, body: await check() };
  }
  if (method !== 'POST') {
    return { status: 405, body: { error: `Metoda ${method} nieobsługiwana dla /api/update.` } };
  }

  const info = await check();
  if (!info.can_update) {
    return { status: 409, body: { ...info, started: false } };
  }

  const started = start({ revision: info.remote_revision });
  if (!started.ok) {
    // „Już trwa" to konflikt stanu (409), nie awaria serwera (500) — panel ma pokazać
    // inny komunikat i NIE ponawiać.
    return { status: started.busy ? 409 : 500, body: { started: false, error: started.error } };
  }
  return {
    status: 200,
    body: { started: true, kind: started.kind, revision: info.remote_revision },
  };
}

module.exports = {
  STATUS,
  MIN_REVISION_PREFIX,
  REPO_SLUG,
  REPO_REF,
  checkForUpdate,
  fetchLatestRevision,
  buildUpdateStatus,
  revisionsMatch,
  normalizeRevision,
  shortRevision,
  planUpdate,
  buildMacUpdateCommand,
  buildWindowsUpdateCommand,
  startUpdate,
  isUpdateInProgress,
  resetUpdateState,
  handleUpdateRequest,
};
