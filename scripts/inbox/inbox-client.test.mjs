// Testy inbox-client.mjs — wrapper fetch huba Team OS.
// Mockujemy TYLKO zewnętrzny serwis (global.fetch); logika klienta (retry, weryfikacja
// wersji, budowa URL, błędy konfiguracji) jest testowana naprawdę. Snapshot/restore
// global.fetch i env INBOX_* per-case (wzorzec izolacji z env-loader.test.mjs) —
// żadnego realnego żądania HTTP ani dotknięcia produkcyjnego .env.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ping, pull, done, send, claimQuery, InboxClientError } from './inbox-client.mjs';

const HUB_URL = 'https://hub.example.ts.net';
const TOKEN = 'deadbeef';

const originalFetch = global.fetch;
let savedEnv;

beforeEach(() => {
  savedEnv = { url: process.env.INBOX_HUB_URL, token: process.env.INBOX_TOKEN };
  process.env.INBOX_HUB_URL = HUB_URL;
  process.env.INBOX_TOKEN = TOKEN;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (savedEnv.url === undefined) delete process.env.INBOX_HUB_URL;
  else process.env.INBOX_HUB_URL = savedEnv.url;
  if (savedEnv.token === undefined) delete process.env.INBOX_TOKEN;
  else process.env.INBOX_TOKEN = savedEnv.token;
});

// Odpowiedź w kształcie fetch Response (tylko pola, których używa klient).
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

// Kolejkuje odpowiedzi/rzuty per wywołanie fetch; nagrywa argumenty. Ostatni element
// powtarza się, gdy prób jest więcej niż wpisów.
function mockFetch(items) {
  const calls = [];
  let i = 0;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    if (item.throw) throw item.throw;
    return item.response;
  };
  return calls;
}

// === Happy path: każda metoda publiczna zwraca sparsowany obiekt i buduje właściwe żądanie ===

