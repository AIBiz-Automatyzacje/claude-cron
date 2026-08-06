// Testy komendy `close` — domknięcie wątku przez hub PLUS zapis nitki do archiwum.
// Świadomie testujemy SZEW (hub ↔ plik) w jednym przebiegu: to jego brak przepuścił
// bug, w którym `close` kasował wątek ze Skrzynki, a archiwum zostawało puste.
// Mockowany jest wyłącznie hub (klient); archiwum pisze prawdziwy `appendToArchive`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main, parseArgs, MISSING_WORKSPACE_MESSAGE } from './close.mjs';

const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MSG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(over = {}) {
  return {
    id: MSG_ID,
    thread_id: THREAD,
    from_user: 'marcin',
    to_user: 'kacper',
    type: 'task',
    title: 'Baner na live sierpniowy',
    content: 'Potrzebuję baner 1920x1080.',
    status: 'delivered',
    created_at: '2026-08-05T07:12:00.000Z',
    ...over,
  };
}

// Atrapa huba: trzyma wiersze w pamięci, `done` przestawia status i zwraca całą nitkę
// (tak jak prawdziwy hub), więc powtórzony `close` widzi już zamknięty wątek.
function fakeHub(rows) {
  const state = rows.map((r) => ({ ...r }));
  const calls = { pull: 0, done: [] };
  return {
    calls,
    async pull() {
      calls.pull += 1;
      return { v: 1, user: 'kacper', threadRows: state.map((r) => ({ ...r })) };
    },
    async done({ id, action }) {
      calls.done.push({ id, action });
      const target = state.find((r) => r.id === id);
      if (!target) return { v: 1, result: 'not_found' };
      if (target.status === 'done') return { v: 1, result: 'already_done' };
      target.status = 'done';
      // Wierność atrapy jest tu kontraktem, nie kosmetyką: prawdziwy hub (`markDone`
      // w lib/inbox-db.js) zwraca 'replied' dla task+Zrobione i 'closed' dla Zapoznane.
      // Atrapa zwracająca 'closed' na wszystko ukrywała błąd liczenia w close.mjs.
      const result = action === 'Zrobione' ? 'replied' : 'closed';
      return { v: 1, result, thread: state.map((r) => ({ ...r })) };
    },
  };
}

async function withEnv(archiveDir) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-close-'));
  // Ścieżki podane jawnie = loadEnv nie potrzebuje workspace'u ani prawdziwego sekretu.
  process.env.INBOX_ENV_FILE = path.join(tmp, 'brak-inbox.env');
  process.env.INBOX_TODO_PATH = path.join(tmp, 'Dashboard.md');
  process.env.INBOX_SKRZYNKA_PATH = path.join(tmp, 'Skrzynka.md');
  process.env.INBOX_ARCHIVE_DIR = archiveDir ?? path.join(tmp, 'inbox-archive');
  return tmp;
}

test('parseArgs: --thread-id trafia do obiektu argumentów', () => {
  assert.deepEqual(parseArgs(['node', 'close.mjs', '--thread-id', THREAD]), { 'thread-id': THREAD });
});

test('close na otwartym wątku: hub dostaje done ORAZ nitka trafia do pliku miesiąca', async () => {
  const tmp = await withEnv();
  const hub = fakeHub([row()]);

  const out = await main({ client: hub, argv: ['node', 'close.mjs', '--thread-id', THREAD] });

  // `Zrobione`, nie `Zapoznane`: task zdelegowany przez drugą osobę domykany bez reply
  // znikał nadawcy z widoku „Delegowane" (filtr `status != 'done'`) bez ŻADNEGO sygnału.
  assert.deepEqual(hub.calls.done, [{ id: MSG_ID, action: 'Zrobione' }]);
  assert.equal(out.closed, 1);
  assert.equal(out.archived, true);

  const files = await fs.readdir(process.env.INBOX_ARCHIVE_DIR);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}\.md$/);
  const content = await fs.readFile(path.join(process.env.INBOX_ARCHIVE_DIR, files[0]), 'utf8');
  assert.ok(content.includes('Baner na live sierpniowy'));
  assert.ok(content.includes('Potrzebuję baner 1920x1080.'));
  assert.ok(content.includes('by @kacper_'));

  await fs.rm(tmp, { recursive: true, force: true });
});

