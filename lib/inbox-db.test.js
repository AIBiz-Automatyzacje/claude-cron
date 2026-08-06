const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inboxDb = require('./inbox-db');
const {
  setInboxDbPath,
  close,
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
  InboxDbError,
} = inboxDb;

// Obsada testowa: sendMessage odrzuca adresatów spoza members, więc nicki używane w testach
// muszą istnieć jako członkowie (tak jak na żywym hubie).
const CAST = ['kacper', 'kamil', 'zenek', 'a', 'b'];

// Świeża baza :memory: przed każdym testem — getInboxDb() otwiera leniwie przy 1. operacji.
beforeEach(() => {
  close();
  setInboxDbPath(':memory:');
  CAST.forEach((name) => addMember(name));
});
afterEach(() => {
  close();
});

function countRows() {
  return inboxDb.getInboxDb().prepare('SELECT COUNT(*) AS n FROM inbox').get().n;
}

// ──────── Granica JSON (wymaganie twarde #1) ────────

test('payload roundtrip: zapis obiektu → odczyt OBIEKTU (nie stringa)', () => {
  const msg = sendMessage({
    from_user: 'kacper',
    to_user: 'kamil',
    type: 'reply',
    title: 'Re: coś',
    content: 'treść',
    payload: { auto_reply: true },
  });

  assert.strictEqual(typeof msg.payload, 'object');
  assert.strictEqual(msg.payload.auto_reply, true);

  // Ponowny odczyt z DB też zwraca obiekt (nie zależy od zwrotki z insertu)
  const reread = getMessage(msg.id);
  assert.strictEqual(reread.payload.auto_reply, true);
  assert.strictEqual(typeof reread.payload, 'object');
});

test('payload null: brak payloadu → null, nie "null" string', () => {
  const msg = sendMessage({ from_user: 'a', to_user: 'b', type: 'task', title: 'T' });
  assert.strictEqual(msg.payload, null);
});

// ──────── sendMessage ────────

test('sendMessage: root ustawia thread_id = własne id', () => {
  const msg = sendMessage({ from_user: 'a', to_user: 'b', type: 'task', title: 'T' });
  assert.strictEqual(msg.thread_id, msg.id);
  assert.strictEqual(msg.status, 'pending');
});

test('sendMessage: przekazany thread_id jest zachowany', () => {
  const root = sendMessage({ from_user: 'a', to_user: 'b', type: 'query', title: 'Q' });
  const reply = sendMessage({ from_user: 'b', to_user: 'a', type: 'reply', title: 'Re: Q', thread_id: root.thread_id });
  assert.strictEqual(reply.thread_id, root.thread_id);
});

test('sendMessage: brak wymaganego pola → InboxDbError', () => {
  assert.throws(() => sendMessage({ from_user: 'a', to_user: 'b', type: 'task' }), InboxDbError);
});

test('sendMessage: nieznany type → InboxDbError', () => {
  assert.throws(
    () => sendMessage({ from_user: 'a', to_user: 'b', type: 'bogus', title: 'T' }),
    InboxDbError
  );
});

// ──────── sendMessage: adresat (R1 — literówka przestaje być cichą utratą) ────────

test('sendMessage: adresat inną wielkością liter → INSERT z nazwą kanoniczną z members', () => {
  addMember('Cave');
  const msg = sendMessage({ from_user: 'kacper', to_user: 'cave', type: 'task', title: 'T' });

  assert.strictEqual(msg.to_user, 'Cave');
  assert.strictEqual(getMessage(msg.id).to_user, 'Cave');
});

