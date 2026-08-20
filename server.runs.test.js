const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Testy HTTP API runów przy RÓWNOLEGŁOŚCI (kill per run, lista aktywnych, limit) na ŻYWYM
// procesie serwera — wzorzec server.inbox.http.test.js / lib/ask.http.test.js: server.js
// startuje DB i scheduler przy require, więc driver przez spawn + fetch omija te side-effecty
// w procesie runnera. config.js czyta env RAZ przy starcie procesu, dlatego izolowana baza
// (CLAUDE_CRON_DB_PATH → tmp; test PISZE joby i runy) wchodzi przy SPAWNIE.
//
// Zadania testowe to script-joby (`node <plik>`) — świadomie zamiast atrapy CLI Claude:
// ścieżka skryptowa nie odpala caffeinate ani nie potrzebuje shebanga, więc scenariusz
// „dwa runy naraz" jest identyczny na macOS, Linuksie i Windowsie. Kill jest wspólny dla
// obu ścieżek (executor.killRun → killProcessTree), więc pokrycie się nie zwęża.

const PORT = 7802;
const SLEEP_MS = 60_000; // run żyje aż go ubijemy — test nigdy nie czeka na jego koniec

let tmpDir;
let server;
let jobA;
let jobB;

const url = (p) => `http://localhost:${PORT}${p}`;

