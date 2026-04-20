#!/usr/bin/env node
// Team OS — inbox pull job
// - Pełne callouts → Zadania/Inbox.md (rebuild bloku między markerami)
// - Banner + top 3 skondensowane → Zadania/to_do.md (rebuild bloku między markerami)
// - Oznacza pending → delivered w DB
// Odpalane co 1 min przez launchd/cron. Zero Claude CLI.

import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOP_N_IN_DASHBOARD = 3;

// ──────── env loader ────────
async function loadEnv() {
  const envPath = process.env.INBOX_ENV_FILE
    || path.resolve(process.env.HOME, 'Documents/kacper_trzepiecinski_workspace/.env');
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
  const workspace = path.resolve(process.env.HOME, 'Documents/kacper_trzepiecinski_workspace');
  if (!process.env.INBOX_TODO_PATH)      process.env.INBOX_TODO_PATH      = path.join(workspace, 'Zadania/to_do.md');
  if (!process.env.INBOX_INBOX_PATH)     process.env.INBOX_INBOX_PATH     = path.join(workspace, 'Zadania/Inbox.md');
  if (!process.env.INBOX_DELEGATED_PATH) process.env.INBOX_DELEGATED_PATH = path.join(workspace, 'Zadania/Delegowane.md');
}

// ──────── rendering ────────
const TYPE_EMOJI = { task: '📝', reply: '💬', close: '✅' };
const TYPE_LABEL = { task: 'Prośba', reply: 'Odpowiedź', close: 'Zamknięcie' };

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

function renderCallout(row) {
  const emoji = TYPE_EMOJI[row.type] || '📝';
  const label = TYPE_LABEL[row.type] || 'Wiadomość';
  const threadId = row.thread_id || row.id;
  const quoted = (row.content || '').split('\n').map(l => '> > ' + l).join('\n');
  const isFresh = row.status === 'pending';
  const badge = isFresh ? '🆕 ' : '';
  const tag = isFresh ? '[!tip]-' : '[!note]-'; // collapsible, default folded
  return [
    `> ${tag} ${badge}${emoji} @${row.from_user} · ${fmtTime(row.created_at)}`,
    `> **${label}:** ${row.title}`,
    quoted ? '>\n' + quoted : null,
    '>',
    '> - [ ] Zapoznane',
    `> %% thread:${threadId} %%`,
  ].filter(Boolean).join('\n');
}

