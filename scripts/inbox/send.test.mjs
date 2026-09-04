// Testy komendy `send` (repo-wersja — zastąpiła kopię w vaultcie, nieobjętą npm test).
// Mockowany wyłącznie hub (klient); walidacja argumentów i kształt wyjścia testowane naprawdę.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function fakeClient({ failUploadOn = null } = {}) {
  const calls = [];
  const uploads = [];
  return {
    calls,
    uploads,
    uploadBlob: async (sha256, filePath) => {
      uploads.push({ sha256, filePath });
      if (failUploadOn !== null && uploads.length === failUploadOn) throw new Error('upload padł');
      return { v: 1, sha256, deduped: false };
    },
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

// ──────── --attach (IU-5) ────────

function tmpFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('send: dwa --attach → dwa rekordy metadanych w jednej wiadomości', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-send-'));
  try {
    const a = tmpFile(dir, 'a.pdf', 'A');
    const b = tmpFile(dir, 'b.png', 'B');
    const client = fakeClient();

    await main({ client, argv: argv('--to', 'Cave', '--title', 'T', '--type', 'task', '--attach', a, '--attach', b) });

    assert.equal(client.uploads.length, 2);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].attachments.length, 2);
    assert.deepEqual(client.calls[0].attachments.map((x) => x.filename), ['a.pdf', 'b.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('send: pad uploadu → client.send NIE jest wołany w ogóle (R2)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-send-'));
  try {
    const a = tmpFile(dir, 'a.txt', 'A');
    const b = tmpFile(dir, 'b.txt', 'B');
    const client = fakeClient({ failUploadOn: 2 });

    await assert.rejects(
      main({ client, argv: argv('--to', 'Cave', '--title', 'T', '--type', 'task', '--attach', a, '--attach', b) }),
      /upload padł/
    );
    assert.equal(client.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('send: --attach na nieistniejący plik → błąd przed transferem i przed wysyłką', async () => {
  const client = fakeClient();
  await assert.rejects(
    main({ client, argv: argv('--to', 'Cave', '--title', 'T', '--type', 'task', '--attach', '/nie/ma/pliku.txt') }),
    /Nie znalazłem pliku do załączenia/
  );
  assert.equal(client.uploads.length, 0);
  assert.equal(client.calls.length, 0);
});

test('send: bez --attach body huba nie dostaje pola attachments', async () => {
  const client = fakeClient();
  await main({ client, argv: argv('--to', 'Cave', '--title', 'T', '--type', 'task') });
  assert.equal('attachments' in client.calls[0], false);
});

test('parseArgs: --attach jest powtarzalne (lista), reszta kluczy bez zmian', () => {
  assert.deepEqual(parseArgs(['n', 's', '--attach', 'a.png', '--attach', 'b.pdf', '--to', 'x']), {
    attach: ['a.png', 'b.pdf'],
    to: 'x',
  });
});
