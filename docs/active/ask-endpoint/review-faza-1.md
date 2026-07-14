# Review — Faza 1 (Fundament): Unit 1 `lib/claude-spawn.js` + Unit 2 konfiguracja `ASK_*` i matcher

Data: 2026-07-14
Zakres: Unit 1 (wspólny helper spawnu Claude) + Unit 2 (stałe `ASK_*` w config, `matchAskToken` w webhook)
Źródło findingów: multi-agent review + adversarial verify (P1: 3 sceptyków, P2: 1 sceptyk)

## Statystyki

| Severity | KOD | TEST | E2E | OPERATOR | Razem |
|----------|-----|------|-----|----------|-------|
| P1       | 0   | 0    | 0   | —        | 0     |
| P2       | 2   | 0    | 0   | —        | 2     |
| P3       | 4   | 5    | 0   | —        | 9     |
| OPERATOR | —   | —    | —   | 1        | 1     |
| **Razem**| 6   | 5    | 0   | 1        | 12    |

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 2 problemy P2 do naprawy** (zero P1; P3/OPERATOR nie blokują).

## Findings

### P2 (important)

1. **[KOD] `lib/claude-spawn.js:65`** — Fallback `shell:true` w `resolveClaudeBin` (Windows, gdy `where claude` pada): Node przy `shell:true` NIE escapuje args, więc metaznaki cmd.exe w argumentach wykonują się jako komendy. Args zawierają treść atakującego — dziś `webhook_payload` z publicznego `/webhook/:token` (opt-out), w Unit 4 podyktowany tekst z publicznego `/ask`. Zachowanie przeniesione wiernie z executora, ale helper staje się wspólną ścieżką spawnu publicznego endpointu. **Rekomendacja:** przy padzie `where` failować run z czytelnym błędem zamiast `shell:true`.

2. **[KOD] `lib/config.js:51`** — *(niezweryfikowany adversarially — 0 głosów sceptyków)* `ASK_TIMEOUT_MS` (55000) i `ASK_MAX_MS` (600000) hardcodowane bez override z env, a plan jawnie zakłada korektę przez env: R6 „default 10 min", sekcja Ryzyka „zmitigowane: ASK_TIMEOUT_MS przez env", Operator checklist „obniżyć ASK_TIMEOUT_MS w env (bez zmiany kodu)". Obecny kod uniemożliwia zaplanowaną mitygację — pomiar limitu Shortcuts/Watch wymusi edycję kodu zamiast env. **Fix:** `Number(process.env.ASK_TIMEOUT_MS) || 55_000` (analogicznie `ASK_MAX_MS`).

### P3 (nit)

3. **[KOD] `lib/executor.js:96`** — Log diagnostyczny `SPAWN: ${CLAUDE_BIN} ...` pokazuje surową stałą z config, podczas gdy faktyczną binarkę rozwiązuje teraz helper claude-spawn (`where claude` / `binOverride`). Przy diagnozie na Windows log kłamie o realnie uruchomionej binarce. Rekomendacja: helper mógłby eksponować resolved bin (np. `spawnClaude` zwraca proc, a `resolveClaudeBin` eksportowany do logu) albo log przenieść do helpera.

4. **[TEST] `lib/webhook.test.js:107`** — Testy defaultów config `ASK_*` asercjonują na ambient env procesu testowego (`require('./config')` czyta env raz): `npm test` na maszynie z wyeksportowanym `ASK_ENABLED=1`/`ASK_TOKEN` (np. VPS po deployu Unit 5) da fałszywy FAIL. Zgodnie z wzorcem projektu (snapshot env przed statefulnymi testami) test powinien kontrolować env — np. spawn `node -e` z czystym env (wzorzec `server.env.test.js`) albo skip/guard gdy `ASK_*` ustawione.

5. **[KOD] `lib/claude-spawn.js:63`** — `resolveClaudeBin()` wykonuje `execSync('where claude')` przy KAŻDYM spawnie na Windows, mimo że wynik jest stały w obrębie życia procesu — brak memoizacji. W executorze (jeden run naraz, w tle) bez znaczenia, ale helper wejdzie w Unit 3/5 na ścieżkę handlera HTTP `/ask`, gdzie `execSync` blokuje event loop per request. Rekomendacja: cache pierwszego udanego resolve (wzorzec leniwej inicjalizacji jak `getDb`). P3, bo target ask to VPS/Linux (gałąź `IS_WIN` nieaktywna), a per-run `execSync` to zachowanie pre-existing przeniesione 1:1 z executora.

