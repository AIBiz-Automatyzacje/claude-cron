#!/usr/bin/env node
// Team OS — domknięcie wątku po mojej stronie, przez hub.
// Args: --thread-id <uuid>
//
// Mieszka W REPO (nie w vaultcie), bo archiwizuje nitkę TYM SAMYM `appendToArchive`
// co `inbox-push.mjs`. Kopia w vaulcie miała własny loader i własne (brakujące)
// archiwum — wątek domknięty komendą znikał ze Skrzynki bez śladu w archiwum.
//
// Zamykamy wyłącznie wiadomości ZAADRESOWANE DO MNIE — hub odrzuca cudze jako
// `skipped` i słusznie: moje wysłane taski ma domykać odbiorca.
//
// Akcja zależy od TYPU wiadomości i to nie jest kosmetyka:
//   - `task` → `Zrobione`. `Zapoznane` robi w hubie gołe `UPDATE status='done'` bez
//     żadnej odpowiedzi, a widok „Delegowane" nadawcy filtruje `status != 'done'` —
//     zdelegowane zadanie znikałoby delegującemu z listy BEZ jednej wiadomości zwrotnej
//     (cicha utrata sygnału). `Zrobione` dokłada nadawcy reply „Zrobione ✅".
//   - `query`/`reply` → `Zapoznane`. Nikt nie czeka na potwierdzenie wykonania, więc
//     dodatkowy ruch w skrzynce drugiej strony byłby szumem.

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseArgs } from './args.mjs';
import { appendToArchive } from './inbox-push.mjs';
import * as inboxClient from './inbox-client.mjs';
import { loadEnv } from './env-loader.mjs';

// `close` potrzebuje wyłącznie katalogu archiwum i credów huba, ale katalog archiwum
// wyprowadzamy z workspace'u — a ten bywa NIEUSTAWIONY w procesie, który dostał tylko
// PULS_HOME (sesja nie-loginowa, Windows przed relogiem, spawn z innego procesu).
// Generyczny komunikat loadera namawia wtedy na wpisanie ścieżek do `.env` w vaultcie,
// czyli dokładnie tam, gdzie sekretów trzymać nie wolno. Własny komunikat kieruje
// do jedynej poprawnej naprawy: re-run instalatora + NOWA sesja.
export const MISSING_WORKSPACE_MESSAGE =
  'Brak CLAUDE_CRON_WORKSPACE — nie wiem, gdzie leży vault (a w nim Zasoby/inbox-archive). '
  + 'Uruchom ponownie instalator Pulsa (ustawia tę zmienną razem z PULS_HOME) i otwórz NOWĄ '
  + 'sesję: zmienne środowiskowe nie propagują się do już działających procesów.';

async function loadInboxEnv() {
  try {
    await loadEnv();
  } catch (error) {
    if (!process.env.CLAUDE_CRON_WORKSPACE) throw new Error(MISSING_WORKSPACE_MESSAGE);
    throw error;
  }
}

export { parseArgs };

// client wstrzykiwany dla testowalności (mock huba); archiwum piszemy PRAWDZIWYM
// `appendToArchive` do katalogu z INBOX_ARCHIVE_DIR — szew hub↔plik ma być testowany
// w jednym przebiegu, bo to jego brak przepuścił bug „close kasuje wątek bez archiwum".
export async function main({ client = inboxClient, argv = process.argv } = {}) {
  await loadInboxEnv();
  const args = parseArgs(argv);
  const threadId = args['thread-id'] || args.thread;

  if (!threadId) {
    throw new Error('Usage: close.mjs --thread-id <uuid>');
  }

  const { user, threadRows = [] } = await client.pull();
  const thread = threadRows.filter((r) => r.thread_id === threadId);
  const mine = thread.filter((r) => r.to_user === user && r.status !== 'done');

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

  // Archiwum PRZED domknięciem w hubie i ze SNAPSHOTU z `pull()` — kolejność jest tu
  // odwracalnością, nie stylem. Zapis po pętli czynił pad dysku (Obsidian Sync, brak
  // miejsca, read-only) NIEODWRACALNYM: wiadomości były już `done`, więc ponowne `close`
  // szło ścieżką „brak otwartych wiadomości" i nitki nie dało się zarchiwizować niczym
  // poza ręczną grzebaniną w bazie huba. Tak najgorszy przypadek to zbędny wpis
  // w archiwum (przy padzie w połowie pętli), a nie zniknięty wątek bez kopii.
  // Archiwum RAZ na wątek, nie raz na wiadomość: `renderArchiveThread` renderuje CAŁĄ
  // nitkę, więc zapis per rekord dołożyłby tę samą treść tyle razy, ile mam wiadomości.
  await appendToArchive(process.env.INBOX_ARCHIVE_DIR, thread, user);

  // Sekwencyjnie, nie równolegle: hub ma rate limit per token, a wątki są krótkie.
  let closed = 0;
  for (const row of mine) {
    const action = row.type === 'task' ? 'Zrobione' : 'Zapoznane';
    const res = await client.done({ id: row.id, action });
    // Hub zwraca RÓŻNE wyniki dla domknięcia: 'replied' (task + Zrobione — dokłada
    // automatyczne „Zrobione ✅" do nadawcy), 'closed' (Zapoznane) i 'already_done'
    // (rekord już domknięty). Wszystkie trzy znaczą „ta wiadomość jest zamknięta" —
    // liczenie samego 'closed' raportowało `closed: 0` przy poprawnie zamkniętych
    // ZADANIACH, a atrapy zwracające 'closed' na każdą akcję trzymały testy na zielono.
    if (res.result === 'closed' || res.result === 'replied' || res.result === 'already_done') closed++;
  }

  const out = { thread_id: threadId, closed, archived: true };
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
