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

**Ostatnia aktualizacja:** 2026-08-05 (domknięcie Fazy 1)
