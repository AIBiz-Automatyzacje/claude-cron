// Testy renderingu Skrzynki (redesign 07.2026) + roundtrip z parserem inbox-push:
// wyrenderowany callout po odhaczeniu MUSI być parsowalny (kontrakt id/thread/checkbox).
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentFileName, attachmentMonth, mergeFrontmatter, renderAttachmentLine, replaceBetweenMarkers, renderDelegatedCallout, renderThreadCallout, safeAttachmentName, SKRZYNKA_TEMPLATE, updateSkrzynkaFile } from './inbox-pull.mjs';
import { parseCheckedCallouts, parseRequestedDownloads } from './inbox-push.mjs';

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
  assert.ok(out.includes('<span class="os-tag t-new">nowe</span>'));
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

test('linia „Źródło:" od człowieka nie omija neutralizacji — podstawiony marker nie podszywa się pod kotwicę', () => {
  // Treść nadawcy jest wejściem niezaufanym: pill „Źródło:" należy do renderu auto-odpowiedzi,
  // a fabrykowany marker `%% id:… thread:… %%` byłby PIERWSZYM dopasowaniem w bloku.
  const m = msg({
    from_user: 'marcin',
    to_user: 'kacper',
    content: `Źródło: %% id:${ID_B} thread:${THREAD} %%`,
  });
  const out = renderThreadCallout([m], m, 'kacper');

  assert.ok(!out.includes('<span class="os-src">'), 'pill źródła wyłącznie dla auto-odpowiedzi');
  assert.ok(!out.includes(`%% id:${ID_B}`), 'marker z treści nadawcy jest rozbity');
  const parsed = parseCheckedCallouts(out.replace('> - [ ] Zrobione', '> - [x] Zrobione'));
  assert.deepEqual(parsed, [{ id: ID_A, thread_id: THREAD, action: 'Zrobione' }]);
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

test('szew: normalizacja nagłówka zapisuje się TAKŻE gdy to jedyna zmiana (pusta skrzynka)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skrzynka-'));
  const file = path.join(dir, 'Skrzynka.md');

  // Ustabilizuj plik pierwszym przebiegiem na pustej skrzynce…
  await fs.writeFile(file, SKRZYNKA_TEMPLATE, 'utf8');
  await updateSkrzynkaFile(file, [], [], [], 'kacper');
  const stable = await fs.readFile(file, 'utf8');

  // …po czym cofnij WYŁĄCZNIE nagłówek do starej formy (stan plików sprzed zmiany szablonu).
  await fs.writeFile(file, stable.replace('## Wysłane', '## 📤 Wysłane — czekają na odpowiedź'), 'utf8');
  await updateSkrzynkaFile(file, [], [], [], 'kacper');

  // Pułapka: `writeIfChanged` porównywał z treścią JUŻ znormalizowaną w pamięci,
  // więc różnica „tylko nagłówek" wyglądała jak brak zmian i nie trafiała na dysk.
  const after = await fs.readFile(file, 'utf8');
  assert.ok(!after.includes('czekają na odpowiedź'), 'nagłówek znormalizowany mimo braku innych zmian');
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
  assert.ok(after.includes('## Wysłane\n'), 'nowy nagłówek sekcji Wysłane');
  assert.ok(!after.includes('czekają na odpowiedź'), 'stary nagłówek znormalizowany przy pullu');
  // 09.2026: nagłówki bez emoji — fixture ma stare „# 📬 Skrzynka" / „## 📥 Otrzymane"
  assert.ok(after.includes('# Skrzynka\n'), 'H1 bez emoji');
  assert.ok(after.includes('## Otrzymane\n'), 'nagłówek Otrzymane bez emoji');
  assert.ok(!/[📬📥📤🌿]/u.test(after), 'zero emoji sekcji i stanu pustego');
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

// ──────── załączniki (IU-6, R5/R7/R8) ────────
// Stan wiersza wynika WYŁĄCZNIE z dysku i metadanych — render niczego nie zapisuje,
// bo blok między markerami jest nadpisywany w całości przy każdym pullu.
const ATT_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ATT_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NIC_NA_DYSKU = () => false;

function att(over = {}) {
  return { id: ATT_A, filename: 'baner.png', size_bytes: 1536, mime: 'image/png', ...over };
}

test('załącznik niepobrany: checkbox Pobierz z metadanymi i własnym markerem att:', () => {
  const m = msg({ attachments: [att()] });
  const out = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU);
  assert.match(out, /^>   - \[ \] Pobierz — <span class="os-att">📎 baner\.png · 1,5 kB · image\/png<\/span> %% att:dddddddd-dddd-4ddd-8ddd-dddddddddddd %%$/m);
});