function renderDashboardLine(row) {
  const emoji = TYPE_EMOJI[row.type] || '📝';
  return `- ${emoji} @${row.from_user} · ${fmtTimeShort(row.created_at)} — **${row.title}**`;
}
function renderDelegatedLine(row) {
  return `- ${delegateIcon(row.created_at)} @${row.to_user} · czeka ${ago(row.created_at)} — **${row.title}**`;
}
function renderDelegatedCallout(row) {
  const icon = delegateIcon(row.created_at);
  const threadId = row.thread_id || row.id;
  const stale = icon === '⚠️';
  const tag = stale ? '[!warning]-' : '[!note]-';
  return [
    `> ${tag} ${icon} @${row.to_user} · czeka ${ago(row.created_at)} · od ${fmtTime(row.created_at)}`,
    `> **${row.title}**`,
    `>`,
    `> %% thread:${threadId} %%`,
  ].join('\n');
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

// ──────── Inbox.md writer ────────
async function updateInboxFile(inboxPath, items) {
  const raw = await fs.readFile(inboxPath, 'utf8');
  const count = items.length;
  const body = items.length ? items.map(renderCallout).join('\n\n') : '';
  let updated = replaceBetweenMarkers(raw, '%% inbox:items:start %%', '%% inbox:items:end %%', body);
  updated = updated.replace(/^\*\d+ now[a-z]+\*$/m, `*${count} ${count === 1 ? 'nowa' : 'nowych'}*`);
  updated = updated.replace(/^_Brak nowych wiadomości\._\s*$/m, items.length ? '' : '_Brak nowych wiadomości._');
  await fs.writeFile(inboxPath, updated, 'utf8');
}

// ──────── Delegowane.md writer ────────
async function updateDelegatedFile(filePath, items) {
  const raw = await fs.readFile(filePath, 'utf8');
  const count = items.length;
  const body = items.length ? items.map(renderDelegatedCallout).join('\n\n') : '';
  let updated = replaceBetweenMarkers(raw, '%% delegated:items:start %%', '%% delegated:items:end %%', body);
  updated = updated.replace(/^\*\d+ w toku\*$/m, `*${count} w toku*`);
  updated = updated.replace(/^_Brak wysłanych delegacji\._\s*$/m, items.length ? '' : '_Brak wysłanych delegacji._');
  await fs.writeFile(filePath, updated, 'utf8');
}

// ──────── to_do.md banner writer ────────
function buildBanner(inboxCount, topInbox, delegatedCount, topDelegated) {
  const lines = [];
  lines.push(`📥 **Inbox:** ${inboxCount} ${inboxCount === 1 ? 'nowa' : 'nowych'} · [[Inbox|otwórz]]   📤 **Delegowane:** ${delegatedCount} w toku`);

  if (topInbox.length > 0) {
    lines.push('');
    for (const item of topInbox) lines.push(renderDashboardLine(item));
    const rest = inboxCount - topInbox.length;
    if (rest > 0) {
      lines.push('');
      lines.push(`_...i ${rest} ${rest === 1 ? 'starsza' : 'starszych'} → [[Inbox]]_`);
    }
  }

  if (topDelegated.length > 0) {
    lines.push('');
    lines.push('**📤 Wysłane — czekają na odpowiedź:**');
    lines.push('');
    for (const item of topDelegated) lines.push(renderDelegatedLine(item));
    const rest = delegatedCount - topDelegated.length;
    if (rest > 0) {
      lines.push('');
      lines.push(`_...i ${rest} ${rest === 1 ? 'starsza' : 'starszych'} → [[Delegowane|zobacz]]_`);
    }
  }

  return lines.join('\n');
}

async function updateDashboard(todoPath, inboxCount, topInbox, delegatedCount, topDelegated) {
  const raw = await fs.readFile(todoPath, 'utf8');
  const banner = buildBanner(inboxCount, topInbox, delegatedCount, topDelegated);
  const updated = replaceBetweenMarkers(raw, '%% inbox:banner:start %%', '%% inbox:banner:end %%', banner);
  await fs.writeFile(todoPath, updated, 'utf8');
}

// ──────── main ────────
async function main() {
  await loadEnv();
  const { INBOX_DB_URL, INBOX_USER, INBOX_TODO_PATH, INBOX_INBOX_PATH, INBOX_DELEGATED_PATH } = process.env;
  if (!INBOX_DB_URL || !INBOX_USER) {
    console.error('Missing INBOX_DB_URL or INBOX_USER');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: INBOX_DB_URL });
  await client.connect();
  try {
    // Wszystkie aktywne (nieprzeczytane + dostarczone) dla mnie — idą do Inbox.md
    const activeRes = await client.query(
      `SELECT id, thread_id, from_user, type, title, content, status, created_at
       FROM inbox
       WHERE to_user = $1 AND status IN ('pending', 'delivered')
       ORDER BY created_at DESC`,
      [INBOX_USER]
    );
    const active = activeRes.rows;
    const topItems = active.slice(0, TOP_N_IN_DASHBOARD);

    // Moje delegowane w toku (wysłane przeze mnie, jeszcze nieobsłużone)
    const delegRes = await client.query(
      `SELECT id, thread_id, to_user, title, created_at, status
       FROM inbox
       WHERE from_user = $1 AND type = 'task' AND status IN ('pending', 'delivered', 'read')
       ORDER BY created_at ASC`,
      [INBOX_USER]
    );
    const delegated = delegRes.rows;
    const topDelegated = delegated.slice(0, TOP_N_IN_DASHBOARD);

    // Write to Inbox.md + Delegowane.md + to_do.md banner
    await updateInboxFile(INBOX_INBOX_PATH, active);
    await updateDelegatedFile(INBOX_DELEGATED_PATH, delegated);
    await updateDashboard(INBOX_TODO_PATH, active.length, topItems, delegated.length, topDelegated);

    // Mark pending → delivered
    const pendingIds = active.filter(r => r.status === 'pending').map(r => r.id);
    if (pendingIds.length > 0) {
      await client.query(`UPDATE inbox SET status='delivered' WHERE id = ANY($1::uuid[])`, [pendingIds]);
    }

    console.log(
      `[inbox-pull] ${new Date().toISOString()} — ` +
      `user=${INBOX_USER} inbox=${active.length} (new=${pendingIds.length}) delegated=${delegated.length}`
    );
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error('[inbox-pull] FATAL:', e.message); process.exit(1); });
