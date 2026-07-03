# Checklista operatora — telegram-powiadomienia-skill-taski

Branch: `feature/telegram-powiadomienia-skill-taski`
Ostatnia aktualizacja: 2026-07-03
Status: **DO WYKONANIA przed mergem do main**

Testy wymagają żywego bota Telegram, działającego VPS-a i sesji Claude Code — nie da się ich
zautomatyzować w pipeline. Wzorzec: `docs/completed/instalator-vps-obsidian-puls/operator-checklist.md`.

## Przygotowanie (raz, przed testami)

- [ ] **P1. Restart lokalnego serwera Pulsa na branchu feature.** Działający proces (uptime liczony w dniach) trzyma kod sprzed zmian — modal ustawień, endpointy settings i kolumna `telegram_notify` nie istnieją w starym procesie. Ubij proces i odpal `npm start` z repo na branchu (albo przez autostart).
  - Weryfikacja: `curl -s http://localhost:7777/api/settings/notifications` zwraca JSON z `discord`/`telegram` (nie 404).
- [ ] **P2. VPS ma zaktualizowany kod.** Push z setupu/dashboardu wymaga endpointu settings na VPS. Cron auto-update robi `git pull` o 02:00 — jeśli merge jeszcze nie nastąpił, na czas testu wgraj branch ręcznie (`git fetch && git checkout feature/... && systemctl restart` na VPS) albo testuj push po merge.
  - Weryfikacja: `curl -s http://100.122.215.61:7777/api/settings/notifications` zwraca JSON (nie 404).
- [ ] **P3. Bot Telegram gotowy.** U @BotFather: `/newbot` → zapisz token. NIE wysyłaj jeszcze wiadomości do bota, jeśli chcesz przetestować ścieżkę „brak update'ów → ręczny fallback"; wyślij, jeśli testujesz happy path auto-detekcji.

## Test 1 — Setup na żywo: konfiguracja raz-lokalnie (Unit 6)

Uruchom `node setup.mjs` (re-run na istniejącej instalacji jest wspierany).

- [ ] 1.1. Pytanie o Discord webhook: wklej swój webhook (albo Enter = pomiń).
- [ ] 1.2. Pytanie o Telegram bot token: wklej token z P3.
- [ ] 1.3. **Auto-detekcja chat ID**: setup prosi „Napisz teraz cokolwiek do swojego bota na Telegramie, potem wciśnij Enter" → po Enterze pokazuje `Wykryto chat ID: <id>. Użyć? [Y/n]` z TWOIM prawidłowym ID.
- [ ] 1.4. **Fallback ręczny** (opcjonalnie, drugi przebieg): Enter bez pisania do bota → `[info] Nie wykryto wiadomości do bota — podaj chat ID ręcznie.` → ręczne pole działa.
- [ ] 1.5. **Test-send**: `[ok] Wiadomość testowa wysłana — sprawdź Telegram.` i wiadomość „✅ Puls połączony z Telegramem" faktycznie DOCHODZI na Telefon.
- [ ] 1.6. Po smoke-teście DB: `[ok] Konfiguracja powiadomień zapisana lokalnie (state DB).`
- [ ] 1.7. **Push na VPS**: komunikat sukcesu pusha (przy skonfigurowanym `CLAUDE_CRON_VPS_URL`), a `curl -s http://100.122.215.61:7777/api/settings/notifications` pokazuje `configured:true` i maskę `…4 ostatnie znaki` dla wypełnionych kanałów. Sekrety NIE występują w odpowiedzi w pełnej formie.

## Test 2 — Powiadomienia end-to-end: sukces i fail (Unit 3 + 4, R9)

- [ ] 2.1. W dashboardzie (`localhost:7777`) utwórz testowy job typu claude z zaznaczonym checkboxem „Telegram" (i opcjonalnie „Discord"), np. skill z szybkim promptem.
- [ ] 2.2. Odpal go ręcznie (▶) → po udanym runie na Telegram dochodzi „✅ <nazwa joba>" z treścią wyniku.
- [ ] 2.3. **Fail**: zmień job tak, żeby padł (np. nieistniejący skill / timeout 1 min na długim tasku) → po OSTATECZNYM failu (po wyczerpaniu retry) dochodzi „❌ <nazwa> padł (<status>)" ze skrótem błędu. Przy `max_retries=1` powiadomienie przychodzi RAZ, nie po każdej próbie.
- [ ] 2.4. **Kill bez powiadomienia**: odpal długi run i ubij go z dashboardu → ŻADNA wiadomość nie przychodzi (status `killed`).
- [ ] 2.5. Edycja joba: checkbox Telegram odzwierciedla stan z bazy po ponownym otwarciu formularza.

## Test 3 — Modal ustawień powiadomień (Unit 5)

- [ ] 3.1. Otwórz „Ustawienia powiadomień" w dashboardzie → placeholdery pokazują stan „skonfigurowano/…XXXX" (maski), pola puste.
- [ ] 3.2. Wpisz nową wartość w JEDNO pole → Zapisz → ponowne otwarcie pokazuje nową maskę; pozostałe kanały NIETKNIĘTE (puste pole = nie nadpisuj).
- [ ] 3.3. **„Wyślij na VPS"** przy PUSTYCH polach (scenariusz „VPS dokupiony po setupie", R10) → push przechodzi, `GET /api/vps/settings/notifications` odzwierciedla pełną lokalną konfigurację.
- [ ] 3.4. **„Wyczyść"** przy kanale → GET pokazuje `configured:false` dla tego kanału. UWAGA: jeśli masz env fallback (`DISCORD_WEBHOOK_URL` w `.zshrc`), kanał dalej pokaże `configured:true` ze źródłem env — to poprawne zachowanie (state wyczyszczony → fallback env). Sprawdź na kanale Telegram (brak env) albo po `unset`.

## Test 4 — Starter-taski: idempotencja na Twojej instalacji (Unit 8)

Twoja lokalna baza JUŻ ma joby o nazwach seedowanych tasków — to naturalny test idempotencji.

- [ ] 4.1. W przebiegu setupu z Testu 1 odpowiedz `T` na „Dodać zestaw podstawowych tasków…" → raport pokazuje wszystkie 4 jako POMINIĘTE z powodem `exists`; zero duplikatów w dashboardzie.
- [ ] 4.2. (Opcjonalnie, pełny happy path) Na czystej bazie (np. tymczasowo pusty `data/`) seed dodaje 4 joby z poprawnymi cronami, `enabled=1` i WYŁĄCZONYMI powiadomieniami; przy działającym serwerze harmonogramy rejestrują się bez restartu (`[ok] Harmonogramy 4 seedowanych tasków zarejestrowane…`).

## Test 5 — Skill `puls` w żywej sesji Claude Code (Unit 9)

- [ ] 5.1. Po setupie istnieje `~/.claude/skills/puls/SKILL.md`; zakładka „Skille" w dashboardzie go widzi (parsowalny frontmatter).
- [ ] 5.2. W NOWEJ sesji Claude Code (poza repo Pulsa): „dodaj do Pulsa zadanie <skill> co poniedziałek 8:00" → agent robi poprawny POST `/api/jobs` (job pojawia się w dashboardzie z cronem `0 8 * * 1`).
- [ ] 5.3. „pokaż czemu ostatni run joba <nazwa> padł" → agent czyta runy z API i cytuje błąd (stderr/error_msg).
- [ ] 5.4. Posprzątaj testowe joby.

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

_(uzupełnić podczas testów)_
