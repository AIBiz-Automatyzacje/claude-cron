# Checklista operatora — telegram-powiadomienia-skill-taski

Branch: `feature/telegram-powiadomienia-skill-taski`
Ostatnia aktualizacja: 2026-07-03
Status: **DO WYKONANIA przed mergem do main**

Testy wymagają żywego bota Telegram, działającego VPS-a i sesji Claude Code — nie da się ich
zautomatyzować w pipeline. Wzorzec: `docs/completed/instalator-vps-obsidian-puls/operator-checklist.md`.

## Przygotowanie (raz, przed testami)

- [x] **P1. Restart lokalnego serwera Pulsa na branchu feature.** Działający proces (uptime liczony w dniach) trzyma kod sprzed zmian — modal ustawień, endpointy settings i kolumna `telegram_notify` nie istnieją w starym procesie. Ubij proces i odpal `npm start` z repo na branchu (albo przez autostart).
  - Weryfikacja: `curl -s http://localhost:7777/api/settings/notifications` zwraca JSON z `discord`/`telegram` (nie 404).
  - ✅ 2026-07-03: serwer lokalny działał WPROST z repo dev (nie z `~/claude-cron` — ten katalog to stara, porzucona kopia). Restart na branchu: endpoint odpowiada, Discord `configured:true` z env fallbacku (R3 działa), migracja dodała `telegram_notify`, 8 jobów nietkniętych.
- [x] **P2. VPS ma zaktualizowany kod.** Push z setupu/dashboardu wymaga endpointu settings na VPS. Cron auto-update robi `git pull` o 02:00 — jeśli merge jeszcze nie nastąpił, na czas testu wgraj branch ręcznie (`git fetch && git checkout feature/... && systemctl restart` na VPS) albo testuj push po merge.
  - Weryfikacja: `curl -s http://100.122.215.61:7777/api/settings/notifications` zwraca JSON (nie 404).
  - ✅ 2026-07-03: `CLAUDE_CRON_VPS_URL` celuje w STARSZY VPS „kacper" (100.122.215.61, alias ssh `vps`), nie w srv1362522 z memory. Deploy brancha: stash lokalnej łatki OAuth (`~/.claude-cron-oauth-token` → `CLAUDE_CODE_OAUTH_TOKEN` w executor.js, wstrzyknięcie PO strip-loopie), checkout, `npm install` (usunięte 38 starych paczek), stash pop bez konfliktu — łatka przeżyła. Usługa `claude-cron.service` active, endpoint odpowiada z Maca po Tailscale, 8 jobów VPS nietkniętych. UWAGA przed mergem: łatka OAuth to lokalna modyfikacja na VPS — auto-update (`git pull`) może się na niej wywalić; rozważyć upstreamowanie mechanizmu tokena.
- [ ] **P3. Bot Telegram gotowy.** U @BotFather: `/newbot` → zapisz token. NIE wysyłaj jeszcze wiadomości do bota, jeśli chcesz przetestować ścieżkę „brak update'ów → ręczny fallback"; wyślij, jeśli testujesz happy path auto-detekcji.

## Test 1 — Setup na żywo: konfiguracja raz-lokalnie (Unit 6)

Uruchom `node setup.mjs` (re-run na istniejącej instalacji jest wspierany).

- [x] 1.1. Pytanie o Discord webhook: wklej swój webhook (albo Enter = pomiń).
  - ✅ 2026-07-03: user pominął (Enter) — Discord dalej działa z env fallbacku (`configured:true` w GET). Migrację Discorda do state zrobimy z modala (Test 3).
