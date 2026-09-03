Branch: `feature/zalaczniki-w-skrzynce`
Ostatnia aktualizacja: 2026-09-03

# Załączniki w Skrzynce Team OS — zadania

Źródła: plan techniczny `docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md`

## Faza 1 — Magazyn bajtów na hubie

Zależy od: Brak

### IU-1: Schemat i warstwa danych załączników (feature-builder-data)

- [x] Modyfikuj: `lib/inbox-db.js` — tabela `inbox_attachments` przez `CREATE TABLE IF NOT EXISTS` w `migrate()`, bez `ALTER TABLE` i bez backfillu
- [x] Modyfikuj: `lib/inbox-db.js` — funkcje `addAttachments(db, messageId, items)`, `getAttachmentsForMessages(ids)`, `getAttachmentById(id)`, `countBlobRefs(sha256)`; `countBlobRefs` rzutuje `COUNT(*)` na `Number` na granicy warstwy (agregaty node:sqlite bywają BigInt, a `bigint === 0` z `number` cicho fałszuje)
- [x] Modyfikuj: `lib/inbox-db.js` — żaden nowy `throw` w `migrate()` na stanie danych; `migrate()` biegnie przy KAŻDEJ operacji, więc rzut zabiłby też endpointy naprawcze — degraduj i `warn` z wykonywalnym komunikatem
- [x] Test (unit): `lib/inbox-db.test.js`
- [x] Test: [Unit] `migrate()` na świeżej bazie tworzy `inbox_attachments`; drugi przebieg nie rzuca
- [x] Test: [Unit] `addAttachments` zapisuje wiele rekordów dla jednej wiadomości i odczytuje je w kolejności wstawienia
- [x] Test: [Unit] `countBlobRefs` zwraca `number`, nie BigInt, i liczy poprawnie przy dwóch rekordach o tym samym `sha256`
- [x] Test: [Unit] `getAttachmentsForMessages([])` zwraca pustą tablicę zamiast rzucać
- [x] Weryfikacja: `node --test lib/inbox-db.test.js` przechodzi bez błędów

### IU-2: Magazyn blobów na dysku huba (feature-builder-data)

- [x] Stwórz: `lib/inbox-blobs.js` — katalog `data/inbox-blobs/<dwa pierwsze znaki sha256>/<sha256>`; `data/` jest w `.gitignore` w całości i leży poza drzewem vaulta, co jest granicą bezpieczeństwa, nie preferencją układu plików
- [x] Stwórz: `lib/inbox-blobs.js` — API `blobPath`, `hasBlob`, `openBlobRead`, `writeBlobFromStream(stream, expectedSha, maxBytes)`, `deleteBlob`; zapis do pliku tymczasowego, hash liczony ze strumienia, `rename` dopiero po zgodności
- [x] Stwórz: `lib/inbox-blobs.js` — walidacja `sha256` wzorcem `^[a-f0-9]{64}$` ZANIM wartość trafi do `path.join`; hash jest jedynym elementem ścieżki pochodzącym z sieci
- [x] Stwórz: `lib/inbox-blobs.js` — zapis poza transakcją SQLite; trzymanie transakcji przez 17 s transferu wypchnęłoby innych pisarzy poza `busy_timeout` i zwróciło `database is locked` jako błąd zamiast czekania
- [x] Test (unit): `lib/inbox-blobs.test.js`
- [x] Test: [Unit] Zapis strumienia o znanej treści tworzy plik pod ścieżką wyprowadzoną z jego sha256
- [x] Test: [Unit] Powtórzony zapis tej samej treści nie tworzy drugiego pliku (dedup R4)
- [x] Test: [Unit] Treść niezgodna z deklarowanym hashem → błąd, plik tymczasowy skasowany, plik docelowy nie powstaje
- [x] Test: [Unit] Strumień przekraczający `maxBytes` → błąd, brak pliku tymczasowego
- [x] Test: [Unit] `sha256` z `../` albo spoza `[a-f0-9]{64}` → błąd walidacji, `path.join` nigdy nie wołany
- [x] Weryfikacja: `node --test lib/inbox-blobs.test.js` przechodzi bez błędów

Notatka wykonawcza (IU-2): to pierwszy kod strumieniowy i pierwsze hashowanie w tym repo — w całym projekcie nie ma dziś ani `createReadStream`, ani `createHash`. Napisz test na rozjazd hasha i na przekroczenie limitu PRZED implementacją zapisu.

