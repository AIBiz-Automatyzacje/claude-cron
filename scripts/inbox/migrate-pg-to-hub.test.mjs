// Testy jednorazowego skryptu migracji pg → hub SQLite (IU-4.1).
// DI: fake source-reader (tablica wierszy „pg") + realny lib/inbox-db.js na :memory:.
// Mockujemy TYLKO zewnętrzny serwis (Postgres) — logika transformacji/migracji jest testowana.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { migrate, pgRowToHubRow, readSourceUrl, MigrateError } from './migrate-pg-to-hub.mjs';

const require = createRequire(import.meta.url);
const inboxDb = require('../../lib/inbox-db');

// Świeża baza :memory: przed każdym testem — getInboxDb() otwiera leniwie przy 1. operacji.
beforeEach(() => {
  inboxDb.close();
  inboxDb.setInboxDbPath(':memory:');
});
afterEach(() => {
  inboxDb.close();
});

function countRows() {
  return inboxDb.getInboxDb().prepare('SELECT COUNT(*) AS n FROM inbox').get().n;
}

// Fabryka wiersza „pg": created_at jako obiekt Date (tak zwraca pg dla timestamptz),
// payload jako obiekt JS (tak zwraca pg dla jsonb).
function pgRow(overrides = {}) {
  const created = new Date('2026-01-15T10:00:00.000Z');
  return {
    id: '11111111-1111-1111-1111-111111111111',
    thread_id: null,
    from_user: 'kacper',
    to_user: 'kamil',
    type: 'task',
    title: 'Zadanie',
    content: 'treść zadania',
    payload: null,
    status: 'pending',
    created_at: created,
    updated_at: created,
    ...overrides,
  };
}

// ──────── pgRowToHubRow (czysta transformacja) ────────

test('pgRowToHubRow: created_at (Date) → ISO string, thread_id NULL → id', () => {
  const hub = pgRowToHubRow(pgRow());
  assert.strictEqual(hub.created_at, '2026-01-15T10:00:00.000Z');
  assert.strictEqual(typeof hub.created_at, 'string');
  // Root bez thread_id (NULL w starym schemacie) dziedziczy własne id (konwencja huba).
  assert.strictEqual(hub.thread_id, hub.id);
});

test('pgRowToHubRow: zachowany przekazany thread_id (reply w nitce)', () => {
  const hub = pgRowToHubRow(pgRow({ id: 'reply-id', thread_id: 'root-id' }));
  assert.strictEqual(hub.thread_id, 'root-id');
});

test('pgRowToHubRow: payload pozostaje OBIEKTEM (serializacja żyje w INSERT)', () => {
  const hub = pgRowToHubRow(pgRow({ payload: { auto_reply: true } }));
  assert.strictEqual(typeof hub.payload, 'object');
  assert.strictEqual(hub.payload.auto_reply, true);
});

test('pgRowToHubRow: wiersz bez id → MigrateError', () => {
  assert.throws(() => pgRowToHubRow({ id: null, status: 'pending' }), MigrateError);
});

test('pgRowToHubRow: created_at nieparsowalny → MigrateError', () => {
  assert.throws(() => pgRowToHubRow(pgRow({ created_at: 'nie-data' })), MigrateError);
});

// ──────── migrate (DI: fake source + :memory:) ────────

