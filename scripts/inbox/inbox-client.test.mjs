// Testy inbox-client.mjs — wrapper fetch huba Team OS.
// Mockujemy TYLKO zewnętrzny serwis (global.fetch); logika klienta (retry, weryfikacja
// wersji, budowa URL, błędy konfiguracji) jest testowana naprawdę. Snapshot/restore
// global.fetch i env INBOX_* per-case (wzorzec izolacji z env-loader.test.mjs) —
// żadnego realnego żądania HTTP ani dotknięcia produkcyjnego .env.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ping,
  pull,
  done,
  send,
  claimQuery,
  uploadBlob,
  downloadBlob,
  setBinaryTimeoutMs,
  InboxClientError,
} from './inbox-client.mjs';

const HUB_URL = 'https://hub.example.ts.net';
const TOKEN = 'deadbeef';
const SHA = 'a'.repeat(64);

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

// Odpowiedź błędu z czytelnym ciałem — hub odsyła powód i podpowiedź, klient ma je pokazać.
function errorResponse(status, rawBody) {
  return { ok: false, status, text: async () => rawBody };
}

test('4xx: nieznany adresat → komunikat niesie powód I listę członków (nie samo „HTTP 400")', async () => {
  // Regresja z retestu T11B: hub odsyłał {error, members}, a klient rzucał gołym kodem
  // statusu — użytkownik musiał zgadywać, jaki nick jest poprawny.
  mockFetch([{ response: errorResponse(400, JSON.stringify({ v: 1, error: 'unknown_recipient', members: ['kacper', 'Cave'] })) }]);
  await assert.rejects(send({ to_user: 'cav', type: 'task', title: 'T' }), (err) => {
    assert.match(err.message, /unknown_recipient/);
    assert.match(err.message, /kacper, Cave/);
    return true;
  });
});

test('4xx: ciało nie-JSON (np. strona z proxy) trafia do komunikatu, przycięte', async () => {
  mockFetch([{ response: errorResponse(413, 'x'.repeat(500)) }]);
  await assert.rejects(pull(), (err) => {
    assert.match(err.message, /413/);
    // Dokładnie MAX_ERROR_BODY_LEN znaków ciała — nie mniej (nie pomijamy treści)
    // i nie więcej (przycięcie działa). Sama długość komunikatu przeszłaby też wtedy,
    // gdyby implementacja ciało całkowicie zignorowała.
    assert.match(err.message, /— x{200}\.$/);
    return true;
  });
});

test('4xx: token z ciała odpowiedzi NIE wycieka do komunikatu', async () => {
  // Proxy po drodze (404/502) rutynowo cytuje ścieżkę żądania, a token siedzi właśnie
  // w ścieżce — surowy przedruk oddałby sekret do logu joba i odpowiedzi skilla.
  mockFetch([{ response: errorResponse(404, `Cannot POST /inbox/v1/${TOKEN}/pull`) }]);
  await assert.rejects(pull(), (err) => {
    assert.ok(!err.message.includes(TOKEN), `token w komunikacie: ${err.message}`);
    assert.match(err.message, /\*\*\*/);
    return true;
  });
});

test('5xx: komunikat po wyczerpaniu retry niesie powód z ciała, nie sam kod', async () => {
  mockFetch([{ response: errorResponse(502, JSON.stringify({ v: 1, error: 'hub_offline' })) }]);
  await assert.rejects(pull(), (err) => {
    assert.match(err.message, /502/);
    assert.match(err.message, /hub_offline/);
    return true;
  });
});

test('4xx: pad odczytu ciała NIE psuje obsługi błędu — zostaje sam kod statusu', async () => {
  // Odczyt ciała jest dodatkiem diagnostycznym; jego awaria nie może zamienić czytelnej
  // odmowy w nieobsłużony wyjątek.
  mockFetch([{ response: { ok: false, status: 403, text: async () => { throw new Error('strumień ucięty'); } } }]);
  await assert.rejects(pull(), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /403/);
    return true;
  });
});

// === Brak konfiguracji: czytelny błąd dla KAŻDEJ metody publicznej ===

