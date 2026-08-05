# Naprawy Team OS — kontekst techniczny

**Branch:** `feature/naprawy-team-os`
**Ostatnia aktualizacja:** 2026-08-05

## Źródła

- Requirements doc: brak (`/dev-brainstorm` nie był użyty)
- Plan techniczny: [docs/plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md](../../plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md)
- Backlog źródłowy: `Zadania/projekty/personal-team-os/STATUS.md`
- Dziennik testów z dowodami: `Zadania/projekty/personal-team-os/testy-team-os-2026-08-03.md`
- Szablon rund testowych: `Zadania/projekty/personal-team-os/szablon-testow-team-os.md`
- Kod bazowy: `claude-cron` @ `0d27508` (repo czyste, baseline testów 155/155)

> **Designerski kontekst pominięty** — plan techniczny ma `design_md: null`, `figma_spec: null`,
> `figma_screens: {}`. To feature backendowy; jedyny dotyk UI (U9, U11) to panel w vanilla JS
> bez Figmy i bez design systemu.

---

## Powiązane pliki

### Repo `claude-cron` (główne)

| Plik | Rola | Unity |
|---|---|---|
| `lib/inbox-db.js` | Warstwa SQLite huba. `sendMessage:135`, `pullForUser:177`, `claimQuery:255`, `migrate:60`, `addMember`, `listMembers`. Schemat `members` @ `:76` | U2, U3 |
| `lib/inbox-api.js` | Czysta funkcja nad `inbox-db`; `handleSend:169` | U2 |
| `scripts/inbox/inbox-push.mjs` | `appendToArchive:94` (**prywatna**), `renderArchiveThread:74`, `archivePath:59`. Eksporty: `extractInboxSection`, `parseCheckedCallouts`, `archivePath`, `renderArchiveThread`, `main` | U5, U7 |
| `scripts/inbox/inbox-pull.mjs` | Renderer Skrzynki. `SKRZYNKA_TEMPLATE:197`, `replaceBetweenMarkers:247`, markery kart `:116`, `:140` | U6 |
| `scripts/inbox/env-loader.mjs` | `DEFAULT_INBOX_SECRET_FILE`, `resolveInboxSecretFile`. Liczy `REPO_ROOT` z `import.meta.url` | — (bez zmian, patrz Decyzje) |
| `setup.mjs` | `mergeHookIntoSettings:176`, zapis settings `:1064`, `persistEnvVar:777`, `upsertEnvLine:312`, `buildSetUserEnvCommand`, `buildVpsUrl:328` | U1, U4, U10 |
| `server.js` | `/api/status` @ `:344` (zwraca już `repo_dir`), router, guard XFF | U1, U9, U11 |
| `lib/config.js` | `VPS_API_URL` @ `:28` — `process.env` czytany **raz**, przy ładowaniu modułu | U9 |
| `install.ps1` | `Expand-RepoFromZip:231-246` — pobiera zip i rozpakowuje zachowując `data\` i `.node\` | U1, U11 |
| `install.sh` | Bootstrap Unix, allowlista katalogów stanowych, atomowy swap | U1 |
| `lib/starter-jobs.js`, `templates/starter-jobs.json` | Seed jobów startowych | U8 |
| `lib/inbox-seed.js` | Wzór seedu joba wg roli (nigdy `updateJob`) | U8 |
| `public/app.js`, `public/index.html` | Panel — polling co 3 s z podpisem payloadu | U9, U11 |

### Poza repo (⚠️ zabrać przy przenoszeniu roboty)

| Ścieżka | Rola | Unity |
|---|---|---|
| `<vault>/.claude/skills/deleguj/scripts/env.mjs` | Loader sekretu po stronie vaulta: `INBOX_ENV_FILE` → `$PULS_HOME/data/inbox.env` → walk-up `.env` | U4 |
| `<vault>/.claude/skills/deleguj/scripts/close.mjs` | **Do usunięcia** po U5 | U5 |
| `<vault>/.claude/skills/deleguj/scripts/reply.mjs` | `findOriginal:27`, wyprowadzenie adresata `:57` — konsument `delegated` z `pullForUser` | U3 (regresja) |
| `<vault>/.claude/skills/deleguj/SKILL.md` | Opis kolejności szukania sekretu + wywołania skryptów | U4, U5 |
| `<aibiz-plugin>/plugins/aibiz/skills/onboard/templates/skrzynka.css` | Szablon CSS (11 użyć `:has()`) | U8, U12 |
| `<aibiz-plugin>/plugins/aibiz/skills/onboard/SKILL.md` | Onboarding, kopiowanie snippetów `:314-323` | U8, U12 |

---

## Decyzje techniczne

| Decyzja | Uzasadnienie | Unit |
|---|---|---|
| **Kolejność `U1 → U2 → U3 → U4 → U5 → …`** | Wariant A poz. 2 przenosi `close.mjs` do repo, więc skill musi znać `PULS_HOME`, żeby **znaleźć plik** — twardsze wymaganie niż dzisiejszy fallback na sekret | wszystkie |
| **Walidacja adresata w `sendMessage`, nie w API** | Jedno miejsce chroni wszystkie ścieżki wejścia; zgodne z zasadą „logika trudna po stronie huba" | U2 |
| **`members.name COLLATE NOCASE`** | Dziś `Cave` i `cave` mogą istnieć obok siebie z osobnymi tokenami — wtedy „nazwa kanoniczna" wychodzi z kolejności `id`, czyli z przypadku. Migracja **wysypie się przy duplikacie** = pożądany fail-fast | U2 |
| **Bez backfillu w `migrate()`** | `migrate()` leci przy każdym boocie (learned pattern). Kałuża wytarta ręcznie 04.08 — zostaje jednorazowe zapytanie kontrolne | U2 |
| **Predykat R3: „odpowiedział ktoś inny niż ja"** | `reply.mjs:57` pozwala dopisać odpowiedź do własnego wątku. „Istnieje jakikolwiek reply" kasowałoby własne pytanie z listy **i** psuło `findOriginal` → „nie znalazłem otwartego wątku" | U3 |
| **Wskaźnik `~/.claude-cron-home` zapisywany przez instalator** | Katalog instalacji to wolne wejście usera (`ask_install_dir`), więc zgadywanie `$HOME/claude-cron` nie działa nawet na Macu autora (repo w `~/Documents/Kodowanie/claude-cron`). Konwencja istnieje: `~/.claude-cron-oauth-token`. `settings.json` ratuje tylko sesje w jednym workspace | U4 |
| **Repo-owy `env-loader.mjs` bez zmian** | Liczy `REPO_ROOT` z `import.meta.url` — zawsze wie, gdzie leży. Fallback dotyczy **wyłącznie** loadera w vaulcie (zmniejszenie zakresu vs STATUS) | U4 |
| **Wersja z pliku, nie z gita** | CAVE instaluje się zipem bez `.git` — `git rev-parse` nie ma czego czytać na jedynej maszynie, dla której ta funkcja powstała. Zip pobierać po **skrócie commita**, nie po nazwie gałęzi (cache raw.githubusercontent) | U1, U11 |
| **Panel pokazuje DWIE wartości adresu** | Jedna liczba nie odpowiada na pytanie „czy używam tego, co ustawiłem". Persystencja istnieje po obu stronach (`~/.zshrc` / rejestr HKCU), więc drugie źródło jest odczytywalne | U9 |
| **Parser `export` jako druga implementacja** | `setup.mjs` jest ESM, `server.js` CommonJS — synchroniczny import nie przejdzie. Świadoma duplikacja **związana komentarzem po obu stronach**; precedens: `INBOX_CODE_PREFIX` w `server.js` vs `invite.mjs` | U9 |
| **Poz. 13 bez maszyny stanu** | Skoro naprawa to jedna komenda, „zamykam bez naprawy" nie jest realnym scenariuszem. **Warunek: komenda w treści zadania** — inaczej mechanizm jest naganiaczem bez dźwigni. Rozpoznawanie po **ukrytym znaczniku**, nie po tytule | U8 |
| **Dedup archiwum wymaga DODANIA markera** | Wbrew założeniu w STATUS `renderArchiveThread` **nie emituje** `%% id:… thread:… %%` — marker żyje wyłącznie w renderze Skrzynki. Konsekwencja: wpisy sprzed zmiany nie zostaną wykryte | U7 |
| **CSS bez `:has()` nie jest przepisywany** | Update Obsidiana na CAVE naprawił wygląd (potwierdzone 05.08). Zostaje wymaganie wersji w onboardingu | U12 |

---

## Zależności

### Wewnętrzne (kolejność wykonania)

```
U1 ──┬──> U8
     ├──> U9 ──> U10
     └──> U11
