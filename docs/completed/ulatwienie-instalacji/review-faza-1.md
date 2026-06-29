# Code Review — Faza 1: Migracja DB (globalna) + guardy + VPS

**Data:** 2026-06-29
**Branch:** `feature/ulatwienie-instalacji`
**Zakres:** Unit 1 (migracja `node:sqlite`), Unit 2 (guardy startowe), Unit 3 (zabezpieczenie VPS)

## Severity gate

**ZASTRZEZENIA** — 0× P1, 2× P2, 14× P3 (+ findingi OPERATOR). Brak blokerow; dwa P2 do naprawy przed domknieciem fazy.

## Statystyki

| Severity | KOD | TEST | E2E | OPERATOR | Razem |
|---|---|---|---|---|---|
| P1 | 0 | 0 | 0 | — | 0 |
| P2 | 1 | 1 | 0 | — | 2 |
| P3 | 5 | 5 | 0 | 5 | 15 |

- Bookkeeping Weryfikacja: 11 checkboxow CLI/grep — wszystkie PASS, 0 FAIL.
- E2E: 0 passed / 0 failed / 0 skipped (faza nie ma scenariuszy przegladarkowych — to warstwa DB/runtime/VPS).

---

## Findings (P1 → P2 → P3)

### P2 — important

**[P2][KOD] scripts/install-vps.sh:48-62 — rozjazd kontraktu zakresu Node miedzy warstwami**
package.json `engines` i `lib/runtime-guard.js` egzekwuja pelny zakres `>=22.13 <25` (gorna granica wykluczajaca, by uniknac `defensive:true` od Node 24.14 / majora 25 — Ryzyka planu). `is_node_supported` w install-vps.sh sprawdza WYLACZNIE dolny prog (major>MIN lub major==MIN && minor>=MIN) — brak gornej granicy `<25`. Identyczna luka w wygenerowanym `cron-node-guard.sh` (warunek `MAJOR -gt MIN_NODE_MAJOR` przepuszcza dowolnie wysoki major). Skutek: na VPS z Node 25/26 instalator i nocny cron-guard uznaja Node za kompatybilny i ZRESTARTUJA serwis, po czym `lib/runtime-guard.js` ubije go z `exit(1)` przy starcie — dokladnie scenariusz padu wszystkich jobow, ktoremu cron-guard ma zapobiegac. Ta sama regula biznesowa (okno [22.13,25)) wyrazona niespojnie w 3 miejscach. Cron przez nodesource `setup_22.x` dzis daje 22.x, ale guard ma chronic wlasnie przed reczna degradacja/zmiana Node przez operatora.

**[P2][TEST] lib/runtime-guard.test.js — brak testu error-case dla enforceNodeVersion (efekt exit(1))**
Brak testu rdzenia R3 ("serwer fail-fast na niekompatybilnym Node"). Plan (Unit 2, Notatka wykonawcza) wprost wymaga: "sam efekt exit(1) weryfikowany przez wstrzykniecie wersji jako argument". Tymczasem `enforceNodeVersion()` w runtime-guard.js:60-66 czyta `process.versions.node` bezposrednio, bez parametru wstrzykiwalnego — droga fail-fast jest nietestowalna jak napisana i nie ma zadnego testu. Testy pokrywaja tylko czysta predykate `isNodeSupported`, nie zachowanie samego guardu. Refaktor: `enforceNodeVersion(version = process.versions.node, { onFail })` z DI exit/stderr, + test happy (wspierany Node nie wola onFail) i error (Node <22.13 wola onFail z komunikatem zawierajacym wykryta i wymagana wersje).

### P3 — nit

**[P3][KOD] scripts/install-vps.sh:503 — VAULT_GIT niecytowany w CRON_CMD**
`CRON_CMD` osadza `$VAULT_GIT` (sciezka podana interaktywnie przez operatora, `read -r VAULT_GIT_INPUT`) niecytowana wewnatrz `su - $CLAUDE_USER -c \"...\"`. Sciezka ze spacja lub metaznakami shell rozsypie crontab lub pozwoli na wstrzykniecie polecenia. Wektor jest za granica zaufania (operator root podczas instalacji, nie zdalny input), wiec nie jest to realna podatnosc, ale krucha konkatenacja user-inputu do polecenia. Sugestia: walidacja/escaping sciezki VAULT_GIT przed wstawieniem do CRON_CMD.

