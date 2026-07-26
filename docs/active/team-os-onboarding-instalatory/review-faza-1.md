# Review fazy 1 — Team OS: onboarding członka w instalatorach

Data: 2026-07-26
Zakres: Faza 1 — IU-1.1 (`scripts/inbox/invite.mjs` + testy, ekstrakcja z `setup.mjs`), IU-1.2 (`lib/inbox-seed.js` — rola maszyny)
Severity gate: **BLOKUJE** (1 × P1)

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi łącznie (po dedupie i adversarial verify) | 30 |
| P1 (KOD/TEST/E2E) | 1 |
| P2 (KOD/TEST/E2E) | 3 |
| P3 (KOD/TEST/E2E) | 23 |
| OPERATOR (poza fix, do checklisty) | 3 |
| E2E: passed / failed / skipped | 0 / 0 / 0 (tester E2E nie odpalił — brak warstwy UI) |
| Bookkeeping `Weryfikacja:` — CLI PASS / FAIL | 5 / 0 |
| Bookkeeping `Weryfikacja:` — Grep PASS / FAIL | 1 / 0 |

Rozkład po typach: KOD 17, TEST 10, OPERATOR 3.
Rozkład po plikach: `scripts/inbox/invite.mjs` 9, `scripts/inbox/invite.test.mjs` 5, `lib/inbox-seed.js` 5, `setup.mjs` 3, `server.js` 3, dokumentacja fazy 2, `setup.test.mjs` 1, `lib/inbox-seed.test.js` 1, bez pliku 1.

---

## P1 — blokujące

### 1. 🔴 P1 · KOD · `scripts/inbox/invite.mjs:51` — wstrzyknięcie dowolnych zmiennych do `.env` z kodu zaproszenia

Brak walidacji kształtu + brak escapowania. `parseInviteCode` zwraca **surowy** `hubUrl` (nie `parsedUrl.href`), a WHATWG `URL` po cichu usuwa CR/LF/TAB przy parsowaniu — string z newline'em przechodzi walidację protokołu i trafia nietknięty do `upsertDotenvLine`, który skleja `KEY="<wartość>"` bez escapowania. Token nie jest walidowany w ogóle (hub emituje `randomBytes(32).toString('hex')`, więc `/^[0-9a-f]{64}$/` byłoby dokładne).

**Zweryfikowane uruchomieniem modułu**: `parseInviteCode('puls-inbox:https://hub.example#tok\nNODE_OPTIONS=--require /tmp/evil.js')` → `writeInboxEnv` produkuje plik z osobną linią `NODE_OPTIONS=--require /tmp/evil.js`; wariant po stronie URL (`'puls-inbox:https://hub.example\nEVIL_VAR=1#tok'`) daje `hubUrl` z newline.

`env-loader.mjs` czyta `^([A-Z_][A-Z0-9_]*)=(.*)$` z `.env` i wpisuje do `process.env` skryptów skrzynki, a te przekazują env do spawnu `claude` (`buildCleanEnv` stripuje tylko `CLAUDE_CODE*`/`CLAUDECODE`). To granica zaufania poza warstwą API: skrypt przenosi zewnętrzny string (kod wklejony przez człowieka, dostarczony kanałem czatu) do zaufanego magazynu konfiguracji.

**Scenariusz:** członek dostaje na czacie kod `puls-inbox:https://hub.atakującego#0123..abcd\nNODE_OPTIONS=--require /tmp/x.js`; parse przepuszcza, probe do huba atakującego zwraca `{v:1}`, zapis tworzy dwie linie zamiast jednej; przy najbliższym runie joba skrzynki spawn `claude` ładuje plik atakującego → wykonanie dowolnego kodu z uprawnieniami daemona.

**Fix:** zwracać `parsedUrl.href`/`origin`, walidować charset tokenu, a `upsertDotenvLine` ma odrzucać wartości z `"`, CR, LF i znakami sterującymi (fail-closed).

---

## P2 — poważne

### 2. 🟠 P2 · KOD · `scripts/inbox/invite.mjs:79` — sekret zapisywany plikiem 0644

`writeInboxEnv` zapisuje `INBOX_TOKEN` plikiem o domyślnych uprawnieniach — **zweryfikowane**: nowo utworzony `.env` ma tryb 0644 (world-readable). Brak `{ mode: 0o600 }` przy tworzeniu i brak `chmodSync` dla pliku już istniejącego. Ten moduł jest JEDYNĄ ścieżką zapisu tokenu skrzynki dla obu instalatorów, a faza powstała po to, by domknąć incydent wycieku sekretów z 25/26.07 — brak zawężenia uprawnień jest w tej samej klasie co brak `.gitignore`.

