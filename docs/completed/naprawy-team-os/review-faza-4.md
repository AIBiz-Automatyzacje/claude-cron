# Review fazy 4 — Konfiguracja VPS (U9, U10)

**Zadanie:** naprawy-team-os
**Faza:** 4 — Konfiguracja VPS (U9 — panel: adres w użyciu obok zapisanego + sygnał rozjazdu; U10 — instalator podpowiada zapisany adres VPS)
**Data review:** 2026-08-05
**Severity gate:** ⛔ **BLOKUJE** — 1 problem P1

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi łącznie (KOD/TEST/E2E) | 13 |
| 🔴 P1 (blocking) | 1 |
| 🟠 P2 (important) | 4 |
| 🟡 P3 (nit) | 8 |
| ⚙️ OPERATOR (poza fix, do checklisty) | 2 |
| E2E | passed 0 / failed 0 / skipped 0 |

Rozkład po plikach: `lib/persisted-env.js` 4, `setup.mjs` 3, `server.js` 2, `lib/persisted-env.test.js` 2, `public/style.css` 1, plan (OPERATOR) 1, środowisko (OPERATOR) 1.

---

## 🔴 P1 — blokujące

### 1. `public/style.css:148` — atrybut `hidden` bezskuteczny, ostrzeżenie o rozjeździe wisi zawsze

Element paska ma klasę `.statbar` (`display: flex`, style.css:124), a ostrzeżenie klasę `.stat` (`display: flex`, style.css:137). Reguła autora bije UA-owe `[hidden]{display:none}`, a globalnego override'u w projekcie nie ma — jedyny precedens to jawne `.modal-overlay[hidden] { display: none; }` (style.css:529).

Skutek jest podwójny:
- `box.hidden = true` (`public/app.js:374`) NIE chowa paska → instalacja bez VPS-a widzi na stałe „Puls proxuje do: (brak) / w konfiguracji zapisane: nie udało się odczytać";
- `document.getElementById('vps-addr-warn').hidden = info.mismatch !== true` (`public/app.js:382`) nie chowa ostrzeżenia → „⚠ Rozjazd — zmiana adresu wymaga restartu Pulsa" wisi u KAŻDEGO usera zawsze, także przy `mismatch:false`.

To fałszywy alarm w feature, którego jedynym celem było zaufanie do diagnostyki (R7) — sygnał, który świeci zawsze, przestaje być sygnałem.

**Fix:** dopisać `.vps-addr[hidden], .vps-addr-warn[hidden] { display: none; }` w `public/style.css` (albo przełączyć na klasę `.hidden` z `!important`, style.css:43).

---

## 🟠 P2 — ważne

### 2. `server.js:360` — synchroniczny odczyt utrwalonego env przy każdym żądaniu `/api/status`

`readPersistedEnv('CLAUDE_CRON_VPS_URL')` woła się bez cache przy KAŻDYM żądaniu. Na Windows to `spawnSync('powershell', ...)` (`lib/persisted-env.js:245`) — pełny spawn procesu (~100–400 ms) blokujący jednowątkową pętlę zdarzeń serwera i schedulera. Panel odpytuje co 3 s, więc w normalnej pracy serwer jest regularnie zamrażany: przesuwają się heartbeat, idle-timeouty executora i pętla drain kolejki.

Endpoint nie ma autoryzacji ani rate limitu, a globalne `Access-Control-Allow-Origin: *` (server.js:760) plus brak guardu XFF dla ruchu z przeglądarki oznacza, że DOWOLNA strona odwiedzona przez usera może w pętli robić `fetch('http://localhost:7777/api/status')` → setki spawnów PowerShella na sekundę = pełny DoS schedulera. Na Uniksie ten sam wzorzec daje 2× `readFileSync` RC per żądanie.

**Fix:** buforuj utrwaloną wartość (TTL rzędu 15–30 s albo mtime pliku RC) i/lub czytaj ją asynchronicznie poza ścieżką żądania. Wzorzec „odczyt w czasie wysyłki" z `notify-config.js` dotyczy TANIEGO odczytu ze state DB, nie spawnu procesu — analogia nie przenosi się.

### 3. `lib/persisted-env.js:245` — `spawnSync` PowerShella bez `timeout`

`spawnSync('powershell', ['-NoProfile','-Command', script], { encoding: 'utf-8' })` nie ma opcji `timeout` ani `maxBuffer`. Jeśli PowerShell się zawiesi (skanowanie AV, wysycony host, blokada polityki wykonania czekająca na I/O), `spawnSync` blokuje wątek NA ZAWSZE — cały serwer Pulsa (dashboard, webhooki, `/inbox/v1/*`, kolejka jobów) przestaje odpowiadać, bez żadnego logu. Kontrakt modułu brzmi „nigdy nie rzuca, nieczytelne źródło = null", ale zawieszenie nie jest tym kontraktem objęte.

**Fix:** `timeout: 3000` (+ `killSignal`), traktowanie `result.signal`/`result.error` jak `null`, test „spawn zwraca error/timeout → null".

