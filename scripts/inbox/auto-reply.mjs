#!/usr/bin/env node
// Team OS — asystent auto-reply (MVP autonomii, poziom 1).
// Agent odpowiada na otrzymane query z wiedzy vaulta ZANIM zrobi to człowiek
// (agent-first, decyzja 23.07). Nie zna odpowiedzi → NO_ANSWER → query zostaje
// człowiekowi. Tylko query, tylko odczyt vaulta (Read/Glob/Grep), zero akcji
// zewnętrznych. Jeden kandydat per run (job co 1 min) — backlog drenuje się
// 1/min, a pojedynczy spawn mieści się w timeoutcie joba.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { loadEnv } from './env-loader.mjs';

const require = createRequire(import.meta.url);
// Reuse spawn-a z core'a: Windows-safe resolve binarki (bez shell:true — command
// injection) + czysty env z tokenem OAuth. cwd ustawiamy sami (vault, nie repo).
const { resolveClaudeBin, buildCleanEnv } = require('../../lib/claude-spawn');

const NO_ANSWER = 'NO_ANSWER';
const TAG = '🤖 auto-odpowiedź asystenta';
const SPAWN_TIMEOUT_MS = 4 * 60 * 1000; // < timeout joba (5 min) — run umiera czysto, nie z ręki daemona
const HISTORY_EXCERPT_LEN = 160;

// ──────── pure helpers (testowane w auto-reply.test.mjs) ────────

export function buildPrompt({ fromUser, toUser, title, content }) {
  return [
    `Jesteś asystentem użytkownika "${toUser}" w systemie Team OS. Użytkownik "${fromUser}" zadał pytanie:`,
    '',
    `Tytuł: ${title}`,
    content ? `Treść: ${content}` : null,
    '',
    'Poszukaj odpowiedzi w tym vaultcie (Read/Glob/Grep). Odpowiadaj WYŁĄCZNIE na podstawie treści plików.',
    'ZIGNORUJ pliki `Zadania/Skrzynka.md` i `Zasoby/inbox-archive/` — to skrzynka wiadomości, w której leży samo to pytanie, a nie wiedza.',
    `Jeśli nie znajdziesz jednoznacznej odpowiedzi — Twoja CAŁA odpowiedź to dokładnie jedno słowo: ${NO_ANSWER}. Bez wyjaśnień, bez żadnego innego tekstu.`,
    'Jeśli znajdziesz: odpowiedz zwięźle po polsku (kilka zdań, bez nagłówków) i podaj nazwę pliku, z którego wiesz.',
  ].filter((l) => l !== null).join('\n');
}

// null = agent nie zna odpowiedzi (albo pusto) → query zostaje człowiekowi.
// NO_ANSWER łapiemy GDZIEKOLWIEK w tekście — model potrafi owinąć je prozą
// („...no note exists. NO_ANSWER"), a wysłanie takiego reply zamyka query u nadawcy
// błędną odpowiedzią (złapane na teście negatywnym CAVE 23.07).
export function parseAnswer(stdout) {
  const text = (stdout || '').trim();
  if (!text || text.includes(NO_ANSWER)) return null;
  return text;
}

export function formatReplyContent(answer) {
  return `${TAG}:\n\n${answer}`;
}

export function formatHistoryLine({ date, toUser, title, answer }) {
  const when = date.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (answer === null) return `- ${when} · do @${toUser} · **${title}** — NO_ANSWER, zostaje dla człowieka`;
  const flat = answer.replace(/\s+/g, ' ').trim();
  const excerpt = flat.length > HISTORY_EXCERPT_LEN ? flat.slice(0, HISTORY_EXCERPT_LEN) + '…' : flat;
  return `- ${when} · do @${toUser} · **${title}** — ${excerpt}`;
}

// ──────── side effects ────────

// Historia asystenta (decyzja 23.07: „jakaś historia") — append-only log per miesiąc,
// obok archiwum inboxu. Pełna treść odpowiedzi i tak żyje w threadzie/archiwum.
async function appendHistory(archiveDir, line, date) {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const file = path.join(archiveDir, `auto-replies-${ym}.md`);
  let header = '';
  try {
    await fs.access(file);
  } catch {
    header = `# 🤖 Auto-odpowiedzi asystenta — ${ym}\n\n`;
  }
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.appendFile(file, header + line + '\n', 'utf8');
}

