// Team OS — JEDNORAZOWY skrypt migracji OTWARTYCH wątków (status != 'done') ze starego,
// publicznego Postgresa (transport sprzed migracji na hub) do huba SQLite (data/inbox.db).
// Odpalany RĘCZNIE przez operatora na VPS-ie huba — to narzędzie migracyjne, NIE job.
// Usuwany w IU-4.3 (razem z zależnością `pg`), więc throwaway-logika (serializacja payloadu,
// raw INSERT) żyje LOKALNIE tutaj — świadomy wyjątek od reguły „granica JSON tylko w inbox-db":
// nie zostawiamy martwego kodu w produkcyjnym inbox-db po skasowaniu skryptu.
//
// Ścieżki:
//  - ŹRÓDŁO (stary Postgres): connection string z process.env.INBOX_DB_URL. To STARA zmienna
//    sprzed migracji, której env-loader już nie eksponuje — czytamy ją WYŁĄCZNIE tutaj, wprost.
//  - CEL (hub SQLite): bezpośrednio do data/inbox.db przez lib/inbox-db.js. Ścieżka przez API/send
//    jest WYKLUCZONA — handleSend wymusza from_user z tokenu i generuje świeży created_at,
//    a sendMessage generuje świeży randomUUID()+now. Migracja MUSI zachować oryginalne
//    id/thread_id/from_user/to_user/created_at/status, więc idziemy surowym INSERT-em.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pg = require('pg');
const inboxDb = require('../../lib/inbox-db');

const { Client } = pg;

// Kolumny czytane ze starego Postgresa. Jawna lista (nie SELECT *) — kontrakt migracji
// jest stały i nie zależy od kolejności kolumn w źródle.
const SOURCE_COLUMNS = 'id, thread_id, from_user, to_user, type, title, content, payload, status, created_at, updated_at';

// Typowany błąd konfiguracji/danych migracji — czytelny komunikat dla operatora zamiast
// kryptycznego błędu pg/sqlite (wzorzec InboxClientError z inbox-client.mjs).
export class MigrateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrateError';
  }
}

// Fail-fast konfiguracji źródła. INBOX_DB_URL czytane wprost z env (env-loader jej nie
// eksponuje — to zmienna wyłącznie tego jednorazowego skryptu).
export function readSourceUrl() {
  const url = process.env.INBOX_DB_URL;
  if (!url) {
    throw new MigrateError(
      'Brak INBOX_DB_URL — ustaw connection string do STAREGO Postgresa (transport sprzed migracji), ' +
        'np. INBOX_DB_URL=postgres://user:pass@host/db, i uruchom skrypt ponownie.'
    );
  }
  return url;
}

// timestamptz z pg przychodzi jako obiekt Date → ISO string (format huba: created_at TEXT).
// Akceptuje też string ISO (fake source w testach) — normalizuje do kanonicznego ISO.
function toIso(value, field) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new MigrateError(`Pole ${field} nie jest poprawną datą: "${value}"`);
    return d.toISOString();
  }
  throw new MigrateError(`Pole ${field} ma nieoczekiwany typ (${typeof value}) — oczekiwano Date/ISO string`);
}

// CZYSTA transformacja: wiersz Postgresa → wiersz huba. Zachowuje id/from_user/to_user/type/
// title/content/status i payload jako OBIEKT (serializacja żyje w warstwie INSERT). thread_id
// roota w starym schemacie bywa NULL (brak DEFAULT) — coalesce do id, spójnie z konwencją huba
// (thread_id NOT NULL, sendMessage: thread_id || id), co ZACHOWUJE grupowanie nitek.
export function pgRowToHubRow(row) {
  if (!row || !row.id) throw new MigrateError('Wiersz źródłowy bez pola "id" — migracja przerwana');
  return {
    id: row.id,
    thread_id: row.thread_id || row.id,
    from_user: row.from_user,
    to_user: row.to_user,
    type: row.type,
    title: row.title,
    content: row.content == null ? null : row.content,
    payload: row.payload == null ? null : row.payload,
    status: row.status,
    created_at: toIso(row.created_at, 'created_at'),
    updated_at: toIso(row.updated_at, 'updated_at'),
  };
}

