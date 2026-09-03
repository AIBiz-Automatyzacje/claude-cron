---
title: "feat: Załączniki w Skrzynce Team OS"
type: feat
status: active
date: 2026-09-03
origin: docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md
design_md: null
figma_spec: null
figma_screens: {}
operator_prep: ./docs/operator/zalaczniki-w-skrzynce-przygotowanie.md
---

# feat: Załączniki w Skrzynce Team OS

## Przegląd

Skrzynka Team OS przenosi dziś wyłącznie tekst. Plik trzeba wysłać osobnym kanałem (Discord, Dysk),
przez co wątek nie wie o jego istnieniu, a archiwum go nie zawiera. Ten plan dokłada załączniki:
nadawca podaje ścieżki w komendzie skilla, hub przechowuje bajty, a odbiorca ściąga je świadomym
odhaczeniem checkboxa w Skrzynce.

Trzy rzeczy przesądzają kształt rozwiązania i wynikają z mapy istniejącego kodu, nie z preferencji:

1. **Blok między markerami `%% inbox:items:* %%` jest nadpisywany w CAŁOŚCI przy każdym pullu**
   (`inbox-pull.mjs:298` `updateSkrzynkaFile`), a `inbox-push.mjs` **nigdy nie zapisuje `Skrzynka.md`**.
   Stan pobrania nie może więc być zapisany w pliku — musi być **wyliczany przez render z obecności pliku
   na dysku**. Każdy inny zapis zdmuchnie najbliższy sync.
2. **Parser milczy przy nieznanej etykiecie** (`parseCheckedCallouts` robi `continue` bez logu), więc
   odhaczone `- [x] Pobierz` dziś przepada bez śladu. Pobranie musi wykonać się **w tym samym procesie,
   między push a pull**, zanim render zdmuchnie zaznaczenie.
3. **Marker `%% id:<uuid> thread:<uuid> %%` identyfikuje wyłącznie kotwicę wątku**, a załączników bywa
   wiele w jednej wiadomości i wiele wiadomości w wątku. Wiersz załącznika musi nieść **własny
   identyfikator**, inaczej nie da się rozstrzygnąć, który plik odhaczono.

## Ujęcie problemu

Zob. źródło: `docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md`. Cztery osoby, wymiana
w obie strony, najczęstsze przypadki to dokument do walidacji, zrzut ekranu z błędem, kreacja graficzna
i wycinek techniczny. Materiały produkcyjne (nagrania, surówki) świadomie zostają na Dysku.

## Śledzenie wymagań

Numeracja z dokumentu źródłowego. **R12 zostało wycofane** decyzją operatora 2026-09-03 (zob. checklist)
— nie ma żadnych kwot ani sufitów miejsca; nie implementuj licznika bajtów per członek.

- **R1.** Załączniki w nowej wiadomości i w odpowiedzi; wiele plików w jednej wiadomości.
- **R2.** Wiadomość powstaje tylko gdy wszystkie jej pliki dotarły na hub.
- **R3.** Plik > 25 MB odrzucany **przed** transferem, komunikatem kierującym na Dysk. Próg mierzy
  **wyłącznie pojedynczy plik** — brak limitu sumy wiadomości (doprecyzowanie 2026-09-03).
- **R4.** Powtórzone wysłanie tego samego pliku nie duplikuje bajtów na hubie.
- **R5.** Skrzynka pokazuje nazwę, rozmiar i typ bez pobierania; sync zostaje tekstowy.
- **R6.** Pobranie przez odhaczenie checkboxa, wykonywane przy najbliższym syncu.
- **R7.** Pobrany plik ląduje w `Zasoby/inbox-zalaczniki/RRRR-MM/`, ma natywny podgląd i wchodzi do archiwum.
- **R8.** Po pobraniu render pokazuje osadzony plik zamiast checkboxa; regeneracja nie kasuje plików
  ani nie cofa stanu.
- **R9.** Odhaczenie pobrania jest **akcją lokalną** — nie zgłasza nic hubowi i nie domyka wątku.
- **R10.** Maszyna w roli agenta nie pobiera nigdy.
- **R11.** Bajty kasowane **14 dni po domknięciu wątku** oraz twardo **90 dni od wysłania**, niezależnie
  od statusu wątku (doprecyzowanie 2026-09-03). Kopia u odbiorcy zostaje na stałe.
- **R13.** Odwołanie dostępu członkowi usuwa jego załączniki i wiadomości, bez osieroconych bajtów.
- **R14.** Nazwa pliku od nadawcy to niezaufane wejście — nie może wyznaczać miejsca zapisu.

## Granice scope'u

- Powiadomienia o nowej wiadomości — poza zakresem.
- Integracja z Dyskiem Google — poza zakresem; przy pliku ponad próg tylko odmowa z komunikatem.
- Podgląd (miniatura) przed pobraniem — poza zakresem; Skrzynka pokazuje metadane.
- Edycja i wersjonowanie załączników — poza zakresem; plik jest niezmienny.
- Panel załączników w dashboardzie webowym — poza zakresem.
- **Kwoty i sufity miejsca na hubie — poza zakresem** (R12 wycofane).

## Kontekst i research

### Relevantny kod i wzorce

- `scripts/inbox/inbox-pull.mjs` — `renderThreadCallout` (81), `checkboxLabel` (96), separator
  `<!--os-thread-sep-->` (113), marker w linii 116, `updateSkrzynkaFile` (298), `writeIfChanged` (331).
  Render emituje gołe `>` jako puste linie, przez co jeden callout rozpada się na kilka bloków parsera —
  checkbox i marker trzymają się razem tylko dlatego, że **sąsiadują**.
- `scripts/inbox/inbox-push.mjs` — `extractInboxSection` (19), `parseCheckedCallouts` (28): blokowanie po
  prefiksie `'> '`, regex markera `%%\s*id:([a-f0-9-]{36})\s+thread:([a-f0-9-]{36})\s*%%`, regex checkboxa
  `^> - \[x\] (Zrobione|Zapoznane)` (kotwiczony, dopasowuje prefiks — span `os-hint` mu nie przeszkadza).
- `lib/inbox-db.js` — `getInboxDb` (43) z kompletem pragm (WAL, foreign_keys, **busy_timeout 5000**),
  `migrate` (69), `parseRow`/`serializePayload` (201/206) jako **jedyna** granica JSON, `sendMessage` (262),
  `resolveRecipient` (232), `pullForUser` (289), `markDone` (349, świeży odczyt przed decyzją),
  `claimQuery` (392, atomowy `UPDATE … RETURNING`), `revokeMember` (466 — **gołe `DELETE` bez kaskady**),
  `assertInboxDbReturnsNumbers` (186, smoke-test BigInt).
- `lib/inbox-api.js` — `ENDPOINT_METHODS` (46), `matchInboxToken` (59, regex dwusegmentowy),
  `handleInboxRequest` (202) z kolejnością bramek: cap → token (`timingSafeEqualStr`, pętla **bez `break`**)
  → rate limit → akcja → metoda → JSON → dispatch. `rateBuckets` (68) — Map in-memory, klucz = token.
- `server.js` — kontrakt kolejności matcherów (856–864), `handleInbox` (815) z `readTextBody`
  (732, `req.setEncoding('utf8')` → chunki są **stringami**), `serveStatic` (105) z jedynym w repo guardem
  traversal (porównanie prefiksowe `startsWith`) i jedynym kontaktem z Bufferem (`fs.readFile` bez enkodowania).
- `scripts/inbox/inbox-client.mjs` — `REQUEST_TIMEOUT_MS = 15_000` (20), `MAX_ATTEMPTS = 2` (24),
  retry tylko dla idempotentnych, `send()` z `retry: false` (217), `assertVersion` (56), `redactToken` (132).
