#!/usr/bin/env node
// Team OS — inbox pull job
// - Pełne callouts → Zadania/Skrzynka.md (dwie sekcje: Otrzymane + Wysłane, rebuild bloków między markerami)
// - Banner + top 3 skondensowane → Zadania/to_do.md (rebuild bloku między markerami)
// - Oznacza pending → delivered w DB
// Odpalane co 1 min przez launchd/cron. Zero Claude CLI.

import pg from 'pg';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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
function avatarSpan(user, { small = false, bot = false } = {}) {
  const slug = bot ? 'bot' : String(user).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const initial = bot ? '🤖' : String(user).charAt(0).toUpperCase();
  return `<span class="os-av${small ? ' s' : ''} u-${slug}">${initial}</span>`;
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

// Renderuje JEDNĄ wiadomość nitki jako li z awatarem: człowiek = inicjał w kolorze osoby,
// agent (payload.auto_reply) = 🤖 + badge AUTO + prefix zdjęty z treści + linia „Źródło:" jako pill.
function renderMessage(m) {
  const auto = isAutoReply(m);
  const raw = auto ? (m.content || '').replace(AUTO_REPLY_PREFIX, '') : (m.content || '');
  const lines = raw.trim().split('\n').map(l => {
    const src = l.match(/^Źródło:\s*(.+)$/);
    return src ? `<span class="os-src">📄 ${src[1]}</span>` : l;
  });
  const who = auto
    ? `<span class="os-who">Asystent @${m.from_user}</span> <span class="os-time">· ${fmtTimeShort(m.created_at)}</span> <span class="os-auto">AUTO</span>`
    : `<span class="os-who">@${m.from_user}</span> <span class="os-time">· ${fmtTimeShort(m.created_at)}</span>`;
  const head = `> - ${avatarSpan(m.from_user, { bot: auto })}${who}<br>${lines[0] || ''}`;
  const cont = lines.slice(1).map(l => `>   ${l}`);
  return [head, ...cont].join('\n');
}

// Renderuje JEDEN callout na cały wątek — nitka chronologicznie w środku.
// thread = posortowane chronologicznie wiadomości jednego thread_id (root = pierwsza).
// anchor = pierwsza aktywna (nie-done) wiadomość DO MNIE — jej id/typ trafiają do markera i checkboxa
//          (kontrakt push-job: SELECT WHERE id, walidacja to_user + typ → akcja).
// me = INBOX_USER — kierunek w metadanych („Ty → @x" vs „od @x").
export function renderThreadCallout(thread, anchor, me) {
  const root = thread[0];
  const threadId = root.thread_id || root.id;
  const name = CALLOUT_NAME[root.type] || 'note';
  const isFresh = thread.some(r => r.status === 'pending');

  const tags = [
    isFresh ? '<span class="os-tag t-new">🆕 nowe</span>' : null,
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

  const messages = thread.map(renderMessage).join('\n');

  return [
    `> [!${name}${isFresh ? '|fresh' : ''}]- ${root.title}`,
    `> ${tags} ${meta}`,
    '>',
    messages,
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
// Wszystkie delegacje w JEDNYM callout — wiersze jak w mockupie (pill czasu, awatar, tytuł),
// marker %% thread %% per wiersz (ukryty w preview, do skopiowania dla /deleguj reply).
export function renderDelegatedCallout(rows) {
  const items = rows.map(row => {
    const icon = delegateIcon(row.created_at);
    const stale = icon === '⚠️';
    const threadId = row.thread_id || row.id;
    return `> - <span class="os-wait${stale ? ' stale' : ''}">${icon} czeka ${ago(row.created_at)}</span> ` +
      `${avatarSpan(row.to_user, { small: true })}<span class="os-who">@${row.to_user}</span> — ` +
      `**${row.title}** <span class="os-since">wysłane ${fmtTime(row.created_at)}</span> %% thread:${threadId} %%`;
  }).join('\n');
  return `> [!delegated]- w toku\n${items}`;
}

// Link do archiwum bieżącego miesiąca — jedyne „drzwi" do zamkniętych wątków w pustym stanie
function archiveLink() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `[[Zasoby/inbox-archive/${ym}|📁 archiwum wątków →]]`;
}

// ──────── generic marker replace ────────
function replaceBetweenMarkers(source, startMarker, endMarker, newContent) {
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(`Markers not found: ${startMarker} / ${endMarker}`);
  }
  const before = source.slice(0, startIdx + startMarker.length);
  const after = source.slice(endIdx);
  return before + '\n' + newContent + (newContent && !newContent.endsWith('\n') ? '\n' : '') + after;
}

// Grupuje płaskie wiersze po thread_id w nitki posortowane chronologicznie.
// threadRows = WSZYSTKIE wiadomości aktywnych wątków; activeForMe = moje nie-done (kotwice).
// Kolejność wątków: malejąco wg czasu kotwicy (najświeższe rozmowy na górze).
function buildThreadCallouts(threadRows, activeForMe, me) {
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
    callouts.push({ anchorTime: new Date(anchor.created_at).getTime(), text: renderThreadCallout(thread, anchor, me) });
  }
  callouts.sort((a, b) => b.anchorTime - a.anchorTime);
  return callouts.map(c => c.text);
}

// ──────── Skrzynka.md writer (oba bloki w jednym pliku) ────────
async function updateSkrzynkaFile(filePath, threadRows, activeForMe, delegatedItems, me) {
  const raw = await fs.readFile(filePath, 'utf8');
  const inboxCallouts = buildThreadCallouts(threadRows, activeForMe, me);
  const inboxCount = activeForMe.length;
  const delegatedCount = delegatedItems.length;

  const inboxBody = inboxCallouts.length
    ? inboxCallouts.join('\n\n')
    : `> [!inbox-ok] 🌿 Pusto. Nikt nic od Ciebie nie chce. · ${archiveLink()}`;
  const delegatedBody = delegatedItems.length
    ? renderDelegatedCallout(delegatedItems)
    : '> [!inbox-ok] 🌿 Nic nie wisi na innych.';

  let updated = replaceBetweenMarkers(raw, '%% inbox:items:start %%', '%% inbox:items:end %%', inboxBody);
  updated = replaceBetweenMarkers(updated, '%% delegated:items:start %%', '%% delegated:items:end %%', delegatedBody);
  updated = updated.replace(/^\*\d+ now[a-z]+\*$/m, `*${inboxCount} ${inboxCount === 1 ? 'nowa' : 'nowych'}*`);
  updated = updated.replace(/^\*\d+ w toku\*$/m, `*${delegatedCount} w toku*`);

  await fs.writeFile(filePath, updated, 'utf8');
}

// ──────── to_do.md banner writer ────────
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
    lines.push('> [!inbox-ok] 🌿 Skrzynka pusta, nic nie czeka na innych. · [[Skrzynka|otwórz]]');
    return lines.join('\n');
  }

  if (inboxCount > 0) {
    lines.push(`> [!inbox] 📥 **Skrzynka** — ${inboxLabel} od zespołu · [[Skrzynka|otwórz →]]`);
    for (const item of topInbox) lines.push('> ' + renderDashboardLine(item));
    const rest = inboxCount - topInbox.length;
    if (rest > 0) lines.push(`> - _...i ${rest} ${rest === 1 ? 'starsza' : 'starszych'} → [[Skrzynka]]_`);
  } else {
    lines.push('> [!inbox-ok] 🌿 Skrzynka pusta. · [[Skrzynka|otwórz]]');
  }

  if (delegatedCount > 0) {
    const stalePart = staleDelegatedCount > 0 ? ` (${staleDelegatedCount} stale ⚠️)` : '';
    lines.push('');
    lines.push(`> [!delegated] 📤 **Delegowane** — ${delegatedCount} w toku${stalePart}`);
    for (const item of topDelegated) lines.push('> ' + renderDelegatedLine(item));
    const rest = delegatedCount - topDelegated.length;
    if (rest > 0) lines.push(`> - _...i ${rest} ${rest === 1 ? 'starsza' : 'starszych'} → [[Skrzynka|zobacz]]_`);
  }

  return lines.join('\n');
}

