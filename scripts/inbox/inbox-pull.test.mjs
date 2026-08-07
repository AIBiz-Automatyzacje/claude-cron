// Testy renderingu Skrzynki (redesign 07.2026) + roundtrip z parserem inbox-push:
// wyrenderowany callout po odhaczeniu MUSI być parsowalny (kontrakt id/thread/checkbox).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFrontmatter, replaceBetweenMarkers, renderDelegatedCallout, renderThreadCallout, SKRZYNKA_TEMPLATE, updateSkrzynkaFile } from './inbox-pull.mjs';
import { parseCheckedCallouts } from './inbox-push.mjs';

const T0 = '2026-07-24T07:12:00.000Z';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function msg(over = {}) {
  return {
    id: ID_A, thread_id: THREAD, from_user: 'marcin', to_user: 'kacper',
    type: 'task', title: 'Baner na live sierpniowy',
    content: 'Potrzebuję baner 1920x1080.', status: 'pending',
    created_at: T0, payload: null, ...over,
  };
}

test('task: awatar, pille, checkbox Zrobione z hintem, marker', () => {
  const m = msg();
  const out = renderThreadCallout([m], m, 'kacper');
  assert.match(out, /^> \[!todo\|fresh\]- Baner na live sierpniowy/);
  assert.ok(out.includes('<span class="os-tag t-new">🆕 nowe</span>'));
  assert.ok(out.includes('<span class="os-tag t-task">📝 zadanie</span>'));
  assert.ok(out.includes('od @marcin'));
  assert.ok(out.includes('<span class="os-av u-marcin">M</span>'));
  assert.match(out, /^> - \[ \] Zrobione /m);
  assert.ok(out.includes(`%% id:${ID_A} thread:${THREAD} %%`));
});

test('delivered (nie-pending): bez badge nowe i bez |fresh', () => {
  const m = msg({ status: 'delivered' });
  const out = renderThreadCallout([m], m, 'kacper');
  assert.match(out, /^> \[!todo\]- /);
  assert.ok(!out.includes('t-new'));
});

test('query ode mnie: kierunek "Ty →", checkbox Zapoznane', () => {
  const q = msg({ type: 'query', from_user: 'kacper', to_user: 'marcin', status: 'delivered' });
  const reply = msg({ id: ID_B, type: 'reply', from_user: 'marcin', to_user: 'kacper', content: 'Realnie piątek.', status: 'delivered' });
  const out = renderThreadCallout([q, reply], reply, 'kacper');
  assert.ok(out.includes('Ty → @marcin'));
  assert.match(out, /^> - \[ \] Zapoznane /m);
  assert.ok(out.includes('/deleguj reply'));
});

test('auto-reply: awatar bota, badge AUTO, prefix zdjęty, źródło jako pill', () => {
  const q = msg({ type: 'query', from_user: 'kacper', to_user: 'marcin', status: 'delivered' });
  const bot = msg({
    id: ID_B, type: 'reply', from_user: 'marcin', to_user: 'kacper', status: 'delivered',
    payload: { auto_reply: true },
    content: '🤖 auto-odpowiedź asystenta:\n\nZasady ustalone 15.06.\n\nŹródło: `Zasoby/Playbooki/moderacja-grup-fb.md`',
  });
  const out = renderThreadCallout([q, bot], bot, 'kacper');
  assert.ok(out.includes('<span class="os-av u-bot">🤖</span>'));
  assert.ok(out.includes('Asystent @marcin'));
  assert.ok(out.includes('<span class="os-auto">AUTO</span>'));
  assert.ok(!out.includes('auto-odpowiedź asystenta'));
  assert.ok(out.includes('<span class="os-src">📄 `Zasoby/Playbooki/moderacja-grup-fb.md`</span>'));
});

test('roundtrip: wyrenderowany i odhaczony callout parsuje się w inbox-push', () => {
  const m = msg();
  const rendered = renderThreadCallout([m], m, 'kacper').replace('> - [ ] Zrobione', '> - [x] Zrobione');
  const parsed = parseCheckedCallouts(rendered);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { id: ID_A, thread_id: THREAD, action: 'Zrobione' });
});

