// Testy kontroli spójności (U8): rozjazd motywu/wersji → JEDNO zadanie (linia w Dashboardzie
// + notatka z komendą naprawczą), rozpoznawane po linku do notatki (nie po tytule),
// bez duplikatów przy kolejnych przebiegach.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_MARKER,
  THEME_FIX_COMMAND,
  detectDrifts,
  hasOpenTask,
  insertDashboardEntry,
  renderTaskFile,
  resolveThemeTemplateDir,
  runConsistencyCheck,
} from './consistency-check.mjs';

const CSS = '.os-av { color: red; }\n';
const DASHBOARD_CSS = '.puls-dashboard { color: green; }\n';
const VERSION_OK = { revision: 'abc1234', installed_at: '2026-08-05T06:00:00.000Z', source: 'zip' };
const VERSION_UNKNOWN = { revision: 'unknown', installed_at: null, source: 'unknown' };
const NOW = new Date('2026-08-05T09:00:00.000Z');

const DASHBOARD = [
  '---',
  'ostatnia_aktualizacja: 2026-08-05 06:17',
  '---',
  '',
  '# Dashboard',
  '',
  '## 🔥 Zaległe',
  '',
  '- [ ] Stare zadanie — 🟢 · 01.08',
  '',
  '## ☀️ Dzisiaj — środa 05.08',
  '',
  '- [ ] Inne zadanie — 🟡 · 05.08',
  '',
].join('\n');

// Vault-atrapa: OBA snippety motywu + Dashboard + katalog zadań + katalog szablonów.
// `vaultCss`/`vaultDashboardCss` = null → snippetu w vaultcie nie ma;
// `templateDashboardCss` = null → plugin go nie dostarcza (starsza wersja pluginu).
async function makeWorkspace({
  vaultCss = CSS,
  vaultDashboardCss = DASHBOARD_CSS,
  templateDashboardCss = DASHBOARD_CSS,
  dashboard = DASHBOARD,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-consistency-'));
  await fs.mkdir(path.join(dir, '.obsidian', 'snippets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'Zadania'), { recursive: true });
  if (vaultCss !== null) {
    await fs.writeFile(path.join(dir, '.obsidian', 'snippets', 'skrzynka.css'), vaultCss, 'utf8');
  }
  if (vaultDashboardCss !== null) {
    await fs.writeFile(path.join(dir, '.obsidian', 'snippets', 'dashboard-todo.css'), vaultDashboardCss, 'utf8');
  }
  await fs.writeFile(path.join(dir, 'Zadania', 'Dashboard.md'), dashboard, 'utf8');

  const templateDir = path.join(dir, 'templates');
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(templateDir, 'skrzynka.css'), CSS, 'utf8');
  if (templateDashboardCss !== null) {
    await fs.writeFile(path.join(templateDir, 'dashboard-todo.css'), templateDashboardCss, 'utf8');
  }
  return { dir, templateDir };
}

// Skrót budujący wejście detectDrifts dla jednego snippetu — reszta listy zgodna.
function snippetsWith(overrides = {}) {
  return [
    { file: 'skrzynka.css', label: 'Skrzynka', vaultCss: CSS, templateCss: CSS },
    { file: 'dashboard-todo.css', label: 'Dashboard i lista zadań', vaultCss: DASHBOARD_CSS, templateCss: DASHBOARD_CSS },
  ].map((s) => (s.file === overrides.file ? { ...s, ...overrides } : s));
}

const NOTE_REL = path.join('Zadania', 'notatki', 'puls-kontrola-spojnosci.md');
const TASK_LINK = '[[Zadania/notatki/puls-kontrola-spojnosci|📎]]';

async function readDashboard(dir) {
  return fs.readFile(path.join(dir, 'Zadania', 'Dashboard.md'), 'utf8');
}

// Otwarte zadania kontroli = nieodhaczone linie z linkiem do notatki.
async function openTaskLines(dir) {
  return (await readDashboard(dir)).split('\n').filter((l) => l.startsWith('- [ ]') && l.includes(TASK_LINK));
}

async function noteExists(dir) {
  try {
    await fs.access(path.join(dir, NOTE_REL));
    return true;
  } catch {
    return false;
  }
}

const silent = () => {};

// === detectDrifts (pure) ===

test('oba snippety zgodne i wersja znana → brak rozjazdów', () => {
  assert.deepEqual(detectDrifts({ snippets: snippetsWith(), version: VERSION_OK }), []);
});

test('CRLF i końcowa pusta linia nie są rozjazdem', () => {
  const drifts = detectDrifts({
    snippets: snippetsWith({ file: 'skrzynka.css', vaultCss: '.os-av { color: red; }\r\n\r\n' }),
    version: VERSION_OK,
  });
  assert.deepEqual(drifts, []);
});

test('snippet Skrzynki rozjechany → rozjazd z komendą naprawczą', () => {
  const drifts = detectDrifts({
    snippets: snippetsWith({ file: 'skrzynka.css', vaultCss: '.os-av { color: blue; }' }),
    version: VERSION_OK,
  });
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].id, 'theme-drift:skrzynka.css');
  assert.equal(drifts[0].komenda, THEME_FIX_COMMAND);

  // Kontrakt U12 (domknięty 07.08): komenda naprawcza wskazuje tryb pluginu,
  // a ręczny fallback zostaje dla vaultów bez pluginu (port community w toku).
  assert.ok(THEME_FIX_COMMAND.includes('/onboard --refresh-theme'), 'komenda ma odsyłać do refresh-theme');
  assert.ok(THEME_FIX_COMMAND.includes('.obsidian/snippets/'), 'ręczny fallback zostaje');
});