const methods = [
  ['ping', () => ping()],
  ['pull', () => pull()],
  ['done', () => done({ id: 'x', action: 'Zrobione' })],
  ['send', () => send({ to_user: 'k', type: 'task', title: 't' })],
  ['claimQuery', () => claimQuery()],
  ['uploadBlob', () => uploadBlob(SHA, '/nieistotne')],
  ['downloadBlob', () => downloadBlob(SHA, '/nieistotne')],
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

// === Operacje binarne: uploadBlob / downloadBlob ===

// Katalog roboczy per-case — testy dotykają PRAWDZIWEGO dysku (zapis strumieniem i rename
// to sedno kontraktu downloadBlob), więc nigdy w drzewie repo ani w vaultcie.
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-client-blob-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Odpowiedź binarna: ciało jako web ReadableStream (dokładnie to, co oddaje fetch).
function binaryResponse(chunks, { breakAfter = null } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (breakAfter) controller.error(new Error(breakAfter));
      else controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

test('uploadBlob: happy path — PUT na /blob/:sha256 z bajtami pliku, zwraca odpowiedź huba', async () => {
  const file = path.join(tmpDir, 'raport.pdf');
  fs.writeFileSync(file, 'zawartość-załącznika');
  const calls = mockFetch([{ response: jsonResponse(200, { v: 1, sha256: SHA, size: 21, deduped: false }) }]);

  const result = await uploadBlob(SHA, file);

  assert.deepEqual(result, { v: 1, sha256: SHA, size: 21, deduped: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${HUB_URL}/inbox/v1/${TOKEN}/blob/${SHA}`);
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/octet-stream');
  // Bajty idą surowo, nie jako JSON — inaczej hub policzyłby inny sha256 niż nadawca.
  assert.equal(Buffer.from(calls[0].opts.body).toString('utf8'), 'zawartość-załącznika');
});

test('uploadBlob: AbortError → PONAWIA i kończy sukcesem (klucz dedup = treść, retry bezpieczny)', async () => {
  const file = path.join(tmpDir, 'zrzut.png');
  fs.writeFileSync(file, 'bajty');
  const calls = mockFetch([
    { throw: abortError() },
    { response: jsonResponse(200, { v: 1, sha256: SHA, size: 5, deduped: true }) },
  ]);

  const result = await uploadBlob(SHA, file);

  assert.equal(result.deduped, true);
  assert.equal(calls.length, 2);
  // Retry wysyła DOKŁADNIE te same bajty — inaczej hub odrzuciłby transfer jako hash_mismatch.
  assert.equal(Buffer.from(calls[1].opts.body).toString('utf8'), 'bajty');
});

test('uploadBlob: używa BINARY_TIMEOUT_MS, nie ciasnego REQUEST_TIMEOUT_MS', async () => {
  const file = path.join(tmpDir, 'duzy.bin');
  fs.writeFileSync(file, 'x');
  mockFetch([{ throw: abortError() }]);

  await assert.rejects(uploadBlob(SHA, file), (err) => {
    assert.match(err.message, /limit czasu 180000 ms/);
    return true;
  });

  // Kontrola różnicowa: ścieżka tekstowa nadal trzyma się swojego, ciasnego limitu.
  mockFetch([{ throw: abortError() }]);
  await assert.rejects(pull(), (err) => {
    assert.match(err.message, /limit czasu 15000 ms/);
    return true;
  });
});

test('uploadBlob: zły sha256 → czytelny błąd, fetch niewywołany', async () => {
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return jsonResponse(200, { v: 1 });
  };
  await assert.rejects(uploadBlob('nie-jest-hashem', '/dowolny'), /64 znakami/);
  assert.equal(fetchCalled, false);
});

test('uploadBlob: nieczytelny plik → czytelny błąd, bez żądania do huba', async () => {
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return jsonResponse(200, { v: 1 });
  };
  await assert.rejects(uploadBlob(SHA, path.join(tmpDir, 'nie-ma-mnie')), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /nie udało się odczytać pliku/);
    return true;
  });
  assert.equal(fetchCalled, false);
});

test('downloadBlob: happy path — zapisuje bajty pod destPath, tworzy brakujący katalog', async () => {
  const dest = path.join(tmpDir, '2026-09', 'raport.pdf');
  const calls = mockFetch([{ response: binaryResponse(['abc', 'def']) }]);

  const result = await downloadBlob(SHA, dest);

  assert.deepEqual(result, { path: dest, size: 6 });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'abcdef');
  assert.equal(calls[0].url, `${HUB_URL}/inbox/v1/${TOKEN}/blob/${SHA}`);
  assert.equal(calls[0].opts.method, 'GET');
});

test('downloadBlob: zerwanie w połowie → brak pliku docelowego i brak śmieci po tymczasowym', async () => {
  const dest = path.join(tmpDir, 'polowiczny.pdf');
  // Oba przebiegi (próba + retry) zrywają — inaczej retry uratowałby pobranie i nie
  // zobaczylibyśmy stanu po awarii.
  mockFetch([{ response: binaryResponse(['pierwsza-polowa'], { breakAfter: 'połączenie zerwane' }) }]);

  await assert.rejects(downloadBlob(SHA, dest), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /nie odpowiada/);
    return true;
  });

  // Kluczowy niezmiennik: w vaultcie nie ma pliku wyglądającego na kompletny…
  assert.equal(fs.existsSync(dest), false);
  // …ani niedokończonego ogona po transferze.
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('downloadBlob: strumień zamilkł po pierwszym chunku → limit czasu i pusty katalog docelowy', async () => {
  const dest = path.join(tmpDir, 'wisi.pdf');
  // Hub/Funnel odsyła 200 i przestaje wysyłać bajty, nie zamykając strumienia. Limit czasu MUSI
  // obejmować transfer, nie tylko nagłówki — inaczej run syncu wisi do twardego timeoutu
  // executora, a w vaultcie zostaje plik .part rozniesiony przez Obsidian Sync.
  const stalled = () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('pierwszy-chunk'));
        // celowo: żadnego close() ani error() — nadawca po prostu milczy
      },
    }),
  });
  mockFetch([{ response: stalled() }, { response: stalled() }]);
  setBinaryTimeoutMs(60);
  try {
    await assert.rejects(downloadBlob(SHA, dest), (err) => {
      assert.ok(err instanceof InboxClientError);
      assert.match(err.message, /limit czasu 60 ms/);
      return true;
    });
  } finally {
    setBinaryTimeoutMs(null);
  }

  assert.equal(fs.existsSync(dest), false);
  // Ani pliku docelowego, ani ogona .part po przerwanym transferze.
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('downloadBlob: niezapisywalny katalog docelowy → błąd o katalogu, nie „przerwany transfer"', async () => {
  const blocked = path.join(tmpDir, 'zablokowany');
  fs.mkdirSync(blocked);
  fs.chmodSync(blocked, 0o500); // brak prawa zapisu — mkdir podkatalogu padnie na EACCES
  const dest = path.join(blocked, 'podkatalog', 'plik.pdf');
  const calls = mockFetch([{ response: binaryResponse(['abc']) }]);

  try {
    await assert.rejects(downloadBlob(SHA, dest), (err) => {
      assert.ok(err instanceof InboxClientError);
      assert.match(err.message, /nie udało się utworzyć katalogu/);
      assert.ok(!/przerwany transfer/.test(err.message));
      return true;
    });
    // Diagnoza praw do katalogu nie jest awarią transportu — żądanie nie poleciało w ogóle.
    assert.equal(calls.length, 0);
  } finally {
    fs.chmodSync(blocked, 0o700);
  }
});

test('downloadBlob: 404 (brak uprawnienia albo brak bajtów) → czytelny błąd bez retry, zero plików', async () => {
  const dest = path.join(tmpDir, 'obcy.pdf');
  const calls = mockFetch([{ response: errorResponse(404, '') }]);

  await assert.rejects(downloadBlob(SHA, dest), (err) => {
    assert.ok(err instanceof InboxClientError);
    assert.match(err.message, /odrzucił żądanie/);
    assert.match(err.message, /404/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(dest), false);
});

test('downloadBlob: token z komunikatu błędu sieci NIE wycieka (undici cytuje pełny URL)', async () => {
  const dest = path.join(tmpDir, 'x.pdf');
  mockFetch([{ throw: new TypeError(`fetch failed: ${HUB_URL}/inbox/v1/${TOKEN}/blob/${SHA}`) }]);

  await assert.rejects(downloadBlob(SHA, dest), (err) => {
    assert.ok(!err.message.includes(TOKEN), `token w komunikacie: ${err.message}`);
    assert.match(err.message, /\*\*\*/);
    return true;
  });
});