### IU-3: Endpointy binarne w API huba (feature-builder-data)

- [x] Modyfikuj: `lib/inbox-api.js` — `matchInboxToken` przyjmuje opcjonalny trzeci segment i zwraca `{token, action, param}`; regex jest granicą bezpieczeństwa, więc `/inbox/v2/…` nadal daje `null`, a nadmiarowe segmenty nie przechodzą
- [x] Modyfikuj: `lib/inbox-api.js` — akcja `blob` w `ENDPOINT_METHODS` z metodami `PUT` i `GET`; cap 64 KB nie obowiązuje dla akcji binarnych, limitem jest `MAX_ATTACHMENT_BYTES` egzekwowany w strumieniu
- [x] Modyfikuj: `lib/inbox-api.js` — autoryzacja odczytu po uczestnictwie: token musi należeć do `from_user` albo `to_user` wiadomości odwołującej się do tego `sha256`; sam hash nie jest uprawnieniem
- [x] Modyfikuj: `lib/inbox-api.js` — osobny kubeł rate-limitu dla operacji binarnych (klucz `token + ':blob'`), żeby transfer nie wygłodził własnego syncu nadawcy; stan in-memory jak `rateBuckets`, zero agregatów SQL
- [x] Modyfikuj: `server.js` — `handleInbox` rozgałęzia się PRZED `readTextBody`; ścieżka binarna nie może przejść przez ten helper, bo `req.setEncoding('utf8')` czyni chunki stringami i uszkodziłoby bajty
- [x] Modyfikuj: `server.js` — helpery `streamBodyToFile` (limit + `req.destroy()` po flushu odpowiedzi, wzorzec 413 z `/ask`) i `streamFileToResponse` (`createReadStream` + `pipe`, `Content-Type`, `Content-Length`)
- [x] Test (unit): `lib/inbox-api.test.js`
- [x] Test (unit): `server.inbox.http.test.js`
- [x] Test: [Unit] `matchInboxToken('/inbox/v1/tok/blob/<64 hex>')` zwraca `{token, action:'blob', param}`
- [x] Test: [Unit] `matchInboxToken('/inbox/v2/tok/blob/x')` zwraca `null`
- [x] Test: [Unit] `PUT blob` z nieznanym tokenem → 403 bez treści
- [x] Test: [Unit] `GET blob` tokenem członka niebędącego stroną wiadomości → 404 (nie 403 — nie zdradzamy istnienia)
- [x] Test: [Unit] Kubeł binarny wyczerpany nie blokuje `pull` tym samym tokenem
- [x] Test: [Unit] `PUT` ciała większego niż `MAX_ATTACHMENT_BYTES` → 413, plik tymczasowy nie zostaje
- [x] Test: [Unit] `PUT` treści o hashu innym niż w URL → 400, blob nie powstaje
- [x] Test: [Unit] `PUT` blobu już istniejącego → 200 bez ponownego zapisu (R4)
- [x] Weryfikacja: `node --test lib/inbox-api.test.js` przechodzi bez błędów
- [x] Weryfikacja: `node --test server.inbox.http.test.js` przechodzi bez błędów

## Do poprawy po review fazy 1
Zamkniete cyklem fix: 14 pozycji — pelna tresc findingow i uzasadnienia w `review-faza-1.md`.


## Operator checklist faza 1

- [ ] Operator: [Manual] Realny transfer 25 MB przez publiczny Funnel z maszyny spoza tailnetu kończy się 200 — harness testowy chodzi po loopbacku i nie dowiedzie zachowania proxy (IU-3) — Operator action: z maszyny spoza tailnetu wyślij plik 25 MB `PUT`-em na `https://<funnel-url>/inbox/v1/<token>/blob/<sha256>`, zmierz czas i kod odpowiedzi (oczekiwane 200), powtórz to samo żądanie i sprawdź `deduped:true` w odpowiedzi oraz brak śmieci w `data/inbox-blobs/tmp` na hubie.

## Faza 2 — Wysyłka z załącznikami

Zależy od: Faza 1

### IU-4: Klient huba — operacje binarne (feature-builder-data)