// Sedno rozszerzenia: przed nim rozjazd Dashboardu był NIEWIDZIALNY — kontrola patrzyła
// wyłącznie na skrzynka.css, a to dashboard-todo.css maluje ekran oglądany najczęściej.
test('snippet Dashboardu rozjechany → osobny rozjazd, mimo zgodnej Skrzynki', () => {
  const drifts = detectDrifts({
    snippets: snippetsWith({ file: 'dashboard-todo.css', vaultCss: '.puls-dashboard { color: black; }' }),
    version: VERSION_OK,
  });
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].id, 'theme-drift:dashboard-todo.css');
  assert.ok(drifts[0].opis.includes('dashboard-todo.css'), 'opis nazywa KTÓRY plik jest stary');
});

test('oba snippety rozjechane → dwa rozjazdy w jednym przebiegu', () => {
  const snippets = snippetsWith({ file: 'skrzynka.css', vaultCss: 'inne' })
    .map((s) => (s.file === 'dashboard-todo.css' ? { ...s, vaultCss: 'tez inne' } : s));
  const drifts = detectDrifts({ snippets, version: VERSION_OK });
  assert.deepEqual(drifts.map((d) => d.id), ['theme-drift:skrzynka.css', 'theme-drift:dashboard-todo.css']);
});

test('brak snippetu w vaultcie → rozjazd theme-missing z nazwą pliku', () => {
  const drifts = detectDrifts({
    snippets: snippetsWith({ file: 'dashboard-todo.css', vaultCss: null }),
    version: VERSION_OK,
  });
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].id, 'theme-missing:dashboard-todo.css');
});

// Starszy plugin zespołowy zna tylko skrzynka.css. Zgłaszanie „brakuje dashboard-todo.css"
// byłoby zadaniem NIENAPRAWIALNYM — a takie uczą człowieka ignorować całą kontrolę.
test('plugin bez szablonu danego snippetu → cisza, nie fałszywy rozjazd', () => {
  const drifts = detectDrifts({
    snippets: snippetsWith({ file: 'dashboard-todo.css', vaultCss: null, templateCss: null }),
    version: VERSION_OK,
  });
  assert.deepEqual(drifts, []);
});

test('wersja unknown → rozjazd version-unknown', () => {
  const drifts = detectDrifts({ snippets: snippetsWith(), version: VERSION_UNKNOWN });
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].id, 'version-unknown');
});

// === renderTaskFile (pure) ===

test('notatka zadania ma znacznik i komendę naprawczą, bez frontmattera', () => {
  const out = renderTaskFile({
    drifts: detectDrifts({ snippets: snippetsWith({ file: 'skrzynka.css', vaultCss: 'inne' }), version: VERSION_OK }),
    now: NOW,
  });
  assert.ok(out.includes(TASK_MARKER));
  assert.ok(!out.startsWith('---'), 'notatka nie udaje pliku zadania');
  assert.ok(out.includes(THEME_FIX_COMMAND));
});

// === insertDashboardEntry (pure) ===