function waitForServerReady(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serwer nie wystartował w 10s')), 10000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Puls running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Osobny plik na job — `command` jest kluczem wyłączności (R5), więc dwa joby o tym samym
// skrypcie NIE poszłyby równolegle i test „dwa aktywne runy" nigdy by nie wystartował.
function writeSleeperScript(name) {
  const scriptPath = path.join(tmpDir, `${name}.js`);
  fs.writeFileSync(scriptPath, `setTimeout(() => {}, ${SLEEP_MS});\n`);
  return scriptPath;
}

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url(pathname), {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function createSleeperJob(name) {
  const res = await api('/api/jobs', {
    method: 'POST',
    body: {
      name,
      job_type: 'script',
      command: writeSleeperScript(name),
      // Zero retry: killed nie generuje retry, ale fail spawnu generowałby — a wtedy
      // test gonił się z dokolejkowanym runem zamiast pokazać prawdziwy problem.
      max_retries: 0,
    },
  });
  assert.equal(res.status, 201, `utworzenie joba "${name}" zwróciło ${res.status}`);
  return res.body;
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: ${label} nie nastąpiło w ${timeoutMs} ms`);
}

async function getStatus() {
  const res = await api('/api/status');
  assert.equal(res.status, 200);
  return res.body;
}

async function runningRunIds() {
  const status = await getStatus();
  return status.current_runs.map((r) => r.id);
}

// Startuje po jednym runie z obu jobów i czeka, aż OBA są 'running'.
// Domyślny limit (3) daje budżet 2 runów długich, a joby bez historii udanych runów są
// klasyfikowane jako długie — więc oba mieszczą się równolegle.
async function startTwoRuns() {
  const a = await api(`/api/jobs/${jobA.id}/trigger`, { method: 'POST' });
  const b = await api(`/api/jobs/${jobB.id}/trigger`, { method: 'POST' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  await waitFor(async () => (await runningRunIds()).length === 2, 'dwa runy naraz w stanie running');
  return { runA: a.body.id, runB: b.body.id };
}

// Sprzątanie po teście — bez tego kolejny test zastaje cudze runy i limit 3 przestaje
// wystarczać na parę świeżych.
async function killAllRunning() {
  for (const id of await runningRunIds()) {
    await api(`/api/runs/${id}/kill`, { method: 'POST' });
  }
  await waitFor(async () => (await runningRunIds()).length === 0, 'kolejka pusta po sprzątaniu');
}

async function getRun(id) {
  const res = await api(`/api/runs?limit=100`);
  assert.equal(res.status, 200);
  return res.body.find((r) => r.id === id) || null;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-runs-http-'));
  server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      CLAUDE_CRON_PORT: String(PORT),
      CLAUDE_CRON_DB_PATH: path.join(tmpDir, 'claude-cron.db'),
      CLAUDE_CRON_INBOX_DB_PATH: path.join(tmpDir, 'inbox.db'),
      CLAUDE_CRON_WORKSPACE: tmpDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServerReady(server);

  jobA = await createSleeperJob('sleeper-a');
  jobB = await createSleeperJob('sleeper-b');
});

after(() => {
  if (server) server.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Szew server.js ↔ lib/version: testy jednostkowe obu stron przechodzą, gdy pole `version`
// zniknie z odpowiedzi endpointu (learned pattern: „testy czystych funkcji obu stron
// przechodzą przy złamanym zachowaniu systemowym"). Tu asertujemy PUBLICZNY kontrakt
// /api/status na żywym procesie serwera.
test('GET /api/status: pole version niesie rewizję i datę instalacji z lib/version', async () => {
  const status = await getStatus();

  assert.ok(status.version, 'brak pola version w /api/status');
  assert.equal(typeof status.version.revision, 'string');
  assert.ok('installed_at' in status.version, 'brak klucza installed_at w version');
  assert.equal(typeof status.version.source, 'string');

  // Serwer musi oddawać DOKŁADNIE to, co wylicza lib/version (ten sam DATA_DIR — spawnujemy
  // serwer z tego repo). Bez pliku wersji kontrakt to jawne 'unknown', nie brak pola.
  const expected = require('./lib/version').getInstallVersion();
  assert.deepEqual(status.version, expected);
  if (!fs.existsSync(require('./lib/version').VERSION_FILE)) {
    assert.equal(status.version.revision, 'unknown');
  }
});

// Szew server.js ↔ lib/persisted-env ↔ public/app.js: testy czystej funkcji `describeEnvUsage`
// przechodzą także wtedy, gdy pole `vps_url` w ogóle nie trafi do odpowiedzi endpointu albo
// zmieni kształt kluczy (ten sam learned pattern co przy `version` wyżej). Front czyta
// DOKŁADNIE `in_use`/`persisted`/`mismatch` (renderVpsAddr), więc kontrakt asertujemy na
// żywym procesie serwera.
test('GET /api/status: pole vps_url niesie adres w użyciu, zapisany i flagę rozjazdu', async () => {
  const status = await getStatus();

  assert.ok(status.vps_url, 'brak pola vps_url w /api/status');
  assert.equal(typeof status.vps_url.in_use, 'string');
  assert.ok('persisted' in status.vps_url, 'brak klucza persisted w vps_url');
  // „nie wiem" (null) musi być rozróżnione od pustego adresu — nigdy undefined ani inny typ.
  assert.ok(status.vps_url.persisted === null || typeof status.vps_url.persisted === 'string');
  assert.equal(typeof status.vps_url.mismatch, 'boolean');

  // Rozjazd wolno zgłosić WYŁĄCZNIE, gdy utrwalona wartość jest znana i różna od tej w pamięci —
  // brak odczytu to „nie wiem", nie oskarżenie (front pokazuje wtedy ostrzeżenie na stałe).
  const { describeEnvUsage } = require('./lib/persisted-env');
  assert.deepEqual(
    status.vps_url,
    describeEnvUsage({ inUse: status.vps_url.in_use, persisted: status.vps_url.persisted }),
  );
});

test('GET /api/status: current_runs to tablica obu aktywnych runów, current_run = pierwszy', async (t) => {
  t.after(killAllRunning);

  // Arrange/Act
  const { runA, runB } = await startTwoRuns();
  const status = await getStatus();

  // Assert — nowe pole widzi oba runy...
  assert.ok(Array.isArray(status.current_runs), 'current_runs musi być tablicą');
  assert.deepEqual(status.current_runs.map((r) => r.id).sort((x, y) => x - y), [runA, runB].sort((x, y) => x - y));
  // ...a stare pole zostaje w kontrakcie (parytet surface API: dashboard i skill /puls
  // aktualizują się osobno) i pokazuje DOKŁADNIE pierwszy element listy.
  assert.deepEqual(status.current_run, status.current_runs[0]);
});

test('POST /api/runs/:id/kill ubija wskazany run; drugi aktywny żyje dalej (R6)', async (t) => {
  t.after(killAllRunning);

  // Arrange
  const { runA, runB } = await startTwoRuns();

  // Act
  const killed = await api(`/api/runs/${runA}/kill`, { method: 'POST' });

  // Assert — ubity dokładnie ten wskazany
  assert.equal(killed.status, 200);
  assert.deepEqual(killed.body, { killed: true });
  await waitFor(async () => {
    const ids = await runningRunIds();
    return ids.length === 1 && ids[0] === runB;
  }, 'zostaje wyłącznie drugi run');

  // Assert — kontrakt „killed milczy": status w DB to 'killed', nie 'failed'
  const finishedA = await getRun(runA);
  assert.equal(finishedA.status, 'killed');
  assert.equal((await getRun(runB)).status, 'running');
});

test('POST /api/runs/current/kill przy dwóch aktywnych → 409 z listą, nic nie zostaje ubite', async (t) => {
  t.after(killAllRunning);

  // Arrange
  const { runA, runB } = await startTwoRuns();

  // Act
  const res = await api('/api/runs/current/kill', { method: 'POST' });

  // Assert — 409 (żadnego zgadywania, który run ubić) + lista do doprecyzowania
  assert.equal(res.status, 409);
  assert.ok(res.body.error, '409 musi nieść czytelny powód');
  assert.deepEqual(res.body.current_runs.map((r) => r.id).sort((x, y) => x - y), [runA, runB].sort((x, y) => x - y));

  // Assert — odmowa jest bezskutkowa: oba runy dalej biegną
  assert.deepEqual((await runningRunIds()).sort((x, y) => x - y), [runA, runB].sort((x, y) => x - y));
});

test('POST /api/runs/current/kill przy jednym aktywnym → zachowanie jak dotąd ({ killed: true })', async (t) => {
  t.after(killAllRunning);

  // Arrange — jeden run
  const started = await api(`/api/jobs/${jobA.id}/trigger`, { method: 'POST' });
  assert.equal(started.status, 200);
  await waitFor(async () => (await runningRunIds()).length === 1, 'jeden run w stanie running');

  // Act
  const res = await api('/api/runs/current/kill', { method: 'POST' });

  // Assert
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { killed: true });
  await waitFor(async () => (await runningRunIds()).length === 0, 'run zniknął z aktywnych');
  assert.equal((await getRun(started.body.id)).status, 'killed');
});

test('POST /api/runs/current/kill bez aktywnych runów → { killed: false } jak dotąd', async () => {
  const res = await api('/api/runs/current/kill', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { killed: false });
});

test('POST /api/runs/:id/kill: nieaktywny run → killed:false, nieznany run → 404, śmieciowe id → 400', async () => {
  // Arrange — run, który już się zakończył (ubity w poprzednim teście nie jest pewny,
  // więc robimy własny i domykamy go tutaj)
  const started = await api(`/api/jobs/${jobB.id}/trigger`, { method: 'POST' });
  await waitFor(async () => (await runningRunIds()).length === 1, 'run wystartował');
  await api(`/api/runs/${started.body.id}/kill`, { method: 'POST' });
  await waitFor(async () => (await runningRunIds()).length === 0, 'run zniknął z aktywnych');

  // Act/Assert — powtórny kill nie jest błędem klienta, tylko informacją o stanie
  const again = await api(`/api/runs/${started.body.id}/kill`, { method: 'POST' });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { killed: false });

  // Act/Assert — nieistniejący run i nie-liczba w ścieżce
  assert.equal((await api('/api/runs/999999/kill', { method: 'POST' })).status, 404);
  assert.equal((await api('/api/runs/abc/kill', { method: 'POST' })).status, 400);
});

test('GET/PUT /api/settings/concurrency: 1 i 5 przechodzą, 0 / ujemna / tekst odrzucone', async (t) => {
  // Domyślna wartość wraca po teście — inaczej limit 1 wycieknie na kolejne testy w pliku
  t.after(() => api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: 3 } }));

  // Assert — domyślny odczyt bez zapisu
  assert.deepEqual(await api('/api/settings/concurrency'), { status: 200, body: { max_concurrent: 3 } });

  // Act/Assert — wartości poprawne
  for (const value of [1, 5]) {
    const put = await api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: value } });
    assert.deepEqual(put, { status: 200, body: { max_concurrent: value } });
    assert.deepEqual(await api('/api/settings/concurrency'), { status: 200, body: { max_concurrent: value } });
  }

  // Act/Assert — śmieci odrzucone Z KOMUNIKATEM i BEZ zapisu (ostatnia poprawna wartość to 5)
  for (const bad of [0, -3, 'pięć', null]) {
    const put = await api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: bad } });
    assert.equal(put.status, 400, `${JSON.stringify(bad)} powinno zostać odrzucone`);
    assert.ok(put.body.error, 'odrzucenie musi nieść komunikat');
  }
  assert.deepEqual(await api('/api/settings/concurrency'), { status: 200, body: { max_concurrent: 5 } });
});

test('Ustawienie limitu jest PRYWATNE: żądanie z X-Forwarded-For → 403 (guard XFF)', async () => {
  // Ruch z Tailscale Funnel ma XFF — dashboard i jego ustawienia mają być dostępne
  // wyłącznie przez Tailscale. Guard stoi PRZED api/static i musi objąć nowy endpoint.
  const get = await api('/api/settings/concurrency', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  assert.equal(get.status, 403);

  const put = await api('/api/settings/concurrency', {
    method: 'PUT',
    body: { max_concurrent: 9 },
    headers: { 'X-Forwarded-For': '1.2.3.4' },
  });
  assert.equal(put.status, 403);

  // Odmowa jest bezskutkowa — wartość niezmieniona (nie 9)
  const current = await api('/api/settings/concurrency');
  assert.notEqual(current.body.max_concurrent, 9);
});

test('Kill per run też jest prywatny: X-Forwarded-For → 403', async () => {
  const res = await api('/api/runs/1/kill', { method: 'POST', headers: { 'X-Forwarded-For': '1.2.3.4' } });
  assert.equal(res.status, 403);
});

// === Odbiór P2 review fazy 1 ===

test('CSRF: cross-origin PUT limitu i POST killa odrzucone (403), same-origin przechodzi', async (t) => {
  t.after(() => api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: 3 } }));

  // Arrange — guard XFF NIE łapie żądania z przeglądarki: fetch z evil.com do localhost
  // idzie bez X-Forwarded-For, a ACAO:* pozwala tej stronie odczytać odpowiedź.
  const evil = { Origin: 'http://evil.com' };

  // Act/Assert — zapis limitu z obcej strony odrzucony i BEZ skutku
  const put = await api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: 9 }, headers: evil });
  assert.equal(put.status, 403, 'cross-origin PUT limitu odrzucony');
  assert.notEqual((await api('/api/settings/concurrency')).body.max_concurrent, 9);

  // Act/Assert — kill runu z obcej strony odrzucony
  const kill = await api('/api/runs/1/kill', { method: 'POST', headers: evil });
  assert.equal(kill.status, 403, 'cross-origin kill odrzucony');

  // Act/Assert — legalny dashboard (Origin == Host) nie jest zablokowany
  const sameOrigin = await api('/api/settings/concurrency', {
    method: 'PUT',
    body: { max_concurrent: 2 },
    headers: { Origin: `http://localhost:${PORT}` },
  });
  assert.deepEqual(sameOrigin, { status: 200, body: { max_concurrent: 2 } });
});

