# Review fazy 3 — Odbiór: render, odhaczenie, zapis do vaulta

Data: 2026-09-03 · Zadanie: `zalaczniki-w-skrzynce` · Faza: 3

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi po verify (do naprawy) | 15 |
| P1 | 3 |
| P2 | 8 |
| P3 | 4 |
| OPERATOR | 0 |
| Obalone przez adversarial verify | 3 |
| Severity gate | **BLOKUJE** |
| Przebiegi E2E (PASS/FAIL/SKIP) | 0 / 0 / 0 (tester pominięty przez routing) |

Rozkład po źródłach: correctness 4, code-quality 3, security 4, test-coverage 2, performance 2, spec-compliance 1.

---

## Findingi P1 (blokujące)

### P1 · KOD · `lib/inbox-db.js:407`

Cała ścieżka odbioru z fazy 3 jest w produkcji martwa: `pullForUser` zwraca `{ user, active, threadRows, delegated }` z gołego `SELECT * FROM inbox`, a `handlePull` (lib/inbox-api.js:196) oddaje to bez zmian. Żaden wiersz nie niesie pola `attachments` ani `blob_available` — `getAttachmentsForMessages` (lib/inbox-db.js:585) nie jest wołane NIGDZIE poza testami. Tymczasem `renderAttachmentLines` (scripts/inbox/inbox-pull.mjs:128) filtruje `m.attachments`, a `renderAttachmentLine` czyta `att.blob_available`, `att.size_bytes`, `att.mime`; `indexAttachments` (scripts/inbox/attachments.mjs) też indeksuje `message.attachments`.

Efekt: w Skrzynce nigdy nie pojawi się ani jeden wiersz załącznika, checkbox „Pobierz" nigdy nie powstanie, `parseRequestedDownloads` zawsze zwróci pustą listę, a `downloadRequestedAttachments` zawsze zrobi wcześniejszy return — R5, R6, R7 i R8 są niespełnione mimo zielonej suity.

Suita jest zielona, bo obie atrapy huba (`fakeHub` w scripts/inbox/attachments.test.mjs i scripts/inbox/inbox-sync.test.mjs) FABRYKUJĄ pole `attachments`, którego prawdziwy hub nie produkuje — dokładnie learned pattern „założenie międzymodułowe = test szwu" (testy obu stron przechodzą przy złamanym zachowaniu systemowym).

Napraw po stronie huba: w `pullForUser` dołóż jedno zapytanie `getAttachmentsForMessages` dla id z `active`+`threadRows`+`delegated` (bez N+1 — funkcja już przyjmuje listę) i wzbogać każdy wiersz o `attachments: [...]` z polami `id, filename, size_bytes, mime, sha256` oraz `blob_available` (obecność blobu wg magazynu). Potem dopisz test kontraktu na PRAWDZIWEJ ścieżce (`handleInboxRequest` action `pull` → wiadomość z załącznikiem → odpowiedź zawiera `attachments[0].id` i `blob_available`), inaczej ten sam rozjazd wróci w fazie 4.

### P1 · KOD · `scripts/inbox/inbox-pull.mjs:98`

Stan „pobrany" rozstrzygany WYŁĄCZNIE po nazwie pliku (`defaultIsDownloaded` = existsSync(dir/month/name)), a nazwa pochodzi od nadawcy i nie jest unikalna. Scenariusz: 24.07 Bob wysyła `raport.pdf` (treść A), Ala odhacza → plik ląduje w `Zasoby/inbox-zalaczniki/2026-07/raport.pdf`. 26.07 Czesia wysyła INNY `raport.pdf` (treść B). Przy najbliższym pullu render wiersza załącznika Czesi wchodzi w gałąź 1 (inbox-pull.mjs:115): pokazuje `![[Zasoby/inbox-zalaczniki/2026-07/raport.pdf]]`, czyli plik BOBA podpisany jako załącznik Czesi, i NIE emituje checkboxa „Pobierz".

Skutek: (a) użytkownik czyta cudzy dokument w przekonaniu, że to załącznik z tej wiadomości; (b) załącznika Czesi nie da się już pobrać żadną drogą z UI — nie ma czego odhaczyć; (c) gałąź sufiksu w `pickDownloadDestination` (attachments.mjs:165) staje się z UI nieosiągalna, a plik `raport (2).pdf` — powstający, gdy oba checkboxy odhaczono w JEDNYM runie — nigdy nie zostaje osadzony i zostaje sierotą.