### 4. `setup.mjs:1394` — stan `kept` nie ustawia zmiennej w bieżącym procesie (regresja klasy R7/R11)

`persistEnvVar` (setup.mjs:849) robi dwie rzeczy naraz i ma to jawnie w komentarzu: „Persystuje zmienną (…) i ustawia ją też w bieżącym procesie (by autostart serwera w TEJ sesji widział wartość)". Gałąź `vpsChoice.action === 'kept'` pomija oba kroki.

Gdy `savedUrl` pochodzi z `readPersistedEnv` (RC/rejestr), a `process.env.CLAUDE_CRON_VPS_URL` w sesji instalatora jest puste (instalacja pod zsh a re-run w bashu, uruchomienie nieinteraktywne, Windows w starym terminalu), instalator wypisuje „[ok] VPS bez zmian: `<adres>`", a serwer startowany/wskrzeszany przez ten sam run setupu dostaje env BEZ adresu → `/api/vps/*` odpowiada 503 „brak env" i panel traci widok VPS. To dokładnie klasa błędu, którą Faza 4 miała zamknąć (`docs/solutions/deployment-issues/2026-07-07-stale-env-vps-url-hook-respawn-serwera.md`).

**Fix:** w gałęzi `kept` ustawić `process.env.CLAUDE_CRON_VPS_URL = vpsChoice.url` (bez zapisu do RC) przed spawnem/restartem serwera.

### 5. `lib/persisted-env.test.js:371` — scenariusze `/api/status` pokryte tylko testem czystej funkcji

Scenariusze IU U9 „[Unit] `/api/status`: wartość z pamięci ≠ zapisana → flaga rozjazdu `true`" i „wartości równe → flaga `false`" są odhaczone w pliku zadań, ale pokrywa je wyłącznie test `describeEnvUsage`. Nic nie sprawdza, że `/api/status` faktycznie wozi pole `vps_url` w tym kształcie — a Weryfikacja IU mówi wprost: „`curl -s localhost:7777/api/status` zwraca oba pola adresu i flagę rozjazdu".

Szew `server.js` ↔ `persisted-env` ↔ `public/app.js` jest niepokryty, mimo że repo ma precedens z tej samej serii zadań: `server.runs.test.js:156` — test na żywym procesie serwera dla analogicznego pola `version` z Fazy 1. Learned pattern projektu mówi to wprost: testy czystych funkcji obu stron przechodzą przy złamanym zachowaniu systemowym (`docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md`).

**Fix:** dopisać w `server.runs.test.js` test `GET /api/status` asertujący obecność `vps_url` z kluczami `in_use`/`persisted`/`mismatch`.

---

## 🟡 P3 — drobne

1. **`server.js:360`** — `vps_url` (adres węzła tailnetu ORAZ wartość z prywatnego `~/.zshrc`/rejestru) trafia do odpowiedzi serwowanej z globalnym `Access-Control-Allow-Origin: *` (server.js:760), bez guardu cross-origin dla GET-ów (`isCrossOriginRequest` tylko dla metod mutujących, server.js:233/554). Dowolna odwiedzona strona odczyta adres wewnętrznego węzła i potwierdzi, że maszyna ma skonfigurowany VPS — rozszerzenie wycieku topologii, klasa z `docs/solutions/auth-issues/2026-07-24-cors-acao-wildcard-...`. Fix: pomijaj `vps_url` przy `isCrossOriginRequest(req)` albo zawęź ACAO do własnego Hosta.
2. **`setup.mjs:528`** — `resolveSavedVpsUrl` zwraca surowy string z RC/rejestru bez walidacji schematu; w ścieżce `kept` ten adres jest celem `pushNotifySettingsToVps` (setup.mjs:1456), czyli wysyłki tokenu bota Telegrama i webhooka Discorda plaintextem. Wcześniej adres zawsze przechodził przez `buildVpsUrl`. Fix: odrzucaj wartości niepasujące do `/^https?:\/\/[^\s]+$/` (→ null → prompt) + test na śmieć w RC.
3. **`lib/persisted-env.js:245`** — spawn `powershell` po gołej nazwie rozstrzyganej przez PATH daemona: zapisywalny katalog wcześniej w PATH podstawia własny `powershell.exe`, uruchamiany przy każdym `/api/status`. `lib/claude-spawn.js` świadomie unika takich fallbacków. Fix: pełna ścieżka z `SystemRoot`, fallback `null`.
4. **`setup.mjs:1394`** — brak ścieżki powrotu z trybu VPS do lokalnego: pusty Enter przy zapisanym adresie zawsze daje `kept`, `resolveVpsChoice` nie zna stanu „wyczyść", a prompt tego nie sygnalizuje. User po likwidacji VPS zostaje z martwym adresem i musi ręcznie edytować `~/.zshrc`/rejestr. Fix: sentinel (`-`/`brak`) → `{url:null, action:'none', persist:false}` + test.
5. **`lib/persisted-env.js:274`** — `REAL_IO` i `decodeShellValue` eksportowane bez konsumentów. Fix: zostaw `readPersistedEnv`, `describeEnvUsage`, `parsePersistedExport`.
6. **`lib/persisted-env.js:193-201`** — YAGNI w `decodeShellValue`: gałęzie dla apostrofu i gołego tokena obsługują linie, których jedyny producent (`upsertEnvLine` → `JSON.stringify`) nigdy nie wypisuje. Fix: zostaw `JSON.parse` + `null`.
7. **`lib/persisted-env.js:221-225`** — `resolveRcCandidates` ciągnie `io.shell()` tylko po to, by ustawić kolejność dwóch plików czytanych i tak obu. Fix: stała lista, `shell` usunięty z `REAL_IO` i `makeIo` (−~6 LOC, jedna zależność od środowiska mniej).
8. **`lib/persisted-env.test.js:86`** — brak asercji dla GŁÓWNEGO scenariusza R7 (`in_use: ''`, `persisted: 'http://…'`). Fix: test zamrażający decyzję, że pusty adres w pamięci przy zapisanym w konfiguracji JEST rozjazdem.

