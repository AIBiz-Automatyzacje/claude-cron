#!/usr/bin/env node
// Puls — kontrola spójności instalacji (U8).
//
// Dwie kontrole, jeden mechanizm („wykryj rozjazd → powiedz człowiekowi"):
//   1. motyw — snippety `<vault>/.obsidian/snippets/*.css` (Skrzynka ORAZ Dashboard/zadania)
//      kontra szablony w pluginie zespołowym (`skills/onboard/templates/`),
//   2. wersja zainstalowanego kodu (`data/version.json`, lib/version.js) — `unknown` znaczy,
//      że instalacja nie wie, z czym pracuje, i każda diagnoza po fakcie jest zgadywaniem.
//
// Wynik rozjazdu to ZADANIE w vaultcie — plik w `Zadania/w_trakcie/` z `termin:` (bez terminu
// wypada z Dashboardu i nikt go nie zobaczy) i z KOMENDĄ NAPRAWCZĄ w treści (zadanie bez
// dźwigni jest naganiaczem i zostanie zamknięte bez naprawy).
//
// Bez maszyny stanu: zadanie wisi, dopóki rozjazd istnieje. Duplikat rozpoznajemy po UKRYTYM
// ZNACZNIKU w treści (`%% puls:consistency-check %%`), nie po tytule ani nazwie pliku —
// tytuł zmieni się przy pierwszym porządkowaniu Dashboardu, a job zacząłby mnożyć kopie.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// Znacznik tożsamości zadania — jedyne kryterium „czy takie zadanie już wisi".
export const TASK_MARKER = '%% puls:consistency-check %%';

// Kroki naprawcze motywu: `/onboard --refresh-theme` istnieje od 07.08 (aibiz-plugin @ 024aeff
// — domknięcie U12) i robi całość jedną akcją. Ręczny fallback zostaje w drugiej części,
// bo port skilla do pluginu społeczności jest w toku — zadanie ma dawać dźwignię każdemu,
// także vaultom bez pluginu zespołowego.
export const THEME_FIX_COMMAND =
  'w sesji Claude Code z vaulta: /onboard --refresh-theme (najpierw zaktualizuj plugin: ' +
  'marketplace → plugin → restart sesji); bez pluginu ręcznie: skopiuj skrzynka.css ' +
  'z pluginu zespołowego (skills/onboard/templates/) do <vault>/.obsidian/snippets/ ' +
  'i włącz snippet w Ustawienia → Wygląd → Fragmenty CSS';

// Komenda naprawcza wersji: ponowna instalacja zapisuje `data/version.json` (U1).
export const VERSION_FIX_COMMAND = 'ponownie uruchom instalator Pulsa (install.sh / install.ps1)';

const TASK_TITLE = 'Puls — kontrola spójności';
const TASK_SLUG = 'puls-kontrola-spojnosci';

// Motyw to DWA snippety, nie jeden. Kontrola pilnowała wyłącznie `skrzynka.css`, więc
// `dashboard-todo.css` mógł być dowolnie stary i nikt się o tym nie dowiadywał — a to on
// odpowiada za wygląd Dashboardu i listy zadań, czyli ekranu oglądanego najczęściej.
// Lista, nie dwie kopie kodu: trzeci snippet dopisuje się tu jednym wierszem.
export const THEME_SNIPPETS = [
  { file: 'skrzynka.css', label: 'Skrzynka' },
  { file: 'dashboard-todo.css', label: 'Dashboard i lista zadań' },
];
const SNIPPETS_DIR_RELATIVE = path.join('.obsidian', 'snippets');
const TEMPLATE_DIR_RELATIVE = path.join('skills', 'onboard', 'templates');
const TASKS_DIR_RELATIVE = path.join('Zadania', 'w_trakcie');
const DASHBOARD_RELATIVE = path.join('Zadania', 'Dashboard.md');

// Sekcja Dashboardu dla zadań z terminem „dzisiaj". Nagłówek nosi datę („## ☀️ Dzisiaj — środa 05.08"),
// więc dopasowujemy po prefiksie, nie po całej linii.
const DASHBOARD_TODAY_HEADING = /^##\s+.*Dzisiaj/m;

// ──────── czyste funkcje ────────

