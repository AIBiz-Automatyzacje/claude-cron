Branch: `feature/zalaczniki-w-skrzynce`
Ostatnia aktualizacja: 2026-09-03 (faza 3)

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
Zamkniete cyklem fix: 11 pozycji — pelna tresc findingow i uzasadnienia w `review-faza-2.md`.

## Operator checklist faza 2

Brak — wszystkie trzy checkboxy `Weryfikacja:` fazy 2 przebiegly zielono (CLI, exit 0), a faza nie ma ani jednego checkboxa `[E2E]`.

## Faza 3 — Odbiór: render, odhaczenie, zapis do vaulta

Zależy od: Faza 2

### IU-6: Render załączników w Skrzynce — trzy stany (feature-builder-data)

- [x] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — wiersz załącznika renderowany PRZY SWOJEJ wiadomości w `renderMessage`, jako samodzielna linia z własnym markerem `%% att:<uuid> %%`; istniejący marker `%% id: … thread: … %%` identyfikuje wyłącznie kotwicę wątku i nie rozróżnia ani wiadomości w wątku, ani plików w wiadomości
- [x] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — trzy stany rozstrzygane WYŁĄCZNIE odczytem dysku i metadanych: plik obecny → osadzenie `> ![[…]]` bez checkboxa (R8); bajty na hubie → `- [ ] Pobierz` z metadanymi; bajty wygasłe → wiersz z adnotacją bez checkboxa
- [x] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — zero zapisu stanu gdziekolwiek; blok między markerami jest nadpisywany w całości co minutę, więc wszystko, co nie wynika z dysku albo z odpowiedzi huba, zostanie zdmuchnięte
- [x] Modyfikuj: `scripts/inbox/inbox-pull.mjs` — klasy `os-att` i `os-att-gone` w spanach; wiersz nie może nieść niczego zależnego od `Date.now()`, bo `writeIfChanged` generowałby wtedy zapis co minutę i ryzyko konfliktu
- [x] Test (unit): `scripts/inbox/inbox-pull.test.mjs`
- [x] Test: [Unit] Wiadomość z jednym załącznikiem, plik nieobecny na dysku → linia `- [ ] Pobierz` z markerem `att:`
- [x] Test: [Unit] Ten sam zestaw wejściowy, plik obecny na dysku → osadzenie `![[…]]`, BRAK linii `Pobierz`
- [x] Test: [Unit] Metadane bez blobu na hubie → wiersz z adnotacją o wygaśnięciu, brak checkboxa
- [x] Test: [Unit] Dwa załączniki w jednej wiadomości → dwie linie o różnych markerach `att:`
- [x] Test: [Unit] Wiersz załącznika nie zawiera niczego zależnego od `Date.now()` — dwa renderowania w odstępie czasu dają identyczny string
- [x] Test: [Unit] Istniejący test roundtrip „Zrobione" nadal przechodzi bez zmian
- [x] Weryfikacja: `node --test scripts/inbox/inbox-pull.test.mjs` przechodzi bez błędów

### IU-7: Parser odhaczonych pobrań — akcja wyłącznie lokalna (feature-builder-data)

