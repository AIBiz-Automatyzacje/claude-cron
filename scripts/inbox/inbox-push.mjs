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
import { pathToFileURL } from 'node:url';
import { loadEnv } from './env-loader.mjs';

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

// Archiwizuje CAŁĄ nitkę wątku w jednym callout (nie pojedynczą wiadomość) —
// zamknięty wątek ma być czytelny bez sięgania do bazy.
function renderArchiveThread(thread, closedBy) {
  const root = thread[0];
  const emoji = TYPE_EMOJI[root.type] || '📨';
  const label = TYPE_LABEL[root.type] || 'Wiadomość';
  const messages = thread.map(m => {
    const body = (m.content || '').split('\n');
    const head = `> - **@${m.from_user}** · ${fmtTime(m.created_at)} — ${body[0] || ''}`;
    const cont = body.slice(1).map(l => `>   ${l}`);
    return [head, ...cont].join('\n');
  }).join('\n');
  return [
    `> [!note]- ${emoji} @${root.from_user} → @${root.to_user} · ${fmtTime(root.created_at)}`,
    `> **${label}:** ${root.title}`,
    '>',
    messages,
    '>',
    `> _archived ${fmtTime(new Date().toISOString())} by @${closedBy}_`,
  ].join('\n');
}

async function fetchThread(client, row) {
  if (!row.thread_id) return [row];
  const res = await client.query(
    `SELECT id, thread_id, from_user, to_user, type, title, content, status, created_at
     FROM inbox WHERE thread_id = $1 ORDER BY created_at ASC`,
    [row.thread_id]
  );
  return res.rows.length ? res.rows : [row];
}

async function appendToArchive(archiveDir, thread, closedBy) {
  await fs.mkdir(archiveDir, { recursive: true });
  const file = archivePath(archiveDir);
  let header = '';
  try {
    await fs.access(file);
  } catch {
    const ym = path.basename(file, '.md');
    header = `---\ntags: [archiwum, team-os]\n---\n\n# 📁 Archiwum Skrzynki — ${ym}\n\n`;
  }
  await fs.appendFile(file, header + renderArchiveThread(thread, closedBy) + '\n\n', 'utf8');
}

// ──────── main ────────
export async function main() {
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
        // INSERT reply 'Zrobione' + close task w JEDNEJ transakcji — crash między nimi
        // zostawiał status!=done i idempotency wstawiała duplikat reply przy następnym runie
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO inbox (thread_id, from_user, to_user, type, title, content)
             VALUES ($1, $2, $3, 'reply', $4, $5)`,
            [row.thread_id, INBOX_USER, row.from_user, `Re: ${row.title}`, 'Zrobione ✅']
          );
          await client.query(`UPDATE inbox SET status='done' WHERE id=$1`, [row.id]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        await appendToArchive(INBOX_ARCHIVE_DIR, await fetchThread(client, row), INBOX_USER);
        stats.replied++;
      } else if (item.action === 'Zapoznane') {
        // UPDATE status='done' (query/reply/anything)
        await client.query(`UPDATE inbox SET status='done' WHERE id=$1`, [row.id]);
        await appendToArchive(INBOX_ARCHIVE_DIR, await fetchThread(client, row), INBOX_USER);
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

// Run only when executed directly (not when imported by inbox-sync.mjs)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('[inbox-push] FATAL:', e.message); process.exit(1); });
}