**[P3][KOD] scripts/install-vps.sh:48-62 — duplikacja logiki porownania wersji Node**
Ta sama regula (major.minor cut + numeryczne porownanie) skopiowana 1:1 miedzy `is_node_supported` a wstrzykiwanym heredoc `cron-node-guard.sh`. Akceptowalne wg reguly projektu "Duplication > Complexity" (bash, dwa konteksty: instalator vs cron jako `$CLAUDE_USER`), ale przy naprawie P2 (dodanie gornej granicy) trzeba zaktualizowac OBIE kopie — ryzyko rozjazdu.

**[P3][TEST] lib/runtime-guard.test.js:28-31 — test '24 → true' odwraca scenariusz planu (poprawnie)**
Test "major 24 → true" swiadomie odwraca scenariusz planu (Unit 2 deklarowal `isNodeSupported('24.0.0') → false`). To poprawka wewnetrznie sprzecznego scenariusza planu (24 < 25, wiec wspierane), udokumentowana w "Decyzje z implementacji" i zgodna ze zrodlem prawdy `engines >=22.13 <25`. Nie defekt — odnotowane dla sciezki audytu (asercja wzmocniona, nie oslabiona).

**[P3][TEST] lib/db.test.js:443 — smoke-test R4 error-case uzywa string, nie BigInt**
Smoke-test R4 error-case symuluje zly typ jako string (`'0'`), podczas gdy cala motywacja R4 oraz komentarze w lib/db.js (`DbTypeError`, `assertDbReturnsNumbers`) dotycza node:sqlite zwracajacego agregat jako BigInt (`COUNT(*)/SUM` jako BigInt). Zweryfikowano: `typeof 1n === 'bigint' !== 'number'`, wiec implementacja TEN przypadek lapie poprawnie — ale test go nie pokrywa. Warto dodac drugi przypadek z `n: 0n` (BigInt), bo to realny scenariusz regresji ktory motywowal feature; string jest tylko proxy. Bez tego test sprawdza "ksztalt" (cokolwiek != number), a nie wlasciwe zachowanie wobec BigInt.

**[P3][KOD] lib/db.js:142 — assertDbReturnsNumbers bez jawnej walidacji conn**
`assertDbReturnsNumbers(conn)` nie ma jawnej walidacji ze `conn` jest przekazany (fail-fast). Przy `conn=undefined` poleci generyczny TypeError zamiast czytelnego komunikatu — lekko sprzeczne z duchem fail-fast/typed-error reszty modulu. Niski priorytet: jedyni wolajacy (server.js, test) zawsze przekazuja conn, wiec scenariusz praktycznie nie wystepuje. Dodawanie guardu moze byc defensive over-engineering — obserwacja, nie wymog.

**[P3][KOD] lib/runtime-guard.js:21 — parseVersion gubi pre-release tag**
`parseVersion` dla `'22.13.0-nightly20240101'` parsuje patch (`'0-nightly...'`) przez `parseInt → 0`, poprawnie dla porownania major.minor, ale cicho gubi info o pre-release. Dla zakresu [22.13,25) zachowanie jest bezpieczne (zweryfikowano: `'22.13.0-nightly' → true`), brak realnego defektu. Komentarz "Nie-numeryczne segmenty → 0 (fail-safe)" trafnie to opisuje. Bez akcji.

**[P3][KOD] lib/config.js:50 — komentarz przy MIN_NODE_VERSION lekko myli**
Komentarz "node:sqlite stabilne dopiero od 22.5" lekko zaprzecza ustaleniu planu (plan:94, research plan:85): 22.5 jest "realnie zepsute" (wymaga `--experimental-sqlite`, czesc buildow niedzialajaca na ARM Mac), a 22.13 to PIERWSZY bezflagowy import. Wartosc stalej (22.13) jest poprawna; mylace tylko sformulowanie sugerujace ze 22.5 bylo "stabilne". Nuans dokumentacyjny, zero wplywu na zachowanie.

