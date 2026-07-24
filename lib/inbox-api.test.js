const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const inboxDb = require('./inbox-db');
const {
  MAX_BODY_SIZE,
  INBOX_RATE_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
  matchInboxToken,
  resetInboxApiState,
  handleInboxRequest,
} = require('./inbox-api');

// Świeża baza :memory: + czysty stan rate-limitu przed każdym testem.
beforeEach(() => {
  inboxDb.close();
  inboxDb.setInboxDbPath(':memory:');
  resetInboxApiState();
});
afterEach(() => {
  inboxDb.close();
});

// Tworzy członka i zwraca jego pełny token (wzorzec addMember z inbox-db).
function seedMember(name) {
  return inboxDb.addMember(name).token;
}

// Skrót wywołania handlera z ustalonym zegarem (deterministyczny rate limit).
function call(input, now = 1_000) {
  return handleInboxRequest(input, { inboxDb, now });
}

// ──────── matchInboxToken (bliźniak webhook.js) ────────

test('matchInboxToken: happy — /inbox/v1/:token/:action → {token, action}', () => {
  assert.deepStrictEqual(matchInboxToken('/inbox/v1/abc/pull'), { token: 'abc', action: 'pull' });
});

test('matchInboxToken: obcina query string', () => {
  assert.deepStrictEqual(matchInboxToken('/inbox/v1/abc/done?foo=1'), { token: 'abc', action: 'done' });
});

test('matchInboxToken: claim-query (myślnik w akcji) parsuje się', () => {
  assert.deepStrictEqual(matchInboxToken('/inbox/v1/tok/claim-query'), { token: 'tok', action: 'claim-query' });
});

test('matchInboxToken: nieznana wersja ścieżki → null', () => {
  assert.strictEqual(matchInboxToken('/inbox/v2/abc/pull'), null);
});

test('matchInboxToken: brak akcji → null', () => {
  assert.strictEqual(matchInboxToken('/inbox/v1/abc'), null);
});

test('matchInboxToken: obcy prefiks / nie-string → null', () => {
  assert.strictEqual(matchInboxToken('/webhook/abc'), null);
  assert.strictEqual(matchInboxToken(null), null);
});

// ──────── Autoryzacja ────────

test('autoryzacja: zły token → 403 bez treści', () => {
  seedMember('kacper');
  const res = call({ token: 'nie-istnieje', action: 'ping', method: 'GET' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json, undefined);
});

test('autoryzacja: brak członków → 403 (pusta lista tokenów)', () => {
  const res = call({ token: 'cokolwiek', action: 'ping', method: 'GET' });
  assert.strictEqual(res.status, 403);
});

test('autoryzacja: dobry token przechodzi — hub wyprowadza user z tokenu', () => {
  const token = seedMember('kacper');
  const res = call({ token, action: 'ping', method: 'GET' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.user, 'kacper');
});

// ──────── Rate limit (wymaganie twarde #3) ────────

test('rate limit: 60 żądań przechodzi, 61. w oknie → 429', () => {
  const token = seedMember('kacper');
  for (let i = 0; i < INBOX_RATE_LIMIT_PER_MIN; i++) {
    assert.strictEqual(call({ token, action: 'ping', method: 'GET' }).status, 200, `żądanie ${i + 1}`);
  }
  const over = call({ token, action: 'ping', method: 'GET' });
  assert.strictEqual(over.status, 429);
  assert.strictEqual(over.json.v, 1);
  assert.strictEqual(over.json.error, 'rate_limited');
});

test('rate limit: nowe okno po 60 s zeruje licznik', () => {
  const token = seedMember('kacper');
  for (let i = 0; i < INBOX_RATE_LIMIT_PER_MIN; i++) {
    call({ token, action: 'ping', method: 'GET' }, 1_000);
  }
  assert.strictEqual(call({ token, action: 'ping', method: 'GET' }, 1_000).status, 429);
  // Po upływie okna licznik startuje od zera.
  assert.strictEqual(call({ token, action: 'ping', method: 'GET' }, 1_000 + RATE_WINDOW_MS).status, 200);
});

test('rate limit: liczony per token (jeden członek nie zjada okna drugiego)', () => {
  const tokA = seedMember('a');
  const tokB = seedMember('b');
  for (let i = 0; i < INBOX_RATE_LIMIT_PER_MIN; i++) {
    call({ token: tokA, action: 'ping', method: 'GET' });
  }
  assert.strictEqual(call({ token: tokA, action: 'ping', method: 'GET' }).status, 429);
  assert.strictEqual(call({ token: tokB, action: 'ping', method: 'GET' }).status, 200);
});

// ──────── Routing: metoda / nieznana akcja / cap body ────────

test('routing: zła metoda → 405', () => {
  const token = seedMember('kacper');
  assert.strictEqual(call({ token, action: 'ping', method: 'POST' }).status, 405);
  assert.strictEqual(call({ token, action: 'pull', method: 'GET' }).status, 405);
});

test('routing: nieznana akcja → 404 bez treści', () => {
  const token = seedMember('kacper');
  const res = call({ token, action: 'nieznana', method: 'GET' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.json, undefined);
});

test('cap body: rawBody > 64 KB → 413', () => {
  const token = seedMember('kacper');
  const huge = 'x'.repeat(MAX_BODY_SIZE + 1);
  const res = call({ token, action: 'send', method: 'POST', rawBody: huge });
  assert.strictEqual(res.status, 413);
});

// ──────── Walidacja inputu ────────

test('walidacja: nieznany type w send → 400 invalid_type', () => {
  const token = seedMember('kacper');
  const body = JSON.stringify({ to_user: 'kamil', type: 'wtf', title: 'T' });
  const res = call({ token, action: 'send', method: 'POST', rawBody: body });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'invalid_type');
});

test('walidacja: nieznana action w done → 400 invalid_action', () => {
  const token = seedMember('kamil');
  const body = JSON.stringify({ id: 'jakieś-id', action: 'Skasowane' });
  const res = call({ token, action: 'done', method: 'POST', rawBody: body });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'invalid_action');
});

test('walidacja: niepoprawny JSON w body POST → 400 invalid_json', () => {
  const token = seedMember('kacper');
  const res = call({ token, action: 'send', method: 'POST', rawBody: '{nie-json' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'invalid_json');
});

// ──────── ping ────────

test('ping: happy → {v:1, user, hub:puls}', () => {
  const token = seedMember('kacper');
  const res = call({ token, action: 'ping', method: 'GET' });
  assert.deepStrictEqual(res.json, { v: 1, user: 'kacper', hub: 'puls' });
});

// ──────── pull ────────

test('pull: happy — zwraca wątki członka i oznacza pending→delivered', () => {
  const token = seedMember('kamil');
  inboxDb.sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'task', title: 'Zrób X' });

  const res = call({ token, action: 'pull', method: 'POST' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.v, 1);
  assert.strictEqual(res.json.user, 'kamil');
  assert.strictEqual(res.json.active.length, 1);
  assert.strictEqual(res.json.active[0].status, 'pending'); // renderer wykrywa "nowe"
  // Po pullu rekord jest delivered w DB.
  const stored = inboxDb.getMessage(res.json.active[0].id);
  assert.strictEqual(stored.status, 'delivered');
});

test('pull: payload wraca jako OBIEKT, nie string (wymaganie twarde #1)', () => {
  const token = seedMember('kamil');
  inboxDb.sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'reply', title: 'Re', payload: { auto_reply: true } });

  const res = call({ token, action: 'pull', method: 'POST' });
  assert.strictEqual(typeof res.json.active[0].payload, 'object');
  assert.strictEqual(res.json.active[0].payload.auto_reply, true);
});