test('Podniesienie limitu z dashboardu BUDZI kolejkę — run rusza bez dodatkowego triggera', async (t) => {
  // Arrange — limit 1: drugi trigger ląduje w kolejce
  t.after(async () => {
    await api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: 3 } });
    await killAllRunning();
  });
  await api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: 1 } });
  await api(`/api/jobs/${jobA.id}/trigger`, { method: 'POST' });
  await api(`/api/jobs/${jobB.id}/trigger`, { method: 'POST' });
  await waitFor(async () => {
    const status = await getStatus();
    return status.current_runs.length === 1 && status.queue_length >= 1;
  }, 'jeden run biegnie, drugi czeka w kolejce');

  // Act — user podnosi limit w dashboardzie; ŻADNEGO dodatkowego triggera
  const put = await api('/api/settings/concurrency', { method: 'PUT', body: { max_concurrent: 3 } });
  assert.deepEqual(put, { status: 200, body: { max_concurrent: 3 } });

  // Assert — czekający run startuje od razu, nie po zakończeniu biegnącego (SLEEP_MS = 60 s)
  const running = await waitFor(
    async () => ((await runningRunIds()).length === 2 ? true : null),
    'drugi run wystartował po podniesieniu limitu',
    10_000,
  );
  assert.equal(running, true);
});

