// Testy warstwy TRANSPORTU auto-reply.main — po przepięciu pg → inbox-client (IU-2.2).
// Mockujemy TYLKO klienta huba. Czyste helpery (parseAnswer/buildPrompt/...) i ich testy
// (auto-reply.test.mjs) pozostają nietknięte. Sedno: brak kandydata (claimQuery → query:null)
// = zero spawnu CLI i zero client.send; atomowy claim robi hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from './auto-reply.mjs';

const ENV_KEYS = ['CLAUDE_CRON_WORKSPACE', 'INBOX_ENV_FILE', 'INBOX_SKRZYNKA_PATH', 'INBOX_ARCHIVE_DIR', 'INBOX_USER', 'INBOX_ASSISTANT_MODEL'];

function setupEnv(t) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-autoreply-'));
  const savedLog = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  t.after(() => {
    console.log = savedLog;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  process.env.CLAUDE_CRON_WORKSPACE = base;
  process.env.INBOX_SKRZYNKA_PATH = path.join(base, 'Zadania', 'Skrzynka.md');
  process.env.INBOX_ARCHIVE_DIR = path.join(base, 'Zasoby', 'inbox-archive');
  delete process.env.INBOX_ENV_FILE;
  return { logs };
}

test('claimQuery zwraca {query:null} → brak spawnu i wysyłki, log "no candidates" (happy path)', async (t) => {
  const { logs } = setupEnv(t);

  let claimCalls = 0;
  let sendCalled = false;
  const client = {
    claimQuery: async () => { claimCalls += 1; return { v: 1, query: null }; },
    send: async () => { sendCalled = true; return { v: 1, message: {} }; },
  };

  await main({ client });

  assert.equal(claimCalls, 1);
  assert.equal(sendCalled, false, 'brak wysyłki gdy nie ma kandydata (a więc i brak spawnu CLI)');
  assert.ok(logs.some((l) => l.includes('no candidates')), 'zalogowano "no candidates"');
});

test('claimQuery bez pola query (undefined) → też brak kandydata, brak wysyłki (error case)', async (t) => {
  const { logs } = setupEnv(t);

  let sendCalled = false;
  const client = {
    claimQuery: async () => ({ v: 1 }), // pole query nieobecne
    send: async () => { sendCalled = true; return { v: 1, message: {} }; },
  };

  await main({ client });

  assert.equal(sendCalled, false);
  assert.ok(logs.some((l) => l.includes('no candidates')));
});
