# Review fazy 1 — Naprawy Team OS

**Zadanie:** `docs/active/naprawy-team-os/`
**Faza:** 1 — Widoczność i hub (U1, U2, U3)
**Data:** 2026-08-05
**Branch:** `feature/naprawy-team-os`

## Severity gate

⚠️ **KONTYNUUJ Z ZASTRZEŻENIAMI** — 5 problemów P2 do naprawy, zero P1.

## Statystyki

| Kategoria | Liczba |
|---|---|
| 🔴 P1 (blocking, KOD/TEST/E2E) | 0 |
| 🟠 P2 (important, KOD/TEST/E2E) | 5 |
| 🟡 P3 (nit, KOD/TEST/E2E) | 13 |
| 👤 OPERATOR (poza fix, warunki środowiskowe) | 7 |
| **Razem** | **25** |

Rozkład P1/P2/P3 wg typu: KOD 2×P2 + 10×P3 · TEST 3×P2 + 3×P3 · E2E 0.

Bramka globalna: `npm test` — **837/837 pass, exit 0** (baseline 155/155 nie spadł).

---

## Findings

### 🟠 P2 — important

#### P2-1 · KOD · `lib/inbox-db.js:120`

Fail-fast migracji NOCASE blokuje własne lekarstwo. `rebuildMembersWithNocase` rzuca `InboxDbError` przy kolizji nazw, ale rzuca z wnętrza `migrate()`, które biegnie w `getInboxDb()` przy KAŻDEJ operacji. Skutek: na hubie z parą „Cave"+"cave" (stan w pełni osiągalny sprzed tej migracji, bo dawny UNIQUE był case-sensitive) każde żądanie `/inbox/v1/:token/*` leci w catch server.js → 500; cała skrzynka zespołu jest martwa, nie tylko `send`. Jednocześnie komunikat błędu instruuje „Rozstrzygnij ręcznie (revokeMember)", a `revokeMember`/`listMembers`/`/api/inbox/members` też przechodzą przez `getInboxDb()` → też rzucają, więc naprawa przez aplikację jest niemożliwa (zostaje ręczna operacja na pliku `data/inbox.db`).

**Akcja:** albo nie blokuj całego połączenia (pozwól otworzyć bazę w trybie legacy i odrzucaj tylko `sendMessage`, ze stanem kolizji wystawionym w `/api/inbox/members`), albo zmień komunikat na instrukcję wykonywalną poza aplikacją (dokładny `sqlite3 data/inbox.db "UPDATE members ..."`). Testy tego nie łapią, bo `migrate(db)` jest w nich wołany na własnym połączeniu, z pominięciem `getInboxDb()`.

#### P2-2 · KOD · `scripts/install-vps.sh:1080`

