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

- [x] Stwórz `lib/version.js` — czysty odczyt `data/version.json` (rewizja, data pobrania, źródło) z fallbackiem `unknown`
- [x] Stwórz `lib/version.test.js`
- [x] Modyfikuj `server.js` — pole wersji w `/api/status` (~`:344`, obok `repo_dir`)
- [x] Modyfikuj `setup.mjs` — zapis `data/version.json` **po** swapie katalogów (allowlista stanowa)
- [x] Modyfikuj `install.sh` — przekazanie faktycznie pobranej rewizji
- [x] Modyfikuj `install.ps1` — j.w. + pobieranie zipa **po skrócie commita**, nie po nazwie gałęzi
- [x] Test: plik wersji istnieje i poprawny → `/api/status` zwraca rewizję i datę
- [x] Test: plik nie istnieje (stara instalacja) → `unknown`, bez rzucania wyjątku
- [x] Test: plik uszkodzony / niepełny JSON → `unknown`, bez rzucania wyjątku
- [x] Weryfikacja: `node --test lib/version.test.js` przechodzi
- [x] Weryfikacja: `npm test` przechodzi w całości (baseline 155/155) — 837/837 pass
- [ ] Weryfikacja: `curl -s localhost:7777/api/status` zwraca niepuste pole wersji (SKIP — daemon biegnie ze starym kodem, wymaga restartu; patrz Operator checklist faza 1)

**Operator checklist:**
- [ ] Instalacja zipowa na Windows raportuje tę samą rewizję co pobrany zip

---

### U2 — Hub odrzuca nieznanego adresata i prostuje wielkość liter *(R1, nakład L, zależności: brak)*

> **Notatka wykonawcza:** zacznij od failing testu `sendMessage(to_user='cav')` → oczekiwany
> `InboxDbError`. To zachowanie kontraktowe huba — przybij je testem przed dotknięciem schematu.

- [x] Modyfikuj `lib/inbox-db.js` — `migrate()`: `members.name` na `COLLATE NOCASE` (przepisanie tabeli, idempotentne, fail-fast przy istniejącym duplikacie z **nazwami**)
- [x] Modyfikuj `lib/inbox-db.js` — `sendMessage()`: lookup po `listMembers()` przed `INSERT`, dopasowanie case-insensitive → podmiana na nazwę kanoniczną; brak trafienia **lub więcej niż jedno** → `InboxDbError`
- [x] Modyfikuj `lib/inbox-db.js` — `addMember()`: duplikat case-insensitive → `InboxDbError`
- [x] Modyfikuj `lib/inbox-api.js` — `handleSend:169` mapuje `InboxDbError` na `400 unknown_recipient` **z listą członków**
- [x] Modyfikuj `lib/inbox-db.test.js`
- [x] Modyfikuj `lib/inbox-api.test.js`
- [x] Test: `to_user='cave'` przy członku `Cave` → INSERT z `to_user='Cave'`
- [x] Test: `to_user='cav'` → `InboxDbError`, **zero wierszy** w `inbox`
- [x] Test: `handleSend` z nieznanym adresatem → `400`, ciało zawiera listę członków
- [x] Test: `addMember('cave')` przy istniejącym `Cave` → `InboxDbError`
- [x] Test: migracja na bazie z `Cave` i `cave` → czytelny błąd z obiema nazwami, baza nietknięta
- [x] Test: migracja idempotentna — drugi `migrate()` nie przepisuje tabeli
- [x] Weryfikacja: `node --test lib/inbox-db.test.js` przechodzi
- [x] Weryfikacja: `node --test lib/inbox-api.test.js` przechodzi
- [x] Weryfikacja: `npm test` przechodzi w całości — 837/837 pass
- [x] Weryfikacja: `grep -n "COLLATE NOCASE" lib/inbox-db.js` zwraca trafienie w definicji `members` (`lib/inbox-db.js:101`)

**Operator checklist:**
- [ ] Kopia zapasowa `data/inbox.db` z VPS przed deployem
- [ ] Migracja przetestowana na kopii żywej bazy
- [ ] Zapytanie kontrolne na hubie: czy są wiersze `inbox` z `to_user` spoza `members`
- [ ] Restart daemona na VPS po deployu

---

### U3 — Odpowiedziane pytanie znika z „Wysłanych" (T6) *(R3, nakład S, zależności: U2)*

- [x] Modyfikuj `lib/inbox-db.js` — `pullForUser:177`, zapytanie `delegated`: alias `FROM inbox i` + `NOT EXISTS (reply w tym thread_id **od kogoś innego niż `i.from_user`**)`, ograniczone do `type='query'`
- [x] Modyfikuj `lib/inbox-db.test.js`
- [x] Test: `query` + `reply` od adresata → **nie ma** w `delegated`
- [x] Test: `query` + `reply` **od samego nadawcy** → **jest** w `delegated` (własne dopowiedzenie nie zamyka)
- [x] Test: `task` + `reply` od adresata → **jest** w `delegated` (zadania zamyka checkbox)
- [x] Test: `query` bez odpowiedzi → jest w `delegated`
- [x] Test: wątek z dopowiedzeniem nadawcy pozostaje znajdowalny przez `findOriginal` (regresja `reply.mjs`)
- [x] Weryfikacja: `node --test lib/inbox-db.test.js` przechodzi
- [x] Weryfikacja: `npm test` przechodzi w całości — 837/837 pass

**Operator checklist:**
- [ ] **Retest T6** wg szablonu, z wariantem kontrolnym „własne dopowiedzenie nie zamyka"
- [ ] Dopisanie do `STATUS.md` zdania o świadomym długu widok↔status

---

## Do poprawy po review fazy 1

> Raport: [review-faza-1.md](review-faza-1.md) · severity gate: **ZASTRZEŻENIA** (0×P1, 5×P2, 13×P3)

