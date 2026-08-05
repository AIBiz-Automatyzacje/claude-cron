# Naprawy Team OS — checklista zadań

**Branch:** `feature/naprawy-team-os`
**Ostatnia aktualizacja:** 2026-08-05

Plan techniczny: [docs/plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md](../../plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md)
Szablon rund testowych: `Zadania/projekty/personal-team-os/szablon-testow-team-os.md`

> **Bramka globalna dla każdego unitu:** `npm test` przechodzi w całości, baseline **155/155** nie spada.
> `Operator checklist` odznacza **człowiek** — te kroki są celowo poza automatyzacją.

---

## Faza 1 — Widoczność i hub

### U1 — Wersja instalacji widoczna w `/api/status` *(R10a, nakład M, zależności: brak)*

- [ ] Stwórz `lib/version.js` — czysty odczyt `data/version.json` (rewizja, data pobrania, źródło) z fallbackiem `unknown`
- [ ] Stwórz `lib/version.test.js`
- [ ] Modyfikuj `server.js` — pole wersji w `/api/status` (~`:344`, obok `repo_dir`)
- [ ] Modyfikuj `setup.mjs` — zapis `data/version.json` **po** swapie katalogów (allowlista stanowa)
- [ ] Modyfikuj `install.sh` — przekazanie faktycznie pobranej rewizji
- [ ] Modyfikuj `install.ps1` — j.w. + pobieranie zipa **po skrócie commita**, nie po nazwie gałęzi
- [ ] Test: plik wersji istnieje i poprawny → `/api/status` zwraca rewizję i datę
- [ ] Test: plik nie istnieje (stara instalacja) → `unknown`, bez rzucania wyjątku
- [ ] Test: plik uszkodzony / niepełny JSON → `unknown`, bez rzucania wyjątku
- [ ] Weryfikacja: `node --test lib/version.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości (baseline 155/155)
- [ ] Weryfikacja: `curl -s localhost:7777/api/status` zwraca niepuste pole wersji

**Operator checklist:**
- [ ] Instalacja zipowa na Windows raportuje tę samą rewizję co pobrany zip

---

### U2 — Hub odrzuca nieznanego adresata i prostuje wielkość liter *(R1, nakład L, zależności: brak)*

> **Notatka wykonawcza:** zacznij od failing testu `sendMessage(to_user='cav')` → oczekiwany
> `InboxDbError`. To zachowanie kontraktowe huba — przybij je testem przed dotknięciem schematu.

- [ ] Modyfikuj `lib/inbox-db.js` — `migrate()`: `members.name` na `COLLATE NOCASE` (przepisanie tabeli, idempotentne, fail-fast przy istniejącym duplikacie z **nazwami**)
- [ ] Modyfikuj `lib/inbox-db.js` — `sendMessage()`: lookup po `listMembers()` przed `INSERT`, dopasowanie case-insensitive → podmiana na nazwę kanoniczną; brak trafienia **lub więcej niż jedno** → `InboxDbError`
- [ ] Modyfikuj `lib/inbox-db.js` — `addMember()`: duplikat case-insensitive → `InboxDbError`
- [ ] Modyfikuj `lib/inbox-api.js` — `handleSend:169` mapuje `InboxDbError` na `400 unknown_recipient` **z listą członków**
- [ ] Modyfikuj `lib/inbox-db.test.js`
- [ ] Modyfikuj `lib/inbox-api.test.js`
- [ ] Test: `to_user='cave'` przy członku `Cave` → INSERT z `to_user='Cave'`
- [ ] Test: `to_user='cav'` → `InboxDbError`, **zero wierszy** w `inbox`
- [ ] Test: `handleSend` z nieznanym adresatem → `400`, ciało zawiera listę członków
- [ ] Test: `addMember('cave')` przy istniejącym `Cave` → `InboxDbError`
- [ ] Test: migracja na bazie z `Cave` i `cave` → czytelny błąd z obiema nazwami, baza nietknięta
- [ ] Test: migracja idempotentna — drugi `migrate()` nie przepisuje tabeli
- [ ] Weryfikacja: `node --test lib/inbox-db.test.js` przechodzi
- [ ] Weryfikacja: `node --test lib/inbox-api.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości
- [ ] Weryfikacja: `grep -n "COLLATE NOCASE" lib/inbox-db.js` zwraca trafienie w definicji `members`

