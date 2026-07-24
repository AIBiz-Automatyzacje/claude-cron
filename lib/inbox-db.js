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
  constructor(message) {
    super(message);
    this.name = 'InboxDbError';
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
  inboxDb = new DatabaseSync(target);
  inboxDb.exec('PRAGMA journal_mode = WAL');
  inboxDb.exec('PRAGMA foreign_keys = ON');

  migrate(inboxDb);
  assertInboxDbReturnsNumbers(inboxDb);
  return inboxDb;
}

// Idempotentne migracje (CREATE TABLE IF NOT EXISTS — idempotentne z natury).
// thread_id ustawiamy = id dla wiadomości-roota (patrz sendMessage), więc jest NOT NULL —
// eliminuje rozgałęzianie COALESCE(thread_id, id) w zapytaniach. created_at/updated_at to
// ISO stringi ustawiane W KODZIE (nie trigger — spójnie z konwencją projektu, patrz db.js).
function migrate(db) {
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

    CREATE TABLE IF NOT EXISTS members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_to_status ON inbox(to_user, status);
    CREATE INDEX IF NOT EXISTS idx_inbox_thread    ON inbox(thread_id);
  `);
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

  const id = randomUUID();
  const now = new Date().toISOString();
  getInboxDb()
    .prepare(
      `INSERT INTO inbox (id, thread_id, from_user, to_user, type, title, content, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(id, thread_id || id, from_user, to_user, type, title, content, serializePayload(payload), now, now);
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

  const delegated = db
    .prepare("SELECT * FROM inbox WHERE from_user = ? AND type IN ('task','query') AND status != 'done' ORDER BY created_at ASC, rowid ASC")
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

// Dodaje członka, zwraca PEŁNY token (długi hex). name UNIQUE — duplikat = InboxDbError.
function addMember(name) {
  if (!name) throw new InboxDbError('addMember: name wymagane');
  const db = getInboxDb();
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  try {
    const res = db.prepare('INSERT INTO members (name, token, created_at) VALUES (?, ?, ?)').run(name, token, now);
    return db.prepare('SELECT id, name, token, created_at FROM members WHERE id = ?').get(res.lastInsertRowid);
  } catch (e) {
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
