#!/usr/bin/env node
// Team OS — inbox push job
// - Parsuje Skrzynka.md, znajduje odhaczone checkboxy w sekcji 📥 Otrzymane
// - Każdy odhaczony callout → `client.done({id, action})`; hub robi transakcję
//   reply+done (task/Zrobione), UPDATE done (Zapoznane) i idempotencję (already_done).
// - Append do Zasoby/inbox-archive/YYYY-MM.md z nitki zwróconej przez hub.
// Odpalane co 1 min przez claude-cron. Zero Claude CLI.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as inboxClient from './inbox-client.mjs';
import { loadEnv } from './env-loader.mjs';

// ──────── parser ────────
// Wyciąga z Skrzynki tylko sekcję 📥 Otrzymane (między markerami).
// Rozdziela ją na bloki callout (każdy zaczyna od `> [!`), dla każdego sprawdza czy ma odhaczony checkbox.
export function extractInboxSection(content) {
  const startMarker = '%% inbox:items:start %%';
  const endMarker = '%% inbox:items:end %%';
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return '';
  return content.slice(startIdx + startMarker.length, endIdx);
}

export function parseCheckedCallouts(section) {
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
export function archivePath(archiveDir) {
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
export function renderArchiveThread(thread, closedBy) {
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

// Stopka archiwum „archived by @X" = odbiorca zamykanej wiadomości (kotwica ma to_user=me).
// Wyprowadzamy ją z nitki zwróconej przez hub — zero osobnego żądania o tożsamość.
function resolveClosedBy(thread, anchorId) {
  const anchor = thread.find((m) => m.id === anchorId);
  return anchor ? anchor.to_user : null;
}

// ──────── main ────────
// client wstrzykiwany dla testowalności (mock huba); domyślnie realny inbox-client.
// Idempotencja (already_done → zero skutków), transakcja reply+done i granica JSON
// siedzą po stronie huba — klient robi głupie, bezpiecznie retryowalne żądania.
export async function main({ client = inboxClient } = {}) {
  await loadEnv();
  const { INBOX_SKRZYNKA_PATH, INBOX_ARCHIVE_DIR } = process.env;

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
    console.log(`[inbox-push] ${new Date().toISOString()} — nothing to push`);
    return;
  }

  const stats = { closed: 0, replied: 0, skipped: 0 };
  for (const item of checked) {
    // Hub zwraca {result, thread?}: replied (task+Zrobione), closed (Zapoznane),
    // already_done/skipped/not_found (bez thread → brak archiwizacji, brak duplikatu).
    const res = await client.done({ id: item.id, action: item.action });

    if ((res.result === 'replied' || res.result === 'closed') && res.thread) {
      await appendToArchive(INBOX_ARCHIVE_DIR, res.thread, resolveClosedBy(res.thread, item.id));
      if (res.result === 'replied') stats.replied++;
      else stats.closed++;
    } else {
      stats.skipped++;
    }
  }

  console.log(
    `[inbox-push] ${new Date().toISOString()} — ` +
    `replied=${stats.replied} closed=${stats.closed} skipped=${stats.skipped}`
  );
}

// Run only when executed directly (not when imported by inbox-sync.mjs)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('[inbox-push] FATAL:', e.message); process.exit(1); });
}
