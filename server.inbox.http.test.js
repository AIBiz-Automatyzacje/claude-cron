const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Testy HTTP huba Team OS (/inbox/v1/:token/* + prywatne /api/inbox/members) na ŻYWYM
// procesie serwera (wzorzec server.env.test.js / ask.http.test.js): server.js startuje
// DB/scheduler przy require, więc driver przez spawn + fetch omija te side-effecty w runnerze.
// config.js czyta env RAZ przy starcie procesu, dlatego izolowane bazy (CLAUDE_CRON_DB_PATH +
// CLAUDE_CRON_INBOX_DB_PATH → tmp; test PISZE członków/wiadomości, nie może dotknąć realnych
// baz usera) i WEBHOOK_BASE_URL (źródło Funnel-URL kodu zaproszenia) wchodzą przy SPAWNIE.

const PORT = 7801;
const FUNNEL_URL = 'https://test-hub.tail1234.ts.net';

let tmpDir;
let server;

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

// Utworzenie członka przez prywatne API (localhost bez XFF = dozwolone). Zwraca pełny
// token — potrzebny testom do wołania publicznych endpointów tokenowych.
async function createMember(name) {
  const res = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `utworzenie członka "${name}" zwróciło ${res.status}`);
  return res.json();
}

// Wywołanie publicznego tokenowego endpointu inbox.
function inboxCall(token, action, { method = 'POST', body, xff } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (xff) headers['X-Forwarded-For'] = xff;
  return fetch(url(`/inbox/v1/${token}/${action}`), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-http-'));
  server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      CLAUDE_CRON_PORT: String(PORT),
      CLAUDE_CRON_DB_PATH: path.join(tmpDir, 'claude-cron.db'),
      CLAUDE_CRON_INBOX_DB_PATH: path.join(tmpDir, 'inbox.db'),
      WEBHOOK_BASE_URL: FUNNEL_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServerReady(server);
});

after(() => {
  if (server) server.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/inbox/members zwraca pełny token + kod zaproszenia jednorazowo; GET maskuje', async () => {
  // Act — utworzenie
  const created = await createMember('Ala');

  // Assert — pełny token (64-znakowy hex) i gotowy kod zaproszenia TYLKO w odpowiedzi POST
  assert.match(created.token, /^[0-9a-f]{64}$/, 'pełny token to hex z randomBytes(32)');
  assert.equal(created.name, 'Ala');
  assert.equal(created.invite_code, `puls-inbox:${FUNNEL_URL}#${created.token}`);

  // Assert — GET zwraca WYŁĄCZNIE maskę (ostatnie 4 znaki), nigdy pełnego tokenu
  const listRes = await fetch(url('/api/inbox/members'));
  assert.equal(listRes.status, 200);
  const members = await listRes.json();
  const ala = members.find((m) => m.name === 'Ala');
  assert.ok(ala, 'Ala jest na liście członków');
  assert.equal(ala.token_masked, `…${created.token.slice(-4)}`);
  assert.ok(!('token' in ala), 'GET nie zwraca pełnego tokenu w żadnym polu');
  assert.ok(!('invite_code' in ala), 'GET nie zwraca kodu zaproszenia');
});

test('kolejność matcherów: /inbox/v1/:token/ping działa z X-Forwarded-For, /api/inbox/members z XFF → 403', async () => {
  // Arrange
  const member = await createMember('Funnelowy');

  // Act + Assert — inbox jest publiczny: ruch z Funnela (XFF) MUSI przejść
  const pingRes = await inboxCall(member.token, 'ping', { method: 'GET', xff: '203.0.113.9' });
  assert.equal(pingRes.status, 200, 'ping przez Funnel przechodzi (matcher przed guardem XFF)');
  const ping = await pingRes.json();
  assert.equal(ping.v, 1);
  assert.equal(ping.user, 'Funnelowy', 'hub wyprowadza tożsamość z tokenu');
  assert.equal(ping.hub, 'puls');

  // Act + Assert — prywatne API administracyjne jest ZA guardem: XFF = 403
  const adminRes = await fetch(url('/api/inbox/members'), { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(adminRes.status, 403, 'guard XFF chroni /api/inbox/members przed Funnelem');
});

test('idempotencja done przez HTTP: powtórzony done → already_done, bez duplikatu reply', async () => {
  // Arrange — Sender wysyła task do Receivera
  const sender = await createMember('Sender');
  const receiver = await createMember('Receiver');
  const sendRes = await inboxCall(sender.token, 'send', {
    body: { to_user: 'Receiver', type: 'task', title: 'Zrób raport' },
  });
  assert.equal(sendRes.status, 200);

  // Receiver pobiera, znajduje id taska
  const pull1 = await (await inboxCall(receiver.token, 'pull')).json();
  const task = pull1.active.find((m) => m.type === 'task' && m.title === 'Zrób raport');
  assert.ok(task, 'task dotarł do Receivera');

  // Act — pierwszy done → replied
  const done1 = await (await inboxCall(receiver.token, 'done', { body: { id: task.id, action: 'Zrobione' } })).json();
  assert.equal(done1.result, 'replied', 'pierwszy done na tasku tworzy reply i zamyka');

  // Act — powtórzony done na TYM SAMYM rekordzie → already_done (re-read statusu z DB)
  const done2 = await (await inboxCall(receiver.token, 'done', { body: { id: task.id, action: 'Zrobione' } })).json();
  assert.equal(done2.result, 'already_done', 'drugi done to no-op, zero skutków ubocznych');

  // Assert — BRAK duplikatu wiersza reply: Sender widzi dokładnie JEDEN reply w wątku
  const pullSender = await (await inboxCall(sender.token, 'pull')).json();
  const repliesInThread = pullSender.threadRows.filter(
    (m) => m.thread_id === task.thread_id && m.type === 'reply'
  );
  assert.equal(repliesInThread.length, 1, 'dokładnie jeden reply mimo dwóch done (idempotencja)');
});

test('granica JSON przez pełny stos: pull zwraca payload.auto_reply jako BOOLEAN true, nie string', async () => {
  // Arrange — wiadomość z payloadem zawierającym auto_reply: true (boolean)
  const sender = await createMember('AutoSender');
  const receiver = await createMember('AutoReceiver');
  const sendRes = await inboxCall(sender.token, 'send', {
    body: {
      to_user: 'AutoReceiver',
      type: 'task',
      title: 'Sprawdź coś',
      payload: { auto_reply: true },
    },
  });
  assert.equal(sendRes.status, 200);

  // Act — Receiver pobiera przez HTTP (send serializuje, pull deserializuje — cały stos)
  const pull = await (await inboxCall(receiver.token, 'pull')).json();
  const msg = pull.active.find((m) => m.title === 'Sprawdź coś');
  assert.ok(msg, 'wiadomość dotarła');

  // Assert — payload jest OBIEKTEM, a auto_reply BOOLEANEM (nie string "true")
  assert.equal(typeof msg.payload, 'object');
  assert.equal(typeof msg.payload.auto_reply, 'boolean', 'auto_reply przeżył granicę JSON jako boolean');
  assert.equal(msg.payload.auto_reply, true);
});

test('DELETE /api/inbox/members/:id odwołuje członka; jego token przestaje działać', async () => {
  // Arrange
  const member = await createMember('DoUsuniecia');
  // token działa przed odwołaniem
  assert.equal((await inboxCall(member.token, 'ping', { method: 'GET' })).status, 200);

  // Act — odwołanie
  const delRes = await fetch(url(`/api/inbox/members/${member.id}`), { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { ok: true });

  // Assert — odwołany token to teraz intruz (403 bez treści)
  assert.equal((await inboxCall(member.token, 'ping', { method: 'GET' })).status, 403);
  // Powtórny DELETE nieistniejącego → 404
  assert.equal((await fetch(url(`/api/inbox/members/${member.id}`), { method: 'DELETE' })).status, 404);
});

test('POST /api/inbox/members z duplikatem imienia → 409; bez name → 400', async () => {
  // Arrange
  await createMember('Unikat');

  // Act + Assert — duplikat name (UNIQUE) mapowany na 409
  const dup = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Unikat' }),
  });
  assert.equal(dup.status, 409);

  // Act + Assert — brak name → 400
  const noName = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noName.status, 400);
});