- [x] 1.2. Pytanie o Telegram bot token: wklej token z P3.
- [x] 1.3. **Auto-detekcja chat ID**: setup prosi „Napisz teraz cokolwiek do swojego bota na Telegramie, potem wciśnij Enter" → po Enterze pokazuje `Wykryto chat ID: <id>. Użyć? [Y/n]` z TWOIM prawidłowym ID.
  - ✅ 2026-07-03 (z asteriskiem): pierwszy przebieg NIE wykrył wiadomości — śledztwo wykluczyło zewnętrznego konsumenta (późniejszy „test2" WISIAŁ w `getUpdates` przez 3 kolejne polle, niepodbierany). Wniosek: przejściowy lag kolejki update'ów świeżo utworzonego bota (wiadomości sekundy po `/newbot` nie weszły do kolejki, `pending:0`). Logika zweryfikowana na żywych danych: `extractChatIdFromUpdates(getUpdates) → 7338359732` (poprawne ID usera). Fallback ręczny pokrył lukę zgodnie z projektem.
- [x] 1.4. **Fallback ręczny** (opcjonalnie, drugi przebieg): Enter bez pisania do bota → `[info] Nie wykryto wiadomości do bota — podaj chat ID ręcznie.` → ręczne pole działa.
  - ✅ 2026-07-03: ręczne `7338359732` przyjęte, test-send wysłany.
- [x] 1.5. **Test-send**: `[ok] Wiadomość testowa wysłana — sprawdź Telegram.` i wiadomość „✅ Puls połączony z Telegramem" faktycznie DOCHODZI na Telefon.
  - ✅ API przyjęło (`ok:true` w body — dokładna weryfikacja frazy zadziałała); dostarczenie potwierdzone przez usera.
- [x] 1.6. Po smoke-teście DB: `[ok] Konfiguracja powiadomień zapisana lokalnie (state DB).`
  - ✅ GET pokazuje `telegram: configured:true, …N5u0, chat_id 7338359732`.
- [x] 1.7. **Push na VPS**: komunikat sukcesu pusha (przy skonfigurowanym `CLAUDE_CRON_VPS_URL`), a `curl -s http://100.122.215.61:7777/api/settings/notifications` pokazuje `configured:true` i maskę `…4 ostatnie znaki` dla wypełnionych kanałów. Sekrety NIE występują w odpowiedzi w pełnej formie.
  - ✅ zaliczone mocniejszą ścieżką: server-side push z modala (Test 3.3) — GET na VPS pokazuje wyłącznie maski, pełne sekrety nie występują w odpowiedziach.
  - ℹ️ user pominął IP VPS w setupie (tryb lokalny) — push przetestujemy z modala (Test 3.3, scenariusz „puste pola + Wyślij na VPS" i tak jest mocniejszy).
  - ⚠️ Side-effect przebiegu: setup nadpisał `CLAUDE_CRON_WORKSPACE` w `.zshrc` na `~/Documents/live-09-07` (poprzednio: `~/Documents/kacper_trzepiecinski_workspace`) — do decyzji usera czy przywrócić.

## Test 2 — Powiadomienia end-to-end: sukces i fail (Unit 3 + 4, R9)

- [x] 2.1. W dashboardzie (`localhost:7777`) utwórz testowy job typu claude z zaznaczonym checkboxem „Telegram" (i opcjonalnie „Discord"), np. skill z szybkim promptem.
  - ✅ 2026-07-03: job #29 „Test powiadomień (operator)" utworzony przez API (`telegram_notify:1`, `discord_notify:0`); ścieżka UI-checkbox pokryta E2E autopilota + wizualnie w 2.5.
- [x] 2.2. Odpal go ręcznie (▶) → po udanym runie na Telegram dochodzi „✅ <nazwa joba>" z treścią wyniku.
  - ✅ run 63859 success → „✅ Test powiadomień (operator) / Test powiadomień Pulsa działa. ✅" doszła (screenshot usera, 16:56).
- [x] 2.3. **Fail**: zmień job tak, żeby padł (np. nieistniejący skill / timeout 1 min na długim tasku) → po OSTATECZNYM failu (po wyczerpaniu retry) dochodzi „❌ <nazwa> padł (<status>)" ze skrótem błędu. Przy `max_retries=1` powiadomienie przychodzi RAZ, nie po każdej próbie.
  - ✅ run 63860 failed → retry 63861 failed (ostateczny) → DOKŁADNIE JEDNA „❌ Test powiadomień (operator) padł (failed)" z treścią błędu `Cannot find module` (screenshot usera).
- [x] 2.4. **Kill bez powiadomienia**: odpal długi run i ubij go z dashboardu → ŻADNA wiadomość nie przychodzi (status `killed`).
  - ✅ run 63863 killed przez `POST /api/runs/current/kill`, bez retry i bez wiadomości (ostatnia na Telegramie to ❌ z 2.3).
- [x] 2.5. Edycja joba: checkbox Telegram odzwierciedla stan z bazy po ponownym otwarciu formularza.
  - ✅ screenshot usera: „Powiadomienie Telegram" zaznaczone, „Powiadomienie Discord" odznaczone — zgodnie z bazą. Testowy job #29 usunięty po testach (8 jobów jak przed).

## Test 3 — Modal ustawień powiadomień (Unit 5)

- [x] 3.1. Otwórz „Ustawienia powiadomień" w dashboardzie → placeholdery pokazują stan „skonfigurowano/…XXXX" (maski), pola puste.
  - ✅ 2026-07-03 (screenshot): placeholdery „skonfigurowano (…iFpn)" / „(…N5u0)" / „(7338359732)", pola puste, hint „Puste pole = wartość bez zmian…", przyciski „Wyczyść" per kanał.
- [x] 3.2. Wpisz nową wartość w JEDNO pole → Zapisz → ponowne otwarcie pokazuje nową maskę; pozostałe kanały NIETKNIĘTE (puste pole = nie nadpisuj).
  - ✅ user wkleił webhook (…R8JG) → state DB ma wartość, GET pokazuje nową maskę …R8JG mimo że env (.zshrc) dalej trzyma …iFpn — **priorytet state>env potwierdzony na żywo**; Telegram nietknięty zapisem.
- [x] 3.3. **„Wyślij na VPS"** przy PUSTYCH polach (scenariusz „VPS dokupiony po setupie", R10) → push przechodzi, `GET /api/vps/settings/notifications` odzwierciedla pełną lokalną konfigurację.
  - ✅ **kluczowy scenariusz roastu ZALICZONY**: VPS pokazuje `telegram configured:true (…N5u0, chat 7338359732)` — na VPS nie było żadnego env Telegrama, więc wartości mogły przyjść wyłącznie z server-side pusha state.