**[P3][TEST] lib/db.test.js:86 — getTodayRunStats: assert.equal luzny (==), bez asercji typu**
Unit 1 scenariusz: plan wymaga wprost "getTodayRunStats zwraca {success, failed} typu number (nie BigInt, nie string)" (plan:153). Istniejace asercje uzywaja `assert.equal(stats.success, 2)` — porownanie luzne (==): `2n==2` oraz `'2'==2` sa true, wiec test NIE wykryje regresji typu — sprawdza tylko wartosc. Intencja R4 jest realnie pokryta nowym `assertDbReturnsNumbers` (smoke-test silnika na COUNT(*)), ale konkretny scenariusz typu dla getTodayRunStats z planu nie ma dedykowanej asercji typeof. Drobny gap pokrycia — nie blokuje, bo smoke-test broni rdzenia R4.

**[P3][TEST] lib/db.test.js — brak asercji typeof === 'number' na lastInsertRowid/.changes**
Plan (Unit 1, Scenariusze testowe) definiuje wprost asercje TYPU: "createJob zwraca lastInsertRowid jako number; deleteOldRoutineRuns/reapOrphanedRuns zwracaja .changes jako number" oraz "getTodayRunStats zwraca number". W testach nie ma ani jednej asercji `typeof === 'number'` na tych wartosciach — sprawdzane sa tylko wartosci. Ze scislym `node:assert/strict` (===) regresja na BigInt (`1n!==1`) lub string zostalaby posrednio zlapana, wiec realna ochrona istnieje — ale doslowny scenariusz typu z planu (motywacja migracji, ryzyko BigInt z review-faza-3.md:61) nie jest jawnie zakodowany. Dodac min. jedna asercje typeof.

**[P3][TEST] lib/runtime-guard.test.js — parseVersion i compareVersions bez bezposredniego testu**
`parseVersion` i `compareVersions` sa eksportowane z runtime-guard.js (module.exports:70-76) ale nie maja zadnego bezposredniego testu — pokryte jedynie tranzytywnie przez `isNodeSupported`. Regula projektu (coding-rules §2: kazda nowa funkcja publiczna = min. happy path + error case) nie jest spelniona dla tych dwoch eksportow. Edge-case parsowania (nie-numeryczny segment → 0, brakujace segmenty) wart jawnego testu.

#### OPERATOR (niewykonalne headless — do operator-checklist, NIE blokuja gate'u)

**[P3][OPERATOR] docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md:202 — checklist Unit 2/3 wymaga realnego VPS/systemd**
Operator checklist Unit 2/3 (start serwera na wspieranym Node bez ExperimentalWarning, install-vps.sh na swiezym VPS, cron z guardem) wymaga realnego srodowiska VPS/systemd — niewykonalne headless. Audyt bezpieczenstwa: faza dotyczy migracji silnika DB + guardow wersji Node + hardeningu instalacji; brak warstwy auth/RLS/XSS/Zod/API-key — te wektory N/A. SQL w `assertDbReturnsNumbers` statyczny (`SELECT COUNT(*) AS n FROM jobs`), bez konkatenacji. runtime-guard.js czysty, fail-fast poprawny. `log_warn` w cron-node-guard.sh loguje wylacznie wersje Node — brak ekspozycji sekretow/PII. `--disable-warning=ExperimentalWarning` wycisza wylacznie kategorie experimental.

**[P3][OPERATOR] scripts/install-vps.sh:455-500 — cron-node-guard.sh + warunkowy restart tylko na realnym VPS**
Wygenerowany cron-node-guard.sh oraz warunkowy restart serwisu (git pull zawsze, systemctl restart tylko po PASS guarda) weryfikowalne tylko na realnym VPS z systemd/cron/su. Operator checklist Unit 3 wymaga: swiezy VPS, Node >=22.13, serwis is-active, cron z guardem; oraz scenariusz negatywny (zdegradowany Node → git pull przechodzi, restart wstrzymany, ostrzezenie w logu/journal).

**[P3][OPERATOR] server.js:1 — fail-fast exit(1) na realnie niewspieranym runtime**
Sciezka fail-fast lib/runtime-guard.js (komunikat na stderr + exit(1) na niekompatybilnym Node) oraz brak ExperimentalWarning przy starcie z flaga `--disable-warning` sa testowane jako pure predykat, ale realny efekt exit(1) na faktycznie niewspieranym runtime i czystosc stderr 24/7 wymagaja uruchomienia na rzeczywistym Node poza zakresem — Operator checklist Unit 2.