// Lokalna granica JSON (throwaway — patrz nagłówek). payload OBIEKT → TEXT-JSON dla SQLite.
function serializePayload(payload) {
  return payload == null ? null : JSON.stringify(payload);
}

// Migracja z WSTRZYKNIĘTYMI zależnościami (DI, wzorzec projektu):
//  - readRows(): async, zwraca tablicę wierszy źródła (real: pg; test: fake).
//  - db: moduł lib/inbox-db.js (test: setInboxDbPath(':memory:')).
// Filtr status != 'done' egzekwowany TU (defense-in-depth) — nie polegamy wyłącznie na WHERE
// w SQL, żeby scenariusz był testowalny fake source-readerem. Idempotencja: INSERT OR IGNORE
// po PRIMARY KEY id (operator może odpalić skrypt 2×). Zwraca podsumowanie liczbowe.
export async function migrate({ readRows, db }) {
  if (typeof readRows !== 'function') throw new MigrateError('migrate: readRows musi być funkcją');
  if (!db || typeof db.getInboxDb !== 'function') throw new MigrateError('migrate: db musi być modułem inbox-db');

  const rows = await readRows();
  const conn = db.getInboxDb();
  const stmt = conn.prepare(
    `INSERT OR IGNORE INTO inbox (id, thread_id, from_user, to_user, type, title, content, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let migrated = 0;
  let skippedDone = 0;
  let skippedDuplicate = 0;

  for (const row of rows) {
    if (row.status === 'done') {
      skippedDone += 1;
      continue;
    }
    const hub = pgRowToHubRow(row);
    const res = stmt.run(
      hub.id,
      hub.thread_id,
      hub.from_user,
      hub.to_user,
      hub.type,
      hub.title,
      hub.content,
      serializePayload(hub.payload),
      hub.status,
      hub.created_at,
      hub.updated_at
    );
    // res.changes > 0 → wstawiono; 0 → zignorowano duplikat (id już w hubie). Porównanie
    // działa też dla BigInt (pułapka node:sqlite) — nie robimy arytmetyki na changes.
    if (res.changes > 0) migrated += 1;
    else skippedDuplicate += 1;
  }

  return { total: rows.length, migrated, skippedDone, skippedDuplicate };
}

// Czyta OTWARTE wątki ze starego Postgresa (real source-reader). WHERE status != 'done' —
// zamknięte wątki żyją w archiwach vaultów, nie migrujemy ich (migrate() filtruje dodatkowo).
async function readOpenRowsFromPg(client) {
  const { rows } = await client.query(
    `SELECT ${SOURCE_COLUMNS} FROM inbox WHERE status != 'done'`
  );
  return rows;
}

// main() = cienka skorupa I/O: env → realny pg.Client → migracja → podsumowanie → cleanup.
export async function main() {
  const url = readSourceUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await migrate({ readRows: () => readOpenRowsFromPg(client), db: inboxDb });
    console.log(
      `[migrate-pg-to-hub] źródło: ${result.total} otwartych wierszy | ` +
        `przeniesiono: ${result.migrated} | pominięto (już w hubie): ${result.skippedDuplicate} | ` +
        `pominięto (done): ${result.skippedDone}`
    );
    return result;
  } finally {
    await client.end();
    inboxDb.close();
  }
}

// Entry-point guard: odpalaj main() TYLKO gdy skrypt uruchamiany bezpośrednio. Porównanie przez
// fs.realpathSync po OBU stronach — macOS symlinkuje /var,/tmp → /private/*, goły path.resolve
// cicho blokowałby main() (learned pattern projektu).
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[migrate-pg-to-hub] BŁĄD: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