- [x] 3.4. **„Wyczyść"** przy kanale → GET pokazuje `configured:false` dla tego kanału. UWAGA: jeśli masz env fallback (`DISCORD_WEBHOOK_URL` w `.zshrc`), kanał dalej pokaże `configured:true` ze źródłem env — to poprawne zachowanie (state wyczyszczony → fallback env). Sprawdź na kanale Telegram (brak env) albo po `unset`.
  - ✅ „Wyczyść Telegram" → lokalnie `configured:false` (puste klucze w state), VPS nietknięty. Konfiguracja przywrócona po teście przez `PUT /api/settings/notifications`.

## Test 4 — Starter-taski: idempotencja na Twojej instalacji (Unit 8)

Twoja lokalna baza JUŻ ma joby o nazwach seedowanych tasków — to naturalny test idempotencji.

- [x] 4.1. W przebiegu setupu z Testu 1 odpowiedz `T` na „Dodać zestaw podstawowych tasków…" → raport pokazuje wszystkie 4 jako POMINIĘTE z powodem `exists`; zero duplikatów w dashboardzie.
  - ✅ 2026-07-03: „Pominięto …— job o tej nazwie już istnieje" ×4, „Nie dodano nowych tasków"; `total_jobs` bez zmian (8).
- [ ] 4.2. (Opcjonalnie, pełny happy path) Na czystej bazie (np. tymczasowo pusty `data/`) seed dodaje 4 joby z poprawnymi cronami, `enabled=1` i WYŁĄCZONYMI powiadomieniami; przy działającym serwerze harmonogramy rejestrują się bez restartu (`[ok] Harmonogramy 4 seedowanych tasków zarejestrowane…`).

## Test 5 — Skill `puls` w żywej sesji Claude Code (Unit 9)

