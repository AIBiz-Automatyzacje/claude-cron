# Review fazy 4 — Deploy i Shortcut

Data: 2026-07-14
Zadanie: `docs/active/ask-endpoint/`
Plan: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`
Findings po adversarial verify (P1 = 3 sceptyków, P2 = 1).

## Werdykt: ⚠️ ZASTRZEŻENIA

**⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 [KOD] do naprawy** (brakująca dokumentacja `/ask` w `CLAUDE.md` — jedyny headless-wykonalny deliverable fazy 4).

Kontekst gate'u: severity gate liczy wyłącznie findingi KOD/TEST/E2E (0× P1, 1× P2, 3× P3). Findingi OPERATOR (2× P1, 1× P2, 2× P3) NIE blokują gate'u — to warunki środowiskowe, nie defekty do fixu — ale **cała substancja fazy 4 (deploy publicznej powierzchni `/ask`) pozostaje niezweryfikowana do czasu wykonania Operator checklist**. Granica auth nowego publicznego endpointu jest na dziś udowodniona wyłącznie testami z symulowanym nagłówkiem `X-Forwarded-For` i atrapą CLI.

## Statystyki

| Severity | KOD | TEST | E2E | OPERATOR | Razem |
|---|---|---|---|---|---|
| P1 | 0 | 0 | 0 | 2 | 2 |
| P2 | 1 | 0 | 0 | 1 | 2 |
| P3 | 3 | 0 | 0 | 2 | 5 |
| **Suma** | **4** | **0** | **0** | **5** | **9** |

Bookkeeping checkboxów `Weryfikacja:` nie dodał żadnych nowych P2/P3 (faza 4 nie definiuje checkboxów `Weryfikacja:` — szczegóły na końcu raportu).

---

## P1 — blocking (OPERATOR — nie blokują gate'u, blokują wdrożenie)

### P1-1 [OPERATOR] `ask-endpoint-zadania.md:134` — cała substancja fazy 4 (deploy `/ask`) niewykonalna headless i NIEZWERYFIKOWANA mimo `execute=done`

Cała substancja fazy 4 (deploy publicznej powierzchni `/ask`) jest niewykonalna headless i pozostaje NIEZWERYFIKOWANA: wszystkie pozycje Operator checklist (linie 134–139) są nieodhaczone mimo `execute=done` w `.autopilot-state.json`. Kluczowa weryfikacja bezpieczeństwa — realny curl z innej maszyny przez Tailscale Funnel (poprawny sekret → odpowiedź; bez sekretu → 403), wpisanie długich losowych `ASK_TOKEN`/`ASK_SECRET` do env i restart daemona (env nie propaguje się do żyjącego procesu — learned pattern 2026-07-07), przeżycie `~/.claude-cron-oauth-token` — wymaga realnego VPS i sieci. Do momentu wykonania tych kroków granica auth nowego publicznego endpointu jest udowodniona wyłącznie testami z symulowanym nagłówkiem `X-Forwarded-For`.

### P1-2 [OPERATOR] `ask-endpoint-zadania.md:136` — smoke-test granicy bezpieczeństwa w realnej sieci + włączenie kanału powiadomień na teczce

Smoke-test granicy bezpieczeństwa w realnej sieci niewykonalny headless: curl z INNEJ maszyny przez Tailscale Funnel (poprawny sekret → odpowiedź text/plain; bez sekretu → 403) oraz włączenie kanału powiadomień (Telegram lub Discord) na jobie „Asystent głosowy" w panelu Pulsa (job powstaje przy pierwszym `/ask`; bez flagi kanału każde odczepione zapytanie kończy się tylko warningiem w logu — wynik ginie dla usera). Testy fazy 3 pokrywają to wyłącznie atrapą CLI i symulowanym nagłówkiem `X-Forwarded-For` — zgodnie z Operator checklist fazy 3 (`review-faza-3.md`, 2× OPERATOR) prawdziwy Funnel + prawdziwa binarka `claude` wymagają realnego środowiska. Operator action: pozycje 2–3 checklisty (`ask-endpoint-zadania.md:135-136`) po wykonaniu deployu.

---

## P2 — important

### P2-1 [KOD] `CLAUDE.md` (via `ask-endpoint-zadania.md:139`) — under-implementation jedynego headless-wykonalnego deliverable'u fazy 4: brak dokumentacji `/ask` w `CLAUDE.md`

Plan (sekcja „Dokumentacja / Notatki operacyjne": „Po implementacji: dopisać `/ask` do sekcji `server.js` — HTTP i granice bezpieczeństwa i `lib/ask.js`+`lib/claude-spawn.js` do Architektura backendu w CLAUDE.md") oraz pozycja checklisty zadań (linia 139) wymagają aktualizacji `CLAUDE.md`, a grep `CLAUDE.md` nie znajduje żadnej wzmianki o `/ask`, `lib/ask.js` ani `lib/claude-spawn.js` — mimo że `.autopilot-state.json` ma dla fazy 4 `execute=done` (zweryfikowane grepem przy pisaniu tego raportu: zero trafień). Implementacja (fazy 1–3) jest ukończona, więc warunek „po implementacji" zachodzi. Przy tej samej edycji warto domknąć P3 z review fazy 3 (P3-15): nieudokumentowane env-vary `CLAUDE_CRON_DB_PATH`/`CLAUDE_CRON_CLAUDE_BIN`.

### P2-2 [OPERATOR] `ask-endpoint-zadania.md:137` — budowa Shortcuta „Asystent" + pomiar realnego limitu czekania akcji „Pobierz zawartość URL"

Budowa Shortcuta „Asystent" na Macu (Dyktuj → Pobierz zawartość URL → Okno dialogowe → Powiedz tekst) + pomiar realnego limitu czekania akcji „Pobierz zawartość URL" — niewykonalne headless. Strona kodowa jest gotowa: `ASK_TIMEOUT_MS` ma override z env (fix P2 po review fazy 1, `lib/config.js`), więc ewentualna korekta nie wymaga zmiany kodu — ale sam pomiar (55 s blisko typowych limitów Shortcuts) to jawna mitygacja ryzyka z planu i musi wykonać ją operator.

---

## P3 — nit / sugestie

### P3-1 [KOD] `ask-endpoint-zadania.md:134` — „długie losowe ASK_TOKEN/ASK_SECRET" bez konkretnej instrukcji generacji

Checklist mówi „długie losowe `ASK_TOKEN`/`ASK_SECRET`" bez konkretnej instrukcji generacji. Ścieżka 403 jest poza rate limitem (znany, zaakceptowany P3 fazy 3 — brute-force token+sekret bez lockoutu), więc entropia sekretów to JEDYNA realna obrona publicznego endpointu przed zgadywaniem. „Długie losowe" pozostawione interpretacji operatora to słaby punkt procedury — dopisać konkretną komendę, np. `openssl rand -hex 32` per sekret (2×), zamiast opisu jakościowego.

### P3-2 [OPERATOR] `ask-endpoint-zadania.md:137` — ASK_SECRET plaintext w definicji Shortcuta + domyślny sync przez iCloud

Shortcut „Asystent" na Macu przechowuje `ASK_SECRET` plaintext w definicji akcji „Pobierz zawartość URL" i (domyślnie) synchronizuje się przez iCloud na wszystkie urządzenia konta. Spójne z przyjętym poziomem zaufania projektu (sekrety plaintext w state DB, „jak shell RC"), ale operator powinien być tego świadomy przy budowie Shortcuta; plan już dokumentuje procedurę rotacji przy podejrzeniu wycieku (env + restart daemona). Weryfikacja i decyzja wyłącznie po stronie operatora — niewykonalne headless.

### P3-3 [OPERATOR] `ask-endpoint-zadania.md:88` — gałąź Windows `lib/ask.js` nieprzetestowana na realnej maszynie Windows

Gałąź Windows w `lib/ask.js` (`killProcessTree` przez `taskkill /PID /T /F`) i pełny cykl `executeAsk` mają skip testów na win32 (atrapa CLI wymaga POSIX shebang) — jeśli jakakolwiek instalacja Windows ma używać `/ask`, przed deployem trzeba odpalić `node --test lib/ask.test.js` + pełny `npm test` na realnej maszynie Windows. Niewykonalne headless na macOS. (Duplikuje Operator checklist fazy 2 — utrzymane tu, bo faza 4 to moment deployu, w którym ten warunek się materializuje.)

### P3-4 [KOD] `.autopilot-state.json:32` — `execute:'done'` dla fazy 4 mimo zera odhaczonych pozycji checklisty

Niespójność stanu z rzeczywistością dokumentów: faza 4 ma `execute:'done'`, podczas gdy WSZYSTKIE pozycje Operator checklist (`ask-endpoint-zadania.md:132-139`) są nieodznaczone `[ ]` i w drzewie nie ma śladu wykonania deployu. Jeśli „done" oznacza „brak pracy automatyzowalnej", to konwencja powinna być zapisana (np. `execute:'operator'` albo notatka w kontekście) — obecny zapis ryzykuje, że pipeline przejdzie do walidacji/complete/archiwizacji (`zakonczenie: pending`) z funkcją nigdy nie wdrożoną, a checklist zniknie do `docs/completed/` jako pozornie zamknięty.

### P3-5 [KOD] `review-faza-3.md` (working tree) — bookkeeping review fazy 3 wisi niezacommitowany

Bookkeeping review fazy 3 wisi niezacommitowany w working tree: zmodyfikowany `ask-endpoint-kontekst.md`, untracked `review-faza-3.md` i `.autopilot-state.json` (stan potwierdzony `git status --short` przy pisaniu tego raportu) — poprzednie fazy commitowały artefakty review razem z fixami (wzorzec: 75c2563, c157bc0). Crash/reset drzewa przed zamknięciem zadania utraciłby raport review i stan autopilota (źródło prawdy wznowienia). Do commitu przy najbliższym kroku pipeline'u — reviewer sam nie commituje (brak zgody usera).

---

## Zgodność ze spec

- **Deliverable dokumentacyjny planu** („Po implementacji: dopisać `/ask` do CLAUDE.md"): NIEWYKONANY mimo `execute=done` — jedyny headless-wykonalny element fazy 4 (P2-1).
- **Pozycje deployowe planu** (env `ASK_*`, Funnel, kanał powiadomień, Shortcut, hotkey): zgodne z planem jako praca operatora; kod po fazach 1–3 jest na to gotowy (m.in. env-override `ASK_TIMEOUT_MS` — mitygacja R6 dostarczona w fixie fazy 1). Wykonanie i weryfikacja → Operator checklist faza 4.
- **Procedura checklisty**: „długie losowe" sekrety bez komendy generacji to jakościowy, nie operacyjny zapis — entropia sekretów jest jedyną obroną ścieżki 403 (poza rate limitem, zaakceptowany P3 fazy 3) (P3-1).
- **Stan autopilota**: `execute:'done'` dla fazy czysto operatorskiej bez zapisanej konwencji ryzykuje fałszywe domknięcie zadania (P3-4).

## Operator checklist faza 4 (niewykonalne headless)

1. **[OPERATOR/P1]** Deploy `/ask` na VPS: merge do `main`, pull, `ASK_TOKEN`/`ASK_SECRET` (długie losowe, np. `openssl rand -hex 32` ×2) do env, restart daemona (env nie propaguje się do żyjącego procesu), weryfikacja przeżycia `~/.claude-cron-oauth-token`.
2. **[OPERATOR/P1]** Smoke-test granicy auth w realnej sieci: curl z innej maszyny przez Tailscale Funnel (poprawny sekret → text/plain; bez sekretu → 403) + włączenie kanału powiadomień na jobie „Asystent głosowy" w panelu.
3. **[OPERATOR/P2]** Budowa Shortcuta „Asystent" + pomiar realnego limitu czekania akcji „Pobierz zawartość URL" (ew. korekta `ASK_TIMEOUT_MS` w env — bez zmiany kodu).
4. **[OPERATOR/P3]** Świadomość: `ASK_SECRET` plaintext w Shortcucie + domyślny sync iCloud; rotacja = env + restart daemona.
5. **[OPERATOR/P3]** Jeśli `/ask` ma działać na Windows: `node --test lib/ask.test.js` + pełny `npm test` na realnej maszynie Windows przed deployem.

## E2E

Faza 4 nie ma scenariuszy E2E browser wykonanych headless — jej substancja (realny Funnel z innej maszyny, Shortcut na Macu) wymaga fizycznego środowiska operatora. Oba scenariusze → Operator checklist faza 4 (pozycje 2 i 3).

- passed: 0, failed: 0, skipped: 2 (oba → Operator checklist)

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 0
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

Sekcja fazy 4 w `ask-endpoint-zadania.md` („Operator checklist (poza automatyzacją — odznacza człowiek)", linie 132–139) nie zawiera ŻADNEGO checkboxa `Weryfikacja:` — wszystkie pozycje to zadania operatorskie odznaczane przez człowieka (celowo, zgodnie z konwencją prefiksu wykluczającego z liczenia ukończenia fazy). Re-parse regexem `^\s*-\s*\[\s*\]\s*Weryfikacja:` → 0 trafień. Brak checkboxów do odznaczenia/anotacji.

Krok 5 (re-aktualizacja gate'u): bookkeeping nie dodał nowych P2/P3 — gate pozostaje **⚠️ ZASTRZEŻENIA** (0× P1 [KOD/TEST/E2E], 1× P2 [KOD]).
