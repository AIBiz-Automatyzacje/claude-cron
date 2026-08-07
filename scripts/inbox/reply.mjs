#!/usr/bin/env node
// Team OS — odpowiedź na wiadomość w wątku, przez hub.
// Args: --thread-id <uuid> --content "..." [--title "..."] [--to <nick>]
//
// Mieszka W REPO (nie w vaultcie) — ten sam powód co close.mjs/send.mjs: kopie w vaultcie
// nie są objęte `npm test` i cicho rozjeżdżają się z repo. Skill `deleguj` woła:
// node "$PULS_HOME/scripts/inbox/reply.mjs".
//
// Adresata wyprowadzamy z wątku: to oryginalny nadawca task/query (a gdy sam go
// wysłałem — jego odbiorca). Wątek bierzemy z `pull`, bo hub nie wystawia odczytu
// pojedynczego wątku, a `pull` zwraca pełne nitki wszystkiego, co mnie dotyczy.
// ⓘ `pull` oznacza przy okazji pending→delivered — to samo robi sync co minutę,
// więc nie zmienia to obserwowalnego stanu, tylko przyspiesza o kilkadziesiąt sekund.
// `--to` jest awaryjnym obejściem dla wątków domkniętych (już nie ma ich w `pull`).

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as inboxClient from './inbox-client.mjs';
import { loadEnv } from './skill-env.mjs';

export function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

// Najstarszy task/query wątku — z nitek przychodzących albo z moich delegacji.
// Widok `delegated` huba ukrywa query z cudzą odpowiedzią, więc dla takich wątków
// jedyną drogą pozostaje jawne `--to` (udokumentowany dług widok↔status).
export function findOriginal({ threadRows = [], delegated = [] }, threadId) {
  const fromThreads = threadRows.find(
    (r) => r.thread_id === threadId && (r.type === 'task' || r.type === 'query')
  );
  if (fromThreads) return fromThreads;
  return delegated.find((r) => r.thread_id === threadId) ?? null;
}

// client wstrzykiwany dla testowalności (mock huba) — wzorzec close.mjs.
export async function main({ client = inboxClient, argv = process.argv } = {}) {
  await loadEnv();
  const args = parseArgs(argv);
  const threadId = args['thread-id'] || args.thread;
  const { content, title, to } = args;

  if (!threadId || !content) {
    throw new Error('Usage: reply.mjs --thread-id <uuid> --content "..." [--title "..."] [--to <nick>]');
  }

  const pulled = await client.pull();
  const original = findOriginal(pulled, threadId);

  if (!original && !to) {
    throw new Error(
      `Nie znalazłem otwartego wątku thread_id=${threadId} wśród moich wiadomości. ` +
        'Jeśli wątek jest już domknięty, podaj adresata jawnie: --to <nick>.'
    );
  }

  // Odpowiadam nadawcy; gdy wątek założyłem sam — jego odbiorcy.
  const toUser = to ?? (original.from_user === pulled.user ? original.to_user : original.from_user);
  const replyTitle = title || (original ? `Re: ${original.title}` : 'Re: (wątek)');

  const { message } = await client.send({
    thread_id: threadId,
    to_user: toUser,
    type: 'reply',
    title: replyTitle,
    content,
  });

  const out = {
    id: message.id,
    thread_id: message.thread_id,
    created_at: message.created_at,
    to_user: message.to_user,
    title: message.title,
    type: message.type,
  };
  console.log(JSON.stringify(out));
  return out;
}

// Entry-point guard przez realpath po OBU stronach — macOS symlinkuje /var i /tmp
// do /private/*, więc gołe porównanie ścieżek cicho blokuje main().
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (isDirectRun()) {
  main().catch(e => { console.error('[deleguj:reply] FATAL:', e.message); process.exit(1); });
}
