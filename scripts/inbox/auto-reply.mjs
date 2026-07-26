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

import * as inboxClient from './inbox-client.mjs';
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

// client wstrzykiwany dla testowalności (mock huba); domyślnie realny inbox-client.
// Atomowy claim jednego query siedzi na hubie (claimQuery: UPDATE...RETURNING) — dwa
// nakładające się runy nie odpowiedzą podwójnie, a brak kandydata = {query:null}.
export async function main({ client = inboxClient } = {}) {
  await loadEnv();
  const { INBOX_SKRZYNKA_PATH, INBOX_ARCHIVE_DIR } = process.env;
  const model = process.env.INBOX_ASSISTANT_MODEL || 'sonnet';
  // Vault root z wymuszonej przez env-loader ścieżki Skrzynki (<vault>/Zadania/Skrzynka.md).
  // UWAGA na inwariant bezpieczeństwa: cwd spawnu to katalog, po którym agent czyta na
  // polecenie OBCEJ osoby (prompt = treść cudzej wiadomości, zero separacji instrukcji od
  // danych). Dlatego sekret skrzynki NIE MOŻE tu leżeć — mieszka poza vaultem
  // (`resolveInboxSecretFile` → `data/inbox.env`); nie przywracaj zapisu do `<vault>/.env`.
  const vaultRoot = path.dirname(path.dirname(INBOX_SKRZYNKA_PATH));

  // Atomowy claim po stronie huba: zwraca zajętą wiadomość albo null (brak kandydata /
  // podjęte przez równoległy run). Marker auto_reply_attempted ustawia hub.
  const { query: q } = await client.claimQuery();
  if (!q) {
    console.log(`[auto-reply] ${new Date().toISOString()} — no candidates`);
    return;
  }

  // Tożsamość odbiorcy pytania (= ja) z zajętej wiadomości — hub claimuje query do mnie.
  const me = q.to_user;
  console.log(`[auto-reply] ${new Date().toISOString()} — user=${me} answering "${q.title}" from @${q.from_user} (model=${model})`);
  const result = await runClaude({ prompt: buildPrompt({ fromUser: q.from_user, toUser: me, title: q.title, content: q.content }), model, cwd: vaultRoot });
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

  await client.send({
    thread_id: q.thread_id,
    to_user: q.from_user,
    type: 'reply',
    title: `Re: ${q.title}`,
    content: formatReplyContent(answer),
    payload: { auto_reply: true },
  });
  await appendHistory(INBOX_ARCHIVE_DIR, formatHistoryLine({ date: now, toUser: q.from_user, title: q.title, answer }), now);
  console.log(`[auto-reply] ${new Date().toISOString()} — replied to @${q.from_user} on "${q.title}" (${answer.length} chars)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[auto-reply] FATAL:', e.message); process.exit(1); });
}