---

## ⚙️ OPERATOR (poza zakresem fix)

1. **Plan `docs/plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md:614`** — scenariusz [Manual] Unit 9 („zmiana adresu bez restartu → panel pokazuje ostrzeżenie; po restarcie znika") oraz „Sprawdzenie M1/M3" wymagają realnego środowiska z działającym VPS-em i restartem daemona usera; nie do odtworzenia headless bez side-effectów na produkcyjnej instalacji.
2. **Środowisko: daemon na porcie 7777 biegnie z kodem sprzed Fazy 4** (uptime ~13 h, etykieta legacy `com.claude-cron.daemon`), więc `curl -s localhost:7777/api/status` nie zwraca `vps_url`. Kontrakt zweryfikowano na świeżo wystartowanej instancji: `{"in_use":"","persisted":"http://100.122.215.61:7777","mismatch":true}` — to warunek środowiskowy, nie defekt kodu.

---

## Zgodność ze spec

- **U9** — zaimplementowane zgodnie z IU: nowy moduł `lib/persisted-env.js` + testy, pole `vps_url` w `/api/status` (odczyt w czasie żądania, wzorzec komentarza obecny), pasek w panelu. **Odchylenie udokumentowane w pliku zadań:** panel nie ma sekcji „ustawienia na górze", pole trafiło jako osobny pasek `#vps-addr` pod statbarem — odchylenie akceptowalne (opisane przy checkboxie). **Odchylenie NIEudokumentowane:** deklarowane scenariusze testowe `/api/status` pokryte tylko na poziomie czystej funkcji (P2 #5), a warstwa prezentacji nie działa (P1 #1) — feature nie spełnia swojego celu end-to-end.
- **U10** — zaimplementowane zgodnie z IU (domyślna wartość w prompcie, „bez zmian" vs „tryb tylko lokalny", sanityzacja przez `buildVpsUrl` dla nowego wejścia), z jedną luką semantyczną: stan `kept` nie propaguje wartości do bieżącego procesu (P2 #4), co podważa cel R11, oraz nie ma ścieżki wyjścia z trybu VPS (P3 #4).
- **Pliki testowe z planu** — obecne: `lib/persisted-env.test.js`, `setup.test.mjs` (rozszerzony). Brak testu szwu HTTP mimo Weryfikacji IU opisanej jako `curl` (P2 #5).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **4**
- Odznaczone na podstawie Agent 5 E2E: **0**
- Pozostawione dla operatora (Manual): **3** (1 `Weryfikacja:` + 2 pozycje „Operator checklist" U9/U10)
- Niejasne (P3): **0**
- Failujące (P2): **0**

### Szczegóły

- [x] CLI: `node --test lib/persisted-env.test.js` przechodzi → PASS (13/13, exit 0)
- [x] CLI: `npm test` przechodzi w całości (U9) → PASS (918/918, exit 0)
- [x] CLI: `node --test setup.test.mjs` przechodzi → PASS (134/134, exit 0)
- [x] CLI: `npm test` przechodzi w całości (U10) → PASS (918/918, exit 0)
- [ ] CLI: `curl -s localhost:7777/api/status` zwraca oba pola adresu i flagę rozjazdu — **SKIP (środowisko)**: daemon na 7777 biegnie z kodem sprzed Fazy 4; kontrakt potwierdzony na świeżej instancji (`{in_use:"",persisted:"http://100.122.215.61:7777",mismatch:true}`) → Operator checklist faza 4, **nie P2**
- [ ] Manual: **Sprawdzenie M1** wg szablonu (zmiana adresu bez restartu → ostrzeżenie; po restarcie znika) — wymaga operatora
- [ ] Manual: **Sprawdzenie M3** wg szablonu — wymaga operatora

Severity gate po bookkeepingu: bez zmian — **BLOKUJE** (P1 #1, `public/style.css:148`).

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 11 (6) |
| Flagi warstw | ui=true dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage, e2e |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 33 -> 33 -> 16 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 8 / 2 / 0 |