// === /api/runs/current vs /api/status — JEDNO źródło bieżącego runu ===
// Z review CodeRabbita (PR #2): endpoint czytał `db.getCurrentRun()` (`LIMIT 1` BEZ
// `ORDER BY`), a `/api/status` — `getRunningRuns()[0]` (`ORDER BY id ASC`).
//
// UWAGA co do wartości tego testu: jest to test KONTRAKTU, nie regresji. Przy dzisiejszym
// planie zapytania SQLite skanuje po rowid i `LIMIT 1` przypadkiem zwraca ten sam,
// najstarszy wiersz — więc test przechodzi RÓWNIEŻ na starym kodzie (sprawdzone).
// Zabezpiecza przed przyszłym rozjazdem: brak `ORDER BY` to niezdefiniowana kolejność,
// którą zmieni pierwszy indeks na `status` albo zmiana wersji SQLite. Bez tego oba
// endpointy mogłyby pokazać różne „bieżące" zadania w dashboardzie i w skillu /puls.
test('GET /api/runs/current zwraca ten sam run co current_run w /api/status (dwa aktywne)', async (t) => {
  t.after(killAllRunning);

  // Arrange — dwa równoległe runy, więc „ten pierwszy" przestaje być oczywisty
  const { runA, runB } = await startTwoRuns();
  const oldest = Math.min(runA, runB);

  // Act
  const current = await api('/api/runs/current');
  const status = await getStatus();

  // Assert — oba źródła wskazują TEN SAM, najstarszy run (deterministyczne ORDER BY id)
  assert.equal(current.status, 200);
  assert.equal(current.body.id, oldest, '/api/runs/current bierze najstarszy biegnący run');
  assert.equal(status.current_run.id, oldest, 'current_run w /api/status bierze ten sam run');
  assert.equal(current.body.id, status.current_run.id, 'oba endpointy nie mogą się rozjechać');
});

