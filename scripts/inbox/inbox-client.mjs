// Team OS — klient HTTP huba skrzynki (zastępuje bezpośrednie połączenia `pg`).
// Robi GŁUPIE, bezpieczne żądania do wersjonowanego API `/inbox/v1/:token/*`.
// Retry (1 ponowna próba na timeout/5xx) stosowany TYLKO do akcji idempotentnych
// po stronie huba: pull, done (already_done), claim-query (marker), ping. `send`
// jest wyłączony z retry — `sendMessage` robi goły INSERT ze świeżym randomUUID()
// (lib/inbox-db.js) bez klucza dedup, więc timeout/5xx PO commicie ma nieznany wynik
// i ponowienie zdublowałoby wiadomość/auto-odpowiedź/delegację.
//
// Operacje binarne (`uploadBlob`/`downloadBlob`) są wyjątkiem od reguły „send bez retry":
// bajty są adresowane TREŚCIĄ (`/blob/:sha256`), więc klucz deduplikacji niesie samo żądanie —
// powtórzenie po timeoucie trafia w istniejący blob i kończy się sukcesem bez skutków ubocznych.
//
// Konfiguracja czytana z process.env W MOMENCIE wywołania (nie przy imporcie modułu):
// env żyjącego procesu bywa nieświeże, a testy nadpisują zmienne per-case
// (learned pattern: stale env w żyjących procesach).

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Wersja kontraktu, której klient oczekuje w polu `v` KAŻDEJ odpowiedzi. Świadomie
// zduplikowana z lib/inbox-api.js (API_VERSION) — to niezależna granica: klient huba
// jest osobnym procesem/pakietem i sam pilnuje driftu wersji (Duplication > Complexity).
const EXPECTED_API_VERSION = 1;

// Timeout pojedynczego żądania (AbortController). Funnel + round-trip HTTP; z zapasem,
// bo rytm skrzynki jest rzadki (sync co 1 min), a fałszywy timeout = niepotrzebny retry.
const REQUEST_TIMEOUT_MS = 15_000;

// Osobny limit dla transferu bajtów. Ciasnota REQUEST_TIMEOUT_MS jest celowa dla pull/done
// (rzadki rytm, fałszywy timeout = niepotrzebny retry), ale zabójcza dla załącznika: zmierzone
// 17 s przez Funnel to JEDEN przebieg na łączu stacjonarnym, nie górna granica — ten sam plik
// przy 300 kB/s to ~87 s. Próg liczony od najgorszego realnego łącza, nie od pomiaru.
const BINARY_TIMEOUT_MS = 180_000;

// Lustro SHA256_PATTERN z lib/inbox-blobs.js — hash trafia do ŚCIEŻKI URL-a i do nazwy pliku
// tymczasowego, więc walidujemy go po naszej stronie, zanim cokolwiek go użyje (hub waliduje
// powtórnie; defense-in-depth). Świadomy duplikat przez granicę pakietu, jak EXPECTED_API_VERSION.
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// 1 próba + 1 retry = 2 (wymaganie: „1 retry na timeout/5xx"). Stosowane wyłącznie do
// akcji idempotentnych — `send` przekazuje `retry:false` (patrz nagłówek modułu).
const MAX_ATTEMPTS = 2;
// Cap na surowe ciało błędu w komunikacie — proxy potrafi odesłać stronę HTML, a komunikat
// ma zmieścić się w jednej linii logu/odpowiedzi skilla.
const MAX_ERROR_BODY_LEN = 200;

// Typowany błąd klienta — czytelny komunikat dla operatora zamiast kryptycznego fetch-error.
export class InboxClientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxClientError';
  }
}

