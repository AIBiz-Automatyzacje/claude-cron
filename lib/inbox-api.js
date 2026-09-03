const crypto = require('node:crypto');

const defaultInboxDb = require('./inbox-db');
const defaultBlobs = require('./inbox-blobs');

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

// OSOBNY kubeł minutowy dla operacji binarnych (klucz `<token>:blob`). Wspólny licznik
// wygłodziłby własny sync nadawcy: jedna wiadomość z kilkoma plikami zjadłaby budżet
// tekstowy, a wtedy `pull`/`done` tej samej osoby dostawałyby 429 i Skrzynka zamarzałaby
// na czas transferu. Limit niższy niż tekstowy, bo każde żądanie to megabajty, a nie
// kilobajty: kilka plików per wiadomość + retry mieści się z zapasem, seryjne pompowanie
// dysku huba już nie.
const BLOB_RATE_LIMIT_PER_MIN = 30;

// Twardy limit pojedynczego załącznika (R3). Cap 64 KB akcji tekstowych NIE obowiązuje na
// ścieżce binarnej — tam limitem jest ta stała, egzekwowana W STRUMIENIU (writeBlobFromStream),
// więc przekroczenie kończy transfer, zamiast najpierw zjeść 25 MB pamięci.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Jedyny element ścieżki na dysku pochodzący z sieci — wzorzec musi być wymuszony PRZED
// dotknięciem magazynu (lustro SHA256_PATTERN z lib/inbox-blobs.js).
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// Enumy i limity walidacji na granicy. MESSAGE_TYPES/DONE_ACTIONS zduplikowane z inbox-db
// świadomie (Duplication > Complexity — granica API waliduje niezależnie od warstwy danych;
// muszą zostać spójne z lib/inbox-db.js).
const MESSAGE_TYPES = ['task', 'query', 'reply', 'close'];
const DONE_ACTIONS = ['Zrobione', 'Zapoznane'];
const MAX_ID_LEN = 100;
const MAX_USER_LEN = 100;
const MAX_TITLE_LEN = 500;
const MAX_CONTENT_LEN = 20_000;
// Sufit liczby załączników jednej wiadomości. Nie jest kwotą miejsca (te wycofano) — to
// granica kształtu inputu: bez niej jedno żądanie 64 KB deklaruje tysiące pozycji i każe
// hubowi zrobić tysiące odczytów dysku przed insertem.
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_FILENAME_LEN = 255;
const MAX_MIME_LEN = 255;

// Kody InboxDbError z warstwy danych, które mapujemy na 400 unknown_recipient (adresat
// nie istnieje albo pasuje do wielu członków — z perspektywy klienta to ten sam problem:
// podany nick nie wskazuje jednoznacznie osoby).
const UNKNOWN_RECIPIENT_CODES = ['unknown_recipient', 'ambiguous_recipient'];

// Specyfikacja endpointów: dozwolona metoda HTTP. Nieznana akcja → 404, zła metoda → 405.
const ENDPOINT_METHODS = {
  ping: 'GET',
  pull: 'POST',
  done: 'POST',
  send: 'POST',
  'claim-query': 'POST',
  // Akcji binarnych (blob) tu nie ma: ich metody rozstrzyga authorizeBlobRequest.
};

// Akcje, których ciało NIE jest tekstem. Wydzielone, bo server.js musi je rozgałęzić PRZED
// readTextBody (req.setEncoding('utf8') zamienia chunki w stringi i uszkodziłby bajty),
// a handleInboxRequest musi je odrzucić, gdyby kiedykolwiek do niego trafiły.
const BINARY_ACTIONS = new Set(['blob']);

function isBinaryAction(action) {
  return BINARY_ACTIONS.has(action);
}