async function updateDashboard(todoPath, args) {
  const raw = await fs.readFile(todoPath, 'utf8');
  if (!raw.includes('%% inbox:banner:start %%')) {
    console.warn('[inbox-pull] banner markers missing in to_do.md — skipping banner update');
    return;
  }
  const banner = buildBanner(args);
  const updated = replaceBetweenMarkers(raw, '%% inbox:banner:start %%', '%% inbox:banner:end %%', banner);
  await fs.writeFile(todoPath, updated, 'utf8');
}

// ──────── main ────────
export async function main() {
  await loadEnv();
  const { INBOX_DB_URL, INBOX_USER, INBOX_TODO_PATH, INBOX_SKRZYNKA_PATH } = process.env;
  if (!INBOX_DB_URL || !INBOX_USER) {
    console.error('Missing INBOX_DB_URL or INBOX_USER');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: INBOX_DB_URL });
  await client.connect();
  try {
    // Auto-close 1: MOJE WYSŁANE query w threadach gdzie ktoś INNY odpisał replym.
    // S-1 (symulacja 22.07): TYLKO query — dla taska odpowiedź bywa dopytaniem
    // („którą wersję?"), a auto-close kasował tracking niewykonanej roboty z Delegowanych
    // i zabierał odbiorcy checkbox „Zrobione" (kotwica przeskakiwała na reply).
    // Task zamyka się WYŁĄCZNIE checkboxem odbiorcy (inbox-push → reply „Zrobione ✅").
    const closeSentRes = await client.query(
      `UPDATE inbox SET status='done'
       WHERE from_user = $1
         AND type = 'query'
         AND status != 'done'
         AND thread_id IN (
           SELECT thread_id FROM inbox
           WHERE type = 'reply' AND from_user != $1
         )
       RETURNING id`,
      [INBOX_USER]
    );

    // F-D (17.06): USUNIĘTO Auto-close 2 (otrzymane task/query → done po moim replym).
    // Powód: odpowiedź ≠ załatwienie. Auto-zamykanie OTRZYMANYCH gubiło otwarte wątki ze
    // Skrzynki, mimo że od tego jest ręczny checkbox [x] Zrobione/Zapoznane (→ inbox-push).
    // Otrzymane znikają teraz WYŁĄCZNIE po ręcznym odhaczeniu. Auto-close zostaje tylko dla
    // WYSŁANYCH (Auto-close 1 wyżej) — tam zniknięcie po odpowiedzi jest pożądane.
    const autoClosedTotal = closeSentRes.rows.length;

    // Moje aktywne wiadomości (Otrzymane = do mnie, nie-done) — kotwice wątków + liczniki
    const activeRes = await client.query(
      `SELECT i.id, i.thread_id, i.from_user, i.type, i.title, i.content, i.status, i.created_at, i.payload
       FROM inbox i
       WHERE i.to_user = $1 AND i.status IN ('pending','delivered')
       ORDER BY i.created_at DESC`,
      [INBOX_USER]
    );
    const active = activeRes.rows;
    const topItems = active.slice(0, TOP_N_IN_DASHBOARD);

    // Pełne nitki tych wątków (też moje wysłane reply) — render grupuje je w jeden callout
    const activeThreadIds = [...new Set(active.map(r => r.thread_id || r.id))];
    let threadRows = active;
    if (activeThreadIds.length > 0) {
      const threadRes = await client.query(
        `SELECT id, thread_id, from_user, to_user, type, title, content, status, created_at, payload
         FROM inbox
         WHERE thread_id = ANY($1::uuid[])
         ORDER BY created_at ASC`,
        [activeThreadIds]
      );
      threadRows = threadRes.rows;
    }

    // Agregat typów dla bannera (Faza 3 — rozbicie task/query)
    const taskCount = active.filter(r => r.type === 'task').length;
    const queryCount = active.filter(r => r.type === 'query').length;

    // Moje delegowane w toku (task + query wysłane przeze mnie, jeszcze nieobsłużone)
    const delegRes = await client.query(
      `SELECT id, thread_id, to_user, title, type, created_at, status
       FROM inbox
       WHERE from_user = $1 AND type IN ('task','query') AND status != 'done'
       ORDER BY created_at ASC`,
      [INBOX_USER]
    );
    const delegated = delegRes.rows;
    const topDelegated = delegated.slice(0, TOP_N_IN_DASHBOARD);

    // Stale count w Delegowanych (Faza 3 — sygnał kogo trzeba pingnąć)
    const STALE_HOURS = 48;
    const staleDelegatedCount = delegated.filter(r => {
      const hours = (Date.now() - new Date(r.created_at).getTime()) / 3600000;
      return hours >= STALE_HOURS;
    }).length;

    // Write to Skrzynka.md (oba bloki) + to_do.md banner
    await updateSkrzynkaFile(INBOX_SKRZYNKA_PATH, threadRows, active, delegated, INBOX_USER);
    await updateDashboard(INBOX_TODO_PATH, {
      inboxCount: active.length,
      taskCount,
      queryCount,
      topInbox: topItems,
      delegatedCount: delegated.length,
      staleDelegatedCount,
      topDelegated,
    });

    // Mark pending → delivered
    const pendingIds = active.filter(r => r.status === 'pending').map(r => r.id);
    if (pendingIds.length > 0) {
      await client.query(`UPDATE inbox SET status='delivered' WHERE id = ANY($1::uuid[])`, [pendingIds]);
    }

    console.log(
      `[inbox-pull] ${new Date().toISOString()} — ` +
      `user=${INBOX_USER} inbox=${active.length} (task=${taskCount} query=${queryCount} new=${pendingIds.length}) ` +
      `delegated=${delegated.length} (stale=${staleDelegatedCount}) auto-closed=${autoClosedTotal} (sent only; recv auto-close usunięty — F-D)`
    );
  } finally {
    await client.end();
  }
}

// Run only when executed directly (not when imported by inbox-sync.mjs)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('[inbox-pull] FATAL:', e.message); process.exit(1); });
}
