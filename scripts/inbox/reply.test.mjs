// Testy komendy `reply` (repo-wersja): wyprowadzanie adresata z wątku + fallback --to.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main, findOriginal, autoClose } from './reply.mjs';

const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let savedEnv;
let archiveDir;
beforeEach(() => {
  savedEnv = { url: process.env.INBOX_HUB_URL, token: process.env.INBOX_TOKEN, archive: process.env.INBOX_ARCHIVE_DIR };
  process.env.INBOX_HUB_URL = 'https://hub.example';
  process.env.INBOX_TOKEN = 'tok';
  // Auto-domknięcie po odpowiedzi pisze archiwum — ZAWSZE do tmp, nigdy do prawdziwego
  // vaulta z CLAUDE_CRON_WORKSPACE sesji, w której odpalono testy.
  archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-reply-archive-'));
  process.env.INBOX_ARCHIVE_DIR = archiveDir;
});
afterEach(() => {
  if (savedEnv.url === undefined) delete process.env.INBOX_HUB_URL;
  else process.env.INBOX_HUB_URL = savedEnv.url;
  if (savedEnv.token === undefined) delete process.env.INBOX_TOKEN;
  else process.env.INBOX_TOKEN = savedEnv.token;
  if (savedEnv.archive === undefined) delete process.env.INBOX_ARCHIVE_DIR;
  else process.env.INBOX_ARCHIVE_DIR = savedEnv.archive;
  fs.rmSync(archiveDir, { recursive: true, force: true });
});

function fakeClient(pulled, { failUploadOn = null } = {}) {
  const sends = [];
  const uploads = [];
  const dones = [];
  return {
    sends,
    uploads,
    dones,
    done: async ({ id, action }) => {
      dones.push({ id, action });
      return { v: 1, result: 'closed' };
    },
    // Alias na `sends` — testy załączników są lustrem send.test.mjs (ta sama nazwa pola).
    get calls() {
      return sends;
    },
    uploadBlob: async (sha256, filePath) => {
      uploads.push({ sha256, filePath });
      if (failUploadOn !== null && uploads.length === failUploadOn) throw new Error('upload padł');
      return { v: 1, sha256, deduped: false };
    },
    pull: async () => pulled,
    send: async (body) => {
      sends.push(body);
      return { message: { id: 'r-1', thread_id: body.thread_id, created_at: 'T', to_user: body.to_user, title: body.title, type: body.type } };
    },
  };
}

function argv(...pairs) {
  return ['node', 'reply.mjs', ...pairs];
}

test('reply na cudze query → adresat = nadawca oryginału, tytuł Re:', async () => {
  const client = fakeClient({
    user: 'kacper',
    threadRows: [{ thread_id: THREAD, type: 'query', from_user: 'Cave', to_user: 'kacper', title: 'Pytanie' }],
    delegated: [],
  });
  const out = await main({ client, argv: argv('--thread-id', THREAD, '--content', 'Odpowiadam') });

  assert.equal(client.sends[0].to_user, 'Cave');
  assert.equal(client.sends[0].type, 'reply');
  assert.equal(out.title, 'Re: Pytanie');
});

test('reply we WŁASNYM wątku (dopowiedzenie) → adresat = odbiorca oryginału, nie ja', async () => {
  const client = fakeClient({
    user: 'kacper',
    threadRows: [],
    delegated: [{ thread_id: THREAD, type: 'task', from_user: 'kacper', to_user: 'Cave', title: 'Baner' }],
  });
  await main({ client, argv: argv('--thread-id', THREAD, '--content', 'Doprecyzowuję') });

  assert.equal(client.sends[0].to_user, 'Cave'); // nie odsyłamy wiadomości samemu sobie
});

test('wątek nieznaleziony bez --to → czytelny błąd z podpowiedzią, zero wysyłki', async () => {
  const client = fakeClient({ user: 'kacper', threadRows: [], delegated: [] });
  await assert.rejects(
    main({ client, argv: argv('--thread-id', THREAD, '--content', 'X') }),
    /podaj adresata jawnie: --to/,
  );
  assert.equal(client.sends.length, 0);
});

test('wątek nieznaleziony Z --to → wysyłka idzie na wskazanego adresata', async () => {
  const client = fakeClient({ user: 'kacper', threadRows: [], delegated: [] });
  await main({ client, argv: argv('--thread-id', THREAD, '--content', 'X', '--to', 'Cave') });
  assert.equal(client.sends[0].to_user, 'Cave');
  assert.equal(client.sends[0].title, 'Re: (wątek)');
});

test('findOriginal: nitki przychodzące wygrywają z delegacjami; reply nie jest oryginałem', () => {
  const rows = { threadRows: [{ thread_id: THREAD, type: 'reply' }, { thread_id: THREAD, type: 'task', from_user: 'a' }], delegated: [{ thread_id: THREAD, from_user: 'b' }] };
  assert.equal(findOriginal(rows, THREAD).from_user, 'a');
  assert.equal(findOriginal({ threadRows: [], delegated: [] }, THREAD), null);
});

// ──────── --attach (IU-5): lustro send.test.mjs ────────
// Obie komendy mają dzielić ścieżkę załączników, więc obie muszą mieć tę samą siatkę testów:
// literówka w nazwie argumentu (args.attachments zamiast args.attach) daje zieloną suitę
// i odpowiedź BEZ plików — cichy rozjazd, którego nikt nie wykryje po stronie send.

function tmpFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('reply: --attach → bajty lecą przed wiadomością, metadane w body huba', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-reply-'));
  try {
    const a = tmpFile(dir, 'zalacznik.pdf', 'A');
    const client = fakeClient({
      user: 'kacper',
      threadRows: [{ thread_id: THREAD, type: 'query', from_user: 'Cave', to_user: 'kacper', title: 'Pytanie' }],
      delegated: [],
    });

    await main({ client, argv: argv('--thread-id', THREAD, '--content', 'Odpowiadam', '--attach', a) });

    assert.equal(client.uploads.length, 1);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].attachments.length, 1);
    assert.equal(client.calls[0].attachments[0].filename, 'zalacznik.pdf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reply: pad uploadu → client.send NIE jest wołany w ogóle (R2)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-reply-'));
  try {
    const a = tmpFile(dir, 'a.txt', 'A');
    const client = fakeClient(
      {
        user: 'kacper',
        threadRows: [{ thread_id: THREAD, type: 'query', from_user: 'Cave', to_user: 'kacper', title: 'Pytanie' }],
        delegated: [],
      },
      { failUploadOn: 1 }
    );

    await assert.rejects(
      main({ client, argv: argv('--thread-id', THREAD, '--content', 'X', '--attach', a) }),
      /upload padł/
    );
    assert.equal(client.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reply: bez --attach body huba nie dostaje pola attachments', async () => {
  const client = fakeClient({
    user: 'kacper',
    threadRows: [{ thread_id: THREAD, type: 'query', from_user: 'Cave', to_user: 'kacper', title: 'Pytanie' }],
    delegated: [],
  });
  await main({ client, argv: argv('--thread-id', THREAD, '--content', 'X') });
  assert.equal('attachments' in client.calls[0], false);
});

// ──────── odpowiedź = przeczytane (auto-domknięcie wątku) ────────

test('reply domyka moje otwarte wiadomości w wątku akcją Zapoznane — także task — i archiwizuje nitkę', async () => {
  const client = fakeClient({
    user: 'kacper',
    threadRows: [
      { id: 't-1', thread_id: THREAD, type: 'task', from_user: 'Filip', to_user: 'kacper', title: 'Zmiany', status: 'done' },
      { id: 'r-a', thread_id: THREAD, type: 'reply', from_user: 'Filip', to_user: 'kacper', title: 'Re: Zmiany', status: 'delivered' },
      { id: 't-2', thread_id: THREAD, type: 'task', from_user: 'Filip', to_user: 'kacper', title: 'Drugie', status: 'delivered' },
      { id: 'r-b', thread_id: THREAD, type: 'reply', from_user: 'kacper', to_user: 'Filip', title: 'Re: Zmiany', status: 'delivered' },
    ],
    delegated: [],
  });

  const out = await main({ client, argv: argv('--thread-id', THREAD, '--content', 'Wgrane') });

  // Tylko otwarte i zaadresowane do mnie; zero „Zrobione" (nadawca dostał już odpowiedź).
  assert.deepEqual(client.dones, [
    { id: 'r-a', action: 'Zapoznane' },
    { id: 't-2', action: 'Zapoznane' },
  ]);
  assert.deepEqual(out.auto_close, { closed: 2, archived: true });
  assert.equal(fs.readdirSync(archiveDir).length, 1);
});

test('reply bez otwartych wiadomości do mnie → zero domknięć i zero archiwum', async () => {
  const client = fakeClient({
    user: 'kacper',
    threadRows: [],
    delegated: [{ thread_id: THREAD, type: 'task', from_user: 'kacper', to_user: 'Cave', title: 'Baner' }],
  });
  const out = await main({ client, argv: argv('--thread-id', THREAD, '--content', 'Doprecyzowuję') });

  assert.equal(client.dones.length, 0);
  assert.equal(out.auto_close.closed, 0);
  assert.equal(fs.readdirSync(archiveDir).length, 0);
});

test('autoClose bez katalogu archiwum → nie domyka (wątek nie może zniknąć bez kopii)', async () => {
  const client = fakeClient({ user: 'kacper', threadRows: [], delegated: [] });
  const res = await autoClose({ client, threadId: THREAD, env: {} });
  assert.equal(res.closed, 0);
  assert.match(res.skipped, /CLAUDE_CRON_WORKSPACE/);
  assert.equal(client.dones.length, 0);
});

test('pad domknięcia po wysłanej odpowiedzi → main NIE rzuca, błąd ląduje w wyniku', async () => {
  const client = fakeClient({
    user: 'kacper',
    threadRows: [{ id: 'q-1', thread_id: THREAD, type: 'query', from_user: 'Cave', to_user: 'kacper', title: 'Pytanie' }],
    delegated: [],
  });
  client.done = async () => { throw new Error('hub 503'); };

  const out = await main({ client, argv: argv('--thread-id', THREAD, '--content', 'Odpowiadam') });

  assert.equal(client.sends.length, 1);
  assert.equal(out.auto_close.closed, 0);
  assert.match(out.auto_close.error, /hub 503/);
});
