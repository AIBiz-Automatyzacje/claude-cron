# Team OS — onboarding członka w instalatorach — zadania

Branch: `feature/team-os-onboarding-instalatory` (odbity z `main` po `024653f`)
Ostatnia aktualizacja: 2026-07-26 (review fazy 1 — gate **BLOKUJE**: 1 × P1, 3 × P2; raport `review-faza-1.md`, sekcja „Do poprawy po review fazy 1")

> **Uwaga o `Delegate to:`** — tabela doboru subagentów w `/dev-plan` zakłada stack React/Supabase.
> Ten projekt to czysty Node (CommonJS + ESM), bash i vanilla JS bez buildu, więc **wszystkie IU trafiają
> do `feature-builder-data`** jako najbliższego warstwie logiki/backendu. Z jego frontmatera materialnie
> stosuje się wyłącznie `security`; `supabase-dev-guidelines` i `sentry-integration` nie mają tu zastosowania
> (brak Supabase i Sentry w projekcie) — wymienione dla zgodności z konwencją planu.

> **Brak `.env.e2e`** — projekt nie ma harnessu E2E, a instalator VPS z natury wymaga świeżego serwera.
> Scenariusze wymagające realnej maszyny są w `Operator checklist`, nie w `Weryfikacja:`.

## Faza 0 — przygotowanie

- [x] Branch roboczy `feature/team-os-onboarding-instalatory` odbity z `main` (po `024653f`)
- [x] Dokumentacja zadania zacommitowana na branchu roboczym
- [x] Przed startem IU-1.1: w drzewie roboczym siedzą niezacommitowane zmiany maszynerii `.claude/` (sync szablonu) + `.gitignore` — rozstrzygnąć (commit osobno albo stash), żeby diff fazy 1 był czysty — rozstrzygnięte commitem `55cbb0e` (sync maszynerii osobno), diff fazy 1 czysty

## Faza 1 — Rdzeń współdzielony + rola maszyny (M) — ✅ ukończona

### IU-1.1 `scripts/inbox/invite.mjs` — wspólny rdzeń + guard `.gitignore` (M) — ✅ completed

**Zrealizowane:** `scripts/inbox/invite.mjs` (192 linie) + `scripts/inbox/invite.test.mjs` (26 testów: parse, upsert, `writeInboxEnv`, `planGitignoreFix`, `ensureEnvIgnored` na żywym repo, `probeInviteCode` na lokalnym fake-hubie). `setup.mjs` skrócony o 94 linie — importuje rdzeń i re-eksportuje `parseInviteCode`/`upsertDotenvLine`.

**Odchylenia od planu:**
- `INVITE_CODE_PREFIX` **przestał być eksportem `setup.mjs`** (właścicielem jest `invite.mjs`). Plan wymieniał re-eksport tylko `parseInviteCode` i `upsertDotenvLine`; grep potwierdził zero konsumentów — `server.js` ma własną stałą CommonJS (`server.js:59`), `setup.test.mjs` go nie importuje.
- Scenariusz „reguła negacji → po dopisaniu wzorca nadal nie ignorowany" **rozbity na dwa testy**. Samą negacją nie da się dojść do ścieżki ponownej weryfikacji: dopisany na końcu `.env*` zawsze wygrywa z wcześniejszym `!.env` (w `.gitignore` wygrywa ostatnia pasująca reguła). Negację pokrywa test „wzorzec obecny + `!.env` → `unfixable` bez duplikatu"; ścieżkę zapis → ponowna weryfikacja → `unfixable` pokrywa test z `.env` dodanym do indeksu (`git add -f`). Zachowanie kodu zgodne z planem — różnica dotyczy konstrukcji testu.
- Guard sonduje **dwie** ścieżki (`.env` oraz `.env.bak.x`) zamiast samego `.env` — wymóg scenariusza z planu: samo `.env` w `.gitignore` przepuściłoby wariant z sufiksem niosący ten sam token (dokładnie mechanizm incydentu z 25/26.07).
- Testy guardu ustawiają `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` na pusty plik (przywracane w `t.after`) — globalny `core.excludesFile` użytkownika ignorujący `.env` dawałby fałszywy `ok`.
- Zero nowych zależności npm.

**Cel:** jedno źródło prawdy dla kodu zaproszenia (parse → probe → zapis) plus guard chroniący przed zapisem tokenu do repo, używalne zarówno przez `setup.mjs`, jak i przez CLI instalatora VPS.

**Wymagania:** R6, R8

**Zależności:** brak

**Pliki:**
- Stwórz: `scripts/inbox/invite.mjs`
- Stwórz: `scripts/inbox/invite.test.mjs`
- Modyfikuj: `setup.mjs` (import + re-eksport `parseInviteCode`, `upsertDotenvLine`; usunięcie przeniesionych definicji)

**Delegate to:** feature-builder-data

**Skills in play:** security (materialnie); supabase-dev-guidelines, sentry-integration — bez zastosowania w tym projekcie

**Podejście:**
- Przenieś bez zmiany zachowania: `INVITE_CODE_PREFIX`, `parseInviteCode`, `upsertDotenvLine`, `writeInboxEnv`, `probeInviteCode`. `setup.mjs` re-eksportuje `parseInviteCode` i `upsertDotenvLine`, żeby istniejące importy w `setup.test.mjs` nie ucierpiały.
- Guard `.gitignore` rozbity na dwie warstwy: **czysta funkcja** decydująca o treści do dopisania na podstawie stanu (`czy repo`, `czy ignorowany`) oraz **cienka skorupa I/O** wołająca `git check-ignore` i zapisująca plik.
- Rozstrzygaj na **exit-code** `git check-ignore -q`, nigdy na treści stdout. Brak gita / workspace poza repo → wynik `not_a_repo` (guard przepuszcza — nie ma czego opublikować).
- Po dopisaniu wzorca `.env*` do `<workspace>/.gitignore` **zapytaj gita ponownie**. Dopiero druga odpowiedź decyduje o wyniku `fixed` vs `unfixable`.
- Kontrakt zwrotu guardu: rozłączne warianty (`ok` | `not_a_repo` | `fixed` | `unfixable`), nie boolean — wołający musi rozróżnić „naprawiono" (loguj) od „nie da się" (pomiń zapis).

**Wzorce do naśladowania:**
- `scripts/inbox/env-loader.mjs` — wspólny moduł wyciągnięty, by zabić drift między skryptami
- `setup.mjs:881-898` `probeInviteCode` — nigdy nie rzuca, zwraca `{ok, reason}` (wzorzec `notify-push`)
- `lib/notify-push.js` — kontrakt `{ok, reason}` dla operacji, która nie może wywrócić wołającego

**Scenariusze testowe:**
- [Unit] `parseInviteCode` po przeniesieniu zachowuje zachowanie: happy path, trim, zły prefiks, brak `#`, pusty token, URL nie-http → wyniki identyczne jak przed ekstrakcją
- [Unit] Guard: workspace nie jest repo gitowym → `not_a_repo`, plik `.gitignore` nietknięty
- [Unit] Guard: repo z wzorcem `.env*` → `ok`, zero zapisów do `.gitignore`
- [Unit] Guard: repo z samym `.env` w `.gitignore` → wykrywa, że `.env.bak.x` **nie** jest ignorowany, dopisuje `.env*`, ponowna weryfikacja daje `fixed`
- [Unit] Guard: repo bez `.gitignore` → tworzy plik z wzorcem, wynik `fixed`
- [Unit] Guard: repo z regułą negacji wymuszającą śledzenie `.env` → po dopisaniu wzorca nadal nie ignorowany → `unfixable`
- [Unit] Guard nie duplikuje wzorca przy ponownym wywołaniu (idempotencja)
- [Unit] `writeInboxEnv` upsertuje `INBOX_HUB_URL`/`INBOX_TOKEN` nie ruszając pozostałych kluczy w `.env`

**Weryfikacja:**
- [x] `node --test scripts/inbox/invite.test.mjs` przechodzi bez błędów — ✅ review fazy 1: exit 0, `# tests 28 / # pass 28 / # fail 0`
- [x] `node --test setup.test.mjs` przechodzi bez błędów (dowód, że ekstrakcja nie zepsuła istniejących importów) — ✅ review fazy 1: exit 0, `# tests 71 / # pass 71 / # fail 0`
- [x] `npm test` zielone (pełna suita) — ✅ review fazy 1: exit 0, `# tests 533 / # pass 533 / # fail 0`

---

### IU-1.2 `lib/inbox-seed.js` — rola maszyny steruje seedem (S) — ✅ completed

**Zrealizowane:** `ROLE_STATE_KEY = 'inbox_role'` czytany przez `db.getState`; `agent` → wyłącznie auto-reply z `enabled: 1`, `client`/brak flagi → wyłącznie sync. Komentarz nad `assistantJobDef` sprostowany. Testy rozszerzone o role, idempotencję obu wariantów i dowód R9 (job wyłączony ręcznie zostaje wyłączony po ponownym seedzie, cron nietknięty).

**Odchylenia od planu:**
- **Dotknięto `server.js`** (poza listą „Pliki:" w IU) — 3 linie: mapa `SEEDED_JOB_NAMES` + odczyt statusu w logu startowym. Po rozszerzeniu statusu stary warunek `result === 'seeded'` nigdy nie byłby prawdziwy i log startowy cicho by zniknął, a IU wymaga, żeby logi mówiły prawdę o stanie faktycznym. Zero zmian logiki.
- Status zwracany zmieniony ze stringów `'seeded'|'exists'|'not_configured'` na sufiksowane `'seeded:sync'|'exists:sync'|'seeded:auto-reply'|'exists:auto-reply'|'not_configured'` — świadomie string zamiast obiektu, bo jedynym konsumentem jest `server.js`.
- Zero nowych zależności npm.

**Cel:** `inbox-seed` tworzy joby zgodnie z rolą maszyny: laptop dostaje sync, VPS dostaje auto-reply od razu włączony, a auto-reply nie pojawia się tam, gdzie nie ma sensu.

**Wymagania:** R4, R5, R7, R9

**Zależności:** brak (równoległe do IU-1.1)

**Pliki:**
- Modyfikuj: `lib/inbox-seed.js`
- Modyfikuj: `lib/inbox-seed.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** security (materialnie); supabase-dev-guidelines, sentry-integration — bez zastosowania w tym projekcie

**Podejście:**
- Klucz `state`: `inbox_role`, wartości `client` | `agent`. Odczyt przez `db.getState` (nie przez env — flaga ma przeżyć restart i nie zależeć od powłoki).
- `agent` → seeduj wyłącznie auto-reply z `enabled: 1`. `client` **lub brak flagi** → seeduj wyłącznie sync. Brak flagi = zachowanie dzisiejsze dla instalacji konfigurowanych ręcznie (chroni przed „cichą śmiercią Skrzynki").
- **Nie ruszaj** kontraktu „tylko `createJob` gdy brak, nigdy `UPDATE`" — to on sprawia, że ręczne wyłączenia jobów przeżywają restart daemona.
- Zachowaj snapshot+restore `process.env` wokół `loadEnv` (script-joby dziedziczą env daemona; mutacja zamroziłaby konfigurację `INBOX_*` na moment startu).
- Zaktualizuj komentarz nad `assistantJobDef` — dziś dokumentuje odwróconą decyzję („Seedowany WYŁĄCZONY — świadoma decyzja per maszyna"). Nowe uzasadnienie: powstaje tylko na maszynie-agencie, od razu włączony, bo pytanie w instalatorze zastąpiło ręczne klikanie.
- Rozszerz zwracany status o rozróżnienie tego, co faktycznie zaseedowano (dziś `'seeded' | 'exists' | 'not_configured'`) — logi startowe mają mówić prawdę o stanie faktycznym.

**Wzorce do naśladowania:**
- `lib/inbox-seed.js` — istniejąca struktura (nigdy nie rzuca, snapshot env, idempotencja po `name`)
- `lib/db.js:369-374` — `getState`/`setState`

**Scenariusze testowe:**
- [Unit] Rola `agent` → powstaje auto-reply z `enabled === 1`, sync **nie** powstaje
- [Unit] Rola `client` → powstaje sync, auto-reply **nie** powstaje
- [Unit] Brak flagi → zachowanie jak `client` (sync tak, auto-reply nie)
- [Unit] Skrzynka nieskonfigurowana (`INBOX_HUB_URL`/`INBOX_TOKEN` brak) → `not_configured`, zero jobów niezależnie od flagi
- [Unit] Idempotencja: drugie wywołanie przy istniejącym jobie o tej nazwie nie tworzy duplikatu
- [Unit] Job istnieje i jest **wyłączony ręcznie** → seed go **nie włącza** (dowód R9: brak `UPDATE`)
- [Unit] `loadEnv` mutujący `process.env` → po wywołaniu `process.env` wraca do stanu sprzed seeda

**Weryfikacja:**
- [x] `node --test lib/inbox-seed.test.js` przechodzi bez błędów — ✅ review fazy 1: exit 0, `# tests 8 / # pass 8 / # fail 0`
- [x] `npm test` zielone (pełna suita) — ✅ review fazy 1: exit 0, `# tests 533 / # pass 533 / # fail 0`
- [x] Grep potwierdza brak `updateJob`/`UPDATE` w `lib/inbox-seed.js` (kontrakt R9 nienaruszony) — ✅ review fazy 1: jedyne trafienie to komentarz `lib/inbox-seed.js:84` („NIGDY updateJob"), zero wywołań w kodzie

## Do poprawy po review fazy 1

> Raport: `docs/active/team-os-onboarding-instalatory/review-faza-1.md`. Severity gate: **BLOKUJE** (1 × P1).
> Bookkeeping `Weryfikacja:` fazy 1: CLI 5 PASS / 0 FAIL, Grep 1 PASS / 0 FAIL — zero dodatkowych findingów.

### P1 — blokujące

- [x] 🔴 [P1] **scripts/inbox/invite.mjs:51** — wstrzyknięcie dowolnych zmiennych do `.env` z kodu zaproszenia (brak walidacji kształtu + brak escapowania). `parseInviteCode` zwraca SUROWY `hubUrl` (nie `parsedUrl.href`), a WHATWG `URL` po cichu usuwa CR/LF/TAB przy parsowaniu — string z newline'em przechodzi walidację protokołu i trafia nietknięty do `upsertDotenvLine`, który skleja `KEY="<wartość>"` bez escapowania. Token nie jest walidowany w ogóle (hub emituje `randomBytes(32).toString('hex')`, więc `/^[0-9a-f]{64}$/` byłoby dokładne). ZWERYFIKOWANE uruchomieniem modułu: `parseInviteCode('puls-inbox:https://hub.example#tok\nNODE_OPTIONS=--require /tmp/evil.js')` → `writeInboxEnv` produkuje plik z osobną linią `NODE_OPTIONS=…`; wariant po stronie URL daje `hubUrl` z newline. `env-loader.mjs` wpisuje to do `process.env` skryptów skrzynki, a te przekazują env do spawnu `claude` → wykonanie dowolnego kodu z uprawnieniami daemona. FIX: zwracać `parsedUrl.href`/`origin`, walidować charset tokenu, a `upsertDotenvLine` ma odrzucać wartości z `"`, CR, LF i znakami sterującymi (fail-closed). **NAPRAWIONE** (fix po review): dziedzina wartości walidowana SPRZED `new URL` (`isSafeEnvValue` — biały znak, `"`, `\`, znaki sterujące), charset tokenu (`^[A-Za-z0-9._~-]+$`), `upsertDotenvLine` fail-closed + replacer funkcyjny. Zweryfikowane uruchomieniem modułu: oba warianty wstrzyknięcia (token i URL z newline) → `null`.

### P2 — poważne

- [x] 🟠 [P2] **scripts/inbox/invite.mjs:79** — `writeInboxEnv` zapisuje sekret (`INBOX_TOKEN`) plikiem o domyślnych uprawnieniach; ZWERYFIKOWANE: nowo utworzony `.env` ma tryb 0644 (world-readable). Brak `{ mode: 0o600 }` przy tworzeniu i brak `chmodSync` dla pliku już istniejącego. To JEDYNA ścieżka zapisu tokenu dla obu instalatorów, a faza powstała po to, by domknąć incydent wycieku z 25/26.07. Token to CAŁA tożsamość w hubie (`/inbox/v1/:token/*`) — pozwala czytać cudze wątki, domykać zadania i podszywać się pod ofiarę. **NAPRAWIONE**: `writeFileSync(..., { mode: 0o600 })` + `chmodSync` (mode działa tylko przy tworzeniu). Zweryfikowane: nowy `.env` = 0600, istniejący 0644 zawężony do 0600; test w suicie.
- [x] 🟠 [P2] **scripts/inbox/invite.mjs:139** — guard `.gitignore` fail-OPEN na sygnale niejednoznacznym: `queryGitignoreState` traktuje `result.error` (brak binarki gita, ENOENT/EACCES) ORAZ `status === 128` jako `isRepo:false` → `not_a_repo` → sekret zapisywany po cichu. 128 to generyczny kod fatalny gita, a brak gita nie znaczy, że katalog nie jest repo — vault bywa commitowany z DRUGIEJ maszyny (topologia tego zadania: laptop + VPS). Sprzeczne z doktryną modułu i z learned-patterns 2026-07-03 / 2026-07-24. FIX: odróżnić „git niedostępny/błąd" od „poza repo" (`git rev-parse --git-dir` albo obecność `.git` w górę drzewa) i przy nierozstrzygalności blokować zapis. **NAPRAWIONE**: `git rev-parse --git-dir` rozdziela „brak gita/błąd" (`isRepo:'unknown'` → fail-closed, wołający pomija zapis) od „poza repo" (fraza ze stderr przy `LC_ALL=C`); nierozstrzygalny wynik sondy `check-ignore` też daje `unknown`. Test z pustym `PATH` potwierdza `unknown` bez mutacji `.gitignore`.
- [x] 🟠 [P2] **scripts/inbox/invite.test.mjs:76** — suita nazywa siebie „siatka bezpieczeństwa ekstrakcji", ale nie ma ANI JEDNEGO przypadku wrogiego wejścia. Brakuje: (a) tokenu/URL-a z CR/LF (wektor P1 wyżej), (b) wartości z `"` i znakami sterującymi, (c) wartości ze wzorcem `$&` (rozwijanie w `String.replace`), (d) asercji uprawnień utworzonego `.env`, (e) przypadku niedostępnego `git check-ignore` (fail-open guardu). Zielone 533/533 nie jest dowodem bezpieczeństwa modułu, mimo że IU-1.1 deklaruje skill „security (materialnie)". **NAPRAWIONE**: 16 nowych testów wrogiego wejścia (CR/LF w tokenie i URL-u, `"`/`\`/znaki sterujące, spacja, wzorzec `$&` przy podmianie, brak wycieku wartości do komunikatu błędu, klucz spoza dziedziny, tryb 0600 nowego i istniejącego `.env`, fail-closed `writeInboxEnv` bez zapisu, `git` niedostępny → `unknown`). Suita: 44/44.

### P3 — opcjonalne (pełne opisy w raporcie)

- [ ] 🟡 [P3] **scripts/inbox/invite.mjs:161** — `unfixable` zostawia zapisany `.gitignore` z dopisanym wzorcem i nie informuje o tym wołającego; brak rollbacku do stanu sprzed próby.
- [ ] 🟡 [P3] **setup.mjs:836** — `probe.reason` drukowany dosłownie; część trybów awarii undici osadza pełny URL (z tokenem w ścieżce) w komunikacie → token w logu instalacji.
- [ ] 🟡 [P3] **setup.mjs:841** — guard nie jest wpięty w `askInboxInvite` (R6 niespełnione lokalnie; plan przypisuje wpięcie do IU-2.3). Konstrukcja „guard obok zapisu" pozwala kolejnym miejscom zapisu o nim zapomnieć — `writeInboxEnv` powinien sam odmawiać zapisu przy `unfixable`.
- [ ] 🟡 [P3] **lib/inbox-seed.js:86** — `getAllJobs()` materializuje pełną kolekcję, by sprawdzić istnienie jednej nazwy; właściwe `SELECT 1 FROM jobs WHERE name = ?` (reguła 12).
- [ ] 🟡 [P3] **scripts/inbox/invite.mjs:133** — brak wczesnego wyjścia z sond `spawnSync` (do 4 procesów gita na wywołanie guardu) + zbędne `encoding: 'utf-8'` przy nieczytanym stdout.
- [ ] 🟡 [P3] **scripts/inbox/invite.mjs:136** — `spawnSync` bez `timeout`: git na nieodpowiadającym montażu zawiesza instalator bez komunikatu.
- [x] 🟡 [P3] **scripts/inbox/invite.test.mjs:207** — gałąź `result.error` w `queryGitignoreState` bez testu (wykonalna headless przez pusty `PATH`). **NAPRAWIONE przy okazji P2/TEST**: test `ensureEnvIgnored` z pustym `PATH` (gałąź `result.error`).
- [ ] 🟡 [P3] **lib/inbox-seed.js:19** — `ROLE_AGENT` prywatny, porównanie strict equality; pisarz z IU-2.1 zapisze literał na ślepo. Eksportuj `ROLE_AGENT`/`ROLE_CLIENT` (lub `isValidRole`) zanim powstanie pisarz.
- [ ] 🟡 [P3] **server.js:709** — wiedza „status → nazwa joba" wyciekła z `inbox-seed.js` do mapy `SEEDED_JOB_NAMES`; czystszy kontrakt to zwrot `{ status, jobName }`.
- [ ] 🟡 [P3] **setup.mjs:34** — komentarz twierdzi „publiczna powierzchnia bez zmian", a `INVITE_CODE_PREFIX` przestał być eksportem; dopisz, że to celowe.
- [ ] 🟡 [P3] **server.js:59** — zgodność `INVITE_CODE_PREFIX` hub ↔ konsument trzyma się wyłącznie na komentarzu; brak testu szwu mimo deklarowanego R8.
- [ ] 🟡 [P3] **scripts/inbox/invite.mjs:83** — moduł łączy dwie domeny (rdzeń kodu zaproszenia + guard higieny sekretów, ~85 linii i zależność od gita); guard prosi się o osobny `gitignore-guard.mjs`.
- [ ] 🟡 [P3] **lib/inbox-seed.js:81** — odczyt `db.getState(ROLE_STATE_KEY)` poza blokiem `try`, a `server.js:714` woła seed bez `.catch()` → wyjątek z DB przy starcie ubija daemona; komentarz stracił frazę „Nigdy nie rzuca".
- [ ] 🟡 [P3] **lib/inbox-seed.js:81** — brak walidacji wartości roli: każda wartość ≠ `'agent'` (np. `'Agent'`, `'agent\n'`) cicho degraduje maszynę do `client`, bez sygnału w logu.
- [ ] 🟡 [P3] **scripts/inbox/invite.mjs:104** — defensive optional chaining w `planGitignoreFix` na scenariusz, który nie może wystąpić (anty-pattern #10).
- [ ] 🟡 [P3] **scripts/inbox/invite.mjs:79** — nieatomowy read-modify-write `.env` przy czytelniku co minutę (cron sync) → okno na niekompletny plik; `renameSync` z pliku tymczasowego.
- [ ] 🟡 [P3] **setup.test.mjs:504** — 11 testów to kopia 1:1 z `invite.test.mjs`; jedyny powód istnienia re-eksportu w `setup.mjs:36`. Usunięcie kopii + re-eksportu nie traci pokrycia.
- [ ] 🟡 [P3] **lib/inbox-seed.test.js:106** — testowana tylko połowa kontraktu snapshot/restore `process.env` (brak wariantu „klucz był ustawiony wcześniej").
- [ ] 🟡 [P3] **scripts/inbox/invite.test.mjs:311** — gałąź restore poprzedniej wartości `INBOX_*` w `probeInviteCode` bez asercji.
- [ ] 🟡 [P3] **scripts/inbox/invite.test.mjs:291** — brak testu huba NIEOSIĄGALNEGO (ECONNREFUSED/timeout/DNS) — najczęstszy realny pad onboardingu, inna ścieżka niż v-mismatch (retry w `inbox-client`).
- [ ] 🟡 [P3] **server.js:710** — mapa `SEEDED_JOB_NAMES` bez testu spójności ze zbiorem statusów `seeded:*`.
- [ ] 🟡 [P3] **scripts/inbox/invite.test.mjs:209** — brak wariantu „vault jako podkatalog repo" (reguła `.env*` w `.gitignore` rodzica).
- [ ] 🟡 [P3] **docs/active/team-os-onboarding-instalatory/team-os-onboarding-instalatory-zadania.md:25** — bookkeeping podaje „26 testów" (powtórzone w `-plan.md:110`, `-kontekst.md:12` i `:96`), a `invite.test.mjs` ma 28 (potwierdzone przebiegiem `# tests 28`); „192 linie" `invite.mjs` vs faktyczne 191.

## Operator checklist faza 1

- [ ] Operator: guard działa wyłącznie na NOWYCH zapisach przez `invite.mjs` — nie dotyka maszyn już skonfigurowanych (produkcyjny VPS „kacper" + laptop), gdzie `.env` z `INBOX_TOKEN` powstał przed guardem, w trybie 0644 i bez weryfikacji `git check-ignore`; incydent 25/26.07 dotyczył wariantu `.env.bak`. Bez tego kroku faza 1 zostaje uznana za domykającą incydent, a produkcyjny vault dalej trzyma aktywny token w repo / na 0644, a token z wycieku nigdy nie zostaje odwołany — Operator action: na KAŻDEJ istniejącej instalacji uruchomić `git -C <workspace> check-ignore -q -- .env` oraz `... -- .env.bak.x`, sprawdzić historię (`git log --all -- '.env*'`), ustawić `chmod 600 <workspace>/.env`, a dla tokenów, które mogły wyciec — rotacja przez `revokeMember` + nowy kod zaproszenia.
- [ ] Operator: ustawienie `inbox_role='agent'` na VPS-ie, który przed tą zmianą dostał zaseedowany i WŁĄCZONY job sync, da OBA joby aktywne naraz (seed nie robi `UPDATE` — R9, słusznie) — czyli dwie maszyny synchronizujące Skrzynkę, przed czym chroni R5. Checklist zadania nie ma kroku weryfikacyjnego ani odpowiadającej asercji w Operator checklist IU-2.2 — Operator action: po ustawieniu roli na każdej istniejącej maszynie wypisać joby Team OS (`GET /api/jobs`), ręcznie WYŁĄCZYĆ job niepasujący do roli (na `agent` — „Team OS — inbox sync"; na `client` — „Team OS — asystent auto-reply") i potwierdzić stan po restarcie daemona.
- [ ] Operator: skutek ustawienia `inbox_role` na ISTNIEJĄCYCH maszynach jest niesprawdzalny headless — wymaga realnego laptopa i produkcyjnego VPS-a; test jednostkowy nie zastąpi odczytu stanu produkcyjnej bazy — Operator action: na laptopie ustawić `inbox_role='client'`, na VPS-ie `'agent'`, zrestartować daemony, po restarcie potwierdzić w dashboardzie/API, że laptop ma wyłącznie job sync (włączony), a VPS wyłącznie auto-reply (włączony), i że żaden job nie został włączony wbrew wcześniejszej ręcznej decyzji.

## Faza 2 — Instalatory (L)

### IU-2.1 `scripts/inbox/onboard.mjs` — CLI dla instalatora VPS (S)

**Cel:** most bash → Node, dzięki któremu instalator VPS konfiguruje skrzynkę bez ani jednej linii logiki domenowej w shellu.

**Wymagania:** R1, R7, R8

**Zależności:** IU-1.1, IU-1.2

**Pliki:**
- Stwórz: `scripts/inbox/onboard.mjs`
- Stwórz: `scripts/inbox/onboard.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** security (materialnie); supabase-dev-guidelines, sentry-integration — bez zastosowania w tym projekcie

**Podejście:**
- Wejście: kod zaproszenia + rola + workspace. Wyjście: **kod wyjścia** jako kontrakt maszynowy + jedna linia tekstu dla człowieka. Bash rozstrzyga na kodzie, nigdy nie parsuje komunikatu.
- Rozłączne kody wyjścia dla: sukces, zły format kodu, hub nieosiągalny / zła wersja, `.gitignore` nienaprawialny. Bash na tej podstawie dobiera komunikat i decyduje, czy restartować serwis.
- Kolejność: parse (czysto) → probe (waliduje zanim dotkniemy plików) → guard `.gitignore` → zapis `.env` → `setState('inbox_role', …)`. Guard **przed** zapisem, bo po zapisie sekret już leży w katalogu.
- Rola zapisywana **tylko po** udanym zapisie `.env` — inaczej seed utworzyłby auto-reply dla maszyny bez konfiguracji, a job failowałby co minutę.
- Logika w czystych funkcjach + cienka skorupa `main()` (konwencja projektu); entry-point guard przez `fs.realpathSync` po obu stronach (macOS symlinkuje `/tmp` → `/private/tmp` — udokumentowana pułapka).
- Dostęp ESM → CommonJS (`lib/db.js`) przez `createRequire` — ustalony precedens w tej warstwie: `scripts/inbox/auto-reply.mjs:18-21` (`require('../../lib/claude-spawn')`) oraz `setup.mjs:27` (`require('./lib/db')`).
- Nie loguj tokenu ani pełnego kodu zaproszenia (zawiera token) — komunikaty operują na nazwie użytkownika zwróconej przez probe.

**Wzorce do naśladowania:**
- `scripts/inbox/inbox-sync.mjs` — entry point skryptu z `main()` i entry-point guardem
- `lib/notify-push.js` — kontrakt „nigdy nie rzucaj, zwróć powód"
- `scripts/inbox/env-loader.mjs` — czytanie konfiguracji w momencie wywołania

**Scenariusze testowe:**
- [Unit] Poprawny kod + osiągalny hub (probe zastubowany) → zapis `.env`, ustawiona rola, kod wyjścia sukcesu
- [Unit] Zły format kodu → dedykowany kod wyjścia, **zero** zapisów do `.env` i `state`
- [Unit] Probe nieudany (timeout / zła wersja) → dedykowany kod wyjścia, zero zapisów
- [Unit] Guard `.gitignore` zwraca `unfixable` → dedykowany kod wyjścia, **token nie zapisany** (fail-closed)
- [Unit] Rola `agent` vs `client` → w `state` ląduje dokładnie przekazana wartość
- [Unit] Komunikaty wyjściowe nie zawierają tokenu ani kodu zaproszenia
- [Unit] Powtórne wywołanie z tym samym kodem → idempotentne (upsert nie duplikuje linii w `.env`)

**Weryfikacja:**
- `node --test scripts/inbox/onboard.test.mjs` przechodzi bez błędów
- `npm test` zielone (pełna suita)
- Grep potwierdza brak logowania `INBOX_TOKEN`/kodu zaproszenia w `scripts/inbox/onboard.mjs`

---

### IU-2.2 `install-vps.sh` — ścieżka członka, autokonfiguracja admina, pytanie o auto-reply (L)

**Cel:** po odpowiedzi „nie" na pytanie o hub instalator prowadzi członka do działającej skrzynki; admin dostaje swoją maszynę skonfigurowaną bez ponownego wklejania kodu.

**Wymagania:** R1, R2, R3, R4

**Zależności:** IU-2.1

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh`
- Modyfikuj: `scripts/install-vps.test.sh`

**Delegate to:** feature-builder-data

**Skills in play:** security (materialnie); supabase-dev-guidelines, sentry-integration — bez zastosowania w tym projekcie

**Podejście:**
- Nowa funkcja `setup_team_os_member` obok istniejącej `setup_team_os_hub` (bez przepisywania tej drugiej — jej testy zostają nietknięte). `main()` woła ścieżkę członka tylko wtedy, gdy ścieżka admina nie skonfigurowała tej maszyny.
- Wszystkie pytania przez istniejący `ask_tty` — gołe `read` dostaje EOF pod `curl|bash` (udokumentowana pułapka).
- Pytanie o kod zaproszenia z **pustą odpowiedzią = pomiń** (R2), spójnie z `setup.mjs`.
- Pytanie o auto-reply na **obu** ścieżkach VPS (admin i członek) → przekazywana rola `agent`; przy odmowie rola `client`.
- Ścieżka admina: po utworzeniu członka-admina użyj `TEAM_OS_INVITE_CODE` do konfiguracji tej maszyny — kod jest już w zmiennej, ponowne pytanie byłoby absurdem.
- Kod zaproszenia przekazywany do CLI przez argument z `%q` (zawiera `:`, `//`, `#`).
- Po udanym zapisie **restart serwisu**, a po nim potwierdzenie stanu faktycznego (wzorzec `team_os_wait_for_server`) — env nie propaguje się do żyjących procesów, a „zrestartowałem" ≠ „wstał".
- Cała strefa to opcjonalny krok finału: każdy pad = `warn` + kontynuacja, **nigdy** `trap ERR` (odwinięcie rollbackiem zweryfikowanej instalacji byłoby gorsze niż brak skrzynki).
- Rozważ (jeśli nie rozdmucha komponentu): ostrzeżenie, gdy vault na VPS wygląda na pusty — auto-reply bez wiedzy zwróci `NO_ANSWER`.

**Wzorce do naśladowania:**
- `scripts/install-vps.sh:1497-1562` `setup_team_os_hub` — struktura komponentu, rozstrzyganie na kodzie HTTP, idempotencja, warn zamiast fail
- `scripts/install-vps.sh:189` `ask_tty` — pytania odporne na `curl|bash`
- `scripts/install-vps.test.sh` — harness lib-only + sandbox + rejestrator wywołań

**Scenariusze testowe:**
- [Unit] Odpowiedź „N" na hub → wołana jest ścieżka członka (dowód R3: temat skrzynki się nie kończy)
- [Unit] Ścieżka członka, pusta odpowiedź na kod → zero wywołań CLI, instalacja kontynuowana (R2)
- [Unit] Poprawny kod + zgoda na auto-reply → CLI wołane z rolą `agent`, potem restart serwisu
- [Unit] Poprawny kod + odmowa auto-reply → CLI wołane z rolą `client`
- [Unit] Kod ze znakami specjalnymi (`#`, `:`, `//`) → dociera do CLI bez zniekształcenia (cytowanie `%q`)
- [Unit] CLI zwraca kod „zły format" → warn z instrukcją, **brak** restartu serwisu, instalacja kontynuowana
- [Unit] CLI zwraca kod „gitignore nienaprawialny" → warn z konkretną instrukcją naprawy, instalacja kontynuowana
- [Unit] Ścieżka admina → maszyna konfigurowana świeżym `TEAM_OS_INVITE_CODE`, bez ponownego pytania o kod
- [Unit] `--only-puls` → cała strefa Team OS pomijana (spójnie z dzisiejszym `setup_team_os_hub`)
- [Unit] Pad CLI nie wywraca instalatora (brak `trap ERR` w tej strefie)

**Weryfikacja:**
- `bash scripts/install-vps.test.sh` przechodzi (0 FAIL), licznik testów wzrósł względem stanu sprzed zmiany
- `npm test` zielone (pełna suita)
- Grep potwierdza brak gołego `read ` w nowej funkcji (wszystkie pytania przez `ask_tty`)

**Operator checklist:**
- [ ] Na świeżym VPS-ie: pełna instalacja, odpowiedź „N" na hub, wklejenie kodu zaproszenia → skrzynka działa bez dotykania `.env`
- [ ] Zgoda na auto-reply → po restarcie job „Team OS — asystent auto-reply" istnieje i jest włączony, joba sync **nie ma**
- [ ] Odmowa auto-reply → job auto-reply nie powstaje
- [ ] Instalacja admina (odpowiedź „t") → maszyna admina skonfigurowana jako klient bez ponownego wklejania kodu

---

### IU-2.3 `setup.mjs` — guard `.gitignore` lokalnie + rola `client` (S)

**Cel:** lokalny onboarding nie zapisuje tokenu do katalogu, który go opublikuje, i oznacza maszynę jako `client`.

**Wymagania:** R5, R6

**Zależności:** IU-1.1, IU-1.2

**Pliki:**
- Modyfikuj: `setup.mjs`
- Modyfikuj: `setup.test.mjs`

**Delegate to:** feature-builder-data

**Skills in play:** security (materialnie); supabase-dev-guidelines, sentry-integration — bez zastosowania w tym projekcie

**Podejście:**
- W `askInboxInvite` wstaw guard **między probe a zapisem**: parse → probe → guard → zapis → rola → hint restartu. Probe pierwszy, bo waliduje kod bez dotykania plików; guard tuż przed zapisem, bo dotyczy właśnie zapisu.
- Wynik `unfixable` → **pomiń zapis**, wypisz konkretną instrukcję (dopisz `.env*` do `.gitignore` i uruchom setup ponownie) i kontynuuj setup. Nigdy nie przerywaj instalacji.
- Wynik `fixed` → poinformuj, że `.gitignore` został uzupełniony (użytkownik ma wiedzieć, że jego repo zmieniło się w wyniku instalacji).
- Po udanym zapisie ustaw `state.inbox_role = 'client'`. Uwaga: `setup.mjs` działa lokalnie na tej samej bazie co daemon — użyj tej samej ścieżki DB co reszta projektu.
- Zachowaj kontrakt „nigdy nie przerywa setupu" — cała ta ścieżka to warn + pominięcie.

**Wzorce do naśladowania:**
- `setup.mjs:904-930` `askInboxInvite` — istniejąca sekwencja i styl komunikatów
- `lib/notify-push.js` — warn przy padzie, nigdy fail setupu

**Scenariusze testowe:**
- [Unit] Guard `ok` → zapis `.env` wykonany, rola `client` ustawiona
- [Unit] Guard `fixed` → zapis wykonany, komunikat informuje o zmianie w `.gitignore`
- [Unit] Guard `unfixable` → **brak** zapisu `.env`, **brak** ustawionej roli, czytelna instrukcja, setup kontynuowany
- [Unit] Pusty kod zaproszenia → pominięcie bez wołania guardu (nie dotykamy `.gitignore` osoby, która nie używa skrzynki)
- [Unit] Probe nieudany → brak zapisu i brak wołania guardu (walidacja przed skutkami ubocznymi)
- [Unit] Zły format kodu → warn, setup kontynuowany (zachowanie dzisiejsze nienaruszone)

**Weryfikacja:**
- `node --test setup.test.mjs` przechodzi bez błędów
- `npm test` zielone (pełna suita)

## Faza 3 — Dokumentacja (S)

### IU-3.1 Aktualizacja `CLAUDE.md` (S)

**Cel:** dokumentacja opisuje stan faktyczny — rolę maszyny, docelową topologię i guard zapisu sekretów.

**Wymagania:** R4, R5, R6

**Zależności:** IU-2.2, IU-2.3

**Pliki:**
- Modyfikuj: `CLAUDE.md`

**Delegate to:** feature-builder-data

**Skills in play:** security (materialnie); supabase-dev-guidelines, sentry-integration — bez zastosowania w tym projekcie

**Podejście:**
- Sekcja Team OS: flaga `inbox_role` (`client` | `agent`), brak flagi = zachowanie `client`.
- Docelowa topologia z uzasadnieniem: sync na maszynie człowieka (rozproszony *lost update* pod Obsidian Sync gubi `[x] Zrobione`), auto-reply na maszynie 24/7 (czyta z huba przez `claimQuery`, nie z pliku).
- Ścieżka członka w instalatorze VPS + fakt, że odpowiedź „t" stawia **własny hub** (dwie skrzynki, jeśli ktoś się pomyli).
- Guard `.gitignore` jako część kontraktu zapisu sekretów: wzorzec `.env*`, weryfikacja przez `git check-ignore`, fail-closed przy `unfixable`.
- **Sprostuj** dotychczasowy zapis „asystent auto-reply seedowany WYŁĄCZONY".

**Scenariusze testowe:**
- [Manual] Czytelnik CLAUDE.md potrafi odpowiedzieć, gdzie trafia sync, gdzie auto-reply i dlaczego

**Weryfikacja:**
- Grep w `CLAUDE.md` potwierdza obecność `inbox_role` oraz brak nieaktualnego zdania o auto-reply seedowanym wyłączonym
- `npm test` zielone (pełna suita)

## Weryfikacja końcowa zadania

- [ ] `npm test` — pełna suita zielona
- [ ] `bash scripts/install-vps.test.sh` — 0 FAIL
- [ ] Grep: definicje jobów wyłącznie w `lib/inbox-seed.js`, zero duplikacji w `scripts/install-vps.sh` (R7)
- [ ] Grep: brak logowania tokenu / kodu zaproszenia w nowych plikach

## Operator checklist (poza automatyzacją)

- [ ] Test end-to-end na maszynie „Cave": VPS (instalacja → „N" na hub → kod zaproszenia → auto-reply „tak") oraz laptop (setup.mjs → kod zaproszenia → sync)
- [ ] Weryfikacja, że na laptopie **nie ma** joba auto-reply, a na VPS-ie **nie ma** joba sync
- [ ] Wymiana wiadomości Cave ↔ kacper przez hub (wysłanie, odpowiedź, odhaczenie, archiwum)
- [ ] Ustawienie `inbox_role` na **istniejących** maszynach operatora (laptop → `client`, produkcyjny VPS → `agent`) — jednorazowo, świadomie poza kodem (backfill w `migrate()` clobberowałby ręczne decyzje)
- [ ] Sprawdzenie, że guard `.gitignore` zadziałał na realnym vaultcie (repo z Obsidian Sync + automatyczny „vault backup")
