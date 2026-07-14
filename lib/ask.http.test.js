const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TEXT_SYNC_BUSY } = require('./ask');

// Testy HTTP endpointu /ask/:token na ŻYWYM procesie serwera (wzorzec server.env.test.js):
// server.js startuje DB/scheduler przy require, więc driver przez spawn + fetch omija te
// side-effecty w procesie runnera. config.js czyta env RAZ przy starcie procesu, dlatego
// override binarki (CLAUDE_CRON_CLAUDE_BIN → atrapa), izolowana baza (CLAUDE_CRON_DB_PATH
// → tmp; test PISZE joby/runy, nie może dotknąć realnej bazy usera) i sekrety ASK_* wchodzą
// przy SPAWNIE, nie przez process.env runnera.
//
// Atrapa CLI przez shebang `#!/usr/bin/env node` — wymaga POSIX → skip na Windows
// (ta sama konwencja co lib/ask.test.js).
const SKIP_WIN = process.platform === 'win32'
  ? 'atrapa CLI przez shebang wymaga POSIX — endpoint pokryty na macOS/Linux'
  : false;

const PORT_ENABLED = 7799;
const PORT_DISABLED = 7800;
const TEST_TOKEN = 'test-token-http';
const TEST_SECRET = 'test-secret-http';
const FAKE_ANSWER = 'ODPOWIEDZ ATRAPY';

let tmpDir;
let serverEnabled;
let serverDisabled;

const urlEnabled = (p) => `http://localhost:${PORT_ENABLED}${p}`;
const urlDisabled = (p) => `http://localhost:${PORT_DISABLED}${p}`;

// Jedna atrapa na proces serwera (env), więc różnicuje zachowanie po treści promptu:
// prompt zawierający 'SLEEP' śpi 3 s (scenariusz „jeszcze myślę"), reszta odpowiada od razu.
function writeFakeClaude(dir) {
  const scriptPath = path.join(dir, 'fake-claude');
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    "const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';",
    "if (prompt.includes('SLEEP')) { setTimeout(() => console.log('obudzony'), 3000); }",
    `else { console.log('${FAKE_ANSWER}'); }`,
  ].join('\n'));
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

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