- [x] Modyfikuj: `scripts/inbox/inbox-push.mjs` — OSOBNA funkcja `parseRequestedDownloads(section)`, nie rozszerzenie alternatywy w `parseCheckedCallouts`; dopisanie `Pobierz` do `(Zrobione|Zapoznane)` wpuściłoby akcję lokalną do `client.done()`, a hub odrzuciłby ją jako `invalid_action`, czyli błąd przy każdym syncu
- [x] Modyfikuj: `scripts/inbox/inbox-push.mjs` — parser jest przebiegiem po liniach, nie po blokach; marker `%% att:<uuid> %%` jest samodzielny, więc nie zależy od kruchego blokowania po prefiksie `'> '` (render emituje gołe `>`, które rozbijają callout na fragmenty)
- [x] Modyfikuj: `scripts/inbox/inbox-push.mjs` — `parseCheckedCallouts` zostaje NIETKNIĘTE; brak interferencji ma być udowodniony testem, nie założony
- [x] Test (unit): `scripts/inbox/inbox-push.test.mjs`
- [x] Test (unit): `scripts/inbox/inbox-pull.test.mjs`
- [x] Test: [Unit] Roundtrip: wyrenderowany wiersz z podmienionym `[ ]` na `[x]` parsuje się na `{attachment_id}`
- [x] Test: [Unit] `parseCheckedCallouts` na tej samej sekcji nie zwraca niczego dla wiersza `Pobierz` (R9)
- [x] Test: [Unit] Sekcja z odhaczonym „Zrobione" i odhaczonym „Pobierz" → jedna akcja hubowa i jedno pobranie, bez wzajemnego mieszania
- [x] Test: [Unit] Nieodhaczony wiersz `Pobierz` nie generuje żądania
- [x] Test: [Unit] Uszkodzony marker (`%% att: %%` bez uuid) jest pomijany bez rzutu
- [x] Weryfikacja: `node --test scripts/inbox/inbox-push.test.mjs scripts/inbox/inbox-pull.test.mjs` przechodzi bez błędów

Notatka wykonawcza (IU-7): kontrakt render↔parser jest najbardziej kruchym miejscem systemu i jedynym z testem szwu. Napisz nowy test roundtrip (render → odhaczenie → parse) PRZED implementacją parsera.

### IU-8: Pobranie do vaulta i wpięcie w sync (feature-builder-data)

- [x] Modyfikuj: `scripts/inbox/inbox-sync.mjs` — sekwencja staje się push → pobrania → pull, w jednym procesie; między krokami nie może być okna, w którym render zdmuchnie akcję usera
- [x] Modyfikuj: `scripts/inbox/env-loader.mjs` — nowe `INBOX_ATTACHMENTS_DIR` = `<workspace>/Zasoby/inbox-zalaczniki`, wyprowadzane z `INBOX_SKRZYNKA_PATH` tak samo jak `INBOX_ARCHIVE_DIR`, ustawiane zawsze i tylko gdy nie ma go w env
- [x] Modyfikuj: `scripts/inbox/attachments.mjs` — sanityzacja nazwy (R14) sprawdza EFEKT, nie kształt: `path.basename` → usunięcie znaków kontrolnych i separatorów → odrzucenie `.`/`..`/nazwy pustej → `path.resolve` i weryfikacja, że wynik nadal leży pod katalogiem docelowym
- [x] Modyfikuj: `scripts/inbox/attachments.mjs` — kolizja nazw: przy innej treści sufiks porządkowy, przy tej samej treści (zgodny `sha256`) potraktuj jako pobrany i nic nie rób; zapis przez plik tymczasowy i `rename`, bo obecność pliku JEST stanem pobrania
- [x] Modyfikuj: `scripts/inbox/attachments.mjs` — R10 dwiema warstwami: job syncu z natury nie istnieje na maszynie w roli `agent`, a mimo to krok pobrań sprawdza rolę jawnie i kończy się no-opem (obrona w głąb, bo rola bywa ustawiana ręcznie)
- [x] Modyfikuj: `scripts/inbox/attachments.mjs` — pobranie niczego nie zgłasza hubowi (R9): brak `client.done()`, brak zmiany statusu, brak archiwum
- [x] Test (unit): `scripts/inbox/attachments.test.mjs`
- [x] Test (unit): `scripts/inbox/inbox-sync.test.mjs`
- [x] Test: [Unit] Odhaczony załącznik → plik ląduje w `Zasoby/inbox-zalaczniki/RRRR-MM/` pod sanityzowaną nazwą
- [x] Test: [Unit] Nazwa `../../../etc/passwd` → zapis wewnątrz katalogu docelowego albo odmowa; NIGDY poza nim
- [x] Test: [Unit] Nazwa z separatorem, znakiem kontrolnym i sama `..` → każda odrzucona lub sprowadzona do basename
- [x] Test: [Unit] Powtórne pobranie tego samego pliku (ta sama treść) → brak drugiego pliku, brak błędu
- [x] Test: [Unit] Kolizja nazw przy różnej treści → drugi plik z sufiksem, pierwszy nietknięty
- [x] Test: [Unit] Przerwane pobranie → brak pliku docelowego, stan pobrania nadal „niepobrany"
- [x] Test: [Unit] `state.inbox_role === 'agent'` → krok pobrań jest no-opem mimo odhaczonych checkboxów (R10)
- [x] Test: [Unit] Pobranie nie woła `client.done()` ani niczego zmieniającego status (R9) — mock klienta odnotowuje zero wywołań
- [x] Test: [Unit] Sekwencja syncu: pobranie następuje PO pushu i PRZED pullem
- [x] Weryfikacja: `node --test scripts/inbox/attachments.test.mjs scripts/inbox/inbox-sync.test.mjs` przechodzi bez błędów
- [x] Weryfikacja: `node --test` (pełna suita) przechodzi bez błędów

