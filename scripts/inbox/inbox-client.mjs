// Team OS — klient HTTP huba skrzynki (zastępuje bezpośrednie połączenia `pg`).
// Robi GŁUPIE, bezpieczne żądania do wersjonowanego API `/inbox/v1/:token/*`.
// Retry (1 ponowna próba na timeout/5xx) stosowany TYLKO do akcji idempotentnych
// po stronie huba: pull, done (already_done), claim-query (marker), ping. `send`
// jest wyłączony z retry — `sendMessage` robi goły INSERT ze świeżym randomUUID()
// (lib/inbox-db.js) bez klucza dedup, więc timeout/5xx PO commicie ma nieznany wynik
// i ponowienie zdublowałoby wiadomość/auto-odpowiedź/delegację.
//
// Konfiguracja czytana z process.env W MOMENCIE wywołania (nie przy imporcie modułu):
// env żyjącego procesu bywa nieświeże, a testy nadpisują zmienne per-case
// (learned pattern: stale env w żyjących procesach).

// Wersja kontraktu, której klient oczekuje w polu `v` KAŻDEJ odpowiedzi. Świadomie
// zduplikowana z lib/inbox-api.js (API_VERSION) — to niezależna granica: klient huba
// jest osobnym procesem/pakietem i sam pilnuje driftu wersji (Duplication > Complexity).
const EXPECTED_API_VERSION = 1;

// Timeout pojedynczego żądania (AbortController). Funnel + round-trip HTTP; z zapasem,
// bo rytm skrzynki jest rzadki (sync co 1 min), a fałszywy timeout = niepotrzebny retry.
const REQUEST_TIMEOUT_MS = 15_000;

// 1 próba + 1 retry = 2 (wymaganie: „1 retry na timeout/5xx"). Stosowane wyłącznie do
// akcji idempotentnych — `send` przekazuje `retry:false` (patrz nagłówek modułu).
const MAX_ATTEMPTS = 2;

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
async function fetchWithTimeout(url, { method, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Pojedyncza próba. Rozróżnia awarie RETRYOWALNE (timeout/sieć/5xx → {retryable, message})
// od NIE-retryowalnych (4xx huba, nie-JSON, zła wersja → rzuca InboxClientError natychmiast).
async function attemptRequest({ url, action, method, body }) {
  let res;
  try {
    res = await fetchWithTimeout(url, { method, body });
  } catch (err) {
    const message =
      err && err.name === 'AbortError'
        ? `przekroczono limit czasu ${REQUEST_TIMEOUT_MS} ms`
        : `błąd sieci: ${err && err.message ? err.message : 'nieznany'}`;
    return { retryable: true, message };
  }

  // 5xx — przejściowy błąd huba/Funnela, retry ma sens (API idempotentne).
  if (res.status >= 500) {
    return { retryable: true, message: `hub odpowiedział ${res.status}` };
  }

  // 4xx — trwała odmowa (zły token, walidacja, rate limit). Retry nic nie da.
  if (!res.ok) {
    throw new InboxClientError(`Hub Team OS odrzucił żądanie "${action}" (HTTP ${res.status}).`);
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

// Rdzeń: buduje URL, wykonuje próby z 1 retry na awarie retryowalne, zwraca sparsowany
// obiekt odpowiedzi (z polem `v:1`). NIE dotyka granicy JSON `payload` — hub ją trzyma.
// `retry:false` (dla nieidempotentnego `send`) wymusza pojedynczą próbę — po awarii
// wynik jest nieznany, więc czytelny błąd zamiast ryzyka duplikatu.
async function request(action, { method, body, retry = true } = {}) {
  const { baseUrl, token } = readConfig();
  const url = `${baseUrl}/inbox/v1/${encodeURIComponent(token)}/${action}`;

  const maxAttempts = retry ? MAX_ATTEMPTS : 1;
  let lastMessage = 'brak odpowiedzi';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await attemptRequest({ url, action, method, body });
    if ('data' in result) return result.data;
    lastMessage = result.message;
  }

  throw new InboxClientError(
    `Hub Team OS nie odpowiada dla akcji "${action}" (${lastMessage}). ` +
      'Sprawdź połączenie z hubem i spróbuj ponownie.'
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
export async function send({ thread_id, to_user, type, title, content, payload } = {}) {
  if (!to_user) throw new InboxClientError('send: wymagane pole "to_user".');
  if (!type) throw new InboxClientError('send: wymagane pole "type".');
  if (!title) throw new InboxClientError('send: wymagane pole "title".');

  const body = { to_user, type, title };
  // Pola opcjonalne dokładamy tylko gdy podane — nie zaśmiecamy body nullami.
  if (thread_id != null) body.thread_id = thread_id;
  if (content != null) body.content = content;
  if (payload != null) body.payload = payload;

  return request('send', { method: 'POST', body, retry: false });
}

// POST /claim-query — atomowy claim jednego query albo {v:1, query:null}.
export function claimQuery() {
  return request('claim-query', { method: 'POST' });
}
