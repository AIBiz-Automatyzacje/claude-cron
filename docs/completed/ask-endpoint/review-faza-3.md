# Review fazy 3 — Unit 5 (endpoint `POST /ask/:token`) + Unit 6 (reaper ❌ dla teczki)

Data: 2026-07-14
Zadanie: `docs/active/ask-endpoint/`
Plan: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`
Findings po adversarial verify (P1 = 3 sceptyków, P2 = 1).

## Werdykt: ⛔ BLOKUJE

**⛔ WYMAGA POPRAWEK — znaleziono 1 problem P1 blokujący kontynuację** (unbounded body na publicznym endpoincie przed autoryzacją = wektor OOM całego schedulera).

## Statystyki

| Severity | KOD | TEST | E2E | OPERATOR | Razem |
|---|---|---|---|---|---|
| P1 | 1 | 0 | 0 | — | 1 |
| P2 | 2 | 0 | 0 | — | 2 |
| P3 | 13 | 4 | 0 | — | 17 |
| OPERATOR | — | — | — | 2 | 2 |
| **Suma** | **16** | **4** | **0** | **2** | **22** |

Bookkeeping checkboxów `Weryfikacja:` nie dodał żadnych nowych P2/P3 (3× PASS — szczegóły na końcu raportu).

---

## P1 — blocking

### P1-1 [KOD] `server.js:451` — unbounded body na publicznym `/ask/:token` PRZED autoryzacją → OOM całego schedulera

`readTextBody` bez limitu rozmiaru body na publicznym endpoincie `/ask/:token`, a body czytane w całości PRZED autoryzacją. `matchAskToken` to czysty regex (przepuszcza dowolny token), endpoint stoi przed guardem `X-Forwarded-For`, więc przy `ASK_ENABLED=1` nieuwierzytelniony atakujący z internetu (Funnel) streamuje dowolnie duże body — `body += chunk` rośnie bez ograniczeń (rate limit w `admitRequest` liczy się dopiero PO pełnej konsumpcji streama, auth-fail w ogóle nie jest rate-limitowany). Kilka równoległych requestów po kilkaset MB = OOM procesu na VPS = śmierć całego schedulera (wszystkie joby). Pytanie głosowe to maks. kilka KB — dodaj cap (np. 64 KB): po przekroczeniu `req.destroy()` + odmowa, licznik długości zamiast konkatenacji do skutku. Narusza też regułę coding-rules §9 „rate limiting na KAŻDYM public endpoint" (ścieżka auth-fail nielimitowana).

---

## P2 — important

### P2-1 [KOD] `server.js:423` — `readTextBody`: brak limitu + brak obsługi `error`/`aborted` na streamie requesta

`readTextBody` buforuje CAŁE body do stringa bez limitu rozmiaru i bez obsługi zdarzenia `error` na streamie requesta — na publicznym endpoincie (Funnel) i PRZED autoryzacją (`admitRequest` woła się dopiero po odczycie body, więc rate limit nie chroni). Intruz bez sekretu może streamować setki MB per połączenie (pamięć rośnie zanim padnie 403); abort klienta w połowie body emituje `error` na req bez listenera (ryzyko uncaughtException) i zostawia nierozwiązaną promise (`end` nigdy nie nadejdzie). Wzorzec skopiowany z `parseBody`, ale to NOWA instancja na NOWEJ publicznej powierzchni — reguła „waliduj każdy input na granicy API". Fix: limit rozmiaru (pytanie głosowe to pojedyncze KB — np. 16 KB, powyżej destroy + 403/413) + listener `error`/`aborted` resolvujący promise. *(Nakłada się z P1-1 — wspólny fix helpera czytania body zamyka oba.)*

### P2-2 [KOD] `server.js:422` — brak `req.setEncoding('utf8')` → U+FFFD na rozciętym znaku wielobajtowym

`readTextBody` skleja chunki przez `body += chunk` (`Buffer.toString()` per chunk) bez `req.setEncoding('utf8')` — znak wielobajtowy UTF-8 rozcięty między chunki daje U+FFFD. Udowodnione eksperymentalnie: „pytanie o pogodę" rozcięte w środku „ę" → „pytanie o pogod��". To główna ścieżka wejścia polskiego endpointu głosowego (diakrytyki w praktycznie każdym pytaniu), a request idzie przez proxy Tailscale Funnel, więc granice chunków są poza kontrolą. Fix jednoliniowy: `req.setEncoding('utf8')` przed handlerem `data` (string_decoder poprawnie buforuje niedokończone sekwencje). Uwaga: `parseBody` (server.js:41) ma identyczną wadę, ale to kod sprzed fazy — dla webhooka `JSON.parse` zepsutego body i tak wpada w catch.

---

## P3 — nit / sugestie

### P3-1 [KOD] `server.js:41` — `parseBody` z tą samą luką unbounded body (pre-existing, konsumowany przez publiczny `/webhook/:token`)

`parseBody` ma identyczną lukę unbounded body (`body += chunk` bez capa) i jest konsumowany przez publiczny `/webhook/:token` (`handleWebhook`, server.js:404) — ten sam wektor wyczerpania pamięci co finding P1. Poza diffem fazy 3 (pre-existing), ale nowy `readTextBody` świadomie powielił ten wzorzec zamiast go naprawić — zgłoszone zgodnie z regułą „nie dismissuj jako pre-existing". Fix najlepiej wspólny: jeden helper czytania body z limitem, używany przez oba.

### P3-2 [KOD] `lib/ask.js:77` — próby 403 całkowicie poza rate limitem (brute-force bez lockoutu)

Rate limit (`isRateLimited`) liczony jest dopiero PO pomyślnym `verifyAuth` — próby nieautoryzowane (403) są całkowicie nieograniczone, więc na publicznym endpoincie możliwy jest online brute-force pary token+sekret bez żadnego lockoutu/throttlingu. Entropia sekretów nie jest nigdzie wymuszana (`ASK_TOKEN`/`ASK_SECRET` to dowolne wartości env, brak generatora w setupie) — słaby sekret usera nie ma żadnej dodatkowej ochrony. Kolejność auth→rate-limit jest zgodna z planem (konspekt B), a intencja rate-limitu z konspektu (ochrona tokenów Claude przy wycieku linka) jest spełniona — dlatego P3 defense-in-depth, nie blocker. Reguła projektu „Rate limiting na KAŻDYM public endpoint" jest pokryta tylko dla ruchu autoryzowanego. Fix opcjonalny: osobny, luźny licznik prób 403 per okno (in-memory, ten sam wzorzec state) albo wymuszenie/wygenerowanie sekretów o wysokiej entropii w setupie.

### P3-3 [KOD] `server.js:446` — 405 przed autoryzacją = fingerprinting `ASK_ENABLED`

Odpowiedź 405 na nie-POST wychodzi PRZED autoryzacją, więc nieuwierzytelniony intruz może fingerprintować instancję: `GET /ask/x` → 405 oznacza `ASK_ENABLED=1`, a 403 oznacza wyłączony endpoint. To osłabia deklarowany kontrakt „bez jawnego ASK_ENABLED=1 endpoint nie istnieje dla świata" (komentarz w `handleAsk`) — istnienie funkcji jest rozróżnialne bez sekretów. Zachowanie jest zgodne z literą planu („nie-POST → 405"), stąd P3. Szczelniejszy wariant: 403 dla wszystkich requestów nieautoryzowanych niezależnie od metody (405 dopiero po auth albo wcale).

### P3-4 [KOD] `server.js:423` — zerwane połączenie w trakcie body → wisząca Promise `readTextBody`

`readTextBody` nie obsługuje zdarzeń `error`/`aborted` na req — przy zerwaniu połączenia w trakcie przesyłania body zdarzenie `end` nie nadejdzie i Promise nigdy się nie rozstrzyga, więc `handleAsk` wisi na await na zawsze (bez odpowiedzi; socket i tak martwy). Brak wycieku rezerwacji `admitRequest` (rezerwacja następuje dopiero po odczycie body), więc skutek to tylko wiszący handler i pamięć częściowego body do GC requestu. Ten sam wzorzec co pre-existing `parseBody` (server.js:41). Fix: `req.on('error', ...)` rozstrzygający Promise. *(Domknięte automatycznie przy fixie P2-1.)*

### P3-5 [KOD] `lib/ask.js:213` — lookup teczki przez pełny skan `getAllJobs().find(...)`

`notifyInterruptedAskRuns` robi lookup teczki przez `db.getAllJobs().find(job => job.name === ASK_JOB_NAME)` — pełny odczyt wszystkich jobów (wszystkie kolumny), żeby znaleźć jeden po nazwie. Wykonywane raz na boot przy małym n, spójne z istniejącym wzorcem `getOrCreateAskJob`/starter-jobs — czysty nit; ewentualny helper `db.getJobByName(name)` z zapytaniem `WHERE name = ?` usunąłby duplikację wzorca w trzech miejscach.

### P3-6 [TEST] `lib/ask.http.test.js` — brak testu granicy rozmiaru body (po wprowadzeniu capa z P1-1)

Po wprowadzeniu capa rozmiaru body (finding P1-1) brakuje testu HTTP na żywym serwerze: POST z body przekraczającym limit → odmowa bez akumulacji (i analogicznie brak regresji dla body tuż pod limitem). Obecne 8 testów pokrywa kontrakt auth/kolejności matcherów/współbieżności, ale nie granicę rozmiaru wejścia.

### P3-7 [KOD] `server.js:461` — leaky abstraction pary rezerwacji admitRequest

Handler `handleAsk` (ścieżka pustego body) musi znać wewnętrzny szczegół `admitRequest` — że rezerwuje DOKŁADNIE lock sync + slot tła — i ręcznie wołać `releaseSyncLock()`+`releaseBackgroundSlot()`. Ta sama para jest już zwalniana wewnątrz `lib/ask.js:280-281` (pad spawnu). Kapsułka `ask.releaseAdmission()` trzymałaby definicję pary po stronie modułu ask: `server.js` przestaje znać stan współbieżności ask, a przyszła zmiana zestawu rezerwacji (np. czwarta bramka) nie wymaga edycji `server.js`.

### P3-8 [KOD] `lib/ask.js:213` — duplikacja lookupu teczki (linie 119 i 213)

Identyczne wyrażenie `db.getAllJobs().find((job) => job.name === ASK_JOB_NAME)` w `getOrCreateAskJob` (linia 119) i `notifyInterruptedAskRuns` (linia 213). Reguła „shared logic do dedykowanego miejsca przy 2+ użyciach" — wyciągnij prywatny `findAskJob()`. Przy okazji: pełny skan `getAllJobs()` zamiast zapytania po name (wydajnościowo pomijalne przy kilku jobach, ale helper skupiłby też ewentualną przyszłą zmianę na `db.getJobByName` w jednym miejscu).

### P3-9 [KOD] `lib/ask.js:1` — plik 385 linii (> 300), trzy odpowiedzialności

Plik ma 385 linii (> 300 wg reguły rozmiaru) i trzy odpowiedzialności: bramki admisji (auth/rate/lock/sloty), cykl życia procesu (spawn/odczepienie/finalize) i warstwę powiadomień. Faza 3 dołożyła do trzeciej kolejną funkcję (`notifyInterruptedAskRuns`). Naturalny szew podziału: `sendAskNotification` + `notifyAskOutcome` + `notifyInterruptedAskRuns` + `STDERR_TAIL_LEN` do `lib/ask-notify.js` (zależności tylko db/discord/telegram, zero cykli — ask importowałby ask-notify jednostronnie).

### P3-10 [KOD] `lib/ask.js:218` — N przerwanych runów teczki = N identycznych, nieodróżnialnych ❌

Przy N>1 przerwanych runach teczki user dostaje N IDENTYCZNYCH wiadomości ❌ — komentarz deklaruje „każde odczepione pytanie ma swój wynik", ale wiadomości są nieodróżnialne (nie wiadomo, które pytanie ponowić). `reapedRuns` niesie tylko `{id, job_id}`; wystarczy doczyt `db.getRunWithPayload(run.id)` w pętli (albo `webhook_payload` w zwrotce reapera) i skrót pytania w treści ❌. Plan literalnie tego nie wymagał, więc nit — ale intencja R7 „każde pytanie ma swój wynik" jest spełniona tylko formalnie.

### P3-11 [KOD] `server.js:439` — `TEXT_EMPTY_QUESTION` poza katalogiem tekstów w `lib/ask.js`

Rozjazd kohezji katalogu tekstów „dla człowieka": `TEXT_EMPTY_QUESTION` mieszka w `server.js`, podczas gdy wszystkie pozostałe teksty głosowe (`TEXT_RATE_LIMIT`, `TEXT_SYNC_BUSY`, `TEXT_SLOTS_FULL`, `TEXT_DETACHED`, `TEXT_SYNC_FAILED`) żyją w `lib/ask.js`. Spójne miejsce (lib/ask.js, eksport jak pozostałe) ułatwia utrzymanie jednolitego stylu komunikatów asystenta i ich ewentualną przyszłą lokalizację; obecnie zmiana tonu komunikatów wymaga edycji dwóch plików w dwóch warstwach.

### P3-12 [TEST] `lib/ask.http.test.js:50` — `waitForServerReady` skopiowane 1:1 z `server.env.test.js`

Timeout 10 s + matchowanie frazy logu „Puls running". Dwa użycia = próg ekstrakcji wspólnego helpera testowego; dopuszczalne wg „duplication > complexity", ale fraza logu startowego staje się cichym kontraktem utrwalonym w DWÓCH plikach — zmiana komunikatu startowego serwera (np. rebranding logów) wywali oba pliki timeoutem 10 s bez czytelnej przyczyny.

### P3-13 [TEST] `lib/ask.http.test.js:176` — test pustego body nie asertuje „bez tworzenia runu" z własnej nazwy

Test „puste body → 200 z przyjaznym tekstem, bez tworzenia runu" NIE asertuje drugiej połowy własnej nazwy — sprawdza tylko status/content-type/tekst, brak asercji, że w `/api/runs` nie przybył run (wystarczy zliczyć runy przed i po, bo happy path wcześniej już jeden utworzył). Nazwa testu obiecuje weryfikację zachowania, którego test nie weryfikuje — regresja tworząca run na pustym body przeszłaby zielono. Podobnie zwolnienie OBU rezerwacji po pustym body jest pokryte tylko pośrednio (kolejny test SLEEP by padł) — krucha zależność od kolejności testów w pliku.

### P3-14 [KOD] `server.js:441` — R11 „logowanie każdego wywołania" spełnione tylko dla zapytań przyjętych

R11 wymaga „logowanie każdego wywołania w konsoli (jak [webhook])", a Unit 5 deklaruje R11 w swoich wymaganiach. Logowane są tylko zapytania przyjęte („[ask] run #N: start" w `executeAsk`); odmowy — 403 (zły token/sekret na publicznym endpoincie), rate limit, „jeszcze myślę", „pełne ręce", puste body — nie zostawiają żadnego śladu w konsoli. Dla endpointu z sekretami brak logu prób 403 utrudnia też wykrycie brute-force. Częściowy parytet z webhookiem (ten też nie loguje odmów) łagodzi do P3, ale literalne „każde wywołanie" nie jest spełnione.

### P3-15 [KOD] `lib/config.js:10` — odchylenie od sekcji Pliki planu U5: nowe env-vary `CLAUDE_CRON_DB_PATH` i `CLAUDE_CRON_CLAUDE_BIN` nieudokumentowane

Plan U5 wymienia tylko `server.js`, `public/enum-map.js` + testy; zmodyfikowano dodatkowo `lib/config.js`, wprowadzając DWA nowe produkcyjne env-vary. Odchylenie jest udokumentowane w kontekście i funkcjonalnie uzasadnione (test HTTP na żywym procesie nie może pisać do realnej bazy usera ani spawnować prawdziwego CLI), ale nowe env-vary nie są dopisane do `CLAUDE.md` (sekcja „config.js — jedyne źródło stałych i env-varów" wylicza `CLAUDE_CRON_*`) — do uzupełnienia najpóźniej przy kroku dokumentacyjnym planu.

### P3-16 [KOD] `lib/ask.js:212` — defensive code: guard `!reapedRuns` na niemożliwy scenariusz

Jedyny caller (`server.js:527`) przekazuje wynik `db.reapOrphanedRuns()`, który ZAWSZE zwraca tablicę (pustą lub z elementami), testy również podają tablice. Wystarczy `reapedRuns.length === 0`. Naruszenie reguły „nie twórz defensive code na scenariusze które nie mogą wystąpić".

### P3-17 [TEST] `lib/ask.js:211` — brak testu z WIELOMA przerwanymi runami teczki

Kontrakt „jedno ❌ per przerwany run" (pętla w `notifyInterruptedAskRuns`, do 3 odczepionych zadań naraz przy `MAX_BACKGROUND_SLOTS=3`) nie ma testu z WIELOMA przerwanymi runami teczki — testy szwu pokrywają tylko 1 run teczki, 1 run zwykłego joba i pustą listę. Regresja typu „jedno zbiorcze ❌ zamiast per-run" albo „break po pierwszym" przeszłaby zielono. Scenariusz mieszany (2 runy teczki + 1 zwykły w jednym reap → dokładnie 2 ❌) domknąłby lukę. Plan nie wymagał tego wprost, stąd P3.

---

## Zgodność ze spec

- **R5/R7/R9 (Unit 6)**: reaper zwraca listę, runy teczki dostają ❌ po restarcie — kontrakt spełniony; intencja R7 „każde pytanie ma swój wynik" spełniona tylko formalnie (N identycznych ❌ — P3-10).
- **R11 (logowanie każdego wywołania)**: spełnione częściowo — tylko zapytania przyjęte, odmowy bez śladu (P3-14).
- **Kontrakt „nie-POST → 405"**: zgodny z literą planu, ale 405 przed auth pozwala fingerprintować `ASK_ENABLED` (P3-3).
- **Kolejność auth → rate-limit**: zgodna z planem (konspekt B); ścieżka 403 poza limitem to świadomy trade-off planu, zgłoszony jako defense-in-depth (P3-2).
- **Odchylenie od sekcji Pliki U5**: dodatkowa modyfikacja `lib/config.js` (2 nowe env-vary) — uzasadniona testowalnością, wymaga dopisania do `CLAUDE.md` (P3-15).
- **Smoke curlem (konspekt E)**: wykonany na żywym serwerze podczas bookkeepingu — 200 `text/plain; charset=utf-8` przy poprawnym sekrecie, 403 bez sekretu (szczegóły niżej).

## Operator checklist faza 3 (niewykonalne headless)

1. **[OPERATOR]** `docs/plans/2026-07-13-001-...-plan.md:358` — Happy path z PRAWDZIWĄ binarką `claude` (OAuth token z `~/.claude-cron-oauth-token`, model sonnet) oraz dostępność `/ask` przez realny Tailscale Funnel są niewykonalne headless — testy pokrywają to atrapą CLI i nagłówkiem `X-Forwarded-For` symulującym Funnel. Wymaga smoke-testu curlem z innej maszyny po deployu (już ujęte w Operator checklist planu: poprawny sekret → odpowiedź; bez sekretu → 403).
2. **[OPERATOR]** `docs/plans/2026-07-13-001-...-plan.md:355` — Operator checklist Unit 6 niewykonalny headless: deploy na VPS z realnymi `ASK_TOKEN`/`ASK_SECRET`, test curlem z innej maszyny przez Tailscale Funnel (poprawny sekret → odpowiedź; bez sekretu → 403), włączenie kanału powiadomień na jobie „Asystent głosowy" w panelu, budowa Shortcuta na Macu i pomiar realnego limitu czekania akcji „Pobierz zawartość URL" (ew. korekta `ASK_TIMEOUT_MS`). Testy HTTP na żywym serwerze pokrywają logikę lokalnie, ale granica Funnel/XFF w realnej sieci i limit Shortcuts wymagają fizycznej weryfikacji operatora.

## E2E

Faza 3 nie miała scenariuszy E2E browser (endpoint bez UI poza etykietą triggera w enum-map, pokrytą testem jednostkowym). Testy HTTP na żywym procesie serwera (`lib/ask.http.test.js`, 8 testów) przechodzą w ramach `npm test`. Dwa scenariusze E2E niewykonalne headless (realny Funnel + prawdziwa binarka `claude`; Shortcut na Macu) → Operator checklist.

- passed: 0, failed: 0, skipped: 2 (oba → Operator checklist)

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 3
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `npm test przechodzi; lib/ask.http.test.js pokrywa scenariusze Unit 5 na żywym procesie serwera` → PASS (komenda: `npm test` — 332 pass, 0 fail; w tym 8 testów `lib/ask.http.test.js`)
- [x] CLI: `smoke curlem (konspekt E) zwraca text/plain` → PASS (wykonany realny smoke na żywym serwerze z env-override: tymczasowa baza `CLAUDE_CRON_DB_PATH`, atrapa CLI `CLAUDE_CRON_CLAUDE_BIN`, port 17877; `curl -X POST -H 'X-Secret: …' /ask/<token>` → `200` + `Content-Type: text/plain; charset=utf-8`, body = stdout atrapy; bez sekretu → `403`; log `[ask] run #1: start/koniec (success)`)
- [x] CLI: `npm test przechodzi; test szwu w lib/ask.test.js i zwrotka reapera w lib/db.test.js pokrywają scenariusze Unit 6` → PASS (komenda: `npm test` — 332 pass, 0 fail)

Krok 5 (re-aktualizacja gate'u): bookkeeping nie dodał nowych P2/P3 — gate pozostaje **⛔ BLOKUJE** (1× P1).