- [x] Modyfikuj: `scripts/inbox/inbox-client.mjs` — `BINARY_TIMEOUT_MS = 180_000` jako OSOBNA stała; `REQUEST_TIMEOUT_MS = 15_000` zostaje dla `pull`/`done`, bo jego ciasnota jest tam celowa
- [x] Modyfikuj: `scripts/inbox/inbox-client.mjs` — `uploadBlob(sha256, filePath)` RETRYUJE (w odróżnieniu od `send`), bo kluczem deduplikacji jest treść: powtórzenie po timeoucie trafia w istniejący blob bez skutków ubocznych
- [x] Modyfikuj: `scripts/inbox/inbox-client.mjs` — `downloadBlob(sha256, destPath)` zapisuje do pliku tymczasowego i robi `rename` po sukcesie; przerwany transfer nie zostawia pliku wyglądającego na kompletny
- [x] Test (unit): `scripts/inbox/inbox-client.test.mjs`
- [x] Test: [Unit] `uploadBlob` po jednym `AbortError` ponawia i kończy sukcesem
- [x] Test: [Unit] `uploadBlob` używa `BINARY_TIMEOUT_MS`, nie `REQUEST_TIMEOUT_MS`
- [x] Test: [Unit] `downloadBlob` przy zerwaniu w połowie nie zostawia pliku docelowego
- [x] Test: [Unit] Komunikat błędu z URL-em zawierającym token jest zredagowany
- [x] Weryfikacja: `node --test scripts/inbox/inbox-client.test.mjs` przechodzi bez błędów

### IU-5: Wysyłka plików przez `send` i `reply` (feature-builder-data)

- [x] Stwórz: `scripts/inbox/attachments.mjs` — `prepareAttachments(paths)`: `stat` → próg 25 MB sprawdzany PRZED jakimkolwiek transferem → `sha256` z pliku → `uploadBlob`; próg mierzy wyłącznie pojedynczy plik, bez limitu sumy wiadomości
- [x] Modyfikuj: `scripts/inbox/args.mjs` — powtarzalna flaga `--attach <ścieżka>`, jedna na plik; świadomie nie lista rozdzielana separatorem, bo ścieżki zawierają spacje, a wszystko przechodzące przez parser linii poleceń PowerShella potrafi się cicho rozpaść
- [x] Modyfikuj: `scripts/inbox/send.mjs` — wysyłka wiadomości dopiero po udanym uploadzie WSZYSTKICH plików; pad któregokolwiek uploadu = wiadomość nie powstaje (R2)
- [x] Modyfikuj: `scripts/inbox/reply.mjs` — ta sama ścieżka załączników co w `send.mjs`
- [x] Modyfikuj: `lib/inbox-api.js` — `handleSend` waliduje `attachments` na granicy (długość listy, wzorzec sha256, limity `filename` i `size_bytes`) i weryfikuje istnienie każdego blobu NA ŚWIEŻO tuż przed insertem, bo między uploadem a `send` mija kilkanaście sekund
- [x] Modyfikuj: `lib/inbox-db.js` — wstawienie wiadomości i rekordów załączników w jednej, KRÓTKIEJ transakcji; transfer jest już zakończony, więc transakcja nie trzyma blokady przez czas sieci
- [x] Test (unit): `scripts/inbox/attachments.test.mjs`
- [x] Test (unit): `scripts/inbox/send.test.mjs`
- [x] Test: [Unit] Dwa `--attach` dają dwa rekordy w jednej wiadomości
- [x] Test: [Unit] Plik 26 MB → odmowa PRZED wywołaniem `uploadBlob` (mock klienta nie dostaje żadnego żądania)
- [x] Test: [Unit] Pad uploadu drugiego pliku → `send` nie jest wołany w ogóle (R2)
- [x] Test: [Unit] Ten sam plik wysłany dwa razy → drugi upload trafia w istniejący blob, powstają dwa rekordy metadanych wskazujące jeden `sha256` (R4)
- [x] Test: [Unit] `handleSend` z `sha256` nieistniejącym na hubie → 400, wiadomość nie powstaje
- [x] Test: [Unit] `handleSend` z `attachments` niebędącym tablicą albo z nadmiarową liczbą pozycji → 400
- [x] Test: [Unit] Ścieżka do pliku, który nie istnieje → czytelny błąd przed transferem
- [x] Weryfikacja: `node --test scripts/inbox/attachments.test.mjs scripts/inbox/send.test.mjs` przechodzi bez błędów
- [x] Weryfikacja: `node --test lib/inbox-api.test.js lib/inbox-db.test.js` przechodzi bez błędów (regresja fazy 1)

