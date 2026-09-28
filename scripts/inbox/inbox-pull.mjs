#!/usr/bin/env node
// Team OS — inbox pull job
// - Pełne callouts → Zadania/Skrzynka.md (dwie sekcje: Otrzymane + Wysłane, rebuild bloków między markerami)
// - Banner + top 3 skondensowane → Zadania/Dashboard.md (rebuild bloku między markerami;
//   nazwa z env-loadera — `to_do.md` wycofane, patrz DASHBOARD_FILENAMES)
// - Dane bierze z huba (`client.pull()`); oznaczanie pending → delivered robi hub.
// Odpalane co 1 min przez launchd/cron. Zero Claude CLI.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as inboxClient from './inbox-client.mjs';
import { loadEnv } from './env-loader.mjs';

const TOP_N_IN_DASHBOARD = 3;

// ──────── rendering ────────
// Redesign 07.2026 (mockup-skrzynka.html): karty wątków stylowane snippetem `skrzynka.css`
// (cssclasses: skrzynka). Renderer emituje inline HTML spany (os-av/os-who/os-tag/...) —
// Obsidian renderuje je w preview i live preview; kontrakt inbox-push (bloki `> `,
// marker %% id/thread %%, checkbox `- [x] Zrobione|Zapoznane`) pozostaje nietknięty.
const TYPE_EMOJI = { task: '📝', query: '❓', reply: '💬', close: '✅' };
const TYPE_LABEL = { task: 'zadanie', query: 'pytanie', reply: 'odpowiedź', close: 'zamknięcie' };
// Callout name per typ — task wymaga akcji wykonawczej, query wymaga odpowiedzi, reply jest info
const CALLOUT_NAME = { task: 'todo', query: 'question', reply: 'tip', close: 'note' };
const AUTO_REPLY_PREFIX = /^🤖 auto-odpowiedź asystenta:?\s*/;

