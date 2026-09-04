// Testy SEKWENCJI syncu: pobrania → push → pull, w jednym procesie.
// Mockowany wyłącznie klient huba; parsery, render i zapisy na dysku działają naprawdę,
// więc test jest szwem trzech kroków, a nie sprawdzeniem, że każdy z nich da się zawołać.
//
// Kolejność jest KONTRAKTEM, nie estetyką: pull nadpisuje blok Skrzynki w całości, więc
// wykonany przed pobraniem zdmuchnąłby odhaczony checkbox „Pobierz", zanim ktokolwiek
// ściągnąłby plik (learned pattern: kolejność kroków startu testuj odtwarzając ją, a nie
// wołając obie strony osobno).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from './inbox-sync.mjs';
import { attachmentFileName, renderAttachmentLine } from './inbox-pull.mjs';

const ID_TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_MSG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ATT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T0 = '2026-07-24T07:12:00.000Z';
const MONTH = '2026-07';
const FILE_CONTENT = 'BAJTY-ZALACZNIKA';
const FILE_SHA = createHash('sha256').update(FILE_CONTENT).digest('hex');

// INBOX_* trafiają tu przez loadEnv, który MUTUJE process.env — bez przywrócenia kolejny
// test dziedziczyłby ścieżki do skasowanego katalogu tymczasowego.
const ENV_KEYS = [
  'CLAUDE_CRON_WORKSPACE',
  'INBOX_ENV_FILE',
  'INBOX_SKRZYNKA_PATH',
  'INBOX_TODO_PATH',
  'INBOX_ARCHIVE_DIR',
  'INBOX_ATTACHMENTS_DIR',
];

const ATTACHMENT = {
  id: ATT_ID,
  filename: 'raport.pdf',
  size_bytes: FILE_CONTENT.length,
  mime: 'application/pdf',
  sha256: FILE_SHA,
};

// Wiadomość z załącznikiem — hub oddaje ją w każdym pullu (także tym, który robi krok pobrań).
const MESSAGE = {
  id: ID_MSG,
  thread_id: THREAD,
  from_user: 'bob',
  to_user: 'alicja',
  type: 'task',
  title: 'Raport',
  content: 'W załączniku.',
  status: 'delivered',
  created_at: T0,
  payload: null,
  attachments: [ATTACHMENT],
};

const CLOSED_THREAD = [
  { id: ID_TASK, thread_id: THREAD, from_user: 'bob', to_user: 'alicja', type: 'task', title: 'Baner', content: 'Baner.', status: 'done', created_at: T0 },
];

// Skrzynka z DWOMA odhaczeniami naraz: hubowym („Zrobione") i lokalnym („Pobierz").
// Wiersz załącznika pochodzi z prawdziwego renderu — kontrakt render↔parser jest testowany,
// nie zakładany.
function skrzynkaContent() {
  const attLine = renderAttachmentLine(ATTACHMENT, MONTH, () => false).replace('- [ ] Pobierz', '- [x] Pobierz');
  return [
    '# Skrzynka',
    '',
    '%% inbox:items:start %%',
    '> [!todo]- Baner na live',
    '> - [x] Zrobione',
    `> %% id:${ID_TASK} thread:${THREAD} %%`,
    '',
    '> [!todo]- Raport',
    attLine,
    '%% inbox:items:end %%',
    '',
    '%% delegated:items:start %%',
    '%% delegated:items:end %%',
    '',
  ].join('\n');
}

function setupVault(t) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-sync-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const zadania = path.join(base, 'Zadania');
  fs.mkdirSync(zadania, { recursive: true });
  const skrzynka = path.join(zadania, 'Skrzynka.md');
  fs.writeFileSync(skrzynka, skrzynkaContent(), 'utf8');
  const todo = path.join(zadania, 'Dashboard.md');
  fs.writeFileSync(todo, '# Dashboard\n\n%% inbox:banner:start %%\n%% inbox:banner:end %%\n', 'utf8');

  process.env.CLAUDE_CRON_WORKSPACE = base;
  process.env.INBOX_SKRZYNKA_PATH = skrzynka;
  process.env.INBOX_TODO_PATH = todo;
  process.env.INBOX_ARCHIVE_DIR = path.join(base, 'Zasoby', 'inbox-archive');
  process.env.INBOX_ATTACHMENTS_DIR = path.join(base, 'Zasoby', 'inbox-zalaczniki');
  // Hermetyczna env: loadEnv nie może sięgnąć po prawdziwy sekret instalacji.
  process.env.INBOX_ENV_FILE = path.join(base, 'brak-inbox.env');
  return { base, skrzynka, attachmentsDir: process.env.INBOX_ATTACHMENTS_DIR };
}

