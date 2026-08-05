#!/usr/bin/env node
// Team OS — domknięcie wątku po mojej stronie, przez hub.
// Args: --thread-id <uuid>
//
// Mieszka W REPO (nie w vaultcie), bo archiwizuje nitkę TYM SAMYM `appendToArchive`
// co `inbox-push.mjs`. Kopia w vaulcie miała własny loader i własne (brakujące)
// archiwum — wątek domknięty komendą znikał ze Skrzynki bez śladu w archiwum.
//
// Zamykamy wyłącznie wiadomości ZAADRESOWANE DO MNIE — hub odrzuca cudze jako
// `skipped` i słusznie: moje wysłane taski ma domykać odbiorca checkboxem „Zrobione".
// Efekt praktyczny: wątek znika z Otrzymanych, delegacja zostaje w Delegowanych.
//
// Akcja `Zapoznane`, nie `Zrobione` — `Zrobione` na tasku wysyła nadawcy automatyczną
// odpowiedź „Zrobione ✅", a `close` ma tylko sprzątać, nie generować ruchu.

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appendToArchive } from './inbox-push.mjs';
import * as inboxClient from './inbox-client.mjs';
import { loadEnv } from './env-loader.mjs';

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

// client wstrzykiwany dla testowalności (mock huba); archiwum piszemy PRAWDZIWYM
// `appendToArchive` do katalogu z INBOX_ARCHIVE_DIR — szew hub↔plik ma być testowany
// w jednym przebiegu, bo to jego brak przepuścił bug „close kasuje wątek bez archiwum".
export async function main({ client = inboxClient, argv = process.argv } = {}) {
  await loadEnv();
  const args = parseArgs(argv);
  const threadId = args['thread-id'] || args.thread;

  if (!threadId) {
    throw new Error('Usage: close.mjs --thread-id <uuid>');
  }

  const { user, threadRows = [] } = await client.pull();
  const mine = threadRows.filter(
    (r) => r.thread_id === threadId && r.to_user === user && r.status !== 'done'
  );

  if (mine.length === 0) {
    // Powtórzone `close` (albo wątek cudzy) trafia tutaj — zero żądań `done`, zero
    // zapisu do archiwum. Tak wygląda idempotencja tej komendy.
    const out = {
      thread_id: threadId,
      closed: 0,
      archived: false,
      note: 'Brak otwartych wiadomości do mnie w tym wątku (mogą już być domknięte albo należeć do drugiej strony).',
    };
    console.log(JSON.stringify(out));
    return out;
  }

  // Sekwencyjnie, nie równolegle: hub ma rate limit per token, a wątki są krótkie.
  let closed = 0;
  let thread = null;
  for (const row of mine) {
    const res = await client.done({ id: row.id, action: 'Zapoznane' });
    if (res.result === 'closed' || res.result === 'already_done') closed++;
    // Hub dokłada pełną nitkę do odpowiedzi — bierzemy ostatnią (najpełniejszą).
    if (res.thread) thread = res.thread;
  }

  // Archiwum RAZ na wątek, nie raz na wiadomość: `renderArchiveThread` renderuje CAŁĄ
  // nitkę, więc zapis per rekord dołożyłby tę samą treść tyle razy, ile mam wiadomości.
  let archived = false;
  if (thread) {
    await appendToArchive(process.env.INBOX_ARCHIVE_DIR, thread, user);
    archived = true;
  }

  const out = { thread_id: threadId, closed, archived };
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
  // Pad zapisu archiwum kończy proces kodem 1 z komunikatem — porażka ma być WIDOCZNA,
  // nie ciche `exit 0` (wątek zniknąłby ze Skrzynki bez kopii w archiwum).
  main().catch((e) => { console.error('[deleguj:close] FATAL:', e.message); process.exit(1); });
}