function isAutoReply(m) {
  return m.payload?.auto_reply === true || AUTO_REPLY_PREFIX.test(m.content || '');
}
// `me` = wiadomość właściciela vaulta — CSS wyróżnia ją bez znajomości imion (plugin zespołowy).
function avatarSpan(user, { small = false, bot = false, me = false } = {}) {
  const slug = bot ? 'bot' : String(user).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const initial = bot ? '🤖' : String(user).charAt(0).toUpperCase();
  return `<span class="os-av${small ? ' s' : ''}${me ? ' me' : ''} u-${slug}">${initial}</span>`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtTimeShort(iso) {
  return new Date(iso).toLocaleString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}
function ago(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'przed chwilą';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
function delegateIcon(iso) {
  const hours = (Date.now() - new Date(iso).getTime()) / 3600000;
  return hours >= 48 ? '⚠️' : '⏳';
}

// ──────── załączniki (R5/R7/R8) ────────
// Katalog pobranych plików jest VAULT-WZGLĘDNY, bo trafia do wikilinku Obsidiana;
// bezwzględną ścieżkę tego samego katalogu daje `INBOX_ATTACHMENTS_DIR` (env-loader, IU-8).
export const ATTACHMENTS_REL_DIR = 'Zasoby/inbox-zalaczniki';

// Podkatalog miesiąca liczony z czasu WIADOMOŚCI, nie z `Date.now()`: wiersz przerenderowany
// po przełomie miesiąca musi wskazywać ten sam plik, a `writeIfChanged` nie może dostać
// zmiennej w czasie treści (inaczej zapis co minutę i wyścig z Obsidian Sync).
// Eksportowana, bo TEN SAM podkatalog musi wyliczyć krok pobrań (attachments.mjs): render
// sprawdza obecność pliku pod <dir>/<miesiąc>/<nazwa>, downloader pod tą ścieżką zapisuje.
// Rozjazd o jeden miesiąc znaczy „pobrane, a checkbox wraca przy każdym syncu" — to kontrakt,
// nie przypadkowa duplikacja, więc żyje w jednej funkcji.
// Liczone w UTC, nie w czasie lokalnym: `created_at` jest znacznikiem UTC, więc wiadomość
// z 2026-07-31T23:30:00Z w strefie +02:00 wpadłaby do `2026-08`, a po zmianie strefy render
// szukałby jej pliku w `2026-07` — checkbox „Pobierz" wracałby przy każdym syncu.
// Znacznik nieparsowalny (ręczna edycja, stary rekord) dostaje stały kosz `bez-daty`;
// `NaN-NaN` byłoby prawdziwą nazwą katalogu w vaultcie.
export function attachmentMonth(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'bez-daty';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Nazwa pliku pochodzi z SIECI (metadane nadawcy) i trafia i na dysk, i do linii Skrzynki
// o kontrakcie liniowym. Hub odrzuca separatory i znaki sterujące (isUnsafeFilename), ale
// render nie może na tym polegać — pojedynczy `\n` w nazwie pozwoliłby wstrzyknąć odhaczony
// checkbox, który inbox-push odczytałby jako akcję człowieka. `%` neutralizujemy, bo z niego
// zbudowany jest marker `%% att:… %%` — nazwa nie może udawać cudzego markera. Nawiasy
// kwadratowe, `<`, `>` i cudzysłowy wycinamy, bo nazwa trafia i do WIKILINKU Obsidiana
// (`]]` + `![[` osadziłoby w Skrzynce odbiorcy dowolną notatkę z jego vaulta, wybraną przez
// nadawcę), i do wnętrza spana `os-att` (`<img src=…>` byłby beaconem otwarcia Skrzynki).
export function safeAttachmentName(raw) {
  const base = path.basename(String(raw ?? '')).replace(/[/\\:%<>"'[\]\u0000-\u001f]/g, '').trim();
  return base === '' || base === '.' || base === '..' ? 'zalacznik' : base;
}

function formatAttachmentSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  const unit = n < 1024 * 1024 ? 'kB' : 'MB';
  const value = n < 1024 * 1024 ? n / 1024 : n / (1024 * 1024);
  return `${value.toFixed(1).replace('.', ',')} ${unit}`;
}

// Tożsamość załącznika (rozmiar + sha256), nie goła nazwa, rozstrzyga „czy to mój plik":
// nazwa pochodzi od nadawcy i nie jest unikalna — dwie wiadomości od różnych osób z plikiem
// `raport.pdf` w tym samym miesiącu dawały ten sam werdykt, więc druga renderowała się jako
// „pobrana" i osadzała CUDZY plik pod własnym podpisem, bez checkboxa do pobrania właściwego.
//
// Tożsamość niesie NAZWA PLIKU NA DYSKU: skrót sha256 w sufiksie. Dzięki temu render kosztuje
// jedno `stat` na załącznik i NIGDY nie czyta zawartości — a render biegnie przy każdym pullu,
// czyli co minutę przez job inbox sync (hashowanie w tej pętli blokowałoby event loop na
// dziesiątki MB odczytu za każdym razem). Downloader zapisuje pod DOKŁADNIE tą nazwą
// (`pickDownloadDestination` w attachments.mjs) — to kontrakt renderu z pobieraniem.
export const SHA_NAME_LEN = 12;

export function attachmentFileName(filename, sha256) {
  // Hub bez sha256 w metadanych (instalacja sprzed IU-6) — zostaje goła nazwa nadawcy.
  if (typeof sha256 !== 'string' || sha256 === '') return filename;
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem} (${sha256.slice(0, SHA_NAME_LEN)})${ext}`;
}

// Stan „pobrany" wynika WYŁĄCZNIE z obecności pliku na dysku (R8) — zero zapisu stanu
// gdziekolwiek, bo blok między markerami jest nadpisywany w całości przy każdym pullu.
// Zwraca NAZWĘ pliku na dysku (ze skrótem sha) albo false.
function defaultIsDownloaded(month, filename, att = {}) {
  const dir = process.env.INBOX_ATTACHMENTS_DIR;
  if (!dir) return false;
  const candidate = attachmentFileName(filename, att.sha256);
  let st;
  try {
    st = fsSync.statSync(path.join(dir, month, candidate));
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  // Rozmiar dokłada się do skrótu w nazwie: plik ucięty w połowie (przerwany zapis spoza
  // naszej ścieżki, konflikt Obsidian Sync) nie może uchodzić za kompletne pobranie.
  const size = Number(att.size_bytes);
  if (Number.isFinite(size) && st.size !== size) return false;
  return candidate;
}

// Trzy stany, rozstrzygane wyłącznie dyskiem i metadanymi:
// 1) plik na dysku → osadzenie, BEZ checkboxa (odhaczenie już nic nie znaczy);
// 2) bajty na hubie → checkbox „Pobierz" (akcja lokalna, patrz IU-7 — nigdy nie idzie do huba);
// 3) `blob_available === false` → adnotacja o wygaśnięciu, bez checkboxa (po limicie 90 dni
//    to ścieżka normalna, nie przypadek brzegowy). Brak pola = bajty są (hub sprzed retencji).
export function renderAttachmentLine(att, month, isDownloaded = defaultIsDownloaded) {
  const name = safeAttachmentName(att.filename);
  const marker = `%% att:${att.id} %%`;
  const meta = [name, formatAttachmentSize(att.size_bytes), att.mime].filter(Boolean).join(' · ');

  // Wstrzykiwana atrapa może zwrócić `true` (kształt sprzed rozstrzygania tożsamością);
  // realna implementacja zwraca NAZWĘ pliku, bo przy kolizji leży on pod sufiksem.
  const onDisk = isDownloaded(month, name, att);
  if (onDisk) {
    const linkName = typeof onDisk === 'string' ? onDisk : name;
    return `>   - <span class="os-att">📎 ${name}</span><br>![[${ATTACHMENTS_REL_DIR}/${month}/${linkName}]] ${marker}`;
  }
  if (att.blob_available === false) {
    return `>   - <span class="os-att os-att-gone">📎 ${meta} · wygasł — poproś nadawcę o ponowne wysłanie</span> ${marker}`;
  }
  return `>   - [ ] Pobierz — <span class="os-att">📎 ${meta}</span> ${marker}`;
}

// Wiersze renderowane PRZY SWOJEJ wiadomości (R5) i wcięte jak linie kontynuacji, więc
// należą do jej pozycji listy. Każdy niesie WŁASNY marker `%% att:<uuid> %%` — istniejący
// `%% id:… thread:… %%` identyfikuje wyłącznie kotwicę wątku i nie rozróżnia ani wiadomości
// w wątku, ani plików w wiadomości. Rekord bez id albo bez nazwy jest pomijany: bez id nie
// da się go odhaczyć, a wiersz-widmo tylko myliłby człowieka.
function renderAttachmentLines(m, isDownloaded) {
  const list = Array.isArray(m.attachments) ? m.attachments : [];
  const month = attachmentMonth(m.created_at);
  return list
    .filter(att => att && typeof att.id === 'string' && att.id !== '' && att.filename)
    .map(att => renderAttachmentLine(att, month, isDownloaded));
}

// Renderuje JEDNĄ wiadomość nitki jako li z awatarem: człowiek = inicjał w kolorze osoby,
// agent (payload.auto_reply) = 🤖 + badge AUTO + prefix zdjęty z treści + linia „Źródło:" jako pill.
// Treść wiadomości pochodzi od INNEGO członka przez hub — to wejście niezaufane, a linie
// kontynuacji renderujemy dosłownie z tym samym wcięciem (`>   `), co wiersze załączników.
// Bez neutralizacji nadawca wstawiał w treść własny odhaczony `- [x] Pobierz … %% att:<id> %%`
// i WYMUSZAŁ pobranie pliku (do 25 MB, rozsiewanego przez Obsidian Sync) na maszynę odbiorcy
// bez żadnej jego akcji; ten sam trik z `%% id:… thread:… %%` podszywa się pod kotwicę wątku.
// Zerowej szerokości spacja (budowana z kodu, nie wklejona do źródła) rozbija oba wzorce,
// a dla człowieka linia wygląda identycznie.
function neutralizeContentLine(line) {
  const zeroWidth = String.fromCharCode(0x200b);
  return line
    .replace(/^(\s*)-(\s*\[)/, `$1-${zeroWidth}$2`)
    .replaceAll('%%', `%${zeroWidth}%`);
}

function renderMessage(m, isDownloaded = defaultIsDownloaded, me = null) {
  const auto = isAutoReply(m);
  const raw = auto ? (m.content || '').replace(AUTO_REPLY_PREFIX, '') : (m.content || '');
  const lines = raw.trim().split('\n').map(l => {
    // Pill „Źródło:" należy do renderu auto-odpowiedzi (prefix zdejmuje `AUTO_REPLY_PREFIX`),
    // więc dla wiadomości człowieka ta gałąź w ogóle nie istnieje — inaczej DOWOLNY nadawca
    // wpisywał w treść linię `Źródło: …` i wychodził poza neutralizację. Sama wartość też
    // przechodzi przez `neutralizeContentLine`: bez tego podstawiony `%% id:… thread:… %%`
    // trafiał do calloutu jako PIERWSZE dopasowanie markera i podszywał się pod kotwicę wątku
    // (parseCheckedCallouts w inbox-push.mjs bierze pierwsze trafienie w bloku).
    const src = auto ? l.match(/^Źródło:\s*(.+)$/) : null;
    return src ? `<span class="os-src">📄 ${neutralizeContentLine(src[1])}</span>` : neutralizeContentLine(l);
  });
  const who = auto
    ? `<span class="os-who">Asystent @${m.from_user}</span> <span class="os-time">· ${fmtTimeShort(m.created_at)}</span> <span class="os-auto">AUTO</span>`
    : `<span class="os-who">@${m.from_user}</span> <span class="os-time">· ${fmtTimeShort(m.created_at)}</span>`;
  const head = `> - ${avatarSpan(m.from_user, { bot: auto, me: !auto && me != null && m.from_user === me })}${who}<br>${lines[0] || ''}`;
  const cont = lines.slice(1).map(l => `>   ${l}`);
  return [head, ...cont, ...renderAttachmentLines(m, isDownloaded)].join('\n');
}

// Renderuje JEDEN callout na cały wątek — nitka chronologicznie w środku.
// thread = posortowane chronologicznie wiadomości jednego thread_id (root = pierwsza).
// anchor = pierwsza aktywna (nie-done) wiadomość DO MNIE — jej id/typ trafiają do markera i checkboxa
//          (kontrakt push-job: SELECT WHERE id, walidacja to_user + typ → akcja).
// me = tożsamość z huba (pole `user` z pull) — kierunek w metadanych („Ty → @x" vs „od @x").
// isDownloaded wstrzykiwane dla testowalności (stan załącznika = obecność pliku na dysku).
export function renderThreadCallout(thread, anchor, me, isDownloaded = defaultIsDownloaded, freshIds = new Set()) {
  const root = thread[0];
  const threadId = root.thread_id || root.id;
  const name = CALLOUT_NAME[root.type] || 'note';
  // `freshIds` to id-ki, które w TYM przebiegu syncu przyszły jeszcze jako `pending`.
  // Krok pobrań robi własny `pull`, a pull po stronie huba przestawia pending→delivered —
  // bez przeniesienia tej wiedzy druga odpowiedź nigdy nie miałaby badge'u „nowe".
  const isFresh = thread.some(r => r.status === 'pending' || freshIds.has(r.id));

  const tags = [
    isFresh ? '<span class="os-tag t-new">nowe</span>' : null,
    `<span class="os-tag t-${root.type}">${TYPE_EMOJI[root.type] || '📝'} ${TYPE_LABEL[root.type] || 'wiadomość'}</span>`,
  ].filter(Boolean).join(' ');
  const dir = root.from_user === me ? `Ty → @${root.to_user}` : `od @${root.from_user}`;
  const meta = `<span class="os-meta">${dir} · ${fmtTime(root.created_at)}</span>`;

  // Checkbox wg typu kotwicy — task czeka na "Zrobione", reszta na "Zapoznane";
  // hint w tej samej linii (regex pusha matchuje prefix, span mu nie przeszkadza)
  const checkboxLabel = anchor.type === 'task' ? 'Zrobione' : 'Zapoznane';
  const hint = anchor.type === 'task'
    ? '<span class="os-hint">odhaczenie odsyła potwierdzenie i zamyka wątek</span>'
    : '<span class="os-hint">dopytaj: `/deleguj reply --thread-id <id z dołu>` albo odhacz ✅</span>';

  const messages = thread.map(m => renderMessage(m, isDownloaded, me)).join('\n');

  return [
    `> [!${name}${isFresh ? '|fresh' : ''}]- ${root.title}`,
    `> ${tags} ${meta}`,
    '>',
    messages,
    '>',
    // Komentarz HTML twardo zamyka listę wiadomości — sama pusta linia `>` NIE kończy
    // listy w markdownie, więc checkbox lądował w TYM SAMYM <ul> co wiadomości i CSS
    // (selektory ul:has/:not(:has)) stylował całość jako stopkę: awatar na tekście,
    // zero wcięcia, checkbox przyklejony. Separator = dwie osobne listy, zawsze.
    '> <!--os-thread-sep-->',
    '>',
    `> - [ ] ${checkboxLabel} ${hint}`,
    `> %% id:${anchor.id} thread:${threadId} %%`,
  ].join('\n');
}

function renderDashboardLine(row) {
  const emoji = TYPE_EMOJI[row.type] || '📝';
  return `- ${emoji} @${row.from_user} · ${fmtTimeShort(row.created_at)} — **${row.title}**`;
}
function renderDelegatedLine(row) {
  return `- ${delegateIcon(row.created_at)} @${row.to_user} · czeka ${ago(row.created_at)} — **${row.title}**`;
}
// Każda delegacja = OSOBNY zwijany callout (spójnie z kartami Otrzymanych): tytuł widoczny
// i klikalny (fold), w środku pill czasu + data + pełna treść wysłanej wiadomości.
// Marker %% thread %% per karta (ukryty w preview, do skopiowania dla /deleguj reply).
export function renderDelegatedCallout(rows) {
  return rows.map(row => {
    const icon = delegateIcon(row.created_at);
    const stale = icon === '⚠️';
    const threadId = row.thread_id || row.id;
    const head = `> [!delegated]- ${TYPE_EMOJI[row.type] || '📝'} ${row.title} · @${row.to_user} ` +
      `<span class="os-since">wysłane ${fmtTime(row.created_at)}</span>`;
    const meta = `> <span class="os-wait${stale ? ' stale' : ''}">${icon} czeka ${ago(row.created_at)}</span>`;
    const content = (row.content || '').trim();
    const body = content ? ['>', ...content.split('\n').map(l => `> ${l}`)] : [];
    return [head, meta, ...body, `> %% thread:${threadId} %%`].join('\n');
  }).join('\n\n');
}

// Link do archiwum bieżącego miesiąca — jedyne „drzwi" do zamkniętych wątków w pustym stanie
function archiveLink() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `[[Zasoby/inbox-archive/${ym}|📁 archiwum wątków →]]`;
}

// ──────── generic marker replace ────────
export function replaceBetweenMarkers(source, startMarker, endMarker, newContent) {
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(`Markers not found: ${startMarker} / ${endMarker}`);
  }
  // Zdublowany marker = plik USZKODZONY (najczęściej: tekstowy merge Obsidian Sync po
  // wyścigu dwóch maszyn — incydent 06.08 na hubie). Pisanie w pierwszy blok zagnieżdżałoby
  // treść coraz głębiej przy KAŻDYM pullu i cementowało uszkodzenie na zawsze — głośny fail
  // zostawia plik człowiekowi do ręcznej naprawy, a job sync zgłasza błąd zamiast udawać sukces.
  if (source.indexOf(startMarker, startIdx + startMarker.length) !== -1
    || source.indexOf(endMarker, endIdx + endMarker.length) !== -1) {
    throw new Error(
      `Zdublowany marker ${startMarker} / ${endMarker} — plik wygląda na uszkodzony ` +
        '(np. konflikt Obsidian Sync). Napraw go ręcznie: zostaw JEDNĄ parę markerów, resztę usuń.'
    );
  }
  const before = source.slice(0, startIdx + startMarker.length);
  const after = source.slice(endIdx);
  return before + '\n' + newContent + (newContent && !newContent.endsWith('\n') ? '\n' : '') + after;
}

// Grupuje płaskie wiersze po thread_id w nitki posortowane chronologicznie.
// threadRows = WSZYSTKIE wiadomości aktywnych wątków; activeForMe = moje nie-done (kotwice).
// Kolejność wątków: malejąco wg czasu kotwicy (najświeższe rozmowy na górze).
function buildThreadCallouts(threadRows, activeForMe, me, freshIds = new Set()) {
  const byThread = new Map();
  for (const row of threadRows) {
    const key = row.thread_id || row.id;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(row);
  }
  for (const msgs of byThread.values()) {
    msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  // Kotwica per wątek: pierwsza (najstarsza) aktywna wiadomość do mnie
  const anchors = new Map();
  const sortedActive = [...activeForMe].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const row of sortedActive) {
    const key = row.thread_id || row.id;
    if (!anchors.has(key)) anchors.set(key, row);
  }

  const callouts = [];
  for (const [key, anchor] of anchors) {
    const thread = byThread.get(key) || [anchor];
    callouts.push({
      anchorTime: new Date(anchor.created_at).getTime(),
      text: renderThreadCallout(thread, anchor, me, defaultIsDownloaded, freshIds),
    });
  }
  callouts.sort((a, b) => b.anchorTime - a.anchorTime);
  return callouts.map(c => c.text);
}

// ──────── Skrzynka.md writer (oba bloki w jednym pliku) ────────
// Self-heal: brak pliku (świeży onboarding, zguba po sync/backup) → utwórz z szablonu.
// Plik istniejący bez markerów NIE jest naprawiany — nie nadpisujemy cudzej treści (throw niżej).
export const SKRZYNKA_TEMPLATE = `---
status: w_trakcie
priorytet: normalne
termin: 2099-12-31
tags: [skrzynka, personal-team-os]
cssclasses: [skrzynka]
---

# Skrzynka

## Otrzymane

*0 nowych*

%% inbox:items:start %%
%% inbox:items:end %%

## Wysłane

*0 w toku*

%% delegated:items:start %%
%% delegated:items:end %%
`;

// ──────── frontmatter merge ────────
// Renderer podmienia tylko treść między markerami, więc zmiany SZABLONU (np. dodane
// `cssclasses: [skrzynka]`, od którego zależy cały CSS karty) nigdy nie docierały do plików
// utworzonych wcześniej — na jednej maszynie Skrzynka wyglądała poprawnie, na drugiej
// „na zepsutym CSS". Dlatego przy każdym pullu domergowujemy BRAKUJĄCE klucze z szablonu.
//
// Merge, nie nadpisanie: ludzie dopisują do frontmattera własne klucze i zmieniają wartości
// (własna lista cssclasses, inny status/termin). Klucz już obecny zostaje nietknięty —
// warunek, nie preferencja.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

// Dzieli ciało frontmattera na wpisy najwyższego poziomu. Linie kontynuacji (wcięcia,
// pozycje listy blokowej `- x`) doklejają się do ostatniego klucza — dzięki temu
// wartości wielolinijkowe przenoszą się z szablonu w całości.
function splitTopLevelEntries(body) {
  const entries = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (m) entries.push({ key: m[1], lines: [line] });
    else if (entries.length) entries[entries.length - 1].lines.push(line);
  }
  return entries;
}

export function mergeFrontmatter(raw, template = SKRZYNKA_TEMPLATE) {
  const tpl = FRONTMATTER_RE.exec(template);
  if (!tpl) return raw;

  const found = FRONTMATTER_RE.exec(raw);
  if (!found) {
    // Otwarcie `---` bez domknięcia to nie „brak frontmattera", tylko plik, którego
    // struktury nie rozumiemy — nie zgadujemy, zostawiamy nietknięty.
    if (/^---\r?\n/.test(raw)) return raw;
    return `---\n${tpl[1]}\n---\n${raw}`;
  }

  const existingKeys = new Set(splitTopLevelEntries(found[1]).map(e => e.key));
  const missing = splitTopLevelEntries(tpl[1]).filter(e => !existingKeys.has(e.key));
  if (!missing.length) return raw;

  const mergedBody = `${found[1].replace(/\s+$/, '')}\n${missing.map(e => e.lines.join('\n')).join('\n')}`;
  return `---\n${mergedBody}\n---${found[2]}${raw.slice(found[0].length)}`;
}

async function ensureSkrzynkaFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, SKRZYNKA_TEMPLATE, 'utf8');
    console.log(`[inbox-pull] created ${filePath} from template (self-heal)`);
    return SKRZYNKA_TEMPLATE;
  }
}

// Normalizacja nagłówków ISTNIEJĄCYCH plików do bieżącego szablonu. Szablon dotyka
// tylko NOWYCH plików, a renderer podmienia wyłącznie treść między markerami — bez tej
// podmiany stary nagłówek zostawałby na zawsze (ta sama pułapka co frontmatter, poz. 12).
// 06.08: „czekają na odpowiedź" kłamie przy taskach (one czekają na odhaczenie).
// 09.2026: nagłówki bez emoji (redesign „tusz") — CSS rozpoznaje sekcje po tekście.
function normalizeSectionHeadings(raw) {
  return raw
    .replace(/^# 📬 Skrzynka$/m, '# Skrzynka')
    .replace(/^## 📥 Otrzymane$/m, '## Otrzymane')
    .replace(/^## 📤 Wysłane(?: — czekają na odpowiedź)?$/m, '## Wysłane');
}

// eksportowane dla testu szwu (render + merge frontmattera + zapis na prawdziwym pliku)
export async function updateSkrzynkaFile(filePath, threadRows, activeForMe, delegatedItems, me, freshIds = new Set()) {
  // `original` = treść z DYSKU — to z nią porównuje writeIfChanged. Porównanie z już
  // znormalizowanym `raw` zjadało zapis, gdy jedyną różnicą był nagłówek (pusta skrzynka,
  // liczniki bez zmian → normalizacja nigdy nie trafiała do pliku).
  const original = await ensureSkrzynkaFile(filePath);
  const raw = normalizeSectionHeadings(original);
  const inboxCallouts = buildThreadCallouts(threadRows, activeForMe, me, freshIds);
  const inboxCount = activeForMe.length;
  const delegatedCount = delegatedItems.length;

  const inboxBody = inboxCallouts.length
    ? inboxCallouts.join('\n\n')
    : `> [!inbox-ok] Pusto. Nikt nic od Ciebie nie chce. · ${archiveLink()}`;
  const delegatedBody = delegatedItems.length
    ? renderDelegatedCallout(delegatedItems)
    : '> [!inbox-ok] Nic nie wisi na innych.';

  let updated = replaceBetweenMarkers(mergeFrontmatter(raw), '%% inbox:items:start %%', '%% inbox:items:end %%', inboxBody);
  updated = replaceBetweenMarkers(updated, '%% delegated:items:start %%', '%% delegated:items:end %%', delegatedBody);
  updated = updated.replace(/^\*\d+ now[a-z]+\*$/m, `*${inboxCount} ${inboxCount === 1 ? 'nowa' : 'nowych'}*`);
  updated = updated.replace(/^\*\d+ w toku\*$/m, `*${delegatedCount} w toku*`);

  await writeIfChanged(filePath, original, updated);
}

// Zapis TYLKO przy realnej zmianie treści.
//
// Job renderujący chodzi co minutę, więc bezwarunkowy `writeFile` to ~1440 zapisów
// dziennie na plik, z czego prawie wszystkie odtwarzają bajt w bajt to samo. Dla
// Obsidian Sync każdy taki zapis to ŚWIEŻA ZMIANA LOKALNA: Mac w kółko wypycha własną
// wersję i wygrywa konflikt z tym, co przyszło z innej maszyny. Tak `Dashboard.md`
// wygenerowany przez `/daily` na VPS nie miał szans dojść na Maca — ginął, zanim
// ktokolwiek go zobaczył (29.07: plik na Macu miał świeży mtime i wczorajszą treść).
async function writeIfChanged(filePath, before, after) {
  if (before === after) return false;
  await fs.writeFile(filePath, after, 'utf8');
  return true;
}

// ──────── dashboard banner writer ────────
// Polski plural — uproszczona reguła (1 / 2-4 / 5+). Dla MVP wystarczy.
function plural(n, one, few, many) {
  if (n === 1) return one;
  if (n >= 2 && n < 5) return few;
  return many;
}

// Redesign 07.2026: banner jako callouty Obsidiana ([!inbox] / [!delegated] / [!inbox-ok]),
// stylowane snippetem `dashboard-todo.css`. Pusty stan = jeden zielony pasek spokoju,
// nowe wiadomości = karta z listą. Czysty markdown, przeżywa regenerację między markerami.
function buildBanner({ inboxCount, taskCount, queryCount, topInbox, delegatedCount, staleDelegatedCount, topDelegated }) {
  const lines = [];

  // Inbox label — rozbicie na typy gdy są task/query, fallback total dla samych reply/close
  let inboxLabel;
  if (taskCount > 0 && queryCount > 0) {
    inboxLabel = `${taskCount} ${plural(taskCount, 'zadanie', 'zadania', 'zadań')} i ${queryCount} ${plural(queryCount, 'pytanie', 'pytania', 'pytań')}`;
  } else if (taskCount > 0) {
    inboxLabel = `${taskCount} ${plural(taskCount, 'zadanie', 'zadania', 'zadań')}`;
  } else if (queryCount > 0) {
    inboxLabel = `${queryCount} ${plural(queryCount, 'pytanie', 'pytania', 'pytań')}`;
  } else {
    inboxLabel = `${inboxCount} ${plural(inboxCount, 'nowa wiadomość', 'nowe wiadomości', 'nowych wiadomości')}`;
  }

  if (inboxCount === 0 && delegatedCount === 0) {
    lines.push('> [!inbox-ok] Skrzynka pusta, nic nie czeka na innych. · [[Skrzynka|otwórz]]');
    return lines.join('\n');
  }

  if (inboxCount > 0) {
    lines.push(`> [!inbox] **Skrzynka** — ${inboxLabel} od zespołu · [[Skrzynka|otwórz →]]`);
    for (const item of topInbox) lines.push('> ' + renderDashboardLine(item));
    const rest = inboxCount - topInbox.length;
    if (rest > 0) lines.push(`> - _...i ${rest} ${rest === 1 ? 'starsza' : 'starszych'} → [[Skrzynka]]_`);
  } else {
    lines.push('> [!inbox-ok] Skrzynka pusta. · [[Skrzynka|otwórz]]');
  }

  if (delegatedCount > 0) {
    const stalePart = staleDelegatedCount > 0 ? ` (${staleDelegatedCount} stale ⚠️)` : '';
    lines.push('');
    lines.push(`> [!delegated] **Delegowane** — ${delegatedCount} w toku${stalePart}`);
    for (const item of topDelegated) lines.push('> ' + renderDelegatedLine(item));
    const rest = delegatedCount - topDelegated.length;
    if (rest > 0) lines.push(`> - _...i ${rest} ${rest === 1 ? 'starsza' : 'starszych'} → [[Skrzynka|zobacz]]_`);
  }

  return lines.join('\n');
}

async function updateDashboard(todoPath, args) {
  // Dashboard należy do UŻYTKOWNIKA (jego lista zadań), w przeciwieństwie do Skrzynki, którą
  // Puls generuje — dlatego brak pliku pomijamy, a NIE tworzymy go z szablonu. Banner jest
  // dodatkiem: brak markerów od zawsze kończył się warnem, więc brak samego pliku nie może
  // być twardszy. Bez tego ENOENT (inna nazwa pliku w vaultcie, świeży vault bez struktury
  // Team OS) wywracał CAŁY sync — łącznie z zapisaną już Skrzynką — i job failował co minutę.
  let raw;
  try {
    raw = await fs.readFile(todoPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.warn(`[inbox-pull] brak ${todoPath} — pomijam banner (ustaw INBOX_TODO_PATH, jeśli plik ma inną nazwę)`);
    return;
  }
  if (!raw.includes('%% inbox:banner:start %%')) {
    console.warn('[inbox-pull] banner markers missing in dashboard — skipping banner update');
    return;
  }
  const banner = buildBanner(args);
  const updated = replaceBetweenMarkers(raw, '%% inbox:banner:start %%', '%% inbox:banner:end %%', banner);
  await writeIfChanged(todoPath, raw, updated);
}

// ──────── main ────────
// client wstrzykiwany dla testowalności (mock huba); domyślnie realny inbox-client.
// Ścieżki plików zapewnia env-loader; konfigurację huba (INBOX_HUB_URL/INBOX_TOKEN)
// waliduje sam klient (fail-fast z czytelnym błędem).
export async function main({ client = inboxClient, freshIds = new Set() } = {}) {
  await loadEnv();
  const { INBOX_TODO_PATH, INBOX_SKRZYNKA_PATH } = process.env;

  // Hub zwraca: user (tożsamość z tokenu), active (moje otrzymane pending/delivered),
  // threadRows (pełne nitki tych wątków), delegated (moje wysłane task/query != done).
  // Oznaczanie pending → delivered i granica JSON payloadu siedzą po stronie huba.
  const { user: me, active, threadRows, delegated } = await client.pull();

  const topItems = active.slice(0, TOP_N_IN_DASHBOARD);

  // Agregat typów dla bannera (Faza 3 — rozbicie task/query)
  const taskCount = active.filter(r => r.type === 'task').length;
  const queryCount = active.filter(r => r.type === 'query').length;

  const topDelegated = delegated.slice(0, TOP_N_IN_DASHBOARD);

  // Stale count w Delegowanych (Faza 3 — sygnał kogo trzeba pingnąć)
  const STALE_HOURS = 48;
  const staleDelegatedCount = delegated.filter(r => {
    const hours = (Date.now() - new Date(r.created_at).getTime()) / 3600000;
    return hours >= STALE_HOURS;
  }).length;

  // Write to Skrzynka.md (oba bloki) + banner w dashboardzie
  await updateSkrzynkaFile(INBOX_SKRZYNKA_PATH, threadRows, active, delegated, me, freshIds);
  await updateDashboard(INBOX_TODO_PATH, {
    inboxCount: active.length,
    taskCount,
    queryCount,
    topInbox: topItems,
    delegatedCount: delegated.length,
    staleDelegatedCount,
    topDelegated,
  });

  // Hub zachowuje oryginalny status 'pending' w active (detekcja „nowe") mimo że sam
  // oznaczył je delivered — liczymy „new" z tego pola dla logu.
  const newCount = active.filter(r => r.status === 'pending' || freshIds.has(r.id)).length;
  console.log(
    `[inbox-pull] ${new Date().toISOString()} — ` +
    `user=${me} inbox=${active.length} (task=${taskCount} query=${queryCount} new=${newCount}) ` +
    `delegated=${delegated.length} (stale=${staleDelegatedCount})`
  );
}

// Run only when executed directly (not when imported by inbox-sync.mjs)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('[inbox-pull] FATAL:', e.message); process.exit(1); });
}