test('GET /api/runs/current bez aktywnych runów → null (kontrakt sprzed równoległości)', async () => {
  await killAllRunning();
  const current = await api('/api/runs/current');
  assert.equal(current.status, 200);
  assert.equal(current.body, null, 'brak runów to null, nie pusta tablica');
});

// === Lekka historia: fields=meta + GET /api/runs/:id (lazy-load logów) ===

test('GET /api/runs?fields=meta: bez stdout/stderr, z rozmiarami; bez parametru — pełne wiersze', async (t) => {
  t.after(killAllRunning);

  // Arrange — jeden zakończony run (kill domyka wiersz)
  const started = await api(`/api/jobs/${jobA.id}/trigger`, { method: 'POST' });
  await waitFor(async () => (await runningRunIds()).length === 1, 'run wystartował');
  await api(`/api/runs/${started.body.id}/kill`, { method: 'POST' });
  await waitFor(async () => (await runningRunIds()).length === 0, 'run zakończony');

  // Act
  const meta = await api('/api/runs?limit=100&fields=meta');
  const full = await api('/api/runs?limit=100');

  // Assert — tryb lekki
  assert.equal(meta.status, 200);
  const metaRow = meta.body.find((r) => r.id === started.body.id);
  assert.ok(metaRow, 'run musi być na liście meta');
  assert.equal(metaRow.stdout, undefined);
  assert.equal(metaRow.stderr, undefined);
  assert.equal(metaRow.webhook_payload, undefined);
  assert.equal(typeof metaRow.stdout_bytes, 'number');

  // Assert — tryb pełny bez zmian (kontrakt skilla /puls)
  const fullRow = full.body.find((r) => r.id === started.body.id);
  assert.equal(typeof fullRow.stdout, 'string', 'bez fields=meta stdout zostaje w liście');
  assert.equal(fullRow.stdout_bytes, undefined);
});