Teksty (verbatim, IU-5) — odmowa przy przekroczeniu progu:
`Plik <nazwa> ma <rozmiar> i przekracza limit 25 MB. Wrzuć go na Dysk i wyślij link w treści wiadomości.`

## Do poprawy po review fazy 2

- [x] 🟠 [P2] **lib/inbox-api.js:224** — Bramka nazwy pliku (`/[/\\\0]/` + dokladnie `'.'`/`'..'`, lustro w `lib/inbox-db.js:515`) przepuszcza znaki sterujace (`"a\nb.pdf"`, `"raport\r\n- [x] Zrobione"`), warianty `'..'` z koncowa spacja/kropka (Win32 je obcina), oraz `:` (alternatywny strumien danych NTFS). `filename` to niezaufane wejscie nadawcy (R14), ktore w fazie 3 idzie do `path.join` i do renderu `Skrzynka.md` o kontrakcie liniowym — nazwa z `\n` pozwala wstrzyknac odhaczony checkbox, ktory `inbox-push.mjs` odczyta jako akcje czlowieka. Napraw w OBU lustrach: odrzucaj zakres kontrolny U+0000–U+001F, znak `:`, oraz nazwy, ktorych postac po obcieciu koncowych kropek i spacji rowna sie `'.'` albo `'..'`.
- [x] 🟠 [P2] **scripts/inbox/inbox-client.mjs:363** — `BINARY_TIMEOUT_MS` nie chroni transferu bajtow w `downloadBlob`, tylko naglowki: `fetchWithTimeout` (linia 92) robi `clearTimeout(timer)` w `finally`, a cialo konsumuje dopiero `pipeline(Readable.fromWeb(res.body), createWriteStream(tmpFile))` — juz po rozbrojeniu AbortControllera. Hub/Funnel, ktory odesle 200 i przestanie wysylac bajty, zawiesza `downloadBlob` BEZ LIMITU (run syncu wisi do twardego timeoutu executora, w vaultcie zostaje `.<nazwa>.<uuid>.part`, ktory Obsidian Sync rozniesie). Napraw: przenies kontrole timeoutu do `attemptBlobDownload` (wlasny `AbortController` + timer, `signal` do `fetch` i do `pipeline(..., { signal })`, `clearTimeout` dopiero po `pipeline`/`rename`). Dopisz test: strumien, ktory po pierwszym chunku nic nie emituje i sie nie zamyka, konczy sie bledem limitu czasu, a katalog docelowy zostaje pusty.
- [x] 🟠 [P2] **scripts/inbox/reply.test.mjs:82** — sciezka `--attach` w `reply.mjs` nie ma ANI JEDNEGO testu (plik nie zawiera slowa `attach`), choc checkbox IU-5 „ta sama sciezka zalacznikow co w send.mjs" jest odhaczony — rozjazd obu sciezek jest niewykrywalny (literowka `args.attachments` zamiast `args.attach` = zielona suita i odpowiedz bez plikow, R1/R2 zlamane cicho). Dopisz dwa testy lustrzane do `send.test.mjs`: (1) `--attach` na plik tmp → `client.uploads.length === 1` i jeden rekord w `client.calls[0].attachments`; (2) pad `uploadBlob` → `client.send` niewywolany (`client.calls.length === 0`).
- [x] 🟡 [P3] **lib/inbox-api.js:230** — walidacja `mime` sprawdza wylacznie dlugosc, wiec `'byle-co'` i `'text/html\r\nX: y'` przechodza granice i dopiero `normalizeAttachment` (lib/inbox-db.js:533) rzuca `InboxDbError` mapowany na ogolne `invalid_input`. Zamien warunek na `if (mime != null && (!isNonEmptyString(mime, MAX_MIME_LEN) || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime))) return { error: 'invalid_attachments' };` (wzorzec `MIME_PATTERN` z lib/inbox-db.js:494).
- [x] 🟡 [P3] **scripts/inbox/attachments.mjs:47** — `formatBytes` zaokragla `toFixed(1)` do najblizszej dziesiatej, wiec plik 26 214 401 B daje komunikat „ma 25,0 MB i przekracza limit 25 MB" (zdanie wewnetrznie sprzeczne). Zamien obliczenie na zaokraglenie w gore: `const mb = Math.ceil((bytes / (1024 * 1024)) * 10) / 10;` — reszta ciala bez zmian. Dopisz w `scripts/inbox/attachments.test.mjs` przypadek `formatBytes(MAX_ATTACHMENT_BYTES + 1) === '25,1 MB'`.
- [x] 🟡 [P3] **scripts/inbox/attachments.mjs:96** — domyslka `client = inboxClient` nie ma ani jednego uzycia (wszystkie cztery wywolania wstrzykuja klienta jawnie) i utrzymuje przy zyciu import z linii 14, wiazac modul przygotowania plikow z transportem. Zamien sygnature na `export async function prepareAttachments(paths, { client })` i usun linie 14 `import * as inboxClient from './inbox-client.mjs';`.
- [x] 🟡 [P3] **scripts/inbox/attachments.mjs:98** — `const list = Array.isArray(paths) ? paths : [paths];` to defensive code na scenariusz niemozliwy: `args.attach` siedzi w `REPEATABLE_KEYS` i jest zawsze tablica albo `undefined` (obsluzone wczesniejszym `if (paths == null) return [];`). Zamien linie 97–99 na `const list = paths ?? [];`, zostawiajac istniejacy `if (list.length === 0) return [];`.
- [x] 🟡 [P3] **scripts/inbox/inbox-client.mjs:362** — `await mkdir(path.dirname(destPath), { recursive: true })` lezy w tym samym `try` co `pipeline`, wiec EACCES/EROFS/ENOTDIR katalogu docelowego jest raportowany jako `{ retryable: true, message: 'przerwany transfer: ...' }` i konczy sie diagnoza wskazujaca siec zamiast praw do katalogu. Przenies `mkdir` PRZED blok `try` z linii 361 i owin wlasnym `try/catch` rzucajacym `InboxClientError` z nazwa katalogu i przyczyna (jak galaz `rename` w liniach 373–378).
- [x] 🟡 [P3] **scripts/inbox/reply.mjs:47** — runtime'owy komunikat Usage nie wymienia nowej flagi (w `send.mjs` zostal rozszerzony, w `reply.mjs` zaktualizowano tylko komentarz naglowkowy). Zmien tresc bledu na: `Usage: reply.mjs --thread-id <uuid> [--content "..." | --content-file <sciezka>] [--title "..."] [--to <nick>] [--attach <sciezka>]`.
- [x] 🟡 [P3] **lib/inbox-api.test.js:565** — granica `MAX_ATTACHMENTS_PER_MESSAGE` nieprzybita (jedyny przypadek to `MAX + 1` odrzucone), wiec zamiana `>` na `>=` w `lib/inbox-api.js:214` przeszlaby niezauwazona. Pod linia 565 dopisz asercje, ze lista o dlugosci dokladnie `MAX_ATTACHMENTS_PER_MESSAGE` (te same pola co `tooMany`, `sha256: SHA_A`, `filename` typu `p0.pdf`, `p1.pdf`, …) daje `status === 200`.
- [x] 🟡 [P3] **scripts/inbox/attachments.test.mjs:61** — granica progu 25 MB nieprzybita (test uzywa `MAX_ATTACHMENT_BYTES + 1024*1024`), wiec zamiana `>` na `>=` w `scripts/inbox/attachments.mjs:81` rozjechalaby klienta z hubem (`server.js:877` i `lib/inbox-blobs.js:153` uzywaja `>`). Dopisz test tworzacy przez `fs.truncateSync` plik o dokladnie `MAX_ATTACHMENT_BYTES` i asertujacy, ze `prepareAttachments([plik], { client })` zwraca jedna pozycje oraz `client.uploads.length === 1`.