test('sendMessage: nick z polskim znakiem trafia do adresata (fold ASCII-only SQLite)', () => {
  // `COLLATE NOCASE` składa wyłącznie ASCII, więc dla bazy „Łukasz" ≠ „łukasz".
  // Fold w JS (toLowerCase) uznawał je za jedno i zwracał ambiguous_recipient —
  // wysyłka do POPRAWNIE istniejącego członka była odrzucana.
  addMember('Łukasz');
  const msg = sendMessage({ from_user: 'kacper', to_user: 'Łukasz', type: 'task', title: 'T' });

  assert.strictEqual(msg.to_user, 'Łukasz');
  assert.strictEqual(getMessage(msg.id).to_user, 'Łukasz');
});

test('sendMessage: ASCII-owa wielkość liter przy nicku z ogonkiem nadal się składa', () => {
  // Część ASCII foldu ma działać jak wcześniej: „lukASZ" → „lukasz".
  addMember('Lukasz');
  const msg = sendMessage({ from_user: 'kacper', to_user: 'lukASZ', type: 'task', title: 'T' });

  assert.strictEqual(msg.to_user, 'Lukasz');
});

test('sendMessage: nieznany adresat → InboxDbError, ZERO wierszy w inbox', () => {
  addMember('Cave');
  const before = countRows();

  assert.throws(
    () => sendMessage({ from_user: 'kacper', to_user: 'cav', type: 'task', title: 'T' }),
    (err) => err instanceof InboxDbError && err.code === 'unknown_recipient'
  );

  assert.strictEqual(countRows(), before);
});

test('sendMessage: komunikat nieznanego adresata wymienia znanych członków', () => {
  try {
    sendMessage({ from_user: 'kacper', to_user: 'cav', type: 'task', title: 'T' });
    assert.fail('powinno rzucić');
  } catch (err) {
    assert.ok(err.message.includes('kamil'), `komunikat bez listy członków: ${err.message}`);
  }
});

// ──────── pullForUser ────────

test('pullForUser: zwraca otrzymane + delegowane, oznacza pending→delivered', () => {
  // do kamila (otrzymane), status pending
  const recv = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'task', title: 'Zrób X' });
  // od kamila (delegowane przez kamila), otwarte
  sendMessage({ from_user: 'kamil', to_user: 'zenek', type: 'query', title: 'Pytanie' });
  // szum: cudza wiadomość
  sendMessage({ from_user: 'kacper', to_user: 'zenek', type: 'task', title: 'Nie moje' });

  const res = pullForUser('kamil');

  assert.strictEqual(res.user, 'kamil');
  assert.strictEqual(res.active.length, 1);
  assert.strictEqual(res.active[0].title, 'Zrób X');
  // zwracany active zachowuje oryginalny status pending (detekcja "nowe")
  assert.strictEqual(res.active[0].status, 'pending');
  assert.strictEqual(res.delegated.length, 1);
  assert.strictEqual(res.delegated[0].to_user, 'zenek');

  // ale w DB rekord już oznaczony delivered
  assert.strictEqual(getMessage(recv.id).status, 'delivered');
});

test('pullForUser: threadRows zawiera pełną nitkę otrzymanych wątków', () => {
  const root = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Q' });
  sendMessage({ from_user: 'kamil', to_user: 'a', type: 'reply', title: 'Re: Q', thread_id: root.thread_id });

  const res = pullForUser('kamil');
  const thread = res.threadRows.filter((r) => r.thread_id === root.thread_id);
  assert.strictEqual(thread.length, 2);
});

test('pullForUser: brak user → InboxDbError', () => {
  assert.throws(() => pullForUser(''), InboxDbError);
});

test('pullForUser: pusta skrzynka → puste listy, brak błędu', () => {
  const res = pullForUser('nikt');
  assert.deepStrictEqual(res.active, []);
  assert.deepStrictEqual(res.threadRows, []);
  assert.deepStrictEqual(res.delegated, []);
});

// ──────── pullForUser: delegowane a odpowiedzi (T6) ────────