- `lib/db.js` `deleteOldRoutineRuns` (363) + `lib/scheduler.js` `startRetention` (643) — jedyny wzorzec
  retencji w repo, do naśladowania kształtem (cutoff liczony w JS, `setInterval`, błąd łapany i logowany).
- `scripts/inbox/env-loader.mjs` — `loadEnv` (71) ustawia `INBOX_SKRZYNKA_PATH` i `INBOX_ARCHIVE_DIR`;
  **mutuje `process.env`** (konsumenci robią snapshot/restore).

### Wiedza instytucjonalna

- `docs/solutions/auth-issues/2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-…` — `cwd` spawnu agenta
  jest granicą bezpieczeństwa. **Katalog bajtów na hubie nigdy w drzewie vaulta**; nazwę od nadawcy
  weryfikuj **po `path.resolve`**, nie wzorcem — sprawdzaj efekt, nie kształt.
- `docs/solutions/runtime-errors/2026-08-05-migracja-fail-fast-w-getdb-blokuje-wlasne-lekarstwo.md` —
  `migrate()` biegnie przy KAŻDEJ operacji; `throw` na stanie danych zabija też endpointy naprawcze.
  Fail-fast wolno tylko na schemacie; stan danych → degradacja + `warn`.
- `docs/solutions/runtime-errors/2026-08-07-brak-busy-timeout-crash-na-database-is-locked.md` — druga
  krawędź tego wniosku: **nie trzymaj transakcji SQLite przez czas transferu**. 17 s zajętej blokady
  wypycha innych pisarzy poza `busy_timeout` i zwraca `database is locked` jako błąd, nie jako czekanie.
- `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md` — `SUM(size_bytes)`
  i liczniki referencji to kandydaci na ciche BigInt; obejmij je smoke-testem albo rzutuj na granicy.
- `docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md` —
  decyzje podejmuj na świeżym odczycie; jedna definicja progu w jednym helperze; **test szwu** klient+hub.
- `docs/solutions/runtime-errors/2026-07-30-prog-detekcji-snu-rowny-okresowi-heartbeatu.md` — próg liczony
  jako „zmierzony czas + definicja zdarzenia + granulacja", nigdy równy pomiarowi; przy retencji dobowej
  granulacja 0–24 h wchodzi do progu.
- `docs/solutions/auth-issues/2026-07-24-cors-acao-wildcard-wyciek-tokenu-guard-xff-nie-chroni.md` —
  guard XFF i CORS są ortogonalne; endpoint zwracający cudzą treść wymaga obu, gdyby kiedyś trafił
  na stronę prywatną.

### Referencje zewnętrzne

Pominięte świadomie — projekt jest czystym Node bez frameworka, a wszystkie ryzykowne miejsca
(cap ciała, traversal, timingSafeEqual, streaming) mają mocne wzorce lokalne w `ask.js` i `inbox-api.js`.

## Kluczowe decyzje techniczne

- **Bajty adresowane treścią, metadane w SQLite**: blob leży w `data/inbox-blobs/<aa>/<sha256>`
  (shardowanie po dwóch pierwszych znakach), a `inbox_attachments` trzyma metadane. Dedup z R4 wychodzi
  za darmo — ten sam plik to ta sama ścieżka. `data/` jest w `.gitignore` w całości i **poza drzewem vaulta**,
  więc spełnia granicę z wniosku o `cwd` agenta.
- **Upload dwufazowy: najpierw bajty, potem wiadomość.** `PUT …/blob/:sha256` jest **idempotentny**
  (klucz = treść), więc wolno go retryować — to rozwiązuje konflikt „17 s transferu przy 15 s timeoutu",
  którego nie da się rozwiązać przez sam wyższy timeout. Dopiero `send` z listą `attachments` materializuje
  wiadomość, weryfikując że każdy blob istnieje — stąd atomowość R2 bierze się z konstrukcji, nie z transakcji
  rozciągniętej na transfer.
- **Hash weryfikowany po stronie huba.** `sha256` z URL-a to deklaracja nadawcy; hub liczy sumę
  ze strumienia i odrzuca rozjazd. Bez tego nadawca podstawiłby dowolną treść pod cudzy hash.
- **Osobny timeout i osobny kubeł rate-limitu dla operacji binarnych.** `BINARY_TIMEOUT_MS = 180_000`
  (zmierzone 17 s × ~10 zapasu na słabe łącze — próg liczony od najgorszego przypadku, nie od pomiaru).
  Kubeł binarny jest osobny, bo wspólny licznik 60/min pozwoliłby transferowi wygłodzić własny sync nadawcy.
- **Stan pobrania wyłącznie z dysku, wyliczany w renderze.** Zero nowych pól i zero zapisów do Skrzynki
  spoza `inbox-pull` — jedyne rozwiązanie zgodne z tym, że blok jest nadpisywany co minutę (R8).
- **Wiersz załącznika niesie własny marker `%% att:<uuid> %%`** i jest samodzielny — nie zależy od
  blokowania parsera ani od markera kotwicy. Dzięki temu renderuje się przy swojej wiadomości (R5),
  a parser pobrań jest prostym przebiegiem po liniach.
- **Osobny parser dla „Pobierz", nie rozszerzenie `parseCheckedCallouts`.** Rozszerzenie alternatywy
  `(Zrobione|Zapoznane)` wpuściłoby akcję lokalną do ścieżki `client.done()` — hub odrzuciłby ją jako
  `invalid_action`, czyli błąd przy każdym syncu. Osobna funkcja czyni R9 niemożliwym do złamania
  konstrukcyjnie, a istniejący test roundtrip zostaje nietknięty.
- **Pobranie w `inbox-sync.mjs` między push a pull**, w jednym procesie. Ta sama przesłanka, dla której
  push→pull żyją razem: między krokami nie może być okna, w którym render zdmuchnie akcję usera.
- **Retencja jako przemiatanie in-process na hubie**, wzorowane na `startRetention` w schedulerze,
  uruchamiane z `server.js` pod guardem `isInboxHub()`. Świadomie NIE jako script-job: drugi proces
  otwierałby drugie połączenie do `inbox.db` w trakcie transferów.
- **Blob kasowany dopiero gdy nie odwołuje się do niego żaden wiersz** — konsekwencja dedupu.

## Otwarte pytania

### Rozwiązane podczas planowania

- **Jak pogodzić 17 s transferu z 15 s timeoutu klienta?** Idempotentny upload adresowany treścią +
  osobny timeout binarny. Sam wyższy timeout nie wystarcza, bo bez klucza dedup retry po timeoucie
  ma nieznany wynik (wniosek stojący za `retry: false` w `send`).
- **Gdzie żyje stan pobrania?** Na dysku, wyliczany w renderze. Wymuszone przez nadpisywanie bloku.
- **Jak odróżnić akcję lokalną od zgłaszanej hubowi?** Osobna funkcja parsująca i osobny marker
  `%% att: %%` — rozdział konstrukcyjny, nie umowny.
- **Który identyfikator niesie wiersz załącznika?** Własny `uuid` rekordu, bo marker kotwicy nie
  rozróżnia ani wiadomości w wątku, ani plików w wiadomości.
- **Jak render zachowa się po skasowaniu bajtów (R5)?** Trzeci stan wiersza: metadane + adnotacja
  „wygasł", bez checkboxa. Po wprowadzeniu twardego limitu 90 dni to ścieżka normalna.

### Odroczone do implementacji

- Dokładny kształt rozszerzenia `matchInboxToken` o trzeci segment — regex jest granicą bezpieczeństwa,
  więc kształt rozstrzygnie się przy pisaniu testów intruza, nie tutaj.
- Czy `streamBodyToFile` da się złożyć z `stream/promises.pipeline`, czy potrzeba ręcznej obsługi
  eventów jak w `readTextBody` — zależy od zachowania `req.pause()` przy przekroczeniu limitu.