## Operator checklist faza 2

Brak — wszystkie trzy checkboxy `Weryfikacja:` fazy 2 przebiegly zielono (CLI, exit 0), a faza nie ma ani jednego checkboxa `[E2E]`.

## Faza 3 — Odbiór: render, odhaczenie, zapis do vaulta

Zależy od: Faza 2

### IU-6: Render załączników w Skrzynce — trzy stany (feature-builder-data)

- [ ] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — wiersz załącznika renderowany PRZY SWOJEJ wiadomości w `renderMessage`, jako samodzielna linia z własnym markerem `%% att:<uuid> %%`; istniejący marker `%% id: … thread: … %%` identyfikuje wyłącznie kotwicę wątku i nie rozróżnia ani wiadomości w wątku, ani plików w wiadomości
- [ ] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — trzy stany rozstrzygane WYŁĄCZNIE odczytem dysku i metadanych: plik obecny → osadzenie `> ![[…]]` bez checkboxa (R8); bajty na hubie → `- [ ] Pobierz` z metadanymi; bajty wygasłe → wiersz z adnotacją bez checkboxa
- [ ] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — zero zapisu stanu gdziekolwiek; blok między markerami jest nadpisywany w całości co minutę, więc wszystko, co nie wynika z dysku albo z odpowiedzi huba, zostanie zdmuchnięte
- [ ] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — klasy `os-att` i `os-att-gone` w spanach; wiersz nie może nieść niczego zależnego od `Date.now()`, bo `writeIfChanged` generowałby wtedy zapis co minutę i ryzyko konfliktu
- [ ] Test (unit): `scripts/inbox/inbox-pull.test.mjs`
- [ ] Test: [Unit] Wiadomość z jednym załącznikiem, plik nieobecny na dysku → linia `- [ ] Pobierz` z markerem `att:`
- [ ] Test: [Unit] Ten sam zestaw wejściowy, plik obecny na dysku → osadzenie `![[…]]`, BRAK linii `Pobierz`
- [ ] Test: [Unit] Metadane bez blobu na hubie → wiersz z adnotacją o wygaśnięciu, brak checkboxa
- [ ] Test: [Unit] Dwa załączniki w jednej wiadomości → dwie linie o różnych markerach `att:`
- [ ] Test: [Unit] Wiersz załącznika nie zawiera niczego zależnego od `Date.now()` — dwa renderowania w odstępie czasu dają identyczny string
- [ ] Test: [Unit] Istniejący test roundtrip „Zrobione" nadal przechodzi bez zmian
- [ ] Weryfikacja: `node --test scripts/inbox/inbox-pull.test.mjs` przechodzi bez błędów