test('pullForUser: query z odpowiedzią adresata znika z delegated', () => {
  const q = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'query', title: 'Pytanie' });
  sendMessage({ from_user: 'kamil', to_user: 'kacper', type: 'reply', title: 'Re: Pytanie', thread_id: q.thread_id });

  const res = pullForUser('kacper');

  assert.deepStrictEqual(res.delegated.map((r) => r.id), []);
  // to naprawa WIDOKU — rekord świadomie zostaje otwarty (dług widok↔status)
  assert.strictEqual(getMessage(q.id).status, 'pending');
});

test('pullForUser: query z WŁASNYM dopowiedzeniem nadawcy zostaje w delegated', () => {
  const q = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'query', title: 'Pytanie' });
  sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'reply', title: 'Re: Pytanie', thread_id: q.thread_id });

  const res = pullForUser('kacper');

  assert.deepStrictEqual(res.delegated.map((r) => r.id), [q.id]);
});

test('pullForUser: task z odpowiedzią adresata zostaje w delegated (domyka checkbox)', () => {
  const t = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'task', title: 'Zrób X' });
  sendMessage({ from_user: 'kamil', to_user: 'kacper', type: 'reply', title: 'Re: Zrób X', thread_id: t.thread_id });

  const res = pullForUser('kacper');

  assert.deepStrictEqual(res.delegated.map((r) => r.id), [t.id]);
});

test('pullForUser: query bez żadnej odpowiedzi zostaje w delegated', () => {
  const q = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'query', title: 'Pytanie' });

  const res = pullForUser('kacper');

  assert.deepStrictEqual(res.delegated.map((r) => r.id), [q.id]);
});

// Test SZWU: konsumentem delegated jest findOriginal ze skilla `deleguj` (reply.mjs, poza
// repo). Predykat odtworzony tu 1:1 — gdyby warunek brzmiał "istnieje jakikolwiek reply",
// własne dopowiedzenie wykasowałoby wątek i reply.mjs mówiłby "nie znalazłem otwartego wątku".
function findOriginal({ threadRows = [], delegated = [] }, threadId) {
  const fromThreads = threadRows.find(
    (r) => r.thread_id === threadId && (r.type === 'task' || r.type === 'query')
  );
  if (fromThreads) return fromThreads;
  return delegated.find((r) => r.thread_id === threadId) ?? null;
}

test('pullForUser: wątek z własnym dopowiedzeniem pozostaje znajdowalny przez findOriginal', () => {
  const q = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'query', title: 'Pytanie' });
  sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'reply', title: 'Re: Pytanie', thread_id: q.thread_id });

  const pulled = pullForUser('kacper');
  const original = findOriginal(pulled, q.thread_id);

  assert.ok(original, 'findOriginal nie znalazł wątku — reply.mjs by padł');
  assert.strictEqual(original.id, q.id);
  // adresat wyprowadzany tak jak w reply.mjs:57
  const toUser = original.from_user === pulled.user ? original.to_user : original.from_user;
  assert.strictEqual(toUser, 'kamil');
});

// ──────── markDone (wymaganie twarde #2) ────────

test('markDone: task+Zrobione → INSERT reply + status done, zwraca nitkę', () => {
  const task = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'task', title: 'Zrób X' });

  const res = markDone({ id: task.id, action: 'Zrobione', user: 'kamil' });

  assert.strictEqual(res.result, 'replied');
  assert.strictEqual(getMessage(task.id).status, 'done');
  // powstał dokładnie jeden reply 'Zrobione ✅'
  const replies = res.thread.filter((m) => m.type === 'reply');
  assert.strictEqual(replies.length, 1);
  assert.strictEqual(replies[0].content, 'Zrobione ✅');
  assert.strictEqual(replies[0].from_user, 'kamil');
  assert.strictEqual(replies[0].to_user, 'kacper');
});

test('markDone: powtórzony na done → already_done, ZERO nowych wierszy reply', () => {
  const task = sendMessage({ from_user: 'kacper', to_user: 'kamil', type: 'task', title: 'Zrób X' });
  markDone({ id: task.id, action: 'Zrobione', user: 'kamil' });

  const before = countRows();
  const res = markDone({ id: task.id, action: 'Zrobione', user: 'kamil' });
  const after = countRows();

  assert.strictEqual(res.result, 'already_done');
  assert.strictEqual(after, before); // brak nowego reply
});

