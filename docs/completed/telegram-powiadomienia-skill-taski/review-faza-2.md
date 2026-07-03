# Review fazy 2 — Telegram (Unit 3: kanał Telegram end-to-end + R9, Unit 4: checkbox per job)

Data: 2026-07-03
Zakres: `lib/telegram.js(+test)`, `lib/notify-format.js` (odziedziczone bugi chunkingu), `lib/db.js(+test)` (kolumna `telegram_notify`), `lib/executor.js(+test)` (`notifyRunOutcome`, `isFinalFailure`, guard `killed`), `lib/discord.js(+test)` (`sendFailureNotification`), `lib/scheduler.js` (interakcja retry↔R9), `public/index.html`, `public/app.js`
Findings po adversarial verify, zdedupowane (32 surowe → 27 unikalnych; 5 duplikatów scalonych z zachowaniem wszystkich perspektyw).

## Statystyki

- 🔴 P1 (blocking): **2** (2 KOD)
- 🟠 P2 (important): **4** (2 KOD, 2 TEST)
- 🟡 P3 (nit): **19** (15 KOD, 3 TEST, 1 E2E)
- 👤 OPERATOR: **2** (poza gate — do Operator checklist)
- 🌐 E2E: **1 passed / 0 failed / 0 skipped** (scenariusz Unit 4 na świeżej instancji z kodem fazy 2, port 7799)
- Testy: `npm test` 230/230 PASS; `node --test lib/telegram.test.js lib/db.test.js` 41/41 PASS

**Severity gate: ⛔ WYMAGA POPRAWEK — znaleziono 2 problemy P1 blokujące kontynuację.**

---

## 🔴 P1 (blocking)

### P1-1 [KOD] `lib/executor.js:43` — suppresja ❌ w `isFinalFailure` zakłada retry, które NIGDY nie odpala

Suppresja powiadomienia ❌ w `isFinalFailure` zakłada, że scheduler zrobi retry, ale retry nigdy nie odpala: `scheduler.js:29` sprawdza `run.status === 'failed'` na stale-owym obiekcie z `getQueuedRuns()` (in-memory status to zawsze `'queued'`; `executeRun` pisze status tylko do DB przez `db.updateRun`, nie mutuje przekazanego obiektu). Skutek fazy 2: job z domyślnym `max_retries=1` po pierwszym failu ma `recentFailedCount=1`, `isFinalFailure('failed',1,1)=false` → brak ❌, a retry też nie powstaje → użytkownik nie dostaje NIC (R9 cicho złamane w domyślnej konfiguracji).

**Fix:** naprawić odczyt statusu w `scheduler.processQueue` (re-read runu z DB po `executeRun`) albo liczyć ostateczność failu w executorze bez założenia o retry.

### P1-2 [KOD] `lib/scheduler.js:29` — R9 pozornie zaimplementowane, w praktyce BŁĘDNE dla domyślnej konfiguracji (martwe retry)