U2 ──> U3
U4 ──> U5 ──> U7
U6 ──> U8
wszystkie ──> U12
```

### Zewnętrzne

- **VPS** — dostęp ssh, restart usługi po U2 i U3 (hub)
- **CAVE/Windows** — poligon testowy; instalacja zipowa (`install.ps1`), bez gita
- **`aibiz-plugin`** — U12 zablokowany do czasu wyjaśnienia niezacommitowanych cudzych zmian
  (`D plugins/aibiz/hooks/frontmatter-validate.sh`, `M plugins/aibiz/hooks/hooks.json`)

---

## Wiedza instytucjonalna (`docs/solutions/`)

| Wpis | Czego uczy | Unity |
|---|---|---|
| `runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md` | `migrate()` leci co boot — backfill wymaga sentinela albo jednorazowego skryptu | U2 |
| `deployment-issues/2026-07-07-stale-env-vps-url-hook-respawn-serwera.md` | Dokładnie problem R7; diagnoza wymaga **porównania źródeł**, nie odczytu jednego | U9 |
| `deployment-issues/2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md` | Windows nie przeniesie pliku z otwartym uchwytem — ubijać filtrem po **ścieżce instalacji**, nigdy po nazwie binarki. `raw.githubusercontent.com` cachuje adresy z nazwą gałęzi | U1, U11 |
| `auth-issues/2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-eksfiltracja-prompt-injection.md` | `cwd` spawnu agenta to granica bezpieczeństwa — komunikat błędu **nie może** sugerować powrotu sekretu do vaulta | U4 |
| `runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md` | Po zapisie decyduj na świeżym odczycie; założenie międzymodułowe = test szwu | U2, U3 |

---

## Terminologia (`docs/CONCEPTS.md`)

Używana w tym zadaniu bez redefiniowania: **Hub**, **Skrzynka**, **Kod zaproszenia**, **Rola maszyny
(`inbox_role`)**, **Script-job**, **Job-teczka**, **Routine**, **Asystent auto-reply**, **NO_ANSWER**.

⚠️ **Nie „naprawiać" zachowań udokumentowanych jako świadome:** `routine=1` tłumi sukcesy; zmiana roli
nie wyłącza joba z poprzedniej roli; `NO_ANSWER` gdziekolwiek w odpowiedzi znaczy „nie wiem".

---

## Konwencje projektu obowiązujące w tym zadaniu

- Testy `node:test` **kolokowane obok źródła** (`lib/x.test.js` przy `lib/x.js`); zero zależności testowych
- Wstrzykiwanie zależności dla testowalności (`db.setDbPath(':memory:')`, `main({ client })`)
- Komentarze **po polsku**, wyjaśniają NIE-oczywiste decyzje — nie opisują oczywistości
- Backend CommonJS, skrypty inbox ESM, frontend vanilla JS bez buildu
- Obowiązują `.claude/rules/coding-rules.md` i `.claude/rules/learned-patterns.md`
- **Nie zmieniać identyfikatorów technicznych** `claude-cron` (nazwa w `package.json`, `data/claude-cron.db`,
  `CLAUDE_CRON_*`, label launchd) — „Puls" to warstwa prezentacji

---

## Dziennik wykonania

### Faza 1 — Widoczność i hub (2026-08-05) — **zaimplementowana, `npm test` 837/837**

**U1 — wersja instalacji w `/api/status`**

- Nowe `lib/version.js` (+ `lib/version.test.js`): `readVersionFile`/`getInstallVersion`/`writeVersionFile`
  nad `data/version.json`. Kontrakt: **odczyt nigdy nie rzuca** — brak pliku, uszkodzony JSON i błąd I/O
  dają ten sam kształt `{revision:'unknown', installed_at:null, source:'unknown'}`.
- `server.js` — pole `version` w `/api/status` obok `repo_dir`.
- `setup.mjs` — `persistInstallVersion()` wołane **przed pytaniami** setupu (setup biegnie już z docelowego
  katalogu, więc jest po swapie; jeśli setup padnie w połowie, ślad wersji i tak zostaje na dysku).
  Pad zapisu = `warn`, nigdy przerwanie instalacji.
- `install.sh` / `install.ps1` — archiwum pobierane **po SHA commita** (`resolve_tarball_source`
  / `Resolve-ZipSource`, SHA z API GitHuba), rewizja przekazywana do `setup.mjs` env-em
  `CLAUDE_CRON_INSTALL_REVISION` / `CLAUDE_CRON_INSTALL_SOURCE`. Pad rozstrzygania SHA (brak sieci,
  limit API) = zejście na URL po nazwie gałęzi + wersja `unknown`; instalacja leci dalej.

**U2 — hub odrzuca nieznanego adresata**

- `members.name` z `COLLATE NOCASE`. SQLite nie zmienia kolacji przez `ALTER`, więc przepisanie tabeli;
  guard `needsMembersNocaseRebuild` czyta **faktyczny DDL** z `sqlite_master.sql` (`PRAGMA table_info`
  nie zdradza kolacji) — bez sentinela, bo źródłem prawdy jest schemat, a `migrate()` leci co boot.
- Kolizja `Cave` + `cave` → `InboxDbError` z obiema nazwami i **zero zmian w danych** (duplikaty liczone
  w JS, nie agregatem SQL — pułapka BigInt).
- `sendMessage` → `resolveRecipient()` przed `INSERT`: dopasowanie case-insensitive, podmiana na nazwę
  kanoniczną z `members`; brak trafienia → `unknown_recipient`, wiele trafień → `ambiguous_recipient`
  (nigdy „pierwszy z brzegu").
- `lib/inbox-api.js` — `handleSend` mapuje te dwa kody na `400 {error:'unknown_recipient', members:[…]}`.

**U3 — odpowiedziane pytanie znika z „Wysłanych"**

- `pullForUser` — zapytanie `delegated` z `NOT EXISTS (reply w tym thread_id od `from_user` ≠ autora)`,
  ograniczone do `type='query'`. `task` bez zmian. Rekord **nie** dostaje `status='done'` (świadomy dług
  widok↔status).

### Odchylenia od planu (Faza 1)

| Odchylenie | Powód |
|---|---|
| `setup.mjs` eksportuje dodatkowo `resolveInstallVersionInput` | Czysty helper priorytetu `env > git > unknown`; bez wydzielenia logika byłaby nietestowalna |
| `InboxDbError` dostał opcjonalne pole `code` | API rozpoznaje powód po kodzie, nie po treści komunikatu (komunikaty zmieniają się przy korektach językowych). Plan mówił tylko o „mapowaniu `InboxDbError`" |
| `getInboxDb()` przypisuje połączenie do modułu **po** migracji i smoke-teście | Wcześniej przypisywał przed `migrate()` — fail-fast kolizji nazw zostawiłby częściowo zmigrowaną bazę jako „gotową" |
| Fixtury istniejących testów inbox rozszerzone o seed członków | Wymuszone zmianą kontraktu z planu (adresat musi istnieć w `members`). Zero osłabionych ani usuniętych asercji |
| Weryfikacje „żywy daemon" (`curl /api/status`) i `[Manual]` niewykonane | Daemon biegnie ze starym kodem; restart to decyzja operatora |

### Review Fazy 1 (2026-08-05)

Raport: [review-faza-1.md](review-faza-1.md). Severity gate: **ZASTRZEŻENIA** — 0×P1, 5×P2, 13×P3
(KOD/TEST) + 7 findingów OPERATOR. `npm test`: 837/837 pass, exit 0.

Kluczowe wnioski:

- **Fail-fast migracji NOCASE jest szerszy niż zamierzony** (`lib/inbox-db.js:120`). Rzucenie z `migrate()`
  zabija CAŁE połączenie, a `getInboxDb()` biegnie przy każdej operacji — więc kolizja nazw kładzie całą
  skrzynkę (nie tylko `send`) i blokuje instruowaną w komunikacie naprawę przez `revokeMember`. To dokładnie
  ta klasa błędu, którą wcześniej „naprawiliśmy" przesuwając przypisanie połączenia za `migrate()` —
  przesunięcie rozwiązało częściową migrację, ale nie dostępność lekarstwa.
- **R10 nie jest spełnione na VPS** (`scripts/install-vps.sh`). `data/version.json` pisze wyłącznie
  `setup.mjs`, którego ścieżka VPS nie uruchamia — hub, czyli maszyna 24/7, zawsze raportuje `unknown`.
  U8 i U11 stoją na tym polu, więc dług trzeba spłacić w tej fazie.
- **Bootstrap instalatorów wszedł bez testów**, mimo istniejącego harnessu (`install.test.sh`,
  `CLAUDE_CRON_LIB_ONLY=1`) — i to jest bezpośrednia przyczyna, dla której defekt zachłannego `sed`
  w `fetch_ref_sha` przeżył implementację. Analogicznie zero Pesterów dla `Resolve-ZipSource`.
- **Szew `server.js`↔`lib/version` nieprzetestowany** — potwierdzenie learned pattern „testy czystych funkcji
  obu stron przechodzą przy złamanym zachowaniu systemowym".
- **Fold wielkości liter rozjeżdża się z SQLite dla diakrytyk** (`toLowerCase()` vs `COLLATE NOCASE`
  = tylko ASCII). Przy polskojęzycznym zespole „Michał"/"MICHAŁ" czyni obie osoby trwale nieosiągalnymi.

Bookkeeping `Weryfikacja:`: 8 checkboxów odznaczonych automatycznie (7×CLI + 1×grep), 1 pozostawiony
operatorowi (`curl /api/status` — potwierdzone, że lokalny daemon biegnie ze starym kodem: odpowiedź nie
zawiera pola `version`). Tester E2E pominięty przez routing (brak warstwy UI, zero browserowych
checkboxów), więc żaden checkbox wymagający żywego środowiska nie został odznaczony.

### Faza 2 — Granica repo ↔ vault (2026-08-05) — **zaimplementowana, `npm test` 853/854**

**U4 — `PULS_HOME` ustawia instalator, nie człowiek**

- `setup.mjs` — nowy czysty helper `mergeEnvIntoSettings(existing, key, value)` (lustro
  `mergeHookIntoSettings` dla sekcji `env` tego samego pliku): cudzych kluczy nie rusza,
  `changed=false` gdy wartość jest już dokładnie ta sama, więc re-run nie przepisuje pliku.
- `registerPulsHomeEnv(workspace, installDir)` zapisuje `env.PULS_HOME` do
  `{workspace}/.claude/settings.json`; `writePulsHomePointer()` + `defaultPulsHomePointer()`
  piszą wskaźnik `~/.claude-cron-home` z **faktycznym** katalogiem instalacji (konwencja
  `~/.claude-cron-oauth-token`). Zgadywanie `$HOME/claude-cron` świadomie odrzucone.
- `persistPulsHome()` wołane **bezwarunkowo**, niezależnie od odpowiedzi o autostart — to od niego
  zależy, czy skille w vaulcie w ogóle znajdą `data/inbox.env`. Uszkodzony `settings.json` = fail-fast
  (jak przy hooku), pad zapisu wskaźnika = `warn` (instalacja jest sprawna, traci tylko zasięg).
- `<vault>/.claude/skills/deleguj/scripts/env.mjs` — kolejność szukania sekretu:
  `INBOX_ENV_FILE` → `$PULS_HOME/data/inbox.env` → wskaźnik `~/.claude-cron-home` →
  walk-up `.env` (legacy, tylko odczyt). Komunikat `MISSING_CONFIG_MESSAGE` **przestał** sugerować
  wpisanie sekretu do `.env` w vaulcie — wskazuje re-run instalatora (`docs/solutions/2026-07-26`).

**U5 — `close` archiwizuje wątek, jedna kopia kodu w repo**

- `appendToArchive` w `scripts/inbox/inbox-push.mjs` jest teraz **eksportowana** (zachowanie bez zmian).
- Nowy `scripts/inbox/close.mjs` w repo, obok `inbox-push.mjs`: `main({client, argv})` z wstrzykiwanym
  klientem (wzorzec `inbox-push`), domyka wyłącznie wiadomości **do mnie**, akcją `Zapoznane`
  (nie `Zrobione` — to wysłałoby nadawcy automatyczną odpowiedź), archiwum zapisuje **raz na wątek**,
  nie raz na wiadomość. Entry-point guard przez `realpathSync` po obu stronach.
- `<vault>/.../deleguj/SKILL.md` woła `node "$PULS_HOME/scripts/inbox/close.mjs"` z **guardem na brak
  `PULS_HOME`** — czytelny komunikat zamiast `MODULE_NOT_FOUND`.

### Odchylenia od planu (Faza 2)

| Odchylenie | Powód |
|---|---|
| Nowy plik testowy **poza repo**: `<vault>/.claude/skills/deleguj/scripts/env.test.mjs` (4 testy loadera) | Checklist wymaga testów loadera w vaulcie, a repo-owy `setup.test.mjs` nie może importować pliku spoza repo bez wiązania testów z konkretną maszyną. Odpalanie: `node --test env.test.mjs` z katalogu `scripts/` — `npm test` repo tego **nie obejmuje** |
| Wydzielone `readSettingsFileOrThrow(settingsFile)` z `registerHook` | Do `{workspace}/.claude/settings.json` piszą teraz DWIE funkcje (hook + `env.PULS_HOME`); definicja „co znaczy uszkodzony plik" ma być jedna. Zachowanie i komunikat `registerHook` bez zmian |
| Zwrotka `close` rozszerzona o pole `archived` (plan mówił o `{thread_id, closed}`) | Bez tego „nitka trafiła do archiwum" nie jest widoczna w wyjściu komendy — cała naprawa jest o **widocznym** sygnale |
| `close.mjs` **rzuca** zamiast `process.exit(1)` w `main()` | `exit` siedzi wyłącznie w entry-point guardzie, żeby `main()` dało się testować (wzorzec `main({client})` z `inbox-push`) |
| Kopia `<vault>/.../deleguj/scripts/close.mjs` **nie usunięta** | Zgodnie z planem to krok operatora po zielonym T8. W okresie przejściowym działają obie ścieżki |

**Walidacja Fazy 2:** `npm test` → 853 pass / 1 fail, przy czym jedyny fail to
`lib/ask.test.js` „wnuk trzymający pipe po wyjściu CLI…" — plik **nietknięty w tej fazie**,
w izolacji 30/30 pass (`node --test lib/ask.test.js`). Klasyfikacja: **flake czasowy pod obciążeniem
pełnego suite'u**, nie defekt. Testy loadera w vaulcie: 4/4 pass (poza `npm test`).

**Ostatnia aktualizacja:** 2026-08-05 (domknięcie Fazy 2)

---

## Review Fazy 2 (2026-08-05)

**Severity gate: ⚠️ ZASTRZEŻENIA** — 0 × P1, **7 × P2**, 7 × P3, 3 findingi OPERATOR.
Pełny raport: `docs/active/naprawy-team-os/review-faza-2.md`.

**Kluczowe wnioski:**

1. **`close` gubi delegację nadawcy** (P2, `close.mjs:69`) — `Zapoznane` na wiadomości typu `task`
   robi `UPDATE ... status='done'` bez reply, a widok „Delegowane" filtruje `status != 'done'`.
   Zadanie znika z listy delegującego bez sygnału — dokładnie ta klasa cichej straty, którą U5
   miało likwidować. Komentarz `close.mjs:11` twierdzi odwrotnie.
2. **Kolejność hub → archiwum jest nieodwracalna** (P2, `close.mjs:79`) — pad zapisu po udanych
   `done` zostawia wątek domknięty i archiwum puste, a ponowny `close` trafia w `mine.length === 0`.
   Nitka JEST już w pamięci (`threadRows` z `pull()`), więc naprawa to snapshot przed pętlą.
3. **R4 spełnione tylko na laptopie** (P2, `install-vps.sh:1086`) — oba wskaźniki `PULS_HOME` pisze
   wyłącznie `setup.mjs`, którego ścieżka VPS nie uruchamia; maszyna z rolą `agent` nie dostanie
   żadnego. To ten sam dług co `data/version.json` z review Fazy 1.
4. **Loader sekretu wciąż poza repo** (P2) — świadome odchylenie fazy okazuje się tym samym
   wzorcem awarii, który U5 naprawiło dla `close.mjs`: `npm test` nie chroni kodu rozstrzygającego
   o źródle `INBOX_TOKEN`.
5. `persistPulsHome()` ubija cały setup na uszkodzonym `settings.json` (P2, `setup.mjs:1333`) —
   wbrew własnemu komentarzowi i PRZED zapisem niezależnego wskaźnika.

**Bookkeeping `Weryfikacja:`** — wszystkie 6 checkboxów fazy 2 odznaczone (4 × CLI, 2 × grep),
zero FAIL. Korekta notki walidacyjnej: `npm test` daje **854/854 pass, exit 0** — flake
`lib/ask.test.js` opisany wyżej **nie reprodukuje się** przy tym przebiegu.

---

## Faza 3 — Format Skrzynki i archiwum (2026-08-05)

**U6 — frontmatter Skrzynki domergowuje się przy każdym pull**

- `scripts/inbox/inbox-pull.mjs` dostał `mergeFrontmatter` — **merge, nie nadpisanie**: brakujące
  klucze z `SKRZYNKA_TEMPLATE` (`cssclasses`, `tags`) dochodzą, wartości już obecne (także cudze,
  ręcznie dopisane klucze) zostają nietknięte. Plik bez frontmattera dostaje cały blok z szablonu.
- Kontrakt push↔pull (`%% inbox:items:start/end %%`, marker `%% id/thread %%`, checkboxy) nietknięty —
  broni go test roundtrip na prawdziwym pliku tmp.

**U7 — archiwum bez duplikatów: marker + podmiana bloku**

- `renderArchiveThread` emituje `%% thread:<id> %%` (dotąd marker żył wyłącznie w renderze Skrzynki),
  a `appendToArchive` wczytuje plik miesiąca i **podmienia** blok o tym `thread_id`, jeśli już jest.
  Ponowna archiwizacja tego samego wątku daje jedną, nowszą kopię zamiast rosnącego łańcucha duplikatów.
- Bloki sprzed zmiany (bez markera) są nierozpoznawalne z definicji — nowy zapis dokłada blok obok,
  starego nie rusza. Czyszczenie historycznych duplikatów zostaje krokiem operatora.

**U8 — job „Puls — kontrola spójności"**

- Nowy `scripts/consistency-check.mjs` (+ testy): dwie kontrole, jeden mechanizm — snippet
  `<vault>/.obsidian/snippets/skrzynka.css` kontra szablon w pluginie zespołowym oraz wersja
  instalacji z U1 (`unknown` = instalacja nie wie, z czym pracuje).
- Rozjazd = **zadanie w vaulcie** z `termin:` w frontmatterze i **komendą naprawczą w treści**.
  Duplikat rozpoznawany po ukrytym znaczniku `%% puls:consistency-check %%`, nigdy po tytule
  ani nazwie pliku — tytuł zmieni się przy pierwszym porządkowaniu Dashboardu.
- Szablon motywu rozwiązywany z **zainstalowanego** pluginu (`installed_plugins.json`), nie ze skanu
  cache — cache trzyma wiele wersji po hashu commita i „którakolwiek" porównywałaby vault z losową.

### Decyzje i odchylenia (Faza 3)

| Odchylenie | Powód |
|---|---|
| `updateSkrzynkaFile` wyeksportowana obok `mergeFrontmatter` (U6) | Test roundtrip ma być testem **szwu** render+merge+zapis na pliku tmp, nie testem kształtu czystej funkcji |
| Istniejący test appendu (U7) dostał drugi `thread_id` + **wzmocnione** asercje (oba wątki obecne, kolejność zachowana) | Po zmianie dwa zapisy tego samego `thread_id` to podmiana, więc stary test nie testowałby już appendu. Zero osłabiania asercji |
| `INBOX_TODO_PATH` dopisany do `ENV_KEYS` i czyszczony w `setupVault` (`inbox-push.main.test.mjs`) | `loadEnv` mutuje `process.env`, a dołożony test szwu woła `close.main`, który tej ścieżki używa |
| Seed przez `templates/starter-jobs.json` + `lib/starter-jobs.js` (nie `inbox-seed.js`) | Opcja dopuszczona planem. Wymusiła dwie zmiany: script-joby pomijają sprawdzanie skilla (inaczej `missing_skill` dla `undefined`), a `loadStarterJobDefs` rozwiązuje względny `command` do absolutnego wobec katalogu instalacji — ścieżka absolutna w JSON byłaby przypięta do maszyny autora |
| Job dostał `lock_group: 'dashboard'` (poza literą planu) | Pisze do `Zadania/Dashboard.md`, tego samego pliku, który w całości przepisuje „Team OS — inbox sync". Bez grupy równoległy run gubiłby jedną z wersji bez sygnału |
| Zadanie tworzone w **dwóch** miejscach: plik w `Zadania/w_trakcie/` + wpis w sekcji „Dzisiaj" Dashboardu | `termin:` daje widoczność po najbliższej regeneracji, wpis w Dashboardzie — natychmiast. Brak sekcji lub brak pliku Dashboardu nie wywala joba |
| Porównanie CSS normalizuje CRLF i końcowe białe znaki | Bez tego snippet skopiowany na Windowsie (CAVE) byłby wiecznym fałszywym rozjazdem |
| Kontrola wersji sprawdza wyłącznie `revision === 'unknown'` | Porównanie z wersją zdalną z GitHuba to jawnie U11 (Faza 5) |
| **Tryb `--refresh-theme` w `SKILL.md` pluginu NIE zrobiony** — przeniesiony do U12 (Faza 5) | Scope U8 zakazuje dotykania pluginu zespołowego, a U12 modyfikuje dokładnie ten plik. Nazwa trybu jest już stałą `THEME_FIX_COMMAND` i trafia do treści zadania. Ten sam powód dla kroku onboardingu „Obsidian zaktualizowany" (R15) |

**Audyt error-handlingu (przed commitem):** zero `console.log` w kodzie produkcyjnym — logowanie
`consistency-check` idzie przez wstrzykiwany `log` (default `console.log`), tak jak w pozostałych
script-jobach. Poprawka: `catch` na `JSON.parse(installed_plugins.json)` zwracał `null` **cicho**,
więc uszkodzony manifest raportowałby się jako „brak pluginu" i job przestałby pilnować motywu na
zawsze — dołożony `console.error` z powodem. Drugi bezargumentowy `catch` (sonda `readdir` na
`plugins/`) opisany komentarzem: brak podkatalogu to normalny stan, odpowiednik `ENOENT`.

**Walidacja Fazy 3:** `npm test` → **895/895 pass, exit 0** (0 fail, 0 skipped).
`node --test scripts/consistency-check.test.mjs` → 17/17 pass. Typecheck, linter i build w tym
projekcie nie istnieją (czysty CommonJS + vanilla JS, `node:test` bez zależności) — nie ma czego
uruchomić poza `npm test`.

**Ostatnia aktualizacja:** 2026-08-05 (domknięcie Fazy 3)

---

## Faza 4 — Konfiguracja VPS (2026-08-05)

**U9 — panel pokazuje adres w użyciu obok zapisanego**

- Nowy `lib/persisted-env.js` (+ testy): odczyt wartości **utrwalonej** przez instalator — Unix
  ostatnia linia `export NAZWA=...` z `~/.zshrc`/`~/.bashrc` (czytane OBA, bo launchd/systemd
  startują bez `SHELL`), Windows `[Environment]::GetEnvironmentVariable(..., 'User')`.
  I/O wstrzykiwane (`REAL_IO`, wzorzec `lib/platform.js`), więc testy nie dotykają maszyny usera.
- `/api/status` dostaje pole `vps_url` = `{ in_use, persisted, mismatch }` z `describeEnvUsage`.
  Odczyt utrwalonej wartości leci **w czasie żądania** (wzorzec `notify-config.js`), a `mismatch`
  jest `true` wyłącznie gdy obie wartości są znane i różne — nieczytelne źródło to „nie wiem"
  (`persisted: null`), nigdy oskarżenie o rozjazd.
- Panel: pasek `#vps-addr` renderowany przez `renderVpsAddr`; brak pola `vps_url` (proxy do
  starszej instancji VPS) chowa pasek, zamiast wywalić render statbara.