function fakeHub() {
  const calls = [];
  return {
    calls,
    pull: async () => {
      calls.push('pull');
      return { v: 1, user: 'alicja', active: [MESSAGE], threadRows: [MESSAGE], delegated: [] };
    },
    done: async () => {
      calls.push('done');
      return { v: 1, result: 'closed', thread: CLOSED_THREAD };
    },
    downloadBlob: async (sha256, destPath) => {
      calls.push('downloadBlob');
      assert.equal(sha256, FILE_SHA);
      fs.writeFileSync(destPath, FILE_CONTENT);
      return { path: destPath, size: FILE_CONTENT.length };
    },
  };
}

test('sekwencja: pobranie następuje PRZED pushem i PRZED pullem', async (t) => {
  const { attachmentsDir } = setupVault(t);
  const client = fakeHub();

  await main({ client, role: 'client' });

  const done = client.calls.indexOf('done');
  const download = client.calls.indexOf('downloadBlob');
  const lastPull = client.calls.lastIndexOf('pull');
  assert.ok(done >= 0 && download >= 0 && lastPull >= 0, `brak kroku w ${client.calls.join(',')}`);
  // Kolejność odwrócona względem pierwotnej implementacji (review fazy 3): push potrafi
  // DOMKNĄĆ wątek, a domknięty wątek wypada z `pullForUser` — pobranie po pushu traciło
  // metadane załącznika z tego samego wątku i plik nie trafiał do vaulta już nigdy.
  assert.ok(download < done, 'pobranie musi poprzedzać push domykający wątki');
  assert.ok(download < lastPull, 'pobranie musi poprzedzać pull regenerujący Skrzynkę');
  // Szew hub↔plik: bajty naprawdę wylądowały w vaultcie.
  assert.equal(fs.readFileSync(path.join(attachmentsDir, MONTH, attachmentFileName('raport.pdf', FILE_SHA)), 'utf8'), FILE_CONTENT);
});

test('maszyna w roli agenta: sync nie pobiera niczego, ale push i pull lecą normalnie (R10)', async (t) => {
  const { attachmentsDir } = setupVault(t);
  const client = fakeHub();

  await main({ client, role: 'agent' });

  assert.ok(!client.calls.includes('downloadBlob'), 'agent nie pobiera');
  assert.equal(fs.existsSync(path.join(attachmentsDir, MONTH)), false);
  assert.ok(client.calls.includes('done'), 'push nadal działa');
  assert.ok(client.calls.includes('pull'), 'pull nadal działa');
});

test('pad pobrania nie zatrzymuje pulla (sync dojeżdża do końca)', async (t) => {
  const { skrzynka } = setupVault(t);
  const client = fakeHub();
  client.downloadBlob = async () => {
    client.calls.push('downloadBlob');
    throw new Error('hub padł w połowie transferu');
  };

  await main({ client, role: 'client' });

  assert.ok(client.calls.includes('downloadBlob'));
  // Pull przerenderował plik — czyli krok 3 wykonał się mimo padu kroku 2.
  const out = fs.readFileSync(skrzynka, 'utf8');
  assert.ok(out.includes('%% inbox:items:start %%'), 'Skrzynka przerenderowana przez pull');
});

// Regresja po review fazy 3: „Zrobione" i „Pobierz" odhaczone w JEDNYM podejściu na TYM
// SAMYM wątku. `done` ustawia status='done', a domknięty wątek wypada z `pullForUser` —
// przy kolejności push→pobrania krok pobrań nie dostawał już metadanych, plik nie trafiał
// do vaulta, a krok 3 usuwał wiersz ze Skrzynki, więc nie było czego odhaczyć ponownie.
test('jeden wątek, dwa odhaczenia: plik ląduje w vaultcie mimo domknięcia wątku', async (t) => {
  const { attachmentsDir } = setupVault(t);
  const client = fakeHub();
  let zamkniete = false;
  client.done = async () => {
    client.calls.push('done');
    zamkniete = true;
    return { v: 1, result: 'closed', thread: CLOSED_THREAD };
  };
  client.pull = async () => {
    client.calls.push('pull');
    // Hub po domknięciu nie oddaje już tego wątku — ani wiadomości, ani jej załączników.
    const rows = zamkniete ? [] : [MESSAGE];
    return { v: 1, user: 'alicja', active: rows, threadRows: rows, delegated: [] };
  };

  await main({ client, role: 'client' });

  assert.equal(
    fs.readFileSync(path.join(attachmentsDir, MONTH, attachmentFileName('raport.pdf', FILE_SHA)), 'utf8'),
    FILE_CONTENT,
    'plik z domkniętego w tym samym runie wątku musi trafić do vaulta',
  );
});
