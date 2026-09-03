const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { INBOX_DB_PATH, DATA_DIR } = require('./config');
const { assertValidSha256, hasBlob, deleteBlob, blobPath } = require('./inbox-blobs');

// Warstwa SQLite huba Team OS (data/inbox.db). JEDYNE miejsce, gdzie payload jest
// serializowany/deserializowany (granica JSON) — powyżej tej warstwy payload jest
// zawsze OBIEKTEM. Idempotencja i atomowość skrzynki (markDone, claimQuery) siedzą
// tutaj, więc klienci robią głupie żądania i mogą bezpiecznie retryować.

const MESSAGE_TYPES = ['task', 'query', 'reply', 'close'];
const DONE_ACTIONS = ['Zrobione', 'Zapoznane'];

let inboxDb;
let dbPathOverride = null;

// Typed error dla naruszeń kontraktu wejścia (brak pola, zły type/action, duplikat
// członka) — odróżnialny od błędów SQLite, żeby warstwa API mogła mapować na kody HTTP.
class InboxDbError extends Error {
  // `code` pozwala warstwie API rozróżnić powód bez parsowania komunikatu (komunikaty
  // zmieniają się przy korektach językowych) — np. 'unknown_recipient' → 400 z listą członków.
  constructor(message, code = null) {
    super(message);
    this.name = 'InboxDbError';
    this.code = code;
  }
}

// Typed error dla smoke-testu typów agregatów (pułapka BigInt node:sqlite) — sygnalizuje
// niekompatybilny build/wersję runtime, nie błąd danych.
class InboxDbTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxDbTypeError';
  }
}

// Wstrzyknięcie ścieżki bazy dla izolacji testów (np. ':memory:'). Wzorzec db.setDbPath.
function setInboxDbPath(testPath) {
  dbPathOverride = testPath;
}

function getInboxDb() {
  if (inboxDb) return inboxDb;

  const target = dbPathOverride || INBOX_DB_PATH;
  if (target !== ':memory:') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  // Połączenie przypisujemy do modułu DOPIERO po udanej migracji i smoke-teście — inaczej
  // fail-fast (np. kolizja nazw członków) zostawiłby częściowo zmigrowaną bazę jako "gotową".
  const conn = new DatabaseSync(target);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  // Ta sama pułapka co w db.js: bez busy_timeout rywalizacja o zapis = natychmiastowy
  // crash na ERR_SQLITE_ERROR (incydent N4 07.08). 5 s czekania, potem błąd wraca.
  conn.exec('PRAGMA busy_timeout = 5000');

  migrate(conn);
  assertInboxDbReturnsNumbers(conn);
  inboxDb = conn;
  return inboxDb;
}