- [x] 5.1. Po setupie istnieje `~/.claude/skills/puls/SKILL.md`; zakładka „Skille" w dashboardzie go widzi (parsowalny frontmatter).
  - ✅ 2026-07-03: plik istnieje, a skill `puls` pojawił się w liście dostępnych skilli żywej sesji Claude Code (frontmatter parsowalny end-to-end).
- [x] 5.2. W NOWEJ sesji Claude Code (poza repo Pulsa): „dodaj do Pulsa zadanie <skill> co poniedziałek 8:00" → agent robi poprawny POST `/api/jobs` (job pojawia się w dashboardzie z cronem `0 8 * * 1`).
  - ✅ 2026-07-03: skill wywołany w żywej sesji („dodaj zadanie: reflect co poniedziałek 8:00") → agent na bazie SAMEJ treści skilla: sprawdził kolizję nazw, zrobił poprawny POST (`cron_expr: 0 8 * * 1`, `timeout_ms` wg szablonu), zweryfikował `next_run: pon 06:00Z` (=8:00 PL). Caveat: sesja w repo Pulsa (nie „czysta") — treść skilla była jednak jedynym źródłem spec API. Obserwacja drobna: odpowiedź POST nie zawiera wyliczonego `next_run` (GET już tak) — kosmetyka, nie blocker.
- [x] 5.3. „pokaż czemu ostatni run joba <nazwa> padł" → agent czyta runy z API i cytuje błąd (stderr/error_msg).
  - ✅ target z pytania (job testowy) już nie istniał (DELETE kasuje też runy — zgodnie ze spec skilla), więc agent zdiagnozował najświeższy realny fail: run 59558 „Daily memory update" (30.06) = `timeout`, `error_msg: Timeout exceeded`, stderr: `TIMEOUT: killed after 1800000ms` — przekroczony twardy limit 30 min.
- [x] 5.4. Posprzątaj testowe joby.
  - ✅ joby #29 i #30 usunięte; stan końcowy = 8 jobów jak przed testami.

## Test 6 (opcjonalny) — instalator VPS bez pytania o Discord (Unit 7)

Harness testowy pokrył to automatycznie (`bash scripts/install-vps.test.sh` zielony). Pełny re-run
`install-vps.sh` na produkcyjnym VPS jest opcjonalny — pamiętaj o konsekwencji: re-run USUWA
`Environment=DISCORD_WEBHOOK_URL` z unita systemd, więc powiadomienia VPS wymagają wcześniejszego
pusha (Test 1.7 / Test 3.3).

- [ ] 6.1. (Opcjonalnie) Re-run instalatora na VPS: brak pytania o Discord; podsumowanie zawiera „Powiadomienia skonfigurujesz przy instalacji lokalnej — trafią tu automatycznie"; po instalacji joby VPS z flagami powiadomień dalej wysyłają (config ze state po pushu).

## Po zaliczeniu

- [ ] Odhacz checkboxy, zanotuj napotkane bugi poniżej.
- [ ] Merge `feature/telegram-powiadomienia-skill-taski` → `main` (+ ewentualny `/dev-compound` jeśli testy operatora ujawnią nowy problem wart bazy wiedzy).
- [ ] Po merge na VPS: auto-update (cron 02:00) lub ręczny `git pull` + restart.

## Notatki z przebiegu

- 2026-07-03: Feedback UX usera z Testu 1 → zaimplementowane na branchu (commit `729aafd`): setup pyta najpierw „Chcesz otrzymywać powiadomienia? [T/n]", potem o wybór JEDNEGO kanału `[1] Discord / [2] Telegram` (zamiast sekwencyjnych pytań o oba). Drugi kanał do dodania w dashboardzie. Nowy pure helper `parseNotifyChannelChoice` + 2 testy; README (tabele pytań mac+win) zaktualizowane; 269/269 testów zielonych.
- 2026-07-03: Side-effect Testu 1 naprawiony — `CLAUDE_CRON_WORKSPACE` w `.zshrc` przywrócony na `~/Documents/kacper_trzepiecinski_workspace` (setup nadpisał na omyłkowo wybrany `live-09-07`). Feedback zapisany w memory: snapshotować nadpisywane wartości przed statefulnymi testami na maszynie usera.