test('happy path: 2 wiersze nitki (task pending + reply delivered) → hub zachowuje id/created_at/status/from_user, payload OBIEKT', async () => {
  const rootCreated = new Date('2026-01-15T10:00:00.000Z');
  const replyCreated = new Date('2026-01-15T11:30:00.000Z');
  const root = pgRow({
    id: 'root-1',
    thread_id: null,
    type: 'query',
    title: 'Pytanie?',
    status: 'pending',
    payload: { source: 'stary-pg' },
    created_at: rootCreated,
    updated_at: rootCreated,
  });
  const reply = pgRow({
    id: 'reply-1',
    thread_id: 'root-1',
    from_user: 'kamil',
    to_user: 'kacper',
    type: 'reply',
    title: 'Re: Pytanie?',
    status: 'delivered',
    payload: null,
    created_at: replyCreated,
    updated_at: replyCreated,
  });

  const result = await migrate({ readRows: async () => [root, reply], db: inboxDb });

  assert.strictEqual(result.migrated, 2);
  assert.strictEqual(result.skippedDone, 0);

  // Nitka odczytana z huba — thread_id roota = jego id (NULL → id).
  const thread = inboxDb.getThread('root-1');
  assert.strictEqual(thread.length, 2);

  const [gotRoot, gotReply] = thread;
  assert.strictEqual(gotRoot.id, 'root-1');
  assert.strictEqual(gotRoot.from_user, 'kacper');
  assert.strictEqual(gotRoot.status, 'pending');
  assert.strictEqual(gotRoot.created_at, '2026-01-15T10:00:00.000Z');
  // payload wraca jako OBIEKT (granica JSON zdeserializowana w inbox-db).
  assert.strictEqual(typeof gotRoot.payload, 'object');
  assert.strictEqual(gotRoot.payload.source, 'stary-pg');

  assert.strictEqual(gotReply.id, 'reply-1');
  assert.strictEqual(gotReply.from_user, 'kamil');
  assert.strictEqual(gotReply.status, 'delivered');
  assert.strictEqual(gotReply.created_at, '2026-01-15T11:30:00.000Z');
  assert.strictEqual(gotReply.payload, null);
});

test('filtr: wiersz status=done w źródle NIE trafia do huba', async () => {
  const open = pgRow({ id: 'open-1', status: 'pending' });
  const closed = pgRow({ id: 'closed-1', status: 'done' });

  const result = await migrate({ readRows: async () => [open, closed], db: inboxDb });

  assert.strictEqual(result.migrated, 1);
  assert.strictEqual(result.skippedDone, 1);
  assert.strictEqual(countRows(), 1);
  assert.strictEqual(inboxDb.getMessage('closed-1'), null);
  assert.ok(inboxDb.getMessage('open-1'));
});

test('idempotencja: druga migracja tych samych danych → zero nowych wierszy', async () => {
  const rows = [pgRow({ id: 'dup-1' }), pgRow({ id: 'dup-2', thread_id: 'dup-1' })];

  const first = await migrate({ readRows: async () => rows, db: inboxDb });
  assert.strictEqual(first.migrated, 2);
  assert.strictEqual(countRows(), 2);

  const second = await migrate({ readRows: async () => rows, db: inboxDb });
  assert.strictEqual(second.migrated, 0);
  assert.strictEqual(second.skippedDuplicate, 2);
  assert.strictEqual(countRows(), 2);
});

test('migrate: readRows nie jest funkcją → MigrateError', async () => {
  await assert.rejects(() => migrate({ readRows: null, db: inboxDb }), MigrateError);
});

// ──────── readSourceUrl (fail-fast konfiguracji) ────────

test('readSourceUrl: brak INBOX_DB_URL → MigrateError z czytelnym komunikatem', () => {
  const saved = process.env.INBOX_DB_URL;
  delete process.env.INBOX_DB_URL;
  try {
    assert.throws(() => readSourceUrl(), (err) => err instanceof MigrateError && /INBOX_DB_URL/.test(err.message));
  } finally {
    if (saved !== undefined) process.env.INBOX_DB_URL = saved;
  }
});

test('readSourceUrl: obecny INBOX_DB_URL → zwraca connection string', () => {
  const saved = process.env.INBOX_DB_URL;
  process.env.INBOX_DB_URL = 'postgres://u:p@host/db';
  try {
    assert.strictEqual(readSourceUrl(), 'postgres://u:p@host/db');
  } finally {
    if (saved === undefined) delete process.env.INBOX_DB_URL;
    else process.env.INBOX_DB_URL = saved;
  }
});
