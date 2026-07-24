const crypto = require('node:crypto');

const defaultInboxDb = require('./inbox-db');

// Handler HTTP huba Team OS nad warstwą inbox-db. Publiczne, tokenowe endpointy
// /inbox/v1/:token/<akcja> konsumowane przez klientów przez Tailscale Funnel.
// To warstwa GRANICY BEZPIECZEŃSTWA: waliduj każdy input, nie zdradzaj szczegółów
// intruzom (kody 403/404/405/413 bez treści diagnostycznej — wzorzec /ask).
//
// handleInboxRequest to CZYSTA funkcja przyjmująca {token, action, method, rawBody}
// + wstrzykiwalną zależność inbox-db (testowalność), zwraca {status, json}.
// I/O (czytanie body ze streamu, pisanie odpowiedzi) zostaje cienką skorupą w server.js
// (IU-1.3) — tam też cap body 64 KB podczas streamowania (413 zanim intruz wypompuje
// setki MB → OOM). MAX_BODY_SIZE eksportowane, żeby skorupa i handler dzieliły stałą.

// Wersja kontraktu — pole `v` w KAŻDEJ odpowiedzi JSON (wymaganie twarde #4).
const API_VERSION = 1;

// Cap body — wzorzec readTextBody z /ask. Handler robi też defense-in-depth (413 gdy
// rawBody go przekracza), bo body idzie do parse'a PRZED autoryzacją.
const MAX_BODY_SIZE = 64 * 1024;

// Rate limit per token (wymaganie twarde #3). Rytm systemu: sync pull+push 2–4 req/min
// + auto-reply 2 req/min + retry po timeoutach Funnela ≈ 6 req/min normalnego ruchu.
// 60/min = ~10× zapasu, a wciąż ciasno dla intruza. ŚWIADOMIE NIE kopiujemy 10/min
// z /ask — to by ucięło normalną pracę zespołu.
const INBOX_RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;

// Enumy i limity walidacji na granicy. MESSAGE_TYPES/DONE_ACTIONS zduplikowane z inbox-db
// świadomie (Duplication > Complexity — granica API waliduje niezależnie od warstwy danych;
// muszą zostać spójne z lib/inbox-db.js).
const MESSAGE_TYPES = ['task', 'query', 'reply', 'close'];
const DONE_ACTIONS = ['Zrobione', 'Zapoznane'];
const MAX_ID_LEN = 100;
const MAX_USER_LEN = 100;
const MAX_TITLE_LEN = 500;
const MAX_CONTENT_LEN = 20_000;

// Specyfikacja endpointów: dozwolona metoda HTTP. Nieznana akcja → 404, zła metoda → 405.
const ENDPOINT_METHODS = {
  ping: 'GET',
  pull: 'POST',
  done: 'POST',
  send: 'POST',
  'claim-query': 'POST',
};

// Matcher tokenu+akcji z URL — bliźniak lib/webhook.js z segmentem wersji `v1`.
// Nieznana wersja (/inbox/v2/...) NIE pasuje → null → 404 w server.js (wymaganie twarde #4).
// (?:\?|$) obcina query string. Zwraca {token, action} albo null.
const INBOX_URL_PATTERN = /^\/inbox\/v1\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)(?:\?|$)/;

function matchInboxToken(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(INBOX_URL_PATTERN);
  return match ? { token: match[1], action: match[2] } : null;
}

// Stan rate-limitu czysto in-memory (wzorzec /ask). ŚWIADOMIE zero agregatów SQL —
// node:sqlite zwraca COUNT/SUM jako BigInt na części buildów (learned pattern).
// Klucz = token; kardynalność mała (liczba członków), restart serwera zeruje okna.
const rateBuckets = new Map();

// Stały kubeł minutowy per token: okno startuje przy 1. żądaniu, po upływie się odnawia.
function isRateLimited(token, now) {
  let bucket = rateBuckets.get(token);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(token, bucket);
  }
  if (bucket.count >= INBOX_RATE_LIMIT_PER_MIN) return true;
  bucket.count += 1;
  return false;
}

// Reset stanu dla testów (izolacja między casami) — wzorzec resetAskState.
function resetInboxApiState() {
  rateBuckets.clear();
}

// Porównanie w stałym czasie z guardem długości PRZED timingSafeEqual (rzuca przy różnych
// długościach). Wzorzec verifySecret z /ask.
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || b === '') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Autoryzacja: token z URL porównywany timingSafeEqual przeciwko WSZYSTKIM tokenom członków.
// WSZYSTKIE porównania wykonywane zawsze (brak break) — czas odpowiedzi nie zdradza, czy
// i który token trafiony. Hub wyprowadza tożsamość z trafionego tokenu (klient NIE deklaruje,
// kim jest). Zwraca członka albo null.
function resolveMember(token, members) {
  let matched = null;
  for (const member of members) {
    if (timingSafeEqualStr(token, member.token)) matched = member;
  }
  return matched;
}

