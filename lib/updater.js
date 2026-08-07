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
// „Przeżyć rodzica" załatwia POŚREDNIK `cmd /c start`, NIE `detached` — oba proste warianty
// spawnu są na Windowsie złe i oba udowodniono na żywej maszynie (CAVE, 2026-08-06):
//  - `detached:true` + `windowsHide` → powershell.exe startuje BEZ konsoli i natychmiast
//    kończy z kodem 0, nie wykonawszy ANI JEDNEJ instrukcji (2-sekundowy skrypt „kończył
//    się" w 146 ms). Dla updatera wyglądało to jak sukces → flaga `updateInProgress`
//    zakleszczona do restartu daemona, zero śladu w logu, zero procesu, zero zipa.
//  - bez `detached` → dziecko ginie razem z rodzicem (`Stop-Process -Force` na daemonie).
// `start` tworzy proces w OSOBNEJ sesji konsolowej: przeżywa rodzica i realnie wykonuje
// skrypt. Pusty argument po `start` to tytuł okna — bez niego `start` wziąłby pierwszy
// cytowany argument (ścieżkę powershella) za tytuł. `/min` = zminimalizowane okno.
//
// Transkrypt do %TEMP%\puls-update.log: instalator biegnie bez konsoli i bez człowieka,
// więc bez transkryptu jego śmierć jest niewidzialna (diagnoza na CAVE trwała godzinę,
// bo NIE BYŁO czego czytać). `try/catch`, bo pad transkryptu nie może ubić aktualizacji.
//
// Treść aktualizacji idzie PRZEZ PLIK (%TEMP%\puls-update-bootstrap.ps1), nie przez
// linię komend: ukryty PowerShell z `irm https://… | iex` w argumentach to podręcznikowa
// sygnatura droppera i antywirus tnie taki CreateProcess z `spawn EPERM` (CAVE 07.08 —
// rano ta sama komenda przeszła, po południu już nie; heurystyka behawioralna zmienia się
// w ciągu dnia). `powershell -File <lokalna ścieżka>` jest niewinne, a `irm|iex` zostaje
// WEWNĄTRZ pliku nie dla zmyłki, tylko z konieczności: install.ps1 rozpoznaje tryb
// bootstrap po PUSTYM $PSScriptRoot, a kod wykonany przez `iex` go nie ma — uruchomienie
// instalatora wprost z pliku wzięłoby ścieżkę LOKALNĄ i pominęło pobieranie repo.
//
// Gdy znamy pełny SHA, podajemy instalatorowi GOTOWE źródło zipa (`CLAUDE_CRON_ZIP_URL`
// + `CLAUDE_CRON_ZIP_TOPDIR`) i rewizję (`CLAUDE_CRON_INSTALL_REVISION`). Bez tego
// `Resolve-ZipSource` pyta api.github.com o SHA DRUGI raz na ten sam commit, a przy
// wyczerpanym limicie 60/h (panel zużył już GET i POST /api/update) schodzi na fallback
// `archive/refs/heads/<SHA>.zip` — gałąź o nazwie SHA nie istnieje, więc 404 i pad
// aktualizacji. `CLAUDE_CRON_INSTALL_REVISION` jest przy tym warunkiem zapisu
// `data/version.json` przez `Invoke-UpdateFinish`.
// Treść pliku bootstrapu (czysta — zapis robi startUpdate przez io.writeFile).
// Wyłącznie ASCII: PowerShell 5.1 czyta pliki bez BOM jako ANSI i diakrytyki
// wywróciłyby parser (ta sama pułapka co w install.ps1 pod irm|iex).
function buildWindowsBootstrapScript({ repoDir, revision, slug = REPO_SLUG }) {
  const ref = normalizeRevision(revision) || REPO_REF;
  const isSha = /^[0-9a-f]{40}$/.test(ref);
  const scriptUrl = `${RAW_BASE}/${slug}/${ref}/install.ps1`;
  return [
    '# Auto-generowany przez Puls (lib/updater.js) - bootstrap aktualizacji Windows.',
    '# Usuwac mozna bez konsekwencji: kazda aktualizacja nadpisuje ten plik od zera.',
    "try { Start-Transcript -Path (Join-Path $env:TEMP 'puls-update.log') -Append | Out-Null } catch {}",
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
    // irm|iex ZOSTAJE w pliku (nie w linii komend) — patrz komentarz nad funkcją wyżej:
    // install.ps1 rozpoznaje tryb bootstrap po pustym $PSScriptRoot kodu z iex.
    `irm ${psQuote(scriptUrl)} | iex`,
    '',
  ].join('\r\n');
}

