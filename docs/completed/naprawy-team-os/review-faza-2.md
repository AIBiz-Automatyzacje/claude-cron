# Review fazy 2 — Granica repo ↔ vault

**Zadanie:** naprawy-team-os
**Faza:** 2 (U4 — `PULS_HOME` ustawia instalator; U5 — `close` archiwizuje wątek, jedna kopia kodu w repo)
**Data:** 2026-08-05
**Severity gate:** ⚠️ **ZASTRZEŻENIA** — 0 × P1, 7 × P2, 7 × P3 (+ 3 findingi OPERATOR)

---

## Statystyki

| Metryka | Wartość |
|---|---|
| P1 (blocking) | 0 |
| P2 (important) | 7 |
| P3 (nit) | 7 |
| OPERATOR (poza fix) | 3 |
| Findingi typu KOD | 9 |
| Findingi typu TEST | 4 |
| Findingi typu E2E | 0 |
| E2E: passed / failed / skipped | 0 / 0 / 0 |
| Checkboxy `Weryfikacja:` fazy 2: odznaczone / pozostawione | 6 / 0 |

**Rozkład po plikach:**

| Plik | P1 | P2 | P3 |
|---|---|---|---|
| `scripts/inbox/close.mjs` | 0 | 3 | 3 |
| `scripts/inbox/close.test.mjs` | 0 | 1 | 1 |
| `setup.mjs` | 0 | 1 | 1 |
| `setup.test.mjs` | 0 | 0 | 1 |
| `scripts/install-vps.sh` | 0 | 1 | 0 |
| `scripts/inbox/inbox-push.mjs` | 0 | 0 | 1 |
| `<vault>/.claude/skills/deleguj/scripts/env.mjs` (poza repo) | 0 | 1 | 0 |

---

## Findingi

### 🔴 P1 — blokujące

Brak.

---

### 🟠 P2 — ważne

#### P2-1 · KOD · `scripts/inbox/close.mjs:69`

`close` domyka KAŻDĄ nie-`done` wiadomość do mnie akcją `Zapoznane`, w tym `task` zdelegowany przez drugą osobę. `markDone` dla `Zapoznane` robi `UPDATE inbox SET status='done'` bez żadnego reply (`lib/inbox-db.js:365`), a widok „Delegowane" nadawcy filtruje `i.status != 'done'` (`lib/inbox-db.js:301-318`) — zadanie ZNIKA z listy delegującego bez jednej wiadomości zwrotnej. Komentarz nagłówkowy (`scripts/inbox/close.mjs:11`) twierdzi odwrotnie: „delegacja zostaje w Delegowanych". To dokładnie ta klasa cichej utraty sygnału, którą U5 miało likwidować.

**Akcja:** dla `type === 'task'` użyć akcji `Zrobione` (albo świadomie odmówić domknięcia taska komendą `close`) i przybić to testem, w którym atrapa huba odwzorowuje `delegated`.

#### P2-2 · TEST · loader sekretu skilla `deleguj` (poza repo)

Loader sekretu skilla `deleguj` (`<vault>/.claude/skills/deleguj/scripts/env.mjs`) wraz z 4 testami (`env.test.mjs`) został zmieniony i pozostawiony POZA repo — `npm test` go nie obejmuje, a to ten kod rozstrzyga, skąd wczytywany jest `INBOX_TOKEN` (kolejność `INBOX_ENV_FILE` → `$PULS_HOME` → wskaźnik → legacy `.env`). Ten sam wzorzec awarii U5 właśnie naprawiło dla `close.mjs` („kopia w vaulcie cicho rozjechała się z repo"), tyle że tu drift dotyczy ścieżki sekretu. Nie da się też zweryfikować, czy loader sprawdza ISTNIENIE `$PULS_HOME/data/inbox.env` przed zaakceptowaniem wartości (`settings.json` vaulta bywa synchronizowany z obcą, maszynowo-specyficzną ścieżką).

**Akcja:** przenieść loader do `scripts/inbox/` obok `env-loader.mjs`, a skill w vaulcie niech importuje go przez `$PULS_HOME` — tak jak robi to teraz z `close.mjs`.

#### P2-3 · KOD · `scripts/install-vps.sh:1086`

Oba nowe kontrakty `PULS_HOME` (`env.PULS_HOME` w `settings.json` i wskaźnik `~/.claude-cron-home`) pisze WYŁĄCZNIE `setup.mjs`, którego ścieżka VPS nie uruchamia (komentarz w tym samym pliku potwierdza ten sam mechanizm dla `data/version.json`). Na maszynie 24/7 — czyli tej z rolą `agent` — żaden z dwóch wskaźników nie powstaje, więc wywołania `node "$PULS_HOME/scripts/inbox/close.mjs"` trafiają w guard „brak PULS_HOME", a R4 („bez ani jednego ręcznego kroku") jest spełnione tylko na ścieżce laptopa.