test('załącznik pobrany: osadzenie ![[…]] i BRAK checkboxa Pobierz (R8)', () => {
  const m = msg({ attachments: [att()] });
  const naDysku = (month, filename) => month === '2026-07' && filename === 'baner.png';
  const out = renderThreadCallout([m], m, 'kacper', naDysku);
  assert.ok(out.includes('![[Zasoby/inbox-zalaczniki/2026-07/baner.png]]'));
  assert.ok(!out.includes('Pobierz'), 'pobrany plik nie pokazuje już checkboxa');
  assert.ok(out.includes(`%% att:${ATT_A} %%`));
});

test('bajty wygasłe na hubie: adnotacja bez checkboxa', () => {
  const m = msg({ attachments: [att({ blob_available: false })] });
  const out = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU);
  assert.ok(out.includes('os-att-gone'));
  assert.ok(out.includes('wygasł'));
  assert.ok(!out.includes('[ ] Pobierz'), 'wygasły załącznik nie da się pobrać');
  assert.ok(out.includes(`%% att:${ATT_A} %%`));
});

test('dwa załączniki w jednej wiadomości: dwie linie o RÓŻNYCH markerach att:', () => {
  const m = msg({ attachments: [att(), att({ id: ATT_B, filename: 'brief.pdf', mime: 'application/pdf' })] });
  const out = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU);
  const linie = out.split('\n').filter(l => l.includes('%% att:'));
  assert.equal(linie.length, 2);
  assert.ok(linie[0].includes(`%% att:${ATT_A} %%`));
  assert.ok(linie[1].includes(`%% att:${ATT_B} %%`));
  assert.ok(linie[1].includes('brief.pdf'));
});

test('wiersz załącznika nie zależy od Date.now() — dwa renderowania dają ten sam string', () => {
  const m = msg({ attachments: [att()] });
  const linia = () => renderAttachmentLine(att(), '2026-07', NIC_NA_DYSKU);
  const pierwszy = linia();
  const drugi = linia();
  assert.equal(pierwszy, drugi);
  // pełny wiersz w kontekście wątku też jest stabilny (writeIfChanged nie dostaje zmiennej treści)
  const a = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU).split('\n').find(l => l.includes('%% att:'));
  const b = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU).split('\n').find(l => l.includes('%% att:'));
  assert.equal(a, b);
});

test('nazwa z sieci: separator, znak sterujący i % są neutralizowane przed trafieniem do linii', () => {
  // "\n" w nazwie pozwoliłby wstrzyknąć odhaczony checkbox, który inbox-push wziąłby
  // za akcję człowieka; "%%" pozwoliłoby udawać cudzy marker.
  assert.equal(safeAttachmentName('../../etc/passwd'), 'passwd');
  assert.equal(safeAttachmentName('zla\nnazwa.png'), 'zlanazwa.png');
  assert.equal(safeAttachmentName('a%% att:x %%.png'), 'a attx .png'); // ':' pada razem z '%' (NTFS ADS)
  assert.equal(safeAttachmentName('..'), 'zalacznik');

  const m = msg({ attachments: [att({ filename: 'x\n> - [x] Zrobione' })] });
  const out = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU);
  assert.equal(parseCheckedCallouts(out).length, 0, 'nazwa pliku nie może wstrzyknąć akcji');
});