**U10 — instalator podpowiada zapisany adres VPS**

- `setup.mjs` pyta o adres z podpowiedzią zapisanej wartości (jak port i workspace). Trzy rozłączne
  stany w czystym `resolveVpsChoice`: `kept` (pusty Enter przy istniejącej konfiguracji — env NIE
  jest przepisywany), `none` (dopiero tu „tryb tylko lokalny"), `set` (nowy adres nadpisuje).
- Utrwaloną wartość czyta **ten sam** `readPersistedEnv` co `/api/status`; pierwszeństwo ma wartość
  z RC/rejestru nad `process.env` bieżącej sesji (pułapka stale env, `docs/solutions/…2026-07-07…`).

### Decyzje i odchylenia (Faza 4)

| Odchylenie | Powód |
|---|---|
| Pole trafiło jako osobny pasek `#vps-addr` **pod statbarem**, nie do „sekcji ustawień na górze panelu" z planu | Panel takiej sekcji nie ma — ustawienia żyją w modalach („Ile naraz", „Powiadomienia"). Pasek reużywa skorupy CSS statbara i znika, gdy VPS nie jest skonfigurowany |
| Brak duplikacji parsera env między `setup.mjs` (ESM) a `server.js` (CJS) — plan dopuszczał świadomy duplikat | Most okazał się darmowy: `setup.mjs` już trzyma `createRequire(import.meta.url)` (używa go do `require('./lib/db')`), więc `lib/persisted-env.js` jest importowany wprost. Zero rozjazdu z formatem `upsertEnvLine` |
| Lustro zapis↔odczyt związane komentarzem po **obu** stronach (`upsertEnvLine`, `buildSetUserEnvCommand` ↔ `persisted-env.js`) | Format `JSON.stringify` i scope `'User'` to kontrakt między plikami; zmiana po jednej stronie musi trafić na drugą (precedens `INBOX_CODE_PREFIX`) |

**Audyt error-handlingu (przed commitem):** zero `console.log`/`console.error` w kodzie
produkcyjnym tej fazy (komunikaty w `setup.mjs` to CLI instalatora, jak cały ten plik). Żaden
`catch` nie jest pusty — wszystkie zwracają `null`/`continue` z komentarzem uzasadniającym:
kontrakt `readPersistedEnv` brzmi „nigdy nie rzuca, nieczytelne źródło = «nie wiem»", bo pad
odczytu RC nie może zabić `/api/status`.

**Do rozstrzygnięcia w review:** `readWindowsPersistedEnv` spawnuje PowerShell **synchronicznie**
w ścieżce `/api/status`, a panel odpytuje co 3 s — na Windowsie to spawn co odświeżenie. Nie
zmieniane w domknięciu (zmiana kształtu, nie naprawa błędu), zgłoszone reviewowi Fazy 4.

**Walidacja Fazy 4:** `npm test` → **912/912 pass, exit 0** (0 fail, 0 skipped).
`node --test lib/persisted-env.test.js` → 13/13 pass, `node --test setup.test.mjs` → 134/134 pass.
Typecheck, linter i build w tym projekcie nie istnieją (czysty CommonJS + vanilla JS) — nie ma
czego uruchomić poza `npm test`.

---

## Review Fazy 4 (2026-08-05)

Raport: `docs/active/naprawy-team-os/review-faza-4.md`. Gate: **⛔ BLOKUJE** — 1× P1, 4× P2,
8× P3, 2× OPERATOR. `npm test` w review: **918/918 pass, exit 0**.

Kluczowe wnioski:

- **P1: `hidden` nie chowa elementu z `display:flex`.** Pasek `#vps-addr` (`.statbar`) i
  ostrzeżenie (`.stat`) mają regułę autora bijącą UA-owe `[hidden]{display:none}` — a projekt nie
  ma globalnego override'u (jedyny precedens: `.modal-overlay[hidden]`, style.css:529). Skutek:
  „⚠ Rozjazd" wisi zawsze, także przy `mismatch:false`. Feature zbudowany po to, żeby ufać
  diagnostyce, świeci fałszywym alarmem u każdego usera.
- **Pytanie „do rozstrzygnięcia w review" rozstrzygnięte: to defekt, nie kształt.** Synchroniczny
  `spawnSync` PowerShella w ścieżce `/api/status` (bez cache i bez `timeout`) siedzi za
  endpointem bez autoryzacji, bez rate limitu i z `ACAO: *` — dowolna odwiedzona strona robi z
  niego DoS schedulera. Wzorzec „odczyt w czasie żądania" z `notify-config.js` NIE przenosi się
  ze state DB na spawn procesu.
- **`kept` w `resolveVpsChoice` odtwarza dokładnie ten błąd, który faza miała zamknąć (R7/R11):**
  pomija nie tylko zapis do RC, ale i `process.env` bieżącego procesu, więc serwer wskrzeszany
  przez ten sam run setupu leci bez adresu → `/api/vps/*` 503.
- **Deklarowane scenariusze `/api/status` pokryte tylko testem czystej funkcji** — szew
  server ↔ persisted-env ↔ app.js niepokryty, mimo precedensu `server.runs.test.js:156` z Fazy 1
  i learned-patternu o testach czystych funkcji przy złamanym zachowaniu systemowym.
- **Środowisko:** lokalny daemon na 7777 biegnie z kodem sprzed Fazy 4 (legacy launchd
  `com.claude-cron.daemon`), więc weryfikacja `curl`-em przeszła dopiero na świeżej instancji.

**Ostatnia aktualizacja:** 2026-08-05 (review Fazy 4)

---

## Faza 5 — Aktualizacja i dystrybucja (2026-08-05)

**U11 — aktualizacja Pulsa przyciskiem w panelu**

- `lib/updater.js` — czterowartościowy kontrakt stanu i to jest sedno modułu: `current`,
  `available`, `unknown` (lokalna rewizja nieznana) i `check_failed` (pad API GitHuba) są
  ROZŁĄCZNE. „Nie wiem" i „nie udało się sprawdzić" NIE MOGĄ udawać „masz aktualne" — fałszywa
  zieleń jest gorsza niż brak odpowiedzi, bo user przestaje sprawdzać.
- Wersja lokalna z `data/version.json` (U1), nie z gita: instalacja zipowa/tarballowa nie ma
  repozytorium, a to ona jest domyślną drogą u użytkowników. Porównanie po prefiksie ≥7 znaków
  (lokalna bywa skrócona z `git rev-parse --short`, zdalna jest zawsze pełna).
- `GET /api/update` (sprawdzenie) i `POST /api/update` (start) siedzą za guardem XFF jak cały
  dashboard, a POST dodatkowo za wspólnym guardem cross-origin `handleApi` — to zdalne pobranie
  kodu z GitHuba + restart daemona, czyli najgroźniejszy endpoint w całym API. **Rewizja bierze
  się ze świeżego sprawdzenia po stronie serwera, nigdy z body** — klient nie decyduje, co się
  instaluje.
- macOS: `git pull --ff-only && kill <pid>` — `kill` TYLKO po udanym pullu (`&&`), przy
  konflikcie/braku sieci serwer żyje dalej, a panel po timeoucie mówi wprost, że się nie udało.
  Windows: `install.ps1` pobierany po **SHA**, nie po nazwie gałęzi (raw.githubusercontent
  cachuje URL-e gałęziowe — learned pattern 2026-07-28), proces `detached` przeżywa śmierć
  rodzica, bo to on ubija daemona (zablokowane pliki).
- Panel: sprawdzenie RAZ przy starcie (publiczne API GitHuba ma limit 60/h na IP, a odpowiedź
  zmienia się w skali dni). Pasek widoczny wyłącznie, gdy jest co powiedzieć — „masz najnowszą"
  nie zasługuje na stały pasek. Po kliknięciu odpytywanie co 5 s, a po 6 min **jawny komunikat
  o niepowodzeniu**: cisza po kliknięciu wygląda identycznie jak „padło w połowie".

**U12 — aktualizacja pluginu zespołowego** (repo `aibiz-plugin`, poza tym repozytorium)

- `skills/onboard/templates/skrzynka.css` zsynchronizowany z rendererem po Fazach 1–4;
  `SKILL.md` opisuje flow Skrzynki, tryb `--refresh-theme` i wymaganie Chromium 105+ (`:has()`).

### Decyzje i odchylenia (Faza 5)

| Odchylenie | Powód |
|---|---|
| `CLAUDE_CRON_NONINTERACTIVE=1` w `install.ps1` **pomija `setup.mjs`**, zamiast puszczać go bez pytań | `setup.mjs` to onboarding sterowany pytaniami (workspace, VPS, powiadomienia, kod zaproszenia). Aktualizacja to podmiana KODU, nie ponowna konfiguracja — stan żyje w `data\` i env User-scope i przeżywa swap katalogów. `Invoke-UpdateFinish` robi dokładnie dwie brakujące rzeczy: zapis `data/version.json` (inaczej panel w kółko pokazuje „dostępna nowa wersja") i start serwera (`Stop-PulsProcesses` go ubił, a zadanie Task Scheduler jest ONLOGON) |
| Czyste helpery paska (`shortRevision`, `revisionsMatch`, `updateBarView`) w `public/render-helpers.js` — plik spoza listy „Pliki" w planie | To jedyny testowalny plik frontu w projekcie. Bez tego reguła „chowamy pasek WYŁĄCZNIE przy `current`" siedziałaby w `app.js` bez żadnego testu |
| Brak testu HTTP na żywym procesie dla `/api/update` (wzorzec `lib/ask.http.test.js`) | GET biłby w prawdziwe API GitHuba (flake + limit 60/h), POST realnie zaktualizowałby maszynę operatora. Szew pokryty jednostkowo: `checkForUpdate` (wersja + odpowiedź API → jeden stan) i `startUpdate` (plan → spawn) |
| Baseline `skrzynka.css` w pluginie ustawiony na **żywy snippet vaulta** (z kolejnością deklaracji) | Poprawka centrowania checkboxa z 05.08 nigdy nie trafiła do repo pluginu, a consistency-check porównuje tekst po normalizacji CRLF — sama przestawka linii byłaby wiecznym fałszywym rozjazdem. Zamyka finding #26 z review Fazy 3 |
| Wymaganie wersji Obsidiana opisane **objawowo** („zaktualizuj Obsidiana"), bez numeru | Brak pewnej mapy Obsidian → Electron/Chromium; instrukcja opiera się na „Sprawdź aktualizacje" i objawie (surowe callouty), nie na numerze, którego nie da się zweryfikować |
| `THEME_FIX_COMMAND` (`scripts/consistency-check.mjs:31`) NADAL opisuje kroki ręczne, mimo że `--refresh-theme` już istnieje | Tryb istnieje wyłącznie w niezacommitowanym `aibiz-plugin`. Do czasu pushu + `/reload-plugins` u zespołu komenda byłaby u odbiorcy martwa — a to dokładnie ten defekt (P2 z review Fazy 3), który uczy człowieka, że sygnał kłamie. Przełączenie jest w operator checkliście U12 |

**Audyt error-handlingu (przed commitem):** zero `console.log`/`console.error` dodanych do kodu
produkcyjnego poza wstrzykiwalnym `REAL_IO` w `lib/updater.js` (`io.log`/`io.warn` — konwencja
backendu tego repo, wymienne w testach). Żaden `catch` nie jest niemy bez uzasadnienia:
`fetchLatestRevision` zwraca `{ok:false, error}` (pad sieci/limit API to normalny stan, nie 500
w panelu), `loadUpdateStatus` zamienia pad na widoczny stan „nie udało się sprawdzić", a jedyny
milczący `catch` (`pollUpdateProgress`) jest udokumentowany i **raportuje przez timeout** —
serwer w trakcie restartu MUSI móc nie odpowiadać, a niepowodzenie i tak wychodzi po 6 min.
`public/app.js` nie ma ani jednego `console.*` w całym pliku (30 milczących catchów z
komentarzem) — nowy kod trzyma tę konwencję.

**Walidacja Fazy 5:** `npm test` → **952/952 pass, exit 0** (0 fail, 0 skipped).
`node --test lib/updater.test.js` → 21/21 pass. Typecheck, linter i build w tym projekcie nie
istnieją (czysty CommonJS + vanilla JS) — nie ma czego uruchomić poza `npm test`.

**Granica repo:** zmiany U12 leżą w OSOBNYM repozytorium `aibiz-plugin` jako niezacommitowane —
push jest bramkowany operator checklistą (cudze niezacommitowane zmiany w `hooks/` do wyjaśnienia
z autorem). Commit Fazy 5 obejmuje wyłącznie `claude-cron`.

**Ostatnia aktualizacja:** 2026-08-05 (domknięcie Fazy 5)
