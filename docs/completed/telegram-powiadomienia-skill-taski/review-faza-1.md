# Review fazy 1 — fundament powiadomień (Unit 1: notify-format, Unit 2: notify-config/notify-push/endpointy)

Data: 2026-07-03
Zakres: `lib/notify-format.js(+test)`, `lib/notify-config.js(+test)`, `lib/notify-push.js(+test)`, `lib/config.js`, `lib/discord.js`, `server.js` (3 route'y)
Findings po adversarial verify, zdedupowane (29 surowych → 18 unikalnych; duplikaty scalone z zachowaniem wszystkich perspektyw).

## Statystyki

- 🔴 P1 (blocking): **0**
- 🟠 P2 (important): **2** (1 KOD, 1 TEST)
- 🟡 P3 (nit): **16** (14 KOD, 1 TEST, 1 odnotowanie bez akcji)
- 👤 OPERATOR: **0**
- 🌐 E2E: **5 passed / 0 failed / 0 skipped** (odroczone curl E2E Unit 2 wykonane w tym review — sekcja "Weryfikacja E2E")
- Testy: `npm test` 202/202 PASS; `node --test lib/notify-format.test.js` 10/10 PASS

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 2 problemy P2 do naprawy.**

---

## 🟠 P2 (important)

### P2-1 [KOD] `lib/notify-push.js:38` — `new URL()` poza `try` łamie kontrakt "NIGDY nie rzuca"

Udokumentowany kontrakt modułu: "NIGDY nie rzuca — zawsze `{ok, reason?}`". Tymczasem `new URL(SETTINGS_PATH, vpsUrl)` stoi PRZED blokiem `try`. `CLAUDE_CRON_VPS_URL` bez protokołu (np. `srv1362522.hstgr.cloud:7777` albo `localhost:7777`) rzuca `TypeError: Invalid URL` (potwierdzone repro w node). Skutki:

- `POST /api/settings/notifications/push-to-vps` kończy się generycznym 500 "Internal server error" (top-level catch w server.js) zamiast czytelnego reason 503/502;
- przyszły konsument `setup.mjs` (Unit 6) dostanie goły wyjątek.

**Fix:** guard/try na parsowanie URL → `{ok:false, reason:'invalid_vps_url'}` + test w `notify-push.test.js`.

### P2-2 [TEST] `lib/discord.js:38` — zmienione zachowanie produkcyjne `sendNotification` bez żadnego testu

Rozwiązywanie webhook URL przy każdej wysyłce (`resolveNotifyConfig(db.getState, process.env)` zamiast zamrożenia przy `require`) nie ma testu — `lib/discord.test.js` nie istnieje. Priorytet state>env jest pokryty w `notify-config.test.js`, ale wiring `discord.js → db.getState` nie; regresja (zły getter, zły klucz) przeszłaby niezauważona, bo wysyłka jest fire-and-forget z `.catch(()=>{})`. Plan (Unit 2) też nie zdefiniował scenariusza testowego dla tej modyfikacji — luka i planu, i testów.

**Fix:** minimalny `lib/discord.test.js` (DI/mock `getState`): state ustawiony → wysyłka na URL ze state; state pusty + env → env; oba puste → early return bez sieci.

---

## 🟡 P3 (nit)

### P3-1 [KOD] `lib/notify-config.js:56` — `sanitizeNotifySettings` bez walidacji formatu i długości

Waliduje tylko whitelist kluczy i typ string. `discord_webhook_url` przyjmuje dowolny string (nie musi być `https://discord.com/api/webhooks/...`), `telegram_chat_id` dowolny string, brak limitu długości. Skutki: (a) zapis nie-URL → `new URL()` w `postWebhook` rzuca, a `executor.js:221` połyka błąd `.catch(() => {})` — powiadomienia cicho martwe mimo 200 OK przy zapisie; (b) dowolny host jako webhook = przekierowanie pełnych outputów jobów na obcy endpoint przez każdego z dostępem do API (LAN/tailnet); (c) nielimitowana długość ląduje w state. Reguła projektu: waliduj KAŻDY input na granicy API. **Fix:** walidacja URL (https + host discord.com/discordapp.com lub minimum poprawny URL), format chat_id (`^-?\d+$` lub `^@\w+$`), rozsądny max length. Domyka też wektor stored-XSS zanim Unit 5 wyrenderuje chat_id przez innerHTML.

### P3-2 [KOD] `lib/config.js:71` — martwe eksporty + zdublowane źródło prawdy nazw env-varów *(scalone 3 zgłoszenia)*

`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (i pozostały po refaktorze `DISCORD_WEBHOOK_URL`) nie mają żadnego konsumenta — `discord.js` przestał importować z config, a `notify-config.js` czyta env przez własną mapę `ENV_FALLBACK` (lib/notify-config.js:8-11). Łamie kontrakt z CLAUDE.md ("config.js — jedyne źródło stałych i env-varów"), nazwy env żyją w dwóch miejscach, semantyki sprzeczne (zamrożone przy require vs resolve przy wysyłce). Eksport przewidziany planem (IU-2), prawdopodobnie pod fazę 2 — ale jeśli `telegram.js` pójdzie przez `resolveNotifyConfig` (a powinien), pozostanie martwy. **Do rozstrzygnięcia w fazie 2:** notify-config bierze defaulty env z config.js, albo usunąć martwe eksporty i zaktualizować opis architektury — świadoma decyzja, nie dryf.

### P3-3 [KOD] `lib/notify-push.js:63` — reason w catch to wolny tekst `error_${err.message}` *(scalone 4 zgłoszenia)*

Trzy problemy naraz: (a) surowy `err.message` trafia do reason i server.js zwraca go w body 502 do przeglądarki — wyciek szczegółów błędów sieci warstwy wewnętrznej (potencjalnie wewnętrzny URL VPS/Tailscale); (b) łamie enum-owy charakter unii reason (`'vps_not_configured'|'nothing_to_push'|'endpoint_missing'|'timeout'|'put_failed_*'`), po której server.js i przyszły modal (Faza 3) mapują dokładny string; (c) błąd bez message → `error_undefined`. **Fix:** stały kod `'network_error'` + opcjonalne pole `detail` logowane server-side; korekta testu w `notify-push.test.js` (match `/ECONNREFUSED/`) razem z fixem.

### P3-4 [KOD] `server.js:223` — PUT z malformed JSON → cichy no-op 200 *(scalone 3 zgłoszenia; POTWIERDZONE w E2E S6)*

`parseBody` (server.js:40) przy błędzie parsowania resolve'uje `{}` — nie odróżnia "niepoprawny JSON" od "pusty legalny obiekt", `sanitizeNotifySettings({})` daje `{ok:true, updates:{}}` → 200 z maskami. Klient wysyłający zepsuty JSON myśli, że konfiguracja zapisana. Helper pre-existing (wspólny z POST joba), ale nowy endpoint konfiguracyjny to pierwsze miejsce, gdzie cichy no-op maskuje błąd klienta zapisującego sekrety. Zgłoszone zamiast dismissowania.

### P3-5 [KOD] `lib/notify-config.js:34` — `maskSecret` ujawnia całe krótkie wartości *(scalone 2 zgłoszenia)*

Dla wartości ≤ `MASK_VISIBLE_CHARS` (4) "maska" zawiera cały sekret (`maskSecret('abcd')` → `…abcd`). Realne webhooki/tokeny są dłuższe (ryzyko praktyczne znikome), ale to eksportowany util o nazwie sugerującej gwarancję maskowania. **Nit:** wartość < 8 znaków → sama flaga `configured` bez maski / stały placeholder.

### P3-6 [KOD] `server.js:441` — nasłuch na wszystkich interfejsach, brak walidacji Host (pre-existing)

`listen(PORT)` bez hosta + guard XFF łapie tylko Tailscale Funnel, nie dostęp z LAN ani DNS rebinding z przeglądarki właściciela. Założenie planu "API niedostępne publicznie" prawdziwe tylko dla internetu, nie dla sieci lokalnej. Nowe endpointy sekretów podnoszą stawkę istniejącej luki (PUT pozwala przekierować powiadomienia). **Poza zakresem fazy — decyzja architektoniczna** (bind 127.0.0.1 + adres tailnet, lub walidacja Host), warta osobnego zadania.

### P3-7 [TEST] `server.js:205` — mapowanie reason→status w push-to-vps nieprzetestowane

Ternary `vps_not_configured=503, nothing_to_push=400, reszta=502` to jedyna nieprzetestowana logika warunkowa nowego kodu. Wyciągnięcie do czystej funkcji (np. w notify-push) + test jednostkowy — zgodnie z konwencją "I/O to cienka skorupa". (Ścieżka 503 potwierdzona jednorazowo w E2E S5.)

### P3-8 [KOD] `lib/notify-format.js:12` — `extractResult` parsuje wszystkie linie od początku na pełnym stdout

Wpis `type:'result'` jest ostatnią linią stream-json, a iteracja idzie od początku z `JSON.parse` na każdej linii (w tym duże wpisy assistant). `executor.js:221` przekazuje PEŁNY, nieprzycięty stdout (truncate do `MAX_LOG_SIZE` dotyczy tylko DB) → długi run (MB) = synchroniczne parsowanie całości na event loopie przy każdym zakończeniu joba. **Sugestia:** iterować od końca (typowo 1 parse) albo podawać stdout przycięty.

### P3-9 [KOD] `lib/notify-format.js:40` — off-by-one w `smartSplit`: chunk `maxLen+1`

Gdy `'. '` zaczyna się dokładnie na indeksie `maxLen`, `splitAt` inkrementowany do `maxLen+1`. Potwierdzone: `smartSplit('a'.repeat(10)+'. '+'b'.repeat(20), 10)` → pierwszy chunk 11 znaków. Narusza kontrakt "każdy chunk ≤ maxLen" (test invariantu `notify-format.test.js:98` nie trafia tego przypadku). Skutek: Faza 2 Telegram 4097 znaków → API 400, chunk cicho zgubiony (fire-and-forget); Discord follow-up 2001 → 400. Kod przeniesiony 1:1, ale od teraz to współdzielony kontrakt obu kanałów — **naprawić przed fazą 2**.

### P3-10 [KOD] `lib/notify-format.js:42` — `smartSplit` może zwrócić pusty chunk

`trimEnd()` po podziale na granicy `\n` produkuje `''` pushowane bez guardu (guard `if (remaining)` chroni tylko ostatni fragment). Potwierdzone: `smartSplit('\n'.repeat(30), 10)` → `[""]`. Pusty content do Discord/Telegram → 400 z API. Boundary condition (długie ciągi newline'ów w wyniku agenta) — **naprawić przed fazą 2**.

### P3-11 [KOD] `lib/notify-format.js:18` — brak walidacji typu `entry.result` na granicy systemu

`extractResult` zwraca `entry.result` z `JSON.parse` niezaufanego stdout CLI bez `typeof === 'string'`. Nie-stringowy result (obiekt/liczba) przecieka do `smartSplit` (`text.length` na obiekcie) i `chunks[0].slice` w discord.js — awaria daleko od źródła. **Fix:** `entry.type === 'result' && typeof entry.result === 'string' && entry.result`.

### P3-12 [KOD] `lib/discord.js:93` — `resolveNotifyConfig` rozwiązuje 3 klucze, Discord potrzebuje 1

3× prepare+SELECT przez `db.getState` per wysyłka, 2 zbędne. Narzut marginalny (ścieżka zimna, raz per zakończenie joba) — akceptowalny trade-off za prostotę; ewentualnie wyeksportować `resolveKey` gdy dojdzie kanał Telegram.

### P3-13 [KOD] `server.js:230` — 3× `db.setState` w pętli bez transakcji

Każdy `INSERT OR REPLACE` to osobny commit/fsync; pad w połowie = zapis częściowy. Skala trywialna (max 3 klucze, ręczna akcja z dashboardu) — nit; `BEGIN/COMMIT` gdyby kluczy przybyło.

### P3-14 [KOD] `server.js:206` — drugi format błędu w tym samym API

push-to-vps zwraca `{ok:false, reason}` (502/503/400), reszta `handleApi` (w tym PUT tego samego zasobu) używa `error(res, msg)` → `{error: msg}`. Plan wskazywał "format odpowiedzi błędów jak przy walidacji POST joba". Konsument (modal Fazy 3) obsłuży dwa kształty — ujednolicić albo świadomie udokumentować `{ok, reason}` jako wyjątek.

### P3-15 [KOD] `lib/notify-push.js:10` — `PUSH_TIMEOUT_MS` zduplikowany z literałem w `proxyToVps`

`10_000` vs `timeout: 10000` (server.js:143) — spójność utrzymywana wyłącznie komentarzem. **Nit:** wspólna stała w `lib/config.js` (np. `VPS_REQUEST_TIMEOUT_MS`).

### P3-16 [KOD] `lib/notify-format.js:22` — odnotowanie: odstępstwo od IU-1 "przeniesienie 1:1" (bez akcji)

Kontrakt `extractResult` zmieniony — zwraca `RESULT_FALLBACK` zamiast `''` przy braku wpisu `type:result`; fallback przeniesiony z wołającego. Zachowanie end-to-end Discorda identyczne (zweryfikowane na diffie), decyzja udokumentowana w kontekst.md pkt 11. Ślad w raporcie, bez akcji.

---

## Zgodność ze spec

Oś Spec trzymana osobno od Standards (sekcja 3 skilla):

- **Braki względem IU:** brak — wszystkie pliki z IU-1/IU-2 (Stwórz/Modyfikuj) istnieją, scenariusze testowe planu pokryte (`npm test` 202/202).
- **Scope creep:** brak istotnego.
- **Zaimplementowane błędnie względem litery planu:** P2-1 (kontrakt `{ok, reason}` z IU-2 łamany przy malformed URL), P3-16 (odstępstwo od "1:1" — udokumentowane, zachowanie identyczne). Odchylenie miękkie: P3-2 (eksport z config.js wykonany wg planu, ale pozostał martwy — plan nie wskazał konsumenta).
- **Luka planu:** IU-2 nie zdefiniował scenariusza testowego dla modyfikacji `discord.js` (P2-2) ani formatu błędów push-to-vps względem wzorca "jak przy walidacji POST joba" (P3-14).

---

## Weryfikacja E2E (odroczone curl E2E Unit 2 — wykonane w review)

Środowisko: izolowana kopia repo w scratchpadzie (świeża baza, bez env `CLAUDE_CRON_VPS_URL`/`DISCORD_WEBHOOK_URL`/`TELEGRAM_*`), serwer na porcie 7791 — produkcyjna instancja usera i jej state nietknięte.

| # | Scenariusz | Wynik |
|---|---|---|
| S1 | `GET /api/settings/notifications` na czystym stanie → wyłącznie maski/flagi (`configured:false`, `masked:null`) | ✅ passed (HTTP 200) |
| S2 | `PUT {"discord_webhook_url":"…SECRET9999"}` → 200; GET po zapisie: `configured:true`, `masked:"…9999"`, **pełny sekret nigdy w odpowiedzi** (grep na leak: czysto) | ✅ passed |
| S3 | `PUT {"foo":"bar"}` (nieznany klucz) → `400 {"error":"unknown key: foo"}` | ✅ passed |
| S4 | `PUT {"discord_webhook_url":""}` → klucz wyczyszczony, `configured:false` (fallback env pusty) | ✅ passed |
| S5 | `POST /api/settings/notifications/push-to-vps` bez VPS → `503 {"ok":false,"reason":"vps_not_configured"}` | ✅ passed |

Bonus S6 (repro findingu P3-4): `PUT '{zepsuty json'` → **200 no-op** zamiast 400 — finding potwierdzony na żywym serwerze.

**E2E: 5 passed / 0 failed / 0 skipped.** Zgłoszone findingi E2E "weryfikacja odroczona/niewykonana" (server.js:198/201) — rozstrzygnięte wykonaniem, usunięte z finalnej listy.

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie E2E: 0 (część curl checkboxa Unit 2 wykonana headless w tym review, zaliczona łącznie z CLI)
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `npm test przechodzi; node --test lib/notify-format.test.js zielony` (Unit 1) → PASS (`npm test`: 202/202; `node --test lib/notify-format.test.js`: 10/10, exit 0)
- [x] CLI+E2E: `npm test zielony; curl PUT + curl GET na działającym serwerze zwracają zapisany (zamaskowany) stan` (Unit 2) → PASS (`npm test` 202/202; curl E2E S1–S5 powyżej — zapis, maska, 400 na nieznany klucz, czyszczenie, 503 push bez VPS)

---

## Severity gate (finalny, po bookkeepingu)

Bookkeeping nie dodał nowych P2/P3. Liczniki finalne: **P1: 0 · P2: 2 · P3: 16 · OPERATOR: 0**.

**⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 2 problemy P2 do naprawy** (notify-push kontrakt `{ok,reason}` przy malformed VPS URL; brak testu wiringowego discord→state). Rekomendacja przy fixie: domknąć też P3-9/P3-10 (smartSplit) przed fazą 2 — Telegram odziedziczy oba boundary bugi w chunkingu 4096.
