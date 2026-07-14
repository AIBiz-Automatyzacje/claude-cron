# Review — Faza 2: Unit 3 (bramki wejścia i teczka) + Unit 4 (wykonanie: spawn, odczepienie, powiadomienia) w `lib/ask.js`

Data: 2026-07-14
Zakres: Unit 3 (verifySecret, rate limiter, lock sync + sloty tła, getOrCreateAskJob) + Unit 4 (executeAsk, wyścig close vs ASK_TIMEOUT_MS, odczepienie, finalize, powiadomienia plain-text, ASK_MAX_MS + kill drzewa)
Źródło findingów: multi-agent review + adversarial verify (P1: 3 sceptyków, P2: 1 sceptyk)

## Statystyki

| Severity | KOD | TEST | E2E | OPERATOR | Razem |
|----------|-----|------|-----|----------|-------|
| P1       | 0   | 0    | 0   | —        | 0     |
| P2       | 1   | 0    | 0   | —        | 1     |
| P3       | 11  | 3    | 0   | —        | 14    |
| OPERATOR | —   | —    | —   | 1        | 1     |
| **Razem**| 12  | 3    | 0   | 1        | 16    |

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 do naprawy** (zero P1; P3/OPERATOR nie blokują).

## Findings

### P2 (important)

1. **[KOD] `lib/ask.js:296`** — Slot tła zwalniany wyłącznie w `settle()` na zdarzeniu `'close'`, a `killProcessTree` na Unix (`lib/ask.js:161-168`) zabija tylko bezpośrednie dziecko (SIGTERM/SIGKILL do `proc.pid`, bez grupy procesów). Wnuk CLI dziedziczący stdout/stderr trzyma pipe po SIGKILL rodzica, więc `'close'` nigdy nie nadchodzi i slot wycieka na zawsze — 3 takie zdarzenia = permanentne „⏳ Mam pełne ręce" (DoS `/ask` do restartu serwera). Komentarz przy `maxTimerId` (linia 272) sam przyznaje ryzyko „zombie bez zdarzenia close" i zabezpiecza finalize, ale NIE zwolnienie slotu. **Fix:** dodatkowo `proc.on('exit', ...)` wołające `settle` — guard `settled` już chroni przed podwójnym zwolnieniem.

### P3 (nit)

2. **[KOD] `lib/ask.js:1`** — Plik ma 335 linii — łamie regułę „Plik > 300 linii = refaktoruj" z coding-rules, a moduł ma dwie wyraźne odpowiedzialności rozdzielone już przez sam plan na Unit 3 (bramki wejścia: verifySecret/admitRequest/release*/getOrCreateAskJob — czysta logika decyzyjna ze stanem in-memory) i Unit 4 (cykl życia wykonania: executeAsk/finalizeAskRun/notifyAskOutcome/killProcessTree — orkiestracja spawn+DB+kanały). Kontekst-doc uczciwie zgłasza problem („do rozważenia splitu w kolejnych fazach"), ale Unit 6 doda do tego samego pliku kolejną funkcję (powiadomienie reapera o przerwaniu), więc plik dalej urośnie. Split na np. `ask-gates.js` + `ask.js` (SRP na poziomie pliku) jest najtańszy TERAZ, zanim Unit 5 (server.js) zwiąże się z kształtem eksportów; granica jest naturalna — jedyny szew to para releaseSyncLock/releaseBackgroundSlot wołana z executeAsk.

3. **[KOD] `lib/ask.js:77`** — Rate limit liczony dopiero PO udanej autoryzacji (kolejność bramek auth → rate limit): ścieżka 403 jest całkowicie nielimitowana, więc brute-force pary token+sekret nie podlega throttlingowi (reguła projektu: rate limiting na każdym public endpoint; `/ask/:token` jest publiczny przez Funnel). Realna mitygacja istnieje (timingSafeEqual + długie losowe sekrety z env), a kolejność ma zaletę anty-DoS (intruz nie zużyje kubła legalnego usera), ale trade-off nie jest udokumentowany. Rekomendacja: komentarz dokumentujący decyzję lub osobny, luźny licznik prób 403 per okno.

