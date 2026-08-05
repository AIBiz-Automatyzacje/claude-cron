#!/usr/bin/env node
// Puls — kontrola spójności instalacji (U8).
//
// Dwie kontrole, jeden mechanizm („wykryj rozjazd → powiedz człowiekowi"):
//   1. motyw Skrzynki — snippet `<vault>/.obsidian/snippets/skrzynka.css` kontra szablon
//      w pluginie zespołowym (`skills/onboard/templates/skrzynka.css`),
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
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// Znacznik tożsamości zadania — jedyne kryterium „czy takie zadanie już wisi".
export const TASK_MARKER = '%% puls:consistency-check %%';

// Komenda naprawcza motywu. Skill `onboard` żyje w pluginie zespołowym (poza tym repo),
// więc stała jest tu przepisana świadomie — zmiana nazwy trybu w SKILL.md wymaga zmiany tutaj.
export const THEME_FIX_COMMAND = '/onboard --refresh-theme';

// Komenda naprawcza wersji: ponowna instalacja zapisuje `data/version.json` (U1).
export const VERSION_FIX_COMMAND = 'ponownie uruchom instalator Pulsa (install.sh / install.ps1)';

const TASK_TITLE = 'Puls — kontrola spójności';
const TASK_SLUG = 'puls-kontrola-spojnosci';
const THEME_SNIPPET_RELATIVE = path.join('.obsidian', 'snippets', 'skrzynka.css');
const TEMPLATE_RELATIVE = path.join('skills', 'onboard', 'templates', 'skrzynka.css');
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
// `vaultCss === null` znaczy „snippetu w vaultcie nie ma" (nie to samo co pusty plik).
export function detectDrifts({ vaultCss, templateCss, version }) {
  const drifts = [];

  if (vaultCss === null) {
    drifts.push({
      id: 'theme-missing',
      opis: 'W vaultcie brakuje snippetu `.obsidian/snippets/skrzynka.css` — Skrzynka renderuje się bez motywu.',
      komenda: THEME_FIX_COMMAND,
    });
  } else if (normalizeCss(vaultCss) !== normalizeCss(templateCss)) {
    drifts.push({
      id: 'theme-drift',
      opis: 'Snippet `skrzynka.css` w vaultcie różni się od szablonu w pluginie zespołowym — Skrzynka wygląda inaczej niż u reszty zespołu.',
      komenda: THEME_FIX_COMMAND,
    });
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
    'Puls wykrył rozjazd między tą maszyną a stanem wzorcowym. Naprawa to jedna komenda —',
    'zadanie znika po ponownym przebiegu kontroli.',
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
export async function resolveThemeTemplate({
  installedPluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'),
  override = process.env.PULS_THEME_TEMPLATE || '',
} = {}) {
  if (override) return (await readFileOrNull(override)) === null ? null : override;

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

    const direct = path.join(installPath, TEMPLATE_RELATIVE);
    if ((await readFileOrNull(direct)) !== null) return direct;

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
      const candidate = path.join(installPath, 'plugins', dir.name, TEMPLATE_RELATIVE);
      if ((await readFileOrNull(candidate)) !== null) return candidate;
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
  templatePath,
  version,
  now = new Date(),
  log = console.log,
} = {}) {
  if (!workspace) throw new Error('Brak CLAUDE_CRON_WORKSPACE — nie wiem, gdzie leży vault');

  // Puls bez pluginu zespołowego (np. VPS) nie ma z czym porównywać motywu — kończymy cicho.
  // Zadanie „zaktualizuj motyw" na maszynie bez motywu byłoby szumem, nie sygnałem.
  if (!templatePath) {
    log('[consistency-check] Brak szablonu motywu w pluginie — pomijam kontrolę.');
    return 'no_template';
  }

  const templateCss = await readFileOrNull(templatePath);
  if (templateCss === null) {
    log(`[consistency-check] Szablon ${templatePath} zniknął — pomijam kontrolę.`);
    return 'no_template';
  }

  const vaultCss = await readFileOrNull(path.join(workspace, THEME_SNIPPET_RELATIVE));
  const drifts = detectDrifts({ vaultCss, templateCss, version });

  if (drifts.length === 0) {
    log('[consistency-check] Spójność OK — motyw zgodny z szablonem, wersja znana.');
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
  const templatePath = await resolveThemeTemplate();
  await runConsistencyCheck({ workspace, templatePath, version: getInstallVersion() });
}

// Entry-point guard przez realpath po OBU stronach — macOS symlinkuje /var i /tmp do /private/*.
if (process.argv[1]) {
  const { realpathSync } = require('node:fs');
  let isEntry = false;
  try {
    isEntry = realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
  } catch {
    isEntry = import.meta.url === pathToFileURL(process.argv[1]).href;
  }
  if (isEntry) {
    main().catch((e) => {
      console.error('[consistency-check] FATAL:', e.message);
      process.exit(1);
    });
  }
}