## Do poprawy po review fazy 3
Zamkniete cyklem fix: 15 pozycji — pelna tresc findingow i uzasadnienia w `review-faza-3.md`.

## Operator checklist faza 3

Brak — wszystkie cztery checkboxy `Weryfikacja:` fazy 3 przebiegly zielono (CLI, exit 0), a faza nie ma ani jednego checkboxa `[E2E]` (tester E2E pominiety przez routing, bo nie bylo czego uruchamiac).

## Faza 4 — Retencja, sprzątanie i rewokacja

Zależy od: Faza 3

### IU-9: Retencja bajtów na hubie (feature-builder-data)

- [x] Stwórz: `lib/inbox-retention.js` — czysta funkcja `computeExpiredAttachments({now, rows, graceMs, hardTtlMs})`: zero I/O, zero `Date.now()` w środku (wzorzec `computeMissedJobs`), cała logika progów testowalna bez bazy i bez dysku
- [x] Stwórz: `lib/inbox-retention.js` — dwa progi: 14 dni od domknięcia wątku oraz twardo 90 dni od `created_at`; po wycofaniu R12 retencja jest JEDYNYM mechanizmem zwalniającym miejsce, więc twardy limit nie jest opcją
- [x] Stwórz: `lib/inbox-retention.js` — znikają wyłącznie bajty, rekord metadanych zostaje (żeby render mógł pokazać trzeci stan); blob kasowany dopiero gdy `countBlobRefs(sha256)` osiągnie zero
- [x] Stwórz: `lib/inbox-retention.js` — sprzątanie osieroconych blobów (wgrane, nigdy nieprzypisane do wiadomości) dopiero po karencji liczonej w godzinach; trwający upload nie może zostać uznany za sierotę
- [x] Modyfikuj: `server.js` — przemiatanie in-process pod guardem `isInboxHub()`, wzorowane na `startRetention` ze schedulera; świadomie nie jako script-job, bo drugi proces otwierałby drugie połączenie do `inbox.db` w trakcie transferów
- [x] Test (unit): `lib/inbox-retention.test.js`
- [x] Test: [Unit] Wątek domknięty 13 dni temu → bajty zostają; 15 dni temu → do skasowania
- [x] Test: [Unit] Wątek otwarty, wysłany 89 dni temu → zostaje; 91 dni → do skasowania mimo otwartego wątku
- [x] Test: [Unit] Odstęp nieokrągły względem progu (jawny jitter) daje ten sam werdykt co okrągły
- [x] Test: [Unit] Dwa rekordy o tym samym `sha256`, jeden wygasły → blob NIE jest kasowany
- [x] Test: [Unit] Oba rekordy wygasłe → blob kasowany dokładnie raz
- [x] Test: [Unit] Skasowanie bajtów zostawia rekord metadanych nietknięty
- [x] Test: [Unit] Blob bez rekordu, młodszy niż karencja sierot → nie jest kasowany
- [x] Test: [Unit] Przemiatanie przy braku czegokolwiek do skasowania nie rzuca i nie loguje błędu
- [x] Weryfikacja: `node --test lib/inbox-retention.test.js` przechodzi bez błędów