function spawnServer({ port, dbFile, askEnv }) {
  return spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      CLAUDE_CRON_PORT: String(port),
      CLAUDE_CRON_DB_PATH: dbFile,
      ...askEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

before(async () => {
  if (SKIP_WIN) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-http-'));
  const fakeClaude = writeFakeClaude(tmpDir);

  serverEnabled = spawnServer({
    port: PORT_ENABLED,
    dbFile: path.join(tmpDir, 'enabled.db'),
    askEnv: {
      ASK_ENABLED: '1',
      ASK_TOKEN: TEST_TOKEN,
      ASK_SECRET: TEST_SECRET,
      CLAUDE_CRON_CLAUDE_BIN: fakeClaude,
    },
  });
  // Serwer z poprawnymi sekretami, ale BEZ ASK_ENABLED=1 — scenariusz opt-in
  // wymaga osobnego procesu (env czytany raz przy starcie).
  serverDisabled = spawnServer({
    port: PORT_DISABLED,
    dbFile: path.join(tmpDir, 'disabled.db'),
    askEnv: {
      ASK_ENABLED: '0',
      ASK_TOKEN: TEST_TOKEN,
      ASK_SECRET: TEST_SECRET,
      CLAUDE_CRON_CLAUDE_BIN: fakeClaude,
    },
  });
  await Promise.all([waitForServerReady(serverEnabled), waitForServerReady(serverDisabled)]);
});

after(() => {
  if (serverEnabled) serverEnabled.kill('SIGKILL');
  if (serverDisabled) serverDisabled.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST bez X-Secret → 403 bez szczegółów', { skip: SKIP_WIN }, async () => {
  const res = await fetch(urlEnabled(`/ask/${TEST_TOKEN}`), { method: 'POST', body: 'pytanie' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'Forbidden', 'body nie zdradza, czy padł token czy sekret');
});

test('POST ze złym sekretem → 403 z identycznym body jak przy złym tokenie', { skip: SKIP_WIN }, async () => {
  const badSecret = await fetch(urlEnabled(`/ask/${TEST_TOKEN}`), {
    method: 'POST',
    headers: { 'X-Secret': 'zly-sekret' },
    body: 'pytanie',
  });
  const badToken = await fetch(urlEnabled('/ask/zly-token'), {
    method: 'POST',
    headers: { 'X-Secret': TEST_SECRET },
    body: 'pytanie',
  });
  assert.equal(badSecret.status, 403);
  assert.equal(badToken.status, 403);
  // Nierozróżnialność przypadków — intruz nie wie, który z dwóch sekretów trafił
  assert.deepEqual(await badSecret.json(), await badToken.json());
});

test('ASK_ENABLED niewłączony → 403 nawet z poprawnymi sekretami', { skip: SKIP_WIN }, async () => {
  const res = await fetch(urlDisabled(`/ask/${TEST_TOKEN}`), {
    method: 'POST',
    headers: { 'X-Secret': TEST_SECRET },
    body: 'pytanie',
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'Forbidden');
});

test('GET na /ask/<token> → 405', { skip: SKIP_WIN }, async () => {
  const res = await fetch(urlEnabled(`/ask/${TEST_TOKEN}`));
  assert.equal(res.status, 405);
});

test('happy path: POST text/plain → 200 text/plain z odpowiedzią atrapy, run widoczny w /api/runs', { skip: SKIP_WIN }, async () => {
  // Act
  const res = await fetch(urlEnabled(`/ask/${TEST_TOKEN}`), {
    method: 'POST',
    headers: { 'X-Secret': TEST_SECRET, 'Content-Type': 'text/plain' },
    body: 'jaka jutro pogoda',
  });

  // Assert — odpowiedź HTTP
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await res.text(), FAKE_ANSWER);

  // Assert — run teczki widoczny przez API (localhost bez XFF = dashboard dostępny)
  const runsRes = await fetch(urlEnabled('/api/runs'));
  assert.equal(runsRes.status, 200);
  const runs = await runsRes.json();
  const askRun = runs.find((r) => r.trigger_type === 'ask');
  assert.ok(askRun, 'run z trigger_type=ask istnieje');
  assert.equal(askRun.status, 'success');
  assert.equal(askRun.webhook_payload, 'jaka jutro pogoda');
});

test('puste body → 200 z przyjaznym tekstem, bez tworzenia runu', { skip: SKIP_WIN }, async () => {
  const res = await fetch(urlEnabled(`/ask/${TEST_TOKEN}`), {
    method: 'POST',
    headers: { 'X-Secret': TEST_SECRET },
    body: '   ',
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(await res.text(), /nic nie usłyszałem/i);
});

test('X-Forwarded-For: /ask przechodzi (publiczny), /api/jobs dalej 403 (kontrakt kolejności matcherów)', { skip: SKIP_WIN }, async () => {
  const resAsk = await fetch(urlEnabled(`/ask/${TEST_TOKEN}`), {
    method: 'POST',
    headers: { 'X-Secret': TEST_SECRET, 'X-Forwarded-For': '203.0.113.7' },
    body: 'pytanie przez funnel',
  });
  assert.equal(resAsk.status, 200);
  assert.equal(await resAsk.text(), FAKE_ANSWER);

  const resApi = await fetch(urlEnabled('/api/jobs'), {
    headers: { 'X-Forwarded-For': '203.0.113.7' },
  });
  assert.equal(resApi.status, 403, 'guard XFF na dashboardzie nienaruszony');
});

test('drugi równoległy POST → 200 z tekstem „jeszcze myślę"', { skip: SKIP_WIN }, async () => {
  // Arrange — pierwszy POST trzyma lock sync (atrapa śpi 3 s na 'SLEEP')
  const firstPromise = fetch(urlEnabled(`/ask/${TEST_TOKEN}`), {
    method: 'POST',
    headers: { 'X-Secret': TEST_SECRET },
    body: 'SLEEP proszę policz coś długo',
  });
  // Krótka pauza, żeby serwer przyjął pierwszy request i zdążył zarezerwować lock
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Act
  const second = await fetch(urlEnabled(`/ask/${TEST_TOKEN}`), {
    method: 'POST',
    headers: { 'X-Secret': TEST_SECRET },
    body: 'czy już wolny?',
  });

  // Assert — odmowa zajętości jako 200 z dokładnym tekstem
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await second.text(), TEXT_SYNC_BUSY);

  // Pierwszy kończy się normalnie (sync, w oknie ASK_TIMEOUT_MS)
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'obudzony');
});