// Idempotentne migracje (CREATE TABLE IF NOT EXISTS — idempotentne z natury).
// thread_id ustawiamy = id dla wiadomości-roota (patrz sendMessage), więc jest NOT NULL —
// eliminuje rozgałęzianie COALESCE(thread_id, id) w zapytaniach. created_at/updated_at to
// ISO stringi ustawiane W KODZIE (nie trigger — spójnie z konwencją projektu, patrz db.js).
function migrate(db, warn = console.warn) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id         TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      from_user  TEXT NOT NULL,
      to_user    TEXT NOT NULL,
      type       TEXT NOT NULL CHECK (type IN ('task', 'query', 'reply', 'close')),
      title      TEXT NOT NULL,
      content    TEXT,
      payload    TEXT,
      status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'done')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    ${membersTableDdl('members')}

    -- Metadane załączników. Bajty leżą POZA bazą, adresowane treścią
    -- (data/inbox-blobs/<aa>/<sha256>), więc ten sam plik wysłany dwa razy to jeden blob
    -- i dwa wiersze — stąd indeks po sha256 (countBlobRefs decyduje, czy wolno skasować blob).
    -- Kolejność wstawienia odtwarzamy po rowid: id jest UUID-em, więc sam nie sortuje.
    CREATE TABLE IF NOT EXISTS inbox_attachments (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES inbox(id),
      filename   TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime       TEXT,
      sha256     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Kto REALNIE wgrał bajty o danym sha256 (ścieżka PUT, po weryfikacji sumy). Bez tego
    -- śladu uprawnieniem do cudzego pliku byłaby sama znajomość hasha: hash wycieka do
    -- renderu Skrzynki i archiwum, a obcy członek wysyłał wiadomość SAM DO SIEBIE z tym
    -- sha256 i stawał się stroną wiadomości wskazującej cudze bajty (patrz
    -- findAttachmentForUser). Klucz złożony, bo tę samą treść może legalnie wgrać wiele osób.
    CREATE TABLE IF NOT EXISTS inbox_blob_uploads (
      sha256      TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (sha256, uploaded_by)
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_to_status ON inbox(to_user, status);
    CREATE INDEX IF NOT EXISTS idx_inbox_thread    ON inbox(thread_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_message ON inbox_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_sha256  ON inbox_attachments(sha256);
  `);

  // Ślad „bajty tego wiersza już zwolniłem". Bez niego wygasły wiersz metadanych (a te
  // zostają na zawsze, żeby render pokazał trzeci stan „wygasł") wracałby do retencji przy
  // KAŻDYM przemiataniu i co godzinę wołał unlink na nieistniejącym pliku — a po ponownym
  // wgraniu tej samej treści kasowałby świeże bajty. ALTER w try/catch: migrate() leci co
  // boot, więc druga próba dodania kolumny musi być bezgłośna (wzorzec migracji w db.js).
  try {
    db.exec('ALTER TABLE inbox_attachments ADD COLUMN bytes_deleted_at TEXT');
  } catch (err) {
    // Jedyny oczekiwany powód to kolumna już dodana w poprzednim boocie. Każdy inny błąd
    // (uszkodzona baza, brak tabeli) przepuszczamy dalej — cicho połknięty znaczyłby
    // schemat bez `bytes_deleted_at` i retencję kasującą te same bajty co godzinę.
    if (!/duplicate column name/i.test(err.message)) throw err;
  }

  if (needsMembersNocaseRebuild(db)) {
    tryRebuildMembersWithNocase(db, warn);
  }
}

// Kolizja nazw NIE MOŻE zabić huba. migrate() biegnie w getInboxDb() przy KAŻDEJ operacji,
// więc rzucenie stąd czyniło martwą całą skrzynkę — także listMembers/revokeMember
// i `/api/inbox/members`, czyli jedyne LEKARSTWO na tę kolizję (500 na każdym żądaniu).
// Degradacja: zostawiamy schemat legacy, krzyczymy w logu gotowym poleceniem i lecimy dalej.
// Bezpieczeństwo trzyma resolveRecipient — kolidująca para daje `ambiguous_recipient`,
// więc żadna wiadomość nie trafi do niewłaściwej osoby; blokowana jest wyłącznie ta nazwa,
// a nie cały zespół. Po rozstrzygnięciu duplikatu migracja domknie się przy kolejnym starcie.
function tryRebuildMembersWithNocase(db, warn = console.warn) {
  try {
    rebuildMembersWithNocase(db);
  } catch (err) {
    if (!(err instanceof InboxDbError) || err.code !== 'members_nocase_collision') throw err;
    warn(`[inbox-db] ${err.message}`);
  }
}

// members.name z COLLATE NOCASE: literówka w wielkości liter ("cave" zamiast "Cave") nie może
// być cichą utratą wiadomości — kolacja pilnuje tego również na indeksie UNIQUE (indeks
// dziedziczy kolację kolumny), więc dwóch członków różniących się tylko wielkością liter
// nie da się już założyć.
function membersTableDdl(tableName) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );`;
}

// SQLite nie zmienia kolacji kolumny przez ALTER — jedyna droga to przepisanie tabeli.
// Guard po FAKTYCZNYM schemacie (sqlite_master.sql), nie po sentinelu: migrate() leci przy
// każdym boocie, a ślepy rebuild przepisywałby tabelę w kółko. PRAGMA table_info NIE zdradza
// kolacji, dlatego czytamy DDL.
function needsMembersNocaseRebuild(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'").get();
  if (!row || !row.sql) return false; // tabeli brak — CREATE wyżej zakłada ją już z NOCASE
  return !/COLLATE\s+NOCASE/i.test(row.sql);
}

// Przepisanie tabeli members na kolację NOCASE. Kolizja istniejących nazw ("Cave" + "cave")
// = przerwanie migracji z obiema nazwami i ZERO zmian w danych — ciche scalenie oddałoby
// cudze wiadomości nie tej osobie. Duplikaty wykrywamy w JS, nie agregatem SQL (BigInt).
// Rzucony błąd łapie tryRebuildMembersWithNocase — komunikat trafia do CZŁOWIEKA
// (log daemona), więc musi być wykonywalny bez czytania kodu: nazwy + dwie drogi wyjścia.
function rebuildMembersWithNocase(db) {
  // Kolizje wykrywamy TĄ SAMĄ kolacją, którą zaraz nałożymy na kolumnę — inaczej migracja
  // przerywa się na parze, której UNIQUE NOCASE wcale by nie odrzucił („Łukasz"/„łukasz"
  // składa się w JS, ale nie w SQLite), i skrzynka zostaje na starym schemacie bez powodu.
  // JOIN po `a.id < b.id` daje każdą parę raz; świadomie bez agregatu (pułapka BigInt).
  const collisions = db
    .prepare(
      `SELECT a.name AS first, b.name AS second
         FROM members a JOIN members b ON b.name = a.name COLLATE NOCASE AND a.id < b.id
        ORDER BY a.id, b.id`
    )
    .all()
    .map((r) => `"${r.first}" + "${r.second}"`);
  if (collisions.length > 0) {
    throw new InboxDbError(
      `migrate: nie mogę włączyć COLLATE NOCASE na members.name — nazwy różniące się tylko ` +
        `wielkością liter: ${collisions.join(', ')}. Skrzynka działa dalej na starym schemacie, ` +
        `ale wysyłka do tych nazw jest odrzucana (ambiguous_recipient), dopóki duplikat istnieje. ` +
        `Rozstrzygnij: usuń zbędnego członka w dashboardzie (Skrzynka → Członkowie) albo poleceniem ` +
        `sqlite3 data/inbox.db "SELECT id, name FROM members;" a następnie ` +
        `sqlite3 data/inbox.db "DELETE FROM members WHERE id = <id>;" — po tym zrestartuj Pulsa, ` +
        `żeby migracja się domknęła.`,
      'members_nocase_collision'
    );
  }

  db.exec('BEGIN');
  try {
    db.exec(`
      ${membersTableDdl('members_nocase_tmp')}
      INSERT INTO members_nocase_tmp (id, name, token, created_at)
        SELECT id, name, token, created_at FROM members;
      DROP TABLE members;
      ALTER TABLE members_nocase_tmp RENAME TO members;
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Smoke-test typów po migrate(): trywialny agregat MUSI zwrócić number. Niektóre buildy
// node:sqlite zwracały COUNT(*) jako BigInt — wtedy cała arytmetyka i serializacja JSON
// cicho się psuje. Fail-fast z czytelnym komunikatem zamiast tajemniczych błędów w runtime.
function assertInboxDbReturnsNumbers(conn) {
  // Obie tabele z agregatami używanymi w logice: inbox (kontrakt historyczny) oraz
  // inbox_attachments (countBlobRefs decyduje o skasowaniu blobu — BigInt zamiast number
  // cicho fałszowałby porównanie `=== 0` i kasował bajty wciąż używane przez inną wiadomość).
  for (const table of ['inbox', 'inbox_attachments']) {
    const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (typeof row.n !== 'number') {
      throw new InboxDbTypeError(
        `[inbox-db smoke-test] node:sqlite zwraca agregat jako "${typeof row.n}" zamiast "number" ` +
          `(COUNT(*) z ${table} → ${String(row.n)}). Niekompatybilny build Node — zaktualizuj runtime.`
      );
    }
  }
}

// === Granica JSON (jedyne miejsce parse/stringify payloadu) ===

// Deserializuje wiersz DB do zwykłego obiektu z payloadem jako OBIEKT (nie string).
// node:sqlite zwraca wiersze z null-prototype — spread normalizuje do plain object,
// żeby konsumenci (deepEqual w testach, JSON.stringify) nie zależeli od tego detalu.
function parseRow(row) {
  if (!row) return null;
  return { ...row, payload: row.payload == null ? null : JSON.parse(row.payload) };
}

function serializePayload(payload) {
  return payload == null ? null : JSON.stringify(payload);
}

// === Helpers ===

function getMessage(id) {
  return parseRow(getInboxDb().prepare('SELECT * FROM inbox WHERE id = ?').get(id));
}

// Cała nitka wątku chronologicznie. rowid jako tiebreak — created_at (ISO) sortuje
// poprawnie, ale wiadomości z tej samej milisekundy potrzebują deterministycznej kolejności.
function getThread(threadId) {
  return getInboxDb()
    .prepare('SELECT * FROM inbox WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(threadId)
    .map(parseRow);
}

// === Message operations ===

// Dopasowanie adresata do listy członków bez względu na wielkość liter. Zwraca nazwę
// KANONICZNĄ (tę z tabeli) — dzięki temu pullForUser (porównanie po to_user) trafia.
// Brak trafienia → InboxDbError z listą członków (podpowiedź dla modelu/klienta).
// Więcej niż jedno trafienie (instalacja sprzed migracji NOCASE) → też błąd; nigdy
// "pierwszy z brzegu", bo to oddanie wiadomości nie tej osobie.
function resolveRecipient(toUser) {
  // Porównanie MUSI iść przez SQLite, nie przez `toLowerCase()`. `COLLATE NOCASE` w SQLite
  // składa WYŁĄCZNIE ASCII, więc „Łukasz" i „łukasz" to dla bazy dwie różne osoby — a dla
  // JS jedna. Fold po stronie JS dawał wtedy `ambiguous_recipient` na adresacie, którego
  // baza widzi jednoznacznie, czyli blokował wysyłkę do poprawnej osoby. Jawne
  // `COLLATE NOCASE` w zapytaniu (zamiast polegania na kolacji kolumny) daje tę samą
  // semantykę także na schemacie sprzed migracji.
  const matches = getInboxDb()
    .prepare('SELECT name FROM members WHERE name = ? COLLATE NOCASE ORDER BY id')
    .all(String(toUser));

  if (matches.length === 1) return matches[0].name;

  const known = listMembers().map((m) => m.name).join(', ') || '(brak członków)';
  if (matches.length === 0) {
    throw new InboxDbError(
      `sendMessage: nieznany adresat "${toUser}". Znani członkowie: ${known}`,
      'unknown_recipient'
    );
  }
  throw new InboxDbError(
    `sendMessage: adresat "${toUser}" pasuje do wielu członków (${matches.map((m) => m.name).join(', ')}) — ` +
      `rozstrzygnij duplikaty w members`,
    'ambiguous_recipient'
  );
}

// INSERT wiadomości. thread_id nieprzekazany → root wątku (thread_id = własne id).
// from_user pochodzi od wywołującego (API wyprowadza go z tokenu). Zwraca wiadomość
// z payloadem jako OBIEKT.
function sendMessage({
  from_user,
  to_user,
  type,
  title,
  content = null,
  thread_id = null,
  payload = null,
  attachments = [],
}) {
  if (!from_user || !to_user || !type || !title) {
    throw new InboxDbError('sendMessage: from_user, to_user, type, title są wymagane');
  }
  if (!MESSAGE_TYPES.includes(type)) {
    throw new InboxDbError(`sendMessage: nieznany type "${type}"`);
  }
  if (!Array.isArray(attachments)) {
    throw new InboxDbError('sendMessage: attachments musi być tablicą', 'invalid_attachment');
  }

  // Adresat MUSI istnieć w members — literówka w nicku była dotąd cichą utratą wiadomości
  // (INSERT przechodził, nikt tego nie pullował). Zwracamy nazwę KANONICZNĄ z tabeli.
  const canonicalTo = resolveRecipient(to_user);

  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getInboxDb();
  const insertMessage = () =>
    db
      .prepare(
        `INSERT INTO inbox (id, thread_id, from_user, to_user, type, title, content, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(id, thread_id || id, from_user, canonicalTo, type, title, content, serializePayload(payload), now, now);

  if (attachments.length === 0) {
    insertMessage();
    return { ...getMessage(id), attachments: [] };
  }

  // Krótka transakcja (wzorzec markDone): wiadomość i metadane załączników powstają razem
  // albo wcale (R2). Bajty są już na dysku PRZED tym wywołaniem (upload dwufazowy), więc
  // transakcja nie trzyma blokady przez czas sieci — sam INSERT to mikrosekundy.
  db.exec('BEGIN');
  let rows;
  try {
    insertMessage();
    rows = addAttachments(db, id, attachments);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ...getMessage(id), attachments: rows };
}

// Wątki członka: otrzymane (do mnie, pending/delivered) + pełne nitki tych wątków +
// delegowane otwarte (moje wysłane task/query != done). Oznacza pending→delivered PO
// zebraniu active — zwracany active zachowuje oryginalny status 'pending' (detekcja "nowe"
// po stronie renderera). Wszystkie payloady jako OBIEKTY.
// Dokłada `attachments` do wierszy wiadomości W MIEJSCU. Kształt rekordu jest KONTRAKTEM
// z klientem (scripts/inbox/inbox-pull.mjs renderuje z niego wiersz, a attachments.mjs
// pobiera po sha256): { id, filename, size_bytes, mime, sha256, blob_available }.
// `blob_available` bierze się z obecności bajtów na dysku huba — jeden `hasBlob` per sha256,
// nie per wiersz (dedup R4 znaczy, że jedne bajty obsługują wiele wiadomości).
function attachAttachments(lists) {
  // Ta sama wiadomość bywa w DWÓCH listach naraz (active i threadRows to osobne obiekty
  // z osobnych zapytań), więc mapa trzyma WSZYSTKIE wiersze o danym id — inaczej pole
  // dostawałby tylko ostatni, a klient renderowałby Skrzynkę z listy bez załączników.
  const byId = new Map();
  for (const list of lists) {
    for (const row of list) {
      row.attachments = [];
      if (!byId.has(row.id)) byId.set(row.id, []);
      byId.get(row.id).push(row);
    }
  }
  if (byId.size === 0) return;

  const rows = getAttachmentsForMessages([...byId.keys()]);
  const blobSeen = new Map();
  for (const a of rows) {
    const targets = byId.get(a.message_id);
    if (!targets) continue;
    if (!blobSeen.has(a.sha256)) blobSeen.set(a.sha256, hasBlob(a.sha256));
    const record = {
      id: a.id,
      filename: a.filename,
      size_bytes: Number(a.size_bytes),
      mime: a.mime ?? null,
      sha256: a.sha256,
      blob_available: blobSeen.get(a.sha256),
    };
    for (const target of targets) target.attachments.push({ ...record });
  }
}

function pullForUser(user) {
  if (!user) throw new InboxDbError('pullForUser: user wymagany');
  const db = getInboxDb();

  const active = db
    .prepare("SELECT * FROM inbox WHERE to_user = ? AND status IN ('pending','delivered') ORDER BY created_at DESC, rowid DESC")
    .all(user)
    .map(parseRow);

  const threadIds = [...new Set(active.map((r) => r.thread_id))];
  let threadRows = [];
  if (threadIds.length > 0) {
    const placeholders = threadIds.map(() => '?').join(',');
    threadRows = db
      .prepare(`SELECT * FROM inbox WHERE thread_id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`)
      .all(...threadIds)
      .map(parseRow);
  }

  // Odpowiedziane query znika z "Wysłanych" — pytanie z odpowiedzią nie jest już otwarte,
  // a rekord NIE dostaje status='done' (świadomy dług widok↔status).
  // `r.from_user <> i.from_user` jest krytyczne: bez tego WŁASNE dopowiedzenie do wątku
  // (reply nadawcy) skasowałoby jego pytanie z listy, a `findOriginal` w skillu `deleguj`
  // (reply.mjs) przestałby znajdować otwarty wątek do odpisania.
  // task zostaje bez zmian — zadanie domyka checkbox "Zrobione", nie odpowiedź.
  const delegated = db
    .prepare(
      `SELECT * FROM inbox i
       WHERE i.from_user = ?
         AND i.type IN ('task','query')
         AND i.status != 'done'
         AND NOT (
           i.type = 'query'
           AND EXISTS (
             SELECT 1 FROM inbox r
             WHERE r.thread_id = i.thread_id
               AND r.type = 'reply'
               AND r.from_user <> i.from_user
           )
         )
       ORDER BY i.created_at ASC, i.rowid ASC`
    )
    .all(user)
    .map(parseRow);

  // Wzbogacenie o załączniki (R5/R7/R8) — JEDNO zapytanie na wszystkie trzy listy (N+1
  // przy nitce z kilkunastoma wiadomościami to kilkanaście round-tripów do SQLite).
  // `blob_available` liczymy TUTAJ, bo tylko hub widzi katalog blobów: po retencji metadane
  // zostają, a bajtów już nie ma — bez tego pola klient renderowałby checkbox „Pobierz",
  // który zawsze kończy się cichym `skipped`.
  attachAttachments([active, threadRows, delegated]);

  const pendingIds = active.filter((r) => r.status === 'pending').map((r) => r.id);
  if (pendingIds.length > 0) {
    const now = new Date().toISOString();
    const placeholders = pendingIds.map(() => '?').join(',');
    db.prepare(`UPDATE inbox SET status='delivered', updated_at=? WHERE id IN (${placeholders})`).run(now, ...pendingIds);
  }

  return { user, active, threadRows, delegated };
}

// Idempotentne domknięcie wiadomości. NAJPIERW świeży odczyt z DB (nie ufamy obiektowi
// z pamięci — learned pattern stale-obiekt). Rekord już 'done' → 'already_done', ZERO
// skutków ubocznych. task+Zrobione → transakcja INSERT reply 'Zrobione ✅' + UPDATE done.
// Semantyka akcji 1:1 z inbox-push: query+Zrobione → 'skipped' (odhaczenie query to
// "Zapoznane"). Zwraca pełną nitkę → klient renderuje archiwum lokalnie.
function markDone({ id, action, user }) {
  if (!id || !action || !user) throw new InboxDbError('markDone: id, action, user są wymagane');
  if (!DONE_ACTIONS.includes(action)) throw new InboxDbError(`markDone: nieznana akcja "${action}"`);

  const db = getInboxDb();
  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
  if (!row) return { result: 'not_found' };
  if (row.to_user !== user) return { result: 'skipped' };
  if (row.status === 'done') return { result: 'already_done' };

  const now = new Date().toISOString();

  if (row.type === 'task' && action === 'Zrobione') {
    // Transakcja: crash między INSERT a UPDATE zostawiłby status != done i przy retry
    // idempotency wstawiłaby duplikat reply.
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO inbox (id, thread_id, from_user, to_user, type, title, content, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reply', ?, ?, NULL, 'pending', ?, ?)`
      ).run(randomUUID(), row.thread_id, user, row.from_user, `Re: ${row.title}`, 'Zrobione ✅', now, now);
      db.prepare("UPDATE inbox SET status='done', updated_at=? WHERE id=?").run(now, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { result: 'replied', thread: getThread(row.thread_id) };
  }

  if (action === 'Zapoznane') {
    db.prepare("UPDATE inbox SET status='done', updated_at=? WHERE id=?").run(now, id);
    return { result: 'closed', thread: getThread(row.thread_id) };
  }

  return { result: 'skipped' };
}

// Atomowy claim jednego niepodjętego query dla asystenta. Pojedyncza instrukcja
// UPDATE ... WHERE id = (podzapytanie) ... RETURNING — dwa sekwencyjne wywołania: drugie
// dostaje null (marker auto_reply_attempted ustawiony przez pierwsze). Kandydat: najstarsze
// otwarte query do mnie, bez reply w wątku, jeszcze nie próbowane. Zwraca wiadomość
// (payload OBIEKT) albo null.
function claimQuery(user) {
  if (!user) throw new InboxDbError('claimQuery: user wymagany');
  const db = getInboxDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `UPDATE inbox
       SET payload = json_set(COALESCE(payload, '{}'), '$.auto_reply_attempted', ?),
           updated_at = ?
       WHERE id = (
         SELECT i.id FROM inbox i
         WHERE i.to_user = ?
           AND i.type = 'query'
           AND i.status IN ('pending', 'delivered')
           AND COALESCE(json_extract(i.payload, '$.auto_reply_attempted'), '') = ''
           AND NOT EXISTS (
             SELECT 1 FROM inbox r WHERE r.thread_id = i.thread_id AND r.type = 'reply'
           )
         ORDER BY i.created_at ASC, i.rowid ASC
         LIMIT 1
       )
       AND COALESCE(json_extract(payload, '$.auto_reply_attempted'), '') = ''
       RETURNING *`
    )
    .get(now, now, user);
  return row ? parseRow(row) : null;
}

// === Attachment operations ===

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_FILENAME_LEN = 255;
const MAX_MIME_LEN = 255;
// Kształt typu MIME wymuszamy na granicy warstwy, bo ta wartość trafia WPROST do nagłówka
// odpowiedzi HTTP: mime z CR/LF przechodziłby walidację długości, a res.writeHead rzucałby
// ERR_INVALID_CHAR, zamieniając poprawne pobranie w 500 (i otwierając wstrzyknięcie nagłówka).
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

// Spacje i ogonki sa legalne; zakazany jest separator sciezki, dwukropek (NTFS: alternatywny
// strumien danych), CALY zakres sterujacy U+0000-U+001F oraz segmenty specjalne "." i ".."
// — te ostatnie po path.join wskazuja KATALOG, wiec zapis zalacznika do vaulta padlby na
// EISDIR/EPERM przy odbiorze wiadomosci. Porownanie robimy PO obcieciu koncowych kropek
// i spacji, bo Win32 obcina je sam (".. " to dla systemu ".."). Znak sterujacy odrzucamy,
// bo nazwa trafia do renderu Skrzynka.md o kontrakcie liniowym: "\n" pozwolilby wstrzyknac
// odhaczony checkbox, ktory inbox-push.mjs odczytalby jako akcje czlowieka.
// Lustro isUnsafeFilename z lib/inbox-api.js — zmieniasz jedna strone, zmieniasz obie.
const UNSAFE_FILENAME_CHARS = /[/\\:\u0000-\u001f]/;

function isUnsafeFilename(name) {
  if (UNSAFE_FILENAME_CHARS.test(name)) return true;
  const trimmed = name.replace(/[. ]+$/, '');
  return trimmed === '' || trimmed === '.' || trimmed === '..';
}

// Walidacja pojedynczego załącznika na granicy warstwy. sha256 jest KLUCZEM ŚCIEŻKI blobu
// (data/inbox-blobs/<aa>/<sha256>), więc kształt musi być wymuszony tutaj, a nie dopiero
// przy zapisie pliku — inaczej "../../etc/passwd" w metadanych staje się ścieżką na dysku.
// Nazwa pliku ze separatorem katalogu jest odrzucana z tego samego powodu (trafia do
// nagłówka pobrania i do renderu Skrzynki).
function normalizeAttachment(item) {
  if (!item || typeof item !== 'object') {
    throw new InboxDbError('addAttachments: załącznik musi być obiektem', 'invalid_attachment');
  }
  const filename = String(item.filename ?? '');
  if (!filename || filename.length > MAX_FILENAME_LEN) {
    throw new InboxDbError(
      `addAttachments: filename wymagany i nie dłuższy niż ${MAX_FILENAME_LEN} znaków`,
      'invalid_attachment'
    );
  }
  if (isUnsafeFilename(filename)) {
    throw new InboxDbError(
      `addAttachments: filename "${filename}" zawiera znak zakazany albo jest segmentem specjalnym`,
      'invalid_attachment'
    );
  }
  const size = item.size_bytes;
  if (!Number.isInteger(size) || size < 0) {
    throw new InboxDbError('addAttachments: size_bytes musi być nieujemną liczbą całkowitą', 'invalid_attachment');
  }
  const sha256 = String(item.sha256 ?? '');
  if (!SHA256_HEX.test(sha256)) {
    throw new InboxDbError(
      'addAttachments: sha256 musi być 64 znakami hex (małe litery)',
      'invalid_attachment'
    );
  }
  const mime = item.mime == null ? null : String(item.mime);
  if (mime !== null && (mime.length === 0 || mime.length > MAX_MIME_LEN || !MIME_PATTERN.test(mime))) {
    throw new InboxDbError(
      `addAttachments: mime musi mieć kształt typ/podtyp i nie przekraczać ${MAX_MIME_LEN} znaków`,
      'invalid_attachment'
    );
  }
  return { filename, size_bytes: size, mime, sha256 };
}

// Zapis metadanych załączników wiadomości. `db` przychodzi z zewnątrz, bo wołamy to
// WEWNĄTRZ transakcji sendMessage — wiadomość z załącznikami powstaje w całości albo wcale
// (R2). Zwraca zapisane rekordy w kolejności wstawienia.
function addAttachments(db, messageId, items) {
  if (!messageId) throw new InboxDbError('addAttachments: messageId wymagany', 'invalid_attachment');
  if (!Array.isArray(items)) throw new InboxDbError('addAttachments: items musi być tablicą', 'invalid_attachment');
  if (items.length === 0) return [];

  const normalized = items.map(normalizeAttachment);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO inbox_attachments (id, message_id, filename, size_bytes, mime, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const ids = [];
  for (const a of normalized) {
    const id = randomUUID();
    stmt.run(id, messageId, a.filename, a.size_bytes, a.mime, a.sha256, now);
    ids.push(id);
  }
  return db
    .prepare(
      `SELECT * FROM inbox_attachments WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid ASC`
    )
    .all(...ids);
}

// Załączniki wielu wiadomości jednym zapytaniem (klient renderuje całą nitkę — pętla
// z zapytaniem per wiadomość to N+1). Pusta lista id = pusta odpowiedź, nie błąd:
// wołający nie ma obowiązku wiedzieć, czy w widoku są jakiekolwiek wiadomości.
function getAttachmentsForMessages(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => '?').join(',');
  return getInboxDb()
    .prepare(
      `SELECT * FROM inbox_attachments WHERE message_id IN (${placeholders}) ORDER BY rowid ASC`
    )
    .all(...messageIds);
}

function getAttachmentById(id) {
  if (!id) return null;
  return getInboxDb().prepare('SELECT * FROM inbox_attachments WHERE id = ?').get(id) || null;
}

// Ile wierszy wciąż wskazuje na ten blob — blob wolno skasować dopiero przy zerze (dedup
// z R4 znaczy, że jedne bajty obsługują wiele wiadomości). Number() na granicy warstwy:
// część buildów node:sqlite zwraca COUNT(*) jako BigInt, a `bigint === 0` z liczbą jest
// fałszem, więc bez rzutowania blob NIGDY by się nie skasował (albo — po odwrotnej
// pomyłce — kasował się mimo referencji).
function countBlobRefs(sha256) {
  const row = getInboxDb()
    .prepare('SELECT COUNT(*) AS n FROM inbox_attachments WHERE sha256 = ?')
    .get(String(sha256 ?? ''));
  return Number(row.n);
}

// Wszystkie załączniki z informacją, czy ich WĄTEK jest domknięty i kiedy — wejście
// retencji (lib/inbox-retention.js). Domknięcie liczymy w SQL, nie w JS: wątek jest
// domknięty, gdy nie ma w nim ani jednej wiadomości poza `done`, a momentem domknięcia
// jest najświeższe `updated_at` w nitce. Świadomie ZERO agregatów zwracanych do JS
// (COUNT/SUM na części buildów node:sqlite wraca jako BigInt, a arytmetyka progów cicho
// by się zepsuła) — stąd EXISTS zamiast SUM(status <> 'done').
function listAttachmentsForRetention() {
  return getInboxDb()
    .prepare(
      `SELECT a.id, a.sha256, a.created_at,
              CASE
                WHEN EXISTS (SELECT 1 FROM inbox o WHERE o.thread_id = i.thread_id AND o.status <> 'done')
                THEN NULL
                ELSE (SELECT MAX(o2.updated_at) FROM inbox o2 WHERE o2.thread_id = i.thread_id)
              END AS thread_closed_at
       FROM inbox_attachments a
       JOIN inbox i ON i.id = a.message_id
       WHERE a.bytes_deleted_at IS NULL
       ORDER BY a.rowid ASC`
    )
    .all();
}

// Hashe WSZYSTKICH wierszy załączników — także tych, których bajty już zwolniliśmy.
// Retencja używa ich jako referencji przy szukaniu sierot: wiersz ze `bytes_deleted_at`
// wypada z listy do skasowania, ale nadal NIE jest sierotą (metadane żyją), więc bez tego
// zapytania przemiatanie próbowałoby go co godzinę unlinkować drugą ścieżką.
function listAttachmentShas() {
  return getInboxDb()
    .prepare('SELECT DISTINCT sha256 FROM inbox_attachments')
    .all()
    .map((r) => r.sha256);
}

// Znacznik zwolnienia bajtów — stawiany po UDANYM skasowaniu pliku, na wszystkich wierszach
// o tym hashu (dedup R4: jeden plik, wiele wierszy). Wiersze zostają w bazie, znika tylko
// ich prawo do ponownego wywołania unlinku.
//
// Wejście walidujemy fail-fast, a nie cichym `return 0` (wzorzec recordBlobUpload): ta
// funkcja odbiera wierszom prawo do ponownego unlinku, więc każdy śmieciowy klucz jest
// błędem wołającego, nie stanem do przemilczenia. Hash musi przejść dokładnie ten sam
// format co ścieżka bajtów — `String(obiekt)` dałby '[object Object]', a hash WIELKIMI
// literami nie trafiłby w żaden wiersz (kolumna jest BINARY), więc bajty zniknęłyby
// z dysku, a retencja wracałaby do nich co godzinę. Znacznik czasu musi być parsowalny,
// bo `parseTime` w innych ścieżkach daje z niego NaN.
function markAttachmentBytesDeleted(sha256, at = new Date().toISOString()) {
  try {
    assertValidSha256(sha256);
  } catch (err) {
    throw new InboxDbError(`markAttachmentBytesDeleted: ${err.message}`, 'invalid_attachment');
  }
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new InboxDbError(
      'markAttachmentBytesDeleted: at musi być parsowalnym znacznikiem czasu (ISO)',
      'invalid_timestamp'
    );
  }
  const info = getInboxDb()
    .prepare('UPDATE inbox_attachments SET bytes_deleted_at = ? WHERE sha256 = ? AND bytes_deleted_at IS NULL')
    .run(at, sha256);
  return Number(info.changes ?? 0);
}

// Ślady wgrania bajtów — jeden wiersz na hash, ze znacznikiem NAJŚWIEŻSZEGO wgrania.
// Retencja szuka wśród nich sierot (bajty wgrane, nigdy nieprzypisane do wiadomości),
// więc liczy się ostatni upload: po retry sprzed minuty karencja startuje od nowa.
function listBlobUploads() {
  return getInboxDb()
    .prepare('SELECT sha256, MAX(created_at) AS uploaded_at FROM inbox_blob_uploads GROUP BY sha256')
    .all();
}

// Czy ten użytkownik ma prawo do BAJTÓW o tym sha256 — i przy okazji metadane pierwszego
// pasującego załącznika (nazwa, mime) potrzebne do nagłówków pobrania. Uprawnieniem jest
// UCZESTNICTWO w wiadomości (from_user albo to_user), nigdy sama znajomość hasha: hash
// wycieka do renderu Skrzynki, archiwum i logów, więc "kto zna hash, ten pobiera" oddawałoby
// cudze pliki każdemu członkowi huba. from_user/to_user trzymają nazwę KANONICZNĄ z members
// (podmienia ją resolveRecipient), a member.name pochodzi z tego samego źródła — dlatego
// porównanie jest dokładne, bez COLLATE (NOCASE zna wyłącznie ASCII, więc dla "Michał"
// i tak nie byłoby lekarstwem). Zwraca wiersz załącznika albo null.
//
// Samo uczestnictwo NIE wystarcza: wiersz wiadomości może sfabrykować atakujący (send do
// samego siebie z cudzym sha256), więc dokładamy warunek „nadawca tej wiadomości realnie
// wgrał te bajty" (JOIN po inbox_blob_uploads). Bez niego znajomość hasha stawała się
// uprawnieniem przez jeden INSERT.
function findAttachmentForUser(sha256, user) {
  if (!sha256 || !user) return null;
  return (
    getInboxDb()
      .prepare(
        `SELECT a.* FROM inbox_attachments a
         JOIN inbox i ON i.id = a.message_id
         JOIN inbox_blob_uploads u ON u.sha256 = a.sha256 AND u.uploaded_by = i.from_user
         WHERE a.sha256 = ? AND (i.from_user = ? OR i.to_user = ?)
         ORDER BY a.rowid ASC
         LIMIT 1`
      )
      .get(String(sha256), String(user), String(user)) || null
  );
}

// Ślad wgrania bajtów: woła go skorupa HTTP po ZWERYFIKOWANYM transferze (suma policzona
// przez huba), nigdy na podstawie samej deklaracji z URL-a. Idempotentny — ten sam człowiek
// może wgrywać tę treść wielokrotnie (retry), a wiersz ma być jeden. Powtórne wgranie
// ODŚWIEŻA `created_at`: retencja liczy karencję sierot od NAJŚWIEŻSZEGO wgrania, więc
// `INSERT OR IGNORE` zamrażał znacznik i kazał przemiataniu kasować świeżo wgrane bajty.
function recordBlobUpload(sha256, user) {
  if (!sha256 || !user) throw new InboxDbError('recordBlobUpload: sha256 i user wymagane', 'invalid_attachment');
  getInboxDb()
    .prepare(
      `INSERT INTO inbox_blob_uploads (sha256, uploaded_by, created_at) VALUES (?, ?, ?)
       ON CONFLICT(sha256, uploaded_by) DO UPDATE SET created_at = excluded.created_at`
    )
    .run(String(sha256), String(user), new Date().toISOString());
}

// Czy ten człowiek wgrał już te bajty. Świadomie SELECT 1 zamiast COUNT(*) — agregat na
// części buildów node:sqlite wraca jako BigInt (pułapka projektu), a tu potrzebna jest
// wyłącznie odpowiedź tak/nie. Zapytanie decyduje o skrócie dedupu na ścieżce PUT.
function isBlobUploader(sha256, user) {
  if (!sha256 || !user) return false;
  const row = getInboxDb()
    .prepare('SELECT 1 AS ok FROM inbox_blob_uploads WHERE sha256 = ? AND uploaded_by = ? LIMIT 1')
    .get(String(sha256), String(user));
  return Boolean(row);
}

// === Member operations ===

// Dodaje członka, zwraca PEŁNY token (długi hex). name UNIQUE COLLATE NOCASE — duplikat,
// także różniący się tylko wielkością liter ("cave" przy istniejącym "Cave"), = InboxDbError.
//
// Guard Unicode PRZED insertem: COLLATE NOCASE zna tylko ASCII, więc para „Michał"/„MICHAŁ"
// przechodzi UNIQUE jako dwie osoby — a resolveRecipient porównuje przez toLowerCase (pełny
// Unicode), więc od tej chwili KAŻDA wysyłka do któregokolwiek z nich wraca ambiguous_recipient
// i obaj są trwale nieosiągalni. Niezmiennik trzymamy w warstwie logiki, nie w kolacji —
// dokładnie wg learned pattern z migracji NOCASE (fail-fast w migrate blokował lekarstwo).
function addMember(name) {
  if (!name) throw new InboxDbError('addMember: name wymagane');
  const db = getInboxDb();
  const clash = listMembers().find((m) => m.name.toLowerCase() === String(name).toLowerCase());
  if (clash) {
    throw new InboxDbError(
      `addMember: członek "${name}" koliduje z istniejącym "${clash.name}" ` +
        '(nazwy porównujemy bez rozróżniania wielkości liter, także dla znaków spoza ASCII)'
    );
  }
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  try {
    const res = db.prepare('INSERT INTO members (name, token, created_at) VALUES (?, ?, ?)').run(name, token, now);
    return db.prepare('SELECT id, name, token, created_at FROM members WHERE id = ?').get(res.lastInsertRowid);
  } catch (e) {
    // UNIQUE zostaje jako druga siatka (wyścig dwóch INSERT-ów) — guard wyżej łapie
    // przypadek Unicode, którego kolacja nie widzi.
    if (String(e.message).includes('UNIQUE')) {
      throw new InboxDbError(`addMember: członek "${name}" już istnieje`);
    }
    throw e;
  }
}

function listMembers() {
  return getInboxDb().prepare('SELECT id, name, token, created_at FROM members ORDER BY id').all();
}

// Rozwiązanie tożsamości z tokenu (hub wyprowadza user z tokenu, klient nie deklaruje).
function getMemberByToken(token) {
  if (!token) return null;
  return getInboxDb().prepare('SELECT id, name, token, created_at FROM members WHERE token = ?').get(token) || null;
}

// Ścieżka bajtów do komunikatu diagnostycznego. Nigdy nie rzuca — to linia loga na
// ścieżce błędu, więc walidacja hasha nie może przesłonić prawdziwej przyczyny padu.
function safeBlobPath(sha256) {
  try {
    return blobPath(sha256);
  } catch {
    return '<ścieżka nieznana>';
  }
}

// Odwołanie dostępu = skasowanie tokenu WRAZ z danymi członka (R13): jego wiadomości,
// metadane ich załączników, ślady wgrania bajtów oraz same bajty, do których nie odwołuje
// się już nic innego. To ścieżka BEZPIECZEŃSTWA, nie porządkowa — po rewokacji na hubie
// nie mogą zostać ani czytelne treści, ani osierocone bajty.
//
// Zasięg jest literalny wobec R13 i ma świadomą cenę: wiadomości członka bywają częścią
// wątków z innymi osobami, więc domknięte nitki tracą tu część historii. Archiwum
// w vaultach (Zasoby/inbox-archive) zostaje jedynym śladem tej korespondencji.
//
// Kolejność jest kontraktem: część bazodanowa w JEDNEJ transakcji, pliki dopiero PO
// udanym commicie. Odwrotna kolejność przy padzie transakcji zostawiłaby rekordy
// wskazujące na nieistniejące bajty — czyli załączniki, których nikt nigdy nie pobierze.
// `deleteBlobFn`/`warn` są wstrzykiwalne dla testu ścieżki nieudanego unlinku.
function revokeMember(id, { deleteBlobFn = deleteBlob, warn = console.warn } = {}) {
  const db = getInboxDb();
  // Świeży odczyt wiersza (learned pattern: nie ufamy obiektowi z pamięci) — potrzebna
  // jest nazwa KANONICZNA, bo to ona siedzi w inbox.from_user/to_user (podmienia ją
  // resolveRecipient), więc porównanie jest dokładne, bez COLLATE.
  const member = db.prepare('SELECT id, name FROM members WHERE id = ?').get(id);
  if (!member) return false;
  const name = member.name;

  // Kandydatów na skasowanie bajtów zbieramy PRZED transakcją — po niej wiersze wskazujące
  // te hashe już nie istnieją i nie byłoby z czego ich odtworzyć.
  const shas = db
    .prepare(
      `SELECT DISTINCT a.sha256 AS sha256
       FROM inbox_attachments a
       JOIN inbox i ON i.id = a.message_id
       WHERE i.from_user = ? OR i.to_user = ?`
    )
    .all(name, name)
    .map((r) => r.sha256);

  // Bajty wgrane, do których NIGDY nie powstał wiersz załącznika (PUT był, `send` nie),
  // też są danymi tego członka. Za chwilę kasujemy jego ślady wgrania — a `computeOrphanedBlobs`
  // czyta wyłącznie inbox_blob_uploads, więc bez tej listy plik zostawałby na dysku na zawsze,
  // bez jakiegokolwiek śladu, po którym przemiatanie mogłoby go znaleźć (wbrew R13).
  const uploadedShas = db
    .prepare('SELECT DISTINCT sha256 FROM inbox_blob_uploads WHERE uploaded_by = ?')
    .all(name)
    .map((r) => r.sha256);
  const candidateShas = [...new Set([...shas, ...uploadedShas])];

  db.exec('BEGIN');
  try {
    // Załączniki PRZED wiadomościami: inbox_attachments.message_id ma REFERENCES inbox(id),
    // a połączenie chodzi z PRAGMA foreign_keys = ON.
    db.prepare(
      `DELETE FROM inbox_attachments
       WHERE message_id IN (SELECT id FROM inbox WHERE from_user = ? OR to_user = ?)`
    ).run(name, name);
    db.prepare('DELETE FROM inbox WHERE from_user = ? OR to_user = ?').run(name, name);
    // Ślady wgrania odwołanego członka też znikają: to jego dane, a zostawione wskazywałyby
    // na bajty, których po tej operacji zwykle już nie ma. Ślady INNYCH osób o tym samym
    // hashu zostają nietknięte — ich uprawnienia do pobrania nie mogą się zmienić.
    db.prepare('DELETE FROM inbox_blob_uploads WHERE uploaded_by = ?').run(name);
    db.prepare('DELETE FROM members WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Bajty kasujemy dopiero, gdy nie wskazuje ich żaden pozostały wiersz — dedup (R4)
  // znaczy, że jeden plik obsługuje wiele wiadomości, także cudzych.
  // Referencje liczymy JEDNYM zapytaniem, nie COUNT-em per hash (N+1 w pętli po rewokacji
  // członka z setkami załączników).
  const stillReferenced = new Set(
    candidateShas.length === 0
      ? []
      : db
          .prepare(
            `SELECT DISTINCT sha256 FROM inbox_attachments
              WHERE sha256 IN (${candidateShas.map(() => '?').join(',')})`
          )
          .all(...candidateShas)
          .map((r) => r.sha256)
  );

  for (const sha of candidateShas) {
    if (stillReferenced.has(sha)) continue;
    try {
      deleteBlobFn(sha);
    } catch (err) {
      // Pad unlinku nie może wywrócić rewokacji: dostęp jest już odebrany, a bajty bez
      // rekordu sprzątnie przemiatanie sierot (lib/inbox-retention.js).
      warn(`[inbox-db] rewokacja ${name}: nie udało się skasować bajtów ${sha} (${safeBlobPath(sha)}): ${err.message}`);
    }
  }

  return true;
}

function close() {
  if (inboxDb) {
    inboxDb.close();
    inboxDb = null;
  }
}

module.exports = {
  getInboxDb,
  setInboxDbPath,
  migrate,
  needsMembersNocaseRebuild,
  assertInboxDbReturnsNumbers,
  InboxDbError,
  InboxDbTypeError,
  sendMessage,
  pullForUser,
  markDone,
  claimQuery,
  addAttachments,
  getAttachmentsForMessages,
  getAttachmentById,
  countBlobRefs,
  listAttachmentsForRetention,
  listAttachmentShas,
  markAttachmentBytesDeleted,
  listBlobUploads,
  findAttachmentForUser,
  recordBlobUpload,
  isBlobUploader,
  getMessage,
  getThread,
  addMember,
  listMembers,
  getMemberByToken,
  revokeMember,
  close,
};