**[P3][OPERATOR] scripts/install-vps.sh:455-512 — R5/Unit 3 end-to-end na realnym VPS**
R5 / Unit 3 scenariusz [Manual]: "Na realnym VPS ze starym Node cron auto-update robi git pull, ale NIE restartuje serwisu; log zawiera ostrzezenie". Logika cron-node-guard.sh i bramkowanie restartu przez `&& systemctl restart` poprawna przy statycznej analizie (su -c propaguje exit code, git pull zawsze, restart warunkowo), `bash -n` przechodzi, grepy z planu (22.13, disable-warning, brak build-essential/better-sqlite3) zielone. Pelna weryfikacja end-to-end wymaga realnego VPS z systemd+cron i zdegradowanym Node — niewykonalna headless.

**[P3][OPERATOR] docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md:203 — Unit 2/3 nieweryfikowalne headless**
Operator checklist Unit 2 (brak ExperimentalWarning na stderr + czysty start) oraz Unit 3 (realny VPS: git pull bez restartu na starym Node, log z ostrzezeniem, serwis is-active, cron z guardem) nieweryfikowalne headless — wymagaja realnego deploya VPS i obserwacji systemd/journald. `bash -n scripts/install-vps.sh` przechodzi, heredoc skladniowo poprawny, ale faktyczne dzialanie su -/logger/systemctl restart tylko na realnym serwerze.

---

## Zgodnosc ze spec

- **R1/R2 (Unit 1):** zrealizowane. `lib/db.js` na `DatabaseSync` z `node:sqlite`, oba PRAGMA przez `db.exec(...)` (0× `.pragma()`), `better-sqlite3` usuniety z deps, `engines >=22.13 <25`. Suite 121 PASS.
- **R3 (Unit 2):** zrealizowane czesciowo — predykat `isNodeSupported` pokryty, ale sam efekt fail-fast `exit(1)` nietestowalny i nieprzetestowany (P2 TEST powyzej).
- **R4 (Unit 2):** zrealizowane — `assertDbReturnsNumbers` + `DbTypeError`. Gap: error-case testowany przez string-proxy, nie BigInt (P3).
- **R5 (Unit 3):** zrealizowane z luka kontraktu — prog dolny podniesiony, build-tools usuniete, cron-guard bramkuje restart. Brak gornej granicy `<25` w bash (P2 KOD) — niespojnosc z `engines`/`runtime-guard.js`.
- **Scope creep:** brak. Zmiany mieszcza sie w R1-R5.
- **Decyzja '24 → true':** swiadoma poprawka sprzecznego scenariusza planu, zgodna ze zrodlem prawdy — nie scope creep.

---

## Bookkeeping checkboxow Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 11
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1 (Unit 3 Test [Manual] — nie jest checkboxem Weryfikacja:, to Test)
- Niejasne (P3): 0
- Failujace (P2): 0

### Szczegoly

- [x] CLI: `node --test (caly suite) przechodzi bez regresji` → PASS (121 pass / 0 fail, exit 0)
- [x] Grep: `grep -n "better-sqlite3" lib/ server.js package.json` → PASS (pusto, exit 1 = brak dopasowania = oczekiwane)
- [x] Grep: `grep -n "node:sqlite" lib/db.js` → PASS (import DatabaseSync obecny)
- [x] Grep: `grep -c "\.pragma(" lib/db.js` → PASS (zwraca 0)
- [x] CLI: `node --test lib/runtime-guard.test.js` → PASS (10 pass / 0 fail)
- [x] Grep: `grep -n "disable-warning=ExperimentalWarning" package.json` → PASS (linia 7, start)
- [x] CLI: `node -e "require('./lib/runtime-guard')"` na wspieranym Node → PASS (nie rzuca, exit 0)
- [x] Grep: `grep -n "MIN_NODE_VERSION" lib/` → PASS (stala w config.js:50)
- [x] CLI: `bash -n scripts/install-vps.sh` → PASS (brak bledow skladni, exit 0)
- [x] Grep: `grep -n "22.13\|disable-warning=ExperimentalWarning" scripts/install-vps.sh` → PASS (prog + flaga obecne)
- [x] Grep: `grep -n "better-sqlite3\|build-essential" scripts/install-vps.sh` → PASS (tylko komentarz historyczny linia 106 — checkbox dopuszcza "lub komentarz uzasadniajacy")