**Operator checklist:**
- [ ] Kopia zapasowa `data/inbox.db` z VPS przed deployem
- [ ] Migracja przetestowana na kopii żywej bazy
- [ ] Zapytanie kontrolne na hubie: czy są wiersze `inbox` z `to_user` spoza `members`
- [ ] Restart daemona na VPS po deployu

---

### U3 — Odpowiedziane pytanie znika z „Wysłanych" (T6) *(R3, nakład S, zależności: U2)*

- [ ] Modyfikuj `lib/inbox-db.js` — `pullForUser:177`, zapytanie `delegated`: alias `FROM inbox i` + `NOT EXISTS (reply w tym thread_id **od kogoś innego niż `i.from_user`**)`, ograniczone do `type='query'`
- [ ] Modyfikuj `lib/inbox-db.test.js`
- [ ] Test: `query` + `reply` od adresata → **nie ma** w `delegated`
- [ ] Test: `query` + `reply` **od samego nadawcy** → **jest** w `delegated` (własne dopowiedzenie nie zamyka)
- [ ] Test: `task` + `reply` od adresata → **jest** w `delegated` (zadania zamyka checkbox)
- [ ] Test: `query` bez odpowiedzi → jest w `delegated`
- [ ] Test: wątek z dopowiedzeniem nadawcy pozostaje znajdowalny przez `findOriginal` (regresja `reply.mjs`)
- [ ] Weryfikacja: `node --test lib/inbox-db.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

**Operator checklist:**
- [ ] **Retest T6** wg szablonu, z wariantem kontrolnym „własne dopowiedzenie nie zamyka"
- [ ] Dopisanie do `STATUS.md` zdania o świadomym długu widok↔status

---

## Faza 2 — Granica repo ↔ vault

### U4 — `PULS_HOME` ustawia instalator, nie człowiek *(R4, nakład L, zależności: brak — musi poprzedzać U5)*

- [ ] Modyfikuj `setup.mjs` — `PULS_HOME` do sekcji `env` w `{workspace}/.claude/settings.json` (idempotentny merge obok wpisu hooka, `:176` / `:1064`)
- [ ] Modyfikuj `setup.mjs` — zapis wskaźnika `~/.claude-cron-home` z **faktycznym** katalogiem instalacji
- [ ] Modyfikuj `setup.test.mjs`
- [ ] Modyfikuj `<vault>/.claude/skills/deleguj/scripts/env.mjs` — kolejność: `INBOX_ENV_FILE` → `$PULS_HOME/data/inbox.env` → **`~/.claude-cron-home` → `<ścieżka>/data/inbox.env`** → walk-up `.env` (legacy)
- [ ] Modyfikuj `<vault>/.claude/skills/deleguj/scripts/env.mjs` — komunikat błędu **przestaje** sugerować wpisanie sekretu do `.env` w vaulcie; wskazuje re-run instalatora
- [ ] Modyfikuj `<vault>/.claude/skills/deleguj/SKILL.md` — opis nowej kolejności szukania
- [ ] Test: merge `env.PULS_HOME` do pustego `settings.json` → klucz dodany
- [ ] Test: merge do `settings.json` z istniejącym `env` i wpisem hooka → oba zachowane
- [ ] Test: re-run z tą samą wartością → brak zmiany pliku (idempotencja)
- [ ] Test: uszkodzony `settings.json` → fail-fast, plik **nietknięty**
- [ ] Test: wskaźnik zapisany z niedomyślnym katalogiem instalacji
- [ ] Test: loader w vaulcie — brak `PULS_HOME`, obecny wskaźnik → sekret znaleziony
- [ ] Test: loader — brak obu → komunikat **bez** sugestii zapisu do `.env` vaulta
- [ ] Weryfikacja: `node --test setup.test.mjs` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości
- [ ] Weryfikacja: `grep -rn "\.env" <vault>/.claude/skills/deleguj/scripts/env.mjs` — brak komunikatu namawiającego do zapisu sekretu w vaulcie

---

### U5 — `close` archiwizuje wątek, jedna kopia kodu w repo *(R2, nakład L, zależności: **U4**)*

- [ ] Stwórz `scripts/inbox/close.mjs` (przeniesienie z vaulta, import `appendToArchive`)
- [ ] Stwórz `scripts/inbox/close.test.mjs`
- [ ] Modyfikuj `scripts/inbox/inbox-push.mjs` — eksport `appendToArchive` (zachowanie bez zmian, zmienia się widoczność)
- [ ] Modyfikuj `scripts/inbox/inbox-push.test.mjs`
- [ ] Modyfikuj `<vault>/.claude/skills/deleguj/SKILL.md` — wywołanie `node $PULS_HOME/scripts/inbox/close.mjs` + **guard na brak `PULS_HOME`** (czytelny komunikat zamiast `MODULE_NOT_FOUND`)
- [ ] Usuń `<vault>/.claude/skills/deleguj/scripts/close.mjs` — **dopiero po zielonym T8**
- [ ] Test: `close` na otwartym wątku → hub dostaje `done` **i** nitka trafia do pliku miesiąca
- [ ] Test: `close` powtórzony → `closed: 0`, **archiwum bez drugiego wpisu**
- [ ] Test: `close` na wątku bez wiadomości do mnie → czytelna nota, zero zapisu
- [ ] Test: pad zapisu archiwum → błąd widoczny w wyjściu, nie ciche `exit 0`
- [ ] Weryfikacja: `node --test scripts/inbox/close.test.mjs` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości
- [ ] Weryfikacja: `grep -n "export.*function appendToArchive" scripts/inbox/inbox-push.mjs` zwraca trafienie

**Operator checklist:**
- [ ] **Retest T8** wg szablonu — z warunkiem 3 (nitka w archiwum)
- [ ] Usunięcie kopii `close.mjs` z vaulta po zielonym T8
- [ ] Zdjęcie ostrzeżenia „domykać wyłącznie checkboxami" ze `STATUS.md`

---

## Faza 3 — Format Skrzynki i archiwum

### U6 — Frontmatter Skrzynki domergowuje się przy każdym pull *(R12, nakład M, zależności: brak)*

- [ ] Modyfikuj `scripts/inbox/inbox-pull.mjs` — merge brakujących kluczy z `SKRZYNKA_TEMPLATE:197` (`cssclasses`, `tags`) bez ruszania wartości już obecnych
- [ ] Modyfikuj `scripts/inbox/inbox-pull.test.mjs`
- [ ] Test: plik bez `cssclasses` → po pullu ma `cssclasses: [skrzynka]`
- [ ] Test: plik z własnym kluczem w frontmatterze → klucz przetrwał
- [ ] Test: plik z `cssclasses` o innej wartości → wartość **nie jest** nadpisana
- [ ] Test: plik bez frontmattera → dostaje pełny blok z szablonu
- [ ] Test: roundtrip push↔pull dalej przechodzi (regresja kontraktu markerów)
- [ ] Weryfikacja: `node --test scripts/inbox/inbox-pull.test.mjs` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

---

### U7 — Archiwum bez duplikatów: marker + podmiana bloku *(R8, nakład M, zależności: U5)*

- [ ] Modyfikuj `scripts/inbox/inbox-push.mjs` — `renderArchiveThread:74` emituje marker `%% thread:<id> %%` (**dziś go nie ma** — marker żyje wyłącznie w renderze Skrzynki)
- [ ] Modyfikuj `scripts/inbox/inbox-push.mjs` — `appendToArchive:94`: wczytaj plik miesiąca, znajdź blok po `thread_id`, **podmień** jeśli jest, dopisz jeśli nie ma
- [ ] Modyfikuj `scripts/inbox/inbox-push.test.mjs`
- [ ] Test: pierwszy zapis wątku → jeden blok z markerem
- [ ] Test: drugi zapis tego samego wątku (więcej wiadomości) → **dalej jeden blok**, treść nowsza
- [ ] Test: drugi wątek → dwa niezależne bloki, kolejność zachowana
- [ ] Test: plik z blokiem bez markera (sprzed zmiany) → nowy zapis dokłada blok, stary nietknięty
- [ ] Test: plik miesiąca nie istnieje → tworzony z nagłówkiem, jak dziś
- [ ] Weryfikacja: `node --test scripts/inbox/inbox-push.test.mjs` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

**Operator checklist:**
- [ ] Jednorazowe usunięcie istniejących duplikatów z `Zasoby/inbox-archive/2026-08.md`

---

### U8 — Job „Puls — kontrola spójności" + `/onboard --refresh-theme` *(R13, R15, nakład L, zależności: U1, U6)*

- [ ] Stwórz `scripts/consistency-check.mjs` — dwie kontrole w jednym jobie: wersja kodu (z U1) i zgodność snippetu CSS z szablonem w pluginie
- [ ] Stwórz `scripts/consistency-check.test.mjs`
- [ ] Modyfikuj `lib/starter-jobs.js` / `templates/starter-jobs.json` — seed joba (`routine=1`, wzór z `lib/inbox-seed.js`: nigdy `updateJob`)
- [ ] Implementuj wystawianie zadania: **komenda naprawcza w treści**, `termin:` w frontmatterze, rozpoznawanie „już wisi" po **ukrytym znaczniku**, nie po tytule
- [ ] Modyfikuj `<aibiz-plugin>/plugins/aibiz/skills/onboard/SKILL.md` — tryb `--refresh-theme` (kopiuje snippety + włącza w Fragmentach CSS + dopisuje `cssclasses`)
- [ ] Test: snippet zgodny i wersja aktualna → **brak zadania**
- [ ] Test: snippet rozjechany → jedno zadanie, w treści komenda naprawcza, w frontmatterze `termin:`
- [ ] Test: drugi przebieg przy niezmienionym rozjeździe → **brak drugiego zadania**
- [ ] Test: zmieniony tytuł istniejącego zadania → rozpoznane po znaczniku, brak duplikatu
- [ ] Test: rozjazd naprawiony → kolejny przebieg nie tworzy nic nowego
- [ ] Test: brak szablonu w pluginie (Puls bez pluginu) → job kończy się cicho, bez błędu
- [ ] Weryfikacja: `node --test scripts/consistency-check.test.mjs` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

**Operator checklist:**
- [ ] **Test T14** wg szablonu (rozjazd → jedno zadanie → drugi przebieg bez duplikatu)
- [ ] **Test T13** wg szablonu (frontmatter, wspólnie z U6)
- [ ] Dopisanie „Obsidian zaktualizowany do najnowszej wersji" jako kroku onboardingu (R15)

---

## Faza 4 — Konfiguracja VPS

### U9 — Panel: adres w użyciu obok zapisanego + sygnał rozjazdu *(R7, nakład M, zależności: U1)*

- [ ] Stwórz `lib/persisted-env.js` — odczyt utrwalonej wartości: Windows rejestr HKCU, Unix linia `export` z `~/.zshrc`/`~/.bashrc`
- [ ] Stwórz `lib/persisted-env.test.js`
- [ ] Dopisz komentarz wiążący parser z `upsertEnvLine` (`setup.mjs:312`) **po obu stronach** — świadoma druga implementacja (ESM↔CJS), precedens `INBOX_CODE_PREFIX`
- [ ] Modyfikuj `server.js` — `/api/status`: adres z pamięci procesu + adres zapisany (odczyt w czasie żądania) + flaga rozjazdu
- [ ] Modyfikuj `public/index.html`, `public/app.js` — pole w ustawieniach na górze panelu + komunikat „zmiana wymaga restartu"
- [ ] Zabezpiecz `/api/vps/*` — brak nowych pól po drugiej stronie **nie może** wywalić widoku
- [ ] Test: RC z `export CLAUDE_CRON_VPS_URL="https://x"` → parser zwraca `https://x`
- [ ] Test: RC z zakomentowaną / uszkodzoną linią → `null`, bez rzucania
- [ ] Test: brak pliku RC → `null`, bez rzucania
- [ ] Test: wartość ze spacjami i cudzysłowami → poprawnie odkodowana
- [ ] Test: `/api/status` — wartość z pamięci ≠ zapisana → flaga rozjazdu `true`
- [ ] Test: wartości równe → flaga `false`
- [ ] Weryfikacja: `node --test lib/persisted-env.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości
- [ ] Weryfikacja: `curl -s localhost:7777/api/status` zwraca oba pola adresu i flagę rozjazdu

**Operator checklist:**
- [ ] **Sprawdzenie M1** wg szablonu (zmiana adresu bez restartu → ostrzeżenie; po restarcie znika)

---

### U10 — Instalator podpowiada zapisany adres VPS *(R11, nakład S, zależności: U9)*

- [ ] Modyfikuj `setup.mjs` — zapisana wartość jako domyślna w pytaniu o adres VPS (jak dla portu i workspace'u)
- [ ] Modyfikuj `setup.mjs` — pusty Enter przy istniejącej konfiguracji → „bez zmian: `<adres>`"; „Tryb tylko lokalny" **wyłącznie** gdy adresu faktycznie nie ma
- [ ] Modyfikuj `setup.test.mjs`
- [ ] Test: zapisany adres + pusty Enter → wartość zachowana, komunikat „bez zmian"
- [ ] Test: brak zapisanego adresu + pusty Enter → „tryb tylko lokalny", env nie zapisywany
- [ ] Test: podany nowy adres → nadpisuje stary
- [ ] Test: adres z białymi znakami / cudzysłowami → sanityzowany jak dziś (`buildVpsUrl`)
- [ ] Weryfikacja: `node --test setup.test.mjs` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

**Operator checklist:**
- [ ] **Sprawdzenie M3** wg szablonu

---

## Faza 5 — Aktualizacja i dystrybucja

### U11 — Aktualizacja Pulsa przyciskiem w panelu *(R10 b/c/d, nakład XL, zależności: U1)*

- [ ] Stwórz `lib/updater.js` — sprawdzenie dostępności przez publiczne API GitHuba + porównanie z rewizją z U1
- [ ] Stwórz `lib/updater.test.js`
- [ ] Modyfikuj `server.js` — endpointy sprawdzenia i uruchomienia aktualizacji
- [ ] Implementuj updater macOS — `git pull --ff-only` + zgaszenie procesu (launchd/hook podnosi sam)
- [ ] Implementuj updater Windows — PowerShell przeżywający śmierć rodzica; ubijanie filtrem po **ścieżce instalacji**, nigdy po nazwie binarki
- [ ] Modyfikuj `install.ps1` — tryb nieinteraktywny dla ścieżki updatera
- [ ] Modyfikuj `public/app.js`, `public/index.html` — badge + przycisk + odpytywanie aż wróci nowa wersja, z **komunikatem o niepowodzeniu** po przekroczeniu czasu
- [ ] Test: wersja lokalna == zdalna → brak sygnału aktualizacji
- [ ] Test: wersja lokalna starsza → sygnał z numerem
- [ ] Test: wersja `unknown` → czytelny stan „nie wiem", **nie** fałszywe „aktualne"
- [ ] Test: API GitHuba niedostępne → stan „nie udało się sprawdzić", panel nie wisi
- [ ] Weryfikacja: `node --test lib/updater.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

**Operator checklist:**
- [ ] Windows: aktualizacja przy działającym daemonie → `data\` i `.node\` nietknięte, serwer wraca
- [ ] Mac: aktualizacja → proces wraca sam, wersja w panelu nowa
- [ ] **Sprawdzenie M2** wg szablonu, na Macu i na CAVE

---

### U12 — Aktualizacja pluginu zespołowego *(R14, R15, nakład M, zależności: **wszystkie pozostałe zrobione I przetestowane**)*

- [ ] Modyfikuj `<aibiz-plugin>/plugins/aibiz/skills/onboard/templates/skrzynka.css` — synchronizacja z rendererem
- [ ] Modyfikuj `<aibiz-plugin>/plugins/aibiz/skills/onboard/SKILL.md` — opis flow Skrzynki, `--refresh-theme`, wymagana wersja Obsidiana
- [ ] Weryfikacja: `npm test` przechodzi w całości (regresja po stronie renderera)

**Operator checklist:**
- [ ] ⚠️ Wyjaśnienie niezacommitowanych cudzych zmian w `aibiz-plugin` z autorem (`D hooks/frontmatter-validate.sh`, `M hooks/hooks.json`) — **przed pushem**
- [ ] `/plugin-zespolowy check`
- [ ] Push + `Update marketplace` + `/reload-plugins` u zespołu
- [ ] **CAVE:** `install.ps1` + świeże snippety w tamtejszym vaulcie
- [ ] **VPS:** `git pull` + restart usługi
- [ ] Wygląd Skrzynki identyczny na Macu, VPS i CAVE
- [ ] **Pełna runda testowa** wg `szablon-testow-team-os.md` — wypełnić BILANS (12 pozycji) i tabelę regresji
- [ ] Przeniesienie nowych znalezisk do `STATUS.md`