R9 („wysyłka po ostatecznym failu po wyczerpaniu retry") — `isFinalFailure` (`lib/executor.js:21`) wstrzymuje ❌ dopóki liczba failów w oknie nie PRZEKROCZY `max_retries`, zakładając że scheduler dorzuci retry. Ale retry w `scheduler.processQueue` jest martwe: warunek `run.status === 'failed'` czyta obiekt pobrany z `getQueuedRuns()` PRZED `executeRun`, a executor nigdy nie mutuje tego obiektu (status idzie wyłącznie do DB przez `db.updateRun(run.id,...)`) — `run.status` zostaje `'queued'`, retry nigdy się nie kolejkuje. Scenariusz: job z `max_retries=1` (default w db.js i UI) + `telegram_notify`/`discord_notify=1`; run pada (exit≠0) → `countRecentFailedRuns=1`, `isFinalFailure('failed',1,1)=false` → brak ❌; retry nie powstaje → to BYŁ ostateczny fail, a user nie dostaje żadnego powiadomienia. ❌ przyjdzie dopiero gdy job padnie drugi raz z rzędu przy następnym runie z crona (może po dobie). Root cause jest pre-existing, ale faza 2 zbudowała na nim R9 bez weryfikacji end-to-end.

**Fix:** scheduler po `executeRun` czyta świeży status z DB (albo executor zwraca status), plus test integracyjny fail→retry→❌. (Fix wspólny z P1-1 — to dwie strony tego samego defektu, kotwiczone w dwóch plikach.)

---

## 🟠 P2 (important)

### P2-1 [KOD] `lib/telegram.js:43` — DoS przez nieskończoną pętlę przy bardzo długiej nazwie joba

`buildMessages` liczy limit chunka jako `TELEGRAM_MAX_LEN - header.length - 1`; przy nazwie joba ≥ ~4090 znaków limit jest ujemny, a `smartSplit` (`lib/notify-format.js`) z ujemnym `maxLen` wpada w nieskończoną SYNCHRONICZNĄ pętlę (warunek `remaining.length > maxLen` zawsze prawdziwy, `slice` z ujemnym indeksem nie zmniejsza `remaining` — potwierdzone symulacją: puste chunki pchane bez końca). Blokuje cały event loop serwera (scheduler+API+dashboard) i rośnie w pamięci. `POST /api/jobs` nie waliduje długości `name`, więc ścieżka osiągalna z API; wyzwala się przy pierwszym udanym runie joba z `telegram_notify=1`.

**Fix:** guard w `buildMessages` (min. limit > 0 / `Math.max(1, ...)` / przycięcie nagłówka) i/lub walidacja długości `name` na granicy API; `smartSplit` powinien fail-fastować przy `maxLen <= 0`.
*(Scalono duplikat: P3 `lib/telegram.js:41` — ten sam brak guardu dolnego.)*

### P2-2 [KOD] `lib/notify-format.js:40` — off-by-one w `smartSplit` przeniesiony do fazy 2 mimo wymogu naprawy PRZED fazą 2

Wymóg naprawy przed fazą 2 (`zadania.md:36`, checkbox pusty) niezrealizowany: gdy `'. '` zaczyna się dokładnie na indeksie `maxLen`, chunk ma `maxLen+1` znaków. Repro potwierdzone: `buildMessages('test-job', ...)` produkuje pierwszą wiadomość 4097 znaków > limit Telegrama 4096 → Bot API zwraca 400, `sendNotification` odrzuca na pierwszym chunku, pozostałe chunki nie są wysyłane, a fire-and-forget `.catch(()=>{})` w executorze połyka błąd — całe powiadomienie cicho przepada. Brak testu brzegowego (test chunkingu w `telegram.test.js` używa linii 80 znaków, daleko od granicy).

**Fix:** naprawa off-by-one w `smartSplit` + test brzegowy dokładnie na granicy `maxLen`. Zastępuje otwarty P3 z review fazy 1 (`zadania.md:36`) — eskalacja do P2, bo Telegram już konsumuje chunking.

### P2-3 [TEST] `lib/executor.js:37` — `notifyRunOutcome` (nowy wspólny punkt decyzyjny powiadomień) bez ŻADNEGO testu

Bramkowanie flagami `job.discord_notify`/`telegram_notify`, rozgałęzienie success→`sendNotification` vs final-fail→`sendFailureNotification`, `countRecentFailedRuns` liczone PO `db.updateRun`, niezależność kanałów — nietestowane. Scenariusz planu „fail z wyczerpanymi retry + flaga → wiadomość ❌" pokryty tylko fragmentarycznie: czysta `isFinalFailure` (`executor.test.js`) i `sendFailureNotification` (`telegram.test.js`) osobno, nigdy wiring między nimi. Regresja typu zamiana `sendNotification`/`sendFailureNotification`, odwrócone flagi kanałów albo policzenie faili PRZED `updateRun` przeszłaby cały suite. Checkbox `zadania.md:56` odhaczony mimo braku testu tej ścieżki. To dokładnie ta warstwa integracji, która zamaskowała P1 (martwe retry ↔ próg `isFinalFailure`).

**Fix:** eksport/DI `notifyRunOutcome` + test z mockami kanałów (gating flag, rozgałęzienie success/fail, kształt `{status, error_msg, stderr}`).
*(Scalono duplikat: P3 TEST o scenariuszu Unit 3 — ta sama luka.)*

### P2-4 [TEST] `lib/executor.js:242` — nowy guard `killed` (odczyt `priorRun` z DB w close handlerach) bez testu

Linie 242-243 ścieżka claude, 326-327 ścieżka script — ta druga wcześniej w ogóle nie znała statusu `killed`. Scenariusz planu „killed → brak wysyłki" pokryty tylko na poziomie czystej `isFinalFailure('killed',...)→false`, ale samo WYKRYCIE killed (`killCurrent` zapisuje `'killed'` w DB zanim proces się domknie; bez odczytu `priorRun` close policzyłby `'failed'` z exit code i R9 wysłałoby ❌ mimo świadomego ubicia przez usera) jest nieasertowane — regresja usuwająca odczyt `priorRun` przeszłaby suite.

**Fix:** test integracyjny na DB `:memory:`: run oznaczony `killed` przed close → `notifyRunOutcome` nie woła kanałów.

---

## 🟡 P3 (nit)

### P3-1 [KOD] `lib/executor.js:30` — zduplikowana logika biznesowa okna retry

`countRecentFailedRuns` (`getRuns` limit `max_retries+1` + filter `status==='failed'`) jest dosłowną kopią `scheduler.processQueue` (`lib/scheduler.js:30-32`). Spójność progu „będzie retry / final fail" opiera się tylko na komentarzu — zmiana semantyki retry w schedulerze cicho rozjedzie próg powiadomień R9. Fix: wspólny helper (np. `db.countRecentFailedRuns(jobId, maxRetries)` w `lib/db.js` — executor nie może importować schedulera, bo scheduler importuje executor) użyty w obu miejscach.

### P3-2 [KOD] `lib/notify-format.js:42` — pusty chunk w `smartSplit` przeniesiony do fazy 2 mimo wymogu naprawy PRZED fazą 2

`zadania.md:37`, checkbox pusty. `trimEnd()` po podziale na granicy `\n` pushuje `''` bez guardu — repro: `smartSplit('\n'.repeat(30), 10)` → `[""]`. W fazie 2 `buildMessages` wyśle `sendMessage` z pustym `text` → Telegram 400 (message text is empty), powiadomienie cicho zgubione. Brak testu brzegowego.

### P3-3 [KOD] `lib/executor.js:262` — ekspozycja promptu/webhook_payload w powiadomieniu o failu

`notifyRunOutcome` dostaje `stderr = fullStderr = diagLog + stderr`, a `diagLog` zaczyna się od linii `SPAWN: <bin> ... -p <PEŁNY PROMPT>` zawierającej `job.arguments` oraz `webhook_payload` (dane z publicznego endpointu `/webhook/:token`). Gdy realny stderr jest krótki (szybki fail), ogon `slice(-1000)` w `buildFailureMessage` (telegram.js) i `sendFailureNotification` (discord.js) obejmie tę linię — treść promptu/payloadu wypływa do zewnętrznych serwisów. Fix: czysty stderr procesu (bez diagLog) do powiadomień albo wycięcie linii SPAWN.

### P3-4 [KOD] `lib/telegram.js:15` — `postSendMessage` bez timeoutu żądania HTTP

Brak `req.setTimeout`/`AbortSignal`, a `sendNotification` awaituje chunki sekwencyjnie — jeden wiszący socket do api.telegram.org = zawieszony na zawsze promise i niewysyłane kolejne chunki (fire-and-forget, więc run się nie blokuje, ale socket i pamięć wiszą bez limitu). Ten sam brak jest pre-existing w `discord.js postWebhook` — nowy kod powiela wzorzec zamiast go poprawić.

### P3-5 [KOD] `lib/executor.js:39-40` — cztery nowe puste `.catch(() => {})` w `notifyRunOutcome`

Łamie regułę projektu „NIGDY pusty catch — zawsze loguj albo re-throw": błędny token/chat_id (np. revoked bot, 401/400) = powiadomienia cicho nigdy nie dochodzą, zero śladu do diagnozy — user zaznacza checkbox, nic nie przychodzi. Zgodne z literą planu („fire-and-forget .catch"), ale izolacja od statusu runu nie wymaga ciszy. Fix: `.catch(err => console.error('[notify]', err.message))` — komunikat błędu telegram.js celowo nie zawiera path, więc token nie wycieknie do logów.
*(Scalono 3 zgłoszenia: executor.js:39, :39, :40 — ta sama sprawa.)*