4. **[KOD] `lib/ask.js:44`** — `verifySecret` zdradza timingiem długość skonfigurowanego sekretu: early return przy różnej długości buforów PRZED `timingSafeEqual` (atakujący może iteracyjnie ustalić długość ASK_TOKEN/ASK_SECRET po czasie odpowiedzi). Zachowanie zgodne z literą planu (R2: „guard długości bufora"), więc to hardening, nie odstępstwo od spec: porównywać skróty SHA-256/HMAC obu wartości (stała długość buforów) zamiast guardu długości — eliminuje leak bez ryzyka wyjątku timingSafeEqual.

5. **[KOD] `lib/ask.js:119`** — `getOrCreateAskJob` robi `db.getAllJobs().find(job => job.name === ASK_JOB_NAME)` przy KAŻDYM przyjętym zapytaniu — ładuje pełną kolekcję jobów ze wszystkimi kolumnami, żeby znaleźć jeden rekord po name (reguła perf 12: nie ładuj pełnych kolekcji dla subsetu). Przy skali projektu (rate limit 10/min, kilkanaście jobów) wpływ marginalny — nit: zapytanie `WHERE name = ?` w db.js albo cache `job.id` po pierwszym wywołaniu.

6. **[KOD] `lib/ask.js:257`** — `stdout += chunk` akumuluje output w RAM bez limitu przez cały cykl życia procesu (do ASK_MAX_MS = 10 min); `truncateTail` do MAX_LOG_SIZE (50KB) działa dopiero przy `finalizeAskRun`, a `notifyAskOutcome` (linie 182-188) przekazuje do `sendPlain` PEŁNY nieucięty stdout — przy nietypowo dużym outpucie `smartSplit` wygeneruje setki sekwencyjnych POST-ów do webhooka (rate limit Discord/Telegram → 429; pętla w sendPlain przerywa się na pierwszym błędzie). W praktyce `--output-format text` daje krótkie odpowiedzi, a wzorzec akumulacji jest spójny z executorem — nit: przytnij tekst przed sendPlain (spójnie z tym, co ląduje w DB).

7. **[KOD] `lib/ask.js:153`** — `truncateTail()` to duplikacja 1:1 funkcji `truncate()` z `lib/executor.js:11-14` (identyczna implementacja: guard pustego stringa + `slice(-max)`, nawet komentarz „wzorzec executora" przyznaje pochodzenie). Reguła „Wyciągaj shared logic do dedykowanego modułu" + „abstrakcja dopiero gdy jest 2+ użycia" — użycia są już DWA. Naturalny dom: `lib/notify-format.js` (obok smartSplit — oba to formatowanie tekstu do limitu) albo `lib/claude-spawn.js`. Trzylinijkowa funkcja, więc waga niska (Duplication > Complexity), ale ryzyko rozjazdu semantyki ogona logów między executorem a ask jest realne przy przyszłej zmianie.

8. **[KOD] `lib/ask.js:58`** — Nazewnictwo: `isRateLimited(now)` ma prefix `is*` (konwencja: czyste boolean query bez side-effectów), ale funkcja MUTUJE stan — resetuje okno i konsumuje budżet (`state.rateWindow.count += 1`). Czytelnik `admitRequest` zakłada, że to predykat, tymczasem samo sprawdzenie zużywa slot limitu (świadoma decyzja — odmowy locka liczą się do limitu — ale nazwa ją ukrywa). Lepsza nazwa: `consumeRateLimitBudget()` / `tryTakeRateSlot()`. Funkcja nieeksportowana, więc koszt zmiany zerowy.

9. **[KOD] `lib/ask.js:163`** — Puste bloki `catch {}` w `killProcessTree` (linie 163, 166, 167) — reguła coding-rules „NIGDY nie używaj pustego catch {} — zawsze loguj albo re-throw". Kontekst-doc audytował to i uzasadnia wzorcem executora (wyścig ESRCH — proces mógł już umrzeć), co jest merytorycznie słuszne dla kill, ale nawet wtedy konwencja wymaga minimum jawnego komentarza w samym catch lub debug-logu; obecnie wyjątek inny niż ESRCH (np. EPERM) też zniknie bez śladu. Nit — spójne z istniejącym kodem executora, do wyrównania przy okazji splitu modułu.

10. **[KOD] `lib/ask.js:282`** — Duplikacja literału `` `Przekroczony limit ${askMaxMs}ms (ASK_MAX_MS)` `` w maxTimer (linia 282) i handlerze close (linia 308). Drift jednej kopii rozjedzie treść error_msg/❌ zależnie od tego, która ścieżka domknęła run — wyciągnąć do jednej stałej/funkcji budującej komunikat.

11. **[KOD] `lib/ask.js:142`** — Treść komunikatu odczepienia niezgodna z literalną treścią spec. R5 planu i konspekt (`docs/konspekt-endpoint-ask.md:71`) cytują: „⏳ Za długie na szybką odpowiedź — robię w tle, wynik przyjdzie powiadomieniem"; zaimplementowano `TEXT_DETACHED` = „⏳ To zajmie chwilę — robię w tle, dam znać na komunikatorze". Sens zachowany, ale testy assertują na stałą modułu, nie na treść ze spec — wyrównać do spec albo świadomie zaakceptować odstępstwo w kontekście fazy.

12. **[KOD] `lib/ask.js:161`** — `killProcessTree` duplikuje kill drzewa z executora (`forceKillProc`/`gracefulKillProc`, `executor.js:131-147`) — duplikacja usankcjonowana planem („kill drzewa zostaje w executorze"), ale wersje już się rozjeżdżają (ask ma `.unref()` na timerze SIGKILL, executor nie). Dwie kopie tej samej semantyki z drobnymi różnicami to przyszły koszt utrzymania; kandydat do `claude-spawn.js` gdy pojawi się trzeci użytkownik.

13. **[TEST] `lib/ask.test.js:446`** — Brak testu gałęzi sync-fail przez close z exit!=0: proces kończy się PRZED ASK_TIMEOUT_MS z kodem niezerowym (`lib/ask.js:307` → status `failed`, odpowiedź TEXT_SYNC_FAILED, run failed, zero powiadomień). Pokryte są tylko pokrewne ścieżki: pad spawnu przez zdarzenie `'error'` (ENOENT) i pad procesu ODCZEPIONEGO — gałąź „zdążył i padł" w trybie sync pozostaje bez asercji (reguła repo: każda funkcja = happy path + error case).

14. **[TEST] `lib/ask.test.js:304`** — Ścieżka `notifyAskOutcome → discord.sendPlain` nigdy nie jest wykonana w testach ask: scenariusze odczepienia używają wyłącznie `telegram_notify=1` (discord asertowany jako 0), a jedyny test z oboma flagami=1 to sync happy path, gdzie oczekiwane jest zero wywołań. Brak testu: odczepienie + `discord_notify=1` i `telegram_notify=1` → dokładnie jedno ✅ na KAŻDYM z dwóch kanałów (`lib/ask.js:187-188`).

15. **[TEST] `lib/ask.js:203`** — `truncateTail` (obcięcie stdout/stderr runu do `config.MAX_LOG_SIZE`=50KB w `finalizeAskRun`) bez żadnego pokrycia — wszystkie atrapy CLI w testach generują krótkie outputy, więc gałąź obcinania (i semantyka „ogon, nie początek") nie jest weryfikowana. Wystarczy atrapa pisząca >50KB + asercja `run.stdout.length <= MAX_LOG_SIZE` i że ogon zawiera końcówkę outputu.

### OPERATOR (poza automatyzacją headless)

16. **[OPERATOR] `lib/ask.js:162`** — Gałąź Windows nieweryfikowalna headless na macOS: `killProcessTree` używa `taskkill /PID /T /F`, a wszystkie testy spawnu w `lib/ask.test.js` mają skip na win32 (atrapa CLI przez shebang wymaga POSIX — powód jawnie udokumentowany w teście). Ścieżka kill + pełny cykl executeAsk na Windows wymagają uruchomienia suite'u na realnej maszynie Windows — analogicznie do findingu OPERATOR z review fazy 1 dla `resolveClaudeBin`. Nie defekt kodu — pozycja do checklisty operatora przed deployem, jeśli instalacja Windows ma używać `/ask`.

## Zgodność ze spec

Po adversarial verify jedno odchylenie od litery spec (nieblokujące):

- **Finding #11 (P3, `lib/ask.js:142`)** — treść `TEXT_DETACHED` różni się od cytatu z R5 planu i konspektu („⏳ Za długie na szybką odpowiedź — robię w tle, wynik przyjdzie powiadomieniem" vs zaimplementowane „⏳ To zajmie chwilę — robię w tle, dam znać na komunikatorze"). Sens i kontrakt zachowane (200 + tekst ⏳, proces żyje), testy spójne z implementacją — do wyrównania albo świadomej akceptacji.

Poza tym implementacja Unit 3 i Unit 4 zgodna z planem: kolejność bramek, rezerwacja pesymistyczna slotów, decyzje `{status, text}`, run teczki z `trigger_type:'ask'`, wyścig close vs ASK_TIMEOUT_MS z odczepieniem bez killa, idempotentny finalize z re-read z DB (guard `killed`), seam plain-text w kanałach, ASK_MAX_MS → kill drzewa → `timeout` → ❌. Finding #4 potwierdza wręcz zgodność z literą R2 (guard długości) — rekomendacja to hardening ponad spec.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `npm test przechodzi; lib/ask.test.js pokrywa wszystkie scenariusze Unit 3 z asercjami na treść tekstów` → PASS (komendy: `npm test` 318/318 pass, `node --test lib/ask.test.js` 26/26 pass)
- [x] CLI: `npm test przechodzi; scenariusze Unit 4 w lib/ask.test.js z mockami wyłącznie na kanałach, spawn realny przez node + skrypty tmp` → PASS (komendy: `npm test` 318/318 pass, `node --test lib/ask.test.js` 26/26 pass, 0 skipped na macOS)

Bookkeeping nie dodał żadnych nowych P2/P3 — liczniki i severity gate bez zmian po kroku 5 (re-aktualizacja): **⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1× P2**.

## E2E

Faza 2 nie ma powierzchni E2E browser (czyste moduły lib/, zero UI; endpoint HTTP powstaje dopiero w Unit 5). E2E: passed 0, failed 0, skipped 0.