Wersja instalacji nigdy nie powstaje na VPS-ie/hubie. `getInstallVersion()` czyta WYŁĄCZNIE `data/version.json`, a plik pisze tylko `persistInstallVersion()` w `setup.mjs` — którego ścieżka VPS nie uruchamia (`install-vps.sh` robi `git clone` + `npm install` i od razu startuje serwis, brak wywołania `setup.mjs` w całym pliku). Efekt: `/api/status` na hubie (maszyna 24/7, najtrudniejsza do zajrzenia z ręki, i jedyna, na której działa auto-reply) zawsze zwróci `version: {revision:'unknown', source:'unknown'}`, mimo że kod przyszedł z gita i rewizja jest tam trywialnie dostępna. Rozmija się z R10 („wersja własnego kodu widoczna w `/api/status` na każdej maszynie") i podkopuje U8/U11, które na tym polu stoją.

**Akcja:** po klonie/aktualizacji repo w `install-vps.sh` (jako user `claude`, PRZED restartem serwisu) zapisz plik, np. `node -e "const v=require('./lib/version');v.writeVersionFile({revision:process.argv[1],source:'git'})" "$(git -C $INSTALL_DIR rev-parse --short HEAD)"`, albo dołóż w `lib/version.js` jawny fallback na `git rev-parse` przy braku pliku.

#### P2-3 · TEST · `install.sh:335`

Nowa logika bootstrapu instalatorów jest bez żadnego testu, mimo że harness istnieje i ją obsługuje. `install.test.sh` źródłuje `install.sh` w trybie `CLAUDE_CRON_LIB_ONLY=1`, więc `resolve_tarball_source` i `fetch_ref_sha` są trywialnie testowalne przez podmianę funkcji `download`/`fetch_ref_sha` w piaskownicy — a to kod, który decyduje, JAKI kod trafia na maszynę użytkownika (URL archiwum + nazwa katalogu topdir). Bez testu cicho psuje się m.in.: ścieżka fallbacku (pad API → URL po nazwie gałęzi, `INSTALL_REVISION` pusty), ścieżka override (`CLAUDE_CRON_TARBALL_URL` bez `CLAUDE_CRON_TARBALL_TOPDIR` → `claude-cron-$REPO_REF`) oraz parser SHA (`sed` na JSON-ie bez `jq`, gdzie pierwsza 40-hexowa wartość „sha" musi być SHA commita).

**Akcja:** dopisać do `install.test.sh` trzy przypadki (sha OK → URL i topdir po SHA + `INSTALL_REVISION`; `fetch_ref_sha` zwraca 1 → URL po gałęzi i pusty `INSTALL_REVISION`; jawny `TARBALL_URL` → brak zapytania do API) oraz jeden Pester na `Resolve-ZipSource` z zamockowanym `Get-RefSha`.

#### P2-4 · TEST · `install.test.sh`

IU1 zmienia bootstrap `install.sh` (nowe `fetch_ref_sha` + `resolve_tarball_source`, nowy kontrakt zmiennych `TARBALL_URL`/`TARBALL_TOPDIR` domyślnie PUSTYCH), a istniejąca suita `install.test.sh` nie dostała ani jednego przypadku — `grep -n 'fetch_ref_sha\|resolve_tarball\|REPO_SLUG' install.test.sh` nie zwraca nic. To bezpośrednia przyczyna, dla której defekt „zachłanny sed" przeszedł przez fazę: test odpalający `fetch_ref_sha` na przygotowanej jednoliniowej odpowiedzi API (fixture z `parents` i `files`) i asertujący równość z sha commita złapałby go natychmiast. Repo ma wzorzec testowania instalatora bashowego (DI przez env), koszt niski. Analogicznie brak przypadku w `install.ps1.Tests.ps1` dla `Resolve-ZipSource` (w tym fallback na nazwę gałęzi przy padzie `Get-RefSha`).

#### P2-5 · TEST · `server.runs.test.js:90`

Scenariusz testowy z planu U1 („plik wersji istnieje i poprawny → `/api/status` zwraca rewizję i datę") jest odhaczony, ale pokryty wyłącznie unit-testami `lib/version.test.js` — nikt nie asertuje, że pole `version` faktycznie jest w odpowiedzi `/api/status`. Szew `server.js`↔`lib/version` jest nieprzetestowany: usunięcie/przemianowanie pola przechodzi cały `npm test` na zielono, a kontrakt publicznego endpointu jest złamany. To dokładnie wzorzec „testy czystych funkcji obu stron przechodzą przy złamanym zachowaniu systemowym" z `learned-patterns.md`.

**Akcja:** w `server.runs.test.js` (jest tam już żywy proces serwera i helper `getStatus()`) dołożyć asercję kształtu: `assert.ok(status.version && typeof status.version.revision === 'string')` plus `assert.ok('installed_at' in status.version)`; test dla świeżej instalacji bez pliku sprawdza `revision === 'unknown'`.

---

### 🟡 P3 — nit

#### P3-1 · KOD · `lib/inbox-db.js:202`
Rozjazd składania wielkości liter: `resolveRecipient` porównuje przez `String(x).toLowerCase()` (fold Unicode), a `COLLATE NOCASE` w SQLite składa WYŁĄCZNIE ASCII A-Z. Zweryfikowane na node:sqlite: przy istniejącym członku „Michał" wpis „MICHAŁ" przechodzi przez UNIQUE COLLATE NOCASE bez błędu, więc `addMember` NIE broni przed taką parą — a `resolveRecipient` widzi wtedy dwa trafienia i zwraca `ambiguous_recipient`, czyli obie osoby stają się TRWALE nieosiągalne dla `send` (400 dla każdej wiadomości), mimo że hub uważa schemat za poprawny. Wariant drugi: baza legacy z parą „Michał"+"MICHAŁ" wywraca `migrate()` przez detektor kolizji w JS, choć SQLite uznaje te nazwy za różne. Zespół jest polskojęzyczny, nicki z diakrytykami są realne. **Akcja:** ujednolicić fold po jednej stronie (fold tylko ASCII, np. `s.replace(/[A-Z]/g, c => c.toLowerCase())`) albo dołożyć w `addMember` jawny guard na kolizję po `toLowerCase()` przed INSERT-em.

#### P3-2 · KOD · `lib/inbox-db.js:111`
`needsMembersNocaseRebuild` testuje CAŁY DDL tabeli regexem `/COLLATE\s+NOCASE/i`, a nie kolumnę `name`. Gdy do `members` dojdzie kiedyś inna kolumna z NOCASE, guard zwróci `false` na tabeli, której `name` wciąż jest case-sensitive — migracja cicho się nie wykona i wraca dokładnie ten bug, który ta faza naprawia. **Akcja:** zawęzić wzorzec do wiersza kolumny (`/name\s+TEXT[^,]*COLLATE\s+NOCASE/i`) + test na DDL z NOCASE wyłącznie przy `token`.

#### P3-3 · KOD · `lib/inbox-db.js:84`
Zapytanie `delegated` w `pullForUser` filtruje po `i.from_user`, a jedyne indeksy to `inbox(to_user, status)` i `inbox(thread_id)` — czyli pełny skan tabeli `inbox`, teraz dodatkowo z korelowanym `NOT EXISTS` odpalanym dla każdego wiersza typu `query`. `pull` biegnie co 1 minutę na każdą maszynę członka, a `inbox` nie ma retencji. **Akcja:** dołożyć w `migrate()` `CREATE INDEX IF NOT EXISTS idx_inbox_from_type ON inbox(from_user, type);`.

#### P3-4 · KOD · `lib/inbox-db.js:52`
W `getInboxDb()` połączenie jest przypisywane do modułu dopiero po migracji — ale gdy `migrate(conn)` albo `assertInboxDbReturnsNumbers(conn)` rzuci, `conn` nie jest zamykane i nikt nie ma do niego referencji. Każde kolejne wejście — a `/api/status` woła `inboxDb.listMembers()` przy każdym pollingu dashboardu co 3 s (`server.js:246`) — otwiera nowe `DatabaseSync` i znów rzuca, więc uchwyty do pliku bazy i WAL narastają bez ograniczenia. **Akcja:** owinąć `migrate`/smoke-test w `try { … } catch (e) { conn.close(); throw e; }` przed przypisaniem do `inboxDb`.

#### P3-5 · KOD · `lib/inbox-db.js:388`
`addMember` nie normalizuje białych znaków, a `resolveRecipient` porównuje po surowym `toLowerCase()`. Admin dodaje członka wklejając nick ze spacją końcową (`"kamil "`, `server.js:571` też nie trimuje) → UNIQUE NOCASE go przepuszcza jako osobnego członka, a każde `send` do `"kamil"` dostaje 400 `unknown_recipient` z listą, w której obie nazwy wyglądają identycznie. **Akcja:** w `addMember` zapisywać `name.trim()` (odrzucać pusty po trimie), w `resolveRecipient` porównywać `String(toUser).trim().toLowerCase()`; test `addMember(' kacper ')`.

#### P3-6 · KOD · `install.sh:318`
Nowy krok `fetch_ref_sha` (i bliźniaczy `Get-RefSha` w `install.ps1:242`) dokłada wywołanie sieciowe do `api.github.com` na krytycznej ścieżce instalacji, a jego kontrakt brzmi „pad = zejście na URL po nazwie gałęzi". Kontrakt trzyma się tylko dla BŁĘDU, nie dla ZWIESZENIA: `download()` używa `curl -fsSL` bez `--max-time`/`--connect-timeout`, a `Invoke-RestMethod` bez `-TimeoutSec`. **Akcja:** własne `curl -fsSL --connect-timeout 5 --max-time 10` (gałąź `wget --timeout=10 --tries=1`) i `-TimeoutSec 10` w `Get-RefSha`.

#### P3-7 · KOD · `install.sh:340`
Fallback po nieudanym rozstrzygnięciu SHA składa nazwę katalogu jako `claude-cron-$REPO_REF` (`install.ps1:240` `claude-cron-$RepoRef`), a GitHub zamienia w topdirze `/` na `-`. Dla refu ze slashem (`feature/naprawy-team-os` — główny scenariusz `CLAUDE_CRON_REF`) tarball rozpakuje się do `claude-cron-feature-naprawy-team-os`, guard obecności `setup.mjs` nie znajdzie katalogu i instalacja padnie twardo. **Akcja:** sanityzować ref przy budowie topdiru (`${REPO_REF//\//-}` / `$RepoRef -replace '/','-'`).

#### P3-8 · KOD · `install.sh:35`
Redundantny env-override rewizji: `INSTALL_REVISION="${CLAUDE_CRON_INSTALL_REVISION:-}"` (`install.sh:35`) i `$InstallRevision = if ($env:CLAUDE_CRON_INSTALL_REVISION) …` (`install.ps1:34`) nie dają nic — `setup.mjs` czyta `process.env.CLAUDE_CRON_INSTALL_REVISION` bezpośrednio. **Akcja:** zostawić lokalne `INSTALL_REVISION=""` / `$InstallRevision = ""` wypełniane przez `resolve_tarball_source` / `Resolve-ZipSource`.

#### P3-9 · KOD · `lib/version.js:66`
Nadmiarowe API modułu przy jednym realnym konsumencie: (a) `getInstallVersion()` to alias `readVersionFile()` wołany raz (`server.js:354`); (b) `VERSION_FILE` i `unknownVersion` eksportowane, a poza modułem nieużywane; (c) `writeVersionFile({revision, source, installedAt})` przyjmuje `installedAt`, którego nie podaje żaden wołający. **Akcja:** wyciąć — zero zmian zachowania, cztery publiczne symbole mniej.

#### P3-10 · KOD · `setup.mjs:1222`
W `resolveInstallVersionInput` gałęzie fallbacku używają `envSource || 'git'` i `envSource || 'unknown'`, choć `CLAUDE_CRON_INSTALL_SOURCE` eksportują oba instalatory WYŁĄCZNIE razem z `CLAUDE_CRON_INSTALL_REVISION` — w tych gałęziach `envSource` jest z definicji pusty. Martwa gałąź, która przy ręcznie ustawionym samym SOURCE potrafi skłamać. **Akcja:** literały `{revision: gitRev, source: 'git'}` i `{revision: 'unknown', source: 'unknown'}`.

#### P3-11 · KOD · `setup.mjs:1247`
`readGitRevision` woła `git -C <REPO_DIR> rev-parse --short HEAD` bez sprawdzenia, czy REPO_DIR jest KORZENIEM repozytorium. Instalacja bootstrapowa do katalogu wewnątrz innego repo + pad rozstrzygania SHA → git zwraca HEAD OBCEGO repozytorium i `data/version.json` raportuje `source:'git'` z rewizją niezwiązaną z zainstalowanym kodem (gorsze niż `unknown`). **Akcja:** `git -C repoDir rev-parse --show-toplevel` i zwracać rewizję tylko gdy `realpathSync(toplevel) === realpathSync(repoDir)`.

#### P3-12 · TEST · `install.ps1.Tests.ps1:1`
Bliźniacza zmiana na Windows (`Get-RefSha`, `Resolve-ZipSource`, przekazanie `CLAUDE_CRON_INSTALL_REVISION` w `Invoke-Setup`) nie ma żadnego testu Pester. Literówka w `$script:ZipTopDir` albo pusty `$sha` daje rozpakowanie do katalogu o innej nazwie i „brak setup.mjs" u KAŻDEGO użytkownika Windows, przy w pełni zielonym `npm test`. **Akcja:** testy `Resolve-ZipSource` z zamockowanym `Get-RefSha` (40-hex → URL/TopDir/Revision; `""` → URL po gałęzi; `$env:CLAUDE_CRON_ZIP_URL` → brak wywołania `Get-RefSha`).

#### P3-13 · TEST · `lib/inbox-api.test.js:247`
Gałąź `ambiguous_recipient` nie ma ani jednego testu. Po migracji NOCASE tej ścieżki nie da się wywołać przez prawdziwą bazę, więc bez testu ze stubem zostaje martwym kodem: usunięcie `'ambiguous_recipient'` z `UNKNOWN_RECIPIENT_CODES` (`lib/inbox-api.js:382`) nie zapali żadnego testu, a na hubie sprzed migracji dałoby niezłapany wyjątek zamiast 400. **Akcja:** test wstrzykujący stub `inboxDb` przez deps, asercja 400 + `error:'unknown_recipient'` + lista członków.

---

### 👤 OPERATOR — warunki środowiskowe (poza zakresem fix)

Pełna lista z krokami: sekcja `## Operator checklist faza 1` w `naprawy-team-os-zadania.md`. Skrót:

1. **(P2)** `docs/active/naprawy-team-os/naprawy-team-os-kontekst.md:56` — trzy weryfikacje poza zasięgiem headless: `/api/status` z niepustym `version` (wymaga restartu daemona), realny przebieg bootstrapu `curl|bash` / `irm|iex`, oraz kontrola żywej `data/inbox.db` na VPS pod kątem par nazw różniących się wielkością liter. Punkt trzeci **PRZED deployem na VPS**.
2. **(P2)** `lib/inbox-db.js:82` — migracja `members` na COLLATE NOCASE odpala się przy pierwszym otwarciu bazy huba; przy kolizji robi fail-fast i hub nie obsłuży żadnego żądania skrzynki. Przed restartem daemona: `SELECT lower(name), count(*) FROM members GROUP BY 1 HAVING count(*)>1` oraz wiersze `inbox` z `to_user` spoza `members` (U2 Operator checklist).
3. **(P3)** `docs/plans/…-plan.md:213`, `:214` — `[Manual]` instalacja zipowa na Windows raportująca tę samą rewizję co pobrany zip (realna maszyna Windows + sieć + niezablokowany limit `api.github.com`).
4. **(P3)** `docs/active/naprawy-team-os/naprawy-team-os-zadania.md:85`, `:87` — `curl -s localhost:7777/api/status` z niepustym polem wersji; lokalny daemon biegnie ze STARYM kodem (potwierdzone w tej sesji: odpowiedź `/api/status` nie zawiera pola `version`), a `data/version.json` powstaje dopiero przy najbliższym `setup.mjs`.

---

## Odchylenia od planu

- Plan U1 przewidywał scenariusz „plik wersji istnieje i poprawny → `/api/status` zwraca rewizję i datę"; zaimplementowany jest wyłącznie jako unit-test `lib/version.js`, bez asercji na endpoincie (P2-5).
- Plan IU1 nie zdefiniował plików testowych dla zmian w `install.sh` / `install.ps1`; brak pokrycia zgłoszony jako P2-3 / P2-4 / P3-12.
- R10 („wersja własnego kodu widoczna w `/api/status` na **każdej** maszynie") nie jest spełnione dla VPS/huba (P2-2).

## Zgodność ze spec

- **R1 (hub odrzuca nieznanego adresata, prostuje wielkość liter)** — spełnione dla ASCII; zastrzeżenie dla diakrytyk (P3-1) i białych znaków (P3-5).
- **R3 (odpowiedziane pytanie znika z „Wysłanych")** — spełnione, komplet testów obecny; zastrzeżenie wydajnościowe (P3-3).
- **R10a (wersja instalacji w `/api/status`)** — spełnione na macOS/Windows przez `setup.mjs`, **niespełnione na VPS** (P2-2), niezweryfikowane end-to-end (P2-5, OPERATOR).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 8
- Odznaczone na podstawie Agent 5 E2E: 0 (tester E2E nie odpalił w tej fazie)
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `node --test lib/version.test.js` przechodzi → PASS (exit 0)
- [x] CLI: `npm test` przechodzi w całości (baseline 155/155) — U1 → PASS (837/837, exit 0)
- [x] CLI: `node --test lib/inbox-db.test.js` przechodzi → PASS (exit 0)
- [x] CLI: `node --test lib/inbox-api.test.js` przechodzi → PASS (exit 0)
- [x] CLI: `npm test` przechodzi w całości — U2 → PASS (837/837, exit 0)
- [x] Grep: `grep -n "COLLATE NOCASE" lib/inbox-db.js` → PASS (trafienie w definicji `members`, `lib/inbox-db.js:101`)
- [x] CLI: `node --test lib/inbox-db.test.js` przechodzi — U3 → PASS (exit 0)
- [x] CLI: `npm test` przechodzi w całości — U3 → PASS (837/837, exit 0)
- [ ] `curl -s localhost:7777/api/status` zwraca niepuste pole wersji — **SKIP (daemon biegnie ze starym kodem; brak przebiegu potwierdzającego)** → przeniesione do `## Operator checklist faza 1`, nie liczone jako P2

Uwaga: routing pominął testera E2E (brak warstwy UI, zero browserowych checkboxów `Weryfikacja:`), więc żaden checkbox wymagający żywego środowiska nie został odznaczony.

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 14 (10) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy); e2e (brak warstwy UI i zero browserowych checkboxow Weryfikacja: (0)) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 38 -> 38 -> 27 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 12 / 2 / 0 |