test('ping: happy path — GET właściwy URL, zwraca sparsowany obiekt', async () => {
  const calls = mockFetch([{ response: jsonResponse(200, { v: 1, user: 'kacper', hub: 'puls' }) }]);
  const result = await ping();
  assert.deepEqual(result, { v: 1, user: 'kacper', hub: 'puls' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${HUB_URL}/inbox/v1/${TOKEN}/ping`);
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.body, undefined);
});

test('pull: happy path — POST bez body, payload pozostaje obiektem', async () => {
  const threads = { v: 1, received: [{ id: 'a', payload: { auto_reply: true } }], delegated: [] };
  const calls = mockFetch([{ response: jsonResponse(200, threads) }]);
  const result = await pull();
  assert.deepEqual(result, threads);
  // Granica JSON nietknięta: payload nadal obiektem.
  assert.equal(result.received[0].payload.auto_reply, true);
  assert.equal(calls[0].url, `${HUB_URL}/inbox/v1/${TOKEN}/pull`);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, undefined);
});

test('done: happy path — POST z body {id, action}, zwraca odpowiedź huba', async () => {
  const calls = mockFetch([{ response: jsonResponse(200, { v: 1, result: 'already_done' }) }]);
  const result = await done({ id: 'msg-1', action: 'Zrobione' });
  assert.deepEqual(result, { v: 1, result: 'already_done' });
  assert.equal(calls[0].url, `${HUB_URL}/inbox/v1/${TOKEN}/done`);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { id: 'msg-1', action: 'Zrobione' });
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
});

test('send: happy path — pola opcjonalne dokładane tylko gdy podane', async () => {
  const calls = mockFetch([{ response: jsonResponse(200, { v: 1, message: { id: 'x' } }) }]);
  const result = await send({
    to_user: 'kamil',
    type: 'task',
    title: 'Zrób raport',
    content: 'treść',
    payload: { auto_reply: true },
  });
  assert.deepEqual(result, { v: 1, message: { id: 'x' } });
  const sentBody = JSON.parse(calls[0].opts.body);
  assert.deepEqual(sentBody, {
    to_user: 'kamil',
    type: 'task',
    title: 'Zrób raport',
    content: 'treść',
    payload: { auto_reply: true },
  });
  // thread_id nie podane → nieobecne w body (nie null).
  assert.equal('thread_id' in sentBody, false);
});

test('claimQuery: happy path — POST, zwraca {query:null} gdy brak kandydata', async () => {
  const calls = mockFetch([{ response: jsonResponse(200, { v: 1, query: null }) }]);
  const result = await claimQuery();
  assert.deepEqual(result, { v: 1, query: null });
  assert.equal(calls[0].url, `${HUB_URL}/inbox/v1/${TOKEN}/claim-query`);
  assert.equal(calls[0].opts.method, 'POST');
});

// === Timeout: 1 retry, po drugim niepowodzeniu czytelny błąd ===

test('timeout: AbortError dwukrotnie → 1 retry, potem czytelny błąd', async () => {
  const calls = mockFetch([{ throw: abortError() }, { throw: abortError() }]);
  await assert.rejects(ping(), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /nie odpowiada/);
    assert.match(err.message, /limit czasu/);
    return true;
  });
  assert.equal(calls.length, 2); // 1 próba + 1 retry
});

test('timeout: pierwszy AbortError, drugi sukces → retry ratuje żądanie', async () => {
  const calls = mockFetch([
    { throw: abortError() },
    { response: jsonResponse(200, { v: 1, user: 'kacper', hub: 'puls' }) },
  ]);
  const result = await ping();
  assert.equal(result.user, 'kacper');
  assert.equal(calls.length, 2);
});

// === send: NIE-idempotentny → zero retry na timeout/5xx (unikamy zdublowanej wiadomości) ===

test('send: AbortError → BEZ retry (1 próba), czytelny błąd — nie ryzykujemy duplikatu', async () => {
  const calls = mockFetch([{ throw: abortError() }, { throw: abortError() }]);
  await assert.rejects(send({ to_user: 'kamil', type: 'reply', title: 'Re: x' }), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /nie odpowiada/);
    return true;
  });
  assert.equal(calls.length, 1); // send nie jest ponawiany — INSERT bez klucza dedup
});

test('send: 502 → BEZ retry (1 próba), czytelny błąd', async () => {
  const calls = mockFetch([{ response: jsonResponse(502, {}) }, { response: jsonResponse(502, {}) }]);
  await assert.rejects(send({ to_user: 'kamil', type: 'reply', title: 'Re: x' }), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /nie odpowiada/);
    return true;
  });
  assert.equal(calls.length, 1);
});

// === 5xx: 1 retry, po drugim niepowodzeniu czytelny błąd ===

test('5xx: dwa razy 502 → 1 retry, potem czytelny błąd', async () => {
  const calls = mockFetch([
    { response: jsonResponse(502, {}) },
    { response: jsonResponse(502, {}) },
  ]);
  await assert.rejects(pull(), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /nie odpowiada/);
    assert.match(err.message, /502/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('5xx: pierwszy 503, drugi 200 → retry ratuje żądanie', async () => {
  const calls = mockFetch([
    { response: jsonResponse(503, {}) },
    { response: jsonResponse(200, { v: 1, query: null }) },
  ]);
  const result = await claimQuery();
  assert.deepEqual(result, { v: 1, query: null });
  assert.equal(calls.length, 2);
});

// === Zła wersja: czytelny błąd „Zaktualizuj Pulsa", BEZ retry ===

test('zła wersja: v:2 → czytelny błąd, bez retry', async () => {
  const calls = mockFetch([{ response: jsonResponse(200, { v: 2, user: 'kacper' }) }]);
  await assert.rejects(ping(), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /Zaktualizuj Pulsa/);
    return true;
  });
  assert.equal(calls.length, 1); // niezgodność wersji nie jest retryowana
});

test('zła wersja: brak pola v → czytelny błąd', async () => {
  mockFetch([{ response: jsonResponse(200, { user: 'kacper' }) }]);
  await assert.rejects(pull(), (err) => {
    assert.match(err.message, /Zaktualizuj Pulsa/);
    assert.match(err.message, /otrzymano v:brak/);
    return true;
  });
});

// === 4xx: trwała odmowa, bez retry ===

test('4xx: 403 zły token → czytelny błąd, bez retry', async () => {
  const calls = mockFetch([{ response: jsonResponse(403, {}) }]);
  await assert.rejects(pull(), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /odrzucił żądanie/);
    assert.match(err.message, /403/);
    return true;
  });
  assert.equal(calls.length, 1);
});

// === Brak konfiguracji: czytelny błąd dla KAŻDEJ metody publicznej ===

const methods = [
  ['ping', () => ping()],
  ['pull', () => pull()],
  ['done', () => done({ id: 'x', action: 'Zrobione' })],
  ['send', () => send({ to_user: 'k', type: 'task', title: 't' })],
  ['claimQuery', () => claimQuery()],
];

for (const [name, call] of methods) {
  test(`brak INBOX_HUB_URL: ${name} → czytelny błąd konfiguracji`, async () => {
    delete process.env.INBOX_HUB_URL;
    global.fetch = () => {
      throw new Error('fetch nie powinien zostać wywołany bez konfiguracji');
    };
    await assert.rejects(call(), (err) => {
      assert.ok(err instanceof InboxClientError);
      assert.match(err.message, /INBOX_HUB_URL/);
      return true;
    });
  });

  test(`brak INBOX_TOKEN: ${name} → czytelny błąd konfiguracji`, async () => {
    delete process.env.INBOX_TOKEN;
    global.fetch = () => {
      throw new Error('fetch nie powinien zostać wywołany bez konfiguracji');
    };
    await assert.rejects(call(), (err) => {
      assert.ok(err instanceof InboxClientError);
      assert.match(err.message, /INBOX_TOKEN/);
      return true;
    });
  });
}

// === Walidacja argumentów metod (fail-fast na wejściu) ===

test('done: brak id → czytelny błąd, fetch niewywołany', async () => {
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return jsonResponse(200, { v: 1 });
  };
  await assert.rejects(done({ action: 'Zrobione' }), /wymagane pole "id"/);
  assert.equal(fetchCalled, false);
});

test('send: brak to_user → czytelny błąd, fetch niewywołany', async () => {
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return jsonResponse(200, { v: 1 });
  };
  await assert.rejects(send({ type: 'task', title: 't' }), /wymagane pole "to_user"/);
  assert.equal(fetchCalled, false);
});