test('szablon self-heal: markery obu sekcji, liczniki pod regexy, cssclasses', () => {
  for (const m of ['%% inbox:items:start %%', '%% inbox:items:end %%', '%% delegated:items:start %%', '%% delegated:items:end %%']) {
    assert.ok(SKRZYNKA_TEMPLATE.includes(m), `brak markera ${m}`);
    assert.ok(SKRZYNKA_TEMPLATE.indexOf(m) === SKRZYNKA_TEMPLATE.lastIndexOf(m), `zdublowany marker ${m}`);
  }
  // liczniki muszą pasować do regexów podmiany w updateSkrzynkaFile
  assert.match(SKRZYNKA_TEMPLATE, /^\*\d+ now[a-z]+\*$/m);
  assert.match(SKRZYNKA_TEMPLATE, /^\*\d+ w toku\*$/m);
  assert.ok(SKRZYNKA_TEMPLATE.includes('cssclasses: [skrzynka]'));
});

test('delegowane: karta per delegacja (fold + tytuł + adresat), pill czasu, stale ⚠️, treść, marker thread', () => {
  const fresh = msg({ created_at: new Date(Date.now() - 2 * 3600000).toISOString() });
  const stale = msg({ id: ID_B, thread_id: null, to_user: 'filip', created_at: new Date(Date.now() - 72 * 3600000).toISOString() });
  const out = renderDelegatedCallout([fresh, stale]);
  // fold `-` + tytuł z adresatem — tytuł jest widoczny (klikalne rozwijanie), treść w środku
  const heads = out.split('\n').filter(l => l.startsWith('> [!delegated]- '));
  assert.equal(heads.length, 2);
  assert.ok(heads[0].includes('Baner na live sierpniowy · @'));
  assert.ok(heads[1].includes('· @filip'));
  assert.ok(heads[0].includes('class="os-since">wysłane ')); // data jako badge w linii tytułu
  assert.ok(out.includes('⏳ czeka 2h'));
  assert.ok(out.includes('os-wait stale'));
  assert.ok(out.includes('⚠️ czeka 3d'));
  assert.ok(out.includes('> Potrzebuję baner 1920x1080.')); // treść wysłanej wiadomości w karcie
  assert.ok(out.includes(`%% thread:${THREAD} %%`));
  assert.ok(out.includes(`%% thread:${ID_B} %%`)); // fallback na id gdy brak thread_id
});

// ──────── frontmatter merge (R12) ────────
// Zmiana szablonu ma docierać do plików utworzonych wcześniej, ale bez deptania
// tego, co user dopisał sam.
const BODY_BEZ_FM = `# 📬 Skrzynka

## 📥 Otrzymane

*0 nowych*

%% inbox:items:start %%
%% inbox:items:end %%

## 📤 Wysłane — czekają na odpowiedź

*0 w toku*

%% delegated:items:start %%
%% delegated:items:end %%
`;

function withFrontmatter(fm) {
  return `---\n${fm}\n---\n${BODY_BEZ_FM}`;
}

test('merge frontmattera: brakujący cssclasses wraca z szablonu', () => {
  const out = mergeFrontmatter(withFrontmatter('status: w_trakcie\ntags: [skrzynka]'));
  assert.ok(out.includes('cssclasses: [skrzynka]'));
  assert.ok(out.includes('status: w_trakcie'));
  assert.ok(out.includes(BODY_BEZ_FM)); // treść pod frontmatterem nietknięta
});

test('merge frontmattera: własny klucz usera przetrwał', () => {
  const out = mergeFrontmatter(withFrontmatter('status: w_trakcie\nmoj_klucz: wartosc usera'));
  assert.ok(out.includes('moj_klucz: wartosc usera'));
  assert.ok(out.includes('cssclasses: [skrzynka]'));
});