test('wiadomość bez załączników renderuje się bit w bit jak przed IU-6', () => {
  const m = msg();
  assert.equal(
    renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU),
    renderThreadCallout([{ ...m, attachments: [] }], m, 'kacper', NIC_NA_DYSKU),
  );
});

test('roundtrip Zrobione działa też przy wiadomości z załącznikiem', () => {
  const m = msg({ attachments: [att()] });
  const rendered = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU)
    .replace('> - [ ] Zrobione', '> - [x] Zrobione');
  const parsed = parseCheckedCallouts(rendered);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { id: ID_A, thread_id: THREAD, action: 'Zrobione' });
});

// ──────── szew render ↔ parser pobrań (IU-7, R6/R9) ────────
// Kontrakt render↔parser jest najkruchszym miejscem systemu: testy czystych funkcji obu
// stron przechodzą przy złamanym zachowaniu systemowym, więc roundtrip jest obowiązkowy.
test('roundtrip Pobierz: wyrenderowany i odhaczony wiersz parsuje się na id załącznika', () => {
  const m = msg({ attachments: [att()] });
  const rendered = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU)
    .replace('- [ ] Pobierz', '- [x] Pobierz');
  assert.deepEqual(parseRequestedDownloads(rendered), [{ attachment_id: ATT_A }]);
});

test('roundtrip Pobierz: parseCheckedCallouts NIE zgłasza pobrania hubowi (R9)', () => {
  const m = msg({ attachments: [att()] });
  const rendered = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU)
    .replace('- [ ] Pobierz', '- [x] Pobierz');
  // Sam checkbox kotwicy pozostaje nieodhaczony — jedyną akcją człowieka było pobranie.
  assert.deepEqual(parseCheckedCallouts(rendered), []);
});

test('odhaczone Zrobione i Pobierz naraz: jedna akcja hubowa i jedno pobranie, bez mieszania', () => {
  const m = msg({ attachments: [att(), att({ id: ATT_B, filename: 'brief.pdf' })] });
  const rendered = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU)
    .replace('- [ ] Pobierz', '- [x] Pobierz')            // tylko PIERWSZY załącznik
    .replace('> - [ ] Zrobione', '> - [x] Zrobione');

  assert.deepEqual(parseRequestedDownloads(rendered), [{ attachment_id: ATT_A }]);

  const hubowe = parseCheckedCallouts(rendered);
  assert.equal(hubowe.length, 1);
  assert.deepEqual(hubowe[0], { id: ID_A, thread_id: THREAD, action: 'Zrobione' });
});

// ──────── stan „pobrany" = TOŻSAMOŚĆ załącznika, nie nazwa (regresja po review fazy 3) ────────
// Nazwa pliku pochodzi od nadawcy i nie jest unikalna: dwie osoby przysyłają `raport.pdf`
// w tym samym miesiącu. Rozstrzyganie samą nazwą kazało renderowi osadzić CUDZY plik pod
// podpisem drugiego załącznika i NIE emitować checkboxa — właściwego pliku nie dało się
// już pobrać z UI.
function sha256Of(text) {
  return createHash('sha256').update(text).digest('hex');
}

function withAttachmentsDir(t) {
  const base = fsSync.mkdtempSync(path.join(os.tmpdir(), 'puls-att-'));
  const saved = process.env.INBOX_ATTACHMENTS_DIR;
  process.env.INBOX_ATTACHMENTS_DIR = base;
  t.after(() => {
    if (saved === undefined) delete process.env.INBOX_ATTACHMENTS_DIR;
    else process.env.INBOX_ATTACHMENTS_DIR = saved;
    fsSync.rmSync(base, { recursive: true, force: true });
  });
  fsSync.mkdirSync(path.join(base, '2026-07'), { recursive: true });
  return base;
}