**Scenariusz:** instalator na VPS zapisuje `~/vault/.env` w 0644; dowolny inny użytkownik systemu (lub przejęty proces na innym koncie) robi `cat` i dostaje ważny token, a token to CAŁA tożsamość w hubie (`/inbox/v1/:token/*`) — pozwala czytać cudze wątki (`pull`), domykać zadania (`done`) i wysyłać wiadomości podszywając się pod ofiarę (`from_user` hub wyprowadza z tokenu).

### 3. 🟠 P2 · KOD · `scripts/inbox/invite.mjs:139` — guard `.gitignore` fail-OPEN na sygnale niejednoznacznym

`queryGitignoreState` traktuje `result.error` (brak binarki gita, ENOENT/EACCES na spawnie) ORAZ `status === 128` jako `isRepo:false`, co `planGitignoreFix` mapuje na `not_a_repo`, a kontrakt guardu każe wtedy zapisywać sekret po cichu. 128 to generyczny kod fatalny gita (uszkodzony `.git`, problem uprawnień, błąd konfiguracji), nie tylko „to nie repo", a brak gita nie znaczy, że katalog nie jest repozytorium — vault bywa repo commitowanym z DRUGIEJ maszyny (dokładnie topologia tego zadania: laptop + VPS na wspólnym vaultcie).