Notatka wykonawcza (IU-9): testy progów pisz z JAWNYM jitterem czasu, nie na okrągłych wartościach. `t.mock.timers.tick(period)` daje odstęp dokładnie równy progowi — wartość w produkcji nieosiągalną, więc test przechodzi przy złamanym zachowaniu.

### IU-10: Kaskada przy odwołaniu dostępu (feature-builder-data)

- [x] Modyfikuj: `lib/inbox-db.js` — `revokeMember` kasuje wiadomości członka, ich rekordy załączników oraz bajty, do których nie odwołuje się już nic innego; dziś to gołe `DELETE FROM members` bez kaskady
- [x] Modyfikuj: `lib/inbox-db.js` — część bazodanowa w JEDNEJ transakcji, kasowanie plików PO udanym commicie; odwrotna kolejność zostawia rekordy wskazujące na nieistniejące bajty przy padzie transakcji
- [x] Modyfikuj: `lib/inbox-db.js` — pad `unlink` to `warn`, nie rzut; bajt bez rekordu i tak sprzątnie sprzątanie sierot z IU-9
- [x] Modyfikuj: `lib/inbox-db.js` — komentarz odnotowujący zasięg: wiadomości członka bywają częścią wątków innych osób, więc domknięte wątki tracą część historii, a archiwum w vaultach pozostaje jedynym śladem
- [x] Test (unit): `lib/inbox-db.test.js`
- [x] Test (unit): `server.inbox.http.test.js`
- [x] Test: [Unit] Rewokacja członka z dwiema wiadomościami i trzema załącznikami → zero rekordów po nim
- [x] Test: [Unit] Blob współdzielony z wiadomością innego członka NIE jest kasowany
- [x] Test: [Unit] Blob wyłącznie jego → plik znika z dysku
- [x] Test: [Unit] Pad kasowania pliku (brak uprawnień) → operacja kończy się sukcesem, rekordy skasowane, `warn` zalogowany
- [x] Test: [Unit] Rewokacja nieistniejącego id → `false`, żadnych efektów ubocznych
- [x] Test: [Unit] `DELETE /api/inbox/members/:id` przez API zwraca 200 i faktycznie kasuje dane
- [x] Weryfikacja: `node --test lib/inbox-db.test.js server.inbox.http.test.js` przechodzi bez błędów
- [x] Weryfikacja: `node --test` (pełna suita) przechodzi bez błędów

## Do poprawy po review fazy 4
Zamkniete cyklem fix: 16 pozycji — pelna tresc findingow i uzasadnienia w `review-faza-4.md`.

- [ ] 🟡 [P3] **lib/inbox-retention.js:162** — pierwsze przemiatanie biegnie synchronicznie w linii startu, a `startInboxRetention` jest wołane w server.js przed `server.listen`. Zamień `runSweep({ isHub, log, warn });` na `firstSweep = setTimeout(() => runSweep({ isHub, log, warn }), 60_000); if (typeof firstSweep.unref === 'function') firstSweep.unref();` i wyczyść ten timer w `stopInboxRetention` obok istniejącego `clearInterval`. (POMINIĘTE: odroczenie pierwszego przemiatania sprzeczne z istniejącym testem „guard pytany już przy przemiataniu startowym" — jego zmiana byłaby osłabieniem asercji)
## Operator checklist faza 4

- [ ] Operator: `data/inbox-blobs/` powstało na hubie i ma właściciela `claude` (IU-10) — Operator action: po wdrożeniu na hub VPS wyślij testowy załącznik, następnie `ls -ld ~/claude-cron/data/inbox-blobs` i potwierdź usera daemona oraz uprawnienia (magazyn tworzy `writeBlobFromStream` przy pierwszym PUT z `mode 0600`; właściciel katalogu zależy od usera systemd).
- [ ] Operator: progi retencji i przemiatanie in-process na hubie działają w czasie rzeczywistym — Operator action: po wdrożeniu sprawdź `journalctl -u <unit-pulsa> | grep '\[inbox-retention\]'` (brak wpisów „przemiatanie padło"), a po godzinie od startu potwierdź, że skrzynka dalej odpowiada na pull (`inbox sync` zielony w panelu).