### P3-6 [KOD] `lib/executor.js:43` — gorliwa ewaluacja `countRecentFailedRuns` także gdy wynik ignorowany

Liczona jako argument `isFinalFailure` przy KAŻDYM niesukcesie: (a) `status='killed'` — `isFinalFailure` zwraca false zanim spojrzy na licznik, (b) job bez flag kanałów — najczęstszy przypadek. Zbędne zapytanie do DB ładujące do `max_retries+1` pełnych wierszy `runs` per fail. Fix: guard na flagi kanałów przed liczeniem + pominięcie dla killed (leniwa ewaluacja).

### P3-7 [KOD] `lib/executor.js:30` — `countRecentFailedRuns` przez `db.getRuns` (SELECT *) ładuje pełne payloady stdout+stderr

Do ~100KB/wiersz przy `MAX_LOG_SIZE=50KB` każde; bieżący run po `db.updateRun` ma już pełny payload — a potrzebne są tylko statusy w oknie `max_retries+1`. Narusza regułę „select konkretnych kolumn". Fix: `SELECT status FROM runs WHERE job_id=? ORDER BY id DESC LIMIT ?`. Skala ograniczona (max 6 wierszy, runy serializowane) — dlatego P3.

### P3-8 [KOD] `lib/executor.js:242` — guard killed czyta `db.getRunWithPayload` (SELECT *) tylko dla `status`

