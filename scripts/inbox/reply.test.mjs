// Testy komendy `reply` (repo-wersja): wyprowadzanie adresata z wątku + fallback --to.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { main, findOriginal } from './reply.mjs';

const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let savedEnv;
beforeEach(() => {
  savedEnv = { url: process.env.INBOX_HUB_URL, token: process.env.INBOX_TOKEN };
  process.env.INBOX_HUB_URL = 'https://hub.example';
  process.env.INBOX_TOKEN = 'tok';
});
afterEach(() => {
  if (savedEnv.url === undefined) delete process.env.INBOX_HUB_URL;
  else process.env.INBOX_HUB_URL = savedEnv.url;
  if (savedEnv.token === undefined) delete process.env.INBOX_TOKEN;
  else process.env.INBOX_TOKEN = savedEnv.token;
});

function fakeClient(pulled) {
  const sends = [];
  return {
    sends,
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