test('linia ląduje na początku sekcji Dzisiaj w formacie /daily', () => {
  const out = insertDashboardEntry(DASHBOARD, NOW);
  const lines = out.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('## ☀️ Dzisiaj'));
  assert.equal(lines[idx + 2], `- [ ] Puls — kontrola spójności ${TASK_LINK} — 🟡 · 05.08`);
  assert.ok(out.includes('- [ ] Inne zadanie — 🟡 · 05.08'), 'istniejące wpisy nietknięte');
});

test('Dashboard bez sekcji Dzisiaj → linia na końcu pliku (daily ją przestawi)', () => {
  const bare = '# Dashboard\n\n## 🗂️ Bez terminu\n';
  const out = insertDashboardEntry(bare, NOW);
  assert.ok(out.startsWith(bare.trimEnd()));
  assert.ok(out.trimEnd().endsWith(`${TASK_LINK} — 🟡 · 05.08`));
});

test('odhaczona linia nie jest otwartym zadaniem', () => {
  assert.equal(hasOpenTask(`- [x] Puls — kontrola spójności ${TASK_LINK} — 🟡 · 05.08`), false);
  assert.equal(hasOpenTask(`- [ ] Coś innego ${TASK_LINK} — 🟡 · 05.08`), true);
});

// === runConsistencyCheck (I/O na tmp) ===

test('zgodny snippet i znana wersja → brak zadania', async () => {
  const { dir, templateDir } = await makeWorkspace();

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'ok');
  assert.deepEqual(await openTaskLines(dir), []);
  assert.equal(await noteExists(dir), false);
});

test('snippet rozjechany → jedna linia w Dashboardzie + notatka z komendą', async () => {
  const { dir, templateDir } = await makeWorkspace({ vaultCss: '.os-av { color: blue; }' });

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'task_created');
  assert.equal((await openTaskLines(dir)).length, 1);
  assert.ok(!(await fs.readdir(path.join(dir, 'Zadania'))).includes('w_trakcie'), 'bez plików w w_trakcie/');

  const content = await fs.readFile(path.join(dir, NOTE_REL), 'utf8');
  assert.ok(content.includes(THEME_FIX_COMMAND), 'zadanie bez komendy naprawczej jest naganiaczem');
  // Kontrakt narracji (audyt C5, 08.08): zadanie mówi wprost o ręcznym zamknięciu —
  // poprzednie „zadanie znika po ponownym przebiegu" było fałszywe (kontrola nie kasuje).
  assert.ok(content.includes('zamknij to zadanie ręcznie'), 'zadanie ma instruować ręczne zamknięcie');
  assert.ok(!content.includes('znika po ponownym przebiegu'), 'fałszywa obietnica auto-kasowania usunięta');
  assert.ok(content.includes(TASK_MARKER));
});

test('drugi przebieg przy niezmienionym rozjeździe → brak drugiego zadania', async () => {
  const { dir, templateDir } = await makeWorkspace({ vaultCss: '.os-av { color: blue; }' });
  await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'task_exists');
  assert.equal((await openTaskLines(dir)).length, 1);
});

test('zmieniony tytuł linii i przeniesiona sekcja → dalej rozpoznane po linku, brak duplikatu', async () => {
  const { dir, templateDir } = await makeWorkspace({ vaultCss: '.os-av { color: blue; }' });
  await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  const dashboardPath = path.join(dir, 'Zadania', 'Dashboard.md');
  const renamed = (await readDashboard(dir)).replace('Puls — kontrola spójności', 'Coś zupełnie innego');
  await fs.writeFile(dashboardPath, renamed, 'utf8');

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'task_exists');
  const open = await openTaskLines(dir);
  assert.equal(open.length, 1);
  assert.ok(open[0].includes('Coś zupełnie innego'));
});

test('rozjazd naprawiony → kolejny przebieg nie tworzy nic nowego', async () => {
  const { dir, templateDir } = await makeWorkspace({ vaultCss: '.os-av { color: blue; }' });
  await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });
  // Człowiek odpalił komendę naprawczą i odhaczył linię.
  const dashboardPath = path.join(dir, 'Zadania', 'Dashboard.md');
  await fs.writeFile(dashboardPath, (await readDashboard(dir)).replace(`- [ ] Puls`, `- [x] Puls`), 'utf8');
  await fs.writeFile(path.join(dir, '.obsidian', 'snippets', 'skrzynka.css'), CSS, 'utf8');

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'ok');
  assert.deepEqual(await openTaskLines(dir), []);
});

