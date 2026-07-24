// Testy warstwy TRANSPORTU inbox-push.main — po przepięciu pg → inbox-client (IU-2.2).
// Mockujemy TYLKO klienta huba; parser (extractInboxSection/parseCheckedCallouts) i
// renderer archiwum działają naprawdę. Parser/renderer i ich testy (inbox-push.test.mjs)
// pozostają nietknięte. Sedno: idempotencja huba (already_done) NIE duplikuje archiwum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from './inbox-push.mjs';

const T0 = '2026-07-24T07:12:00.000Z';
const T1 = '2026-07-24T08:12:00.000Z';
const ID_TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_REPLY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ENV_KEYS = ['CLAUDE_CRON_WORKSPACE', 'INBOX_ENV_FILE', 'INBOX_SKRZYNKA_PATH', 'INBOX_ARCHIVE_DIR', 'INBOX_USER'];

// Skrzynka z jednym odhaczonym taskiem [x] Zrobione (kontrakt marker id/thread + checkbox).
const SKRZYNKA_CHECKED = `# Skrzynka

%% inbox:items:start %%
> [!todo]- Baner na live
> - [x] Zrobione
> %% id:${ID_TASK} thread:${THREAD} %%
%% inbox:items:end %%
`;

// Nitka zwracana przez hub przy result:'replied' — task + dołożona odpowiedź "Zrobione ✅".
// Kotwica (id=ID_TASK).to_user = 'alicja' → closedBy w stopce archiwum.
const REPLIED_THREAD = [
  { id: ID_TASK, thread_id: THREAD, from_user: 'bob', to_user: 'alicja', type: 'task', title: 'Baner na live', content: 'Potrzebuję baner.', status: 'done', created_at: T0 },
  { id: ID_REPLY, thread_id: THREAD, from_user: 'alicja', to_user: 'bob', type: 'reply', title: 'Re: Baner na live', content: 'Zrobione ✅', status: 'pending', created_at: T1 },
];

function setupVault(t, skrzynkaContent) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-push-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const zadania = path.join(base, 'Zadania');
  fs.mkdirSync(zadania, { recursive: true });
  const skrzynka = path.join(zadania, 'Skrzynka.md');
  fs.writeFileSync(skrzynka, skrzynkaContent, 'utf8');
  const archiveDir = path.join(base, 'Zasoby', 'inbox-archive');

  process.env.CLAUDE_CRON_WORKSPACE = base;
  process.env.INBOX_SKRZYNKA_PATH = skrzynka;
  process.env.INBOX_ARCHIVE_DIR = archiveDir;
  delete process.env.INBOX_ENV_FILE;
  return { base, skrzynka, archiveDir };
}

function readArchive(archiveDir) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const file = path.join(archiveDir, `${ym}.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

test('powtórzone done (hub: already_done) nie duplikuje archiwum ani reply', async (t) => {
  const { archiveDir } = setupVault(t, SKRZYNKA_CHECKED);

  // Hub: pierwsze done dla id → replied+thread; kolejne dla tego id → already_done (idempotencja).
  const seen = new Set();
  let doneCalls = 0;
  const client = {
    done: async ({ id, action }) => {
      doneCalls += 1;
      assert.equal(action, 'Zrobione');
      if (seen.has(id)) return { v: 1, result: 'already_done' };
      seen.add(id);
      return { v: 1, result: 'replied', thread: REPLIED_THREAD };
    },
  };

  // Dwa przebiegi na TYM SAMYM (wciąż odhaczonym) pliku — jak dwa syncy zanim pull przerysuje.
  await main({ client });
  await main({ client });

  assert.equal(doneCalls, 2, 'done wołane w obu runach');
  const archive = readArchive(archiveDir);
  const footers = archive.match(/_archived .* by @alicja_/g) || [];
  assert.equal(footers.length, 1, 'archiwum dopisane dokładnie raz mimo dwóch runów');
  // Reply "Zrobione ✅" pojawia się w archiwum dokładnie raz (nie zduplikowane).
  assert.equal((archive.match(/Zrobione ✅/g) || []).length, 1);
  // closedBy wyprowadzone z nitki huba (kotwica.to_user), nie z env.
  assert.ok(archive.includes('by @alicja'));
});

test('done zwraca not_found/skipped → brak archiwizacji (error case)', async (t) => {
  const { archiveDir } = setupVault(t, SKRZYNKA_CHECKED);

  let doneCalls = 0;
  const client = {
    done: async () => { doneCalls += 1; return { v: 1, result: 'not_found' }; },
  };

  await main({ client });

  assert.equal(doneCalls, 1);
  assert.equal(readArchive(archiveDir), '', 'nic nie zarchiwizowane dla not_found');
});
