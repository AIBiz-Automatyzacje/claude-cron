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
- [ ] Weryfikacja: `node --test setup.test.mjs` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości
- [ ] Weryfikacja: `grep -rn "\.env" <vault>/.claude/skills/deleguj/scripts/env.mjs` — brak komunikatu namawiającego do zapisu sekretu w vaulcie

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