function runClaude({ prompt, model, cwd }) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--model', model, '--allowedTools', 'Read,Glob,Grep'];
    const proc = spawn(resolveClaudeBin(), args, {
      cwd,
      env: buildCleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, SPAWN_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message, stdout, stderr }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, error: `timeout po ${SPAWN_TIMEOUT_MS / 1000}s`, stdout, stderr });
      if (code !== 0) return resolve({ ok: false, error: `exit ${code}: ${stderr.trim().slice(0, 300)}`, stdout, stderr });
      resolve({ ok: true, stdout });
    });
  });
}

export async function main() {
  await loadEnv();
  const { INBOX_DB_URL, INBOX_USER, INBOX_SKRZYNKA_PATH, INBOX_ARCHIVE_DIR } = process.env;
  if (!INBOX_DB_URL || !INBOX_USER) {
    console.error('Missing INBOX_DB_URL or INBOX_USER');
    process.exit(1);
  }
  const model = process.env.INBOX_ASSISTANT_MODEL || 'sonnet';
  // Vault root z wymuszonej przez env-loader ścieżki Skrzynki (<vault>/Zadania/Skrzynka.md)
  const vaultRoot = path.dirname(path.dirname(INBOX_SKRZYNKA_PATH));

  const client = new pg.Client({ connectionString: INBOX_DB_URL });
  await client.connect();
  try {
    // Kandydat: najstarsze otwarte query do mnie, w którym NIKT jeszcze nie odpisał
    // i którego asystent jeszcze nie próbował (marker w payload).
    const candRes = await client.query(
      `SELECT id, COALESCE(thread_id, id) AS thread_id, from_user, title, content
       FROM inbox i
       WHERE to_user = $1
         AND type = 'query'
         AND status IN ('pending','delivered')
         AND COALESCE(payload->>'auto_reply_attempted','') = ''
         AND NOT EXISTS (
           SELECT 1 FROM inbox r
           WHERE r.thread_id = COALESCE(i.thread_id, i.id) AND r.type = 'reply'
         )
       ORDER BY created_at ASC
       LIMIT 1`,
      [INBOX_USER]
    );
    if (candRes.rows.length === 0) {
      console.log(`[auto-reply] ${new Date().toISOString()} — user=${INBOX_USER} no candidates`);
      return;
    }
    const q = candRes.rows[0];

    // Claim PRZED spawnem — atomowy, nakładające się runy nie odpowiedzą podwójnie.
    // Jedna próba na query: marker zostaje też po failu spawna (query i tak wisi u człowieka).
    const claimRes = await client.query(
      `UPDATE inbox
       SET payload = COALESCE(payload,'{}'::jsonb) || jsonb_build_object('auto_reply_attempted', now())
       WHERE id = $1 AND COALESCE(payload->>'auto_reply_attempted','') = ''
       RETURNING id`,
      [q.id]
    );
    if (claimRes.rows.length === 0) {
      console.log(`[auto-reply] ${new Date().toISOString()} — query ${q.id} claimed by another run, skipping`);
      return;
    }

    console.log(`[auto-reply] ${new Date().toISOString()} — user=${INBOX_USER} answering "${q.title}" from @${q.from_user} (model=${model})`);
    const result = await runClaude({ prompt: buildPrompt({ fromUser: q.from_user, toUser: INBOX_USER, title: q.title, content: q.content }), model, cwd: vaultRoot });
    if (!result.ok) {
      console.error(`[auto-reply] FATAL: spawn failed for query ${q.id}: ${result.error}`);
      process.exit(1); // alarm Telegram (routine job) — query zostaje człowiekowi
    }

    const now = new Date();
    const answer = parseAnswer(result.stdout);
    if (answer === null) {
      await appendHistory(INBOX_ARCHIVE_DIR, formatHistoryLine({ date: now, toUser: q.from_user, title: q.title, answer: null }), now);
      console.log(`[auto-reply] ${new Date().toISOString()} — NO_ANSWER for "${q.title}", zostaje dla człowieka`);
      return;
    }

    await client.query(
      `INSERT INTO inbox (thread_id, from_user, to_user, type, title, content, payload)
       VALUES ($1, $2, $3, 'reply', $4, $5, '{"auto_reply": true}'::jsonb)`,
      [q.thread_id, INBOX_USER, q.from_user, `Re: ${q.title}`, formatReplyContent(answer)]
    );
    await appendHistory(INBOX_ARCHIVE_DIR, formatHistoryLine({ date: now, toUser: q.from_user, title: q.title, answer }), now);
    console.log(`[auto-reply] ${new Date().toISOString()} — replied to @${q.from_user} on "${q.title}" (${answer.length} chars)`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[auto-reply] FATAL:', e.message); process.exit(1); });
}