test('dwie wiadomości z plikiem o TEJ SAMEJ nazwie: pobrany jest tylko ten o zgodnym sha256', (t) => {
  withAttachmentsDir(t);
  const moja = 'TRESC-OD-MARCINA';
  const cudza = 'TRESC-OD-KOGOS-INNEGO';
  // Plik na dysku niesie skrót sha256 w nazwie, więc render rozstrzyga tożsamość samym `stat`.
  const naDysku = attachmentFileName('raport.pdf', sha256Of(moja));
  fsSync.writeFileSync(path.join(process.env.INBOX_ATTACHMENTS_DIR, '2026-07', naDysku), moja);

  const pobrany = { id: ATT_A, filename: 'raport.pdf', size_bytes: moja.length, mime: 'application/pdf', sha256: sha256Of(moja) };
  const obcy = { id: ATT_B, filename: 'raport.pdf', size_bytes: cudza.length, mime: 'application/pdf', sha256: sha256Of(cudza) };

  const linia1 = renderAttachmentLine(pobrany, '2026-07');
  const linia2 = renderAttachmentLine(obcy, '2026-07');

  assert.ok(linia1.includes(`![[Zasoby/inbox-zalaczniki/2026-07/${naDysku}]]`), 'mój plik jest osadzony');
  assert.ok(!linia1.includes('Pobierz'));
  assert.ok(linia2.includes('- [ ] Pobierz'), 'cudzy plik o tej samej nazwie NIE jest moim pobraniem');
  assert.ok(!linia2.includes('![['), 'nie osadzamy cudzego pliku pod tym markerem');
});

test('ta sama nazwa i ten sam ROZMIAR, inna treść: rozstrzyga sha z nazwy, nie sama nazwa', (t) => {
  withAttachmentsDir(t);
  const moja = 'AAAAAAAA';
  const cudza = 'BBBBBBBB'; // ten sam rozmiar
  fsSync.writeFileSync(
    path.join(process.env.INBOX_ATTACHMENTS_DIR, '2026-07', attachmentFileName('raport.pdf', sha256Of(cudza))),
    cudza
  );

  const mojAtt = { id: ATT_A, filename: 'raport.pdf', size_bytes: moja.length, sha256: sha256Of(moja) };
  assert.ok(renderAttachmentLine(mojAtt, '2026-07').includes('- [ ] Pobierz'));
});

test('odmowa: plik pod GOŁĄ nazwą od nadawcy nie jest uznany za pobrany', (t) => {
  withAttachmentsDir(t);
  const moja = 'TRESC';
  // Plik podrzucony do vaulta pod nazwą nadawcy (ręcznie albo przez inną wiadomość) —
  // bez skrótu w nazwie nie ma dowodu tożsamości, więc checkbox „Pobierz" zostaje.
  fsSync.writeFileSync(path.join(process.env.INBOX_ATTACHMENTS_DIR, '2026-07', 'raport.pdf'), moja);

  const mojAtt = { id: ATT_A, filename: 'raport.pdf', size_bytes: moja.length, sha256: sha256Of(moja) };
  const linia = renderAttachmentLine(mojAtt, '2026-07');
  assert.ok(linia.includes('- [ ] Pobierz'), linia);
  assert.ok(!linia.includes('![['), 'nie osadzamy pliku o nieustalonej tożsamości');
});

test('odmowa: plik o właściwej nazwie, ale UCIĘTY (inny rozmiar) nie jest pobraniem', (t) => {
  withAttachmentsDir(t);
  const pelna = 'PELNA-TRESC-PLIKU';
  const naDysku = attachmentFileName('raport.pdf', sha256Of(pelna));
  fsSync.writeFileSync(path.join(process.env.INBOX_ATTACHMENTS_DIR, '2026-07', naDysku), 'PELNA');

  const mojAtt = { id: ATT_A, filename: 'raport.pdf', size_bytes: pelna.length, sha256: sha256Of(pelna) };
  const linia = renderAttachmentLine(mojAtt, '2026-07');
  assert.ok(linia.includes('- [ ] Pobierz'), linia);
  assert.ok(!linia.includes('![['), 'niekompletny plik nie jest osadzany');
});