// Konfiguracja z env — fail-fast z czytelnym komunikatem (nie kryptyczny „fetch failed").
// Zwraca bazę bez końcowych ukośników + token. Czytane przy KAŻDYM żądaniu.
function readConfig() {
  const baseUrl = process.env.INBOX_HUB_URL;
  const token = process.env.INBOX_TOKEN;
  if (!baseUrl) {
    throw new InboxClientError(
      'Brak konfiguracji INBOX_HUB_URL — wklej kod zaproszenia do skrzynki zespołowej (setup.mjs).'
    );
  }
  if (!token) {
    throw new InboxClientError(
      'Brak konfiguracji INBOX_TOKEN — wklej kod zaproszenia do skrzynki zespołowej (setup.mjs).'
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

// Weryfikacja pola `v` w odpowiedzi — mismatch = drift wersji hub vs klient.
function assertVersion(data, action) {
  if (!data || typeof data !== 'object' || data.v !== EXPECTED_API_VERSION) {
    const received = data && typeof data === 'object' && 'v' in data ? data.v : 'brak';
    throw new InboxClientError(
      `Niezgodna wersja API huba Team OS dla akcji "${action}" ` +
        `(oczekiwano v:${EXPECTED_API_VERSION}, otrzymano v:${received}). Zaktualizuj Pulsa.`
    );
  }
}

// Jedno żądanie z twardym timeoutem. Zwraca surową odpowiedź fetch albo rzuca (AbortError
// przy timeout, TypeError przy błędzie sieci). Timer ZAWSZE czyszczony w finally.
// `body`/`headers` przychodzą GOTOWE — serializację JSON robi wywołujący, bo ścieżka binarna
// wysyła surowe bajty, a nie obiekt.
async function fetchWithTimeout(url, { method, body, headers, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, signal: controller.signal, headers, body });
  } finally {
    clearTimeout(timer);
  }
}

// Opis awarii transportu (timeout / błąd sieci) dla człowieka. Redakcja tokenu jest tu
// obowiązkowa: undici osadza PEŁNY URL w `cause`/`message` błędu sieciowego, a token siedzi
// w ścieżce (`/inbox/v1/:token/...`) — surowy przedruk wysypałby sekret do logu joba.
function describeFetchFailure(err, token, timeoutMs) {
  if (err && err.name === 'AbortError') return `przekroczono limit czasu ${timeoutMs} ms`;
  const reason = err && err.message ? err.message : 'nieznany';
  return `błąd sieci: ${redactToken(reason, token)}`;
}

// Pojedyncza próba. Rozróżnia awarie RETRYOWALNE (timeout/sieć/5xx → {retryable, message})
// od NIE-retryowalnych (4xx huba, nie-JSON, zła wersja → rzuca InboxClientError natychmiast).
async function attemptRequest({ url, action, method, body, headers, token, timeoutMs = REQUEST_TIMEOUT_MS }) {
  let res;
  try {
    res = await fetchWithTimeout(url, { method, body, headers, timeoutMs });
  } catch (err) {
    return { retryable: true, message: describeFetchFailure(err, token, timeoutMs) };
  }

  // Ciało odpowiedzi MUSI trafić do komunikatu: hub przy nieznanym adresacie odsyła
  // `{error:'unknown_recipient', members:[…]}`, czyli gotową podpowiedź „chciałeś kogoś z tych".
  // Gołe „HTTP 400" kazało człowiekowi zgadywać, jaki nick jest poprawny — sygnał porażki był,
  // ale bez treści (T11B, 06.08). Odczyt ciała nie może wywrócić obsługi błędu, więc pad
  // parsowania i puste ciało schodzą cicho do samego kodu statusu.
  //
  // Opis budujemy PRZED rozgałęzieniem 5xx/4xx — powód odmowy jest tak samo potrzebny, gdy
  // hub zwraca 502 (np. proxy Funnela mówiące, czego nie umie), a retry nic mu nie odbiera.
  if (!res.ok) {
    const details = await describeErrorBody(res, token);

    // 5xx — przejściowy błąd huba/Funnela, retry ma sens (API idempotentne).
    if (res.status >= 500) {
      return { retryable: true, message: `hub odpowiedział ${res.status}${details}` };
    }

    // 4xx — trwała odmowa (zły token, walidacja, rate limit). Retry nic nie da.
    throw new InboxClientError(`Hub Team OS odrzucił żądanie "${action}" (HTTP ${res.status})${details}.`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new InboxClientError(
      `Hub Team OS zwrócił odpowiedź, której nie da się sparsować jako JSON (akcja "${action}").`
    );
  }
  assertVersion(data, action);
  return { data };
}

// Usuwa token z tekstu przeznaczonego dla człowieka. Świadomy bliźniak `redactToken`
// z onboard.mjs — ten moduł jest self-contained (istnieje jego kopia w vaulcie), więc
// import przez granicę pakietu jest droższy niż trzy linijki (Duplication > Complexity).
function redactToken(text, token) {
  return token ? String(text).split(token).join('***') : String(text);
}

// Dopisek do komunikatu błędu złożony z ciała odpowiedzi huba. Zwraca pusty string,
// gdy nie ma czego powiedzieć — wywołujący skleja go bezwarunkowo.
// `members` rozwijamy do listy nicków, bo to jedyna informacja, która pozwala poprawić
// literówkę bez zaglądania do dashboardu.
//
// Ciało jest NIEZAUFANE: przy 404/502 nie odpowiada nasz hub, tylko proxy po drodze, a te
// rutynowo cytują ścieżkę żądania — w której siedzi token (`/inbox/v1/:token/pull`). Bez
// redakcji komunikat wysypałby sekret do logu joba i do odpowiedzi skilla.
async function describeErrorBody(res, token) {
  let raw;
  try {
    raw = await res.text();
  } catch {
    return '';
  }
  if (!raw) return '';

  try {
    const body = JSON.parse(raw);
    const parts = [];
    if (body.error) parts.push(String(body.error));
    if (Array.isArray(body.members) && body.members.length > 0) {
      parts.push(`znani członkowie: ${body.members.join(', ')}`);
    }
    // JSON bez znanych pól: nasz hub ZAWSZE odsyła `error` przy odmowie (lib/inbox-api.js),
    // więc surowy dump cudzego JSON-a nic nie wnosi poza szumem.
    return parts.length > 0 ? redactToken(` — ${parts.join('; ')}`, token) : '';
  } catch {
    // Nie-JSON (np. strona HTML z proxy) — pokaż surowo, przycięte. Redakcja PRZED
    // przycięciem: cięcie w połowie tokenu zostawiłoby w komunikacie jego początek.
    return ` — ${redactToken(raw, token).slice(0, MAX_ERROR_BODY_LEN)}`;
  }
}

// Rdzeń: buduje URL, wykonuje próby z 1 retry na awarie retryowalne, zwraca sparsowany
// obiekt odpowiedzi (z polem `v:1`). NIE dotyka granicy JSON `payload` — hub ją trzyma.
// `retry:false` (dla nieidempotentnego `send`) wymusza pojedynczą próbę — po awarii
// wynik jest nieznany, więc czytelny błąd zamiast ryzyka duplikatu.
async function runWithRetry(action, attempt, retry) {
  const maxAttempts = retry ? MAX_ATTEMPTS : 1;
  let lastMessage = 'brak odpowiedzi';
  for (let i = 1; i <= maxAttempts; i += 1) {
    const result = await attempt();
    if ('data' in result) return result.data;
    lastMessage = result.message;
  }

  throw new InboxClientError(
    `Hub Team OS nie odpowiada dla akcji "${action}" (${lastMessage}). ` +
      'Sprawdź połączenie z hubem i spróbuj ponownie.'
  );
}

// Buduje URL akcji huba. Jedno miejsce, bo ścieżka niesie token — i to ona jest powodem,
// dla którego każdy komunikat błędu przechodzi przez `redactToken`.
function actionUrl(baseUrl, token, ...segments) {
  return `${baseUrl}/inbox/v1/${encodeURIComponent(token)}/${segments.join('/')}`;
}

async function request(action, { method, body, retry = true } = {}) {
  const { baseUrl, token } = readConfig();
  const url = actionUrl(baseUrl, token, action);
  const headers = body === undefined ? undefined : { 'Content-Type': 'application/json' };
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return runWithRetry(
    action,
    () => attemptRequest({ url, action, method, body: payload, headers, token }),
    retry
  );
}

// === Metody klienta odwzorowujące endpointy huba ===

// GET /ping — probe kodu zaproszenia. Zwraca {v:1, user, hub:'puls'}.
export function ping() {
  return request('ping', { method: 'GET' });
}

// POST /pull — wątki dla członka (oznacza pending→delivered). `payload` pozostaje obiektem.
export function pull() {
  return request('pull', { method: 'POST' });
}

// POST /done — odhaczenie wiadomości. Idempotentne po stronie huba (już done → already_done).
// async: walidacja wejścia rzuca jako ODRZUCONY promise (spójny kontrakt — wszystkie metody
// zwracają promise, nigdy nie rzucają synchronicznie).
export async function done({ id, action } = {}) {
  if (!id) throw new InboxClientError('done: wymagane pole "id".');
  if (!action) throw new InboxClientError('done: wymagane pole "action".');
  return request('done', { method: 'POST', body: { id, action } });
}

// POST /send — wysłanie/delegowanie wiadomości. `from_user` hub wyprowadza z tokenu.
// async: patrz `done` — spójny kontrakt promise'owy również przy walidacji wejścia.
// `retry:false` — nieidempotentny INSERT bez klucza dedup (patrz nagłówek modułu):
// ponowienie po timeout/5xx-po-commicie zdublowałoby wiadomość.
export async function send({ thread_id, to_user, type, title, content, payload, attachments } = {}) {
  if (!to_user) throw new InboxClientError('send: wymagane pole "to_user".');
  if (!type) throw new InboxClientError('send: wymagane pole "type".');
  if (!title) throw new InboxClientError('send: wymagane pole "title".');
  if (attachments != null && !Array.isArray(attachments)) {
    throw new InboxClientError('send: "attachments" musi być tablicą metadanych.');
  }

  const body = { to_user, type, title };
  // Pola opcjonalne dokładamy tylko gdy podane — nie zaśmiecamy body nullami.
  if (thread_id != null) body.thread_id = thread_id;
  if (content != null) body.content = content;
  if (payload != null) body.payload = payload;
  // Metadane załączników; bajty poszły wcześniej przez uploadBlob (upload dwufazowy).
  if (attachments != null && attachments.length > 0) body.attachments = attachments;

  return request('send', { method: 'POST', body, retry: false });
}

// POST /claim-query — atomowy claim jednego query albo {v:1, query:null}.
export function claimQuery() {
  return request('claim-query', { method: 'POST' });
}

// === Operacje binarne (bajty załączników) ===

// Walidacja hasha PRZED użyciem go w ścieżce URL-a i w nazwie pliku tymczasowego.
// Fail-fast po naszej stronie, żeby śmieć nie przeszedł przez sieć ani przez path.join.
function assertSha256(sha256, method) {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new InboxClientError(`${method}: "sha256" musi być 64 znakami [a-f0-9].`);
  }
}

// Sprzątanie pliku tymczasowego. Idempotentne i nigdy nie rzuca — biegnie na ścieżce błędu,
// gdzie prawdziwą przyczyną jest zerwany transfer, nie nieudany unlink (wzorzec inbox-blobs).
async function removeTempFile(file) {
  try {
    await unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[inbox-client] nie udało się skasować pliku tymczasowego ${file}: ${err.message}`);
    }
  }
}

// PUT /blob/:sha256 — wysłanie bajtów załącznika. RETRYUJE, w odróżnieniu od `send`:
// żądanie jest adresowane treścią, więc ponowienie po timeoucie trafia w istniejący blob
// (hub odsyła `deduped:true`) i nie ma szans zdublować niczego.
//
// Bajty wczytujemy do pamięci RAZ, a nie strumieniem: (a) retry musi wysłać DOKŁADNIE te same
// bajty, a zużytego strumienia nie da się odtworzyć, (b) Content-Length pozwala hubowi odmówić
// za dużemu plikowi PRZED transferem. Sufit 25 MB jest znany i sprawdzany przed wywołaniem,
// więc koszt pamięciowy jest ograniczony z góry.
export async function uploadBlob(sha256, filePath) {
  assertSha256(sha256, 'uploadBlob');
  if (!filePath) throw new InboxClientError('uploadBlob: wymagana ścieżka pliku.');

  const { baseUrl, token } = readConfig();
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    throw new InboxClientError(`uploadBlob: nie udało się odczytać pliku ${filePath} (${err.message}).`);
  }

  const url = actionUrl(baseUrl, token, 'blob', sha256);
  return runWithRetry(
    'blob upload',
    () =>
      attemptRequest({
        url,
        action: 'blob upload',
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
        token,
        timeoutMs: BINARY_TIMEOUT_MS,
      }),
    true
  );
}

// Jedna próba pobrania. Odpowiedź jest BINARNA, więc kontraktem nie jest pole `v` (assertVersion
// nie ma tu zastosowania), tylko status i strumień bajtów. Zapis idzie do pliku tymczasowego
// obok celu, a `rename` (atomowy w obrębie FS) następuje dopiero po pełnym transferze — przerwane
// pobranie nie zostawia w vaultcie pliku wyglądającego na kompletny.
async function attemptBlobDownload({ url, action, token, destPath }) {
  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'GET', timeoutMs: BINARY_TIMEOUT_MS });
  } catch (err) {
    return { retryable: true, message: describeFetchFailure(err, token, BINARY_TIMEOUT_MS) };
  }

  if (!res.ok) {
    const details = await describeErrorBody(res, token);
    if (res.status >= 500) {
      return { retryable: true, message: `hub odpowiedział ${res.status}${details}` };
    }
    throw new InboxClientError(`Hub Team OS odrzucił żądanie "${action}" (HTTP ${res.status})${details}.`);
  }

  const tmpFile = path.join(path.dirname(destPath), `.${path.basename(destPath)}.${randomUUID()}.part`);
  try {
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpFile));
  } catch (err) {
    // Zerwanie w połowie jest RETRYOWALNE (GET nie ma skutków ubocznych), ale plik tymczasowy
    // ginie tu i teraz — sprzątanie nie może czekać na kolejną próbę ani na sukces.
    await removeTempFile(tmpFile);
    return { retryable: true, message: `przerwany transfer: ${redactToken(err.message, token)}` };
  }

  try {
    await rename(tmpFile, destPath);
  } catch (err) {
    // Pad finalizacji (brak praw, EXDEV) nie jest awarią transportu — ponowienie pobrania
    // niczego nie naprawi, więc czytelny błąd zamiast cichego retry.
    await removeTempFile(tmpFile);
    throw new InboxClientError(`downloadBlob: nie udało się zapisać pliku ${destPath} (${err.message}).`);
  }

  const { size } = await stat(destPath);
  return { data: { path: destPath, size } };
}

// GET /blob/:sha256 — pobranie bajtów załącznika do `destPath`. Idempotentne, więc retryuje.
// Zwraca { path, size }.
export async function downloadBlob(sha256, destPath) {
  assertSha256(sha256, 'downloadBlob');
  if (!destPath) throw new InboxClientError('downloadBlob: wymagana ścieżka docelowa.');

  const { baseUrl, token } = readConfig();
  const url = actionUrl(baseUrl, token, 'blob', sha256);
  return runWithRetry(
    'blob download',
    () => attemptBlobDownload({ url, action: 'blob download', token, destPath }),
    true
  );
}