// ──────── done ────────

test('done: task+Zrobione → replied, zwraca pełną nitkę wątku', () => {
  const token = seedMember('kamil');
  const task = inboxDb.sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'task', title: 'Zrób X' });

  const res = call({ token, action: 'done', method: 'POST', rawBody: JSON.stringify({ id: task.id, action: 'Zrobione' }) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.result, 'replied');
  assert.ok(Array.isArray(res.json.thread));
  assert.strictEqual(res.json.thread.length, 2); // task + reply
});

test('done: idempotentnie — powtórzony done na domkniętym rekordzie → already_done, zero skutków', () => {
  const token = seedMember('kamil');
  const task = inboxDb.sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'task', title: 'Zrób X' });
  const doneBody = JSON.stringify({ id: task.id, action: 'Zrobione' });

  call({ token, action: 'done', method: 'POST', rawBody: doneBody });
  const rowsAfterFirst = inboxDb.getInboxDb().prepare('SELECT COUNT(*) AS n FROM inbox').get().n;

  const second = call({ token, action: 'done', method: 'POST', rawBody: doneBody });
  assert.strictEqual(second.json.result, 'already_done');
  const rowsAfterSecond = inboxDb.getInboxDb().prepare('SELECT COUNT(*) AS n FROM inbox').get().n;
  assert.strictEqual(rowsAfterSecond, rowsAfterFirst); // brak duplikatu reply
});

test('done: brak id → 400 invalid_id', () => {
  const token = seedMember('kamil');
  const res = call({ token, action: 'done', method: 'POST', rawBody: JSON.stringify({ action: 'Zapoznane' }) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'invalid_id');
});

// ──────── send ────────

test('send: happy — INSERT wiadomości, from_user z tokenu (nie z body)', () => {
  const token = seedMember('kacper');
  const body = JSON.stringify({ to_user: 'kamil', type: 'query', title: 'Pytanie', content: 'treść', from_user: 'PODSZYCIE' });
  const res = call({ token, action: 'send', method: 'POST', rawBody: body });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.message.from_user, 'kacper'); // tożsamość z tokenu wygrywa
  assert.strictEqual(res.json.message.to_user, 'kamil');
  assert.strictEqual(res.json.message.type, 'query');
});

test('send: brak to_user → 400 invalid_to_user', () => {
  const token = seedMember('kacper');
  const res = call({ token, action: 'send', method: 'POST', rawBody: JSON.stringify({ type: 'task', title: 'T' }) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'invalid_to_user');
});

// ──────── claim-query ────────

test('claim-query: happy — atomowy claim jednego query', () => {
  const token = seedMember('kamil');
  inboxDb.sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'query', title: 'Pytanie?' });

  const res = call({ token, action: 'claim-query', method: 'POST' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.query.type, 'query');
  assert.strictEqual(res.json.query.title, 'Pytanie?');
});

test('claim-query: brak kandydata → {v:1, query:null}', () => {
  const token = seedMember('kamil');
  const res = call({ token, action: 'claim-query', method: 'POST' });
  assert.deepStrictEqual(res.json, { v: 1, query: null });
});

test('claim-query: drugi claim tego samego query → null (idempotentny marker)', () => {
  const token = seedMember('kamil');
  inboxDb.sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'query', title: 'Pytanie?' });

  const first = call({ token, action: 'claim-query', method: 'POST' });
  const second = call({ token, action: 'claim-query', method: 'POST' });
  assert.notStrictEqual(first.json.query, null);
  assert.strictEqual(second.json.query, null);
});