test('close powtórzony: closed 0 i ANI JEDNEGO dodatkowego wpisu w archiwum (idempotencja)', async () => {
  const tmp = await withEnv();
  const hub = fakeHub([row()]);
  const argv = ['node', 'close.mjs', '--thread-id', THREAD];

  await main({ client: hub, argv });
  const file = path.join(process.env.INBOX_ARCHIVE_DIR, (await fs.readdir(process.env.INBOX_ARCHIVE_DIR))[0]);
  const afterFirst = await fs.readFile(file, 'utf8');

  const second = await main({ client: hub, argv });

  assert.equal(second.closed, 0);
  assert.equal(second.archived, false);
  // Drugie wywołanie nie wysyła nawet żądania `done` — wątek jest już domknięty.
  assert.equal(hub.calls.done.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), afterFirst);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('close na wątku bez wiadomości do mnie: czytelna nota i zero zapisu (error case)', async () => {
  const tmp = await withEnv();
  // Wiadomość w wątku jest zaadresowana do kogoś innego — hub odrzuciłby jej domknięcie.
  const hub = fakeHub([row({ to_user: 'marcin', from_user: 'kacper' })]);

  const out = await main({ client: hub, argv: ['node', 'close.mjs', '--thread-id', THREAD] });

  assert.equal(out.closed, 0);
  assert.equal(out.archived, false);
  assert.match(out.note, /Brak otwartych wiadomości do mnie/);
  assert.equal(hub.calls.done.length, 0);
  await assert.rejects(() => fs.readdir(process.env.INBOX_ARCHIVE_DIR), /ENOENT/);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('pad zapisu archiwum: błąd propaguje się z main, nie ciche powodzenie (error case)', async () => {
  const blocker = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-close-blk-'));
  const filePosingAsDir = path.join(blocker, 'nie-katalog');
  await fs.writeFile(filePosingAsDir, 'to jest plik, nie katalog', 'utf8');

  const tmp = await withEnv(path.join(filePosingAsDir, 'inbox-archive'));
  const hub = fakeHub([row()]);

  await assert.rejects(
    () => main({ client: hub, argv: ['node', 'close.mjs', '--thread-id', THREAD] }),
    (e) => e instanceof Error && /ENOTDIR|EEXIST|ENOENT/.test(e.code || e.message)
  );

  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(blocker, { recursive: true, force: true });
});

test('close na query: akcja Zapoznane — nikt nie czeka na potwierdzenie wykonania', async () => {
  const tmp = await withEnv();
  const hub = fakeHub([row({ type: 'query', title: 'Czy live idzie w czwartek?' })]);

  await main({ client: hub, argv: ['node', 'close.mjs', '--thread-id', THREAD] });

  assert.deepEqual(hub.calls.done, [{ id: MSG_ID, action: 'Zapoznane' }]);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('close na task: hub odpowiada "replied", a raport MUSI liczyć to jako domknięte', async () => {
  // Regresja: liczyliśmy wyłącznie 'closed', więc poprawnie zamknięte ZADANIE
  // raportowało `closed: 0` — nieodróżnialnie od „nic się nie stało".
  const tmp = await withEnv();
  const hub = fakeHub([row({ type: 'task', title: 'Nagraj lekcję o n8n' })]);

  const out = await main({ client: hub, argv: ['node', 'close.mjs', '--thread-id', THREAD] });

  assert.deepEqual(hub.calls.done, [{ id: MSG_ID, action: 'Zrobione' }]);
  assert.equal(out.closed, 1, 'task domknięty przez hub musi być policzony');
  assert.equal(out.archived, true);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('wątek z DWIEMA moimi wiadomościami: done per wiadomość, archiwum RAZ na wątek', async () => {
  const tmp = await withEnv();
  const SECOND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hub = fakeHub([
    row(),
    row({ id: SECOND_ID, type: 'reply', title: 'Baner na live sierpniowy', content: 'Dorzucam wymiary.' }),
  ]);

  const out = await main({ client: hub, argv: ['node', 'close.mjs', '--thread-id', THREAD] });

  assert.equal(hub.calls.done.length, 2);
  assert.deepEqual(
    hub.calls.done.map((c) => c.id).sort(),
    [MSG_ID, SECOND_ID].sort()
  );
  assert.equal(out.closed, 2);

  // Regresja „appendToArchive w pętli" dołożyłaby całą nitkę N razy — tytuł wątku
  // ma wystąpić DOKŁADNIE raz, mimo dwóch domkniętych wiadomości.
  const files = await fs.readdir(process.env.INBOX_ARCHIVE_DIR);
  assert.equal(files.length, 1);
  const content = await fs.readFile(path.join(process.env.INBOX_ARCHIVE_DIR, files[0]), 'utf8');
  assert.equal(content.split('**Zadanie:** Baner na live sierpniowy').length - 1, 1);
  // Obie wiadomości nitki są w tym jednym wpisie.
  assert.ok(content.includes('Dorzucam wymiary.'));

  await fs.rm(tmp, { recursive: true, force: true });
});

test('pad huba PO zapisie archiwum: nitka jest już w pliku miesiąca (odwracalność)', async () => {
  const tmp = await withEnv();
  const hub = fakeHub([row()]);
  hub.done = async () => { throw new Error('hub 503'); };

  await assert.rejects(
    () => main({ client: hub, argv: ['node', 'close.mjs', '--thread-id', THREAD] }),
    /hub 503/
  );

  // Kolejność „archiwum przed hubem" znaczy, że pad domknięcia zostawia wątek
  // W SKRZYNCE i JEDNOCZEŚNIE w archiwum — powtórka `close` jest bezpieczna.
  const files = await fs.readdir(process.env.INBOX_ARCHIVE_DIR);
  assert.equal(files.length, 1);
  const content = await fs.readFile(path.join(process.env.INBOX_ARCHIVE_DIR, files[0]), 'utf8');
  assert.ok(content.includes('Baner na live sierpniowy'));

  await fs.rm(tmp, { recursive: true, force: true });
});

test('brak CLAUDE_CRON_WORKSPACE: komunikat kieruje do instalatora, nie do .env w vaulcie', async () => {
  const snapshot = {
    INBOX_ENV_FILE: process.env.INBOX_ENV_FILE,
    INBOX_TODO_PATH: process.env.INBOX_TODO_PATH,
    INBOX_SKRZYNKA_PATH: process.env.INBOX_SKRZYNKA_PATH,
    INBOX_ARCHIVE_DIR: process.env.INBOX_ARCHIVE_DIR,
    CLAUDE_CRON_WORKSPACE: process.env.CLAUDE_CRON_WORKSPACE,
  };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-close-nows-'));
  process.env.INBOX_ENV_FILE = path.join(tmp, 'brak-inbox.env');
  for (const key of ['INBOX_TODO_PATH', 'INBOX_SKRZYNKA_PATH', 'INBOX_ARCHIVE_DIR', 'CLAUDE_CRON_WORKSPACE']) {
    delete process.env[key];
  }

  await assert.rejects(
    () => main({ client: fakeHub([row()]), argv: ['node', 'close.mjs', '--thread-id', THREAD] }),
    (e) => e.message === MISSING_WORKSPACE_MESSAGE
  );
  assert.match(MISSING_WORKSPACE_MESSAGE, /instalator/i);
  assert.doesNotMatch(MISSING_WORKSPACE_MESSAGE, /\.env/);

  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

test('brak --thread-id: rzuca instrukcję użycia zamiast milczeć (error case)', async () => {
  const tmp = await withEnv();
  const hub = fakeHub([row()]);
  await assert.rejects(
    () => main({ client: hub, argv: ['node', 'close.mjs'] }),
    /Usage: close\.mjs --thread-id/
  );
  assert.equal(hub.calls.pull, 0);
  await fs.rm(tmp, { recursive: true, force: true });
});