Obie lokalizacje (242 i 326). W praktyce payload wiersza jest w tym momencie pusty (updateRun jeszcze nie zapisał stdout/stderr), więc koszt realny minimalny — nit o dobór zapytania: lżejsze `SELECT status FROM runs WHERE id=?` będzie intencjonalne i odporne na przyszłe zmiany kolejności zapisu.

### P3-9 [KOD] `lib/telegram.js:62` — brak obsługi rate-limitu 429 i capu liczby chunków

Przy stdout 50KB `extractResult` może dać ~13 wiadomości burst do jednego czatu; odrzucenie 429 przerywa pętlę w połowie, pozostałe chunki giną cicho. Fix minimalny: cap liczby wiadomości (np. 5 + dopisek o obcięciu) lub prosty retry-after z `parameters.retry_after`. Plan tego nie wymagał — P3.

### P3-10 [KOD] `lib/executor.js:37` — naruszenie SRP + limitu 300 linii (executor.js = 391 linii)

Druga odpowiedzialność: polityka powiadomień (`isFinalFailure`, `countRecentFailedRuns`, `notifyRunOutcome` to spójny, czysty klaster niezależny od spawnowania procesów). Ekstrakcja do np. `lib/notify-outcome.js` rozwiązałaby też wspólny dom dla logiki okna retry (P3-1) i uprościła testowanie `notifyRunOutcome` (P2-3 — dziś prywatne w module z I/O).

### P3-11 [KOD] `lib/discord.js:9` — duplikacja formatowania failu między kanałami

`STDERR_TAIL_LEN=1000` i wyrażenie detalu `((error_msg && trim()) || stderr.trim().slice(-1000))` skopiowane 1:1 w `discord.js:74` i `telegram.js` (`buildFailureMessage`), z komentarzami odsyłającymi do siebie nawzajem. `lib/notify-format.js` powstał dokładnie po to — `buildFailureDetail(errorMsg, stderr)` + `STDERR_TAIL_LEN` powinny trafić tam (2 użycia = próg ekstrakcji).

### P3-12 [KOD] `lib/discord.js:79` — asymetria kanałów przy pustym detalu failu

`telegram.buildFailureMessage` ma guard (`detail ? header+detail : header`), a `discord.sendFailureNotification` wysyła embed z `description: ''` gdy `error_msg` i stderr puste (możliwe w ścieżce script — `executor.js:340` przekazuje surowy stderr bez diagLog). Pusty string w polu embeda = niezdefiniowany kontrakt / możliwe 400, połknięte przez `.catch(()=>{})`. Fix: pomiń pole `description` gdy detal pusty.
*(Scalono 2 zgłoszenia tej samej asymetrii.)*

### P3-13 [KOD] `lib/discord.js:70` — mylący kontrakt: parametr `run` to nie rekord runu z DB

