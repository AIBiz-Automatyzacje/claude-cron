// Testy warstwy TRANSPORTU auto-reply.main — po przepięciu pg → inbox-client (IU-2.2).
// Mockujemy TYLKO klienta huba. Czyste helpery (parseAnswer/buildPrompt/...) i ich testy
// (auto-reply.test.mjs) pozostają nietknięte. Sedno: brak kandydata (claimQuery → query:null)
// = zero spawnu CLI i zero client.send; atomowy claim robi hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from './auto-reply.mjs';

// Override binarki `claude` dla ścieżki spawnu (wzorzec setClaudeBin z lib/ask.test.js):
// runClaude z auto-reply.mjs woła resolveClaudeBin() z tego samego singletona modułu.
const require = createRequire(import.meta.url);
const { setClaudeBin } = require('../../lib/claude-spawn.js');

// Atrapa CLI przez shebang `#!/usr/bin/env node` — flagi (-p, --model, --allowedTools)
// trafiają do argv skryptu, nie do node. Shebang wymaga POSIX → skip na Windows.
const SKIP_WIN = process.platform === 'win32'
  ? 'atrapa CLI przez shebang wymaga POSIX — ścieżka spawnu pokryta na macOS/Linux'
  : false;

function makeFakeClaude(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoreply-fake-claude-'));
  const scriptPath = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(scriptPath, 0o755);
  setClaudeBin(scriptPath);
  t.after(() => {
    setClaudeBin(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

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

test('kandydat jest → runClaude (odpowiedź != NO_ANSWER) → client.send z payload.auto_reply + historia (happy path)', { skip: SKIP_WIN }, async (t) => {
  setupEnv(t);
  // Atrapa CLI zwraca realną odpowiedź (nie NO_ANSWER) — main musi wysłać reply.
  makeFakeClaude(t, 'process.stdout.write("Deploy robisz przez skrypt install-vps.sh (Zasoby/deploy.md).");');

  let sentBody = null;
  const client = {
    claimQuery: async () => ({
      v: 1,
      query: {
        id: 'q-42',
        thread_id: 'thr-7',
        to_user: 'kacper',
        from_user: 'kamil',
        title: 'Jak zdeployować?',
        content: 'Pytanie o deploy.',
      },
    }),
    send: async (body) => { sentBody = body; return { v: 1, message: { id: 'm-1' } }; },
  };

  await main({ client });

  assert.ok(sentBody, 'client.send zostało wywołane');
  assert.equal(sentBody.thread_id, 'thr-7', 'reply trzyma się wątku query');
  assert.equal(sentBody.to_user, 'kamil', 'reply wraca do nadawcy query (from_user)');
  assert.equal(sentBody.type, 'reply');
  assert.equal(sentBody.title, 'Re: Jak zdeployować?');
  assert.match(sentBody.content, /🤖 auto-odpowiedź asystenta/, 'treść otagowana jako auto-odpowiedź');
  assert.match(sentBody.content, /install-vps\.sh/, 'treść zawiera odpowiedź agenta');
  assert.deepEqual(sentBody.payload, { auto_reply: true }, 'payload oznaczony auto_reply');

  // Historia dopisana (append-only log auto-odpowiedzi).
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const historyFile = path.join(process.env.INBOX_ARCHIVE_DIR, `auto-replies-${ym}.md`);
  const history = fs.readFileSync(historyFile, 'utf8');
  assert.match(history, /Jak zdeployować\?/, 'wpis historii zawiera tytuł query');
});

test('kandydat jest → NO_ANSWER → BRAK wysyłki, wpis "zostaje dla człowieka" w historii (error case)', { skip: SKIP_WIN }, async (t) => {
  setupEnv(t);
  makeFakeClaude(t, 'process.stdout.write("Nie ma o tym notatki. NO_ANSWER");');

  let sendCalled = false;
  const client = {
    claimQuery: async () => ({
      v: 1,
      query: { id: 'q-43', thread_id: 'thr-8', to_user: 'kacper', from_user: 'kamil', title: 'Nieznane pytanie', content: null },
    }),
    send: async () => { sendCalled = true; return { v: 1, message: {} }; },
  };

  await main({ client });

  assert.equal(sendCalled, false, 'NO_ANSWER nie może zamknąć query błędną odpowiedzią');
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const historyFile = path.join(process.env.INBOX_ARCHIVE_DIR, `auto-replies-${ym}.md`);
  const history = fs.readFileSync(historyFile, 'utf8');
  assert.match(history, /zostaje dla człowieka/, 'historia odnotowuje NO_ANSWER');
});