6. **[TEST] `lib/webhook.test.js:110`** — Testy defaultów config `ASK_*` mieszkają w `webhook.test.js` (zgodnie z planem Unit 2, ale wbrew regule kolokacji — testy config.js powinny leżeć przy config.js) i zależą od env runnera: na maszynie z wyeksportowanym `ASK_ENABLED=1`/`ASK_TOKEN` (docelowa konfiguracja produkcyjna VPS) `npm test` sfailuje mimo poprawnego kodu. Komentarz w teście to przyznaje („testy odpalane bez env ASK_*"), ale bardziej odporna forma to snapshot+delete env przed require z odizolowanym cache modułu, albo przynajmniej przeniesienie do dedykowanego `config.test.js` z tym zastrzeżeniem.

7. **[TEST] `lib/config.js:45`** — Kolokacja: nowe stałe `ASK_*` w config.js testowane są w `lib/webhook.test.js` zamiast w dedykowanym `lib/config.test.js` (który nie istnieje). Zgodne z literą planu (Unit 2 jawnie wskazuje webhook.test.js jako plik testowy), więc tylko nit — ale przy rozroście sekcji Ask w kolejnych fazach warto wydzielić `config.test.js`, żeby testy config nie żyły w pliku matcherów URL.

8. **[KOD] `lib/claude-spawn.js:82`** — Martwy eksport `OAUTH_TOKEN_FILE` — zero konsumentów w produkcji, testach i skryptach (grep po lib/, scripts/, setup.mjs, server.js czysty; używany wyłącznie wewnętrznie jako default param `buildCleanEnv`). Przed refaktorem był module-local const w executor.js. YAGNI: usunąć z `module.exports`, zostawić jako wewnętrzną stałą — eksport „na przyszłość" bez użycia.

9. **[TEST] `lib/webhook.test.js:107`** — Brak testu happy path flagi opt-in: pokryty jest tylko default `ASK_ENABLED=false`, nie ma testu, że `ASK_ENABLED='1'` daje `true` (a np. `'true'`/`'yes'` NIE daje — kontrakt „truthy tylko przy 1" z planu). Ponieważ config czyta env raz przy require, test wymaga subprocessa z kontrolowanym env (wzorzec istnieje: `server.env.test.js` / `node -e` z env). Bez tego regresja odwracająca logikę na opt-out (jak `WEBHOOK_ENABLED`) przeszłaby niezauważona przez suite.

10. **[TEST] `lib/webhook.test.js:67`** — `matchAskToken` ma słabsze pokrycie niż bliźniaczy `matchWebhookToken`: brak wariantu tokenu BEZ query (`'/ask/abc123'` → `'abc123'`, najczęstszy realny przypadek — Shortcut nie doda query) oraz brak wariantu nielegalnego znaku (`'/ask/abc.def'` → `null`), oba obecne w testach webhooka. Ryzyko niskie (regex kopiowany), ale przy przyszłej edycji jednego z dwóch wzorców rozjazd nie zostanie złapany. Plan specyfikował tylko wariant z query, więc to luka ponadplanowa.

11. **[TEST] `lib/claude-spawn.js:30`** — Nieprzetestowana gałąź błędu `readOauthToken` dla nie-ENOENT (np. EACCES): kontrakt „zaloguj błąd i zwróć null, nie rzucaj" nie ma asercji — testy (przez re-eksport w executor.test.js) pokrywają tylko happy path, ENOENT i pusty plik. Scenariusz: plik tokenu z chmod 000 na VPS → oczekiwany log `[claude-spawn]` + spawn bez tokenu; regresja rzucająca wyjątek z `buildCleanEnv` wywaliłaby cały spawn joba i nie zostałaby złapana. Gałąź przeniesiona z executora (luka pre-existing), ale po wydzieleniu do nowego publicznego modułu powinna dostać test (reguła: nowa funkcja publiczna = happy + error).

### OPERATOR (poza automatyzacją headless)

12. **[OPERATOR] `lib/claude-spawn.js:57`** — Ścieżka Windows w `resolveClaudeBin` (resolve przez `where claude`, fallback `shell:true` gdy `where` nie znajdzie binarki) jest niewykonalna do weryfikacji headless na tym Macu (`IS_WIN=false`, gałąź martwa w testach; override binarki ją omija). Logika przeniesiona 1:1 z executora, ale jedyna realna weryfikacja to run na maszynie Windows (install.ps1/Pester lub ręczny smoke) — do odnotowania przy najbliższym teście instalacji Windows.

## Zgodność ze spec

Brak findingów typu spec-compliance po adversarial verify — implementacja Unit 1 i Unit 2 zgodna z planem. Jedyne odchylenie funkcjonalne od intencji planu to finding P2 #2 (`ASK_TIMEOUT_MS`/`ASK_MAX_MS` bez override z env — plan zakładał korektę przez env bez zmiany kodu).

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 4
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `npm test przechodzi w całości — w tym istniejące lib/executor.test.js i lib/scheduler.test.js bez zmian asercji` → PASS (komenda: `npm test`, 284/284 pass, 0 fail)
- [x] CLI: `lib/claude-spawn.test.js pokrywa scenariusze powyżej i przechodzi` → PASS (komenda: `node --test lib/claude-spawn.test.js`, 5/5 pass)
- [x] CLI: `npm test przechodzi; lib/webhook.test.js pokrywa nowy matcher` → PASS (komendy: `npm test` + `node --test lib/webhook.test.js`, 15/15 pass)
- [x] CLI: `node -e "const c=require('./lib/config'); process.exit(c.ASK_ENABLED===false && c.ASK_TIMEOUT_MS===55000 ? 0 : 1)"` → PASS (exit 0)

Bookkeeping nie dodał żadnych nowych P2/P3 — liczniki i severity gate bez zmian po kroku 5 (re-aktualizacja): **⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 2× P2**.

## E2E

Faza 1 nie ma powierzchni E2E browser (czyste moduły lib/, zero UI). E2E: passed 0, failed 0, skipped 0.
