# Review fazy 3 — konfiguracja raz-lokalnie (Unit 5, 6, 7)

Data: 2026-07-03
Zakres: modal ustawień powiadomień w dashboardzie (`public/index.html`, `public/app.js`), setup lokalny z pytaniami o powiadomienia + auto-detekcja chat ID + test-send + push na VPS (`setup.mjs`, `setup.test.mjs`), instalator VPS bez pytania o Discord (`scripts/install-vps.sh`, `scripts/install-vps.test.sh`).
Findings po adversarial verify, zdeduplikowane (31 surowych → 21 unikalnych: część reviewerów zgłosiła te same defekty pod różnymi kotwicami — noty przy pozycjach).

## Statystyki

| Severity | KOD/TEST/E2E | OPERATOR |
|---|---|---|
| 🔴 P1 | 0 | — |
| 🟠 P2 | 2 | 2 |
| 🟡 P3 | 17 | — |

- Testy CLI (bookkeeping): `node --test setup.test.mjs` 46/46 PASS, `bash scripts/install-vps.test.sh` 101/101 PASS, `grep -c DISCORD scripts/install-vps.sh` → 0 PASS.
- E2E: 0 passed / 0 failed / 3 skipped (scenariusze Unit 5 niewykonane — patrz P2-1).

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 2 problemy P2 do naprawy (0 P1).**

---

## 🟠 P2 (important)

### P2-1 [E2E] `public/app.js:960` — scenariusze E2E Unit 5 niewykonane; cały frontend modala bez żadnej weryfikacji zachowania

Scenariusze [E2E] z planu (Unit 5, plan `docs/plans/2026-07-03-001-...-plan.md:263`) NIE zostały wykonane — checkbox „Weryfikacja: Scenariusz E2E lokalny przez agent-browser przechodzi" celowo nieodhaczony, a kontekst fazy wymienia wyłącznie unit suite'y. Cały nowy frontend modala (`openNotifyModal`, `saveNotifySettings`, `clearNotifyChannel`, `pushNotifyToVps` — 138 linii) nie ma żadnej automatycznej weryfikacji; statyczna kontrola spójności z API (masked/masked_token/chat_id, reason-kody) wypada OK, ale zachowanie w przeglądarce jest niezweryfikowane.