### IU-7: Parser odhaczonych pobrań — akcja wyłącznie lokalna (feature-builder-data)

- [ ] Modyfikuj: `scripts/inbox/inbox-push.mjs` — OSOBNA funkcja `parseRequestedDownloads(section)`, nie rozszerzenie alternatywy w `parseCheckedCallouts`; dopisanie `Pobierz` do `(Zrobione|Zapoznane)` wpuściłoby akcję lokalną do `client.done()`, a hub odrzuciłby ją jako `invalid_action`, czyli błąd przy każdym syncu
- [ ] Modyfikuj: `scripts/inbox/inbox-push.mjs` — parser jest przebiegiem po liniach, nie po blokach; marker `%% att:<uuid> %%` jest samodzielny, więc nie zależy od kruchego blokowania po prefiksie `'> '` (render emituje gołe `>`, które rozbijają callout na fragmenty)
- [ ] Modyfikuj: `scripts/inbox/inbox-push.mjs` — `parseCheckedCallouts` zostaje NIETKNIĘTE; brak interferencji ma być udowodniony testem, nie założony
- [ ] Test (unit): `scripts/inbox/inbox-push.test.mjs`
- [ ] Test (unit): `scripts/inbox/inbox-pull.test.mjs`
- [ ] Test: [Unit] Roundtrip: wyrenderowany wiersz z podmienionym `[ ]` na `[x]` parsuje się na `{attachment_id}`
- [ ] Test: [Unit] `parseCheckedCallouts` na tej samej sekcji nie zwraca niczego dla wiersza `Pobierz` (R9)
- [ ] Test: [Unit] Sekcja z odhaczonym „Zrobione" i odhaczonym „Pobierz" → jedna akcja hubowa i jedno pobranie, bez wzajemnego mieszania
- [ ] Test: [Unit] Nieodhaczony wiersz `Pobierz` nie generuje żądania
- [ ] Test: [Unit] Uszkodzony marker (`%% att: %%` bez uuid) jest pomijany bez rzutu
- [ ] Weryfikacja: `node --test scripts/inbox/inbox-push.test.mjs scripts/inbox/inbox-pull.test.mjs` przechodzi bez błędów

Notatka wykonawcza (IU-7): kontrakt render↔parser jest najbardziej kruchym miejscem systemu i jedynym z testem szwu. Napisz nowy test roundtrip (render → odhaczenie → parse) PRZED implementacją parsera.

### IU-8: Pobranie do vaulta i wpięcie w sync (feature-builder-data)

