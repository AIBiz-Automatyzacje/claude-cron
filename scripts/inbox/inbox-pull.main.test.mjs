// Testy warstwy TRANSPORTU inbox-pull.main — po przepięciu pg → inbox-client (IU-2.2).
// Mockujemy TYLKO klienta huba (zewnętrzny szew); renderery/self-heal działają naprawdę,
// więc test jest szwem klient↔renderer (założenie: hub daje dane, renderer je składa).
// Renderery i ich testy (inbox-pull.test.mjs) pozostają nietknięte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from './inbox-pull.mjs';

const T0 = '2026-07-24T07:12:00.000Z';
const T1 = '2026-07-24T08:12:00.000Z';
const ID_Q = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_R = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ENV_KEYS = ['CLAUDE_CRON_WORKSPACE', 'INBOX_ENV_FILE', 'INBOX_TODO_PATH', 'INBOX_SKRZYNKA_PATH', 'INBOX_ARCHIVE_DIR', 'INBOX_USER'];

// Świeży vault w tmp + hermetyczna env (żeby loadEnv nie sięgał do prawdziwego .env).
function setupVault(t) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-pull-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const zadania = path.join(base, 'Zadania');
  fs.mkdirSync(zadania, { recursive: true });
  const skrzynka = path.join(zadania, 'Skrzynka.md'); // celowo NIE tworzymy — self-heal
  const todo = path.join(zadania, 'to_do.md');
  fs.writeFileSync(todo, '# to_do\n\n%% inbox:banner:start %%\n%% inbox:banner:end %%\n', 'utf8');

  process.env.CLAUDE_CRON_WORKSPACE = base;
  process.env.INBOX_TODO_PATH = todo;
  process.env.INBOX_SKRZYNKA_PATH = skrzynka;
  process.env.INBOX_ARCHIVE_DIR = path.join(base, 'Zasoby', 'inbox-archive');
  delete process.env.INBOX_ENV_FILE;
  return { base, skrzynka, todo };
}

test('renderuje me z pola user odpowiedzi huba, nie z env (happy path)', async (t) => {
  const { skrzynka } = setupVault(t);
  // Pułapka: env INBOX_USER celowo BŁĘDNE — jeśli kod czyta env, kierunek się rozjedzie.
  process.env.INBOX_USER = 'bob';

  // Wątek: ja (alicja) wysłałam query do boba, bob odpisał. active = otrzymana odpowiedź.
  const myQuery = { id: ID_Q, thread_id: THREAD, from_user: 'alicja', to_user: 'bob', type: 'query', title: 'Kiedy live?', content: 'Data?', status: 'delivered', created_at: T0, payload: null };
  const reply = { id: ID_R, thread_id: THREAD, from_user: 'bob', to_user: 'alicja', type: 'reply', title: 'Re: Kiedy live?', content: 'Piątek.', status: 'delivered', created_at: T1, payload: null };

  let pullCalled = 0;
  const client = {
    pull: async () => { pullCalled += 1; return { v: 1, user: 'alicja', active: [reply], threadRows: [myQuery, reply], delegated: [] }; },
  };

  await main({ client });

  assert.equal(pullCalled, 1);
  const out = await fsp.readFile(skrzynka, 'utf8');
  // me='alicja' (z huba) → root.from_user===me → "Ty → @bob". Gdyby me='bob' (env) → "od @alicja".
  assert.ok(out.includes('Ty → @bob'), 'kierunek liczony z huba user=alicja');
  assert.ok(!out.includes('od @alicja'), 'nie użyto env INBOX_USER=bob');
});

test('pusta skrzynka z huba: pusty stan bez wyjątku, self-heal tworzy plik (error case)', async (t) => {
  const { skrzynka } = setupVault(t);
  process.env.INBOX_USER = 'ktokolwiek';

  const client = {
    pull: async () => ({ v: 1, user: 'alicja', active: [], threadRows: [], delegated: [] }),
  };

  await main({ client });

  const out = await fsp.readFile(skrzynka, 'utf8');
  assert.ok(out.includes('%% inbox:items:start %%'), 'self-heal utworzył plik z markerami');
  assert.ok(out.includes('Pusto'), 'pusty stan Otrzymane');
  assert.match(out, /^\*0 nowych\*$/m);
});