test('zadanie odhaczone bez naprawy → rozjazd trwa, powstaje nowa linia', async () => {
  const { dir, templateDir } = await makeWorkspace({ vaultCss: '.os-av { color: blue; }' });
  await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });
  const dashboardPath = path.join(dir, 'Zadania', 'Dashboard.md');
  await fs.writeFile(dashboardPath, (await readDashboard(dir)).replace(`- [ ] Puls`, `- [x] Puls`), 'utf8');

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'task_created');
  assert.equal((await openTaskLines(dir)).length, 1);
});

test('stary dashboard-todo.css przy zgodnej Skrzynce → zadanie powstaje', async () => {
  // Realny scenariusz zespołu: motyw Skrzynki ktoś odświeżył, Dashboard został z kwietnia.
  const { dir, templateDir } = await makeWorkspace({ vaultDashboardCss: '.puls-dashboard { color: black; }' });

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'task_created');
  const content = await fs.readFile(path.join(dir, NOTE_REL), 'utf8');
  assert.ok(content.includes('dashboard-todo.css'), 'zadanie nazywa plik do odświeżenia');
  assert.ok(!content.includes('skrzynka.css` w vaultcie różni'), 'zgodny snippet nie jest zgłaszany');
});

test('plugin bez dashboard-todo.css → brak zadania mimo braku pliku w vaultcie', async () => {
  const { dir, templateDir } = await makeWorkspace({ vaultDashboardCss: null, templateDashboardCss: null });

  const status = await runConsistencyCheck({ workspace: dir, templateDir, version: VERSION_OK, now: NOW, log: silent });

  assert.equal(status, 'ok');
  assert.deepEqual(await openTaskLines(dir), []);
});

test('brak szablonu w pluginie → job kończy się cicho, bez zadania', async () => {
  const { dir } = await makeWorkspace({ vaultCss: '.os-av { color: blue; }' });

  const status = await runConsistencyCheck({ workspace: dir, templateDir: null, version: VERSION_UNKNOWN, now: NOW, log: silent });

  assert.equal(status, 'no_template');
  assert.deepEqual(await openTaskLines(dir), []);
});

test('brak workspace → czytelny błąd konfiguracji', async () => {
  await assert.rejects(
    () => runConsistencyCheck({ workspace: '', templateDir: null, version: VERSION_OK }),
    /CLAUDE_CRON_WORKSPACE/,
  );
});

// === resolveThemeTemplateDir ===

test('katalog szablonów znaleziony po installPath z installed_plugins.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-plugins-'));
  const installPath = path.join(dir, 'cache', 'aibiz');
  const templateDir = path.join(installPath, 'plugins', 'aibiz', 'skills', 'onboard', 'templates');
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(templateDir, 'skrzynka.css'), CSS, 'utf8');
  const installedFile = path.join(dir, 'installed_plugins.json');
  await fs.writeFile(installedFile, JSON.stringify({ plugins: { 'aibiz@aibiz': [{ installPath }] } }), 'utf8');

  const found = await resolveThemeTemplateDir({ installedPluginsFile: installedFile });

  assert.equal(found, templateDir);
});

// Sondą jest skrzynka.css (jest w każdej wersji pluginu). Katalog z samym dashboard-todo.css
// to nie katalog szablonów motywu — inaczej resolver wskazywałby przypadkowe miejsce.
test('katalog bez snippetu-sondy nie jest uznany za katalog szablonów', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-plugins-nosonda-'));
  const installPath = path.join(dir, 'cache', 'aibiz');
  const templateDir = path.join(installPath, 'skills', 'onboard', 'templates');
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(templateDir, 'dashboard-todo.css'), DASHBOARD_CSS, 'utf8');
  const installedFile = path.join(dir, 'installed_plugins.json');
  await fs.writeFile(installedFile, JSON.stringify({ plugins: { 'aibiz@aibiz': [{ installPath }] } }), 'utf8');

  assert.equal(await resolveThemeTemplateDir({ installedPluginsFile: installedFile }), null);
});

test('brak installed_plugins.json → null (Puls bez pluginu)', async () => {
  const found = await resolveThemeTemplateDir({
    installedPluginsFile: path.join(os.tmpdir(), 'nie-ma-takiego-pliku-puls.json'),
  });

  assert.equal(found, null);
});