// Matcher tokenu+akcji z URL — bliźniak lib/webhook.js z segmentem wersji `v1`.
// Nieznana wersja (/inbox/v2/...) NIE pasuje → null → 404 w server.js (wymaganie twarde #4).
// (?:\?|$) obcina query string. Trzeci segment (parametr akcji — dziś sha256 załącznika) jest OPCJONALNY, ale nadal
// domknięty przez (?:\?|$): czwarty segment nie przechodzi, a nieznana wersja (/inbox/v2/…)
// dalej daje null. Zwraca {token, action, param} (param = null, gdy segmentu nie ma).
const INBOX_URL_PATTERN = /^\/inbox\/v1\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?(?:\?|$)/;

function matchInboxToken(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(INBOX_URL_PATTERN);
  if (!match) return null;
  const param = match[3] ?? null;
  // Trzeci segment należy WYŁĄCZNIE do akcji binarnych. Dla reszty jest nadmiarowy, więc
  // /inbox/v1/<token>/pull/cokolwiek daje null → 404, zamiast wykonywać pełny pull pod
  // nieskończenie wieloma URL-ami (błąd konstrukcji URL po stronie klienta ma się ujawnić).
  if (param !== null && !isBinaryAction(match[2])) return null;
  return { token: match[1], action: match[2], param };
}

// Stan rate-limitu czysto in-memory (wzorzec /ask). ŚWIADOMIE zero agregatów SQL —
// node:sqlite zwraca COUNT/SUM jako BigInt na części buildów (learned pattern).
// Klucz = token; kardynalność mała (liczba członków), restart serwera zeruje okna.
const rateBuckets = new Map();

// Stały kubeł minutowy per token: okno startuje przy 1. żądaniu, po upływie się odnawia.
function isRateLimited(key, now, limit) {
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= limit) return true;
  bucket.count += 1;
  return false;
}

// Klucz kubła binarnego. Tokeny to hex z randomBytes, więc dwukropek nie może pojawić się
// w tokenie i kolizja z kubłem tekstowym jest niemożliwa.
function blobBucketKey(token) {
  return `${token}:blob`;
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

// Kształt typu MIME sprawdzamy JUŻ TUTAJ (nie tylko długość): bez tego 'byle-co' przechodzi
// granicę i dopiero normalizeAttachment (lib/inbox-db.js) rzuca InboxDbError mapowany na ogólne
// invalid_input — nadawca dostaje mylny kod zamiast invalid_attachments. Lustro MIME_PATTERN
// z lib/inbox-db.js (świadomy duplikat przez granicę warstw, jak reguła nazwy pliku).
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

// Nazwa pliku to niezaufane wejście nadawcy (R14): nie wyznacza miejsca zapisu (robi to hash),
// ale trafia do path.join po stronie klienta oraz do renderu Skrzynka.md o kontrakcie LINIOWYM
// (blok `> `, marker `%% id %%`, checkbox). Dlatego odrzucamy tu nie tylko separator ścieżki
// i NUL, ale CAŁY zakres sterujący U+0000–U+001F: nazwa z `\n` pozwoliłaby nadawcy wstrzyknąć
// do pliku odhaczony checkbox, który inbox-push.mjs odczytałby jako akcję człowieka. Znak ':'
// odpada, bo na NTFS otwiera alternatywny strumień danych ("raport.pdf:zly"). Segmenty specjalne
// porównujemy PO obcięciu końcowych kropek i spacji — Win32 obcina je sam, więc ".. " to '..'.
// Lustro tej reguły siedzi w normalizeAttachment (lib/inbox-db.js) — defense-in-depth przez
// granicę warstw; zmieniasz jedną stronę, zmieniasz obie.
const UNSAFE_FILENAME_CHARS = /[/\\:\u0000-\u001f]/;

function isUnsafeFilename(name) {
  if (UNSAFE_FILENAME_CHARS.test(name)) return true;
  const trimmed = name.replace(/[. ]+$/, '');
  return trimmed === '' || trimmed === '.' || trimmed === '..';
}

// Walidacja listy załączników na granicy — pełna, niezależna od warstwy danych (ta waliduje
// powtórnie, defense-in-depth). Po kształcie sprawdzamy ISTNIENIE bajtów NA ŚWIEŻO: między
// uploadem a `send` mija kilkanaście sekund, w których retencja albo rewokacja mogły zadziałać,
// a wiersz wskazujący nieistniejący blob to załącznik, którego nikt nigdy nie pobierze.
// Warunek „to TEN nadawca wgrał te bajty" jest lustrem findAttachmentForUser: bez niego
// znajomość cudzego hasha wystarczyłaby, by podpiąć cudzy plik pod własną wiadomość.
function validateAttachments(list, member, inboxDb, blobs) {
  if (!Array.isArray(list)) return { error: 'invalid_attachments' };
  if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) return { error: 'invalid_attachments' };

  const items = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_attachments' };
    const { sha256, filename, size_bytes: sizeBytes, mime } = raw;
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return { error: 'invalid_attachments' };
    if (!isNonEmptyString(filename, MAX_FILENAME_LEN)) return { error: 'invalid_attachments' };
    if (isUnsafeFilename(filename)) return { error: 'invalid_attachments' };
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ATTACHMENT_BYTES) {
      return { error: 'invalid_attachments' };
    }
    if (mime != null && (!isNonEmptyString(mime, MAX_MIME_LEN) || !MIME_PATTERN.test(mime))) {
      return { error: 'invalid_attachments' };
    }

    if (!blobs.hasBlob(sha256) || !inboxDb.isBlobUploader(sha256, member.name)) {
      return { error: 'unknown_attachment' };
    }
    items.push({ sha256, filename, size_bytes: sizeBytes, mime: mime ?? null });
  }
  return { items };
}