**Akcja:** w finale `install-vps.sh` (obok zapisu `data/inbox.env` i roli, jako user `claude`) zapisać wskaźnik `~/.claude-cron-home` — analogicznie do długu `version.json` zgłoszonego w review Fazy 1.

#### P2-4 · KOD · `scripts/inbox/close.mjs:79`

Kolejność „najpierw domknij w hubie, potem zapisz archiwum" czyni pad zapisu NIEODWRACALNYM — a to dokładnie regresja, którą U5 miał usunąć. `main()` domyka wszystkie moje wiadomości w wątku (pętla `client.done`, `:68-72`), a `appendToArchive` woła dopiero po pętli (`:79`).

**Scenariusz:** wątek z 2 wiadomościami do mnie, katalog `Zasoby/inbox-archive` chwilowo niedostępny (Obsidian Sync / read-only / brak miejsca) → oba `done` przechodzą (status `done` w hubie), `appendToArchive` rzuca → exit 1; wątek zniknął ze Skrzynki, archiwum puste; ponowne `close --thread-id X` po naprawie dysku leci ścieżką `mine.length === 0` (`:47-58`) i zwraca `{closed:0, archived:false}` — nitki nie da się już zarchiwizować inaczej niż ręcznie w bazie huba. Test „pad zapisu archiwum" (`close.test.mjs:429`) utrwala tę stratę jako zachowanie poprawne, bo sprawdza wyłącznie widoczność błędu.

**Akcja:** naprawa jest tania, bo nitka JEST już w pamięci — `pull()` zwraca `threadRows` (`lib/inbox-db.js:276-327`): `const thread = threadRows.filter(r => r.thread_id === threadId)` i zapis ze snapshotu (przed pętlą albo w `catch` wokół zapisu). Przy okazji znika zależność od pola `thread` w KAŻDEJ odpowiedzi `done` — dziś hub renderuje i przesyła całą nitkę N razy dla N moich wiadomości (N+1 round-tripów z powtarzanym payloadem).

#### P2-5 · KOD · `scripts/inbox/close.mjs:243`

Nowa ścieżka `close` (skill w vaulcie → `node "$PULS_HOME/scripts/inbox/close.mjs"`) woła REPO-owy `env-loader.loadEnv()`, który twardo wymaga `CLAUDE_CRON_WORKSPACE` do wyliczenia `INBOX_ARCHIVE_DIR` (`env-loader.mjs`, `requireWorkspace`). Tymczasem `persistPulsHome()` wpisuje do `{workspace}/.claude/settings.json` WYŁĄCZNIE `PULS_HOME` (`setup.mjs:580-602`), a `CLAUDE_CRON_WORKSPACE` idzie tylko do shell RC / rejestru (`setup.mjs:1288`). Guard w `<vault>/.claude/skills/deleguj/SKILL.md:57` sprawdza również tylko `PULS_HOME`. Efekt: proces mający `PULS_HOME` z `settings.json`, ale bez zmiennej z RC (sesja nie-loginowa, terminal na Windowsie przed relogiem, spawn z innego procesu), przechodzi guard i wywala się komunikatem `Ustaw INBOX_TODO_PATH w .env (brak CLAUDE_CRON_WORKSPACE / INBOX_ENV_FILE)` — czyli tą samą sugestią „wpisz do .env", którą U4 celowo usunął z loadera w vaulcie. `close` potrzebuje wyłącznie `INBOX_ARCHIVE_DIR` + credów huba, więc wymaganie pełnego workspace'u jest zbędne.

