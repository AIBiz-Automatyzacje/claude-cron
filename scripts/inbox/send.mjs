#!/usr/bin/env node
// Team OS — wysłanie taska/query do skrzynki zespołowej przez hub.
// Args: --to <nick> --title "..." [--content "..." | --content-file <ścieżka>] --type task|query [--thread <uuid>]
//
// Mieszka W REPO (nie w vaultcie) — ten sam powód co close.mjs: kopia w vaultcie nie jest
// objęta `npm test` i cicho rozjeżdża się z repo (kopia inbox-client sprzed PR #5 nie miała
// redakcji tokenu w błędach). Skill `deleguj` woła: node "$PULS_HOME/scripts/inbox/send.mjs".
//
// Hub wyprowadza `from_user` z tokenu, generuje id i ustawia thread_id (self-reference
// dla pierwszej wiadomości wątku) — skill nie robi nic z tożsamością ani z bazą.

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseArgs } from './args.mjs';
import * as inboxClient from './inbox-client.mjs';
import { readContent } from './content-arg.mjs';
import { loadEnv } from './skill-env.mjs';

const TYPES = ['task', 'query', 'reply', 'close'];

export { parseArgs };

// client wstrzykiwany dla testowalności (mock huba) — wzorzec close.mjs.
export async function main({ client = inboxClient, argv = process.argv } = {}) {
  await loadEnv();
  const args = parseArgs(argv);
  const { to, title, type, thread } = args;
  const content = readContent(args);

  if (!to || !title) {
    throw new Error('Usage: send.mjs --to <nick> --title "..." [--content "..." | --content-file <ścieżka>] --type task|query [--thread <uuid>]');
  }
  // Brak cichego defaultu: nowa wiadomość MUSI mieć jawny --type (task vs query → inny
  // render u odbiorcy i inna ścieżka domknięcia).
  if (!type) {
    throw new Error('Missing --type: podaj jawnie --type task lub --type query (bez defaultu, by query nie stał się taskiem)');
  }
  if (!TYPES.includes(type)) {
    throw new Error(`Invalid --type: ${type}`);
  }

  const { message } = await client.send({
    to_user: to,
    type,
    title,
    content: content ?? null,
    thread_id: thread ?? null,
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
  main().catch(e => { console.error('[deleguj:send] FATAL:', e.message); process.exit(1); });
}