function handleSend(member, body, inboxDb, blobs) {
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
  const attachments = validateAttachments(body.attachments ?? [], member, inboxDb, blobs);
  if (attachments.error) return badRequest(attachments.error);
  let message;
  try {
    message = inboxDb.sendMessage({
      from_user: member.name, // tożsamość z tokenu, nie z body
      to_user: body.to_user,
      type: body.type,
      title: body.title,
      content: body.content ?? null,
      thread_id: body.thread_id ?? null,
      payload: body.payload ?? null,
      attachments: attachments.items,
    });
  } catch (err) {
    // Nieznany/niejednoznaczny adresat to błąd DLA UPRAWNIONEGO klienta (token trafiony),
    // więc odpowiadamy podpowiedzią: listą nicków. Bez niej model wysyłający wiadomość
    // powtarza tę samą literówkę. Sam błąd rozpoznajemy po `code`, nie po treści komunikatu.
    if (err instanceof inboxDb.InboxDbError && UNKNOWN_RECIPIENT_CODES.includes(err.code)) {
      return {
        status: 400,
        json: { v: API_VERSION, error: 'unknown_recipient', members: inboxDb.listMembers().map((m) => m.name) },
      };
    }
    throw err;
  }
  return ok({ message });
}

function handleClaimQuery(member, inboxDb) {
  return ok({ query: inboxDb.claimQuery(member.name) });
}

// === Ścieżka binarna (bajty załącznika) ===