// CRLF i końcowe białe znaki NIE są rozjazdem: snippet kopiowany na Windowsie (CAVE) ma inne
// zakończenia linii niż szablon w repo pluginu, a bez normalizacji zadanie wisiałoby tam
// w nieskończoność i nauczyłoby człowieka ignorować ten sygnał.
function normalizeCss(text) {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

// Zwraca listę rozjazdów: [{ id, opis, komenda }]. Pusta lista = wszystko zgodne.
// `snippets`: [{ file, label, vaultCss, templateCss }] — po jednym wpisie na plik motywu.
// `vaultCss === null` znaczy „snippetu w vaultcie nie ma" (nie to samo co pusty plik);
// `templateCss === null` znaczy „ten plugin go nie dostarcza" i jest MILCZĄCO pomijane:
// starszy plugin zespołowy zna tylko `skrzynka.css`, a zadanie „brakuje dashboard-todo.css"
// byłoby wtedy nienaprawialne i nauczyłoby człowieka ignorować całą kontrolę.
export function detectDrifts({ snippets = [], version }) {
  const drifts = [];

  for (const { file, label, vaultCss, templateCss } of snippets) {
    if (templateCss === null || templateCss === undefined) continue;

    if (vaultCss === null || vaultCss === undefined) {
      drifts.push({
        id: `theme-missing:${file}`,
        opis: `W vaultcie brakuje snippetu \`.obsidian/snippets/${file}\` — ${label} renderuje się bez motywu.`,
        komenda: THEME_FIX_COMMAND,
      });
    } else if (normalizeCss(vaultCss) !== normalizeCss(templateCss)) {
      drifts.push({
        id: `theme-drift:${file}`,
        opis: `Snippet \`${file}\` w vaultcie różni się od szablonu w pluginie zespołowym — ${label} wygląda inaczej niż u reszty zespołu.`,
        komenda: THEME_FIX_COMMAND,
      });
    }
  }

  // Świadomie NIE porównujemy z wersją zdalną — to należy do aktualizacji przyciskiem (U11).
  // Tu wykrywamy jedyny rozjazd widoczny lokalnie: instalacja bez zapisanej wersji.
  const revision = version && typeof version.revision === 'string' ? version.revision : '';
  if (!revision || revision === 'unknown') {
    drifts.push({
      id: 'version-unknown',
      opis: 'Puls nie wie, jaką wersję kodu ma zainstalowaną (brak `data/version.json`) — nie da się stwierdzić, czy ta maszyna ma aktualne poprawki.',
      komenda: VERSION_FIX_COMMAND,
    });
  }

  return drifts;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Treść zadania. Frontmatter zgodny z `Zadania/.szablony/szablon-zadania.md`; `termin` = dziś,
// bo bez terminu zadanie nie trafi do żadnej sekcji Dashboardu.
export function renderTaskFile({ drifts, now = new Date() }) {
  const today = formatDate(now);
  const lines = [
    '---',
    'status: w_trakcie',
    'priorytet: wazne',
    `termin: ${today}`,
    `utworzone: ${today}`,
    'projekt:',
    'rodzic:',
    '---',
    '',
    TASK_MARKER,
    '',
    `# ${TASK_TITLE}`,
    '',
    '## Cel',
    '',
    'Puls wykrył rozjazd między tą maszyną a stanem wzorcowym. Przy każdym punkcie są kroki',
    'naprawcze. Po naprawie zamknij to zadanie ręcznie — kontrola celowo nie kasuje zadań',
    'z Dashboardu (drugi przebieg nie tworzy duplikatu).',
    '',
    '## Do zrobienia',
    '',
  ];

  for (const drift of drifts) {
    lines.push(`- [ ] ${drift.opis}`);
    lines.push(`      → \`${drift.komenda}\``);
  }

  lines.push('', '---', '', `*Utworzono automatycznie przez job „${TASK_TITLE}": ${today}*`, '');
  return lines.join('\n');
}

// Linia wpisu w Dashboardzie (format z `utworz-zadanie`: link + emoji priorytetu).
export function dashboardEntryLine(slug) {
  return `- [ ] [[w_trakcie/${slug}|${TASK_TITLE}]] — 🟡`;
}

// Wstawia wpis na początek sekcji „Dzisiaj". Brak sekcji = zwracamy treść bez zmian —
// zadanie i tak ma `termin`, więc najbliższa regeneracja Dashboardu je pokaże.
export function insertDashboardEntry(dashboard, slug) {
  const entry = dashboardEntryLine(slug);
  if (dashboard.includes(`w_trakcie/${slug}`)) return dashboard;

  const match = DASHBOARD_TODAY_HEADING.exec(dashboard);
  if (!match) return dashboard;

  const headingEnd = dashboard.indexOf('\n', match.index);
  if (headingEnd === -1) return `${dashboard}\n\n${entry}\n`;

  const before = dashboard.slice(0, headingEnd + 1);
  const after = dashboard.slice(headingEnd + 1);
  // Nagłówek sekcji jest oddzielony od listy pustą linią — zachowujemy ten układ.
  return `${before}\n${entry}\n${after.replace(/^\n/, '')}`;
}

// ──────── I/O ────────

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Szablon motywu bierzemy z pluginu ZAINSTALOWANEGO (installed_plugins.json), nie ze skanu
// katalogu cache — cache trzyma wiele wersji po hashu commita i wybór „którejkolwiek"
// porównywałby vault z przypadkową, starą wersją szablonu.
// Wzorzec resolucji lustrzany do `lib/skills.js` (scanPluginSkills).
export async function resolveThemeTemplateDir({
  installedPluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'),
} = {}) {
  const raw = await readFileOrNull(installedPluginsFile);
  if (raw === null) return null;

  let installed;
  try {
    installed = JSON.parse(raw);
  } catch (err) {
    // Uszkodzony manifest to NIE to samo co „brak pluginu" — bez tego sygnału job
    // zaraportowałby „pomijam kontrolę" i cicho przestał pilnować motywu na zawsze.
    console.error(`[consistency-check] Nieczytelny ${installedPluginsFile}: ${err.message}`);
    return null;
  }

  const entries = Object.values(installed?.plugins || {}).flat();
  for (const entry of entries) {
    const installPath = entry?.installPath;
    if (!installPath) continue;

    // Sondą istnienia katalogu jest PIERWSZY snippet z listy: `skrzynka.css` jest w każdej
    // wersji pluginu zespołowego, więc jego brak znaczy „to nie ten katalog", a nie
    // „plugin nie ma motywu". Sam katalog może przy tym nie mieć nowszych plików — to
    // rozstrzyga detectDrifts (templateCss === null → pomijamy).
    const probe = THEME_SNIPPETS[0].file;

    const direct = path.join(installPath, TEMPLATE_DIR_RELATIVE);
    if ((await readFileOrNull(path.join(direct, probe))) !== null) return direct;

    // Zagnieżdżone pluginy: {installPath}/plugins/<nazwa>/skills/...
    let nested = [];
    try {
      nested = await fs.readdir(path.join(installPath, 'plugins'), { withFileTypes: true });
    } catch {
      // Sonda istnienia: plugin płaski nie ma podkatalogu `plugins/` — brak to normalny stan,
      // nie awaria (odpowiednik ENOENT w readFileOrNull).
      nested = [];
    }
    for (const dir of nested) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(installPath, 'plugins', dir.name, TEMPLATE_DIR_RELATIVE);
      if ((await readFileOrNull(path.join(candidate, probe))) !== null) return candidate;
    }
  }

  return null;
}

// Czy w `Zadania/w_trakcie/` wisi już zadanie kontroli — wyłącznie po znaczniku w treści.
async function findExistingTask(tasksDir) {
  let names = [];
  try {
    names = await fs.readdir(tasksDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }

  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const content = await readFileOrNull(path.join(tasksDir, name));
    if (content !== null && content.includes(TASK_MARKER)) return path.join(tasksDir, name);
  }
  return null;
}

// Nazwa pliku wolna od kolizji (konwencja `utworz-zadanie`: sufiks -2, -3, …).
async function freeTaskPath(tasksDir) {
  for (let i = 1; i < 100; i += 1) {
    const slug = i === 1 ? TASK_SLUG : `${TASK_SLUG}-${i}`;
    const candidate = path.join(tasksDir, `${slug}.md`);
    if ((await readFileOrNull(candidate)) === null) return { slug, filePath: candidate };
  }
  throw new Error('Nie mogę znaleźć wolnej nazwy pliku zadania');
}

// Zwraca 'no_template' | 'ok' | 'task_exists' | 'task_created' — status opisuje, CO się stało,
// żeby log joba nie kłamał o stanie maszyny.
export async function runConsistencyCheck({
  workspace,
  templateDir,
  version,
  now = new Date(),
  log = console.log,
} = {}) {
  if (!workspace) throw new Error('Brak CLAUDE_CRON_WORKSPACE — nie wiem, gdzie leży vault');

  // Puls bez pluginu zespołowego (np. VPS) nie ma z czym porównywać motywu — kończymy cicho.
  // Zadanie „zaktualizuj motyw" na maszynie bez motywu byłoby szumem, nie sygnałem.
  if (!templateDir) {
    log('[consistency-check] Brak szablonów motywu w pluginie — pomijam kontrolę.');
    return 'no_template';
  }

  const snippets = [];
  for (const { file, label } of THEME_SNIPPETS) {
    snippets.push({
      file,
      label,
      templateCss: await readFileOrNull(path.join(templateDir, file)),
      vaultCss: await readFileOrNull(path.join(workspace, SNIPPETS_DIR_RELATIVE, file)),
    });
  }

  // Zniknął KOMPLET szablonów (podmieniony/odinstalowany plugin) — nie ma z czym porównywać.
  if (snippets.every((s) => s.templateCss === null)) {
    log(`[consistency-check] Szablony w ${templateDir} zniknęły — pomijam kontrolę.`);
    return 'no_template';
  }

  const drifts = detectDrifts({ snippets, version });

  if (drifts.length === 0) {
    log('[consistency-check] Spójność OK — motyw zgodny z szablonami, wersja znana.');
    return 'ok';
  }

  const tasksDir = path.join(workspace, TASKS_DIR_RELATIVE);
  const existing = await findExistingTask(tasksDir);
  if (existing) {
    log(`[consistency-check] Rozjazd (${drifts.map((d) => d.id).join(', ')}) — zadanie już wisi: ${existing}`);
    return 'task_exists';
  }

  await fs.mkdir(tasksDir, { recursive: true });
  const { slug, filePath } = await freeTaskPath(tasksDir);
  await fs.writeFile(filePath, renderTaskFile({ drifts, now }), 'utf8');

  // Wpis w Dashboardzie to widoczność NATYCHMIAST; `termin:` w pliku to widoczność po
  // najbliższej regeneracji. Robimy oba — brak Dashboardu nie może wywalić joba.
  const dashboardPath = path.join(workspace, DASHBOARD_RELATIVE);
  const dashboard = await readFileOrNull(dashboardPath);
  if (dashboard !== null) {
    const updated = insertDashboardEntry(dashboard, slug);
    if (updated !== dashboard) await fs.writeFile(dashboardPath, updated, 'utf8');
  }

  log(`[consistency-check] Rozjazd (${drifts.map((d) => d.id).join(', ')}) — utworzono zadanie: ${filePath}`);
  return 'task_created';
}

async function main() {
  const workspace = process.env.CLAUDE_CRON_WORKSPACE;
  if (!workspace) {
    console.error('[consistency-check] Brak CLAUDE_CRON_WORKSPACE — nie wiem, gdzie leży vault.');
    process.exit(1);
  }

  const { getInstallVersion } = require('../lib/version.js');
  const templateDir = await resolveThemeTemplateDir();
  await runConsistencyCheck({ workspace, templateDir, version: getInstallVersion() });
}

// Entry-point guard przez realpath po OBU stronach — macOS symlinkuje /var i /tmp do /private/*.
// Ścieżkę modułu wyprowadzamy `fileURLToPath`, NIGDY `new URL(...).pathname`: pathname jest
// percent-encoded (katalog instalacji to wolne wejście usera — spacje, diakrytyki) i na Windowsie
// daje `/C:/...`. Wtedy realpathSync rzuca, guard cicho nie odpala main(), a job kończy się
// kodem 0 — Puls raportuje sukces przy NIEWYKONANEJ kontroli.
if (process.argv[1]) {
  const { realpathSync } = require('node:fs');
  const modulePath = fileURLToPath(import.meta.url);
  let isEntry = false;
  try {
    isEntry = realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    isEntry = path.resolve(process.argv[1]) === modulePath;
  }
  if (isEntry) {
    main().catch((e) => {
      console.error('[consistency-check] FATAL:', e.message);
      process.exit(1);
    });
  }
}