- Format wiersza metadanych (kolejność nazwa/rozmiar/typ, ikona, klasy `os-*`) — dopracowanie wizualne
  po zobaczeniu pierwszego renderu w Obsidianie.
- Czy `SUM(size_bytes)` w ogóle będzie potrzebne po wycofaniu R12 (prawdopodobnie tylko do logu retencji).

## Wymagania wstępne operatora

**Brak — autopilot może startować od razu.** Wszystkie pozycje `[blokuje: planowanie]` w
`docs/operator/zalaczniki-w-skrzynce-przygotowanie.md` są odhaczone, a weryfikacje środowiska wykonane
2026-09-03 (wpis w `.gitignore` vaulta, pomiar 25 MB przez Funnel, dysk huba). Pozycje pozostające otwarte
w tym dokumencie są **po implementacji** (wydanie skilla `deleguj`, snippet `skrzynka.css`, aktualizacja
pluginu u zespołu, wykluczenie katalogu z Obsidian Sync) — trafiają do smoke'u operatora, nie blokują żadnej fazy.

Projekt nie ma harnessu E2E (`.env.e2e` nie istnieje, brak warstwy webowej dla tego feature'a) — weryfikacja
idzie przez `node:test` i smoke operatora. Żaden scenariusz nie jest oznaczony `[E2E]`.

## Implementation Units

### Faza 1 — Magazyn bajtów na hubie

**Zależy od:** Brak

- [x] **IU-1: Schemat i warstwa danych załączników**

**Cel:** Tabela metadanych załączników w `data/inbox.db` plus operacje odczytu i zapisu w jedynej warstwie,
która dotyka bazy skrzynki.

**Wymagania:** R2, R4, R5

**Zależności:** Brak

**Pliki:**
- Modyfikuj: `lib/inbox-db.js`
- Test (unit): `lib/inbox-db.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Nowa tabela `inbox_attachments`: `id TEXT PRIMARY KEY`, `message_id TEXT NOT NULL REFERENCES inbox(id)`,
  `filename TEXT NOT NULL`, `size_bytes INTEGER NOT NULL`, `mime TEXT`, `sha256 TEXT NOT NULL`,
  `created_at TEXT NOT NULL`, plus indeksy po `message_id` i po `sha256`.
- `CREATE TABLE IF NOT EXISTS` w `migrate()` — idempotentne z natury, **bez `ALTER TABLE` i bez backfillu**.
  Gdyby backfill okazał się potrzebny, obowiązuje sentinel w `state` (`migrate()` leci przy każdej operacji).
- **Żaden nowy `throw` w `migrate()` na stanie danych.** `migrate()` biegnie w leniwym `getInboxDb()` przy
  KAŻDEJ operacji, więc rzut na stanie (osierocone rekordy, rozjazd metadanych z dyskiem) zabiłby też
  endpointy naprawcze — degraduj i `warn` z wykonywalnym komunikatem.
- Funkcje: `addAttachments(db, messageId, items)` (wołane w transakcji `sendMessage`),
  `getAttachmentsForMessages(ids)`, `getAttachmentById(id)`, `countBlobRefs(sha256)`.
- `countBlobRefs` zwraca `COUNT(*)` — **rzutuj na `Number` na granicy warstwy**; agregaty node:sqlite
  bywają BigInt, a `bigint === 0` z `number` cicho fałszuje.
- Metadane wchodzą do `parseRow` tą samą drogą co reszta — payload zostaje jedyną granicą JSON.

**Wzorce do naśladowania:**
- `migrate()` (`lib/inbox-db.js:69`) — kształt DDL i indeksów.
- `assertInboxDbReturnsNumbers` (186) — rozszerz o nowy agregat.
- `tryRebuildMembersWithNocase` (103) — wzorzec degradacji zamiast rzutu.

**Scenariusze testowe:**
- [Unit] `migrate()` na świeżej bazie tworzy `inbox_attachments`; drugi przebieg nie rzuca.
- [Unit] `addAttachments` zapisuje wiele rekordów dla jednej wiadomości i odczytuje je w kolejności wstawienia.
- [Unit] `countBlobRefs` zwraca `number`, nie BigInt, i liczy poprawnie przy dwóch rekordach o tym samym `sha256`.
- [Unit] `getAttachmentsForMessages([])` zwraca pustą tablicę zamiast rzucać.

**Weryfikacja:**
- `node --test lib/inbox-db.test.js` przechodzi bez błędów.

---

- [x] **IU-2: Magazyn blobów na dysku huba**

**Cel:** Moduł zapisu i odczytu bajtów adresowanych treścią, poza drzewem vaulta, z deduplikacją.

**Wymagania:** R4, R14

**Zależności:** Brak

**Pliki:**
- Stwórz: `lib/inbox-blobs.js`
- Test (unit): `lib/inbox-blobs.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Katalog `data/inbox-blobs/<dwa pierwsze znaki sha256>/<sha256>`. **`data/` jest w `.gitignore` w całości
  i leży poza drzewem vaulta** — to granica bezpieczeństwa z wniosku o `cwd` agenta, nie preferencja układu.
- API: `blobPath(sha256)`, `hasBlob(sha256)`, `openBlobRead(sha256)`, `writeBlobFromStream(stream, expectedSha, maxBytes)`,
  `deleteBlob(sha256)`.
- `writeBlobFromStream` pisze do pliku tymczasowego, liczy `crypto.createHash('sha256')` **ze strumienia**,
  i dopiero po zgodności robi `rename` na docelową ścieżkę. Rozjazd hasha, przekroczenie `maxBytes`
  albo zerwanie strumienia → skasowanie pliku tymczasowego i błąd typowany.
- `sha256` z wejścia jest walidowany wzorcem `^[a-f0-9]{64}$` **zanim** trafi do `path.join` — hash
  jest jedynym elementem ścieżki pochodzącym z sieci.
- Zapis poza transakcją SQLite. Trzymanie transakcji przez 17 s transferu wypchnęłoby innych pisarzy
  poza `busy_timeout` i zwróciło `database is locked` jako błąd zamiast czekania.

**Notatka wykonawcza:** To pierwszy kod strumieniowy i pierwsze hashowanie w tym repo (w całym projekcie
nie ma dziś ani `createReadStream`, ani `createHash`) — napisz test na rozjazd hasha i na przekroczenie
limitu **przed** implementacją zapisu.

**Wzorce do naśladowania:**
- `lib/inbox-db.js:48` — `fs.mkdirSync(DATA_DIR, { recursive: true })`.
- `scripts/inbox/invite.mjs:146` — zapis pliku z jawnym trybem i `chmodSync` po fakcie.

**Scenariusze testowe:**
- [Unit] Zapis strumienia o znanej treści tworzy plik pod ścieżką wyprowadzoną z jego sha256.
- [Unit] Powtórzony zapis tej samej treści nie tworzy drugiego pliku (dedup R4).
- [Unit] Treść niezgodna z deklarowanym hashem → błąd, plik tymczasowy skasowany, plik docelowy nie powstaje.
- [Unit] Strumień przekraczający `maxBytes` → błąd, brak pliku tymczasowego.
- [Unit] `sha256` z `../` albo spoza `[a-f0-9]{64}` → błąd walidacji, `path.join` nigdy nie wołany.

**Weryfikacja:**
- `node --test lib/inbox-blobs.test.js` przechodzi bez błędów.

---

- [x] **IU-3: Endpointy binarne w API huba**

**Cel:** `PUT` i `GET` bajtów pod `/inbox/v1/:token/blob/:sha256`, z autoryzacją po uczestnictwie w wątku
i osobnym kubłem rate-limitu.

**Wymagania:** R4, R5, R6

**Zależności:** IU-1, IU-2

**Pliki:**
- Modyfikuj: `lib/inbox-api.js`
- Modyfikuj: `server.js`
- Test (unit): `lib/inbox-api.test.js`
- Test (unit): `server.inbox.http.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- `matchInboxToken` dostaje **opcjonalny trzeci segment** i zwraca `{token, action, param}`. Regex jest
  granicą bezpieczeństwa — nieznana wersja (`/inbox/v2/…`) nadal musi dawać `null`, a nadmiarowe segmenty
  nie mogą przechodzić.
- Nowe akcje w `ENDPOINT_METHODS`: `blob` z metodami `PUT` (zapis) i `GET` (odczyt).
- **Kolejność bramek bez zmian**: cap → token (`timingSafeEqualStr`, pętla bez `break`) → rate limit →
  akcja → metoda. Dla akcji binarnych cap 64 KB **nie obowiązuje** — limitem jest `MAX_ATTACHMENT_BYTES`
  egzekwowany w strumieniu.
- **Autoryzacja odczytu**: token musi należeć do członka będącego `from_user` albo `to_user` wiadomości,
  która odwołuje się do tego `sha256`. Sam hash nie jest uprawnieniem — wyciekły hash nie może dawać dostępu.
- **Osobny kubeł rate-limitu** dla operacji binarnych (klucz `token + ':blob'`), żeby transfer nie wygłodził
  własnego syncu nadawcy. Stan in-memory jak `rateBuckets` — świadomie zero agregatów SQL.
- W `server.js` `handleInbox` rozgałęzia się **przed** `readTextBody`: dla akcji binarnej idzie strumieniem,
  dla reszty bez zmian. Dwa nowe helpery: `streamBodyToFile` (z limitem i `req.destroy()` po flushu
  odpowiedzi — wzorzec 413 z `/ask`) oraz `streamFileToResponse` (`createReadStream` + `pipe`,
  `Content-Type`, `Content-Length`).
- Odpowiedzi błędne dla intruzów zostają gołymi kodami bez treści (403/404/405/413), zgodnie z kontraktem.

**Wzorce do naśladowania:**
- `handleInbox` (`server.js:815`) — kształt skorupy i obsługa 413.
- `readTextBody` (`server.js:732`) — obsługa `req.pause()`, listener `'error'`, idempotentne `finish`.
- `resolveMember` (`lib/inbox-api.js:101`) — porównanie w stałym czasie po wszystkich tokenach.

**Scenariusze testowe:**
- [Unit] `matchInboxToken('/inbox/v1/tok/blob/<64 hex>')` zwraca `{token, action:'blob', param}`.
- [Unit] `matchInboxToken('/inbox/v2/tok/blob/x')` zwraca `null`.
- [Unit] `PUT blob` z nieznanym tokenem → 403 bez treści.
- [Unit] `GET blob` tokenem członka niebędącego stroną wiadomości → 404 (nie 403 — nie zdradzamy istnienia).
- [Unit] Kubeł binarny wyczerpany nie blokuje `pull` tym samym tokenem.
- [Unit] `PUT` ciała większego niż `MAX_ATTACHMENT_BYTES` → 413, plik tymczasowy nie zostaje.
- [Unit] `PUT` treści o hashu innym niż w URL → 400, blob nie powstaje.
- [Unit] `PUT` blobu już istniejącego → 200 bez ponownego zapisu (R4).
- [Manual] Realny transfer 25 MB przez publiczny Funnel z maszyny spoza tailnetu kończy się 200
  (harness testowy chodzi po loopbacku i nie dowiedzie zachowania proxy).

**Weryfikacja:**
- `node --test lib/inbox-api.test.js` przechodzi bez błędów.
- `node --test server.inbox.http.test.js` przechodzi bez błędów.

#### Odchylenia — faza 1 (2026-09-03, zrealizowane)

Zmiany względem litery planu, przyjęte w implementacji fazy 1:

- **IU-1** — `addAttachments` waliduje kształt CAŁEJ partii przed pierwszym `INSERT`-em
  (sha256 = 64 hex, `filename` bez separatora ścieżki i NUL, `size_bytes` nieujemny integer,
  limity długości `filename`/`mime`). Plan tej bramki nie wymieniał, ale sha256 jest kluczem
  ścieżki blobu w IU-2 — bez walidacji tutaj zapis bajtów byłby podatny na path traversal,
  a R2 („wszystko albo nic") zależałoby od tego, czy wołający owinął operację transakcją.
- **IU-3** — `findAttachmentForUser(sha256, user)` dołożona do `lib/inbox-db.js` (poza listą `Pliki:`).
  Autoryzacja odczytu po uczestnictwie wymaga JOIN-a `inbox_attachments`↔`inbox`; budowanie SQL
  w `lib/inbox-api.js` złamałoby granicę modułów (API jest czystą funkcją NAD warstwą danych).
- **IU-2/IU-3** — `INBOX_BLOBS_DIR` (`data/inbox-blobs`) w `lib/config.js` z override
  `CLAUDE_CRON_INBOX_BLOBS_DIR` (lustro `CLAUDE_CRON_INBOX_DB_PATH`). Config jest jedynym źródłem
  stałych i ścieżek; bez override testy HTTP na żywym procesie pisałyby bajty do realnego
  `data/inbox-blobs` (in-process setter nie sięga spawnowanego dziecka).
- **IU-3** — `handleInbox(req, res, match)` zamiast `(req, res, token, action)`: potrzebny trzeci
  segment URL-a i rozgałęzienie binarne przed `readTextBody`.
- **IU-3** — odmowy na ścieżce binarnej wysyłają `Connection: close`. Bez tego `req.destroy()`
  po odmowie zostawia klientowi z pulą połączeń (undici/fetch) martwy socket, a NASTĘPNE,
  poprawne żądanie pada twardym `fetch failed` (wykryte testem: 6,3 s i FAIL → 0,23 s i PASS).
- **IU-3** — trzy istniejące asercje `matchInboxToken` w `lib/inbox-api.test.js` zaktualizowane
  o `param: null`. To wymuszona planem zmiana KONTRAKTU, nie osłabienie: nadal `deepStrictEqual`
  na pełnym kształcie obiektu.
- Zero nowych zależności w całej fazie.

### Faza 2 — Wysyłka z załącznikami

**Zależy od:** Faza 1

- [ ] **IU-4: Klient huba — operacje binarne**

**Cel:** `uploadBlob` i `downloadBlob` w kliencie, z osobnym timeoutem i regułą retry właściwą dla operacji
idempotentnej.

**Wymagania:** R1, R6

**Zależności:** IU-3

**Pliki:**
- Modyfikuj: `scripts/inbox/inbox-client.mjs`
- Test (unit): `scripts/inbox/inbox-client.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- `BINARY_TIMEOUT_MS = 180_000` jako **osobna stała** — `REQUEST_TIMEOUT_MS = 15_000` zostaje dla `pull`/`done`,
  bo jego ciasnota jest tam celowa. Próg liczony od najgorszego realnego łącza: zmierzone 17 s przez Funnel
  to jeden przebieg na łączu stacjonarnym, nie górna granica; przy 300 kB/s ten sam plik to ~87 s.
- `uploadBlob(sha256, filePath)` **retryuje** (w odróżnieniu od `send`), bo klucz deduplikacji jest treścią:
  powtórzenie po timeoucie trafia w istniejący blob i kończy się sukcesem bez skutków ubocznych.
- `downloadBlob(sha256, destPath)` zapisuje strumieniem do pliku tymczasowego i robi `rename` po sukcesie —
  przerwany transfer nie zostawia w vaulcie pliku wyglądającego na kompletny.
- `assertVersion` nie ma zastosowania do odpowiedzi binarnych; dla nich kontraktem jest status i długość.
- Redakcja tokenu w komunikatach błędów obowiązuje bez zmian — token siedzi w ścieżce URL.

**Wzorce do naśladowania:**
- `fetchWithTimeout` (`inbox-client.mjs:68`) — `AbortController` + `clearTimeout` w `finally`.
- `attemptRequest` (85) — klasyfikacja awarii retryowalnych.
- `redactToken` (132) i `describeErrorBody` (144).

**Scenariusze testowe:**
- [Unit] `uploadBlob` po jednym `AbortError` ponawia i kończy sukcesem.
- [Unit] `uploadBlob` używa `BINARY_TIMEOUT_MS`, nie `REQUEST_TIMEOUT_MS`.
- [Unit] `downloadBlob` przy zerwaniu w połowie nie zostawia pliku docelowego.
- [Unit] Komunikat błędu z URL-em zawierającym token jest zredagowany.

**Weryfikacja:**
- `node --test scripts/inbox/inbox-client.test.mjs` przechodzi bez błędów.

---

- [ ] **IU-5: Wysyłka plików przez `send` i `reply`**

**Cel:** `--attach` w komendach nadawcy: walidacja progu przed transferem, upload bajtów, dopiero potem
utworzenie wiadomości.

**Wymagania:** R1, R2, R3, R4

**Zależności:** IU-4

**Pliki:**
- Stwórz: `scripts/inbox/attachments.mjs`
- Modyfikuj: `scripts/inbox/send.mjs`
- Modyfikuj: `scripts/inbox/reply.mjs`
- Modyfikuj: `scripts/inbox/args.mjs`
- Modyfikuj: `lib/inbox-api.js`
- Modyfikuj: `lib/inbox-db.js`
- Test (unit): `scripts/inbox/attachments.test.mjs`
- Test (unit): `scripts/inbox/send.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- `--attach <ścieżka>` **powtarzalne** (wiele plików = wiele flag). Świadomie nie lista rozdzielana
  separatorem: ścieżki zawierają spacje, a lekcja z `--content` mówi, że wszystko, co przechodzi przez
  parser linii poleceń PowerShella, potrafi się cicho rozpaść.
- `prepareAttachments(paths)` w nowym module: dla każdego pliku `stat` → **próg 25 MB sprawdzany PRZED
  jakimkolwiek transferem** (R3), z komunikatem kierującym wprost na Dysk → `sha256` z pliku → `uploadBlob`.
  Próg mierzy **wyłącznie pojedynczy plik**; nie ma limitu sumy wiadomości.
- Dopiero po udanym uploadzie **wszystkich** plików leci `send`/`reply` z polem `attachments:
  [{sha256, filename, size_bytes, mime}]`. Pad któregokolwiek uploadu → wiadomość nie powstaje (R2).
- Po stronie huba `handleSend` waliduje `attachments` na granicy (długość listy, wzorzec `sha256`, limity
  `filename` i `size_bytes`) i **weryfikuje istnienie każdego blobu na świeżo, tuż przed insertem** —
  między uploadem a `send` mija kilkanaście sekund, w których retencja albo rewokacja mogły zadziałać.
- Wstawienie wiadomości i rekordów załączników w **jednej, krótkiej transakcji** (wzorzec `markDone`,
  gałąź `replied`). Transfer jest już zakończony, więc transakcja nie trzyma blokady przez czas sieci.
- `mime` wyprowadzany z rozszerzenia po stronie klienta i traktowany jako podpowiedź do renderu,
  nigdy jako decyzja o zapisie.

**Teksty (verbatim):**
- Odmowa przy przekroczeniu progu: `Plik <nazwa> ma <rozmiar> i przekracza limit 25 MB. Wrzuć go na Dysk i wyślij link w treści wiadomości.`

**Wzorce do naśladowania:**
- `scripts/inbox/args.mjs` — istniejący parser flag i konwencja błędów.
- `handleSend` (`lib/inbox-api.js:157`) — walidacja pól na granicy, `from_user` **zawsze z tokenu**.
- `markDone` (`lib/inbox-db.js:366`) — kształt krótkiej transakcji `BEGIN`/`COMMIT`.

**Scenariusze testowe:**
- [Unit] Dwa `--attach` dają dwa rekordy w jednej wiadomości.
- [Unit] Plik 26 MB → odmowa **przed** wywołaniem `uploadBlob` (mock klienta nie dostaje żadnego żądania).
- [Unit] Pad uploadu drugiego pliku → `send` nie jest wołany w ogóle (R2).
- [Unit] Ten sam plik wysłany dwa razy → drugi upload trafia w istniejący blob, powstają dwa rekordy
  metadanych wskazujące jeden `sha256` (R4).
- [Unit] `handleSend` z `sha256` nieistniejącym na hubie → 400, wiadomość nie powstaje.
- [Unit] `handleSend` z `attachments` niebędącym tablicą albo z nadmiarową liczbą pozycji → 400.
- [Unit] Ścieżka do pliku, który nie istnieje → czytelny błąd przed transferem.

**Weryfikacja:**
- `node --test scripts/inbox/attachments.test.mjs scripts/inbox/send.test.mjs` przechodzi bez błędów.
- `node --test lib/inbox-api.test.js lib/inbox-db.test.js` przechodzi bez błędów (regresja fazy 1).

#### Odchylenia — faza 2 (2026-09-03, zrealizowane)

**Status:** wszystkie scenariusze testowe IU-4 i IU-5 napisane i przechodzą; obie pozycje
„Weryfikacja" fazy 2 wykonane (`node --test scripts/inbox/attachments.test.mjs scripts/inbox/send.test.mjs`
oraz `node --test lib/inbox-api.test.js lib/inbox-db.test.js` — bez błędów). Pełna suita: 1200/1201 PASS,
jedyny FAIL to flake infrastruktury workera na `server.inbox.http.test.js` (PASS 3/3 w izolacji).

Zmiany względem litery planu, przyjęte w implementacji fazy 2:

- **IU-4** — `uploadBlob` wysyła bajty jako `Buffer` (`readFile`), nie strumieniem. Retry musi wysłać
  DOKŁADNIE te same bajty, a zużytego strumienia nie da się odtworzyć; dodatkowo `Content-Length`
  pozwala hubowi odrzucić za duży plik przed transferem (`streamBodyToFile` sprawdza `content-length`).
  Plan wymagał strumienia wyłącznie dla `downloadBlob` — tam jest.
- **IU-4** — wspólny refaktor transportu: `fetchWithTimeout`/`attemptRequest` przyjmują gotowe
  `body`/`headers` oraz `timeoutMs` (default `REQUEST_TIMEOUT_MS`); wydzielone `runWithRetry`
  i `actionUrl`. Zachowanie ścieżki tekstowej bez zmian.
- **IU-4** — redakcja tokenu rozszerzona na komunikat „błąd sieci" (`describeFetchFailure`).
  Wcześniej `err.message` z undici (pełny URL z tokenem w ścieżce) szedł surowy do komunikatu —
  domknięcie istniejącej dziury w tym samym module.
- **IU-5** — `handleSend` wymaga nie tylko istnienia blobu (`blobs.hasBlob`), ale też śladu wgrania
  tych bajtów PRZEZ TEGO nadawcę (`inboxDb.isBlobUploader`). To lustro `findAttachmentForUser`
  z fazy 1: bez tego znajomość cudzego hasha pozwalałaby podpiąć cudzy plik pod własną wiadomość.
  Kod błędu: `400 unknown_attachment`.
- **IU-5** — `MAX_ATTACHMENTS_PER_MESSAGE = 10` na granicy API. To nie kwota miejsca (te wycofano),
  tylko limit kształtu inputu: bez niego jedno żądanie 64 KB każe hubowi zrobić tysiące odczytów
  dysku przed insertem.
- **IU-5** — magazyn blobów wstrzykiwany do `handleInboxRequest` jako opcja `blobs`
  (default `lib/inbox-blobs`), wzorzec istniejącego wstrzykiwania `inboxDb`; `server.js` bez zmian.
- **IU-5** — `sendMessage` zwraca teraz ZAWSZE pole `attachments` (pusta tablica przy braku) —
  spójny kształt zamiast pola warunkowego.
- **IU-5** — `reply.mjs` nadal wymaga `--content`; wiadomość „sam plik bez treści" byłaby zmianą
  kontraktu komendy, poza zakresem IU.
- Zero nowych zależności w całej fazie.

### Faza 3 — Odbiór: render, odhaczenie, zapis do vaulta

**Zależy od:** Faza 2

- [ ] **IU-6: Render załączników w Skrzynce — trzy stany**

**Cel:** Wiersz załącznika przy wiadomości, w jednym z trzech stanów, wyliczany bezstanowo przy każdym pullu.

**Wymagania:** R5, R7, R8

**Zależności:** IU-1

**Pliki:**
- Modyfikuj: `scripts/inbox/inbox-pull.mjs`
- Test (unit): `scripts/inbox/inbox-pull.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Wiersz renderowany **przy swojej wiadomości** (R5), w `renderMessage`, jako samodzielna linia niosąca
  własny marker: `> - [ ] Pobierz — <nazwa> · <rozmiar> · <typ> %% att:<uuid> %%`.
- Marker musi być **samodzielny**, bo istniejący `%% id:<uuid> thread:<uuid> %%` identyfikuje wyłącznie
  kotwicę wątku, a nie rozróżnia ani wiadomości w wątku, ani plików w wiadomości.
- **Trzy stany, rozstrzygane wyłącznie odczytem dysku i metadanych:**
  1. plik istnieje w `Zasoby/inbox-zalaczniki/RRRR-MM/` → osadzenie `> ![[<ścieżka>]]`, **bez checkboxa** (R8);
  2. bajty dostępne na hubie → checkbox `- [ ] Pobierz` z metadanymi;
  3. bajty wygasły (metadane bez blobu) → wiersz z adnotacją, **bez checkboxa** — po twardym limicie 90 dni
     to ścieżka normalna, nie przypadek brzegowy.
- **Zero zapisu stanu gdziekolwiek.** Blok między markerami jest nadpisywany w całości co minutę, więc
  wszystko, co nie wynika z dysku albo z odpowiedzi huba, zostanie zdmuchnięte.
- Nowe klasy `os-att`, `os-att-gone` w spanach — trafiają do snippetu `skrzynka.css` w pluginie zespołowym
  (pozycja w checkliście operatora).
- **Uważaj na `writeIfChanged`**: render zależny od `Date.now()` generuje zapis co minutę. Wiersz załącznika
  nie może nieść nic zmiennego w czasie, inaczej dołoży zapisów i ryzyka konfliktu.

**Wzorce do naśladowania:**
- `renderMessage` (`inbox-pull.mjs:61`) i `renderThreadCallout` (81) — konwencja spanów i prefiksów `> `.
- `checkboxLabel` (96) — jedyne miejsce rozstrzygania etykiety.

**Scenariusze testowe:**
- [Unit] Wiadomość z jednym załącznikiem, plik nieobecny na dysku → linia `- [ ] Pobierz` z markerem `att:`.
- [Unit] Ten sam wejściowy zestaw, plik obecny na dysku → osadzenie `![[…]]`, **brak** linii `Pobierz`.
- [Unit] Metadane bez blobu na hubie → wiersz z adnotacją o wygaśnięciu, brak checkboxa.
- [Unit] Dwa załączniki w jednej wiadomości → dwie linie o różnych markerach `att:`.
- [Unit] Wiersz załącznika **nie** zawiera niczego zależnego od `Date.now()` (dwa renderowania w odstępie
  czasu dają identyczny string).
- [Unit] Istniejący test roundtrip „Zrobione" nadal przechodzi bez zmian.

**Weryfikacja:**
- `node --test scripts/inbox/inbox-pull.test.mjs` przechodzi bez błędów.

---

- [ ] **IU-7: Parser odhaczonych pobrań — akcja wyłącznie lokalna**

**Cel:** Rozpoznanie `- [x] Pobierz` jako żądania pobrania, konstrukcyjnie odciętego od ścieżki zgłaszania
do huba.

**Wymagania:** R6, R9

**Zależności:** IU-6

**Pliki:**
- Modyfikuj: `scripts/inbox/inbox-push.mjs`
- Test (unit): `scripts/inbox/inbox-push.test.mjs`
- Test (unit): `scripts/inbox/inbox-pull.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- **Osobna funkcja `parseRequestedDownloads(section)`**, nie rozszerzenie alternatywy w
  `parseCheckedCallouts`. Dopisanie `Pobierz` do `(Zrobione|Zapoznane)` wpuściłoby akcję lokalną do
  `client.done()`, a hub odrzuciłby ją jako `invalid_action` — błąd przy każdym syncu. Rozdział funkcji
  czyni R9 niemożliwym do złamania konstrukcyjnie.
- Parser jest przebiegiem po liniach, nie po blokach: marker `%% att:<uuid> %%` jest samodzielny, więc
  nie zależy od kruchego blokowania po prefiksie `'> '` (render emituje gołe `>`, które rozbijają callout
  na fragmenty).
- `parseCheckedCallouts` zostaje **nietknięte** — jego regex nie matchuje `Pobierz`, a regex markera
  nie matchuje `att:`. Brak interferencji ma być udowodniony testem, nie założony.

**Notatka wykonawcza:** Kontrakt render↔parser jest najbardziej kruchym miejscem systemu i jedynym
z testem szwu. Napisz nowy test roundtrip (render → odhaczenie → parse) **przed** implementacją parsera.

**Wzorce do naśladowania:**
- `parseCheckedCallouts` (`inbox-push.mjs:28`) — kotwiczenie `^` z flagą `m` i dopasowanie prefiksu.
- Test roundtrip (`inbox-pull.test.mjs:69`) — kształt testu szwu.

**Scenariusze testowe:**
- [Unit] Roundtrip: wyrenderowany wiersz z podmienionym `[ ]` na `[x]` parsuje się na `{attachment_id}`.
- [Unit] `parseCheckedCallouts` na tej samej sekcji **nie** zwraca niczego dla wiersza `Pobierz` (R9).
- [Unit] Sekcja z odhaczonym „Zrobione" i odhaczonym „Pobierz" → jedna akcja hubowa i jedno pobranie,
  bez wzajemnego mieszania.
- [Unit] Nieodhaczony wiersz `Pobierz` nie generuje żądania.
- [Unit] Uszkodzony marker (`%% att: %%` bez uuid) jest pomijany bez rzutu.

**Weryfikacja:**
- `node --test scripts/inbox/inbox-push.test.mjs scripts/inbox/inbox-pull.test.mjs` przechodzi bez błędów.

---

- [ ] **IU-8: Pobranie do vaulta i wpięcie w sync**

**Cel:** Wykonanie pobrania między push a pull, zapis pod bezpieczną nazwą w `Zasoby/inbox-zalaczniki/RRRR-MM/`,
oraz twarde odcięcie maszyny w roli agenta.

**Wymagania:** R6, R7, R10, R14

**Zależności:** IU-4, IU-7

**Pliki:**
- Modyfikuj: `scripts/inbox/attachments.mjs`
- Modyfikuj: `scripts/inbox/inbox-sync.mjs`
- Modyfikuj: `scripts/inbox/env-loader.mjs`
- Test (unit): `scripts/inbox/attachments.test.mjs`
- Test (unit): `scripts/inbox/inbox-sync.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- `inbox-sync.mjs` staje się **push → pobrania → pull**, w jednym procesie. Ta sama przesłanka, dla której
  push i pull już tam mieszkają razem: między krokami nie może być okna, w którym render zdmuchnie akcję usera.
- `env-loader.loadEnv()` ustawia nowe `INBOX_ATTACHMENTS_DIR` = `<workspace>/Zasoby/inbox-zalaczniki`,
  wyprowadzane tak samo jak `INBOX_ARCHIVE_DIR` (z `INBOX_SKRZYNKA_PATH`), zawsze i tylko gdy nie ma go w env.
- **Sanityzacja nazwy (R14) sprawdza EFEKT, nie kształt**: `path.basename` → usunięcie znaków kontrolnych
  i separatorów → odrzucenie `.`/`..`/nazwy pustej → złożenie ścieżki → **`path.resolve` i weryfikacja, że
  wynik nadal leży pod katalogiem docelowym**. Walidacja samym wzorcem jest niewystarczająca — to ten sam
  wniosek, dla którego guard `.gitignore` pyta gita o efekt zamiast czytać plik.
- Kolizja nazw: gdy plik o tej nazwie istnieje i ma **inną** treść, dopisz sufiks porządkowy; gdy ma tę samą
  treść (`sha256` się zgadza), potraktuj jako pobrany i nic nie rób (idempotencja).
- Zapis przez plik tymczasowy i `rename` — przerwane pobranie nie zostawia w vaulcie pliku wyglądającego
  na kompletny, co jest istotne, bo **obecność pliku JEST stanem pobrania**.
- **R10 dwiema warstwami**: (1) job syncu z natury nie istnieje na maszynie w roli `agent`
  (`inbox-seed.js` rozdziela joby po `state.inbox_role`); (2) mimo to krok pobrań sprawdza rolę jawnie
  i kończy się no-opem — obrona w głąb, bo rola bywa ustawiana ręcznie.
- Pobranie **niczego nie zgłasza hubowi** (R9): brak `client.done()`, brak zmiany statusu, brak archiwum.

**Wzorce do naśladowania:**
- `inbox-sync.mjs` — istniejąca sekwencja i obsługa błędów kroków.
- `close.test.mjs` — testowanie szwu hub↔plik w jednym przebiegu, z prawdziwym zapisem.
- `inbox-pull.main.test.mjs:23` `setupVault(t)` — tymczasowy vault, snapshot i restore env.

**Scenariusze testowe:**
- [Unit] Odhaczony załącznik → plik ląduje w `Zasoby/inbox-zalaczniki/RRRR-MM/` pod sanityzowaną nazwą.
- [Unit] Nazwa `../../../etc/passwd` → zapis wewnątrz katalogu docelowego albo odmowa; **nigdy** poza nim.
- [Unit] Nazwa z separatorem, znakiem kontrolnym i sama `..` → każda odrzucona lub sprowadzona do basename.
- [Unit] Powtórne pobranie tego samego pliku (ta sama treść) → brak drugiego pliku, brak błędu.
- [Unit] Kolizja nazw przy różnej treści → drugi plik z sufiksem, pierwszy nietknięty.
- [Unit] Przerwane pobranie → brak pliku docelowego, stan pobrania nadal „niepobrany".
- [Unit] `state.inbox_role === 'agent'` → krok pobrań jest no-opem mimo odhaczonych checkboxów (R10).
- [Unit] Pobranie nie woła `client.done()` ani niczego zmieniającego status (R9) — mock klienta odnotowuje zero wywołań.
- [Unit] Sekwencja syncu: pobranie następuje **po** pushu i **przed** pullem.

**Weryfikacja:**
- `node --test scripts/inbox/attachments.test.mjs scripts/inbox/inbox-sync.test.mjs` przechodzi bez błędów.
- `node --test` (pełna suita) przechodzi bez błędów.

### Faza 4 — Retencja, sprzątanie i rewokacja

**Zależy od:** Faza 3

- [ ] **IU-9: Retencja bajtów na hubie**

**Cel:** Kasowanie bajtów 14 dni po domknięciu wątku oraz twardo 90 dni od wysłania, z zachowaniem metadanych.

**Wymagania:** R11

**Zależności:** IU-1, IU-2

**Pliki:**
- Stwórz: `lib/inbox-retention.js`
- Modyfikuj: `server.js`
- Test (unit): `lib/inbox-retention.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- **Czysta funkcja `computeExpiredAttachments({now, rows, graceMs, hardTtlMs})`** — zero I/O, zero `Date.now()`
  w środku (wzorzec `computeMissedJobs`). Cała logika progów jest testowalna bez bazy i bez dysku.
- Dwa progi: `GRACE_AFTER_CLOSE_MS` = 14 dni od domknięcia wątku, `HARD_TTL_MS` = 90 dni od `created_at`.
  Po wycofaniu R12 retencja jest **jedynym** mechanizmem zwalniającym miejsce — twardy limit nie jest opcją.
- **Znikają wyłącznie bajty; rekord metadanych zostaje**, żeby wątek pozostał czytelny, a render mógł
  pokazać trzeci stan (R5).
- **Blob kasowany dopiero gdy `countBlobRefs(sha256)` osiągnie zero** — konsekwencja dedupu z R4.
- Przemiatanie **in-process na hubie**, uruchamiane z `server.js` pod guardem `isInboxHub()`, wzorowane na
  `startRetention` ze schedulera. Świadomie nie jako script-job: drugi proces otwierałby drugie połączenie
  do `inbox.db` w trakcie transferów.
- **Granulacja wchodzi do progu.** Przemiatanie raz na godzinę znaczy, że znacznik bywa przestarzały o 0–60 min;
  próg liczony jako „czas + definicja zdarzenia + granulacja", nigdy równy okresowi przemiatania.
- Sprzątanie **osieroconych blobów**: bajty wgrane, ale nigdy nieprzypisane do wiadomości (nadawca przerwał
  między uploadem a `send`). Kasuj dopiero po karencji liczonej w godzinach, nigdy natychmiast — trwający
  upload nie może zostać uznany za sierotę.

**Notatka wykonawcza:** Testy progów pisz z **jawnym jitterem** czasu, nie na okrągłych wartościach.
`t.mock.timers.tick(period)` daje odstęp dokładnie równy progowi — wartość w produkcji nieosiągalną, więc
test przechodzi przy złamanym zachowaniu.

**Wzorce do naśladowania:**
- `lib/db.js:363` `deleteOldRoutineRuns` — cutoff liczony w JS, nie w SQL.
- `lib/scheduler.js:643` `startRetention` — kształt pętli, łapanie i logowanie błędu.
- `computeMissedJobs` w schedulerze — czysta funkcja progowa z wstrzykiwanym czasem.

**Scenariusze testowe:**
- [Unit] Wątek domknięty 13 dni temu → bajty zostają; 15 dni temu → do skasowania.
- [Unit] Wątek otwarty, wysłany 89 dni temu → zostaje; 91 dni → do skasowania mimo otwartego wątku.
- [Unit] Odstęp **nieokrągły** względem progu (jawny jitter) daje ten sam werdykt co okrągły.
- [Unit] Dwa rekordy o tym samym `sha256`, jeden wygasły → blob **nie** jest kasowany.
- [Unit] Oba rekordy wygasłe → blob kasowany dokładnie raz.
- [Unit] Skasowanie bajtów zostawia rekord metadanych nietknięty.
- [Unit] Blob bez rekordu, młodszy niż karencja sierot → nie jest kasowany.
- [Unit] Przemiatanie przy braku czegokolwiek do skasowania nie rzuca i nie loguje błędu.

**Weryfikacja:**
- `node --test lib/inbox-retention.test.js` przechodzi bez błędów.

---

- [ ] **IU-10: Kaskada przy odwołaniu dostępu**

**Cel:** `revokeMember` usuwa wiadomości i załączniki członka, nie zostawiając osieroconych bajtów.

**Wymagania:** R13

**Zależności:** IU-9

**Pliki:**
- Modyfikuj: `lib/inbox-db.js`
- Test (unit): `lib/inbox-db.test.js`
- Test (unit): `server.inbox.http.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Dziś `revokeMember` (`lib/inbox-db.js:466`) to **gołe `DELETE FROM members`** — nie rusza `inbox` ani niczego
  innego. R13 wymaga kaskady: wiadomości członka, ich rekordy załączników oraz bajty, do których nie odwołuje
  się już nic innego.
- Wszystko w **jednej transakcji** dla części bazodanowej; kasowanie plików **po** udanym commicie.
  Odwrotna kolejność zostawia rekordy wskazujące na nieistniejące bajty przy padzie transakcji.
- Kasowanie plików nie może wywrócić operacji — pad `unlink` to `warn`, nie rzut. Bajt bez rekordu i tak
  zostanie sprzątnięty przez sprzątanie sierot z IU-9.
- **Uwaga na zasięg:** wiadomości członka bywają częścią wątków, w których uczestniczą inni. R13 mówi wprost
  „usuwa również jego załączniki i wiadomości" — implementuj literalnie, ale odnotuj w komentarzu, że
  domknięte wątki tracą wtedy część historii, a archiwum w vaultach pozostaje jedynym śladem.

**Wzorce do naśladowania:**
- `markDone` (`lib/inbox-db.js:366`) — kształt transakcji `BEGIN`/`COMMIT`.
- `tryRebuildMembersWithNocase` (103) — degradacja z `warn` zamiast rzutu przy operacji pobocznej.

**Scenariusze testowe:**
- [Unit] Rewokacja członka z dwiema wiadomościami i trzema załącznikami → zero rekordów po nim.
- [Unit] Blob współdzielony z wiadomością innego członka **nie** jest kasowany.
- [Unit] Blob wyłącznie jego → plik znika z dysku.
- [Unit] Pad kasowania pliku (brak uprawnień) → operacja kończy się sukcesem, rekordy skasowane, `warn` zalogowany.
- [Unit] Rewokacja nieistniejącego id → `false`, żadnych efektów ubocznych.
- [Unit] `DELETE /api/inbox/members/:id` przez API zwraca 200 i faktycznie kasuje dane.

**Weryfikacja:**
- `node --test lib/inbox-db.test.js server.inbox.http.test.js` przechodzi bez błędów.
- `node --test` (pełna suita) przechodzi bez błędów.

**Operator checklist:**
- [ ] Po wdrożeniu na hub: sprawdź, że `data/inbox-blobs/` powstało i ma właściciela `claude`.

## Wpływ systemowy

- **Graf interakcji:** `matchInboxToken` jest wspólnym wejściem dla wszystkich akcji skrzynki — zmiana jego
  regexu dotyka też `ping`/`pull`/`done`/`send`/`claim-query`. Kontrakt kolejności matcherów w `server.js`
  (webhook → ask → inbox → guard XFF → api/static) zostaje nienaruszony; endpointy binarne wchodzą **wewnątrz**
  gałęzi inbox, czyli przed guardem XFF, bo muszą działać przez Funnel.
- **Propagacja błędów:** kody intruzów pozostają gołymi statusami bez treści. Błąd zapisu bajtów jest błędem
  klienta (4xx) tylko wtedy, gdy wynika z jego danych (zły hash, przekroczony limit); awaria dysku to 5xx
  i podlega retry.
- **Ryzyka cyklu życia stanu:** trzy miejsca, w których stan może się rozjechać — blob bez rekordu (sierota
  po przerwanej wysyłce, sprzątany z karencją), rekord bez blobu (po retencji — **stan zamierzony**, render
  go pokazuje) oraz plik w vaulcie bez rekordu na hubie (po retencji — zamierzone, kopia odbiorcy zostaje na stałe).
- **Parytet surface API:** dashboard webowy świadomie nie dostaje niczego (poza scope'em). Skill `deleguj`
  w pluginie zespołowym wymaga aktualizacji, żeby nadawca w ogóle miał jak podać plik.
- **Pokrycie integracyjne:** dwa szwy, których testy jednostkowe obu stron nie dowiodą — klient↔hub przy
  przerwanym uploadzie (atomowość R2) oraz render↔parser przy trzecim checkboxie. Oba mają jawne testy szwu.

## Ryzyka i zależności

- **Kontrakt render↔parser to najkruchszy punkt systemu.** Ma dziś jeden test szwu i milczy przy nieznanej
  etykiecie. Mitygacja: osobny parser dla akcji lokalnej, nowy test roundtrip pisany przed implementacją,
  test dowodzący braku interferencji z istniejącą ścieżką.
- **Pierwszy kod strumieniowy i pierwsze hashowanie w repo.** Zero lokalnych wzorców — całe `createReadStream`,
  `createWriteStream` i `createHash` nie występują dziś nigdzie w kodzie Node. Ryzyko subtelnych błędów
  cyklu życia strumienia; mitygacja: testy na zerwanie i przekroczenie limitu przed implementacją.
- **`req.setEncoding('utf8')` w `readTextBody` czyni chunki stringami.** Ścieżka binarna **nie może** przejść
  przez ten helper — pomyłka uszkodziłaby bajty w sposób niewidoczny w małych testach.
- **Ryzyko rezydualne — załączniki są w zasięgu odczytu zadań Claude na maszynie odbiorcy.**
  `WORKSPACE_DIR` to vault, a `claude-spawn.js` odpala **każdy** job z `cwd` ustawionym na tę ścieżkę,
  włącznie z jobami karmionymi niezaufanym wejściem (webhooki, `/ask`). Wykluczenie katalogu z Obsidian Sync
  odcina maszynę-agenta, ale nie maszynę odbiorcy. To kompromis przyjęty wprost w wymaganiach (R7 wymaga
  pliku w vaulcie dla podglądu Obsidiana), a barierą pozostaje świadome odhaczenie przez człowieka.
- **Rozmiar transferu kontra rytm syncu.** Sync chodzi co minutę; pobranie 25 MB trwa ~13 s na dobrym łączu
  i wielokrotnie dłużej na słabym. Kolejny run może wystartować w trakcie — zabezpiecza to reguła schedulera
  „jeden run per `job_id`", ale warto to zweryfikować w smoke'u.

## Dokumentacja / Notatki operacyjne

- `CLAUDE.md` — sekcja Team OS wymaga dopisania warstwy załączników: magazyn blobów, dwufazowy upload,
  trzeci checkbox o semantyce lokalnej, retencja.
- `docs/CONCEPTS.md` — kandydaci na hasła: **Blob**, **Załącznik**, **Pobranie na żądanie**.
- Po wdrożeniu: cztery obszary bez siatki w bazie wiedzy (kontrakt roundtrip Skrzynki, rate limit i głodzenie
  klas operacji, cap ciała żądania, praca z binariami w Node) — każdy zasługuje na `/dev-compound`.
- Rollout: wydanie skilla `deleguj` i snippetu `skrzynka.css` w pluginie zespołowym oraz aktualizacja
  u czterech osób — zob. checklist operatora.

## Źródła i referencje

- **Dokument źródłowy:** [docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md](docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md)
- **Checklist operatora:** [docs/operator/zalaczniki-w-skrzynce-przygotowanie.md](docs/operator/zalaczniki-w-skrzynce-przygotowanie.md)
- Ziarno: `docs/ideation/2026-09-02-skrzynka-zalaczniki-powiadomienia-ideation.md`
- Kod: `lib/inbox-db.js`, `lib/inbox-api.js`, `server.js`, `scripts/inbox/inbox-pull.mjs`,
  `scripts/inbox/inbox-push.mjs`, `scripts/inbox/inbox-client.mjs`