// Decyzja o żądaniu binarnym — TE SAME bramki i ta sama kolejność co w handleInboxRequest
// (token → rate limit → metoda → walidacja parametru), tylko bez ciała: bajty czyta i pisze
// skorupa w server.js, bo czysta funkcja nie może trzymać strumienia. Zwraca albo odmowę
// {status[, json]}, albo zgodę {status:200, op, member, sha256, maxBytes|attachment}.
function authorizeBlobRequest(
  { token, method = 'GET', sha256 },
  { inboxDb = defaultInboxDb, now = Date.now() } = {}
) {
  // 1. Autoryzacja (403 bez szczegółów) — timingSafeEqual po wszystkich tokenach.
  const member = resolveMember(token, inboxDb.listMembers());
  if (!member) return intruder(403);

  // 2. Rate limit z OSOBNEGO kubła binarnego — transfer nie zjada budżetu syncu.
  if (isRateLimited(blobBucketKey(token), now, BLOB_RATE_LIMIT_PER_MIN)) {
    return { status: 429, json: { v: API_VERSION, error: 'rate_limited' } };
  }

  // 3. Metoda: PUT zapisuje, GET odczytuje; cokolwiek innego → 405.
  if (method !== 'PUT' && method !== 'GET') return intruder(405);

  // 4. Parametr ścieżki. Waliduj PRZED oddaniem go magazynowi — to jedyny element ścieżki
  //    na dysku pochodzący z sieci (inbox-blobs waliduje powtórnie, defense-in-depth).
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    return badRequest('invalid_sha256');
  }

  // 5a. Zapis: wolno każdemu członkowi, bo upload POPRZEDZA wiadomość (dwufazowość) —
  //     w chwili PUT żaden wiersz jeszcze nie wskazuje na te bajty, więc nie ma czego pytać
  //     o uczestnictwo. Ryzyko ogranicza limit rozmiaru + kubeł binarny.
  if (method === 'PUT') {
    return { status: 200, op: 'upload', member, sha256, maxBytes: MAX_ATTACHMENT_BYTES };
  }

  // 5b. Odczyt: uprawnieniem jest UCZESTNICTWO w wiadomości, nie znajomość hasha.
  //     Brak uprawnienia i nieistniejący załącznik dają TEN SAM kod 404 — 403 zdradzałby,
  //     że bajty o tym hashu są na hubie (sonda po cudzych plikach).
  const attachment = inboxDb.findAttachmentForUser(sha256, member.name);
  if (!attachment) return intruder(404);
  return { status: 200, op: 'download', member, sha256, attachment };
}

// Mapowanie kodów InboxBlobError na status HTTP — kontrakt trzymamy tutaj, żeby skorupa
// w server.js nie musiała znać semantyki błędów magazynu. Nieznany kod = 400 (błąd żądania),
// bo writeBlobFromStream rzuca InboxBlobError wyłącznie na przerwanym/niezgodnym transferze.
function blobErrorStatus(code) {
  if (code === 'too_large') return 413;
  // Awaria magazynu po stronie huba (brak miejsca, brak praw) NIE jest błędem żądania —
  // klient nie ma czego poprawić, a 400 kazałoby mu porzucić poprawny plik.
  if (code === 'store_failed') return 500;
  return 400;
}

// === Handler główny — czysta funkcja, bramki w kolejności ===
// cap body → autoryzacja → rate limit → routing (akcja/metoda) → walidacja → dispatch.
function handleInboxRequest(
  { token, action, method = 'GET', rawBody = '' },
  { inboxDb = defaultInboxDb, blobs = defaultBlobs, now = Date.now() } = {}
) {
  // 0. Fail-closed: ciało binarne NIGDY nie może trafić w ten handler (rawBody to string
  //    po setEncoding('utf8') — bajty byłyby już uszkodzone). Ścieżkę binarną obsługuje
  //    authorizeBlobRequest + skorupa strumieniowa; misrouting = 404, nie ciche parsowanie.
  if (isBinaryAction(action)) return intruder(404);

  // 1. Cap body (413) — defense-in-depth; server.js ucina już podczas streamowania.
  if (typeof rawBody === 'string' && rawBody.length > MAX_BODY_SIZE) {
    return intruder(413);
  }

  // 2. Autoryzacja (403 bez szczegółów) — timingSafeEqual po wszystkich tokenach.
  const member = resolveMember(token, inboxDb.listMembers());
  if (!member) return intruder(403);

  // 3. Rate limit per token (429).
  if (isRateLimited(token, now, INBOX_RATE_LIMIT_PER_MIN)) {
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
      case 'send': return handleSend(member, body, inboxDb, blobs);
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
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  INBOX_RATE_LIMIT_PER_MIN,
  BLOB_RATE_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
  isBinaryAction,
  authorizeBlobRequest,
  blobErrorStatus,
  MESSAGE_TYPES,
  DONE_ACTIONS,
  matchInboxToken,
  resetInboxApiState,
  handleInboxRequest,
};
