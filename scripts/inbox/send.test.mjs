// Testy komendy `send` (repo-wersja — zastąpiła kopię w vaultcie, nieobjętą npm test).
// Mockowany wyłącznie hub (klient); walidacja argumentów i kształt wyjścia testowane naprawdę.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { main, parseArgs } from './send.mjs';

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

function fakeClient() {
  const calls = [];
  return {
    calls,
    send: async (body) => {
      calls.push(body);
      return { message: { id: 'id-1', thread_id: body.thread_id ?? 'id-1', created_at: 'T', to_user: body.to_user, title: body.title, type: body.type } };
    },
  };
}

function argv(...pairs) {
  return ['node', 'send.mjs', ...pairs];
}

test('send: happy path — body dla huba i kształt wyjścia', async () => {
  const client = fakeClient();
  const out = await main({ client, argv: argv('--to', 'Cave', '--title', 'Baner', '--type', 'task', '--content', 'treść') });

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { to_user: 'Cave', type: 'task', title: 'Baner', content: 'treść', thread_id: null });
  assert.equal(out.to_user, 'Cave');
  assert.equal(out.type, 'task');
});

test('send: brak --type = twardy błąd (query nie może cicho stać się taskiem)', async () => {
  const client = fakeClient();
  await assert.rejects(main({ client, argv: argv('--to', 'Cave', '--title', 'X') }), /Missing --type/);
  await assert.rejects(main({ client, argv: argv('--to', 'Cave', '--title', 'X', '--type', 'zly') }), /Invalid --type/);
  assert.equal(client.calls.length, 0); // walidacja PRZED żądaniem do huba
});

test('parseArgs: pary --klucz wartość, ostatnie wystąpienie wygrywa', () => {
  assert.deepEqual(parseArgs(['n', 's', '--to', 'a', '--to', 'b']), { to: 'b' });
});