`sendFailureNotification(job, run)` w discord.js i telegram.js dostaje syntetyczny obiekt `{status, error_msg, stderr}` zbudowany w `notifyRunOutcome` (`executor.js:45`) — przy czym w ścieżce claude `stderr` to fullStderr z diagLogiem. Nazwa sugeruje wiersz z tabeli `runs` (finished_at/exit_code nie istnieją). Fix: przemianować na `failure`/`outcome` + komentarz z kształtem.
*(Scalono 2 zgłoszenia: discord.js:70 i telegram.js:64.)*

### P3-14 [KOD] `lib/discord.js:76` — tytuł embeda ❌ bez cięcia do limitu Discorda 256 znaków

`❌ ${job.name} padł (${run.status})` — cięte jest tylko description do 2000. Długa nazwa joba → API 400, błąd połknięty przez `.catch(()=>{})` — powiadomienie znika bez śladu. Fix: `.slice(0, 256)` na tytule (header w telegram.js mieści się w globalnym cięciu 4096).

### P3-15 [KOD] `public/app.js:47` — `API.post`/`API.put` nie sprawdzają `res.ok` (pre-existing, potwierdzone na żywo w E2E)

Przy 400 z `POST /api/jobs` (np. pusty skill_name i prompt) `saveJob` nie wpada w catch, pokazuje toast „Job utworzony!" i zamyka modal, a job nie istnieje — cicha utrata danych formularza (user przekonany, że job z powiadomieniem Telegram powstał). Fix: rzucać błąd gdy `!res.ok` w helperze API.

### P3-16 [TEST] `lib/telegram.test.js:151` — skorupa sieciowa `sendNotification` testowana tylko dla 1 wiadomości

Pętla `for...of buildMessages` z sekwencyjnym await (`telegram.js:57-59`) bez testu multi-chunk (wynik > 4096 → N kolejnych POSTów w dobrej kolejności, każdy z tym samym chat_id). Regresja „wysyłany tylko pierwszy chunk" przeszłaby zielono. Fix: test z długim wynikiem, asercja `calls.length >= 2` i nagłówek tylko w `calls[0].body.text`.

### P3-17 [TEST] `lib/telegram.js:29` — ścieżka błędu `postSendMessage` (statusCode poza 2xx → reject) bez testu

Mock w `telegram.test.js` zawsze odpowiada 200. Nieasertowana też deklarowana komentarzem własność bezpieczeństwa: komunikat błędu NIE zawiera `path` (w path żyje bot token) — regresja dodająca `options.path` do Error wyciekłaby token do stderr/logów. Reguła projektu: każda nowa funkcja = min. 1 happy path + 1 error case.

### P3-18 [TEST] `lib/discord.js:79` — gałąź twardego cięcia opisu embeda ❌ do 2000 znaków bez testu

Istniejący test `discord.test.js` pokrywa tylko ogon stderr ~1000 znaków (mieści się w limicie bez cięcia). Odpowiednik telegramowy (twarde cięcie do 4096) MA test — asymetria pokrycia między kanałami przy tej samej semantyce R9.

### P3-19 [E2E] `public/app.js:920` — scenariusz weryfikacji Unit 4 bez pokrycia automatycznego