test('merge frontmattera: istniejąca wartość NIE jest nadpisywana szablonem', () => {
  const out = mergeFrontmatter(withFrontmatter('cssclasses: [moje, wlasne]\ntermin: 2026-01-01'));
  assert.ok(out.includes('cssclasses: [moje, wlasne]'));
  assert.ok(!out.includes('cssclasses: [skrzynka]'));
  assert.ok(!out.includes('termin: 2099-12-31'));
  assert.ok(out.includes('status: w_trakcie')); // brakujące klucze dołożone
});

test('merge frontmattera: plik bez frontmattera dostaje pełny blok z szablonu', () => {
  const out = mergeFrontmatter(BODY_BEZ_FM);
  assert.ok(out.startsWith('---\n'));
  for (const line of ['status: w_trakcie', 'priorytet: normalne', 'termin: 2099-12-31', 'tags: [skrzynka, personal-team-os]', 'cssclasses: [skrzynka]']) {
    assert.ok(out.includes(line), `brak ${line}`);
  }
  assert.ok(out.endsWith(BODY_BEZ_FM));
});

test('merge frontmattera: komplet kluczy = plik bit w bit ten sam (brak fałszywego zapisu)', () => {
  const raw = SKRZYNKA_TEMPLATE;
  assert.equal(mergeFrontmatter(raw), raw);
});

test('szew: updateSkrzynkaFile domergowuje frontmatter i nie rusza markerów', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skrzynka-'));
  const file = path.join(dir, 'Skrzynka.md');
  await fs.writeFile(file, withFrontmatter('status: w_trakcie\nmoj_klucz: zostaje'), 'utf8');

  const m = msg();
  await updateSkrzynkaFile(file, [m], [m], [], 'kacper');

  // decyzja na ŚWIEŻYM odczycie z dysku, nie na obiekcie z pamięci
  const after = await fs.readFile(file, 'utf8');
  assert.ok(after.includes('cssclasses: [skrzynka]'));
  assert.ok(after.includes('moj_klucz: zostaje'));
  // Normalizacja nagłówka istniejącego pliku (fixture ma STARY „— czekają na odpowiedź"):
  // przy taskach ten dopisek kłamał — one czekają na odhaczenie, nie na odpowiedź.
  assert.ok(after.includes('## 📤 Wysłane\n'), 'nowy nagłówek sekcji Wysłane');
  assert.ok(!after.includes('czekają na odpowiedź'), 'stary nagłówek znormalizowany przy pullu');
  assert.ok(after.includes('%% inbox:items:start %%'));
  assert.ok(after.includes('%% delegated:items:end %%'));
  assert.match(after, /^\*1 nowa\*$/m);

  // kontrakt push↔pull: odhaczony checkbox z ZAPISANEGO pliku parsuje się w inbox-push
  const parsed = parseCheckedCallouts(after.replace('> - [ ] Zrobione', '> - [x] Zrobione'));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { id: ID_A, thread_id: THREAD, action: 'Zrobione' });

  await fs.rm(dir, { recursive: true, force: true });
});

test('replaceBetweenMarkers: zdublowany marker = głośny fail, nie pisanie w pierwszy blok', () => {
  // Incydent 06.08: tekstowy merge Obsidian Sync zdublował sekcję z markerami — pull pisał
  // w PIERWSZY blok i zagnieżdżał treść coraz głębiej przy każdym runie, cementując uszkodzenie.
  const zdrowy = 'a\n%% s %%\nstare\n%% e %%\nb';
  assert.equal(
    replaceBetweenMarkers(zdrowy, '%% s %%', '%% e %%', 'nowe'),
    'a\n%% s %%\nnowe\n%% e %%\nb',
  );

  const podwojnyStart = 'a\n%% s %%\nx\n%% e %%\nb\n%% s %%\ny';
  assert.throws(() => replaceBetweenMarkers(podwojnyStart, '%% s %%', '%% e %%', 'nowe'), /Zdublowany marker/);

  const podwojnyEnd = 'a\n%% s %%\nx\n%% e %%\nb\n%% e %%';
  assert.throws(() => replaceBetweenMarkers(podwojnyEnd, '%% s %%', '%% e %%', 'nowe'), /Zdublowany marker/);
});