Sprzeczne z doktryną samego modułu („guard, który nie potrafi potwierdzić bezpieczeństwa, odmawia operacji") i z learned-patterns 2026-07-03 (stan zewnętrznego CLI potwierdzaj stanem faktycznym) oraz 2026-07-24 (przy niepewności fail-closed).

**Scenariusz:** VPS bez gita, workspace `~/vault` będący klonem repo pushowanego z laptopa; `spawnSync` zwraca `error` → guard mówi `not_a_repo` → instalator zapisuje `INBOX_TOKEN` do nieignorowanego `.env` → pierwszy commit z laptopa wysyła token do historii gita, czyli powtórka incydentu 25/26.07.

**Fix:** odróżnić „git niedostępny/błąd" od „poza repo" (potwierdzenie obecnością `.git` w górę drzewa albo `git rev-parse --git-dir`) i przy nierozstrzygalności blokować zapis.

### 4. 🟠 P2 · TEST · `scripts/inbox/invite.test.mjs:76` — „siatka bezpieczeństwa" bez ani jednego wrogiego wejścia

Suita nazywa siebie „siatka bezpieczeństwa ekstrakcji", ale wszystkie wejścia `parseInviteCode`/`upsertDotenvLine`/`writeInboxEnv` są dobrze uformowane (happy path, trim, zły prefiks, brak `#`, pusty token, nie-http). Brakuje: (a) tokenu/URL-a z CR/LF (wektor wstrzyknięcia linii do `.env`, P1 wyżej), (b) wartości z `"` i znakami sterującymi, (c) wartości ze wzorcem `$&` (rozwijanie w `String.replace`), (d) asercji uprawnień utworzonego `.env`, (e) przypadku, w którym `git check-ignore` jest niedostępny (fail-open guardu).

Dokładnie te ścieżki niosą ryzyko bezpieczeństwa i dokładnie ich nie ma, więc zielone 533/533 nie jest dowodem bezpieczeństwa modułu, mimo że IU-1.1 deklaruje skill „security (materialnie)".

**Scenariusz:** ktoś wdroży walidację, a potem ją zrefaktoruje/cofnie i suita zostanie zielona — regresja wstrzyknięcia `.env` wraca niezauważona do obu instalatorów.

---

## P3 — drobne

### KOD

5. **`scripts/inbox/invite.mjs:161`** — `ensureEnvIgnored` przy wyniku `unfixable` zostawia ZAPISANY wcześniej `.gitignore` z dopisanym wzorcem `.env*` i nie informuje o tym wołającego (kontrakt zwrotu to tylko `{status, gitignoreFile}`). Guard deklarujący „nie potrafię potwierdzić bezpieczeństwa" jednocześnie zmutował plik śledzony w repo użytkownika; brak rollbacku. Scenariusz: użytkownik robi `git commit -a` i commituje cudzą zmianę `.gitignore`, zyskując fałszywe poczucie, że sprawa jest załatwiona.
6. **`setup.mjs:836`** — komunikat błędu probe'a drukowany dosłownie: `Hub skrzynki nie odpowiedział poprawnie (${probe.reason})`. `probe.reason` to `error.message` z `inbox-client`, a klient buduje URL z tokenem W ŚCIEŻCE. Część trybów awarii undici osadza pełny URL w treści komunikatu („Failed to parse URL from …") → token trafia do logu instalacji, który użytkownik wkleja adminowi. Fix: sanityzacja `reason` przed wypisaniem (wycięcie tokenu / whitelist krótkich powodów).
7. **`setup.mjs:841`** — guard istnieje, ale NIE jest wpięty: `askInboxInvite` nadal woła `writeInboxEnv` bez `ensureEnvIgnored`, więc R6 nie jest spełnione w ścieżce lokalnej. Plan przypisuje wpięcie do IU-2.3 (to nie odchylenie od zakresu fazy), ale konstrukcja „guard jako osobne, opcjonalne wywołanie obok zapisu" sprawia, że każde kolejne miejsce zapisu może o niego zapomnieć. Fix: `writeInboxEnv` sam odmawia zapisu, gdy guard zwróci `unfixable`.
8. **`lib/inbox-seed.js:86`** — `db.getAllJobs()` (`SELECT * FROM jobs ORDER BY id`) materializuje pełną kolekcję, by sprawdzić istnienie JEDNEJ nazwy filtrem w JS. Narusza regułę 12; właściwe jest punktowe `SELECT 1 FROM jobs WHERE name = ?`. Koszt dziś pomijalny, ale wzorzec się propaguje — IU-2.1 sięgnie do tej samej warstwy.
9. **`scripts/inbox/invite.mjs:133`** — `queryGitignoreState` odpala `spawnSync` dla KAŻDEJ sondy bez wczesnego wyjścia; w ścieżce `needs_fix` `ensureEnvIgnored` woła funkcję dwa razy → do 4 procesów gita na jedno wywołanie guardu. Dodatkowo `encoding: 'utf-8'` każe buforować stdout/stderr, których kod świadomie nie czyta — `stdio: 'ignore'` byłoby zgodne z intencją.
10. **`scripts/inbox/invite.mjs:136`** — `spawnSync` bez `timeout`: git na nieodpowiadającym montażu sieciowym zawiesza cały instalator bez komunikatu. Dorzucenie `timeout` i potraktowanie przekroczenia jak `result.error` domyka kontrakt „guard nie potrafi potwierdzić → nie blokuje w nieskończoność".
11. **`lib/inbox-seed.js:19`** — kontrakt wartości roli nie jest opublikowany: `ROLE_AGENT = 'agent'` zostaje prywatny (eksportowany jest tylko `ROLE_STATE_KEY`), a porównanie to strict equality. Pisarzem flagi ma być CLI z IU-2.1, które zapisze literał na ślepo — literówka daje CICHO rolę `client`. Eksportuj `ROLE_AGENT`/`ROLE_CLIENT` (lub `isValidRole`) zanim powstanie pisarz.
12. **`server.js:709`** — wiedza o tym, KTÓRY job odpowiada danemu statusowi, wyciekła z `lib/inbox-seed.js` do `server.js`: seed zwraca sklejony string, a `server.js` trzyma mapę `SEEDED_JOB_NAMES` tłumaczącą go z powrotem na nazwę joba, którą seed już znał. Czystszy kontrakt: zwrot `{ status, jobName }`.
13. **`setup.mjs:34`** — komentarz nad re-eksportem twierdzi „publiczna powierzchnia setup.mjs zostaje bez zmian", a `export const INVITE_CODE_PREFIX` zniknął z `setup.mjs`. Odchylenie jest świadome i opisane w `-zadania.md`, ale komentarz w kodzie mówi nieprawdę.
14. **`scripts/inbox/invite.mjs:83`** — spójność modułu: `invite.mjs` łączy dwie odrębne domeny — rdzeń kodu zaproszenia (parse → probe → zapis `.env`) i guard higieny sekretów w repo gitowym (~85 linii + zależność od `spawnSync`/gita). Guard nie zna pojęcia kodu zaproszenia i przyda się każdemu zapisowi sekretu do workspace'u. Osobny `scripts/inbox/gitignore-guard.mjs` trzymałby regułę „jedna odpowiedzialność per moduł".
15. **`lib/inbox-seed.js:81`** — kontrakt „seed nigdy nie rzuca / nie blokuje startu daemona" częściowo złamany: nowy odczyt `db.getState(ROLE_STATE_KEY)` (podobnie jak `getAllJobs`/`createJob`) leży POZA blokiem `try`, a `server.js:714` woła `seedInboxSyncJob().then(...)` bez `.catch()`. Wyjątek z warstwy DB przy starcie = unhandled rejection = ubity daemon. Komentarz nad funkcją stracił przy okazji frazę „Nigdy nie rzuca".
16. **`lib/inbox-seed.js:81`** — brak walidacji wartości flagi roli: spec definiuje dziedzinę dwuwartościową, implementacja robi wyłącznie `=== 'agent'`; KAŻDA inna wartość (`'Agent'`, `'agent\n'`, literówka z przyszłego `onboard.mjs`) cicho degraduje maszynę do roli `client` — czyli dokładnie problem, dla którego rola powstała. Warto znormalizować (trim/lowercase) i logować ostrzeżenie przy wartości spoza dziedziny.
17. **`scripts/inbox/invite.mjs:104`** — defensive code na scenariusz, który nie może wystąpić (anty-pattern #10): `planGitignoreFix` broni się `state?.isRepo`, `state?.isIgnored`, `typeof state?.gitignoreContent === 'string'`, choć jedyny wołający buduje argument na miejscu i obiekt jest zawsze pełny.
18. **`scripts/inbox/invite.mjs:79`** — `writeInboxEnv` robi nieatomowy read-modify-write na `<workspace>/.env`, a ten sam plik czyta `env-loader` przy KAŻDYM starcie script-joba skrzynki (cron `*/1`). Okno, w którym job wystartuje w trakcie zapisu, daje mu niekompletny plik → fail runu + alarm Telegrama. Tanio: zapis do pliku tymczasowego + `fs.renameSync`.

### TEST

19. **`setup.test.mjs:504`** — redundancja pokrycia po ekstrakcji: bloki `parseInviteCode` (504-543) i `upsertDotenvLine` (545-565) to 11 testów będących kopią 1:1 testów z `scripts/inbox/invite.test.mjs:78-142`. Jedynym powodem istnienia re-eksportu `export { parseInviteCode, upsertDotenvLine }` w `setup.mjs:36` są właśnie te duplikaty (grep: ZERO konsumentów produkcyjnych). Uproszczenie bez utraty pokrycia: usunąć bloki 504-565 i re-eksport; dowodem, że ekstrakcja nie zepsuła setupu, zostają testy `askInboxInvite` (setup.test.mjs:567+).
20. **`scripts/inbox/invite.test.mjs:207`** — gałąź `result.error` w `queryGitignoreState` (udokumentowany kontrakt, wprost w tabeli ryzyk planu: „git check-ignore niedostępny") nie ma testu; testy pokrywają wyłącznie exit-code 0/1/128. Scenariusz wykonywalny headless: podmienić `process.env.PATH` na pusty (ENOENT → `result.error`).
21. **`server.js:59`** — zgodność `INVITE_CODE_PREFIX` między hubem (literał CommonJS) a konsumentem (`scripts/inbox/invite.mjs:17`) trzyma się WYŁĄCZNIE na komentarzu „MUSI być identyczny" — brak testu szwu, mimo że faza deklaruje R8. Narusza learned pattern „założenie międzymodułowe = test szwu".
22. **`lib/inbox-seed.test.js:106`** — scenariusz IU-1.2 „`loadEnv` mutujący `process.env` → po wywołaniu wraca do stanu sprzed seeda" pokryty w połowie: test asertuje wyłącznie, że klucze DODANE przez `loadEnv` zniknęły. Gałąź `Object.assign(process.env, snapshot)` (daemon miał WCZEŚNIEJ ustawione `INBOX_HUB_URL`) nie jest testowana.
23. **`docs/active/team-os-onboarding-instalatory/team-os-onboarding-instalatory-zadania.md:25`** — bookkeeping fazy podaje nieprawdziwą liczbę testów: „26 testów" (powtórzone w `-plan.md:110` oraz `-kontekst.md:12` i `:96`), a plik ma **28** (potwierdzone `grep -c '^test('` i przebiegiem `node --test`: `# tests 28`). Przy okazji: „192 linie" `invite.mjs` vs faktyczne **191**.
24. **`scripts/inbox/invite.test.mjs:311`** — `probeInviteCode`: testowana wyłącznie gałąź przywracania env dla wartości NIEUSTAWIONYCH (`undefined` → `delete`). Gałąź „już były ustawione → przywróć poprzednią wartość" nie ma asercji, a to realny stan (ponowne wklejenie kodu, zmiana huba).
25. **`scripts/inbox/invite.test.mjs:291`** — brak testu najczęstszego realnego pada onboardingu: hub NIEOSIĄGALNY (ECONNREFUSED / timeout / DNS). Pokryta jest tylko zła wersja odpowiedzi (`v:2`). Ta ścieżka biegnie przez retry w `inbox-client`, więc różni się strukturalnie od v-mismatch.
26. **`server.js:710`** — mapa `SEEDED_JOB_NAMES` nie ma żadnego testu, a chroni dokładnie przed błędem, który faza naprawiała (rozszerzenie statusu → stary warunek `result === 'seeded'` nigdy nie trafiał i log cicho znikał).
27. **`scripts/inbox/invite.test.mjs:209`** — testy guardu zakładają, że workspace == korzeń repo. Brakuje najbardziej realnej konfiguracji z uzasadnienia zadania: vault jako PODKATALOG repozytorium (reguła `.env*` w `.gitignore` katalogu nadrzędnego).

---

## OPERATOR — poza automatyzacją (nie liczone do gate'u)

28. **P2 · maszyny już skonfigurowane** — guard działa wyłącznie na NOWYCH zapisach przez `invite.mjs`. Na realnych instalacjach (produkcyjny VPS „kacper" + laptop) `.env` z `INBOX_TOKEN` powstał przed istnieniem guardu, w trybie 0644 i bez weryfikacji `git check-ignore`; incydent 25/26.07 dotyczył wariantu `.env.bak`. Ryzyko przy pominięciu: faza 1 zostaje uznana za domykającą incydent, a produkcyjny vault dalej trzyma aktywny token w repo / na 0644, a token z wycieku nigdy nie zostaje odwołany.
29. **P3 · `docs/…-zadania.md:314`** — checklist „Ustawienie `inbox_role` na istniejących maszynach" nie domyka maszyn aktualizowanych w miejscu: seed nie robi `UPDATE` (R9, słusznie), więc na VPS-ie, który wcześniej dostał zaseedowany i WŁĄCZONY job sync, samo ustawienie `inbox_role='agent'` + restart da OBA joby aktywne naraz — konfiguracja dwóch maszyn synchronizujących Skrzynkę, przed którą chroni R5.
30. **P3 · `lib/inbox-seed.js:81`** — skutek ustawienia `inbox_role` na ISTNIEJĄCYCH maszynach da się sprawdzić tylko na realnym laptopie i produkcyjnym VPS-ie; kod tego nie zrobi (kontrakt R9), a test jednostkowy nie zastąpi sprawdzenia stanu produkcyjnej bazy.

---

## Bookkeeping checkboxów `Weryfikacja:`

Re-parsowano wszystkie pozycje `Weryfikacja:` fazy 1 (IU-1.1, IU-1.2). Zero pozycji browserowych (E2E nie odpalił — brak warstwy UI), zero pozycji `[Manual]` w tej fazie.

| IU | Pozycja | Klasyfikacja | Wynik | Dowód |
|---|---|---|---|---|
| IU-1.1 | `node --test scripts/inbox/invite.test.mjs` | CLI | ✅ PASS | exit 0, `# tests 28 / # pass 28 / # fail 0` |
| IU-1.1 | `node --test setup.test.mjs` | CLI | ✅ PASS | exit 0, `# tests 71 / # pass 71 / # fail 0` |
| IU-1.1 | `npm test` (pełna suita) | CLI | ✅ PASS | exit 0, `# tests 533 / # pass 533 / # fail 0` |
| IU-1.2 | `node --test lib/inbox-seed.test.js` | CLI | ✅ PASS | exit 0, `# tests 8 / # pass 8 / # fail 0` |
| IU-1.2 | `npm test` (pełna suita) | CLI | ✅ PASS | ten sam przebieg co wyżej |
| IU-1.2 | Grep: brak `updateJob`/`UPDATE` w `lib/inbox-seed.js` (R9) | Grep | ✅ PASS | jedyne trafienie to **komentarz** `lib/inbox-seed.js:84` („NIGDY updateJob") — zero wywołań w kodzie |

Podsumowanie bookkeepingu: CLI 5 PASS / 0 FAIL, Grep 1 PASS / 0 FAIL → **zero dodatkowych P2 z bookkeepingu**. Wszystkie pozycje odznaczone w `-zadania.md` z adnotacją wyniku.

Uwaga: przebieg `node --test scripts/inbox/invite.test.mjs` jest jednocześnie dowodem findingu #23 — suita raportuje `# tests 28`, podczas gdy dokumentacja fazy mówi o 26.

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 9 (6) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy); e2e (brak warstwy UI i zero browserowych checkboxow Weryfikacja: (0)) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 49 -> 49 -> 32 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 8 / 2 / 0 |
