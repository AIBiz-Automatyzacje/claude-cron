# Review fazy 4 — Retencja, sprzątanie i rewokacja

Zadanie: `zalaczniki-w-skrzynce` · Faza: 4 (IU-9, IU-10) · Data: 2026-09-03

**Severity gate: ⛔ BLOKUJE** — 1 finding P1 (trwale nieusuwalne osierocone bajty po rewokacji).

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi łącznie (po dedupie i verify) | 19 |
| P1 (KOD/TEST/E2E) | 1 |
| P2 (KOD/TEST/E2E) | 8 |
| P3 (KOD/TEST/E2E) | 8 |
| OPERATOR (poza gate'em) | 2 |
| Obalone przez adversarial verify | 0 |
| E2E: PASS / FAIL / SKIP | 0 / 0 / 0 |
| Bookkeeping `Weryfikacja:` — odznaczone | 3 (CLI, exit 0) |

Rozkład po typie: KOD 11, TEST 6, OPERATOR 2.
Rozkład po pliku: `lib/inbox-retention.js` 6, `lib/inbox-retention.test.js` 4, `lib/inbox-db.js` 3, `server.js` 2, `lib/inbox-db.test.js` 1, dokumentacja 1.

---

## Findingi

### 🔴 P1

#### 1. [KOD] `lib/inbox-db.js:849` — rewokacja zostawia trwale nieusuwalne osierocone bajty

Rewokacja zostawia TRWALE nieusuwalne osierocone bajty — dokładnie to, czego zakazuje R13 („bez osieroconych bajtów"). `revokeMember` zbiera kandydatów do skasowania (`shas`, linia 826) WYŁĄCZNIE z `inbox_attachments` członka, a w transakcji kasuje `DELETE FROM inbox_blob_uploads WHERE uploaded_by = ?` (838). Bajty wgrane przez członka, do których nigdy nie powstał wiersz załącznika (PUT wykonany, `send` nie — normalna sytuacja: człowiek przerwał, klient padł, wysyłka odrzucona przez walidację), nie są w `shas`, więc plik zostaje na dysku, a jednocześnie znika jedyny ślad, po którym mogłoby go znaleźć przemiatanie sierot (`computeOrphanedBlobs` czyta wyłącznie `listBlobUploads`).

Scenariusz zweryfikowany na żywej bazie: `recordBlobUpload(SHA,'ala')` + plik 25 MB w magazynie → `revokeMember(ala)` → `listBlobUploads() === []`, `listAttachmentsForRetention() === []`, `sweepInboxRetention({now: +400 dni})` → `{expired:0, deletedBlobs:0, deletedOrphans:0}`, a `hasBlob(SHA) === true`. Efekt: treść odwołanego członka zostaje na hubie na zawsze i nie ma żadnego mechanizmu, który ją sprzątnie (R11 to jedyny taki mechanizm po wycofaniu R12).

**Naprawa:** PRZED transakcją zebrać także hashe z `inbox_blob_uploads WHERE uploaded_by = ?` i dołączyć je do pętli kasowania po commicie (guard `countBlobRefs(sha) > 0` zostaje bez zmian, więc bajty współdzielone z cudzą wiadomością dalej są chronione), albo nie kasować śladów wgrania, dopóki bajty nie znikną.

---

### 🟠 P2

#### 2. [KOD] `lib/inbox-retention.js:114` — przemiatanie bez śladu „już zwolniłem", praca rośnie bez ograniczeń

Przemiatanie nie ma ŻADNEGO śladu „te bajty już zwolniłem", więc praca rośnie bez ograniczeń i powstaje okno kasujące świeże bajty. `listAttachmentsForRetention()` (`lib/inbox-db.js:663`) zwraca KAŻDY wiersz `inbox_attachments` w historii huba — bez WHERE, bez LIMIT, z dwoma skorelowanymi podzapytaniami na wiersz — a metadane z założenia nie znikają NIGDY (trzeci stan renderu).

Skutek 1 (wydajność): wiersz raz uznany za wygasły jest wygasły na zawsze, więc co godzinę, w nieskończoność, `deleteBlobSafely` woła synchroniczny `fs.unlinkSync` dla każdego hasha zwolnionego kiedykolwiek w przeszłości (ENOENT → cicho `false`, więc nawet warn tego nie ujawnia). Po roku pracy huba to pełny skan tabeli plus tysiące jałowych syscalli blokujących event loop TEGO SAMEGO procesu, który równolegle streamuje 25 MB transfery blobów (`writeBlobFromStream`) — czyli dokładnie warunek, przez który powstał drenaż/idle-watchdog z fazy 3.

Skutek 2 (utrata danych): „wygasły" liczone jest wyłącznie z wierszy, więc ponowne wgranie tej samej treści (PUT, dedup R4) do bajtów, których wszystkie stare wiersze wygasły, nie ma żadnej ochrony — przemiatanie w oknie do 60 min między PUT a `send` skasuje je jako wygasłe, a wysłana chwilę później wiadomość dostanie załącznik trwale niedostępny, bez śladu w logu.

**Naprawa:** utrwal moment zwolnienia bajtów (kolumna `bytes_deleted_at` w `inbox_attachments` ustawiana po udanym `deleteBlob`) i wytnij takie wiersze w `WHERE` zapytania retencji; ta sama kolumna jest tańszym źródłem `blob_available` niż `hasBlob` per sha (`lib/inbox-db.js:380`).

#### 3. [KOD] `lib/inbox-retention.js:118` — kasowanie wygasłych pomija ochronę świeżego wgrania (ORPHAN_GRACE_MS)

`computeExpiredAttachments` liczy wyłącznie wiersze `inbox_attachments`, więc gdy WSZYSTKIE wiersze o danym sha256 wygasły, sweep kasuje plik niezależnie od tego, kiedy bajty ostatnio wgrano. Scenariusz: ten sam plik (cotygodniowy raport, logo, szablon) był wysłany 100 dni temu; nadawca wysyła go ponownie — PUT `/blob/<sha>` widzi, że pliku nie ma, zapisuje bajty i `recordBlobUpload`; zanim klient zdąży wywołać `send`, odpala się godzinne przemiatanie, widzi wyłącznie stare wygasłe wiersze i kasuje świeżo wgrane bajty; `validateAttachments` (`lib/inbox-api.js:252`) odrzuca wtedy `send` błędem `unknown_attachment`, a wysyłka pada bez zrozumiałej dla nadawcy przyczyny.

Ta sama luka powoduje, że dla każdego wygasłego hasha `deleteBlob` jest wołany co godzinę już na zawsze (wiersze metadanych nigdy nie znikają), mimo że komentarz przy `blobsToDelete` (linia 68) deklaruje „skasować go wolno dokładnie raz — drugi unlink to już potencjalnie CUDZE bajty o tym hashu, wgrane w międzyczasie na nowo" — czyli kod robi dokładnie to, przed czym ostrzega.

**Naprawa:** pobierz `db.listBlobUploads()` PRZED kasowaniem wygasłych i odfiltruj z `blobsToDelete` hashe, których najświeższe `uploaded_at` mieści się w `ORPHAN_GRACE_MS` od `now` (dane są już dostępne, wystarczy przenieść wywołanie wyżej); dopisz test: wiersz wygasły + wgranie sprzed godziny → blob NIE jest kasowany.

#### 4. [KOD] `lib/inbox-retention.js:118` — wygasły wiersz wraca w `blobsToDelete` przy każdym przemiataniu, bez sprawdzenia ponownego wgrania

Wiersz metadanych po wygaśnięciu żyje wiecznie, więc jego `sha256` wraca w `blobsToDelete` przy KAŻDYM przemiataniu — bez sprawdzenia, czy w międzyczasie ktoś nie wgrał tych bajtów na nowo (`deleteBlob` jest bezwarunkowe; komentarz przy linii 68 sam nazywa to ryzyko „potencjalnie CUDZE bajty o tym hashu", ale kod przed nim nie chroni).

Scenariusz: załącznik z lutego wygasł na twardym progu 90 dni (wiersz zostaje, sha=X). Dziś nadawca wysyła ten sam plik komuś innemu: klient robi PUT (bajty X wracają na dysk), po czym `send`. Jeśli w tym oknie zatyka godzinny tick, sweep widzi, że WSZYSTKIE wiersze o sha X są wygasłe, i kasuje świeżo wgrane bajty; `validateAttachments` (`lib/inbox-api.js:252`) sprawdza `hasBlob` i zwraca 400 `invalid_attachments` na poprawnej wysyłce, a użytkownik dostaje błąd bez żadnej diagnozy w Skrzynce. Okno jest krótkie, ale próba powtarza się co godzinę przez cały czas życia wygasłego wiersza.

**Naprawa:** przekazać `db.listBlobUploads()` do decyzji o blobie i pominąć hash, którego znacznik wgrania jest ŚWIEŻSZY niż najstarszy wygasły wiersz o tym hashu (albo po prostu młodszy niż `ORPHAN_GRACE_MS`).

#### 5. [KOD] `lib/inbox-retention.js:125` — sieroty nie obejmują plików tymczasowych przerwanych transferów

Przemiatanie sierot jest napędzane WYŁĄCZNIE tabelą `inbox_blob_uploads`, więc nie widzi plików tymczasowych przerwanych transferów — a `data/inbox-blobs/tmp/<uuid>.part` sprząta tylko blok `catch` w `writeBlobFromStream` (`lib/inbox-blobs.js:161`), który przy twardym zakończeniu procesu nie biegnie. Scenariusz: nadawca wysyła 25 MB, w połowie transferu daemon dostaje SIGKILL (aktualizacja przyciskiem `/api/update` ubija proces, reboot VPS, OOM) → `.part` zostaje; grep po repo potwierdza zero kodu kasującego `tmp/` gdziekolwiek indziej. Po wycofaniu R12 retencja jest jedynym mechanizmem zwalniającym miejsce, więc te pliki rosną bez sufitu i bez sygnału.

**Naprawa:** w `sweepInboxRetention` dołożyć przemiatanie katalogu `tmp` w magazynie blobów (kasuj `.part` starsze niż `ORPHAN_GRACE_MS`, tą samą karencją co sieroty, przez wstrzykiwane `blobs`), z testem na pliku starszym i młodszym od karencji.

#### 6. [KOD] `lib/inbox-db.js:723` — `recordBlobUpload` z `INSERT OR IGNORE` nie odświeża `created_at`, więc niezmiennik retencji jest fałszywy

`recordBlobUpload` używa `INSERT OR IGNORE`, więc `created_at` pary (sha256, uploaded_by) NIGDY się nie odświeża przy ponownym wgraniu tej samej treści. `listBlobUploads` (linia 684) zwraca `MAX(created_at)`, a `lib/inbox-retention.js` opiera na tym wprost zapisany niezmiennik: „przy wielu wgraniach tej samej treści liczy się NAJŚWIEŻSZE, inaczej retry po dwóch dniach kasowałby świeżo wgrane bajty". Niezmiennik jest fałszywy — zweryfikowane: po wstawieniu śladu z 2026-01-01 i ponownym `recordBlobUpload(sha,'m')` `listBlobUploads()` nadal zwraca `uploaded_at: 2026-01-01`.

Skutek: nadawca, który tę treść wgrał kiedyś (a bajty zniknęły przez retencję albo sprzątanie sierot), po ponownym PUT ma ślad starszy niż `ORPHAN_GRACE_MS`, więc przemiatanie w oknie między PUT a `send` (dwa osobne żądania HTTP, timer bije co godzinę) kasuje właśnie wgrane bajty, a `send` odbija się o `hasBlob` w `validateAttachments` — i każdy retry wpada w tę samą pułapkę.

**Naprawa:** zamień na `INSERT INTO inbox_blob_uploads (...) VALUES (?,?,?) ON CONFLICT(sha256, uploaded_by) DO UPDATE SET created_at = excluded.created_at` i dopisz test, że powtórne `recordBlobUpload` podnosi `uploaded_at` w `listBlobUploads`.

*(sceptyk sugerował P3 — utrzymane P2: skutkiem jest niemożliwa do wykonania wysyłka w pętli retry.)*

#### 7. [TEST] `lib/inbox-retention.test.js:282` — kontrakt SQL `thread_closed_at` pokryty wyłącznie przypadkiem negatywnym

Jedyny test kontraktu SQL nowego zapytania sprawdza wyłącznie przypadek NEGATYWNY (`thread_closed_at === null` dla żywego wątku). Brakuje testu pozytywnego: nitka domknięta w całości (task `Zrobione` + reply `Zapoznane`) → `thread_closed_at` jest niepustym znacznikiem równym najświeższemu `updated_at`. Bez niego odwrócenie gałęzi `CASE`/`EXISTS` w `listAttachmentsForRetention` (`lib/inbox-db.js:663`) przechodzi całą suitą: w jedną stronę cały próg 14-dniowy jest martwy (bajty zwalnia dopiero twarde 90 dni — cichy wzrost zajętości dysku), w drugą `thread_closed_at` wypełnia się dla wątków OTWARTYCH i retencja kasuje bajty żywej korespondencji po 14 dniach od wysłania.

20 testów progowych chodzi na ręcznie budowanych obiektach, a `sweepInboxRetention` jest testowane wyłącznie na atrapach — szew moduł↔SQL nie jest pokryty w ani jednym punkcie (learned pattern: założenie międzymodułowe = test szwu).

**Naprawa:** dopisz test domkniętej nitki (`markDone` obu wiadomości → `thread_closed_at` niepuste) oraz jeden przebieg `sweepInboxRetention` na prawdziwym `inboxDb` z tmpowym magazynem blobów.

#### 8. [TEST] `lib/inbox-retention.test.js:52` — scenariusz „bajty znikają, rekord zostaje" testuje kształt, nie zachowanie

Scenariusz planu „[Unit] Skasowanie bajtów zostawia rekord metadanych nietknięty" jest odhaczony, ale test sprawdza coś innego niż zachowanie: asercja `JSON.stringify([row]) === rowsBefore` dowodzi jedynie, że czysta funkcja progowa nie mutuje tablicy wejściowej — funkcja i tak nie ma dostępu do bazy, więc test przechodzi z definicji (assertion „kształtu", nie zachowania). Nigdzie nie ma testu, że po `sweepInboxRetention` na PRAWDZIWEJ `inbox.db` wiersz w `inbox_attachments` nadal istnieje, a plik bloba zniknął — czyli że render dostanie trzeci stan (R5) zamiast zgubić wiersz.

**Naprawa:** test integracyjny — realna baza (`setInboxDbPath(':memory:')`) + tymczasowy magazyn blobów (`setBlobsDir`), wiadomość z załącznikiem postarzona o >90 dni, `sweepInboxRetention({ now })` → `SELECT COUNT(*) FROM inbox_attachments` = 1 i `fs.existsSync(blobPath(sha))` = false.

*(sceptyk sugerował P3 — utrzymane P2: odhaczony scenariusz planu nie ma pokrycia.)*

#### 9. [TEST] `lib/inbox-retention.js:142` — pozytywna ścieżka przemiatania nietestowalna i nietestowana

`sweepInboxRetention` przyjmuje wstrzykiwane `db`/`blobs`, ale `runSweep` woła ją jako `sweepInboxRetention({ warn })` — bez przekazania zależności — więc każdy test z `isHub: () => true` uderzyłby w prawdziwą `inbox.db` i prawdziwy katalog blobów. W konsekwencji `lib/inbox-retention.test.js` pokrywa wyłącznie gałąź `isHub() === false` (linia 269 testu) i `TypeError`, a nigdy nie sprawdza, że przy hubie przemiatanie faktycznie biegnie, że log powstaje tylko gdy coś skasowano i że wyjątek z bazy jest łapany w catch z linii 152 (zamiast wywalić timer). To jedyna ścieżka w systemie, która NIEODWRACALNIE kasuje cudze dane, i nie ma dla niej ani jednego happy-path testu (coding-rules §2).

**Naprawa:** przepuść opcjonalne `deps` przez `startInboxRetention` → `runSweep` → `sweepInboxRetention` (domyślnie produkcyjne moduły) i dopisz dwa testy: (a) `isHub: () => true` z atrapami db/blobs → skasowane hashe i jedna linia loga, (b) atrapa `listAttachmentsForRetention` rzucająca → `warn` zawiera prefiks `[inbox-retention]`, wyjątek nie wypływa.

*(sceptyk sugerował P3 — utrzymane P2: brak happy-path dla jedynej nieodwracalnie kasującej ścieżki.)*

---

### 🟡 P3

#### 10. [KOD] `server.js:1222` — `listMembers()` liczone eagernie przed guardem `isInboxHub`

`memberCount: inboxDb.listMembers().length` liczy się EAGERNIE przy każdym ticku, zanim `isInboxHub` zdąży odbić brak `WEBHOOK_BASE_URL` — więc każda instalacja (laptop członka, maszyna bez skrzynki) co godzinę otwiera i migruje `data/inbox.db` tylko po to, żeby dowiedzieć się, że nie jest hubem. Zamień argument na `memberCount: WEBHOOK_BASE_URL ? inboxDb.listMembers().length : 0`.

#### 11. [KOD] `lib/inbox-db.js:850` — N+1 w pętli rewokacji

`if (countBlobRefs(sha) > 0) continue;` odpala osobne `prepare` + `SELECT COUNT(*)` dla każdego hasha odwołanego członka (rule 12: pętla z zapytaniem do bazy = N+1). Przed pętlą policz to jednym zapytaniem (`SELECT DISTINCT sha256 FROM inbox_attachments WHERE sha256 IN (...)` → `Set`), a w pętli zamień warunek na `if (stillReferenced.has(sha)) continue;`.

#### 12. [KOD] `lib/inbox-retention.js:162` — pierwsze przemiatanie synchronicznie przed `server.listen`

`startInboxRetention` robi pierwsze przemiatanie SYNCHRONICZNIE w linii startu, a jest wołane w `server.js` PRZED `server.listen` — pełny skan `inbox_attachments` plus seria `unlinkSync` opóźnia przyjęcie pierwszego żądania, a na maszynie klienta sam guard (`isHub()` → `listMembers()` → `getInboxDb()`) otwiera i migruje `inbox.db` już przy boocie. Zamień `runSweep({ isHub, log, warn });` na odroczony pierwszy przebieg (`setTimeout(..., 60_000)` + `unref()`) i wyczyść ten timer w `stopInboxRetention` obok istniejącego `clearInterval`.

#### 13. [KOD] `server.js:1219` — duplikat trzyelementowego wywołania `isInboxHub`

Zestaw argumentów `isInboxHub({ inboxHubUrl, webhookBaseUrl: WEBHOOK_BASE_URL, memberCount: inboxDb.listMembers().length })` jest powielony dosłownie w handlerze `/api/status` (linia 299) i w guardzie retencji (linia 1219). Rozjazd jednej kopii da panel twierdzący co innego niż przemiatanie. Wyciągnij tuż nad linią 299 `function currentIsInboxHub() { … }` i użyj jej w obu miejscach (`isHub: currentIsInboxHub`).

#### 14. [KOD] `lib/inbox-retention.js:148` — log miesza `deletedBlobs` z rosnącym na zawsze `expired`

Komunikat loga miesza dwie nieporównywalne liczby: `deletedBlobs` (co realnie zwolniono w tym ticku) i `expired` (wszystkie wygasłe wiersze metadanych, licznik rosnący na zawsze, bo metadane nigdy nie znikają). Operator czytający „skasowano bajty 1 załączników (wygasłych rekordów: 4213)" przeczyta 4213 jako zaległość. Usuń człon `(wygasłych rekordów: ${expired})` z szablonu komunikatu.

#### 15. [TEST] `lib/inbox-retention.test.js:273` — hooki bazodanowe na poziomie pliku obejmują 18 testów czystych funkcji

`beforeEach`/`afterEach` są zarejestrowane na poziomie pliku, więc w `node:test` obowiązują WSZYSTKIE testy w pliku — 18 testów czystych funkcji progowych (deklarowanych jako „zero I/O, zero bazy") dostaje przy każdym przebiegu `inboxDb.close()`, `setInboxDbPath(':memory:')`, pełne `migrate()` i dwa `addMember`. Opakuj oba testy kontraktu SQL w `describe('kontrakt SQL', () => { … })` i przenieś hooki z linii 273 i 278 do wnętrza tego bloku.

#### 16. [TEST] `lib/inbox-db.test.js:790` — import w środku pliku

`const inboxBlobs = require('./inbox-blobs');` stoi w środku pliku, między testami, mimo że reszta zależności jest zaimportowana w bloku linii 1–8 (coding-rules §8). Usuń tę linię i dodaj `const inboxBlobs = require('./inbox-blobs');` bezpośrednio pod `const inboxDb = require('./inbox-db');` w linii 8.

#### 17. [TEST] `lib/inbox-retention.test.js:255` — komunikat asercji twierdzi więcej, niż test sprawdza

`assert.strictEqual(asked, 1, 'guard pytany przy każdym przemiataniu')` — obserwowane jest wyłącznie jedno, startowe wywołanie `runSweep`, a nie zachowanie guardu przy kolejnych tickach interwału (test nie przesuwa czasu). Zamień tekst asercji na `'guard pytany już przy przemiataniu startowym'`.

---

### ⚪ OPERATOR (poza fixem — do Operator checklist)

#### 18. [OPERATOR] `docs/active/zalaczniki-w-skrzynce/zalaczniki-w-skrzynce-zadania.md:268`

Operator checklist fazy 4 (IU-10): „sprawdź, że `data/inbox-blobs/` powstało i ma właściciela `claude`" — weryfikacja wymaga realnego wdrożenia na hub VPS (użytkownik daemona, uprawnienia katalogu), więc jest niewykonalna w środowisku headless review. Nie jest to defekt kodu: magazyn tworzy `writeBlobFromStream` przy pierwszym PUT z `mode 0600`, ale właściciel katalogu zależy od usera systemd na hubie.

#### 19. [OPERATOR] `lib/inbox-retention.js:1`

Progi retencji (14 dni po domknięciu wątku, 90 dni od wysłania, 24 h karencji sierot) oraz sam fakt, że przemiatanie in-process rusza na hubie pod guardem `isInboxHub`, są weryfikowalne wyłącznie na żywym hubie VPS z upływem realnego czasu. Do smoke'u operatora: po wdrożeniu sprawdzić w logu daemona brak wpisów `[inbox-retention] przemiatanie padło`, właściciela/uprawnienia `data/inbox-blobs/` (user `claude`) oraz że po godzinie od startu skrzynka dalej odpowiada na pull.

---

## Obalone przez verify (nie do naprawy)

Brak — każdy weryfikowany finding przetrwał próbę obalenia.

---

## Bookkeeping checkboxów Weryfikacja: / Test: [E2E]

- Odznaczone automatycznie (CLI/grep): 3
- Odznaczone na podstawie przebiegów E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

Faza 4 nie zawiera ani jednego checkboxa z markerem `[E2E]` — tester E2E został pominięty przez routing, a bookkeeping nie miał czego przenosić do Operator checklist z tego tytułu.

### Szczegóły
- [x] CLI: `node --test lib/inbox-retention.test.js` → PASS (20/20, exit 0)
- [x] CLI: `node --test lib/inbox-db.test.js server.inbox.http.test.js` → PASS (100/100, exit 0)
- [x] CLI: `npm test` (pełna suita) → PASS (1279/1279, exit 0)

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 10 (6) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=true |
| Checkboxy `[E2E]` (Test: + Weryfikacja:) | 0 |
| Tryb testera E2E | pominiety |
| Tester E2E | pominiety przez routing |
| Przebiegi E2E PASS / FAIL / SKIP | 0 / 0 / 0 |
| Reviewerzy aktywni | security, performance, code-quality, correctness, spec-compliance, test-coverage |
| Reviewerzy pominieci | e2e (zero checkboxow [E2E] (0) i brak makiet figma_screens) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 28 -> 28 -> 19 |
| P3 odrzucone limitem globalnym | 0 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 9 / 0 / 0 |