Frontend vanilla JS bez testów to konwencja projektu — jedyna weryfikacja tych 3 linii + checkboxa w `index.html` to przejście scenariusza E2E na żywym dashboardzie w kroku review (wykonane — patrz „Weryfikacja E2E").

---

## 👤 OPERATOR (poza gate — Operator checklist)

### OP-1 `localhost:7777` — produkcyjny lokalny Puls działa z kodem sprzed fazy 2

Scenariusz E2E Unit 4 PASS na aktualnym kodzie, ale NIE na wskazanym w zadaniu `localhost:7777`. Bloker: produkcyjny proces Puls (PID 96870) działa od 30.06.2026 — backend cicho gubi `telegram_notify` (POST z `true` → w bazie 0), mimo że frontend serwowany z dysku ma już checkbox. Zweryfikowano twardo: identyczny POST na świeżej instancji z kodem fazy 2 (port 7799, czysta baza) daje `telegram_notify:1`, edycja odzwierciedla stan z bazy, odznaczenie+zapis daje 0.
**Operator action:** zrestartować lokalny serwer Puls (`launchctl kickstart -k com.claude-cron.scheduler` lub kill+`npm start`) — po restarcie feature działa end-to-end.

### OP-2 `lib/telegram.js:11` — realna wysyłka do żywego API Telegrama niezweryfikowana

Testy pokrywają wyłącznie czyste funkcje i no-op bez configu (mocki). Poprawność ścieżki `/bot<token>/sendMessage`, semantyka odpowiedzi (Telegram zwraca `ok:false` z HTTP 200 tylko w części przypadków; learned-pattern projektu każe weryfikować dokładną frazę `ok:true`, nie sam status) oraz chunking 4096 na żywym API wymagają realnego bota + chat_id — weryfikacja headless niewykonalna.
**Operator action:** przy teście fazy setupowej (Unit 6) skonfigurować prawdziwego bota i potwierdzić dojście wiadomości testowej oraz powiadomienia z realnego runu (✅ i ❌).

---

## Zgodność ze spec

- **R9 (powiadomienie po ostatecznym failu) — NIEZREALIZOWANE w domyślnej konfiguracji** mimo odhaczonych checkboxów Unit 3: P1-1/P1-2 (martwe retry w schedulerze + próg `isFinalFailure` zbudowany na założeniu, że retry istnieje). Checkbox `zadania.md:56` („Test: fail…") odhaczony na podstawie testów czystych funkcji, nie ścieżki integracyjnej (P2-3).
- **Wymóg z review fazy 1 „naprawić boundary bugi smartSplit PRZED fazą 2" zignorowany** — checkboxy `zadania.md:36-37` puste, a faza 2 podpięła Telegram (limit 4096) pod wadliwy chunking: P2-2 (off-by-one → 4097 znaków → 400) i P3-2 (pusty chunk → 400).
- Pozostały zakres Unit 3/4 (kolumna DB + migracja, czyste `buildMessages`/`buildFailureMessage`, checkbox UI, wariant fail w Discordzie) — zgodny z planem, potwierdzony testami (230/230) i E2E.

## Weryfikacja E2E

| Scenariusz | Wynik |
|---|---|
| Unit 4: dodaj job z zaznaczonym Telegramem → `GET /api/jobs` zwraca `telegram_notify:1`; edycja odzwierciedla stan z bazy; odznaczenie+zapis → 0 (świeża instancja z kodem fazy 2, port 7799, czysta baza) | ✅ passed |

Razem: **1 passed / 0 failed / 0 skipped**. Uwaga: na produkcyjnym `localhost:7777` scenariusz NIE przechodzi do czasu restartu serwera (OP-1) — to warunek środowiskowy, nie defekt kodu fazy 2. Bonus E2E: potwierdzono na żywo pre-existing P3-15 (`API.post` bez `res.ok` → fałszywy toast sukcesu przy 400).

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 1
- Odznaczone na podstawie Agent 5 E2E: 1
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `npm test zielony (w tym node --test lib/telegram.test.js, lib/db.test.js)` → PASS (komendy: `npm test` → 230/230, exit 0; `node --test lib/telegram.test.js lib/db.test.js` → 41/41, exit 0)
- [x] E2E: `scenariusz E2E przez agent-browser przechodzi (formularz zapisuje i odczytuje flagę)` → PASS na świeżej instancji z kodem fazy 2 (port 7799); na produkcyjnym `localhost:7777` wymaga restartu serwera — przeniesione do Operator checklist (OP-1)

Bookkeeping nie dodał nowych P2/P3 — severity gate bez zmian po kroku 4.7.

## Severity gate (finalny)

**⛔ WYMAGA POPRAWEK — 2 problemy P1 (R9 martwe w domyślnej konfiguracji) blokują kontynuację do fazy 3.** Dodatkowo 4×P2 (DoS pętla, off-by-one chunkingu, 2 luki testowe na szwie `notifyRunOutcome`/guard killed) do naprawy w kroku fix. 19×P3 do rozważenia (rekomendacja: P3-1, P3-2, P3-5 domknąć razem z fixami P1/P2 — leżą na tych samych ścieżkach). 2×OPERATOR poza gate.