- [x] 🟠 [P2] **lib/inbox-db.js:120** — Fail-fast migracji NOCASE blokuje własne lekarstwo: `rebuildMembersWithNocase` rzuca z wnętrza `migrate()`, które biegnie w `getInboxDb()` przy KAŻDEJ operacji. Na hubie z parą „Cave"+"cave" każde żądanie `/inbox/v1/:token/*` → 500 (martwa cała skrzynka, nie tylko `send`), a instruowany w komunikacie `revokeMember`/`listMembers`/`/api/inbox/members` też idzie przez `getInboxDb()` → naprawa przez aplikację niemożliwa. Albo otwieraj bazę w trybie legacy i odrzucaj tylko `sendMessage`, albo daj komunikat wykonywalny poza aplikacją (dokładny `sqlite3 data/inbox.db "UPDATE members ..."`). Testy tego nie łapią — wołają `migrate(db)` na własnym połączeniu, z pominięciem `getInboxDb()`.
- [x] 🟠 [P2] **scripts/install-vps.sh:1080** — Wersja instalacji nigdy nie powstaje na VPS/hubie: `data/version.json` pisze tylko `persistInstallVersion()` w `setup.mjs`, a `install-vps.sh` go nie uruchamia (`git clone` + `npm install` + start serwisu). `/api/status` na hubie zawsze `{revision:'unknown', source:'unknown'}` → rozjazd z R10 i podkopanie U8/U11. Napraw: po klonie/aktualizacji repo (jako user `claude`, PRZED restartem serwisu) zapisz plik przez `lib/version.writeVersionFile` z `git rev-parse --short HEAD`, albo dołóż w `lib/version.js` fallback na `git rev-parse` przy braku pliku.
- [x] 🟠 [P2] **server.runs.test.js:90** — Szew `server.js`↔`lib/version` nieprzetestowany: scenariusz U1 („`/api/status` zwraca rewizję i datę") pokryty wyłącznie unit-testami `lib/version.test.js`, nikt nie asertuje pola `version` w odpowiedzi endpointu. Usunięcie/przemianowanie pola przechodzi cały `npm test` na zielono. Dołóż w `server.runs.test.js` (jest tam żywy proces serwera i helper `getStatus()`): `assert.ok(status.version && typeof status.version.revision === 'string')` + `assert.ok('installed_at' in status.version)`; wariant bez pliku → `revision === 'unknown'`.
- [x] 🟠 [P2] **install.sh:335** — Nowa logika bootstrapu (`resolve_tarball_source`, `fetch_ref_sha`) bez żadnego testu, mimo że harness `install.test.sh` ją obsługuje (`CLAUDE_CRON_LIB_ONLY=1` + DI przez podmianę `download`). To kod decydujący, JAKI kod trafia na maszynę użytkownika. Dopisz trzy przypadki: sha OK → URL i topdir po SHA + `INSTALL_REVISION`; `fetch_ref_sha` zwraca 1 → URL po gałęzi i pusty `INSTALL_REVISION`; jawny `TARBALL_URL` → brak zapytania do API.
- [x] 🟠 [P2] **install.test.sh** — `grep -n 'fetch_ref_sha\|resolve_tarball\|REPO_SLUG' install.test.sh` nie zwraca nic: nowy kontrakt zmiennych `TARBALL_URL`/`TARBALL_TOPDIR` (domyślnie PUSTYCH) jest niepokryty. To bezpośrednia przyczyna, dla której defekt zachłannego `sed` przeszedł przez fazę — test `fetch_ref_sha` na fixture odpowiedzi API (z `parents` i `files`) złapałby go natychmiast. Analogicznie brak przypadku w `install.ps1.Tests.ps1` dla `Resolve-ZipSource` (w tym fallback na nazwę gałęzi przy padzie `Get-RefSha`).

<details>
<summary>🟡 P3 (opcjonalne, 13 pozycji — pełne opisy w raporcie)</summary>

- [ ] 🟡 [P3] **lib/inbox-db.js:202** — `resolveRecipient` składa Unicode (`toLowerCase()`), a `COLLATE NOCASE` tylko ASCII: para „Michał"/"MICHAŁ" przechodzi UNIQUE i czyni obie osoby TRWALE nieosiągalnymi (`ambiguous_recipient` → 400). Ujednolicić fold albo dołożyć guard w `addMember`.
- [ ] 🟡 [P3] **lib/inbox-db.js:111** — `needsMembersNocaseRebuild` matchuje `/COLLATE\s+NOCASE/i` na CAŁYM DDL, nie na kolumnie `name`; NOCASE przy innej kolumnie cicho wyłączy migrację. Zawęzić wzorzec + test.
- [ ] 🟡 [P3] **lib/inbox-db.js:84** — zapytanie `delegated` filtruje po `i.from_user` bez indeksu (pełny skan + korelowany `NOT EXISTS`), `pull` co 1 min, `inbox` bez retencji. Dołożyć `CREATE INDEX IF NOT EXISTS idx_inbox_from_type ON inbox(from_user, type);`.
- [ ] 🟡 [P3] **lib/inbox-db.js:52** — pad `migrate`/smoke-testu w `getInboxDb()` zostawia niezamknięte `DatabaseSync` bez referencji; `/api/status` woła `listMembers()` co 3 s → uchwyty do bazy i WAL narastają. Owinąć w `try/catch` z `conn.close()` przed przypisaniem.
- [ ] 🟡 [P3] **lib/inbox-db.js:388** — brak trimowania nazwy w `addMember`/`resolveRecipient`: `"kamil "` wchodzi jako osobny członek, a `send` do `"kamil"` dostaje 400 z listą, gdzie obie nazwy wyglądają identycznie.
- [ ] 🟡 [P3] **install.sh:318** — `fetch_ref_sha` / `Get-RefSha` bez timeoutów (`curl -fsSL` bez `--max-time`, `Invoke-RestMethod` bez `-TimeoutSec`): zdławione API wiesza instalator zamiast wejść w zaplanowany fallback.
- [ ] 🟡 [P3] **install.sh:340** — fallback składa topdir jako `claude-cron-$REPO_REF`, a GitHub zamienia `/` na `-`; ref ze slashem (`feature/naprawy-team-os`) wywraca instalację. Sanityzować ref w obu instalatorach.
- [ ] 🟡 [P3] **lib/version.js:66** — nadmiarowe API: alias `getInstallVersion()`, nieużywane eksporty `VERSION_FILE`/`unknownVersion`, nieużywany parametr `installedAt`. Wyciąć.
- [ ] 🟡 [P3] **setup.mjs:1222** — martwe `envSource || 'git'` / `envSource || 'unknown'` (oba instalatory eksportują SOURCE wyłącznie razem z REVISION); przy ręcznie ustawionym samym SOURCE potrafi skłamać. Zamienić na literały.
- [ ] 🟡 [P3] **setup.mjs:1247** — `readGitRevision` nie sprawdza, czy REPO_DIR jest korzeniem repo: instalacja wewnątrz cudzego repo raportuje `source:'git'` z obcą rewizją (gorsze niż `unknown`). Porównać `rev-parse --show-toplevel` przez `realpathSync`.
- [ ] 🟡 [P3] **install.ps1.Tests.ps1:1** — zero testów Pester dla `Get-RefSha`/`Resolve-ZipSource`/`Invoke-Setup`; literówka w `$script:ZipTopDir` wywala instalację u KAŻDEGO usera Windows przy zielonym `npm test`.
- [ ] 🟡 [P3] **lib/inbox-api.test.js:247** — gałąź `ambiguous_recipient` bez testu; po migracji NOCASE nieosiągalna przez prawdziwą bazę → test ze stubem `inboxDb` przez deps (400 + `error:'unknown_recipient'` + lista członków).

</details>

---

## Operator checklist faza 1

> Warunki środowiskowe niewykonalne headless — **nie są zadaniami do fix** i nie liczą się do ukończenia fazy.

- [ ] Operator: kontrola żywej bazy huba pod kątem nazw różniących się tylko wielkością liter — migracja `members` na COLLATE NOCASE odpala się przy pierwszym otwarciu bazy i przy kolizji robi fail-fast, po którym hub nie obsłuży ŻADNEGO żądania skrzynki — Operator action: na VPS wykonaj `sqlite3 ~/claude-cron/data/inbox.db "SELECT lower(name), count(*) FROM members GROUP BY 1 HAVING count(*)>1;"` **PRZED** deployem/restartem daemona; przy trafieniu rozstrzygnij duplikaty (`revokeMember` na starym kodzie albo `UPDATE members` na kopii) i dopiero wtedy deployuj.
- [ ] Operator: zapytanie kontrolne o wiersze `inbox` z `to_user` spoza `members` (rekordy sprzed walidacji adresata pozostają niedostarczalne, backfillu świadomie nie ma) — Operator action: `sqlite3 ~/claude-cron/data/inbox.db "SELECT id, from_user, to_user, type, status FROM inbox WHERE to_user NOT IN (SELECT name FROM members);"`, wynik przenieś do `STATUS.md` jako znany dług.
- [ ] Operator: kopia zapasowa `data/inbox.db` z VPS i przetestowanie migracji na tej kopii — Operator action: `scp` bazy na maszynę lokalną, `node -e "require('./lib/inbox-db').getInboxDb()"` z `INBOX_DB_PATH` wskazującym kopię, sprawdź brak wyjątku i obecność `COLLATE NOCASE` w `sqlite3 kopia.db ".schema members"`.
- [ ] Operator: restart daemona na VPS po deployu — Operator action: `sudo systemctl restart claude-cron` (jako admin), potem `curl -s localhost:7777/api/status` na VPS i weryfikacja, że serwis wstał.
- [ ] Operator: `curl -s localhost:7777/api/status` zwraca niepuste pole wersji (U1) — potwierdzone w tej sesji, że lokalny daemon biegnie ze STARYM kodem (odpowiedź nie zawiera pola `version`); dodatkowo `data/version.json` powstaje dopiero przy najbliższym `setup.mjs`, więc świeży odczyt da `unknown` dopóki setup nie pobiegnie — Operator action: zrestartuj lokalny daemon (`launchctl kickstart -k gui/$(id -u)/com.claude-cron.daemon`), następnie `curl -s localhost:7777/api/status | python3 -m json.tool | grep -A3 version`; pełną rewizję zobaczysz dopiero po re-instalacji przez `setup.mjs`.
- [ ] Operator: realny przebieg bootstrapu `curl|bash` / `irm|iex` — jedyny dowód, że archiwum po SHA faktycznie się pobiera i rozpakowuje do `claude-cron-<40-hex>` oraz że `setup.mjs` zapisał `data/version.json` (wymaga sieci, API GitHuba i świeżej maszyny) — Operator action: wykonaj **PO** naprawie P2 z `install.sh` (inaczej zweryfikujesz błędny SHA); na czystym katalogu `INSTALL_DIR=/tmp/puls-test curl -fsSL <raw-url-po-SHA> | bash`, potem `cat /tmp/puls-test/data/version.json` i porównaj z `git rev-parse --short <ref>`.
- [ ] Operator: `[Manual]` instalacja zipowa na Windows raportuje tę samą rewizję co pobrany zip — Operator action: na CAVE odpal `irm <url> | iex`, po instalacji porównaj `Get-Content data\version.json` z nazwą rozpakowanego katalogu (`claude-cron-<sha>`) oraz z wynikiem `Get-RefSha`; wymaga niezablokowanego limitu `api.github.com` (60/h dla anonimowych).

---

## Faza 2 — Granica repo ↔ vault

### U4 — `PULS_HOME` ustawia instalator, nie człowiek *(R4, nakład L, zależności: brak — musi poprzedzać U5)*

- [x] Modyfikuj `setup.mjs` — `PULS_HOME` do sekcji `env` w `{workspace}/.claude/settings.json` (idempotentny merge obok wpisu hooka, `:176` / `:1064`)
- [x] Modyfikuj `setup.mjs` — zapis wskaźnika `~/.claude-cron-home` z **faktycznym** katalogiem instalacji
- [x] Modyfikuj `setup.test.mjs`
- [x] Modyfikuj `<vault>/.claude/skills/deleguj/scripts/env.mjs` — kolejność: `INBOX_ENV_FILE` → `$PULS_HOME/data/inbox.env` → **`~/.claude-cron-home` → `<ścieżka>/data/inbox.env`** → walk-up `.env` (legacy)
- [x] Modyfikuj `<vault>/.claude/skills/deleguj/scripts/env.mjs` — komunikat błędu **przestaje** sugerować wpisanie sekretu do `.env` w vaulcie; wskazuje re-run instalatora
- [x] Modyfikuj `<vault>/.claude/skills/deleguj/SKILL.md` — opis nowej kolejności szukania
- [x] Test: merge `env.PULS_HOME` do pustego `settings.json` → klucz dodany
- [x] Test: merge do `settings.json` z istniejącym `env` i wpisem hooka → oba zachowane
- [x] Test: re-run z tą samą wartością → brak zmiany pliku (idempotencja)
- [x] Test: uszkodzony `settings.json` → fail-fast, plik **nietknięty**
- [x] Test: wskaźnik zapisany z niedomyślnym katalogiem instalacji
- [x] Test: loader w vaulcie — brak `PULS_HOME`, obecny wskaźnik → sekret znaleziony
- [x] Test: loader — brak obu → komunikat **bez** sugestii zapisu do `.env` vaulta
- [x] Weryfikacja: `node --test setup.test.mjs` przechodzi — 124/124 pass
- [x] Weryfikacja: `npm test` przechodzi w całości — 854/854 pass
- [x] Weryfikacja: `grep -rn "\.env" <vault>/.claude/skills/deleguj/scripts/env.mjs` — brak komunikatu namawiającego do zapisu sekretu w vaulcie

---

### U5 — `close` archiwizuje wątek, jedna kopia kodu w repo *(R2, nakład L, zależności: **U4**)*

- [x] Stwórz `scripts/inbox/close.mjs` (przeniesienie z vaulta, import `appendToArchive`)
- [x] Stwórz `scripts/inbox/close.test.mjs`
- [x] Modyfikuj `scripts/inbox/inbox-push.mjs` — eksport `appendToArchive` (zachowanie bez zmian, zmienia się widoczność)
- [x] Modyfikuj `scripts/inbox/inbox-push.test.mjs`
- [x] Modyfikuj `<vault>/.claude/skills/deleguj/SKILL.md` — wywołanie `node $PULS_HOME/scripts/inbox/close.mjs` + **guard na brak `PULS_HOME`** (czytelny komunikat zamiast `MODULE_NOT_FOUND`)
- [ ] Usuń `<vault>/.claude/skills/deleguj/scripts/close.mjs` — **dopiero po zielonym T8**
- [x] Test: `close` na otwartym wątku → hub dostaje `done` **i** nitka trafia do pliku miesiąca
- [x] Test: `close` powtórzony → `closed: 0`, **archiwum bez drugiego wpisu**
- [x] Test: `close` na wątku bez wiadomości do mnie → czytelna nota, zero zapisu
- [x] Test: pad zapisu archiwum → błąd widoczny w wyjściu, nie ciche `exit 0`
- [x] Weryfikacja: `node --test scripts/inbox/close.test.mjs` przechodzi — 6/6 pass
- [x] Weryfikacja: `npm test` przechodzi w całości — 854/854 pass
- [x] Weryfikacja: `grep -n "export.*function appendToArchive" scripts/inbox/inbox-push.mjs` zwraca trafienie (`inbox-push.mjs:97`)

**Operator checklist:**
- [ ] **Retest T8** wg szablonu — z warunkiem 3 (nitka w archiwum)
- [ ] Usunięcie kopii `close.mjs` z vaulta po zielonym T8
- [ ] Zdjęcie ostrzeżenia „domykać wyłącznie checkboxami" ze `STATUS.md`

---

## Do poprawy po review fazy 2

- [x] 🟠 [P2] **scripts/inbox/close.mjs:69** — `close` domyka KAŻDĄ nie-`done` wiadomość do mnie akcją `Zapoznane`, w tym `task` zdelegowany przez drugą osobę; `markDone` dla `Zapoznane` robi `UPDATE inbox SET status='done'` bez reply (`lib/inbox-db.js:365`), a widok „Delegowane" nadawcy filtruje `i.status != 'done'` (`lib/inbox-db.js:301-318`) → zadanie znika z listy delegującego bez wiadomości zwrotnej (komentarz `close.mjs:11` twierdzi odwrotnie). Akcja: dla `type === 'task'` użyć akcji `Zrobione` (albo odmówić domknięcia taska komendą `close`) + test z atrapą huba odwzorowującą `delegated`.
- [x] 🟠 [P2] **scripts/inbox/close.mjs:79** — kolejność „najpierw domknij w hubie, potem zapisz archiwum" czyni pad zapisu nieodwracalnym: pętla `client.done` (`:68-72`) przechodzi, `appendToArchive` (`:79`) rzuca → wątek zniknął ze Skrzynki, archiwum puste, a ponowny `close` leci ścieżką `mine.length === 0` i zwraca `{closed:0, archived:false}`. Test `close.test.mjs:429` utrwala tę stratę jako poprawną. Akcja: zbuduj snapshot nitki z `threadRows` (`pull()` już je zwraca) i zapisz archiwum przed pętlą albo w `catch` wokół zapisu; znika też N+1 round-tripów z powtarzanym payloadem `thread`.
- [x] 🟠 [P2] **scripts/inbox/close.mjs:243** — nowa ścieżka `close` woła repo-owy `env-loader.loadEnv()`, który twardo wymaga `CLAUDE_CRON_WORKSPACE` (`requireWorkspace`), a `persistPulsHome()` wpisuje do `settings.json` wyłącznie `PULS_HOME` (`setup.mjs:580-602`); guard w `SKILL.md:57` też sprawdza tylko `PULS_HOME`. Proces bez zmiennej z RC przechodzi guard i wywala się komunikatem „Ustaw INBOX_TODO_PATH w .env" — tą samą sugestią, którą U4 celowo usunął. Akcja: mergeować też `CLAUDE_CRON_WORKSPACE`, albo wyprowadzić `INBOX_ARCHIVE_DIR` bez `requireWorkspace` z własnym komunikatem.
- [x] 🟠 [P2] **setup.mjs:1333** — `persistPulsHome()` woła `registerPulsHomeEnv()` bez try/catch, więc uszkodzony `{workspace}/.claude/settings.json` ubija CAŁY setup (także u usera, który autostartu nie chce), i to PRZED `writePulsHomePointer` — user traci oba mechanizmy lokalizacji instalacji. Kod przeczy własnemu komentarzowi („Pad zapisu = warn, nigdy przerwanie setupu"). Akcja: najpierw `writePulsHomePointer`, potem `registerPulsHomeEnv` w try/catch → `[warn]`.
- [x] 🟠 [P2] **scripts/install-vps.sh:1086** — oba kontrakty `PULS_HOME` (`env.PULS_HOME` w `settings.json` + wskaźnik `~/.claude-cron-home`) pisze wyłącznie `setup.mjs`, którego ścieżka VPS nie uruchamia; na maszynie z rolą `agent` żaden wskaźnik nie powstaje, więc `node "$PULS_HOME/scripts/inbox/close.mjs"` trafia w guard „brak PULS_HOME" (R4 spełnione tylko na laptopie). Akcja: w finale `install-vps.sh` (obok `data/inbox.env` i roli, jako user `claude`) zapisać wskaźnik `~/.claude-cron-home`.
- [x] 🟠 [P2] **scripts/inbox/close.test.mjs:372** — brak testu boundary „wątek z WIELOMA moimi wiadomościami" (wszystkie case'y używają `fakeHub([row()])`). Nietestowane: (a) `done` dla każdej mojej wiadomości i sumowanie `closed`, (b) „Archiwum RAZ na wątek" (komentarz `close.mjs:271`) — regresja przenosząca `appendToArchive` do pętli przechodzi cały suite. Akcja: case z dwoma wierszami `to_user:'kacper'` w jednym `thread_id` → `hub.calls.done.length === 2`, `out.closed === 2`, tytuł wątku w pliku miesiąca dokładnie raz.
- [x] 🟠 [P2] **`<vault>/.claude/skills/deleguj/scripts/env.mjs`** — loader sekretu skilla `deleguj` wraz z 4 testami (`env.test.mjs`) został zmieniony i pozostawiony POZA repo, więc `npm test` go nie obejmuje, a to on rozstrzyga skąd wczytywany jest `INBOX_TOKEN`; nie da się też zweryfikować, czy sprawdza ISTNIENIE `$PULS_HOME/data/inbox.env` przed zaakceptowaniem wartości (`settings.json` bywa synchronizowany z obcą ścieżką). Akcja: przenieść loader do `scripts/inbox/` obok `env-loader.mjs`, a skill w vaulcie niech importuje go przez `$PULS_HOME` — tak jak robi to teraz z `close.mjs`.
- [ ] 🟡 [P3] **scripts/inbox/close.mjs:41** — `--thread-id` bez walidacji kształtu (`--thread-id --foo` da `'--foo'`, literówka w UUID daje mylącą notę „Brak otwartych wiadomości do mnie"); reszta systemu waliduje (`inbox-push.mjs:45`, hub `MAX_ID_LEN`). Akcja: guard `/^[a-f0-9-]{36}$/` + jeden test.
- [ ] 🟡 [P3] **scripts/inbox/close.mjs:95** — defensywa bez scenariusza: `catch` w `isDirectRun` próbuje `pathToFileURL` po padzie `realpathSync` (bliźniaczy `migrate-pg-to-hub.mjs:170` ma `return false`), a `threadRows = []` (`:47`) jest zbędne — `pull()` weryfikuje `v:1` i zawsze zwraca `threadRows`. Akcja: `catch { return false; }` oraz `const { user, threadRows } = await client.pull();`.
- [ ] 🟡 [P3] **scripts/inbox/close.mjs:279** — gdy hub odrzuci wszystkie kandydatury (`skipped`/`not_found`), wyjście `{thread_id, closed:0, archived:false}` nie ma pola `note` → skill raportuje „nic się nie stało" bez powodu, nieodróżnialnie od realnego błędu. Akcja: gdy `mine.length > 0` a `closed === 0`, dołóż `note` z liczbą odrzuconych i wynikami huba.
- [ ] 🟡 [P3] **scripts/inbox/inbox-push.mjs:468** — współdzielony kod archiwum (`archivePath`, `renderArchiveThread`, `appendToArchive`) mieszka w entry-poincie script-joba; `close.mjs` importuje go ciągnąc guard entry-pointa i importy klienta. Akcja: wydziel `scripts/inbox/inbox-archive.mjs` (+ `inbox-archive.test.mjs`), oba moduły niech importują stamtąd.
- [ ] 🟡 [P3] **setup.mjs:1104** — dwa mechanizmy na jeden cel (`env.PULS_HOME` w `settings.json` ~45 linii + 5 testów vs wskaźnik `~/.claude-cron-home`, który jest nadzbiorem) — ścieżka `settings.json` nie odblokowuje żadnego przypadku, a dokłada fail-fast na cudzym pliku. **Wymaga decyzji autora planu** (oba zapisy są jawnie w checkliście U4). Akcja (jeśli plan da się skorygować): zostaw sam `writePulsHomePointer`, usuń `mergeEnvIntoSettings`/`registerPulsHomeEnv` i 4 testy.
- [ ] 🟡 [P3] **scripts/inbox/close.test.mjs:358** — `withEnv()` nadpisuje globalne `INBOX_ENV_FILE`/`INBOX_TODO_PATH`/`INBOX_SKRZYNKA_PATH`/`INBOX_ARCHIVE_DIR` i nigdy ich nie przywraca; kolejne testy dziedziczą wartości z poprzedniego case'u. Akcja: snapshot czterech kluczy w `withEnv` i przywrócenie w `t.after(...)`.
- [ ] 🟡 [P3] **setup.test.mjs:284** — test wskaźnika porównuje treść po `.trim()`, więc nie przybija FORMATU, który parsuje czytelnik spoza repo (`env.mjs` w vaulcie); rozszerzenie wskaźnika o drugą linię przejdzie zielono, a skill `deleguj` cicho przestanie działać po re-instalacji. Akcja: `assert.equal(fs.readFileSync(pointer,'utf-8'), installDir + '\n')`.

---

## Operator checklist faza 2

- [ ] Operator: wskaźnik `~/.claude-cron-home` nie istnieje na tej maszynie (`ls ~/.claude-cron-home` → brak), bo `persistPulsHome` biegnie dopiero przy uruchomieniu `setup.mjs`, a instalator po fazie 2 nie był odpalony — `PULS_HOME` jest wyłącznie w `<vault>/.claude/settings.json`, więc drugi tor R4 (procesy spoza sesji Claude Code) pozostaje nieczynny — Operator action: odpal interaktywnie `node setup.mjs` w katalogu instalacji, potem `cat ~/.claude-cron-home` i porównaj z faktyczną ścieżką instalacji; weryfikacja niewykonalna headless.
- [ ] Operator: stara kopia `<vault>/.claude/skills/deleguj/scripts/close.mjs` (mtime 28.07) wciąż jest tą, którą realnie widzi vault, jeśli `PULS_HOME` nie jest ustawione — ścieżka U4+U5 pozostaje niezweryfikowana end-to-end — Operator action: po re-runie instalatora wykonaj **retest T8** wg szablonu z warunkiem 3 („nitka w archiwum"), a dopiero po zielonym T8 usuń kopię `close.mjs` z vaulta.
- [ ] Operator: notka o walidacji w `naprawy-team-os-kontekst.md:100` mówi „853 pass / 1 fail (flake `lib/ask.test.js`)", a przy tym review `npm test` daje **854/854 pass, exit 0** — flake nie reprodukuje się — Operator action: popraw notkę w kontekście na aktualny wynik (checkboxy `Weryfikacja: npm test` w U4/U5 zostały już odznaczone w bookkeepingu tego review).

---

## Faza 3 — Format Skrzynki i archiwum

### U6 — Frontmatter Skrzynki domergowuje się przy każdym pull *(R12, nakład M, zależności: brak)*

- [x] Modyfikuj `scripts/inbox/inbox-pull.mjs` — merge brakujących kluczy z `SKRZYNKA_TEMPLATE:197` (`cssclasses`, `tags`) bez ruszania wartości już obecnych
- [x] Modyfikuj `scripts/inbox/inbox-pull.test.mjs`
- [x] Test: plik bez `cssclasses` → po pullu ma `cssclasses: [skrzynka]`
- [x] Test: plik z własnym kluczem w frontmatterze → klucz przetrwał
- [x] Test: plik z `cssclasses` o innej wartości → wartość **nie jest** nadpisana
- [x] Test: plik bez frontmattera → dostaje pełny blok z szablonu
- [x] Test: roundtrip push↔pull dalej przechodzi (regresja kontraktu markerów)
- [x] Weryfikacja: `node --test scripts/inbox/inbox-pull.test.mjs` przechodzi — 13/13 pass
- [x] Weryfikacja: `npm test` przechodzi w całości — 895/895 pass

---

### U7 — Archiwum bez duplikatów: marker + podmiana bloku *(R8, nakład M, zależności: U5)*

- [x] Modyfikuj `scripts/inbox/inbox-push.mjs` — `renderArchiveThread:74` emituje marker `%% thread:<id> %%` (**dziś go nie ma** — marker żyje wyłącznie w renderze Skrzynki)
- [x] Modyfikuj `scripts/inbox/inbox-push.mjs` — `appendToArchive:94`: wczytaj plik miesiąca, znajdź blok po `thread_id`, **podmień** jeśli jest, dopisz jeśli nie ma
- [x] Modyfikuj `scripts/inbox/inbox-push.test.mjs`
- [x] Test: pierwszy zapis wątku → jeden blok z markerem
- [x] Test: drugi zapis tego samego wątku (więcej wiadomości) → **dalej jeden blok**, treść nowsza
- [x] Test: drugi wątek → dwa niezależne bloki, kolejność zachowana
- [x] Test: plik z blokiem bez markera (sprzed zmiany) → nowy zapis dokłada blok, stary nietknięty
- [x] Test: plik miesiąca nie istnieje → tworzony z nagłówkiem, jak dziś
- [x] Weryfikacja: `node --test scripts/inbox/inbox-push.test.mjs` przechodzi — 11/11 pass
- [x] Weryfikacja: `npm test` przechodzi w całości — 895/895 pass

**Operator checklist:**
- [ ] Jednorazowe usunięcie istniejących duplikatów z `Zasoby/inbox-archive/2026-08.md`

---

### U8 — Job „Puls — kontrola spójności" + `/onboard --refresh-theme` *(R13, R15, nakład L, zależności: U1, U6)*

- [x] Stwórz `scripts/consistency-check.mjs` — dwie kontrole w jednym jobie: wersja kodu (z U1) i zgodność snippetu CSS z szablonem w pluginie
- [x] Stwórz `scripts/consistency-check.test.mjs`
- [x] Modyfikuj `lib/starter-jobs.js` / `templates/starter-jobs.json` — seed joba (`routine=1`, wzór z `lib/inbox-seed.js`: nigdy `updateJob`)
- [x] Implementuj wystawianie zadania: **komenda naprawcza w treści**, `termin:` w frontmatterze, rozpoznawanie „już wisi" po **ukrytym znaczniku**, nie po tytule
- [ ] Modyfikuj `<aibiz-plugin>/plugins/aibiz/skills/onboard/SKILL.md` — tryb `--refresh-theme` (kopiuje snippety + włącza w Fragmentach CSS + dopisuje `cssclasses`) — **przeniesione do U12 (Faza 5)**: ten sam plik pluginu zespołowego modyfikuje U12, a scope U8 zakazuje dotykania pluginu. Nazwa trybu jest już stałą `THEME_FIX_COMMAND` w `scripts/consistency-check.mjs` i trafia do treści zadania.
- [x] Test: snippet zgodny i wersja aktualna → **brak zadania**
- [x] Test: snippet rozjechany → jedno zadanie, w treści komenda naprawcza, w frontmatterze `termin:`
- [x] Test: drugi przebieg przy niezmienionym rozjeździe → **brak drugiego zadania**
- [x] Test: zmieniony tytuł istniejącego zadania → rozpoznane po znaczniku, brak duplikatu
- [x] Test: rozjazd naprawiony → kolejny przebieg nie tworzy nic nowego
- [x] Test: brak szablonu w pluginie (Puls bez pluginu) → job kończy się cicho, bez błędu
- [x] Weryfikacja: `node --test scripts/consistency-check.test.mjs` przechodzi — 17/17 pass
- [x] Weryfikacja: `npm test` przechodzi w całości — 895/895 pass

**Operator checklist:**
- [ ] **Test T14** wg szablonu (rozjazd → jedno zadanie → drugi przebieg bez duplikatu)
- [ ] **Test T13** wg szablonu (frontmatter, wspólnie z U6)
- [ ] Dopisanie „Obsidian zaktualizowany do najnowszej wersji" jako kroku onboardingu (R15)

---

## Do poprawy po review fazy 3

- [x] 🔴 [P1] **scripts/inbox/inbox-push.mjs:120** — marker wątku matchowany SUBSTRINGIEM (`line.startsWith('>') && line.includes(marker)`) na treści renderowanej DOSŁOWNIE z niezaufanej wiadomości innego członka (`renderArchiveThread:92-93`). Wiadomość z linią `%% thread:<cudzy-uuid> %%` trafia do archiwum, a przy domknięciu tamtego wątku `replaceArchiveThreadBlock` podmienia CAŁY obcy blok — zarchiwizowana nitka osoby trzeciej znika bezpowrotnie. Fix: escapować `%%` w renderowanej treści ORAZ matchować marker przez równość całej linii (`line.trim() === '> ' + marker`) + test z cudzym markerem w treści.
- [x] 🟠 [P2] **scripts/consistency-check.mjs:31** — job seedowany z `enabled: 1` (`templates/starter-jobs.json:43`) codziennie wystawia zadanie z komendą `/onboard --refresh-theme`, która NIE ISTNIEJE (tryb przeniesiony do U12/Faza 5; grep po zainstalowanym pluginie: zero trafień). User dostaje „naprawa to jedna komenda", komenda nie działa → zadanie zamykane bez naprawy. Fix: `"enabled": 0` w szablonie do czasu U12 albo `THEME_FIX_COMMAND` z krokami ręcznymi.
- [x] 🟠 [P2] **scripts/consistency-check.mjs:314** — entry-point guard używa `realpathSync(new URL(import.meta.url).pathname)` zamiast `fileURLToPath` (learned-pattern + wzorzec 4 pozostałych entry-pointów repo). `URL.pathname` jest percent-encoded (katalog instalacji = wolne wejście usera) i daje `/C:/...` na Windowsie → `realpathSync` rzuca, `main()` nie startuje, job kończy się kodem 0 i Puls raportuje sukces przy niewykonanej kontroli. Fix: `fileURLToPath` po obu stronach.
- [ ] 🟡 [P3] **scripts/consistency-check.mjs:607** — brak szablonu motywu ⇒ early return `no_template` PRZED `detectDrifts`, więc kontrola wersji nigdy nie biegnie bez pluginu (VPS, świeża instalacja); test `consistency-check.test.mjs:876` betonuje regresję. Fix: drift wersji liczony zawsze.
- [ ] 🟡 [P3] **lib/starter-jobs.test.js:80** — osłabienie asercji (anty-pattern #2): z pętli usunięto `assert.equal(job.telegram_notify, 0)` i `assert.equal(job.job_type, 'claude')`, żeby przeszedł nowy script-job. Fix: asercje warunkowo dla jobów ≠ „Puls — kontrola spójności".
- [ ] 🟡 [P3] **scripts/inbox/inbox-push.mjs:124** — granice bloku po ciągłości `>` bez zatrzymania na `> [!`: usunięcie pustej linii między wpisami ⇒ podmiana wchłania sąsiedni callout.
- [ ] 🟡 [P3] **scripts/inbox/inbox-push.mjs:107** — `threadIdOf(thread) === null` daje literalny `> %% thread:null %%`, którego `replaceArchiveThreadBlock` nigdy nie trafi → bloki mnożą się przy każdym domknięciu.
- [ ] 🟡 [P3] **scripts/inbox/inbox-push.mjs:159** — read-modify-write całego pliku miesiąca (dawniej atomowy `appendFile`) przy drugim pisarzu (`close.mjs`) i Obsidian Sync = lost update. Fix: porównanie ze snapshotem tuż przed zapisem (lub tmp+rename) + test sąsiadujących bloków.
- [ ] 🟡 [P3] **scripts/consistency-check.mjs:89** — `formatDate` liczy `termin` w UTC (`toISOString`), vault liczy dobę lokalnie → run po lokalnej północy wpada do „Zaległych". Fix: `toLocaleDateString('sv-SE')` + test.
- [ ] 🟡 [P3] **scripts/consistency-check.mjs:394** — `DASHBOARD_RELATIVE` na sztywno zamiast rezolucji przez `INBOX_TODO_PATH` (env-loader) → na vaultcie sprzed zmiany nazwy wpis do Dashboardu cicho nie powstaje.
- [ ] 🟡 [P3] **scripts/consistency-check.mjs:169** — parametr `override` z `process.env.PULS_THEME_TEMPLATE`: konfiguracja bez konsumenta (zero użyć w repo, testy ją wyłączają) wymuszająca odczyt pliku jako sondę istnienia. Usuń.
- [ ] 🟡 [P3] **scripts/consistency-check.mjs:171** — szablon czytany dwa razy na przebieg + pełne odczyty jako sondy istnienia (187, 197, `freeTaskPath:232` do 100 plików). Fix: `fs.access`, `resolveThemeTemplate` zwraca `{path, content}`.
- [ ] 🟡 [P3] **scripts/consistency-check.mjs:64** — `{ id, opis, komenda }` łamie konwencję §7 (angielskie identyfikatory, polskie komentarze). Fix: `description`/`command`.
- [ ] 🟡 [P3] **scripts/consistency-check.mjs:484** — `dashboardEntryLine` i `VERSION_FIX_COMMAND` eksportowane bez konsumentów. Zdejmij `export`.
- [ ] 🟡 [P3] **scripts/inbox/inbox-pull.mjs:938** — `splitTopLevelEntries` obsługuje kontynuacje pod scenariusz, którego nie ma; uprość do dwóch przebiegów po liniach (−~10 LOC).
- [ ] 🟡 [P3] **lib/starter-jobs.js:44** — `command` rozwijany do ścieżki ABSOLUTNEJ w momencie seedu i zamrażany w DB (seed nigdy nie robi UPDATE); po przeniesieniu instalacji job pada codziennie. Fix: względny w DB, rozwijanie w `lib/executor.js:433` + test.
- [ ] 🟡 [P3] **lib/starter-jobs.js:44** — parametr `repoRoot` w `loadStarterJobDefs` bez żadnego wywołującego. Usuń.
- [ ] 🟡 [P3] **setup.mjs:1366** — pytanie instalatora nie wymienia „kontroli spójności", a „T" seeduje job piszący do vaulta (`Zadania/w_trakcie/`, `Dashboard.md`). Dopisz do treści pytania.
- [ ] 🟡 [P3] **scripts/inbox/inbox-push.test.mjs:82** — brak testu na wrogi input (`content` z `%% thread:<inny-id> %%`) — bezpośrednie pokrycie P1.
- [ ] 🟡 [P3] **scripts/inbox/inbox-pull.test.mjs:130** — bez pokrycia guard niedomkniętego frontmattera (`inbox-pull.mjs:254`) i gałąź kontynuacji `splitTopLevelEntries` (`:236`), mimo deklaracji w nocie fazy. Dołóż 2 asercje.
- [ ] 🟡 [P3] **scripts/consistency-check.test.mjs:774** — brak testu `runConsistencyCheck` dla `version-unknown` przy zgodnym snippecie (jedyny drift realny na świeżej maszynie) → `task_created` + treść z `VERSION_FIX_COMMAND`.
- [ ] 🟡 [P3] **scripts/consistency-check.test.mjs:809** — brak testu I/O „brak pliku Dashboard.md" (`consistency-check.mjs:287`); `makeWorkspace` zawsze tworzy plik. Dodaj opcję `dashboard: null`.
- [ ] 🟡 [P3] **scripts/consistency-check.test.mjs:894** — brak testu na uszkodzony `installed_plugins.json` (gałąź `console.error` + `return null`, `consistency-check.mjs:182`).
- [ ] 🟡 [P3] **scripts/consistency-check.test.mjs:818** — brak testu na oba rozjazdy naraz (theme-drift + version-unknown → jedno zadanie z obiema komendami).

## Operator checklist faza 3

- [ ] Operator: job „Puls — kontrola spójności" powstaje wyłącznie przez seed w `setup.mjs` (idempotencja po `name`), więc na maszynach już zainstalowanych nie pojawi się sam; na VPS starter-jobs nie są seedowane w ogóle. Dodatkowo `data/version.json` nie istnieje w tej instalacji (repo dev), więc kontrola raportuje `version-unknown` — Operator action: odpal `node setup.mjs` w katalogu instalacji i odpowiedz „T" na pytanie o taski startowe, potem sprawdź job na dashboardzie i wykonaj **Test T14** (rozjazd → jedno zadanie → drugi przebieg bez duplikatu); weryfikacja przebiegu o 09:00 niewykonalna headless.
- [ ] Operator: snippet `<vault>/.obsidian/snippets/skrzynka.css` jest NOWSZY niż szablon w zainstalowanym pluginie (`~/.claude/plugins/cache/aibiz/aibiz/32a789438618/skills/onboard/templates/skrzynka.css`) — vault ma poprawki, których szablon nie ma (ukryty `inline-title`, `border-top: none` dla AnuPpuccin, centrowanie ptaszka, `font-size: 11px`); detekcja jest bezkierunkowa, więc pierwszy przebieg wystawi zadanie „napraw motyw", a przyszła naprawa nadpisze vault starszym CSS-em — Operator action: przenieś aktualny CSS z vaulta do `skills/onboard/templates/skrzynka.css` w repo pluginu zespołowego, zacommituj i zaktualizuj plugin PRZED włączeniem joba kontroli spójności.

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
