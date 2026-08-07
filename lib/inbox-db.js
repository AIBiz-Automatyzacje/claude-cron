const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { INBOX_DB_PATH, DATA_DIR } = require('./config');

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

    CREATE INDEX IF NOT EXISTS idx_inbox_to_status ON inbox(to_user, status);
    CREATE INDEX IF NOT EXISTS idx_inbox_thread    ON inbox(thread_id);
  `);

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
  const row = conn.prepare('SELECT COUNT(*) AS n FROM inbox').get();
  if (typeof row.n !== 'number') {
    throw new InboxDbTypeError(
      `[inbox-db smoke-test] node:sqlite zwraca agregat jako "${typeof row.n}" zamiast "number" ` +
        `(COUNT(*) → ${String(row.n)}). Niekompatybilny build Node — zaktualizuj runtime.`
    );
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
function sendMessage({ from_user, to_user, type, title, content = null, thread_id = null, payload = null }) {
  if (!from_user || !to_user || !type || !title) {
    throw new InboxDbError('sendMessage: from_user, to_user, type, title są wymagane');
  }
  if (!MESSAGE_TYPES.includes(type)) {
    throw new InboxDbError(`sendMessage: nieznany type "${type}"`);
  }

  // Adresat MUSI istnieć w members — literówka w nicku była dotąd cichą utratą wiadomości
  // (INSERT przechodził, nikt tego nie pullował). Zwracamy nazwę KANONICZNĄ z tabeli.
  const canonicalTo = resolveRecipient(to_user);

  const id = randomUUID();
  const now = new Date().toISOString();
  getInboxDb()
    .prepare(
      `INSERT INTO inbox (id, thread_id, from_user, to_user, type, title, content, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(id, thread_id || id, from_user, canonicalTo, type, title, content, serializePayload(payload), now, now);
  return getMessage(id);
}

// Wątki członka: otrzymane (do mnie, pending/delivered) + pełne nitki tych wątków +
// delegowane otwarte (moje wysłane task/query != done). Oznacza pending→delivered PO
// zebraniu active — zwracany active zachowuje oryginalny status 'pending' (detekcja "nowe"
// po stronie renderera). Wszystkie payloady jako OBIEKTY.
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

// Odwołanie dostępu = skasowanie tokenu. Zwraca true gdy członek istniał.
function revokeMember(id) {
  return getInboxDb().prepare('DELETE FROM members WHERE id = ?').run(id).changes > 0;
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
  getMessage,
  getThread,
  addMember,
  listMembers,
  getMemberByToken,
  revokeMember,
  close,
};
