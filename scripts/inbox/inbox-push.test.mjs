// Testy parsera sekcji Skrzynki i renderingu archiwum nitki.
// Roundtrip render→parse (kontrakt pull↔push) żyje w inbox-pull.test.mjs — tu tylko strona push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendToArchive, extractInboxSection, renderArchiveThread, archivePath } from './inbox-push.mjs';

const T0 = '2026-07-24T07:12:00.000Z';
const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function msg(over = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', thread_id: THREAD,
    from_user: 'marcin', to_user: 'kacper',
    type: 'task', title: 'Baner na live sierpniowy',
    content: 'Potrzebuję baner 1920x1080.', status: 'done',
    created_at: T0, ...over,
  };
}

test('extractInboxSection: zwraca treść między markerami, bez otoczenia', () => {
  const content = '# Skrzynka\n\nprolog\n%% inbox:items:start %%\n> [!todo]- Coś\n%% inbox:items:end %%\nepilog\n';
  const out = extractInboxSection(content);
  assert.ok(out.includes('> [!todo]- Coś'));
  assert.ok(!out.includes('prolog'));
  assert.ok(!out.includes('epilog'));
});

test('extractInboxSection: brak markera (start lub end) = pusty string, nie wyjątek (error case)', () => {
  assert.equal(extractInboxSection('plik bez markerów'), '');
  assert.equal(extractInboxSection('%% inbox:items:start %%\ntreść bez końca'), '');
  assert.equal(extractInboxSection('treść bez startu\n%% inbox:items:end %%'), '');
});

test('archivePath: plik YYYY-MM.md wewnątrz katalogu archiwum', () => {
  const p = archivePath('/tmp/vault/Zasoby/inbox-archive');
  assert.match(p, /inbox-archive[/\\]\d{4}-\d{2}\.md$/);
});

test('renderArchiveThread: cała nitka w jednym callout — nagłówek, obie wiadomości, stopka archived', () => {
  const task = msg();
  const reply = msg({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'reply',
    from_user: 'kacper', to_user: 'marcin',
    title: 'Re: Baner na live sierpniowy', content: 'Zrobione ✅\nLink w Zasobach.',
  });
  const out = renderArchiveThread([task, reply], 'kacper');
  assert.match(out, /^> \[!note\]- 📝 @marcin → @kacper · \d{2}\.\d{2}\.\d{4}/);
  assert.ok(out.includes('> **Zadanie:** Baner na live sierpniowy'));
  assert.ok(out.includes('> - **@marcin**'));
  assert.ok(out.includes('Potrzebuję baner 1920x1080.'));
  assert.ok(out.includes('> - **@kacper**'));
  // Kontynuacja wieloliniowej treści zostaje wcięta wewnątrz calloutu
  assert.ok(out.includes('>   Link w Zasobach.'));
  assert.ok(out.includes('by @kacper_'));
});

// appendToArchive jest publiczna, bo używa jej też close.mjs (druga ścieżka domknięcia).
test('appendToArchive: tworzy katalog i plik miesiąca z nagłówkiem, drugi zapis tylko dopisuje', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-archive-'));
  const dir = path.join(tmp, 'Zasoby/inbox-archive');

  await appendToArchive(dir, [msg()], 'kacper');
  const file = archivePath(dir);
  const first = await fs.readFile(file, 'utf8');
  assert.ok(first.startsWith('---\ntags: [archiwum, team-os]\n---'));
  assert.ok(first.includes('Baner na live sierpniowy'));

  await appendToArchive(dir, [msg({ title: 'Druga nitka' })], 'kacper');
  const second = await fs.readFile(file, 'utf8');
  // Nagłówek pliku dokładany TYLKO przy tworzeniu — inaczej front-matter powtarzałby się.
  assert.equal(second.match(/tags: \[archiwum, team-os\]/g).length, 1);
  assert.ok(second.includes('Druga nitka'));

  await fs.rm(tmp, { recursive: true, force: true });
});

test('appendToArchive: niezapisywalny katalog archiwum rzuca (error case)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-archive-blk-'));
  const notADir = path.join(tmp, 'plik');
  await fs.writeFile(notADir, 'x', 'utf8');
  await assert.rejects(() => appendToArchive(path.join(notADir, 'archiwum'), [msg()], 'kacper'));
  await fs.rm(tmp, { recursive: true, force: true });
});

test('renderArchiveThread: nieznany typ i pusta treść nie łamią renderu (error case)', () => {
  const weird = msg({ type: 'unknown-future-type', content: null });
  const out = renderArchiveThread([weird], 'kacper');
  assert.match(out, /^> \[!note\]- 📨 /);
  assert.ok(out.includes('> **Wiadomość:** Baner na live sierpniowy'));
  assert.ok(out.includes('> - **@marcin**'));
});