test('GET /api/runs/:id zwraca pełny run; 404 dla nieznanego, 400 dla śmieci; literały niezasłonięte', async (t) => {
  t.after(killAllRunning);

  // Arrange
  const started = await api(`/api/jobs/${jobB.id}/trigger`, { method: 'POST' });
  await waitFor(async () => (await runningRunIds()).length === 1, 'run wystartował');

  // Act/Assert — pojedynczy run z logami
  const one = await api(`/api/runs/${started.body.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.id, started.body.id);
  assert.equal(typeof one.body.stdout, 'string', 'pojedynczy run wozi log — po to jest ten endpoint');

  // Act/Assert — literały MUSZĄ mieć pierwszeństwo przed :id (inaczej parseInt → 400/404)
  const current = await api('/api/runs/current');
  assert.equal(current.status, 200);
  assert.equal(current.body.id, started.body.id);
  const recent = await api('/api/runs/recent?per_job=3');
  assert.equal(recent.status, 200);
  assert.ok(Array.isArray(recent.body), '/api/runs/recent dalej zwraca tablicę');

  // Act/Assert — błędy
  assert.equal((await api('/api/runs/999999')).status, 404);
  assert.equal((await api('/api/runs/abc')).status, 400);
});

test('GET /api/runs/:id jest prywatny: X-Forwarded-For → 403', async () => {
  const res = await api('/api/runs/1', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  assert.equal(res.status, 403);
});

test('job_id ze śmieciem daje 400 na liście i licznikach — nie cichą odpowiedź bez filtra', async () => {
  // parseInt('12x') = 12, parseInt('x') = NaN. NaN wchodził dalej jako „brak filtra", więc
  // pytanie o konkretne zadanie dostawało 200 i dane WSZYSTKICH zadań.
  // /api/runs/recent świadomie pominięty — ten endpoint nie zna parametru job_id (tylko per_job).
  for (const path of ['/api/runs', '/api/runs/stats']) {
    for (const bad of ['x', '12x', '0', '-3', '1.5', '99999999999999999999']) {
      const res = await api(`${path}?job_id=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `${path}?job_id=${bad} musi być odrzucone`);
    }
  }

  // Poprawne id dalej działa, brak parametru też (filtr nieobowiązkowy).
  assert.equal((await api(`/api/runs/stats?job_id=${jobA.id}`)).status, 200);
  assert.equal((await api('/api/runs/stats')).status, 200);
});