test('markDone: query+Zapoznane → status done, closed', () => {
  const q = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Q' });
  const res = markDone({ id: q.id, action: 'Zapoznane', user: 'kamil' });
  assert.strictEqual(res.result, 'closed');
  assert.strictEqual(getMessage(q.id).status, 'done');
});

test('markDone: query+Zrobione → skipped (odhaczenie query to Zapoznane)', () => {
  const q = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Q' });
  const res = markDone({ id: q.id, action: 'Zrobione', user: 'kamil' });
  assert.strictEqual(res.result, 'skipped');
  assert.strictEqual(getMessage(q.id).status, 'pending');
});

test('markDone: nie moja wiadomość → skipped, brak zmiany', () => {
  const task = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'task', title: 'T' });
  const res = markDone({ id: task.id, action: 'Zrobione', user: 'ktos-inny' });
  assert.strictEqual(res.result, 'skipped');
  assert.strictEqual(getMessage(task.id).status, 'pending');
});

test('markDone: nieistniejące id → not_found', () => {
  const res = markDone({ id: 'brak-takiego', action: 'Zapoznane', user: 'kamil' });
  assert.strictEqual(res.result, 'not_found');
});

test('markDone: nieznana akcja → InboxDbError', () => {
  const q = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Q' });
  assert.throws(() => markDone({ id: q.id, action: 'Cokolwiek', user: 'kamil' }), InboxDbError);
});

// ──────── claimQuery (atomowość) ────────

test('claimQuery: dwa wywołania → drugie dostaje null (atomowość)', () => {
  sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Q' });

  const first = claimQuery('kamil');
  const second = claimQuery('kamil');

  assert.notStrictEqual(first, null);
  assert.strictEqual(first.title, 'Q');
  assert.strictEqual(second, null);
});

test('claimQuery: ustawia marker auto_reply_attempted w payloadzie', () => {
  const q = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Q' });
  const claimed = claimQuery('kamil');
  assert.ok(claimed.payload.auto_reply_attempted, 'marker ustawiony');
  // marker trwały w DB
  assert.ok(getMessage(q.id).payload.auto_reply_attempted);
});

test('claimQuery: query z istniejącym reply nie jest podejmowane', () => {
  const root = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Q' });
  sendMessage({ from_user: 'kamil', to_user: 'a', type: 'reply', title: 'Re: Q', thread_id: root.thread_id });

  assert.strictEqual(claimQuery('kamil'), null);
});

test('claimQuery: brak kandydatów → null (error/empty case)', () => {
  assert.strictEqual(claimQuery('kamil'), null);
});

test('claimQuery: brak user → InboxDbError', () => {
  assert.throws(() => claimQuery(''), InboxDbError);
});

test('claimQuery: preferuje najstarsze query', () => {
  const older = sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Starsze' });
  sendMessage({ from_user: 'a', to_user: 'kamil', type: 'query', title: 'Nowsze' });
  const claimed = claimQuery('kamil');
  assert.strictEqual(claimed.id, older.id);
});

// ──────── CRUD członków ────────

test('addMember: zwraca pełny token, dane członka', () => {
  const m = addMember('nowy');
  assert.strictEqual(m.name, 'nowy');
  assert.strictEqual(typeof m.token, 'string');
  assert.strictEqual(m.token.length, 64); // 32 bajty hex
});

test('addMember: duplikat nazwy → InboxDbError', () => {
  assert.throws(() => addMember('kacper'), InboxDbError);
});

test('addMember: duplikat różniący się wielkością liter → InboxDbError (COLLATE NOCASE)', () => {
  addMember('Cave');
  assert.throws(() => addMember('cave'), InboxDbError);
  assert.strictEqual(listMembers().filter((m) => m.name.toLowerCase() === 'cave').length, 1);
});

