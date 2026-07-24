const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

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

// Świeża baza :memory: przed każdym testem — getInboxDb() otwiera leniwie przy 1. operacji.
beforeEach(() => {
  close();
  setInboxDbPath(':memory:');
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
  const m = addMember('kacper');
  assert.strictEqual(m.name, 'kacper');
  assert.strictEqual(typeof m.token, 'string');
  assert.strictEqual(m.token.length, 64); // 32 bajty hex
});

test('addMember: duplikat nazwy → InboxDbError', () => {
  addMember('kacper');
  assert.throws(() => addMember('kacper'), InboxDbError);
});

test('addMember: brak nazwy → InboxDbError', () => {
  assert.throws(() => addMember(''), InboxDbError);
});

test('listMembers: zwraca dodanych członków', () => {
  addMember('kacper');
  addMember('kamil');
  const list = listMembers();
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map((m) => m.name), ['kacper', 'kamil']);
});

test('getMemberByToken: rozwiązuje tożsamość z tokenu', () => {
  const m = addMember('kacper');
  const found = getMemberByToken(m.token);
  assert.strictEqual(found.name, 'kacper');
});

test('getMemberByToken: nieznany token → null', () => {
  assert.strictEqual(getMemberByToken('nieznany'), null);
  assert.strictEqual(getMemberByToken(''), null);
});

test('revokeMember: kasuje członka, zwraca true; ponowne → false', () => {
  const m = addMember('kacper');
  assert.strictEqual(revokeMember(m.id), true);
  assert.strictEqual(getMemberByToken(m.token), null);
  assert.strictEqual(revokeMember(m.id), false);
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
