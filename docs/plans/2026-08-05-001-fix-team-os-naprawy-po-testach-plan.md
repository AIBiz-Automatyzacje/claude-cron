---
title: "fix: Naprawy Team OS po testach end-to-end 04.08"
type: fix
status: active
date: 2026-08-05
origin: Zadania/projekty/personal-team-os/STATUS.md (sekcja „🔥 NASTĘPNA SESJA") + dziennik testów testy-team-os-2026-08-03.md + sesja /zroastuj-mnie 05.08
design_md: null
figma_spec: null
figma_screens: {}
---

# fix: Naprawy Team OS po testach end-to-end 04.08

## Przegląd

04.08 Team OS przeszedł pierwsze testy end-to-end jako produkt (10 scenariuszy, T1–T10): 9 zdanych,
T6 oblany. Runda wyprodukowała 14 znalezisk, po przeglądzie 05.08 zostało 11, a sesja roastu
05.08 dołożyła pozycję 15 i zmieniła warianty rozwiązań w pięciu pozycjach.

Plan porządkuje to w 12 Implementation Units w 5 fazach. Kolejność nie jest kosmetyczna — wynika
z twardych zależności (poz. 2 wymaga poz. 4, cała lista wymaga widoczności wersji z poz. 10a).

**Motyw przewodni wszystkich napraw:** system ma dziś wzorzec **cichej awarii** — hub przyjmuje
nieistniejącego adresata bez błędu, `close` kasuje treść bez śladu, panel pokazuje konfigurację,
której nie używa. Każdy unit ma dokładać **widoczny sygnał porażki**, nie tylko poprawiać ścieżkę
szczęśliwą.

## Ujęcie problemu

Team OS jest w dogfoodingu i trafi do kursantów Akademii jako plugin zespołowy. Dziś:

1. **Wiadomości giną bez śladu** — literówka w nicku adresata (`cave` zamiast `Cave`) przechodzi
   przez hub bez błędu; u nadawcy wygląda jak normalnie czekająca. Zjadło dwie wiadomości w jeden dzień.
2. **Treść znika przy domykaniu** — komenda `close` nie archiwizuje wątku. Do czasu naprawy
   obowiązuje obejście operacyjne: domykać **wyłącznie checkboxami**.
3. **Odpowiedziane pytanie zostaje w „Wysłanych"** — jedyny oblany test (T6); ten sam wątek widnieje
   w dwóch sekcjach naraz, licznik „w toku" zawyża.
4. **Onboarding wymaga wiedzy technicznej** — brak `PULS_HOME` wywraca `/deleguj`, a komunikat błędu
   sugeruje cofnięcie migracji bezpieczeństwa (wpisanie sekretu do `.env` w vaulcie).
5. **Nie wiadomo, co która maszyna ma zainstalowane** — brak numeru wersji; 04.08 CAVE renderował
   Skrzynkę starym kodem w trakcie testów i część wyników poszła do kosza.

## Śledzenie wymagań

Numeracja `Rn` odpowiada numerom pozycji z `STATUS.md`, żeby ślad wstecz był jednoznaczny.

- **R1** — hub odrzuca nieznanego adresata i sam prostuje wielkość liter; `cave` → `Cave`, `cav` → błąd z listą członków
- **R2** — `close` archiwizuje pełną nitkę wątku, tak samo jak checkbox
- **R3** — odpowiedziane `query` znika z „Wysłanych" bez akcji człowieka (retest T6)
- **R4** — `/deleguj` działa po świeżej instalacji bez ręcznego ustawiania czegokolwiek
- **R7** — panel pokazuje adres VPS faktycznie używany **oraz** zapisany w konfiguracji i sygnalizuje rozjazd
- **R8** — archiwum zawiera każdy wątek dokładnie raz, także przy domykaniu etapami
- **R10** — wersja własnego kodu widoczna w `/api/status` na każdej maszynie; aktualizacja przyciskiem w panelu
- **R11** — instalator podpowiada zapisany adres VPS; pusty Enter = „bez zmian", nie „tryb tylko lokalny"
- **R12** — brakujące klucze frontmattera Skrzynki domergowują się przy każdym pull, bez ruszania istniejących
- **R13** — rozjazd wyglądu i wersji jest zgłaszany jako zadanie w Dashboardzie z komendą naprawczą w treści
- **R14** — plugin zespołowy zaktualizowany; identyczny wygląd na wszystkich maszynach
- **R15** — minimalna wersja Obsidiana jako krok onboardingu

## Granice scope'u

- **Nie ruszamy pozycji 5, 6 i 9** — zamknięte decyzją 05.08 (rotacja tokenów ręcznie · asystent nie
  odpowiada na dopytania · zombie-job wykreślony). Nie wskrzeszać bez nowego argumentu.
- **Nie przeładowujemy `CLAUDE_CRON_VPS_URL` w locie** — decyzja 05.08: pokazywać, nie przeładowywać.
- **Nie przepisujemy CSS bez `:has()`** — update Obsidiana na CAVE naprawił wygląd (potwierdzone 05.08).
  Zostaje wymaganie wersji w onboardingu (R15).
- **Nie domykamy statusem odpowiedzianych `query`** — R3 jest naprawą **widoku**; rekord zostaje
  `delivered` w bazie. Świadomy dług, patrz „Otwarte pytania".
- **Nie budujemy punktów deployu ani synchronizacji maszyn** — CAVE jest środowiskiem testowym,
  dostaje jeden deploy na koniec, pod rundę testową.
- **Nie dotykamy hasła w historii gita vaulta** (`b05de80f`, `72d2de9d`) — osobny incydent, poza tą listą.

## Kontekst i research

### Relevantny kod i wzorce

| Obszar | Plik | Uwaga |
|---|---|---|
| Hub — wysyłka, pull, claim | `lib/inbox-db.js` (`sendMessage:135`, `pullForUser:177`, `claimQuery:255`, `addMember`, `listMembers`) | jedyna granica JSON `payload`; idempotencja i atomowość siedzą tutaj |
| Hub — API | `lib/inbox-api.js` (`handleSend:169`) | walidacja na granicy, kody bez treści dla intruzów |
| Schemat huba | `lib/inbox-db.js:76` | `members.name TEXT NOT NULL UNIQUE` — **UNIQUE case-sensitive** |
| Archiwum | `scripts/inbox/inbox-push.mjs` (`appendToArchive:94` — prywatna, `renderArchiveThread:74`, `archivePath:59`) | eksporty: `extractInboxSection`, `parseCheckedCallouts`, `archivePath`, `renderArchiveThread`, `main` |
| Renderer Skrzynki | `scripts/inbox/inbox-pull.mjs` (`SKRZYNKA_TEMPLATE:197`, `replaceBetweenMarkers:247`) | podmienia tylko treść między markerami, frontmattera nie rusza |
| Loader sekretu (repo) | `scripts/inbox/env-loader.mjs` (`DEFAULT_INBOX_SECRET_FILE`, `resolveInboxSecretFile`) | liczy `REPO_ROOT` z `import.meta.url` — **nie potrzebuje `PULS_HOME`** |
| Loader sekretu (vault) | `<vault>/.claude/skills/deleguj/scripts/env.mjs` | zna tylko `INBOX_ENV_FILE` → `$PULS_HOME/data/inbox.env` → walk-up `.env` |
| Persystencja env | `setup.mjs` (`persistEnvVar:777`, `upsertEnvLine:312`, `buildSetUserEnvCommand`) | Windows → rejestr HKCU; Unix → `export` w `~/.zshrc` |
| Merge do settings.json | `setup.mjs` (`mergeHookIntoSettings:176`, zapis `:1064`) | gotowe miejsce wpięcia dla sekcji `env` |
| Status API | `server.js:344` | już zwraca `repo_dir` z tego samego powodu („dwie instalacje na jednej maszynie") |
| Pobieranie zipa | `install.ps1` (`Expand-RepoFromZip:231-246`) | pobieranie i rozpakowanie z zachowaniem `data\` i `.node\` już napisane |
| Config | `lib/config.js:28` | `VPS_API_URL` czytany raz, przy ładowaniu modułu |

### Wiedza instytucjonalna (`docs/solutions/`)

- **`2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md`** — `migrate()` leci przy każdym boocie;
  backfill danych wymaga sentinela albo jednorazowego skryptu. Dotyczy U2.
- **`2026-07-07-stale-env-vps-url-hook-respawn-serwera.md`** — dokładnie ten problem co R7; wniosek:
  diagnoza wymaga **porównania źródeł**, nie odczytu jednego. Dotyczy U9.
- **`2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md`** — Windows nie przeniesie
  pliku z otwartym uchwytem (ubijać procesy filtrem po ścieżce instalacji); `raw.githubusercontent.com`
  cachuje adresy z nazwą gałęzi. Dotyczy U1 i U11.
- **`2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-eksfiltracja-prompt-injection.md`** — `cwd`
  spawnu agenta to granica bezpieczeństwa; sekret nigdy w drzewie vaulta. Dotyczy U4 (komunikat błędu
  nie może sugerować powrotu do `.env` w vaulcie).
- **`2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md`** — po zapisie decyduj na świeżym
  odczycie. Wzorzec już zastosowany w `markDone`, utrzymać w U2.

### Referencje zewnętrzne

Pominięte świadomie — wszystkie zmiany dotyczą kodu własnego i udokumentowanych wzorców w repo.
Jedyny punkt styku z zewnętrznym API (GitHub Releases/Commits w U11) jest publiczny i sprawdzony 05.08.

## Kluczowe decyzje techniczne

| Decyzja | Uzasadnienie |
|---|---|
| **Kolejność `10a → 1 → 3 → 4 → 2 → …`** | Wariant A poz. 2 przenosi `close.mjs` do repo, więc skill musi znać `PULS_HOME`, żeby **znaleźć sam plik** — to twardsze wymaganie niż dzisiejszy fallback na sekret. Odwrotna kolejność = `close` nie startuje na Macu i CAVE |
| **Walidacja adresata w `sendMessage`, nie w API** | Jedno miejsce chroni wszystkie ścieżki wejścia (hub API, przyszli klienci). Zgodne z zasadą „logika trudna po stronie huba" |
| **`members.name` case-insensitive na poziomie schematu** | Dziś `Cave` i `cave` mogą istnieć obok siebie z osobnymi tokenami; wtedy „nazwa kanoniczna" wychodzi z kolejności `id`, czyli z przypadku. Migracja tabeli **wysypie się przy istniejącym duplikacie** — to pożądany fail-fast |
| **Predykat R3: „odpowiedział ktoś inny niż ja"** | `reply.mjs:57` pozwala dopisać odpowiedź do własnego wątku. Predykat „istnieje jakikolwiek reply" kasowałby własne pytanie z listy **i** psuł `findOriginal` w `reply.mjs` (kolejna odpowiedź → „nie znalazłem otwartego wątku") |
| **Wskaźnik `~/.claude-cron-home` zapisywany przez instalator** | Katalog instalacji jest wolnym wejściem usera (`ask_install_dir`), więc zgadywanie `$HOME/claude-cron` nie działa nawet na Macu autora (repo stoi w `~/Documents/Kodowanie/claude-cron`). Konwencja już istnieje: `~/.claude-cron-oauth-token` |
| **Wersja z pliku zapisanego przez instalator, nie z gita** | CAVE instaluje się zipem bez `.git` — `git rev-parse` nie ma czego czytać na jedynej maszynie, dla której ta funkcja powstała |
| **Panel pokazuje DWIE wartości adresu VPS** | Jedna liczba nie odpowiada na pytanie „czy używam tego, co ustawiłem" — a to ono kosztowało godzinę 04.08. Persystencja istnieje po obu stronach (`~/.zshrc` / rejestr HKCU), więc drugie źródło jest odczytywalne |
| **Poz. 13 bez maszyny stanu — zadanie wisi do naprawy** | Skoro naprawa to jedna komenda, „zamykam bez naprawy" nie jest realnym scenariuszem. **Warunek: komenda musi być w treści zadania** — inaczej mechanizm jest naganiaczem bez dźwigni |
| **Dedup archiwum wymaga DODANIA markera** | Wbrew założeniu w STATUS `renderArchiveThread` **nie emituje** `%% id:… thread:… %%` (marker żyje wyłącznie w renderze Skrzynki, `inbox-pull.mjs:116,140`). Bez markera nie ma po czym dopasować bloku |

## Otwarte pytania

### Rozwiązane podczas planowania

- **Czy `setup.mjs` utrwala adres VPS na tyle, by panel miał co porównać?** Tak — `persistEnvVar:777`
  pisze do rejestru HKCU (Windows) albo `~/.zshrc`/`~/.bashrc` (Unix, format `export NAZWA="wartość"`
  z `upsertEnvLine:312`). R7 jest wykonalne w wariancie z porównaniem.
- **Czy repo-owy `env-loader.mjs` też potrzebuje fallbacku na `$HOME/claude-cron`?** Nie —
  liczy `REPO_ROOT` z `import.meta.url`, więc zawsze wie, gdzie leży. Fallback dotyczy **wyłącznie**
  loadera w vaulcie. To zmniejsza zakres R4 względem opisu w STATUS.
- **Czy marker do dedupu archiwum już istnieje?** Nie. Trzeba go dodać do `renderArchiveThread`.
  Konsekwencja: **istniejące duplikaty w `2026-08.md` nie zostaną wykryte** — wymagają jednorazowego
  ręcznego sprzątnięcia (Operator checklist U7).
- **Czy dwie zjedzone wiadomości wymagają skryptu naprawczego?** Nie — dziennik testów odnotowuje
  `Fix doraźny: UPDATE w bazie huba cave→Cave`. Zostaje jednorazowe **zapytanie kontrolne**.
- **Czy przepisywać CSS bez `:has()`?** Nie — update Obsidiana na CAVE naprawił wygląd.

### Odroczone do implementacji

- **Kształt migracji `members` na `COLLATE NOCASE`** — SQLite nie zmienia collation przez `ALTER`,
  więc to `CREATE … _new` → `INSERT SELECT` → `DROP` → `RENAME`. Dokładna obsługa kolizji (fail-fast
  z nazwami duplikatów) do ustalenia przy pierwszym uruchomieniu na kopii żywej bazy.
- **Czy `~/.claude-cron-home` ma trzymać samą ścieżkę, czy JSON** — rozstrzygnąć przy pisaniu
  drugiego czytelnika (vault `env.mjs`). Domyślnie: goła ścieżka, jak `~/.claude-cron-oauth-token`.
- **Sposób ubicia serwera przez samego siebie w updaterze (U11)** — na Windowsie skrypt musi przeżyć
  śmierć rodzica; dokładny mechanizm (detached PowerShell z opóźnieniem) do zweryfikowania empirycznie.
- **Rozjazd widok↔status dla odpowiedzianych `query`** — świadomy dług. Rozstrzygnięcie „czy odpowiedź
  zamyka sprawę" jest decyzją produktową („sprawdzę jutro" też jest odpowiedzią), nie łatką przy okazji.

## Notatka o delegacji

Tabela wyboru subagenta z `/dev-plan` jest skalibrowana pod stack React/Vite/Supabase. To repo jest
CommonJS + vanilla JS bez buildu, więc stosuję mapowanie zastępcze, zachowując intencję reguły:

- `lib/`, `scripts/`, `server.js`, `setup.mjs`, instalatory → **`feature-builder-data`** (warstwa logiki i danych)
- `public/` (panel) → **`feature-builder-ui`** (warstwa prezentacji)
- unit dotykający obu naraz i nierozdzielalny → **`feature-builder-fullstack`**

Pole `Skills in play` jest mirrorem frontmattera agenta zgodnie z regułą. Skille Supabase/Figma/Tailwind
są w tym repo **bezczynne** — nie ma tu ani Supabase, ani Figmy, ani Tailwinda. Obowiązują natomiast
`.claude/rules/coding-rules.md` i `.claude/rules/learned-patterns.md`.

---

## Implementation Units

### Faza 1 — Widoczność i hub

- [ ] **Unit 1: Wersja instalacji widoczna w `/api/status`**

**Cel:** każda maszyna raportuje, jaki kod ma zainstalowany — niezależnie od tego, czy przyszedł
z gita, czy z zipa. Fundament pod U8, U11 i pod wiarygodność każdej rundy testowej.

**Wymagania:** R10 (część a)

**Zależności:** brak — wchodzi jako pierwszy właśnie dlatego

**Pliki:**
- Stwórz: `lib/version.js`
- Stwórz: `lib/version.test.js`
- Modyfikuj: `server.js` (endpoint `/api/status`, ~`:344`)
- Modyfikuj: `setup.mjs` (zapis pliku wersji po rozpakowaniu/pullu)
- Modyfikuj: `install.sh`, `install.ps1` (przekazanie faktycznie pobranej rewizji)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne w tym repo — patrz „Notatka o delegacji")*

**Podejście:**
- Źródłem prawdy jest **plik zapisany przez instalator** (`data/version.json`: rewizja, data pobrania,
  źródło), nie `git rev-parse` — CAVE nie ma repozytorium.
- `lib/version.js` to czysta funkcja czytająca plik + fallback `unknown` gdy pliku brak (instalacje
  sprzed zmiany). Brak wersji **nie może** wywalić `/api/status`.
- `data/` jest w allowliście katalogów stanowych instalatora, więc plik przeżywa re-instalację —
  dlatego zapis musi nastąpić **po** swapie katalogów, nie przed.
- Zip pobierać **po skrócie commita**, nie po nazwie gałęzi (cache `raw.githubusercontent.com` —
  patrz wiedza instytucjonalna); wtedy zapisana rewizja odpowiada temu, co faktycznie rozpakowano.

**Wzorce do naśladowania:** `repo_dir` w `/api/status` (`server.js`) — to samo uzasadnienie
(„pokaż, z czym naprawdę pracujesz"); `lib/config.js` jako miejsce stałych.

**Scenariusze testowe:**
- [Unit] plik wersji istnieje i jest poprawny → `/api/status` zwraca rewizję i datę
- [Unit] plik nie istnieje (stara instalacja) → zwraca `unknown`, bez rzucania wyjątku
- [Unit] plik uszkodzony/niepełny JSON → `unknown`, bez rzucania wyjątku
- [Manual] instalacja zipowa na Windows raportuje tę samą rewizję co pobrany zip

**Weryfikacja:**
- `node --test lib/version.test.js` przechodzi
- `npm test` przechodzi w całości (baseline 155/155 nie spada)
- `curl -s localhost:7777/api/status` zwraca niepuste pole wersji

---

- [ ] **Unit 2: Hub odrzuca nieznanego adresata i prostuje wielkość liter**

**Cel:** literówka w nicku przestaje być cichą utratą wiadomości.

**Wymagania:** R1

**Zależności:** brak (równoległy do U1, ale robiony po nim dla widoczności wersji)

**Pliki:**
- Modyfikuj: `lib/inbox-db.js` (`sendMessage`, `migrate`, `addMember`)
- Modyfikuj: `lib/inbox-api.js` (`handleSend` — mapowanie na `400 unknown_recipient`)
- Modyfikuj: `lib/inbox-db.test.js`
- Modyfikuj: `lib/inbox-api.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- **(a) Schemat:** `members.name` z `COLLATE NOCASE`. SQLite nie zmienia collation przez `ALTER`,
  więc migracja tabeli. Kolizja istniejących duplikatów = **fail-fast z nazwami**, nie ciche scalenie.
  Migracja idempotentna: guard po `PRAGMA table_info` / sentinelu, żeby nie przepisywać tabeli co boot.
- **(b) Walidacja w `sendMessage`, przed `INSERT`:** lookup po `listMembers()`, dopasowanie
  case-insensitive → podmiana `to_user` na **nazwę kanoniczną z tabeli**; brak trafienia →
  `InboxDbError`. Więcej niż jedno trafienie (instalacja sprzed migracji) → też `InboxDbError`,
  nigdy „pierwszy z brzegu".
- **(c) API:** `handleSend` mapuje `InboxDbError` na `400 unknown_recipient` **z listą członków** —
  to ma być podpowiedź dla modelu, nie samo „błąd".
- **Bez backfillu w `migrate()`** — kałuża wytarta ręcznie 04.08; zostaje jednorazowe zapytanie
  kontrolne (Operator checklist).

**Notatka wykonawcza:** zacznij od failing testu na `sendMessage('cav')` → oczekiwany `InboxDbError`.
To jest zachowanie kontraktowe huba, warto je przybić testem przed dotknięciem schematu.

**Wzorce do naśladowania:** `addMember` (mapowanie `UNIQUE` → `InboxDbError`); `markDone`
(świeży odczyt z DB przed decyzją); walidacja na granicy w `lib/inbox-api.js`.

**Scenariusze testowe:**
- [Unit] `to_user='cave'` przy członku `Cave` → INSERT z `to_user='Cave'`
- [Unit] `to_user='cav'` → `InboxDbError`, **zero wierszy** w `inbox`
- [Unit] `handleSend` z nieznanym adresatem → `400`, ciało zawiera listę członków
- [Unit] `addMember('cave')` przy istniejącym `Cave` → `InboxDbError` (duplikat case-insensitive)
- [Unit] migracja na bazie z `Cave` i `cave` → czytelny błąd z obiema nazwami, baza nietknięta
- [Unit] migracja idempotentna — drugi `migrate()` nie przepisuje tabeli

**Weryfikacja:**
- `node --test lib/inbox-db.test.js` i `node --test lib/inbox-api.test.js` przechodzą
- `npm test` przechodzi w całości
- `grep -n "COLLATE NOCASE" lib/inbox-db.js` zwraca trafienie w definicji `members`

**Operator checklist:**
- [ ] Zapytanie kontrolne na żywym hubie: czy są wiersze `inbox` z `to_user` spoza `members`
- [ ] Restart daemona na VPS po deployu

---

- [ ] **Unit 3: Odpowiedziane pytanie znika z „Wysłanych" (T6)**

**Cel:** zamknąć jedyny oblany test rundy 04.08, nie psując `reply.mjs`.

**Wymagania:** R3

**Zależności:** U2 (ten sam plik, jedno wejście w `lib/inbox-db.js`)

**Pliki:**
- Modyfikuj: `lib/inbox-db.js` (`pullForUser` — zapytanie `delegated`)
- Modyfikuj: `lib/inbox-db.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- Do zapytania `delegated` dochodzi warunek wykluczający `query`, w którego wątku istnieje `reply`
  **od kogoś innego niż autor pytania**. Alias `FROM inbox i` + `NOT EXISTS` z dodatkowym
  `r.from_user <> i.from_user`.
- `task` zostaje bez zmian — zadania domyka checkbox „Zrobione", nie odpowiedź.
- Wzór składniowy stoi 80 linii niżej w `claimQuery` (`lib/inbox-db.js:255`) — ta sama struktura,
  jeden warunek więcej.
- **Rekord nie dostaje `status='done'`** — to naprawa widoku. Świadomy dług, opisany w STATUS.

**Wzorce do naśladowania:** `claimQuery` (`lib/inbox-db.js:255`) — istniejący `NOT EXISTS (reply)`.

**Scenariusze testowe:**
- [Unit] `query` + `reply` od adresata → **nie ma** w `delegated`
- [Unit] `query` + `reply` **od samego nadawcy** → **jest** w `delegated` (własne dopowiedzenie nie zamyka)
- [Unit] `task` + `reply` od adresata → **jest** w `delegated` (zadania zamyka checkbox)
- [Unit] `query` bez żadnej odpowiedzi → jest w `delegated`
- [Unit] wątek z dopowiedzeniem nadawcy pozostaje znajdowalny przez `findOriginal` (regresja `reply.mjs`)

**Weryfikacja:**
- `node --test lib/inbox-db.test.js` przechodzi
- `npm test` przechodzi w całości

**Operator checklist:**
- [ ] **Retest T6** wg szablonu (wraz z wariantem kontrolnym „własne dopowiedzenie nie zamyka")

---

### Faza 2 — Granica repo ↔ vault

- [ ] **Unit 4: `PULS_HOME` ustawia instalator, nie człowiek**

**Cel:** świeża instalacja u osoby nietechnicznej działa bez ani jednego ręcznego kroku —
i bez komunikatu namawiającego do cofnięcia migracji bezpieczeństwa.

**Wymagania:** R4

**Zależności:** brak techniczna; **musi poprzedzać U5**

**Pliki:**
- Modyfikuj: `setup.mjs` (sekcja `env` w `{workspace}/.claude/settings.json` + zapis wskaźnika)
- Modyfikuj: `setup.test.mjs`
- Modyfikuj: `<vault>/.claude/skills/deleguj/scripts/env.mjs` *(poza repo — patrz „Ryzyka")*
- Modyfikuj: `<vault>/.claude/skills/deleguj/SKILL.md` (opis kolejności szukania)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- **(a)** `setup.mjs` dopisuje `PULS_HOME` do sekcji `env` w `{workspace}/.claude/settings.json` —
  obok istniejącego idempotentnego merge'u wpisu hooka autostartu (`mergeHookIntoSettings:176`,
  zapis `:1064`). Ten sam plik, ta sama zasada: nie nadpisujemy cudzych kluczy, fail-fast na
  uszkodzonym JSON-ie.
- **(b)** Ten sam instalator zapisuje ścieżkę instalacji do **wskaźnika o stałej nazwie**
  `~/.claude-cron-home`. Powód: `settings.json` ratuje tylko sesje w tym jednym workspace; wskaźnik
  działa dla każdego procesu. Konwencja istnieje — `~/.claude-cron-oauth-token`.
- Loader w vaulcie dostaje kolejność: `INBOX_ENV_FILE` → `$PULS_HOME/data/inbox.env` →
  **`~/.claude-cron-home` → `<ścieżka>/data/inbox.env`** → walk-up `.env` (legacy).
- **Zgadywanie `$HOME/claude-cron` odpada** — katalog instalacji jest wolnym wejściem usera, a na
  maszynie autora repo stoi w `~/Documents/Kodowanie/claude-cron`, więc zgadywanka nie ratuje nawet
  instalacji, która zgłosiła problem.
- **(c)** Komunikat błędu przestaje sugerować wpisanie sekretu do `.env` w vaulcie — zamiast tego
  wskazuje re-run instalatora. Sekret w vaulcie to udokumentowana ścieżka eksfiltracji.
- **Repo-owy `env-loader.mjs` zostaje bez zmian** — liczy `REPO_ROOT` z `import.meta.url`.

**Wzorce do naśladowania:** `mergeHookIntoSettings` (`setup.mjs:176`) — idempotentny merge;
`resolveInboxSecretFile` (`scripts/inbox/env-loader.mjs`) — jedno źródło prawdy o lokalizacji sekretu.

**Scenariusze testowe:**
- [Unit] merge `env.PULS_HOME` do pustego `settings.json` → klucz dodany
- [Unit] merge do `settings.json` z istniejącym `env` i wpisem hooka → oba zachowane, `PULS_HOME` dodany
- [Unit] re-run z tą samą wartością → brak zmiany pliku (idempotencja)
- [Unit] uszkodzony `settings.json` → fail-fast, plik **nietknięty**
- [Unit] wskaźnik `~/.claude-cron-home` zapisany z faktycznym katalogiem instalacji (nie domyślnym)
- [Unit] loader w vaulcie: brak `PULS_HOME`, obecny wskaźnik → sekret znaleziony
- [Unit] loader: brak obu → komunikat **nie zawiera** sugestii zapisu do `.env` vaulta

**Weryfikacja:**
- `node --test setup.test.mjs` przechodzi
- `npm test` przechodzi w całości
- `grep -rn "\.env" <vault>/.claude/skills/deleguj/scripts/env.mjs` — brak komunikatu namawiającego do zapisu sekretu w vaulcie

---

- [ ] **Unit 5: `close` archiwizuje wątek — jedna kopia kodu w repo**

**Cel:** obie ścieżki domykania (checkbox i komenda) zapisują nitkę do archiwum. Znika
obejście operacyjne „domykać wyłącznie checkboxami".

**Wymagania:** R2

**Zależności:** **U4** — skill musi umieć znaleźć `PULS_HOME`, żeby w ogóle trafić w plik

**Pliki:**
- Stwórz: `scripts/inbox/close.mjs`
- Stwórz: `scripts/inbox/close.test.mjs`
- Modyfikuj: `scripts/inbox/inbox-push.mjs` (eksport `appendToArchive`)
- Modyfikuj: `scripts/inbox/inbox-push.test.mjs`
- Modyfikuj: `<vault>/.claude/skills/deleguj/SKILL.md` (wywołanie `node $PULS_HOME/scripts/inbox/close.mjs`)
- Usuń: `<vault>/.claude/skills/deleguj/scripts/close.mjs` *(po potwierdzeniu, że nowa ścieżka działa)*

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- Wariant A (wybrany 05.08): `close.mjs` przenosi się do repo obok `inbox-push.mjs` i importuje
  `appendToArchive` normalnym importem — koniec z dwiema lokalizacjami tego samego kodu i trzecią
  kopią loadera.
- `appendToArchive` przestaje być prywatna. Zachowanie bez zmian, zmienia się wyłącznie widoczność.
- Hub zwraca `thread` w odpowiedzi `done` — dane są, wystarczy je zapisać.
- **Guard na brak `PULS_HOME`:** skill nie woła `node` w ciemno. Brak zmiennej → czytelny komunikat
  („zaktualizuj Pulsa / ustaw PULS_HOME"), nie `MODULE_NOT_FOUND`. Widoczna porażka zamiast cichej.
- Kasowanie kopii w vaulcie **dopiero po** potwierdzeniu działania nowej ścieżki.

**Wzorce do naśladowania:** `inbox-sync.mjs` (entry point script-joba); `inbox-push.mjs`
(`main({ client })` z wstrzykiwanym klientem dla testowalności).

**Scenariusze testowe:**
- [Unit] `close` na otwartym wątku → hub dostaje `done` **i** nitka trafia do pliku miesiąca
- [Unit] `close` powtórzony → `closed: 0`, **archiwum bez drugiego wpisu** (idempotencja)
- [Unit] `close` na wątku bez wiadomości do mnie → czytelna nota, zero zapisu
- [Unit] pad zapisu archiwum → błąd widoczny w wyjściu, nie ciche `exit 0`

**Weryfikacja:**
- `node --test scripts/inbox/close.test.mjs` przechodzi
- `npm test` przechodzi w całości
- `grep -n "export async function appendToArchive\|export function appendToArchive" scripts/inbox/inbox-push.mjs` zwraca trafienie

**Operator checklist:**
- [ ] **Retest T8** wg szablonu — z warunkiem 3 (nitka w archiwum)
- [ ] Usunięcie kopii `close.mjs` z vaulta po zielonym T8
- [ ] Zdjęcie ostrzeżenia „domykać wyłącznie checkboxami" ze STATUS-a

---

### Faza 3 — Format Skrzynki i archiwum

- [ ] **Unit 6: Frontmatter Skrzynki domergowuje się przy każdym pull**

**Cel:** zmiany szablonu docierają do istniejących plików; koniec z „na CAVE wygląda na zepsuty CSS".

**Wymagania:** R12

**Zależności:** brak

**Pliki:**
- Modyfikuj: `scripts/inbox/inbox-pull.mjs` (obok `SKRZYNKA_TEMPLATE:197`)
- Modyfikuj: `scripts/inbox/inbox-pull.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- Renderer podmienia dziś tylko treść między markerami i frontmattera nie rusza. Dochodzi krok:
  **domerguj brakujące klucze** z `SKRZYNKA_TEMPLATE` (`cssclasses`, `tags`).
- **Wartości już obecne zostają nietknięte** — merge, nie nadpisanie. To warunek, nie preferencja:
  ludzie dopisują własne klucze do frontmattera.
- Plik bez frontmattera w ogóle → dodaj cały blok z szablonu.
- Kontrakt push↔pull (`%% inbox:items:start %%`, marker `%% id/thread %%`, checkboxy) jest święty —
  ta zmiana go nie dotyka.

**Wzorce do naśladowania:** `replaceBetweenMarkers` (`inbox-pull.mjs:247`) — zmiana punktowa,
reszta pliku nietknięta.

**Scenariusze testowe:**
- [Unit] plik bez `cssclasses` → po pullu ma `cssclasses: [skrzynka]`
- [Unit] plik z własnym kluczem w frontmatterze → klucz przetrwał
- [Unit] plik z `cssclasses` o innej wartości → wartość **nie jest** nadpisana
- [Unit] plik bez frontmattera → dostaje pełny blok z szablonu
- [Unit] roundtrip push↔pull dalej przechodzi (regresja kontraktu)

**Weryfikacja:**
- `node --test scripts/inbox/inbox-pull.test.mjs` przechodzi
- `npm test` przechodzi w całości

---

- [ ] **Unit 7: Archiwum bez duplikatów — marker + podmiana bloku**

**Cel:** wątek domykany etapami występuje w pliku miesiąca dokładnie raz.

**Wymagania:** R8

**Zależności:** U5 (obie ścieżki domykania muszą już iść przez `appendToArchive`)

**Pliki:**
- Modyfikuj: `scripts/inbox/inbox-push.mjs` (`renderArchiveThread`, `appendToArchive`)
- Modyfikuj: `scripts/inbox/inbox-push.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- **`renderArchiveThread` dostaje marker `%% thread:<id> %%`** — dziś go **nie ma** (marker żyje
  wyłącznie w renderze Skrzynki, `inbox-pull.mjs:116,140`). Bez tego nie ma po czym dopasowywać bloku;
  założenie w STATUS, że „marker już siedzi w treści", nie jest prawdziwe dla archiwum.
- `appendToArchive` przestaje być gołym `fs.appendFile`: wczytaj plik miesiąca, znajdź blok po
  `thread_id`, **podmień** jeśli jest, dopisz jeśli nie ma.
- Nowsza wersja nitki wygrywa (domknięcie etapami dokłada wiadomości, nie usuwa).
- Wpisy sprzed zmiany nie mają markera → **nie zostaną wykryte**. Istniejące duplikaty
  (`Test łączności Team OS` w `2026-08.md`) sprząta operator ręcznie, jednorazowo.

**Wzorce do naśladowania:** `parseCheckedCallouts` (`inbox-push.mjs:28`) — dopasowanie bloku po
markerze regexem; `replaceBetweenMarkers` (`inbox-pull.mjs`) — podmiana fragmentu pliku.

**Scenariusze testowe:**
- [Unit] pierwszy zapis wątku → jeden blok z markerem
- [Unit] drugi zapis tego samego wątku (więcej wiadomości) → **dalej jeden blok**, treść nowsza
- [Unit] drugi wątek → dwa niezależne bloki, kolejność zachowana
- [Unit] plik z blokiem bez markera (sprzed zmiany) → nowy zapis dokłada blok, stary nietknięty
- [Unit] plik miesiąca nie istnieje → tworzony z nagłówkiem, jak dziś

**Weryfikacja:**
- `node --test scripts/inbox/inbox-push.test.mjs` przechodzi
- `npm test` przechodzi w całości

**Operator checklist:**
- [ ] Jednorazowe usunięcie istniejących duplikatów z `Zasoby/inbox-archive/2026-08.md`

---

- [ ] **Unit 8: Job „Puls — kontrola spójności" + `/onboard --refresh-theme`**

**Cel:** rozjazd wyglądu i wersji przestaje być niewidzialny — system sam mówi człowiekowi,
co jest nie tak, i podaje komendę naprawczą.

**Wymagania:** R13, R15 (część), R10 (konsument wersji)

**Zależności:** U1 (wersja), U6 (frontmatter)

**Pliki:**
- Stwórz: `scripts/consistency-check.mjs`
- Stwórz: `scripts/consistency-check.test.mjs`
- Modyfikuj: `lib/starter-jobs.js` lub `templates/starter-jobs.json` (seed joba)
- Modyfikuj: `<aibiz-plugin>/plugins/aibiz/skills/onboard/SKILL.md` (tryb `--refresh-theme`) *(poza repo)*

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- **Jeden job, dwie kontrole** — wersja kodu (z U1) i zgodność snippetu CSS w vaulcie z szablonem
  w pluginie. Ta sama logika („wykryj rozjazd → powiedz człowiekowi"), więc jeden mechanizm.
- Wykryty rozjazd → **zadanie w Dashboardzie**. Bez maszyny stanu: zadanie wisi, dopóki rozjazd
  istnieje (decyzja 05.08 — skoro naprawa to jedna komenda, zamykanie bez naprawy nie jest realnym
  scenariuszem).
- **Warunek konieczny: treść zadania zawiera komendę naprawczą** (`/onboard --refresh-theme`).
  Zadanie bez dźwigni jest naganiaczem i zostanie zamknięte bez naprawy.
- **Zadanie musi mieć `termin:`** — inaczej wypada z Dashboardu i nikt go nie zobaczy.
- **Rozpoznawanie „czy takie zadanie już wisi" po ukrytym znaczniku w treści, nie po tytule** —
  tytuł zmieni się przy pierwszym porządkowaniu Dashboardu i job zacznie mnożyć kopie.
- Świadomy koszt: `--refresh-theme` nadpisuje snippet, więc ręczne przeróbki CSS znikają.
  Przy założeniu „jeden wspólny wygląd u wszystkich" to cecha, nie wada.

**Wzorce do naśladowania:** `lib/inbox-seed.js` (seed joba tylko gdy skonfigurowany, nigdy `updateJob`);
markery `%% … %%` w `inbox-pull.mjs`; script-joby (`job_type: 'script'`) w `lib/executor.js`.

**Scenariusze testowe:**
- [Unit] snippet zgodny z szablonem i wersja aktualna → **brak zadania**
- [Unit] snippet rozjechany → jedno zadanie, w treści komenda naprawcza, w frontmatterze `termin:`
- [Unit] drugi przebieg przy niezmienionym rozjeździe → **brak drugiego zadania**
- [Unit] zmieniony tytuł istniejącego zadania → dalej rozpoznane po znaczniku, brak duplikatu
- [Unit] rozjazd naprawiony → kolejny przebieg nie tworzy nic nowego
- [Unit] brak szablonu w pluginie (Puls bez pluginu) → job kończy się cicho, bez błędu

**Weryfikacja:**
- `node --test scripts/consistency-check.test.mjs` przechodzi
- `npm test` przechodzi w całości

**Operator checklist:**
- [ ] **Test T14** wg szablonu (rozjazd → jedno zadanie → drugi przebieg bez duplikatu)
- [ ] Dopisanie „Obsidian zaktualizowany do najnowszej wersji" jako kroku onboardingu (R15)

---

### Faza 4 — Konfiguracja VPS

- [ ] **Unit 9: Panel pokazuje adres w użyciu obok zapisanego i sygnalizuje rozjazd**

**Cel:** koniec z godziną diagnozy „dlaczego Puls gada z inną maszyną, niż pokazuje konfiguracja".

**Wymagania:** R7

**Zależności:** U1 (to samo pole statusu, jedno wejście w `/api/status`)

**Pliki:**
- Stwórz: `lib/persisted-env.js`
- Stwórz: `lib/persisted-env.test.js`
- Modyfikuj: `server.js` (`/api/status`)
- Modyfikuj: `public/app.js`, `public/index.html` (pole w ustawieniach na górze panelu)

**Delegate to:** feature-builder-fullstack

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, supabase-dev-guidelines, security, sentry-integration, figma:figma-use, figma-design-to-code *(w tym repo aktywne są wyłącznie reguły projektu — patrz „Notatka o delegacji")*

**Podejście:**
- **Dwie wartości, nie jedna:** „Puls proxuje do…" (z pamięci procesu, `lib/config.js:28`) oraz
  „w konfiguracji zapisane…" (odczyt **w czasie żądania**). Różnica → widoczny komunikat
  „zmiana wymaga restartu".
- `lib/persisted-env.js` czyta wartość utrwaloną przez instalator: Windows → User Environment
  (rejestr HKCU), Unix → linia `export NAZWA="wartość"` w `~/.zshrc`/`~/.bashrc`.
- **Parser linii `export` musi lustrzanie odpowiadać `upsertEnvLine`** (`setup.mjs:312`, format
  `JSON.stringify` wartości). `setup.mjs` jest ESM, `server.js` CommonJS — synchroniczny import
  nie przejdzie, więc to świadoma druga implementacja **związana komentarzem po obu stronach**.
  Precedens w repo: `INBOX_CODE_PREFIX` w `server.js` vs `scripts/inbox/invite.mjs`.
- Nieczytelne/brakujące źródło → „nie wiem", nigdy zgadywanie. Fail-closed w komunikacie.
- **Nie przeładowujemy zmiennej w locie** — decyzja 05.08.

**Wzorce do naśladowania:** `repo_dir` w `/api/status`; `lib/notify-config.js` (rozwiązywanie
konfiguracji w czasie użycia, nie przy require); podpis payloadu w `public/app.js` (polling bez migotania).

**Scenariusze testowe:**
- [Unit] RC z `export CLAUDE_CRON_VPS_URL="https://x"` → parser zwraca `https://x`
- [Unit] RC z zakomentowaną/uszkodzoną linią → `null`, bez rzucania
- [Unit] brak pliku RC → `null`, bez rzucania
- [Unit] wartość ze spacjami i cudzysłowami → poprawnie odkodowana
- [Unit] `/api/status`: wartość z pamięci ≠ zapisana → flaga rozjazdu `true`
- [Unit] wartości równe → flaga `false`
- [Manual] zmiana adresu bez restartu → panel pokazuje ostrzeżenie; po restarcie znika

**Weryfikacja:**
- `node --test lib/persisted-env.test.js` przechodzi
- `npm test` przechodzi w całości
- `curl -s localhost:7777/api/status` zwraca oba pola adresu i flagę rozjazdu

**Operator checklist:**
- [ ] **Sprawdzenie M1** wg szablonu testów

---

- [ ] **Unit 10: Instalator podpowiada zapisany adres VPS**

**Cel:** re-run instalatora przestaje kłamać, że konfiguracja zniknęła.

**Wymagania:** R11

**Zależności:** U9 (ta sama zmienna, ten sam odczyt utrwalonej wartości)

**Pliki:**
- Modyfikuj: `setup.mjs` (pytanie o adres VPS)
- Modyfikuj: `setup.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- Zapisana wartość jako domyślna — dokładnie tak, jak działa to już dla portu i workspace'u.
- Pusty Enter przy istniejącej konfiguracji → „bez zmian: `<adres>`". Komunikat „Tryb tylko lokalny"
  zostaje **wyłącznie** dla stanu, w którym adresu faktycznie nie ma.
- Odczyt utrwalonej wartości — ten sam mechanizm co w U9 (potencjalnie ten sam helper, jeśli
  wyjdzie naturalnie; duplikacja jest tu tańsza niż most ESM↔CJS).

**Wzorce do naśladowania:** pytanie o port (`resolveDashboardPort`) i o workspace w `setup.mjs` —
oba już podpowiadają zapisane wartości.

**Scenariusze testowe:**
- [Unit] istnieje zapisany adres + pusty Enter → wartość zachowana, komunikat „bez zmian"
- [Unit] brak zapisanego adresu + pusty Enter → „tryb tylko lokalny", env nie zapisywany
- [Unit] podany nowy adres → nadpisuje stary
- [Unit] adres z białymi znakami/cudzysłowami → sanityzowany jak dziś (`buildVpsUrl`)

**Weryfikacja:**
- `node --test setup.test.mjs` przechodzi
- `npm test` przechodzi w całości

**Operator checklist:**
- [ ] **Sprawdzenie M3** wg szablonu testów

---

### Faza 5 — Aktualizacja i dystrybucja

- [ ] **Unit 11: Aktualizacja Pulsa przyciskiem w panelu**

**Cel:** aktualizacja jak w normalnej aplikacji — „dostępna nowa wersja → klik → aktualizuje się
i wraca". Człowiek widzi wynik, zamiast dowiadywać się rano, że coś się zepsuło bez świadka.

**Wymagania:** R10 (części b, c, d)

**Zależności:** U1 (numer wersji jako podstawa porównania)

**Pliki:**
- Stwórz: `lib/updater.js`
- Stwórz: `lib/updater.test.js`
- Modyfikuj: `server.js` (endpoint sprawdzenia i uruchomienia aktualizacji)
- Modyfikuj: `public/app.js`, `public/index.html` (badge + przycisk + odpytywanie)
- Modyfikuj: `install.ps1` (tryb nieinteraktywny dla ścieżki Windows)

**Delegate to:** feature-builder-fullstack

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, supabase-dev-guidelines, security, sentry-integration, figma:figma-use, figma-design-to-code *(w tym repo aktywne są wyłącznie reguły projektu)*

**Podejście:**
- **Sprawdzenie dostępności:** publiczne API GitHuba (repo jest publiczne, potwierdzone 05.08 —
  odpowiada bez tokenu). Porównanie z rewizją z U1.
- **Mac:** `git pull --ff-only` + zgaszenie procesu; launchd/hook podnosi sam.
- **Windows:** ścieżka zipowa **już istnieje** (`install.ps1:231-246` — pobiera i rozpakowuje
  zachowując `data\` i `.node\`). Do zrobienia: uruchomienie jej tak, by proces przeżył śmierć
  rodzica (odczekanie, podmiana, start). Node siedzi w `.node\` i nie jest podmieniany, więc blokada
  pliku Node nie jest problemem — ale **pliki aplikacji trzymane przez daemona już tak**: ubijać
  filtrem po **ścieżce instalacji**, nigdy po nazwie binarki (wiedza instytucjonalna 2026-07-28).
- **Zip po skrócie commita, nie po nazwie gałęzi** — cache `raw.githubusercontent.com`.
- **Panel odpytuje aż wróci nowa wersja** — i po przekroczeniu rozsądnego czasu mówi wprost, że
  aktualizacja się nie powiodła. Cisza po kliknięciu jest gorsza niż błąd.
- **Nie nocny automat** — decyzja 05.08.

**Wzorce do naśladowania:** `Expand-RepoFromZip` (`install.ps1`); allowlista katalogów stanowych
(`data/`, `.node/`) + atomowy swap z `install.sh`; `platform.js` (`getStatus`) jako wzór warstwy per-OS.

**Scenariusze testowe:**
- [Unit] wersja lokalna == zdalna → brak sygnału aktualizacji
- [Unit] wersja lokalna starsza → sygnał dostępnej aktualizacji z numerem
- [Unit] wersja `unknown` (stara instalacja) → czytelny stan „nie wiem", **nie** fałszywe „aktualne"
- [Unit] API GitHuba niedostępne → stan „nie udało się sprawdzić", panel nie wisi
- [Manual] Windows: aktualizacja przy działającym daemonie → `data\` i `.node\` nietknięte, serwer wraca
- [Manual] Mac: aktualizacja → proces wraca sam, wersja w panelu nowa

**Weryfikacja:**
- `node --test lib/updater.test.js` przechodzi
- `npm test` przechodzi w całości

**Operator checklist:**
- [ ] **Sprawdzenie M2** wg szablonu testów, na Macu i na CAVE

---

- [ ] **Unit 12: Aktualizacja pluginu zespołowego**

**Cel:** identyczny wygląd i zachowanie Skrzynki na wszystkich maszynach zespołu i u kursantów.

**Wymagania:** R14, R15

**Zależności:** **wszystkie pozostałe unity zrobione I przetestowane** (decyzja 05.08 — jedna
aktualizacja na końcu zamiast kilku po drodze)

**Pliki:**
- Modyfikuj: `<aibiz-plugin>/plugins/aibiz/skills/onboard/templates/skrzynka.css` *(poza repo)*
- Modyfikuj: `<aibiz-plugin>/plugins/aibiz/skills/onboard/SKILL.md` *(poza repo — opis flow Skrzynki, `--refresh-theme`, wymagana wersja Obsidiana)*

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nieaktywne)*

**Podejście:**
- **Renderer i CSS idą w parze** — rozjazd między nimi psuje wygląd u wszystkich naraz.
  Renderer żyje w `claude-cron` (`84dfb1b`, `68e6a03`, badge daty, separator listy), `skrzynka.css`
  w szablonie `onboard` w `aibiz-plugin` (zsynchronizowany 04.08 — `8dc1fc0` + poprawka checkboxa).
- Kroki: `/plugin-zespolowy check` → weryfikacja opisu flow Skrzynki w skillu `onboard` →
  push + `Update marketplace` + `/reload-plugins` u zespołu.
- ⚠️ **W repo pluginu wiszą niezacommitowane cudze zmiany** (potwierdzone 05.08:
  `D plugins/aibiz/hooks/frontmatter-validate.sh`, `M plugins/aibiz/hooks/hooks.json`).
  **Wyjaśnić z autorem przed pushem** — inaczej wypchniemy cudzą zmianę bez jego wiedzy.

**Scenariusze testowe:**
- [Manual] po `/reload-plugins` Skrzynka wygląda identycznie na Macu, VPS i CAVE
- [Manual] świeży vault po `onboard` dostaje snippet i `cssclasses` bez ręcznych kroków

**Weryfikacja:**
- `npm test` przechodzi w całości (regresja po stronie renderera)

**Operator checklist:**
- [ ] Wyjaśnienie niezacommitowanych zmian w `aibiz-plugin` z autorem
- [ ] `/plugin-zespolowy check`
- [ ] Push + `Update marketplace` + `/reload-plugins`
- [ ] **CAVE:** `install.ps1` (zipowa instalacja = oficjalna ścieżka update na Windows) + świeże snippety
- [ ] **VPS:** `git pull` + restart usługi
- [ ] **Pełna runda testowa** wg `szablon-testow-team-os.md` — wypełnić BILANS

---

## Wpływ systemowy

- **Graf interakcji:** `sendMessage` (U2) leży na ścieżce **wszystkich** wysyłek — skill `deleguj`,
  auto-reply, przyszli klienci. `pullForUser` (U3) zasila renderer Skrzynki **i** `findOriginal`
  w `reply.mjs` — zmiana widoczności rekordu zmienia zachowanie sąsiedniego skryptu.
- **Propagacja błędów:** `InboxDbError` z warstwy DB → `handleSend` → `400` z listą członków → komunikat
  w skillu. Każde ogniwo musi go przepuścić czytelnie; połknięcie na którymkolwiek poziomie odtwarza
  cichą awarię, którą naprawiamy.
- **Ryzyka cyklu życia stanu:** migracja `members` (U2) przepisuje tabelę — wykonać na zatrzymanym
  daemonie albo z pewnością, że `migrate()` jest jedynym pisarzem. Odpowiedziane `query` zostaje
  `delivered` na zawsze (świadomy dług R3).
- **Parytet surface API:** `/api/status` zyskuje pola w U1 i U9 — panel czyta je przez ten sam
  polling; `/api/vps/*` proxuje status z drugiej maszyny, więc **pola muszą być odporne na brak**
  (starsza wersja po drugiej stronie nie może wywalić widoku).
- **Pokrycie integracyjne:** testy jednostkowe `sendMessage` i `pullForUser` przechodzą przy złamanym
  zachowaniu systemowym (lekcja z `2026-07-03-stale-obiekt-w-pamieci`). Dlatego U3 ma jawny scenariusz
  regresji `reply.mjs`, a U5 — scenariusz „close → archiwum", którego brak sprawił, że T8 zaliczył się
  przy kasowaniu treści.

## Ryzyka i zależności

| Ryzyko | Mitygacja |
|---|---|
| **Kod żyje w trzech repozytoriach** (`claude-cron`, vault `.claude/skills/deleguj/`, `aibiz-plugin`) — poprawka w jednym miejscu zostawia dwie stare kopie | U5 likwiduje kopię `close.mjs`; przy każdym uncie z plikami spoza repo ścieżka jest oznaczona *(poza repo)*. Backlog: „Mac → plugin `aibiz`" zlikwiduje trzecią kopię loadera |
| **Migracja `members` na żywej bazie** — przepisanie tabeli z tokenami zespołu | Kopia `data/inbox.db` przed deployem; migracja fail-fast przy duplikacie zamiast cichego scalenia; test na kopii żywej bazy przed VPS |
| **U5 wdrożony przed U4** = `close` przestaje startować na maszynach bez `PULS_HOME` | Twarda zależność w planie + guard w skillu (czytelny komunikat zamiast `MODULE_NOT_FOUND`) |
| **Restart daemona ubija bieżące joby** | Deploy świadomie: VPS `git pull` + restart, Mac restart daemona. Joby chodzą co minutę, więc okno jest krótkie, ale nie zerowe |
| **Niezacommitowane cudze zmiany w `aibiz-plugin`** | U12 blokuje push do czasu wyjaśnienia z autorem |
| **Istniejące duplikaty w archiwum nie zostaną naprawione automatycznie** (brak markera we wpisach sprzed U7) | Jednorazowe sprzątnięcie ręczne, w Operator checklist U7 |
| **Baseline testów 155/155** | Każdy unit ma `npm test` w Weryfikacji; spadek poniżej baseline = regresja, nie „inny zestaw" |

## Fazowe dostarczanie

**Faza 1 — Widoczność i hub** (U1, U2, U3) · *≈ pół dnia*
Kończy się retestem T6. Od tego momentu wiadomo, co która maszyna ma zainstalowane.

**Faza 2 — Granica repo ↔ vault** (U4, U5) · *≈ pół dnia*
Kończy się retestem T8 z warunkiem archiwum i zdjęciem ostrzeżenia „domykać wyłącznie checkboxami".

**Faza 3 — Format Skrzynki i archiwum** (U6, U7, U8) · *≈ pół dnia*
Kończy się testami T13 i T14.

**Faza 4 — Konfiguracja VPS** (U9, U10) · *≈ 1,5 h*
Kończy się sprawdzeniami M1 i M3.

**Faza 5 — Aktualizacja i dystrybucja** (U11, U12) · *≈ dzień + runda testowa*
Kończy się pełną rundą wg szablonu i wypełnionym BILANSEM.

**Razem: ~2 dni robocze na fazy 1–4 + dzień na fazę 5 + rundę testową.**
Szacunki obejmują pisanie kodu i testy; deploy i retesty są osobno, w Operator checklistach.

## Dokumentacja / Notatki operacyjne

- **`STATUS.md`** — po każdej fazie odhaczyć pozycje i zaktualizować sekcję „NASTĘPNA SESJA";
  po U3 dopisać zdanie o świadomym długu widok↔status; po U5 zdjąć ostrzeżenie o `close`.
- **`szablon-testow-team-os.md`** — źródło prawdy dla wszystkich Operator checklistów. Runda kończy
  się wypełnionym BILANSEM (kolumna „zamknięta?") i tabelą regresji.
- **`CLAUDE.md`** — po U1, U4 i U9 dopisać: plik wersji, wskaźnik `~/.claude-cron-home`,
  odczyt utrwalonego env. To są nowe kontrakty międzymodułowe, a ten plik jest ich rejestrem.
- **Deploy:** VPS `git pull` + restart usługi · Mac restart daemona · CAVE `install.ps1`
  (instalacja zipowa, bez gita).
- **Dogfooding trwa** — joby chodzą co minutę, każdy restart jest widoczny dla drugiej strony.

## Źródła i referencje

- **Backlog źródłowy:** `Zadania/projekty/personal-team-os/STATUS.md` (sekcja „🔥 NASTĘPNA SESJA", stan 05.08)
- **Dziennik testów z dowodami:** `Zadania/projekty/personal-team-os/testy-team-os-2026-08-03.md`
- **Szablon rund testowych:** `Zadania/projekty/personal-team-os/szablon-testow-team-os.md`
- **Sesja roastu 05.08** — zmiany wariantów w poz. 1, 3, 4, 7, 10 i dodanie poz. 15
- Kod bazowy: `claude-cron` @ `0d27508` (repo czyste, baseline testów 155/155)
- Wiedza instytucjonalna: `docs/solutions/` — wpisy wymienione w sekcji „Kontekst i research"
