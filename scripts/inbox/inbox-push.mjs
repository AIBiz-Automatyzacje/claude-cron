#!/usr/bin/env node
// Team OS — inbox push job
// - Parsuje Skrzynka.md, znajduje odhaczone checkboxy w sekcji 📥 Otrzymane
// - task z [x] Zrobione → INSERT reply 'Zrobione' + UPDATE task status='done'
// - query/reply z [x] Zapoznane → UPDATE wiadomości status='done'
// - Append do Zasoby/inbox-archive/YYYY-MM.md
// - Idempotentny (sprawdza status='done' w DB przed akcją, pomija)
// Odpalane co 1 min przez claude-cron. Zero Claude CLI.

import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  if (!process.env.INBOX_SKRZYNKA_PATH) process.env.INBOX_SKRZYNKA_PATH = path.join(workspace, 'Zadania/Skrzynka.md');
  if (!process.env.INBOX_ARCHIVE_DIR)   process.env.INBOX_ARCHIVE_DIR   = path.join(workspace, 'Zasoby/inbox-archive');
}

// ──────── parser ────────
// Wyciąga z Skrzynki tylko sekcję 📥 Otrzymane (między markerami).
// Rozdziela ją na bloki callout (każdy zaczyna od `> [!`), dla każdego sprawdza czy ma odhaczony checkbox.
function extractInboxSection(content) {
  const startMarker = '%% inbox:items:start %%';
  const endMarker = '%% inbox:items:end %%';
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return '';
  return content.slice(startIdx + startMarker.length, endIdx);
}

function parseCheckedCallouts(section) {
  // Każdy callout to blok kolejnych linii zaczynających się od `> `
  const lines = section.split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith('> ')) {
      current.push(line);
    } else {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length) blocks.push(current.join('\n'));

  const results = [];
  for (const block of blocks) {
    const idMatch = block.match(/%%\s*id:([a-f0-9-]{36})\s+thread:([a-f0-9-]{36})\s*%%/);
    if (!idMatch) continue;
    const checkedMatch = block.match(/^> - \[x\] (Zrobione|Zapoznane)/m);
    if (!checkedMatch) continue;
    results.push({
      id: idMatch[1],
      thread_id: idMatch[2],
      action: checkedMatch[1], // 'Zrobione' lub 'Zapoznane'
    });
  }
  return results;
}

// ──────── archive ────────
function archivePath(archiveDir) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return path.join(archiveDir, `${ym}.md`);
}

const TYPE_EMOJI = { task: '📝', query: '❓', reply: '💬', close: '✅' };
const TYPE_LABEL = { task: 'Zadanie', query: 'Pytanie', reply: 'Odpowiedź', close: 'Zamknięcie' };

function fmtTime(iso) {
  return new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderArchiveBlock(row, closedBy) {
  const emoji = TYPE_EMOJI[row.type] || '📨';
  const label = TYPE_LABEL[row.type] || 'Wiadomość';
  const quoted = (row.content || '').split('\n').map(l => '> > ' + l).join('\n');
  return [
    `> [!note]- ${emoji} @${row.from_user} → @${row.to_user} · ${fmtTime(row.created_at)}`,
    `> **${label}:** ${row.title}`,
    quoted ? '>\n' + quoted : null,
    '>',
    `> _archived ${fmtTime(new Date().toISOString())} by @${closedBy}_`,
  ].filter(Boolean).join('\n');
}

async function appendToArchive(archiveDir, row, closedBy) {
  await fs.mkdir(archiveDir, { recursive: true });
  const file = archivePath(archiveDir);
  let header = '';
  try {
    await fs.access(file);
  } catch {
    const ym = path.basename(file, '.md');
    header = `---\ntags: [archiwum, team-os]\n---\n\n# 📁 Archiwum Skrzynki — ${ym}\n\n`;
  }
  await fs.appendFile(file, header + renderArchiveBlock(row, closedBy) + '\n\n', 'utf8');
}

// ──────── main ────────
async function main() {
  await loadEnv();
  const { INBOX_DB_URL, INBOX_USER, INBOX_SKRZYNKA_PATH, INBOX_ARCHIVE_DIR } = process.env;
  if (!INBOX_DB_URL || !INBOX_USER) {
    console.error('Missing INBOX_DB_URL or INBOX_USER');
    process.exit(1);
  }

  let raw;
  try {
    raw = await fs.readFile(INBOX_SKRZYNKA_PATH, 'utf8');
  } catch (e) {
    console.error(`[inbox-push] Cannot read ${INBOX_SKRZYNKA_PATH}: ${e.message}`);
    process.exit(1);
  }

  const section = extractInboxSection(raw);
  const checked = parseCheckedCallouts(section);
  if (checked.length === 0) {
    console.log(`[inbox-push] ${new Date().toISOString()} — user=${INBOX_USER} nothing to push`);
    return;
  }

  const client = new pg.Client({ connectionString: INBOX_DB_URL });
  await client.connect();
  let stats = { closed: 0, replied: 0, skipped: 0 };
  try {
    for (const item of checked) {
      // Pobierz rekord — sprawdź czy nadal pending/delivered (idempotency)
      const r = await client.query(
        `SELECT id, thread_id, from_user, to_user, type, title, content, status, created_at
         FROM inbox WHERE id = $1`,
        [item.id]
      );
      if (r.rows.length === 0) {
        stats.skipped++;
        continue;
      }
      const row = r.rows[0];
      // Walidacja: rekord musi być do mnie i nie zamknięty
      if (row.to_user !== INBOX_USER || row.status === 'done') {
        stats.skipped++;
        continue;
      }

      if (row.type === 'task' && item.action === 'Zrobione') {
        // INSERT reply 'Zrobione' do oryginalnego nadawcy + close task
        await client.query(
          `INSERT INTO inbox (thread_id, from_user, to_user, type, title, content)
           VALUES ($1, $2, $3, 'reply', $4, $5)`,
          [row.thread_id, INBOX_USER, row.from_user, `Re: ${row.title}`, 'Zrobione ✅']
        );
        await client.query(`UPDATE inbox SET status='done' WHERE id=$1`, [row.id]);
        await appendToArchive(INBOX_ARCHIVE_DIR, row, INBOX_USER);
        stats.replied++;
      } else if (item.action === 'Zapoznane') {
        // UPDATE status='done' (query/reply/anything)
        await client.query(`UPDATE inbox SET status='done' WHERE id=$1`, [row.id]);
        await appendToArchive(INBOX_ARCHIVE_DIR, row, INBOX_USER);
        stats.closed++;
      } else {
        stats.skipped++;
      }
    }
    console.log(
      `[inbox-push] ${new Date().toISOString()} — user=${INBOX_USER} ` +
      `replied=${stats.replied} closed=${stats.closed} skipped=${stats.skipped}`
    );
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error('[inbox-push] FATAL:', e.message); process.exit(1); });