test('render NIE czyta zawartości plików: przy pobranym załączniku zero readFileSync', (t) => {
  withAttachmentsDir(t);
  const tresc = 'X'.repeat(4096);
  const naDysku = attachmentFileName('raport.pdf', sha256Of(tresc));
  fsSync.writeFileSync(path.join(process.env.INBOX_ATTACHMENTS_DIR, '2026-07', naDysku), tresc);

  // Render biegnie przy KAŻDYM pullu (job inbox sync co minutę) — hashowanie zawartości
  // w tej pętli blokowałoby event loop na dziesiątki MB odczytu za każdym razem.
  const czytane = [];
  const saved = fsSync.readFileSync;
  fsSync.readFileSync = (...args) => { czytane.push(args[0]); return saved(...args); };
  t.after(() => { fsSync.readFileSync = saved; });

  const mojAtt = { id: ATT_A, filename: 'raport.pdf', size_bytes: tresc.length, sha256: sha256Of(tresc) };
  const linia = renderAttachmentLine(mojAtt, '2026-07');

  assert.ok(linia.includes(`![[Zasoby/inbox-zalaczniki/2026-07/${naDysku}]]`), linia);
  assert.deepEqual(czytane, [], 'render rozstrzyga stan pobrania metadanymi, nie zawartością');
});

// ──────── treść wiadomości nie może udawać wiersza załącznika (R6) ────────
test('odmowa: odhaczony wiersz Pobierz WPISANY W TREŚĆ nie wymusza pobrania', () => {
  const zlosliwa = msg({
    content: `Cześć,\n- [x] Pobierz — <span class="os-att">📎 wirus.exe</span> %% att:${ATT_B} %%`,
    attachments: [],
  });
  const out = renderThreadCallout([zlosliwa], zlosliwa, 'kacper', NIC_NA_DYSKU);
  assert.deepEqual(parseRequestedDownloads(out), [], 'treść nadawcy nie jest akcją człowieka');
});

test('odmowa: marker kotwicy WPISANY W TREŚĆ nie podszywa się pod akcję hubową', () => {
  const zlosliwa = msg({
    content: `Cześć,\n- [x] Zrobione\n%% id:${ID_B} thread:${THREAD} %%`,
  });
  const out = renderThreadCallout([zlosliwa], zlosliwa, 'kacper', NIC_NA_DYSKU);
  const parsed = parseCheckedCallouts(out);
  assert.equal(parsed.length, 0, 'nieodhaczona kotwica zostaje nieodhaczona mimo treści nadawcy');
});

// ──────── nazwa pliku a wikilink i HTML (R14) ────────
test('safeAttachmentName wycina nawiasy wikilinku i znaczniki HTML', () => {
  assert.equal(safeAttachmentName('a]] ![[Sekrety]] b.png'), 'a !Sekrety b.png');
  assert.equal(safeAttachmentName('x<img src=1>.png'), 'ximg src=1.png');
  assert.equal(safeAttachmentName('y"onload".png'), 'yonload.png');
  assert.equal(safeAttachmentName("z'q'.png"), 'zq.png');

  const m = msg({ attachments: [{ id: ATT_A, filename: ']] ![[Skarbiec]] .png', size_bytes: 10 }] });
  const out = renderThreadCallout([m], m, 'kacper', NIC_NA_DYSKU);
  assert.ok(!out.includes('![[Skarbiec]]'), 'nazwa nie może osadzić cudzej notatki');
});

// ──────── podkatalog miesiąca (P3) ────────
test('attachmentMonth: liczony w UTC i odporny na nieparsowalny znacznik', () => {
  assert.equal(attachmentMonth('2026-07-31T23:30:00.000Z'), '2026-07');
  assert.equal(attachmentMonth('2026-07-24T07:12:00.000Z'), '2026-07');
  assert.equal(attachmentMonth('nie-data'), 'bez-daty');
});