test('addMember: brak nazwy → InboxDbError', () => {
  assert.throws(() => addMember(''), InboxDbError);
});

test('listMembers: zwraca dodanych członków', () => {
  addMember('nowy1');
  addMember('nowy2');
  assert.deepStrictEqual(listMembers().map((m) => m.name), [...CAST, 'nowy1', 'nowy2']);
});

test('getMemberByToken: rozwiązuje tożsamość z tokenu', () => {
  const m = addMember('nowy');
  const found = getMemberByToken(m.token);
  assert.strictEqual(found.name, 'nowy');
});

test('getMemberByToken: nieznany token → null', () => {
  assert.strictEqual(getMemberByToken('nieznany'), null);
  assert.strictEqual(getMemberByToken(''), null);
});

test('revokeMember: kasuje członka, zwraca true; ponowne → false', () => {
  const m = addMember('nowy');
  assert.strictEqual(revokeMember(m.id), true);
  assert.strictEqual(getMemberByToken(m.token), null);
  assert.strictEqual(revokeMember(m.id), false);
});

// ──────── Migracja members → COLLATE NOCASE ────────

// Legacy schemat (sprzed migracji): members.name UNIQUE bez kolacji. Własne połączenie,
// niezależne od stanu modułu — migrate() przyjmuje db jako argument.
function legacyDb(names = [], target = ':memory:') {
  const db = new DatabaseSync(target);
  db.exec(`
    CREATE TABLE members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  names.forEach((name, i) => {
    db.prepare('INSERT INTO members (name, token, created_at) VALUES (?, ?, ?)').run(name, `tok-${i}`, '2026-08-05T00:00:00.000Z');
  });
  return db;
}

test('migrate: legacy members bez NOCASE → tabela przepisana, dane zachowane', () => {
  const db = legacyDb(['Cave', 'kacper']);
  assert.strictEqual(inboxDb.needsMembersNocaseRebuild(db), true);

  inboxDb.migrate(db);

  assert.strictEqual(inboxDb.needsMembersNocaseRebuild(db), false);
  const rows = db.prepare('SELECT id, name, token FROM members ORDER BY id').all();
  assert.deepStrictEqual(rows.map((r) => r.name), ['Cave', 'kacper']);
  assert.deepStrictEqual(rows.map((r) => r.token), ['tok-0', 'tok-1']);
  // Kolacja działa: duplikat po wielkości liter jest odrzucany przez indeks UNIQUE.
  assert.throws(() =>
    db.prepare('INSERT INTO members (name, token, created_at) VALUES (?, ?, ?)').run('cave', 'tok-x', 'now')
  );
  db.close();
});

test('migrate: kolizja "Cave" + "cave" → ostrzeżenie z obiema nazwami i poleceniem, baza nietknięta, migracja NIE rzuca', () => {
  const db = legacyDb(['Cave', 'cave']);
  const warnings = [];

  // Kontrakt: migrate() NIE rzuca — biegnie w getInboxDb() przy KAŻDEJ operacji, więc rzut
  // zabijałby całą skrzynkę razem z lekarstwem (listMembers/revokeMember).
  inboxDb.migrate(db, (msg) => warnings.push(msg));

  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('"Cave" + "cave"'), `ostrzeżenie bez obu nazw: ${warnings[0]}`);
  // Komunikat MUSI być wykonywalny poza aplikacją (log daemona czyta człowiek).
  assert.ok(warnings[0].includes('sqlite3 data/inbox.db'), `ostrzeżenie bez polecenia naprawczego: ${warnings[0]}`);

  // Dane bez zmian, schemat wciąż legacy (żadnego cichego scalenia).
  assert.deepStrictEqual(db.prepare('SELECT name FROM members ORDER BY id').all().map((r) => r.name), ['Cave', 'cave']);
  assert.strictEqual(inboxDb.needsMembersNocaseRebuild(db), true);
  db.close();
});

test('migracja: para różniąca się TYLKO polskim znakiem NIE jest kolizją — UNIQUE NOCASE jej nie odrzuci', () => {
  // Detekcja kolizji musi używać tej samej kolacji, którą nakładamy na kolumnę.
  // Fold w JS uznawał „Łukasz"/„łukasz" za duplikat i blokował migrację bez powodu —
  // schemat zostawał legacy, a komunikat kazał usuwać członka, którego usuwać nie trzeba.
  const db = legacyDb(['Łukasz', 'łukasz']);
  const warnings = [];

  inboxDb.migrate(db, (msg) => warnings.push(msg));

  assert.deepStrictEqual(warnings, [], 'to nie jest kolizja dla SQLite');
  assert.strictEqual(inboxDb.needsMembersNocaseRebuild(db), false, 'migracja musi się domknąć');
  assert.deepStrictEqual(
    db.prepare('SELECT name FROM members ORDER BY id').all().map((r) => r.name),
    ['Łukasz', 'łukasz'],
    'obie nazwy zachowane'
  );
  db.close();
});

test('kolizja nazw w żywej bazie: getInboxDb() otwiera skrzynkę, listMembers/revokeMember działają, send do kolidującej nazwy odrzucony', () => {
  // Szew, którego testy migrate(db) na własnym połączeniu nie dotykały: PRAWDZIWA ścieżka
  // getInboxDb() → migrate(). Dawniej rzut z migrate() dawał 500 na każdym żądaniu skrzynki.
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-collision-')), 'inbox.db');
  legacyDb(['Cave', 'cave'], dbFile).close();

  close();
  setInboxDbPath(dbFile);

  assert.deepStrictEqual(listMembers().map((m) => m.name), ['Cave', 'cave'], 'skrzynka musi się otworzyć mimo kolizji');

  // Dopóki duplikat istnieje, wysyłka do kolidującej nazwy jest odrzucana — nie zgadujemy adresata.
  assert.throws(
    () => sendMessage({ from_user: 'Cave', to_user: 'cave', type: 'task', title: 'T' }),
    (err) => err instanceof InboxDbError && err.code === 'ambiguous_recipient'
  );

  // ...ale lekarstwo jest osiągalne przez aplikację (dawniej revokeMember też rzucał z migrate).
  const doomed = listMembers().find((m) => m.name === 'cave');
  assert.strictEqual(revokeMember(doomed.id), true);
});

test('migrate: idempotentna — drugi przebieg nie przepisuje tabeli members', () => {
  const db = legacyDb(['Cave']);
  inboxDb.migrate(db);
  const sqlAfterFirst = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'").get().sql;
  const idAfterFirst = db.prepare('SELECT id FROM members WHERE name = ?').get('Cave').id;

  assert.strictEqual(inboxDb.needsMembersNocaseRebuild(db), false); // guard: brak rebuildu
  inboxDb.migrate(db);

  const sqlAfterSecond = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'").get().sql;
  assert.strictEqual(sqlAfterSecond, sqlAfterFirst);
  assert.strictEqual(db.prepare('SELECT id FROM members WHERE name = ?').get('Cave').id, idAfterFirst);
  db.close();
});

// ──────── getThread ────────

test('getThread: zwraca wiadomości chronologicznie, payload jako obiekt', () => {
  const root = sendMessage({ from_user: 'a', to_user: 'b', type: 'query', title: 'Q', payload: { k: 1 } });
  sendMessage({ from_user: 'b', to_user: 'a', type: 'reply', title: 'Re: Q', thread_id: root.thread_id });

  const thread = getThread(root.thread_id);
  assert.strictEqual(thread.length, 2);
  assert.strictEqual(thread[0].type, 'query');
  assert.strictEqual(thread[0].payload.k, 1);
  assert.strictEqual(thread[1].type, 'reply');
});