**Do wykonania (wykonalne headless przez agent-browser na `localhost:7777`):**
1. otwarcie modala → placeholdery z maskami („skonfigurowano (…4242)"),
2. wpisanie wartości → Zapisz → ponowne otwarcie pokazuje nową maskę,
3. „Wyczyść" kanału → `GET /api/settings/notifications` pokazuje `configured:false` (przy pustym env).

*(dedup: to samo zgłoszone drugą kotwicą jako plan.md:263 — scalone)*

### P2-2 [TEST] `scripts/install-vps.test.sh:600` — scenariusz z planu „harness bez pytania o Discord — brak wiszącego read" niepokryty

Plan (Unit 7) definiuje test, którego nie ma: `collect_config` jest w harnessie `main()` mockowany (`MAIN_COMPONENT_FNS`), a żaden test nie wykonuje realnego `collect_config` z fixture TTY. Test 21 usunięto (legalnie — usuwana funkcjonalność), test 45 pokrywa tylko `build_puls_env_lines`. Regresja przywracająca pytanie/`read` w bloku pytań nie zostałaby wykryta (wiszący `read` pod `curl|bash` = EOF i ciche domyślne — dokładnie pułapka z learned patterns). Suite przechodzi 101/101, ale scenariusz z planu pozostaje niepokryty.

---

## 🟡 P3 (nit)

### P3-1 [KOD] `setup.mjs:672` — komunikat „Pominięto Telegram (brak chat ID)" kłamie: sam token i tak trafia do state i na VPS

`buildNotificationSettingsPayload` (l. 678) nie warunkuje `telegram_bot_token` od obecności chat ID — user, który podał token, a potem zrezygnował (puste chat ID, prompt obiecuje „puste = pomiń Telegram"), myśli że nic nie zapisano, a sekret wylądował lokalnie i na VPS (placeholder w modalu pokaże „skonfigurowano (…xxxx)" przy `configured:false`). Dwa stany („pominięto" vs „częściowo skonfigurowano") zlane w jeden mylący komunikat. Fix: albo nie wkładać tokena do payloadu bez chat ID, albo komunikat zgodny z zachowaniem („token zapisany — chat ID uzupełnisz w dashboardzie"). *(dedup: 2 zgłoszenia)*

### P3-2 [KOD] `setup.mjs:655` — zero walidacji formatu wartości powiadomień na WSZYSTKICH granicach wejścia (regresja po usunięciu `is_valid_discord_webhook`)

Setup przyjmuje dowolny string jako Discord webhook URL / Telegram token / chat ID, a `sanitizeNotifySettings` (`lib/notify-config.js:57`, granica PUT) sprawdza tylko `typeof string`. Jedyny istniejący walidator — `is_valid_discord_webhook` w `install-vps.sh` — został w tej fazie usunięty bez odpowiednika, więc po fazie 3 ŻADNA ścieżka konfiguracji nie waliduje formatu. Literówka/zły URL = treść powiadomień (nazwy jobów, fragmenty błędów) POST-owana na dowolny host albo cicha niedostawa wykrywana dopiero przy pierwszym failu joba (Telegram ma test-send, Discord nie ma żadnej weryfikacji). Minimalny fix w JEDNYM wspólnym miejscu (`sanitizeNotifySettings`) + warn w setupie: prefix `https://discord.com/api/webhooks/`, token `\d+:[A-Za-z0-9_-]+`, chat_id `-?\d+`. *(dedup: 3 zgłoszenia)*

### P3-3 [KOD] `setup.mjs:529` — auto-detekcja chat ID akceptuje ostatni update bez pokazania tożsamości nadawcy (default Enter=Y)

Jeśli obca osoba napisze do bota w oknie setupu (username bota bywa odgadywalny/skanowany), jej chat_id zostaje wykryty i domyślnie zaakceptowany — przyszłe powiadomienia o failach (nazwy jobów, komunikaty błędów) trafiają do obcego czatu. Update zawiera `message.from.first_name/username` — wyświetlenie ich obok wykrytego ID przy „Użyć? [Y/n]" pozwala userowi zweryfikować, że to jego rozmowa.

### P3-4 [KOD] `setup.mjs:538` — `extractChatIdFromUpdates` zlewa `{ok:false}` (błędny token, 401 z description) i `{ok:true, result:[]}` (brak wiadomości) w jeden `null`

Przy literówce w tokenie user dostaje mylące „Nie wykryto wiadomości do bota — podaj chat ID ręcznie", wpisuje chat ID, a dopiero test-send failuje. Odpowiedź `ok:false` niesie `description` — rozróżnić (warn „token odrzucony przez Bot API").

### P3-5 [KOD] `setup.mjs:212` — trzeci punkt prawdy dla kontraktu kluczy snake_case; `persistNotifySettings` omija `sanitizeNotifySettings`

`buildNotificationSettingsPayload` hardcoduje `discord_webhook_url`/`telegram_bot_token`/`telegram_chat_id` zamiast wywieść je z `NOTIFY_STATE_KEYS` (`lib/notify-config.js`, bezpieczny require bez node:sqlite) i duplikuje `buildPushPayload` z `lib/notify-push.js` (już require'owanego w setup.mjs, l. 558). Mapowanie kluczy żyje w trzech miejscach — dodanie kanału wymaga zsynchronizowania wszystkich; kontrakt spięty tylko komentarzem. Dodatkowo `persistNotifySettings` (l. 546) pisze `db.setState` bezpośrednio. *(dedup: 2 zgłoszenia)*

### P3-6 [KOD] `setup.mjs:511` — druga, rozjechana implementacja klienta Bot API sendMessage

setup.mjs (fetch, sukces = `ok:true` z BODY, timeout 10 s) vs `lib/telegram.js` `postSendMessage` (https.request, sukces = kod HTTP 2xx, bez timeoutu). Ten sam kontrakt zewnętrzny ma dwie definicje sukcesu — setup stosuje learned pattern (stan faktyczny z body), produkcyjna ścieżka wysyłki NIE. Duplikacja obronialna (Duplication > Complexity), ale rozjazd semantyki domknąć: ujednolicić weryfikację `ok:true` w `lib/telegram.js` (osobny task).

### P3-7 [KOD] `setup.mjs:602` — `main()` urósł do ~118 linii (reguła: >50 = wyciągnij pod-funkcje)

Faza dokleja inline cały blok orkiestracji pytań Discord/Telegram + test-send (l. ~653-683). `askTelegramChatId` już wyciągnięte — konsekwentnie wyciągnąć całość do `askNotifySettings(rl)`, żeby `main()` pozostał cienką skorupą I/O zgodnie z konwencją projektu.

### P3-8 [KOD] `setup.mjs:710` — push na VPS tylko gdy vpsUrl podany w BIEŻĄCYM przebiegu setupu

Przy re-runie setupu (np. dodanie Telegrama później) user z już skonfigurowanym `CLAUDE_CRON_VPS_URL` w env, który zostawi puste pytanie o VPS, dostaje zapis lokalny bez próby pusha i bez warna — konfiguracja cicho nie trafia na VPS. Ścieżka ratunkowa istnieje („Wyślij na VPS" w dashboardzie, R4). Rozważyć fallback do `process.env.CLAUDE_CRON_VPS_URL`.

### P3-9 [TEST] `setup.mjs:529` — `askTelegramChatId` nietestowalne: `fetchTelegramUpdates` zaszyte na sztywno (brak DI)

Funkcja zawiera logikę decyzyjną (potwierdzenie [Y/n], odrzucenie → ręczny fallback, brak detekcji → info + fallback) bez żadnego testu — wbrew wzorcowi czystych funkcji z argumentami. Wystarczy przekazać fetcher jako parametr z domyślną wartością; gałąź „wykryto → user odrzuca → ręczne wpisanie" warta pokrycia.

### P3-10 [TEST] `setup.mjs:516` — kluczowy guard „ok:true z body, nie kod HTTP" bez asercji chroniącej przed regresją

`sendTelegramTestMessage` i `fetchTelegramUpdates` (timeout) nietestowane, mimo że analogiczna logika w `lib/notify-push.js` ma testy z mock fetch. Plan celowo ograniczył testy Unit 6 do czystych funkcji (nie odstępstwo), ale regresja do sprawdzania `res.ok` przeszłaby suite.

### P3-11 [KOD] `scripts/install-vps.sh:1221` — re-run instalatora cicho kasuje `DISCORD_WEBHOOK_URL` ze starego unitu systemd

Stara instalacja z env-fallbackiem (R3) w unicie: `build_puls_env_lines` już nie emituje tej linii, a `create_systemd_service` regeneruje plik co run — jeśli konfiguracja nigdy nie była pushnięta do state DB, powiadomienia Discord przestają działać cicho, bez ostrzeżenia w podsumowaniu. Przy re-runie wykryć istniejącą linię w starym unicie i zachować ją albo jawnie ostrzec o konieczności pusha z lokalnego setupu.

### P3-12 [KOD] `server.js:471` — `server.listen(PORT)` bez hosta = nasłuch na wszystkich interfejsach, a state DB jest teraz kanonicznym magazynem sekretów powiadomień

Guard 403 blokuje tylko ruch z `X-Forwarded-For` (Funnel). W sieci LAN każdy host może bez autentykacji zrobić `PUT /api/settings/notifications` (podmiana chat_id/webhooka = przekierowanie powiadomień z treścią błędów jobów) oraz `POST push-to-vps`. Powierzchnia pre-existing (cały dashboard nieautoryzowany — odnotowane już w review fazy 1), ale faza 3 podnosi stawkę. Do świadomej decyzji: bind `127.0.0.1` + interfejs Tailscale albo udokumentowany wymóg firewalla lokalnie (na VPS mityguje UFW).

### P3-13 [KOD] `public/app.js:1022` — brak guardu in-flight na „Zapisz" i „Wyczyść"

Szybki double-click wysyła równoległe `PUT /api/settings/notifications`. `pushNotifyToVps` ma `btn.disabled`+`finally`, save/clear nie — niespójność z regułą 13 (operacje wzajemnie wykluczające blokuj do zakończenia). Skutek marginalny (PUT idempotentny), ale wzorzec ujednolicić.

### P3-14 [KOD] `public/app.js:1043` — wspólny try/catch `clearNotifyChannel` dla PUT (czyszczenie) i GET (refresh) daje sprzeczne toasty

Gdy PUT się uda, a odświeżenie placeholderów padnie: toast sukcesu („Wyczyszczono…") natychmiast po nim toast „Błąd czyszczenia konfiguracji" — mylący sygnał, mimo że czyszczenie przeszło; drugi GET to zbędny round-trip (modal zna stan po wyczyszczeniu — placeholdery można ustawić lokalnie). Rozdzielić catch per operacja albo aktualizować placeholdery bez refetchu.

### P3-15 [KOD] `public/app.js:1056` — „Wyślij na VPS" wysyła ZAPISANY state, UI nie ostrzega o niezapisanych polach formularza

User wpisuje token → klika „Wyślij na VPS" przed „Zapisz" → toast sukcesu, a VPS ma starą konfigurację. Naturalny flow (Zapisz zamyka modal) to łagodzi; prosty guard — jeśli któreś pole niepuste, podpowiedz najpierw Zapisz — usunąłby pułapkę.

### P3-16 [KOD/TEST] `public/app.js:968` — czyste helpery (`pushReasonMessage` z `PUSH_REASON_MESSAGES`, `notifyPlaceholder`) w stanowym app.js bez testów

Konwencja projektu wydziela czyste helpery do testowanych modułów (`enum-map.js`, `render-helpers.js` — jedyne z testami). Mapowanie reason→komunikat to dokładnie ten typ logiki; test przypiąłby kontrakt enum-kodów reason z `lib/notify-push.js` (dziś spięty tylko komentarzem; mapa nie pokrywa dynamicznych `put_failed_<status>`/`confirm_failed_<status>`/`error_<msg>` — fallback działa, ale dryf przy nowym reason będzie cichy). *(dedup: 2 zgłoszenia)*

### P3-17 [KOD] `public/index.html:24` — inline styl layoutu w headerze zamiast klasy w styles.css

`style="display:flex;align-items:center;gap:10px"` — dotychczasowe inline style w tym pliku to wyłącznie przełączniki widoczności (`display:none`), nie layout. Klasa np. `.header-actions`.

---

## Operator checklist (poza gate — warunki środowiskowe, nie defekty kodu)

### OP-1 [P2] Unit 5: push konfiguracji na żywy VPS (plan l. 266-268, zadania l. 94)

„Wyślij na VPS" w modalu → `GET /api/vps/settings/notifications` pokazuje `configured:true`. Wymaga realnej instancji VPS usera (srv1362522) osiągalnej przez Tailscale i realnych credentiali — headless test kliknąłby push z fikcyjnym tokenem i **nadpisałby produkcyjną konfigurację powiadomień na VPS**, więc celowo pominięty. Ogniwa pokryte unit testami (`lib/notify-push.test.js` z mock fetch); brak weryfikacji end-to-end na żywym środowisku. *(dedup: 4 zgłoszenia — P2×2, P3×2)*

### OP-2 [P2] Unit 6: pełny przebieg setupu na żywo z prawdziwym botem Telegrama (plan l. 301-302, zadania l. 104)

Pytania → auto-detekcja chat ID przez `getUpdates` → wiadomość testowa „✅ Puls połączony z Telegramem" dochodzi → po setupie VPS ma konfigurację. Wymaga prawdziwego bota (@BotFather) i interaktywnego TTY — niewykonalne headless. Czyste funkcje (`buildNotificationSettingsPayload`, `extractChatIdFromUpdates`) pokryte 7 testami z asercjami; ścieżka integracyjna „setup → state → push" do potwierdzenia przez operatora. *(dedup: 2 zgłoszenia — P2, P3)*

---

## Zgodność ze spec (oś Spec)

- Braki względem planu: scenariusz testowy Unit 7 „harness bez pytania o Discord" zdefiniowany, nieistniejący (P2-2); scenariusze [E2E] Unit 5 zdefiniowane, niewykonane (P2-1).
- Scope creep: nie stwierdzono.
- Pozornie zaimplementowane, ale błędnie: komunikat „Pominięto Telegram" przy częściowej konfiguracji (P3-1) — plan (Unit 6) nie precyzuje częściowego przypadku, więc P3, nie P2.

## E2E

| Scenariusz | Wynik |
|---|---|
| Otwórz modal → placeholdery „skonfigurowano/…4242" | ⚪ skipped (Agent 5 nie wykonał — do przegonienia headless, P2-1) |
| Wpisz wartość → Zapisz → ponowne otwarcie pokazuje nową maskę | ⚪ skipped (jw.) |
| „Wyczyść" kanału → GET `configured:false` (pusty env) | ⚪ skipped (jw.) |

**E2E: 0 passed / 0 failed / 3 skipped.**

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 2
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `node --test setup.test.mjs zielony` → PASS (46/46, exit 0)
- [x] CLI+Grep: `bash scripts/install-vps.test.sh zielony; grep -c DISCORD scripts/install-vps.sh → 0` → PASS (101/101, exit 0; grep → 0 wystąpień)
- [ ] E2E: `scenariusz E2E lokalny przez agent-browser przechodzi (zapis + odczyt maski)` — SKIP (Agent 5 nie wykonał scenariuszy; P2-1 już zarejestrowany — wykonalne headless, do domknięcia w fixie)
- [ ] Manual: `push na żywy VPS — GET /api/vps/settings/notifications po pushu pokazuje configured:true` — wymaga operatora (OP-1)
- [ ] Manual: `pełny setup na żywo (prawdziwy bot) — chat ID wykryty, testowa wiadomość dochodzi, po setupie VPS ma konfigurację` — wymaga operatora (OP-2)

Bookkeeping nie dodał nowych P2/P3 — severity gate bez zmian: **⚠️ ZASTRZEŻENIA (0×P1, 2×P2, 17×P3, 2×OPERATOR)**.