- [ ] Modyfikuj: `scripts/inbox/inbox-sync.mjs` — sekwencja staje się push → pobrania → pull, w jednym procesie; między krokami nie może być okna, w którym render zdmuchnie akcję usera
- [ ] Modyfikuj: `scripts/inbox/env-loader.mjs` — nowe `INBOX_ATTACHMENTS_DIR` = `<workspace>/Zasoby/inbox-zalaczniki`, wyprowadzane z `INBOX_SKRZYNKA_PATH` tak samo jak `INBOX_ARCHIVE_DIR`, ustawiane zawsze i tylko gdy nie ma go w env
- [ ] Modyfikuj: `scripts/inbox/attachments.mjs` — sanityzacja nazwy (R14) sprawdza EFEKT, nie kształt: `path.basename` → usunięcie znaków kontrolnych i separatorów → odrzucenie `.`/`..`/nazwy pustej → `path.resolve` i weryfikacja, że wynik nadal leży pod katalogiem docelowym
- [ ] Modyfikuj: `scripts/inbox/attachments.mjs` — kolizja nazw: przy innej treści sufiks porządkowy, przy tej samej treści (zgodny `sha256`) potraktuj jako pobrany i nic nie rób; zapis przez plik tymczasowy i `rename`, bo obecność pliku JEST stanem pobrania
- [ ] Modyfikuj: `scripts/inbox/attachments.mjs` — R10 dwiema warstwami: job syncu z natury nie istnieje na maszynie w roli `agent`, a mimo to krok pobrań sprawdza rolę jawnie i kończy się no-opem (obrona w głąb, bo rola bywa ustawiana ręcznie)
- [ ] Modyfikuj: `scripts/inbox/attachments.mjs` — pobranie niczego nie zgłasza hubowi (R9): brak `client.done()`, brak zmiany statusu, brak archiwum
- [ ] Test (unit): `scripts/inbox/attachments.test.mjs`
- [ ] Test (unit): `scripts/inbox/inbox-sync.test.mjs`
- [ ] Test: [Unit] Odhaczony załącznik → plik ląduje w `Zasoby/inbox-zalaczniki/RRRR-MM/` pod sanityzowaną nazwą
- [ ] Test: [Unit] Nazwa `../../../etc/passwd` → zapis wewnątrz katalogu docelowego albo odmowa; NIGDY poza nim
- [ ] Test: [Unit] Nazwa z separatorem, znakiem kontrolnym i sama `..` → każda odrzucona lub sprowadzona do basename
- [ ] Test: [Unit] Powtórne pobranie tego samego pliku (ta sama treść) → brak drugiego pliku, brak błędu
- [ ] Test: [Unit] Kolizja nazw przy różnej treści → drugi plik z sufiksem, pierwszy nietknięty
- [ ] Test: [Unit] Przerwane pobranie → brak pliku docelowego, stan pobrania nadal „niepobrany"
- [ ] Test: [Unit] `state.inbox_role === 'agent'` → krok pobrań jest no-opem mimo odhaczonych checkboxów (R10)
- [ ] Test: [Unit] Pobranie nie woła `client.done()` ani niczego zmieniającego status (R9) — mock klienta odnotowuje zero wywołań
- [ ] Test: [Unit] Sekwencja syncu: pobranie następuje PO pushu i PRZED pullem
- [ ] Weryfikacja: `node --test scripts/inbox/attachments.test.mjs scripts/inbox/inbox-sync.test.mjs` przechodzi bez błędów
- [ ] Weryfikacja: `node --test` (pełna suita) przechodzi bez błędów

## Faza 4 — Retencja, sprzątanie i rewokacja

Zależy od: Faza 3

### IU-9: Retencja bajtów na hubie (feature-builder-data)