Testy tego nie łapią, bo test kolizji (attachments.test.mjs) sprawdza sam downloader, a testy renderu wstrzykują `isDownloaded`, więc nigdy nie konfrontują dwóch wiadomości o tej samej nazwie. Naprawa musi wiązać stan pobrania z TOŻSAMOŚCIĄ załącznika (id/sha256), a nie z gołą nazwą — np. zapis pod nazwą z krótkim prefiksem id albo weryfikacja sha256 istniejącego pliku przed uznaniem go za „ten".

### P1 · KOD · `scripts/inbox/inbox-push.mjs:72`

Regex parsera pobrań `/^>\s*- \[x\] Pobierz\b/` matchuje także linie kontynuacji TREŚCI wiadomości, którą renderuje `renderMessage` jako `>   ${l}` BEZ jakiejkolwiek neutralizacji (scripts/inbox/inbox-pull.mjs:145). Treść pochodzi od nadawcy przez hub, więc zdalny nadawca może w treści umieścić linię `- [x] Pobierz — %% att:<id własnego załącznika> %%` i wymusić pobranie pliku na maszynę odbiorcy BEZ żadnej akcji człowieka — dokładnie ta klasa wstrzyknięcia, przed którą fazy 2/3 broniły `isUnsafeFilename` i `safeAttachmentName`, tylko przez o wiele szerszy kanał.

Zweryfikowane: render wiadomości o treści `Czesc\n- [x] Pobierz — 📎 x %% att:dddddddd-… %%` daje `parseRequestedDownloads(out) === [{attachment_id:'dddddddd-…'}]`. Łamie R6 (pobranie następuje wyłącznie przez odhaczenie przez człowieka) i wpuszcza do vaulta plik do 25 MB rozsiewany dalej przez Obsidian Sync. `parseCheckedCallouts` jest odporne, bo kotwiczy `^> - \[x\] ` (dokładnie jedna spacja) — nowy parser tę ostrożność zgubił.

Naprawa: zakotwicz parser na dokładnym prefiksie renderu (`^>   - \[x\] Pobierz `) ORAZ neutralizuj w `renderMessage` linie treści zaczynające się od `- [` / zawierające marker komentarza Obsidiana (wstaw znak zerowej szerokości między dwa procenty i zescapuj `- [x]` na początku linii); dopisz test: wiadomość, której treść zawiera odhaczony wiersz Pobierz z poprawnym markerem, daje `parseRequestedDownloads(...) === []`.

---

## Findingi P2

### P2 · KOD · `scripts/inbox/inbox-pull.mjs:110`

Nazwa pliku od nadawcy trafia BEZ escapowania do kontekstu HTML i do wikilinku Obsidiana. `safeAttachmentName` (inbox-pull.mjs:82) wycina tylko separatory, znak procenta i znaki sterujące, a hub (`isUnsafeFilename`, lib/inbox-db.js:504) przepuszcza `<`, `>`, `"`, `[`, `]`.

Potwierdzone uruchomieniem renderu: (1) filename `x]] ![[Sekretny-dziennik` w stanie „pobrany" (linia 115) daje `![[Zasoby/inbox-zalaczniki/2026-07/x]] ![[Sekretny-dziennik]]` — nadawca osadza W SKRZYNCE ODBIORCY dowolną notatkę z jego vaulta, wybraną przez siebie; (2) filename `<img src=x onerror=alert(1)>.png` (linia 120) wychodzi surowo w środku `<span class="os-att">…</span>` — wstrzyknięcie HTML do noty renderowanej przez Obsidiana (obcy `<img src>` = beacon informujący nadawcę, że odbiorca otworzył Skrzynkę).

Wektory obejścia bramki, żaden bez testu odmowy: `<`/`>` (HTML), `"` (wyjście z atrybutu), `]]` + `![[` (wyjście z wikilinku), `[`/`]` (fałszywy link), znaki poza wyciętym zakresem sterującym (U+0085). Napraw w jednym miejscu: rozszerz `safeAttachmentName` o wycięcie `[<>"'\[\]]`, a w inbox-pull.test.mjs dopisz test odmowy per wektor (asercja, że wyrenderowana linia nie zawiera `<`, `]]` ani `![[` poza własnym osadzeniem).