**Akcja:** `persistPulsHome` mergeuje przez to samo `mergeEnvIntoSettings` również `CLAUDE_CRON_WORKSPACE`, albo `close.mjs` wyprowadza katalog archiwum bez `requireWorkspace` i daje własny komunikat wskazujący re-run instalatora.

#### P2-6 · KOD · `setup.mjs:1333`

`persistPulsHome()` woła `registerPulsHomeEnv()` bez try/catch, a ta rzuca fail-fast na uszkodzonym `{workspace}/.claude/settings.json`. Skutek: wyjątek leci przez `main()` i ubija CAŁY setup — u usera, który autostartu w ogóle nie chce (wcześniej fail-fast dotyczył tylko `registerHook` po odpowiedzi „T"). Gorzej: rzut następuje PRZED `writePulsHomePointer`, więc user traci OBA mechanizmy lokalizacji instalacji, choć wskaźnik `~/.claude-cron-home` jest niezależny od `settings.json` i zapisałby się bez problemu. Kod przeczy własnemu komentarzowi nad wywołaniem („Pad zapisu = warn, nigdy przerwanie setupu").

**Akcja:** w `persistPulsHome` najpierw `writePulsHomePointer`, a `registerPulsHomeEnv` w try/catch → `[warn]` z tym samym komunikatem (scenariusz planu „uszkodzony settings.json → fail-fast, plik nietknięty" pozostaje spełniony na poziomie `registerPulsHomeEnv`, testowanym w `setup.test.mjs`).

#### P2-7 · TEST · `scripts/inbox/close.test.mjs:372`

Brak testu boundary „wątek z WIELOMA moimi wiadomościami" — wszystkie przypadki używają nitki z jedną wiadomością (`fakeHub([row()])`). Nietestowane pozostają dwa jawnie zadeklarowane w kodzie invarianty: (a) `done` wołane dla KAŻDEJ mojej wiadomości i licznik `closed` sumuje poprawnie, (b) „Archiwum RAZ na wątek, nie raz na wiadomość" (komentarz `close.mjs:271`). Regresja przenosząca `appendToArchive` do wnętrza pętli (duplikat całej nitki w pliku miesiąca) przechodzi cały obecny suite.

**Akcja:** dodaj case — dwa wiersze `to_user:'kacper'` w jednym `thread_id` → `hub.calls.done.length === 2`, `out.closed === 2`, a liczba wystąpień tytułu wątku w pliku miesiąca === 1.

---

### 🟡 P3 — drobne

#### P3-1 · KOD · `scripts/inbox/close.mjs:41`
`--thread-id` trafia z CLI wprost do filtra bez walidacji kształtu: `close.mjs --thread-id --foo` da `thread-id: '--foo'`, a literówka w UUID daje mylącą notę „Brak otwartych wiadomości do mnie" zamiast błędu użycia. Reszta systemu ten identyfikator waliduje (`inbox-push.mjs:45` — `[a-f0-9-]{36}`, hub — `MAX_ID_LEN`). **Akcja:** po `const threadId = ...` dodać guard `if (!/^[a-f0-9-]{36}$/.test(threadId)) throw new Error('close.mjs: --thread-id musi być UUID')` plus jeden test.

#### P3-2 · TEST · `scripts/inbox/close.test.mjs:358`
`withEnv()` nadpisuje globalne `process.env.INBOX_ENV_FILE/INBOX_TODO_PATH/INBOX_SKRZYNKA_PATH/INBOX_ARCHIVE_DIR` i nigdy ich nie przywraca — kolejne testy w procesie runnera dziedziczą wartości z poprzedniego case'u (np. test „zero zapisu" mógłby oglądać katalog z innego przebiegu). **Akcja:** w `withEnv` zrobić snapshot tych czterech kluczy i przywrócić go w `t.after(...)` każdego testu (wzorzec „snapshotuj nadpisywane wartości env").

#### P3-3 · TEST · `setup.test.mjs:284`
Test wskaźnika sprawdza treść przez `.trim()`, więc nie przybija FORMATU, który parsuje czytelnik żyjący poza repo (`<vault>/.claude/skills/deleguj/scripts/env.mjs`) — a `npm test` tego czytelnika nie obejmuje (udokumentowane odchylenie fazy). **Scenariusz:** ktoś rozszerza wskaźnik o drugą linię (`version=2`) albo o JSON — `setup.test.mjs` i `npm test` nadal zielone, a loader w vaulcie bierze całą zawartość za ścieżkę, nie znajduje `data/inbox.env` i skill `deleguj` cicho przestaje działać po re-instalacji. **Akcja:** `assert.equal(fs.readFileSync(pointer,'utf-8'), installDir + '\n')` zamiast porównania po `.trim()`.

#### P3-4 · KOD · `scripts/inbox/inbox-push.mjs:468`
Współdzielony kod archiwum (`archivePath`, `renderArchiveThread`, `appendToArchive`) mieszka w module będącym entry-pointem script-joba — `close.mjs` importuje `inbox-push.mjs` tylko po helper i ciągnie przy okazji jego guard entry-pointa oraz importy klienta. Reguła projektu: shared logic do dedykowanego modułu. **Akcja:** przenieś te trzy funkcje do nowego `scripts/inbox/inbox-archive.mjs`, `inbox-push.mjs` i `close.mjs` niech go importują (testy archiwum → `inbox-archive.test.mjs`).

#### P3-5 · KOD · `scripts/inbox/close.mjs:95`
Defensywa na scenariusze, które nie zachodzą, i rozjazd z istniejącym wzorcem projektu. (1) linia 95: `catch` w `isDirectRun` po padzie `realpathSync` próbuje porównania przez `pathToFileURL` — `realpathSync` rzuca praktycznie tylko gdy ścieżka nie istnieje, a wtedy porównanie i tak jest fałszywe (a `pathToFileURL` samo może rzucić w guardzie modułu). Bliźniaczy `scripts/inbox/migrate-pg-to-hub.mjs:170` ma tam po prostu `return false`. (2) linia 47: domyślka `threadRows = []` — `inbox-client.pull()` weryfikuje `v:1` i zwraca kształt `pullForUser` (`lib/inbox-db.js:276`), który ZAWSZE ma `threadRows`. **Akcja:** `catch { return false; }` oraz `const { user, threadRows } = await client.pull();`.

#### P3-6 · KOD · `setup.mjs:1104`
Dwa mechanizmy na jeden cel — `env.PULS_HOME` w `{workspace}/.claude/settings.json` (`mergeEnvIntoSettings` + `registerPulsHomeEnv`, ~45 linii + 5 testów) oraz wskaźnik `~/.claude-cron-home`. Kolejność szukania w loaderze vaulta (`INBOX_ENV_FILE` → `$PULS_HOME` → wskaźnik → legacy) sprawia, że wskaźnik jest nadzbiorem: działa dla KAŻDEGO procesu, także w sesjach Claude Code z tego workspace'u, więc ścieżka `settings.json` nie odblokowuje żadnego przypadku, którego wskaźnik nie pokrywa — dokłada za to fail-fast na cudzym pliku w miejscu, gdzie wcześniej go nie było. **Uwaga:** oba zapisy są jawnie wymagane checklistą U4 w `docs/plans`, więc redukcja wymaga decyzji autora planu. **Akcja (jeśli plan da się skorygować):** zostaw sam `writePulsHomePointer`, usuń `mergeEnvIntoSettings`/`registerPulsHomeEnv` i 4 dotyczące ich testy z `setup.test.mjs`.

#### P3-7 · KOD · `scripts/inbox/close.mjs:279`
Gdy hub odrzuci wszystkie kandydatury (`result: 'skipped'` — rozjazd `to_user` po kanonizacji nazw — albo `not_found`), wyjście to `{thread_id, closed: 0, archived: false}` BEZ pola `note`, więc skill raportuje userowi „nic się nie stało" bez powodu, a kształt jest nieodróżnialny od realnego błędu. **Akcja:** gdy `mine.length > 0` a `closed === 0`, dołóż `note` z liczbą odrzuconych i wynikami huba (analogicznie do noty przy pustym `mine`).

---

### 🔧 OPERATOR — warunki środowiskowe (poza zakresem fix)

#### OP-1 · `docs/active/naprawy-team-os/naprawy-team-os-kontekst.md:100`
Kontekst zapisuje wynik walidacji jako „853 pass / 1 fail (flake `lib/ask.test.js`)". Przy weryfikacji tego review `npm test` daje **854/854 pass, exit 0** — flake nie reprodukuje się. Checkboxy `Weryfikacja: npm test przechodzi w całości` w U4 i U5 zostały odznaczone w tym review (bookkeeping); pozostaje poprawić notkę o wyniku w kontekście.

#### OP-2 · `setup.mjs:1328` / `~/.claude-cron-home`
Wskaźnik `~/.claude-cron-home` nie istnieje na tej maszynie (`ls ~/.claude-cron-home` → brak), bo `persistPulsHome` biegnie dopiero przy uruchomieniu `setup.mjs`, a instalator po tej fazie nie był odpalony. `PULS_HOME` jest wyłącznie w `<vault>/.claude/settings.json`, czyli działa tylko w sesjach Claude Code z tego workspace'u — drugi tor R4 (procesy spoza sesji CC) pozostaje nieczynny do re-runu instalatora. Weryfikacja niewykonalna headless: wymaga interaktywnego setupu po stronie operatora.

#### OP-3 · `~/.claude-cron-home` + `<vault>/.claude/skills/deleguj/scripts/close.mjs`
Stara kopia `close.mjs` w vaulcie (mtime 28.07) wciąż jest tą, którą realnie widzi vault, jeśli `PULS_HOME` nie jest ustawione. Cała ścieżka U4+U5 pozostaje niezweryfikowana end-to-end (retest T8, warunek 3 „nitka w archiwum"). Weryfikacja wymaga re-runu instalatora przez operatora — nie jest to defekt kodu.

---

## Zgodność ze spec

| Wymaganie | Stan |
|---|---|
| R4 — `PULS_HOME` ustawia instalator, bez ręcznego kroku | ⚠️ częściowo — spełnione tylko na ścieżce laptopa (`setup.mjs`); VPS/`agent` nie dostaje żadnego wskaźnika (P2-3) |
| R2 — `close` archiwizuje wątek, jedna kopia kodu w repo | ⚠️ częściowo — kod jest w repo i testowany, ale kolejność hub→archiwum czyni pad zapisu nieodwracalnym (P2-4); kopia w vaulcie nadal nieusunięta (świadomie — po zielonym T8) |
| „Delegacja zostaje w Delegowanych" (komentarz `close.mjs:11`) | ❌ nie spełnione — `Zapoznane` na tasku znika z widoku nadawcy bez reply (P2-1) |
| Sekret poza drzewem vaulta, komunikat bez sugestii `.env` | ✅ spełnione (`MISSING_CONFIG_MESSAGE` wskazuje re-run instalatora) |

**Odchylenia od planu:** loader `env.mjs` + jego testy żyją poza repo, więc `npm test` ich nie obejmuje (P2-2). Checklista U5 „Usuń `<vault>/…/close.mjs`" świadomie niezaznaczona — zależy od zielonego T8 (operator).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **6**
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `node --test setup.test.mjs` przechodzi → PASS (124/124, exit 0)
- [x] CLI: `npm test` przechodzi w całości (U4) → PASS (854/854, exit 0)
- [x] Grep: `grep -rn "\.env" <vault>/.claude/skills/deleguj/scripts/env.mjs` — brak komunikatu namawiającego do zapisu sekretu w vaulcie → PASS (`MISSING_CONFIG_MESSAGE` kieruje do instalatora, komentarz `:84-86` wprost uzasadnia decyzję)
- [x] CLI: `node --test scripts/inbox/close.test.mjs` przechodzi → PASS (6/6, exit 0)
- [x] CLI: `npm test` przechodzi w całości (U5) → PASS (854/854, exit 0)
- [x] Grep: `grep -n "export.*function appendToArchive" scripts/inbox/inbox-push.mjs` → PASS (`inbox-push.mjs:97`)

Bookkeeping **nie dołożył** nowych P2 ani P3 — severity gate bez zmian (ZASTRZEŻENIA).

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 10 (6) |
| Flagi warstw | ui=true dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage, e2e |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 40 -> 40 -> 21 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 11 / 4 / 0 |
