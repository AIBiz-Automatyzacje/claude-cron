// Testy komendy `close` — domknięcie wątku przez hub PLUS zapis nitki do archiwum.
// Świadomie testujemy SZEW (hub ↔ plik) w jednym przebiegu: to jego brak przepuścił
// bug, w którym `close` kasował wątek ze Skrzynki, a archiwum zostawało puste.
// Mockowany jest wyłącznie hub (klient); archiwum pisze prawdziwy `appendToArchive`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main, parseArgs } from './close.mjs';

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
      return { v: 1, result: 'closed', thread: state.map((r) => ({ ...r })) };
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

  assert.deepEqual(hub.calls.done, [{ id: MSG_ID, action: 'Zapoznane' }]);
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