### P2 · KOD · `scripts/inbox/inbox-pull.mjs:117`

Trzeci stan z IU-6 („bajty wygasly (metadane bez blobu) → wiersz z adnotacja, bez checkboxa") opiera sie na polu `att.blob_available`, ktorego zadne zrodlo prawdy nie definiuje i ktorego zaden kod huba nie produkuje: `grep -rn blob_available` po calym repo daje wylacznie scripts/inbox/inbox-pull.mjs:107/117 i asercje w scripts/inbox/inbox-pull.test.mjs:255. Ani plan techniczny, ani dokument wymagan, ani schemat `inbox_attachments` (lib/inbox-db.js:91) nie zna tej nazwy — semantyka i nazwa pola zostaly wymyslone po stronie renderu.

Skutek: galaz `blob_available === false` jest w produkcji nieosiagalna (zielony test opiera sie na recznie zbudowanym obiekcie), a zalacznik po wygasnieciu bajtow bedzie renderowany jako zwykly checkbox „Pobierz", ktorego kliknieciem uzytkownik dostanie tylko cichy `skipped`/blad w logu zamiast adnotacji z IU-6. Dodatkowo faza 4 (IU-9, retencja) nie jest niczym zwiazana z ta nazwa i moze wprowadzic inne pole, utrwalajac rozjazd.

Naprawa: zapisac kontrakt pola (kto je emituje: `pull` huba, na podstawie obecnosci blobu) w planie/IU i wystawic je po stronie huba wraz z metadanymi zalacznika, albo — jesli to nalezy do fazy 4 — cofnac galaz i checkbox IU-6 „stan wygasly" do stanu niezrealizowanego, zamiast raportowac go jako zrobiony.

### P2 · KOD · `scripts/inbox/attachments.mjs:269`

Po `await client.downloadBlob(meta.sha256, dest)` nikt nie sprawdza, czy zapisane bajty mają oczekiwany `sha256` ani czy nie przekraczają limitu — `attemptBlobDownload` (scripts/inbox/inbox-client.mjs:353) pipe'uje strumień odpowiedzi wprost do pliku i zwraca sam rozmiar. Bajty pochodzą z sieci i lądują w vaultcie pod nazwą, którą użytkownik uzna za zweryfikowaną.

Skutki: (a) hub zwracający zły blob (pomyłka magazynu, kompromitacja VPS-a) cicho wstawia obcy plik pod zaufaną nazwą, a `sha256OfFile` przy następnym syncu uzna go za „inną treść" i zacznie mnożyć kopie z sufiksem; (b) strumień bez sufitu rozmiaru zapełnia dysk vaulta — po stronie klienta nie ma tu żadnego capa, w przeciwieństwie do ścieżki wysyłki, gdzie hub egzekwuje MAX_ATTACHMENT_BYTES.

Napraw u konsumenta, który zna oczekiwany hash: po `downloadBlob` policz `sha256OfFile(dest)`, przy rozjeździe skasuj plik, zwiększ `stats.failed` i zaloguj `console.error`; dodatkowo odrzuć plik większy niż `MAX_ATTACHMENT_BYTES`. Test: hub-atrapa zapisująca inną treść niż deklarowany sha → brak pliku w katalogu miesiąca i `failed === 1`.

### P2 · KOD · `scripts/inbox/attachments.mjs:273`

Komentarz „checkbox zostaje odhaczony, więc kolejny przebieg spróbuje ponownie" jest nieprawdziwy, a realne zachowanie to ciche zgubienie akcji usera. Po nieudanym pobraniu (`stats.failed++`, tylko `console.error`) sync leci dalej do kroku 3, `runPull` nadpisuje CAŁY blok między markerami `inbox:items`, a `renderAttachmentLine` dla pliku nieobecnego na dysku emituje `- [ ] Pobierz` — odhaczenie znika. Nie ma retry, nie ma śladu w Skrzynce, a job jest `routine=1`, więc kanał powiadomień milczy (alarmuje tylko fail całego runu, a skrypt kończy się kodem 0). To ta sama klasa awarii, dla której odrzucono sync na dwóch maszynach: cofnięcie akcji usera bez sygnału.

Napraw jedną z dwóch dróg i popraw komentarz zgodnie z wybraną: (a) po niepowodzeniu pobrania oddaj to do renderu, żeby wiersz wrócił jako `- [x] Pobierz` z adnotacją o błędzie (stan pozostaje żądaniem usera), albo (b) ponów pobranie w tym samym runie i dopiero po ostatecznym padzie zgłoś to widocznie (niezerowy kod wyjścia kroku / wpis w Skrzynce), zamiast tylko `console.error`.

### P2 · KOD · `scripts/inbox/attachments.mjs:240`

Krok pobrań wykonuje WŁASNY `client.pull()`, a `pull` po stronie huba ma efekt uboczny: `pullForUser` (lib/inbox-db.js:400) przestawia wszystkie `pending` na `delivered`. Scenariusz: o 10:00:30 przychodzi nowa wiadomość; o 10:01 sync ma odhaczone „Pobierz", więc pull #1 (krok pobrań) zjada status `pending`, a pull #2 (krok renderu, inbox-pull.mjs:501) widzi już `delivered` → `isFresh` (inbox-pull.mjs:163) = false → wiadomość NIGDY nie dostaje badge'u „nowe" ani klasy `|fresh`, i nie wchodzi do `newCount` w logu. Bez odhaczonego pobrania ta sama wiadomość dostałaby oznaczenie.

Efekt jest niedeterministyczny (zależy od tego, czy w tej minucie coś się pobiera), więc diagnoza „czemu nowa wiadomość nie zapaliła się na zielono" jest praktycznie niemożliwa. Napraw przekazując wynik JEDNEGO pulla przez oba kroki (albo pozwalając wstrzyknąć `pullData` do `downloadRequestedAttachments`), zamiast wołać hub dwa razy w jednym runie.

### P2 · KOD · `server.js:868`

`BLOB_DRAIN_IDLE_MS = 1000` mierzy PRZERWĘ między chunkami, ale 1 s to wartość poniżej normalnej zmienności realnego łącza — pojedyncza retransmisja/zadyszka mobilnego uplinku w trakcie 26 MB uploadu wystarczy, by watchdog uznał uczciwego nadawcę za milczącego: `settle(true)` → `closeSocketAfterResponse` → odpowiedź i `req.destroy()` przy niedoczytanych danych w buforze odbiorczym, czyli RST kasujący 413 w buforze klienta.

Scenariusz: klient deklaruje 26 MB, pompuje przez LTE, ma 1,3 s przerwy po 5 MB → dostaje „fetch failed" zamiast 413, niedeterministycznie, zależnie od jakości łącza — czyli wraca objaw, dla którego cały drenaż powstał. Learned pattern o progach mówi wprost: próg = okres zjawiska + definicja zdarzenia, a nie goła „sekunda ciszy". Podnieś próg do wartości z zapasem nad realną zmiennością łącza (rzędu 10–15 s, spójnie z `REQUEST_TIMEOUT_MS` klienta) albo domykaj gniazdo półzamknięciem (`res.end()` + `socket.end()`) zamiast `destroy()`.

### P2 · KOD · `scripts/inbox/inbox-sync.mjs:54`

`role: role === undefined ? readMachineRole() : role` liczy się EAGERNIE przy każdym runie syncu — a sync to script-job odpalany co 1 minutę w ŚWIEŻYM procesie. `readMachineRole` woła `db.getState(...)`, co przez leniwy `getDb()` otwiera `data/claude-cron.db` i wykonuje pełny `migrate()` (seria `ALTER TABLE` w try/catch, czyli próby ZAPISU) plus smoke-test agregatów — na bazie, którą równolegle trzyma otwartą daemon. Płacimy to 1440 razy na dobę tylko po to, żeby odczytać jeden klucz `state`, podczas gdy w zdecydowanie najczęstszym przebiegu (zero odhaczonych „Pobierz") cały krok i tak kończy się no-opem po `requested.length === 0` (attachments.mjs:236). To dokładany co minutę drugi pisarz do bazy schedulera — dokładnie ta klasa kontaktu, przez którą projekt musiał dokładać `busy_timeout` (learned pattern 2026-08-07).

Zdanie akcji: przekaż leniwy dostęp zamiast wartości — zmień pole na `getRole: () => (role === undefined ? readMachineRole() : role)` i w `downloadRequestedAttachments` wywołaj je DOPIERO po wczytaniu Skrzynki i wczesnym powrocie `if (requested.length === 0) return stats;`, przed jakimkolwiek `client.pull()`, `mkdir` i zapisem. R10 zostaje nietknięte: rola nadal rozstrzyga się przed jakimkolwiek żądaniem do huba i przed jakimkolwiek zapisem na dysk, a sam odczyt lokalnego `Skrzynka.md` nie jest pobraniem.

### P2 · KOD · `scripts/inbox/inbox-sync.mjs:47`

Kolejność push → pobrania gubi pobranie, gdy człowiek odhaczy w jednym podejściu „Zrobione" i „Pobierz" na TYM SAMYM wątku (typowy gest: ściągam plik i zamykam zadanie). Krok 1 woła `client.done()` → hub ustawia `status='done'`; krok 2 robi własny `client.pull()`, a `pullForUser` (lib/inbox-db.js:355) bierze do `active` tylko `pending|delivered`, zaś `threadRows` wyprowadza z id wątków z `active` — domknięty wątek znika z CAŁEJ odpowiedzi. `indexAttachments` nie znajduje metadanych, `downloadRequestedAttachments` (attachments.mjs:246) loguje warn i zwiększa `skipped`, a krok 3 (pull) usuwa wiersz ze Skrzynki. Plik nigdy nie trafia do vaulta, użytkownik nie dostaje żadnego sygnału poza linijką w logu joba i nie ma już checkboxa, żeby powtórzyć.

Testy nie łapią: test IU-7 „Zrobione i Pobierz naraz" sprawdza tylko parsery, a `inbox-sync.test.mjs` używa DWÓCH różnych wątków (ID_TASK vs ID_MSG). Napraw kolejnością: pobrania PRZED pushem (pull i tak zostaje ostatni, więc okno na zdmuchnięcie checkboxa się nie otwiera).

---

## Findingi P3

### P3 · KOD · `scripts/inbox/inbox-pull.mjs:76`

`attachmentMonth` przy niepoprawnym `created_at` (brak pola, uszkodzony rekord huba) zwraca `"NaN-NaN"`, co downloader (attachments.mjs:252) bierze za nazwę podkatalogu i tworzy w vaultcie katalog `Zasoby/inbox-zalaczniki/NaN-NaN/`. Dodaj w `attachmentMonth`, zaraz po `const d = new Date(iso);`, linię `if (Number.isNaN(d.getTime())) return 'bez-daty';` — render i downloader korzystają z tej samej funkcji, więc obie strony pozostaną spójne.

### P3 · KOD · `scripts/inbox/attachments.mjs:171`

`if ((await sha256OfFile(candidate)) === sha256) return null;` czyta i hashuje CAŁY istniejący plik (do 25 MB) zanim stwierdzi, że treść jest inna — a rozmiar wystarczy, by większość przypadków rozstrzygnąć jednym `stat`. Zdanie akcji: rozszerz sygnaturę na `pickDownloadDestination(dir, name, sha256, sizeBytes)` (wywołanie w linii 261 przekazuje `meta.size_bytes`) i w pętli, przed `sha256OfFile`, pobierz `const st = await stat(candidate);` oraz `if (Number.isFinite(sizeBytes) && st.size !== sizeBytes) continue;` — hash liczymy dopiero dla kandydata o zgodnym rozmiarze.

### P3 · KOD · `scripts/inbox/inbox-pull.mjs:87`

Dwie różne funkcje o TEJ SAMEJ nazwie `formatBytes` w modułach, które się importują: ta (B/kB/MB, `toFixed(1)`, zaokrąglenie do najbliższej dziesiątej) i eksportowana `formatBytes` z `scripts/inbox/attachments.mjs:47` (tylko MB, `Math.ceil` — zaokrąglenie w górę wymuszone findingiem fazy 2). Czytający „5-sekundową regułą" nie ma szans zgadnąć, którą widzi, a przypadkowe podmienienie jednej na drugą jest ciche. Zmień nazwę tej lokalnej funkcji na `formatAttachmentSize` i zaktualizuj jedyne jej użycie w `renderAttachmentLine` (linia 111).

### P3 · KOD · `scripts/inbox/inbox-pull.mjs:72`

`attachmentMonth` liczy podkatalog z czasu LOKALNEGO (`d.getFullYear()`/`d.getMonth()`) na znaczniku ISO w UTC, więc wiadomość z 2026-07-31T23:30:00Z ląduje w katalogu `2026-08`, a ta sama baza odczytana na maszynie w innej strefie (albo po zmianie strefy laptopa) wskaże `2026-07` — render szuka pliku w innym katalogu niż ten, w którym downloader go zapisał, i checkbox „Pobierz" wraca przy każdym syncu mimo pobranego pliku. Zamień ciało funkcji na wariant UTC (`getUTCFullYear()` / `getUTCMonth()`) i dopisz w inbox-pull.test.mjs asercję `attachmentMonth('2026-07-31T23:30:00.000Z') === '2026-07'`.

---

## Obalone przez verify (nie do naprawy)

- [P2/KOD] scripts/inbox/attachments.mjs:14 — Odwrócony kierunek zależności: `attachments.mjs` (moduł nadawcy) importuje `inbox-pull.mjs` i `inbox-push.mjs` i dokłada do siebie orkiestrację odbioru; jako „konkretną szkodę" wskazano prywatną kopię `formatBytes` w inbox-pull.mjs:87 wymuszoną unikaniem cyklu oraz regres findingu fazy 2 o odcięciu modułu od transportu · obalone: Kluczowe twierdzenia nie wytrzymuja konfrontacji z kodem. (a) NIE MA cyklu — ani inbox-pull.mjs, ani inbox-push.mjs nie importuja attachments.mjs, strzalka jest jednokierunkowa, wiec regula „zero circular dependencies" nie jest zlamana, a import jest bezpieczny (oba moduly maja guard entry-pointu, import nie odpala main). (b) Podana „konkretna szkoda" jest nieprawdziwa: prywatne `formatBytes` NIE jest kopia tego z attachments.mjs — to inna funkcja o innej semantyce (B/kB/MB z toFixed(1) dla metadanych wiersza vs. wylacznie MB z Math.ceil, celowo, dla komunikatu odmowy 25 MB, po fixie P3 z fazy 2), wiec import nie zastapilby jej niezaleznie od kierunku zaleznosci. (c) Nie jest to regres findingu fazy 2 — tamten dotyczyl domyslki `client = inboxClient`, a attachments.mjs nadal nie importuje inbox-client.mjs i nadal wymaga wstrzyknietego klienta. Pozostaje wylacznie zarzut estetyczny (rozjechany naglowek pliku, mieszanie odpowiedzialnosci) bez wykazanego wplywu na zachowanie (zrodlo: code-quality)
- [P2/TEST] server.js:873 — Nowa logika sterowania w `drainRequestBody`/`drainThenRespond` (cap `BLOB_DRAIN_CAP_FACTOR`, watchdog bezczynności, jednorazowy `settle()`, wczesny return dla zniszczonego strumienia) nie ma ani jednego testu; istniejące przypadki 413 przechodzą także przy całkowicie martwym drenażu · obalone: Premisa findingu jest falszywa. Test `server.inbox.http.test.js:605` („PUT blob: zadeklarowany Content-Length ponad limit -> 413 bez transferu ciala") idzie DOKLADNIE nowa sciezka: deklarowany CL 26 MB → rejectBlob({drain:true}) → drainRequestBody, klient wysyla 16 bajtow i milknie bez `end`. Zmierzony czas tego testu to `duration_ms: 1006.5` — 1000 ms watchdoga BLOB_DRAIN_IDLE_MS plus narzut. To jest dokladnie test, ktory finding proponuje dopisac jako (1), i jednoczesnie dowod, ze watchdog + settle(true) + closeSocketAfterResponse sa uzbrojone: przy nieuzbrojonym watchdogu zaden inny sygnal (data/end/close/cap) w tym scenariuszu nie nadchodzi, wiec odpowiedz nigdy by nie poszla i test by wisial. Wczesny `return settle(false)` jest realnie przebiegany przez test z linii 370 (22 ms). Nietkniete testem zostaje tylko ramie capu (2× maxBytes) — to luka, ale oba nosne zdania findingu sa obalone pomiarem (zrodlo: security)
- [P2/KOD] server.js:988 — `drain: true` w gałęzi `InboxBlobError` martwe dla `too_large`/`stream_error`, bo `for await` po `req` niszczy strumień, a `IncomingMessage.destroy()` niszczy gniazdo, więc 413 idzie do zerwanego socketu; klient chunked dostaje „fetch failed" · obalone: Wplyw nie zachodzi — sprawdzone eksperymentalnie na zywym serwerze. Odpalony dokladnie scenariusz z findingu: surowy `http.request` PUT /inbox/v1/:token/blob/:sha BEZ Content-Length (Transfer-Encoding: chunked), 30 MB przy limicie 25 MB — klient dostal `{status: 413, body: '{"v":1,"error":"too_large"}'}`, pelna odpowiedz, zero „fetch failed". Minimalna reprodukcja pokazuje, ze po rzucie w `for await` `req.destroyed = true` i `req.readable = false`, ale `req.socket === null` — IncomingMessage zostal odpiety od gniazda, wiec `socket.destroy()` z `_destroy` sie NIE wykonuje i gniazdo zyje; `res.writable` jest dalej `true` i odpowiedz normalnie flushuje (Node v22.22.3). Faktyczna czesc findingu — ze `drain:true` jest w tej galezi no-opem (wczesny `settle(false)` po `req.destroyed`) — jest prawdziwa, ale to martwy kod bez skutku, a nie awaria dostarczenia 413; postulowana naprawa (rezygnacja z `for await` na rzecz recznej iteracji z `pause()`) nie ma czego naprawiac (zrodlo: correctness)

---

## Bookkeeping checkboxów `Weryfikacja:` / `Test: [E2E]`

Faza 3 nie ma ani jednego checkboxa z markerem `[E2E]` — tester E2E został pominięty przez routing, więc żadna linia nie wymagała dowodu przebiegu i sekcja „Operator checklist faza 3" pozostaje pusta.

Re-parsowano 4 niezaznaczone wiersze `Weryfikacja:` (wszystkie kategoria CLI). Uruchomione przez Bash w katalogu repo:

| Wiersz | Komenda | Exit | Wynik |
|---|---|---|---|
| IU-6 | `node --test scripts/inbox/inbox-pull.test.mjs` | 0 | `[x]` |
| IU-7 | `node --test scripts/inbox/inbox-push.test.mjs scripts/inbox/inbox-pull.test.mjs` | 0 | `[x]` |
| IU-8 | `node --test scripts/inbox/attachments.test.mjs scripts/inbox/inbox-sync.test.mjs` | 0 | `[x]` |
| IU-8 | `node --test` (pełna suita) | 0 | `[x]` — 1236 pass, 0 fail |

Zero FAIL, zero SKIP → bookkeeping nie wnosi żadnego findingu P2.

Uwaga interpretacyjna: zieleń pełnej suity NIE jest dowodem, że faza 3 działa — finding P1 (`lib/inbox-db.js:407`) pokazuje, że atrapy huba w testach fabrykują pole `attachments`, którego produkcyjny `pullForUser` nie emituje. To dokładnie sytuacja „testy obu stron przechodzą przy złamanym zachowaniu systemowym".

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 15 (11) |
| Flagi warstw | ui=true dane=true typowanie=false nowyModul=true |
| Checkboxy `[E2E]` (Test: + Weryfikacja:) | 0 |
| Tryb testera E2E | pominiety |
| Tester E2E | pominiety przez routing |
| Przebiegi E2E PASS / FAIL / SKIP | 0 / 0 / 0 |
| Reviewerzy aktywni | security, performance, code-quality, correctness, spec-compliance, test-coverage |
| Reviewerzy pominieci | e2e (zero checkboxow [E2E] (0) i brak makiet figma_screens) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 29 -> 29 -> 18 |
| P3 odrzucone limitem globalnym | 0 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 14 / 3 / 0 |