function buildWindowsUpdateCommand({ scriptPath }) {
  return {
    command: 'cmd',
    args: [
      '/c', 'start', '', '/min',
      'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ],
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
    // `detached:true` — na Uniksie znaczy tylko „nowa grupa procesów": skrypt przeżywa
    // `kill` daemona i wykonuje się normalnie. Na Windowsie ta sama flaga ZABIJA wykonanie
    // (patrz komentarz nad buildWindowsUpdateCommand) — dlatego jest per platforma, w planie.
    return {
      ok: true, kind: 'mac', cwd: repoDir, detached: true,
      ...buildMacUpdateCommand({ repoDir, pid, nodeBin }),
    };
  }
  if (platform === 'win32') {
    // cwd POZA katalogiem instalacji: Windows blokuje katalog roboczy żywego procesu,
    // a to właśnie ten proces przenosi `$InstallDir` w `Install-FreshRepo`. Z `cwd`
    // ustawionym na repo `Move-Item` pada „Proces nie moze uzyskac dostepu do pliku"
    // JUŻ PO `Stop-PulsProcesses` — daemon ubity, zadanie Task Scheduler jest ONLOGON,
    // więc maszyna zostaje bez Pulsa do następnego logowania (learned pattern 2026-07-28).
    //
    // `detached:false` NIE jest przeoczeniem: `detached` na Windowsie odbiera dziecku
    // konsolę, a cmd.exe/powershell.exe bez konsoli kończą natychmiast z kodem 0, nie
    // wykonawszy nic (dowód na żywej maszynie 2026-08-06). Przeżycie śmierci daemona
    // gwarantuje pośrednik `cmd /c start` z buildWindowsUpdateCommand, nie ta flaga.
    const scriptPath = path.join(os.tmpdir(), 'puls-update-bootstrap.ps1');
    return {
      ok: true,
      kind: 'windows',
      cwd: os.tmpdir(),
      detached: false,
      // startUpdate zapisuje plik PRZED spawnem (io.writeFile — wstrzykiwalne w testach).
      scriptFile: { path: scriptPath, content: buildWindowsBootstrapScript({ repoDir, revision }) },
      ...buildWindowsUpdateCommand({ scriptPath }),
    };
  }
  return { ok: false, error: `Aktualizacja z panelu nie jest wspierana na ${platform}.` };
}

// Wstrzykiwalne I/O (wzorzec REAL_IO z platform.js) — kontraktem jest to, CO i JAK
// zostaje odpalone, a tego nie da się sprawdzić realnym spawnem ubijającym serwer.
const REAL_IO = {
  spawn: (command, args, options) => spawn(command, args, options),
  exists: file => fs.existsSync(file),
  writeFile: (file, content) => fs.writeFileSync(file, content),
  log: message => console.log(message),
  warn: message => console.warn(message),
};

// Czy aktualizacja już biegnie. Stan in-memory (wzorzec liczników z ask.js): odczepiony
// instalator przeżywa śmierć daemona, więc DRUGI klik (np. po odświeżeniu panelu, które
// gubi blokadę w przeglądarce) odpaliłby DRUGI instalator — na Windowsie dwa równoległe
// `install.ps1` robią naraz `Stop-PulsProcesses` i `Move-Item` katalogu z bazą.
// Flagi nie trzeba czyścić po sukcesie: proces i tak zaraz ginie od aktualizacji.
let updateInProgress = false;

// Watchdog na zakleszczoną flagę. Na Windowsie pośrednik `cmd /c start` kończy z kodem 0
// od razu po ODPALENIU instalatora — a to, czy instalator faktycznie dobiegł, wie tylko
// system plików. Jeśli instalator umrze po cichu (Defender, pad pobierania), daemon żyje,
// flaga stoi, a panel do końca życia procesu odpowiada 409 „Aktualizacja już trwa" —
// dokładnie ten stan zakleszczył CAVE 2026-08-06. Po WATCHDOG_MS uznajemy aktualizację
// za martwą i zwalniamy flagę: skoro daemon wciąż żyje i wykonuje ten timer, podmiana
// kodu NA PEWNO się nie dokonała. Timer z unref() — nie trzyma procesu przy życiu.
const UPDATE_WATCHDOG_MS = 10 * 60_000;
let updateWatchdogTimer = null;

function isUpdateInProgress() {
  return updateInProgress;
}

// Wyłącznie dla testów (wzorzec db.setDbPath) — stan współbieżności żyje w module.
function resetUpdateState() {
  updateInProgress = false;
  if (updateWatchdogTimer) {
    clearTimeout(updateWatchdogTimer);
    updateWatchdogTimer = null;
  }
  // Cache GET-a też jest stanem modułu — bez wyczyszczenia test sprawdzający świeży
  // odczyt dostawałby wynik poprzedniego przypadku.
  updateCheckCache = null;
}

function startUpdate({
  revision,
  repoDir = PROJECT_ROOT,
  platform = process.platform,
  pid = process.pid,
  nodeBin = process.execPath,
  watchdogMs = UPDATE_WATCHDOG_MS,
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

  // Bootstrap na dysk PRZED spawnem — treść aktualizacji idzie przez plik, nie przez
  // linię komend (antywirus, patrz komentarz nad buildWindowsBootstrapScript).
  if (plan.scriptFile) {
    try {
      io.writeFile(plan.scriptFile.path, plan.scriptFile.content);
    } catch (err) {
      return { ok: false, error: `Nie udało się zapisać skryptu aktualizacji (${plan.scriptFile.path}): ${err.message}.` };
    }
  }

  // `detached` bierze się Z PLANU (per platforma), nie jest stałą: Unix potrzebuje nowej
  // grupy procesów, a Windows z tą flagą w ogóle nie wykonuje skryptu — przeżycie rodzica
  // zapewnia tam pośrednik `cmd /c start` (pełny wywód nad buildWindowsUpdateCommand).
  //
  // Spawn w try/catch: `spawn EPERM` (antywirus blokuje CreateProcess) leci SYNCHRONICZNIE
  // i bez tego wypadał z handleUpdateRequest jako gołe „Internal server error" — panel
  // nie mówił NIC, a powód siedział w niewidzialnym stderr daemona (CAVE 07.08).
  let child;
  try {
    child = io.spawn(plan.command, plan.args, {
      detached: plan.detached,
      stdio: 'ignore',
      cwd: plan.cwd,
      windowsHide: true,
    });
  } catch (err) {
    return {
      ok: false,
      error:
        `System odmówił uruchomienia procesu aktualizacji (${err.code || err.message}). ` +
        'Najczęstszy powód: antywirus zablokował start PowerShella — sprawdź Historię ochrony ' +
        'w Zabezpieczeniach Windows i dodaj wyjątek albo zaktualizuj ręcznie instalatorem.',
    };
  }
  updateInProgress = true;

  // Watchdog: jeśli po watchdogMs ten daemon WCIĄŻ żyje, aktualizacja umarła po cichu —
  // zwolnij flagę, żeby dało się spróbować ponownie bez restartu serwera.
  updateWatchdogTimer = setTimeout(() => {
    updateWatchdogTimer = null;
    if (!updateInProgress) return;
    updateInProgress = false;
    io.warn(
      `[updater] Aktualizacja nie zakończyła się w ${Math.round(watchdogMs / 60_000)} min, ` +
        'a serwer wciąż żyje — zwalniam blokadę. Szczegóły: %TEMP%\\puls-update.log (Windows).'
    );
  }, watchdogMs);
  if (typeof updateWatchdogTimer.unref === 'function') updateWatchdogTimer.unref();
  if (child && typeof child.on === 'function') {
    // Zwolnienie blokady w idempotentnym `settle` (learned pattern 2026-07-14): 'error'
    // i 'exit' mogą przyjść w dowolnej kombinacji, a podwójne zwolnienie zalewałoby log
    // dwoma ostrzeżeniami o tej samej porażce.
    //
    // SUKCES to WYŁĄCZNIE `code === 0`. Mac: proces `exec`-uje nowy serwer, a bieżący
    // i tak zaraz ginie. Windows: kod 0 znaczy tylko tyle, że pośrednik `cmd /c start`
    // ODPALIŁ instalatora — czy instalator dobiegł, rozstrzyga dopiero watchdog wyżej.
    // W obu przypadkach zwolnienie flagi przy kodzie 0 otworzyłoby okno na drugi
    // instalator w trakcie podmiany plików. Każde inne zakończenie (niezerowy kod,
    // ubicie sygnałem — wtedy `code === null`, a powód siedzi w `signal`) to porażka
    // przy ŻYJĄCYM serwerze: bez zwolnienia panel odpowiada 409 „Aktualizacja już trwa".
    let settled = false;
    const settle = (reason) => {
      if (settled) return;
      settled = true;
      if (reason === null) return; // sukces — blokada zostaje do śmierci procesu
      updateInProgress = false;
      io.warn(`[updater] Aktualizacja nie powiodła się (${reason}) — można spróbować ponownie.`);
    };

    // Instalator w ogóle nie ruszył (spawn padł) — blokada musi puścić, inaczej panel
    // nigdy nie pozwoliłby spróbować ponownie bez restartu daemona.
    child.on('error', err => settle(`błąd uruchomienia: ${err.message}`));
    // Na Macu to normalna ścieżka porażki: `kill` stoi za `&&`, więc przy konflikcie
    // merge albo braku sieci `git pull` pada, a serwer żyje dalej. `'error'` tego NIE
    // łapie, bo spawn się udał.
    child.on('exit', (code, signal) => {
      if (code === 0) return settle(null);
      settle(signal ? `przerwana sygnałem ${signal}` : `kod wyjścia ${code}`);
    });
  }
  if (child && typeof child.unref === 'function') child.unref();

  io.log(`[updater] Start aktualizacji (${plan.kind}) → ${shortRevision(revision) || 'najnowsza'}`);
  return { ok: true, kind: plan.kind, revision: normalizeRevision(revision) || null };
}

// Cache odpowiedzi GET /api/update (wzorzec `readPersistedEnvCached` z persisted-env.js).
//
// Panel woła `loadUpdateStatus()` przy KAŻDEJ inicjalizacji, a `checkForUpdate` idzie do
// api.github.com, gdzie limit dla niezalogowanych to **60 żądań/h na IP**. Bez cache kilka
// odświeżeń karty zjada cały limit — a wtedy `check()` zwraca `check_failed`, `POST` odpowiada
// 409 z `can_update:false` i aktualizacja jest niemożliwa aż do odnowienia limitu. Czyli
// funkcja psuje się dokładnie przez to, że ktoś na nią patrzy.
//
// TTL 5 min daje najwyżej 12 żądań/h i zostawia zapas dla POST-a oraz dla kilku maszyn za
// jednym NAT-em. Koszt: „dostępna aktualizacja" pojawia się z opóźnieniem do 5 minut — bez
// znaczenia przy funkcji, której cykl życia liczy się w dniach.
const UPDATE_CHECK_TTL_MS = 300_000;
let updateCheckCache = null;

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
  now = Date.now(),
} = {}) {
  if (method === 'GET') {
    const cached = updateCheckCache;
    if (cached && now - cached.at < UPDATE_CHECK_TTL_MS) return { status: 200, body: cached.value };
    const value = await check();
    updateCheckCache = { at: now, value };
    return { status: 200, body: value };
  }
  if (method !== 'POST') {
    return { status: 405, body: { error: `Metoda ${method} nieobsługiwana dla /api/update.` } };
  }

  // POST NIGDY nie czyta cache: klik użytkownika musi dostać stan sprzed sekundy,
  // nie sprzed pięciu minut — inaczej pobralibyśmy rewizję, której już nie ma.
  const info = await check();
  updateCheckCache = { at: now, value: info };
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
  buildWindowsBootstrapScript,
  startUpdate,
  isUpdateInProgress,
  resetUpdateState,
  handleUpdateRequest,
};