// === Walidacja inputów na granicy ===

function isNonEmptyString(value, maxLen) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

// Parsuje rawBody jako JSON (endpointy POST). Zwraca {ok, body} albo {ok:false}.
function parseJsonBody(rawBody) {
  if (!rawBody) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false };
  }
}

// Helper odpowiedzi z polem `v` (wymaganie twarde #4). Kody intruzów (403/404/405/413)
// zwracamy BEZ json — server.js wypisze goły status bez treści.
function ok(json) {
  return { status: 200, json: { v: API_VERSION, ...json } };
}
function badRequest(error) {
  return { status: 400, json: { v: API_VERSION, error } };
}
function intruder(status) {
  return { status };
}

// === Dispatch akcji (po autoryzacji, rate limicie i walidacji routingu) ===

function handlePing(member) {
  return ok({ user: member.name, hub: 'puls' });
}

function handlePull(member, inboxDb) {
  return ok(inboxDb.pullForUser(member.name));
}

function handleDone(member, body, inboxDb) {
  if (!isNonEmptyString(body.id, MAX_ID_LEN)) return badRequest('invalid_id');
  if (!DONE_ACTIONS.includes(body.action)) return badRequest('invalid_action');
  return ok(inboxDb.markDone({ id: body.id, action: body.action, user: member.name }));
}

function handleSend(member, body, inboxDb) {
  if (!isNonEmptyString(body.to_user, MAX_USER_LEN)) return badRequest('invalid_to_user');
  if (!MESSAGE_TYPES.includes(body.type)) return badRequest('invalid_type');
  if (!isNonEmptyString(body.title, MAX_TITLE_LEN)) return badRequest('invalid_title');
  if (body.content != null && !(typeof body.content === 'string' && body.content.length <= MAX_CONTENT_LEN)) {
    return badRequest('invalid_content');
  }
  if (body.thread_id != null && !isNonEmptyString(body.thread_id, MAX_ID_LEN)) {
    return badRequest('invalid_thread_id');
  }
  if (body.payload != null && (typeof body.payload !== 'object' || Array.isArray(body.payload))) {
    return badRequest('invalid_payload');
  }
  const message = inboxDb.sendMessage({
    from_user: member.name, // tożsamość z tokenu, nie z body
    to_user: body.to_user,
    type: body.type,
    title: body.title,
    content: body.content ?? null,
    thread_id: body.thread_id ?? null,
    payload: body.payload ?? null,
  });
  return ok({ message });
}

function handleClaimQuery(member, inboxDb) {
  return ok({ query: inboxDb.claimQuery(member.name) });
}

// === Handler główny — czysta funkcja, bramki w kolejności ===
// cap body → autoryzacja → rate limit → routing (akcja/metoda) → walidacja → dispatch.
function handleInboxRequest(
  { token, action, method = 'GET', rawBody = '' },
  { inboxDb = defaultInboxDb, now = Date.now() } = {}
) {
  // 1. Cap body (413) — defense-in-depth; server.js ucina już podczas streamowania.
  if (typeof rawBody === 'string' && rawBody.length > MAX_BODY_SIZE) {
    return intruder(413);
  }

  // 2. Autoryzacja (403 bez szczegółów) — timingSafeEqual po wszystkich tokenach.
  const member = resolveMember(token, inboxDb.listMembers());
  if (!member) return intruder(403);

  // 3. Rate limit per token (429).
  if (isRateLimited(token, now)) {
    return { status: 429, json: { v: API_VERSION, error: 'rate_limited' } };
  }

  // 4. Routing: nieznana akcja (404), zła metoda (405).
  const expectedMethod = ENDPOINT_METHODS[action];
  if (!expectedMethod) return intruder(404);
  if (method !== expectedMethod) return intruder(405);

  // 5. Body dla endpointów POST (walidacja JSON zanim dotkniemy warstwy danych).
  let body = {};
  if (expectedMethod === 'POST') {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) return badRequest('invalid_json');
    body = parsed.body;
  }

  // 6. Dispatch. InboxDbError (naruszenie kontraktu warstwy danych) → 400; inne błędy
  // propagują do server.js (500) — nie połykamy nieznanych.
  try {
    switch (action) {
      case 'ping': return handlePing(member);
      case 'pull': return handlePull(member, inboxDb);
      case 'done': return handleDone(member, body, inboxDb);
      case 'send': return handleSend(member, body, inboxDb);
      case 'claim-query': return handleClaimQuery(member, inboxDb);
      default: return intruder(404);
    }
  } catch (err) {
    if (err instanceof inboxDb.InboxDbError) return badRequest('invalid_input');
    throw err;
  }
}

module.exports = {
  API_VERSION,
  MAX_BODY_SIZE,
  INBOX_RATE_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
  MESSAGE_TYPES,
  DONE_ACTIONS,
  matchInboxToken,
  resetInboxApiState,
  handleInboxRequest,
};