- [ ] Stwórz: `lib/inbox-retention.js` — czysta funkcja `computeExpiredAttachments({now, rows, graceMs, hardTtlMs})`: zero I/O, zero `Date.now()` w środku (wzorzec `computeMissedJobs`), cała logika progów testowalna bez bazy i bez dysku
- [ ] Stwórz: `lib/inbox-retention.js` — dwa progi: 14 dni od domknięcia wątku oraz twardo 90 dni od `created_at`; po wycofaniu R12 retencja jest JEDYNYM mechanizmem zwalniającym miejsce, więc twardy limit nie jest opcją
- [ ] Stwórz: `lib/inbox-retention.js` — znikają wyłącznie bajty, rekord metadanych zostaje (żeby render mógł pokazać trzeci stan); blob kasowany dopiero gdy `countBlobRefs(sha256)` osiągnie zero
- [ ] Stwórz: `lib/inbox-retention.js` — sprzątanie osieroconych blobów (wgrane, nigdy nieprzypisane do wiadomości) dopiero po karencji liczonej w godzinach; trwający upload nie może zostać uznany za sierotę
- [ ] Modyfikuj: `server.js` — przemiatanie in-process pod guardem `isInboxHub()`, wzorowane na `startRetention` ze schedulera; świadomie nie jako script-job, bo drugi proces otwierałby drugie połączenie do `inbox.db` w trakcie transferów
- [ ] Test (unit): `lib/inbox-retention.test.js`
- [ ] Test: [Unit] Wątek domknięty 13 dni temu → bajty zostają; 15 dni temu → do skasowania
- [ ] Test: [Unit] Wątek otwarty, wysłany 89 dni temu → zostaje; 91 dni → do skasowania mimo otwartego wątku
- [ ] Test: [Unit] Odstęp nieokrągły względem progu (jawny jitter) daje ten sam werdykt co okrągły
- [ ] Test: [Unit] Dwa rekordy o tym samym `sha256`, jeden wygasły → blob NIE jest kasowany
- [ ] Test: [Unit] Oba rekordy wygasłe → blob kasowany dokładnie raz
- [ ] Test: [Unit] Skasowanie bajtów zostawia rekord metadanych nietknięty
- [ ] Test: [Unit] Blob bez rekordu, młodszy niż karencja sierot → nie jest kasowany
- [ ] Test: [Unit] Przemiatanie przy braku czegokolwiek do skasowania nie rzuca i nie loguje błędu
- [ ] Weryfikacja: `node --test lib/inbox-retention.test.js` przechodzi bez błędów

Notatka wykonawcza (IU-9): testy progów pisz z JAWNYM jitterem czasu, nie na okrągłych wartościach. `t.mock.timers.tick(period)` daje odstęp dokładnie równy progowi — wartość w produkcji nieosiągalną, więc test przechodzi przy złamanym zachowaniu.

### IU-10: Kaskada przy odwołaniu dostępu (feature-builder-data)

- [ ] Modyfikuj: `lib/inbox-db.js` — `revokeMember` kasuje wiadomości członka, ich rekordy załączników oraz bajty, do których nie odwołuje się już nic innego; dziś to gołe `DELETE FROM members` bez kaskady
- [ ] Modyfikuj: `lib/inbox-db.js` — część bazodanowa w JEDNEJ transakcji, kasowanie plików PO udanym commicie; odwrotna kolejność zostawia rekordy wskazujące na nieistniejące bajty przy padzie transakcji
- [ ] Modyfikuj: `lib/inbox-db.js` — pad `unlink` to `warn`, nie rzut; bajt bez rekordu i tak sprzątnie sprzątanie sierot z IU-9
- [ ] Modyfikuj: `lib/inbox-db.js` — komentarz odnotowujący zasięg: wiadomości członka bywają częścią wątków innych osób, więc domknięte wątki tracą część historii, a archiwum w vaultach pozostaje jedynym śladem
- [ ] Test (unit): `lib/inbox-db.test.js`
- [ ] Test (unit): `server.inbox.http.test.js`
- [ ] Test: [Unit] Rewokacja członka z dwiema wiadomościami i trzema załącznikami → zero rekordów po nim
- [ ] Test: [Unit] Blob współdzielony z wiadomością innego członka NIE jest kasowany
- [ ] Test: [Unit] Blob wyłącznie jego → plik znika z dysku
- [ ] Test: [Unit] Pad kasowania pliku (brak uprawnień) → operacja kończy się sukcesem, rekordy skasowane, `warn` zalogowany
- [ ] Test: [Unit] Rewokacja nieistniejącego id → `false`, żadnych efektów ubocznych
- [ ] Test: [Unit] `DELETE /api/inbox/members/:id` przez API zwraca 200 i faktycznie kasuje dane
- [ ] Weryfikacja: `node --test lib/inbox-db.test.js server.inbox.http.test.js` przechodzi bez błędów
- [ ] Weryfikacja: `node --test` (pełna suita) przechodzi bez błędów

## Operator checklist faza 4

- [ ] Po wdrożeniu na hub: sprawdź, że `data/inbox-blobs/` powstało i ma właściciela `claude` (IU-10)
