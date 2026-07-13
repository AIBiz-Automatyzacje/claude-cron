# Konspekt — endpoint `/ask` (asystent głosowy)

> Kompletny zakres prac do samodzielnej implementacji w projekcie Puls (`~/Documents/Kodowanie/claude-cron/`).
> Ustalone: 10–13.07.2026. Zastępuje plan z sesji 04.07 (tamten celował w branch migracji, który jest już zmergowany do main).
> **Zaktualizowano 13.07.2026 po sesji roast** — najważniejsze zmiany: fallback „odczep zamiast ubijaj" (bez kill+requeue → zero podwójnych wykonań), faza 1 tylko Mac (Watch = faza 2), przyjazne komunikaty zawsze jako 200, job „Asystent głosowy" jako teczka historii, gwarancja „nigdy cisza".

---

## Cel i flow użytkownika

1. Skrót klawiszowy na Macu → okno dyktowania. (Apple Watch = **faza 2**, patrz niżej.)
2. Mówisz: pytanie („co ustaliłem z Marcinem o atrybucji?") albo polecenie („dodaj zadanie: zadzwonić do księgowej", „wyślij Marcinowi, że raport gotowy").
3. Tekst leci na VPS → Claude z dostępem do vaulta i skilli wykonuje → odpowiedź wraca w tym samym połączeniu HTTP.
4. Mac: okno dialogowe z odpowiedzią + odczyt na głos (Zosia Enhanced).

Jeden skrót do wszystkiego. Claude NIE musi z góry zgadywać, czy zadanie jest długie — o tym, czy odpowiedź wróci na ekran czy na komunikator, rozstrzyga zegar (timeout), nie klasyfikacja w prompcie.

**Zakres v1 (pełny, bez rozdrabniania):** pytania o vault + dodawanie zadań + odpalanie skilli (`/deleguj`, `/gog`, `/kie-generate`, `/utworz-zadanie`...).

**Fazy:**
- **Faza 1 — Mac.** Backend + skrót na Macu. Przy budowie skrótu krótki test, ile akcja „Pobierz zawartość URL" realnie wytrzyma czekania (55 s jest blisko typowych limitów).
- **Faza 2 — Apple Watch.** PRZED implementacją eksperyment pomiarowy: testowy endpoint czekający N sekund, skrót z zegarka przez LTE (20/30/45/60 s) — `ASK_TIMEOUT_MS` schodzi poniżej zmierzonego limitu z zapasem. Zegarek bywa dużo mniej cierpliwy niż Mac; bez pomiaru dostaje goły błąd sieci zamiast fallbacku.

---

## Architektura — 3 warstwy

1. **Endpoint `POST /ask/:token`** w `server.js` — synchroniczny, obok istniejącego `/webhook/:token` (routing publiczny ~linia 432).
2. **Prompt asystencki** — doklejany systemowo do każdego zapytania.
3. **Apple Shortcut** „Asystent" — faza 1 Mac, 4 akcje: Dyktuj → Pobierz zawartość URL (czeka!) → Okno dialogowe → Powiedz tekst.

Kluczowy insight z sesji 04.07: akcja Shortcuts „Pobierz zawartość URL" jest **synchroniczna** — czeka na odpowiedź HTTP, więc ten sam skrót, który wysłał głos, pokazuje wynik. Zero własnych okien, zero apki na zegarek.

Dlaczego nie webhook Pulsa: `handleWebhook` (`server.js:389-416`) odpowiada `{ok, run_id}` **zanim** Claude ruszy — wynik ląduje w SQLite, nie w odpowiedzi HTTP. Webhook = skrzynka nadawcza, nie linia telefoniczna. `/ask` to osobne drzwi, nie łatka.

---

## Zakres prac — serwer (świeży branch z `main`)

### A. Nowy moduł `lib/ask.js`

- **Wydzielić z `executor.js:100-152` wspólny helper spawnowania Claude'a** (dziś zaszyty w środku executora): czyszczenie env (`strip CLAUDE_CODE*` + `CLAUDECODE`), wstrzyknięcie OAuth z `~/.claude-cron-oauth-token` PO stripie (`readOauthToken` już wyeksportowany), `cwd = WORKSPACE_DIR` (vault). Executor i ask używają tego samego helpera — zero duplikacji.
- Spawn dla `/ask`: `claude --dangerously-skip-permissions --output-format text --model <ASK_MODEL> -p <prompt>` — `text` zamiast `stream-json` (czysty stdout do zwrotu).
- **Model: Sonnet** (`ASK_MODEL`, default `sonnet` — alias CLI wskazuje najnowszego Sonneta; Haiku odrzucony jako za słaby do skilli). Konfigurowalne przez env, więc podmiana = restart daemona.
- **Prompt asystencki** (template w `ask.js`), doklejany przed tekstem użytkownika:
  - pytanie → odpowiedz zwięźle, 2–4 zdania (odpowiedź jest czytana na głos);
  - polecenie → wykonaj i potwierdź jednym zdaniem („✅ Dodałem zadanie").
  - BEZ klasyfikacji „długie vs krótkie" — o trybie odpowiedzi decyduje timeout serwera, nie Claude (patrz C).
- **Współbieżność — dwa niezależne limity:**
  - **max 1 zapytanie synchroniczne** (trzymające połączenie HTTP). Drugie równoległe → natychmiast `200` z tekstem „⏳ Jeszcze myślę nad poprzednim pytaniem". Chroni przed retry Shortcuts i podwójnym spawnem.
  - **max 3 zadania odczepione w tle** (patrz C). Zadania w tle NIE blokują nowych zapytań sync — po zleceniu długiego raportu asystent dalej odpowiada na szybkie pytania. Czwarte odczepienie → `200` z tekstem „⏳ Mam pełne ręce — poczekaj aż coś skończę".

### B. Endpoint `POST /ask/:token` w `server.js`

Kolejność w handlerze:
1. **Autoryzacja podwójna:** token w URL (dopasowanie analogiczne do `matchWebhookToken`) + sekret w headerze `X-Secret`. Porównanie przez `crypto.timingSafeEqual` (NIE `===`; uwaga: przy różnych długościach bufora `timingSafeEqual` rzuca — najpierw porównaj długości). Brak/niezgodność któregokolwiek → 403 bez szczegółów.
2. **Rate limit:** max 10 zapytań/min (licznik in-memory per token wystarczy). Funnel jest publiczny — bez limitu ktoś z wyciekniętym linkiem pali tokeny Claude.
3. **Body = czysty tekst** (`text/plain`), NIE `JSON.stringify` jak w webhooku.
4. Spawn przez helper z A, `await` na zakończenie z timeoutem **55 s** (`ASK_TIMEOUT_MS`; wartość do weryfikacji testem limitu Shortcuts na Macu, patrz Fazy).
5. Zdążył → `200`, `Content-Type: text/plain; charset=utf-8`, body = stdout.
6. Nie zdążył → **odczepienie w tło** (patrz C), odpowiedź `200` natychmiast.

**Kody odpowiedzi — przyjazne teksty tylko dla przyjaciół:** Shortcuts na kodzie błędu pokazuje surowy komunikat systemowy zamiast body — cała treść komunikatu idzie do kosza. Dlatego **wszystko, co ma przeczytać człowiek** („jeszcze myślę", „mam pełne ręce", „robię w tle", przekroczony rate limit) wraca jako `200` z tekstem. **Kody błędów zostają wyłącznie dla intruzów:** 403 (zła autoryzacja), 404/405. Konsekwencja dla testów: asercje na TREŚĆ odpowiedzi, nie tylko na kod.

Uwaga na istniejący guard: blokada `X-Forwarded-For` w `server.js:441-444` odcina ruch z Funnela od dashboardu — routing `/ask/:token` musi być dopasowany PRZED tym guardem, tak jak webhook (`server.js:432-436`).

### C. Długie zlecenia — „odczep zamiast ubijaj"

Skille typu kie-generate potrafią mielić minuty, a klient HTTP nie będzie wisiał. Ale procesu NIE ubijamy i NIE zlecamy od nowa — kill+requeue groził **podwójnym wykonaniem poleceń z side-effectami** (wiadomość do Marcina wysłana w 40. sekundzie + requeue = Marcin dostaje ją dwa razy). Zamiast tego:

- Po przekroczeniu `ASK_TIMEOUT_MS` serwer **zostawia proces w spokoju** (dalej pracuje ten sam, jeden proces — zero duplikacji, zero zmarnowanej pracy) i odpowiada `200`: „⏳ Za długie na szybką odpowiedź — robię w tle, wynik przyjdzie powiadomieniem".
- Gdy odczepiony proces skończy, serwer bierze jego stdout i wysyła przez istniejący mechanizm powiadomień (Discord/Telegram wg konfiguracji teczki, patrz niżej).
- **Bezpiecznik:** twardy limit życia zadania odczepionego `ASK_MAX_MS` (default 10 min) + istniejące wzorce idle/watchdog z executora. Po przekroczeniu → kill + ❌ na komunikator.
- **Gwarancja „nigdy cisza":** zadanie odczepione kończy się ZAWSZE dokładnie jednym z trzech komunikatów na komunikator:
  - ✅ wynik,
  - ❌ „nie udało się" (pad procesu / przekroczony `ASK_MAX_MS`),
  - ❌ „przerwane przez restart serwera — poproś jeszcze raz" (reaper po restarcie znajduje osierocony run teczki; UWAGA: zwykłe runy `killed` nie wysyłają powiadomień — dla runów teczki to trzeba jawnie włączyć).

**Job „Asystent głosowy" = teczka (nie wykonawca).** Dedykowany job w panelu Pulsa pełni trzy role, zero nowych ekranów:

- **historia/diagnostyka**: każde zapytanie `/ask` (także szybkie, obsłużone synchronicznie) zapisuje się jako run tej teczki — co spytano, co odpowiedział, ile trwało, status. Run tworzony przez `db.createRun` ze statusem prowadzonym przez moduł ask (NIE przez kolejkę schedulera — ask omija kolejkę);
- **konfiguracja kanału**: flagi `discord_notify`/`telegram_notify` teczki decydują, dokąd idą wyniki zadań odczepionych — jak przy każdym innym jobie;
- **sprzątanie**: teczka oznaczona `routine=1` → udane wpisy znikają po 24 h (istniejący mechanizm retencji), wpadki zostają do wglądu.

**Powiadomienia TYLKO dla zadań odczepionych** — szybkie pytania odpowiadają w okienku i nie trąbią dodatkowo na Discordzie.

### D. Konfiguracja (`lib/config.js` + env)

| Zmienna | Default | Opis |
|---------|---------|------|
| `ASK_ENABLED` | `false` | włącznik feature'a (jak `WEBHOOK_ENABLED`) |
| `ASK_TOKEN` | — | token w URL; wygenerować długi losowy |
| `ASK_SECRET` | — | sekret do headera `X-Secret` |
| `ASK_TIMEOUT_MS` | `55000` | ile sync czeka przed odczepieniem w tło (do weryfikacji testem limitu Shortcuts) |
| `ASK_MAX_MS` | `600000` | twardy limit życia zadania odczepionego (10 min) |
| `ASK_MODEL` | `sonnet` | model dla zapytań |

Wartości tokenów/sekretów TYLKO w env na VPS — nic w repo, nic w commitach.

### E. Testy (`lib/ask.test.js`, konwencja repo — obok źródła)

Minimum (asercje na treść odpowiedzi tam, gdzie kod to zawsze 200 — patrz B):
- 403 bez `X-Secret` / ze złym sekretem / ze złym tokenem (happy + error path autoryzacji),
- `200` + tekst „jeszcze myślę" przy drugim równoległym zapytaniu sync,
- `200` + tekst „mam pełne ręce" przy czwartym zadaniu odczepionym,
- `200` + tekst rate-limitu po przekroczeniu 10/min,
- odczepienie: timeout → odpowiedź „robię w tle" + proces NIE zostaje ubity + run teczki istnieje,
- gwarancja „nigdy cisza": pad odczepionego procesu → wywołane powiadomienie ❌; run teczki oznaczony `killed` przez reaper → powiadomienie ❌ (test szwu ask+reaper, nie tylko czystych funkcji),
- happy path: mock spawna → stdout wraca jako `text/plain` + run teczki zapisany, BEZ powiadomienia.

Przed deployem test lokalny curlem:
```bash
curl -X POST "http://localhost:7777/ask/<token>" \
  -H "X-Secret: <sekret>" -H "Content-Type: text/plain" \
  --data "jakie mam zadania na dziś?"
```

---

## Deploy

1. Commit + push (branch → merge do main).
2. Pull na VPS + restart daemona Pulsa.
3. `ASK_*` do env na VPS.
4. Utworzyć w panelu Pulsa job-teczkę „Asystent głosowy" (`routine=1`, bez harmonogramu) + podpiąć powiadomienie (Telegram lub Discord — decyzja przy konfiguracji).
5. Sieć: zero zmian — Funnel już wisi na `kacper.tail4f19b2.ts.net:8443`, endpoint jedzie tym samym portem.

⚠️ Pamiętaj: token OAuth Claude na VPS żyje w `~/.claude-cron-oauth-token` — endpoint korzysta z niego przez helper, nic nowego nie trzeba, ale przy redeploy VPS token musi przeżyć.

---

## Apple Shortcut — faza 1: Mac (po działającym backendzie)

Jeden skrót „Asystent", 4 akcje:
1. **Dyktuj tekst**
2. **Pobierz zawartość URL** — POST na `https://kacper.tail4f19b2.ts.net:8443/ask/<token>`, header `X-Secret`, body = podyktowany tekst, czeka na odpowiedź
3. **Okno dialogowe** z odpowiedzią (wybrane w demo 13.07 — ładniejsze od Quick Look i „Pokaż wynik")
4. **Powiedz tekst** — głos **Zosia (Enhanced)** (wybrany w demo 13.07; pobrany przez Ustawienia → Dostępność → Zawartość mówiona). ElevenLabs świadomie odłożony — ewentualna podmiana to jedna akcja w skrócie, nie zmiana architektury.

- Odpalanie: hotkey w Shortcuts.app (albo Raycast) — do wyboru przy klikaniu.
- Dyktowanie: Apple (rekomendacja na start) vs VoiceInk (lepsza jakość, ale dwustopniowo przez schowek) — decyzja przy klikaniu, backend nie czeka.

## Faza 2: Apple Watch (osobne zadanie, po fazie 1)

- Skrót synchronizuje się przez iCloud → complication na tarczy / Siri / apka Skróty.
- **Krok zero fazy 2 — pomiar cierpliwości zegarka:** testowy endpoint czekający N sekund, wywołania z zegarka przez LTE (20/30/45/60 s). `ASK_TIMEOUT_MS` schodzi poniżej najsłabszego ogniwa (zegarek/Funnel) z zapasem. Bez pomiaru zegarek może zrywać połączenie PRZED odczepieniem i pokazywać goły błąd sieci.
- Karta odpowiedzi na ekranie zegarka zamiast okna dialogowego (dobór akcji przy klikaniu).

---

## Bezpieczeństwo — uzasadnienie decyzji

Claude dla `/ask` chodzi z pełnymi uprawnieniami (`--dangerously-skip-permissions`) — tak samo jak joby Pulsa. Świadoma decyzja: skoro v1 ma odpalać skille (Bash, API, Postgres), allowlista narzędzi traci sens. Całe bezpieczeństwo siedzi w warstwie dostępu:

- podwójny sekret (token URL + header `X-Secret`, `timingSafeEqual`),
- rate limit 10/min,
- współbieżność: max 1 sync + max 3 w tle,
- `ASK_ENABLED=false` domyślnie (świadome włączenie na VPS),
- logowanie każdego wywołania (jak `[webhook]` w konsoli) + historia w teczce.

Poziom ryzyka = ten sam, który już akceptujemy przy publicznych webhookach Pulsa. Wyciek obu sekretów = dostęp do asystenta z vaultem i terminalem → w razie podejrzenia natychmiast zrotować `ASK_TOKEN`/`ASK_SECRET` w env i zrestartować daemona.

**Świadomie zaakceptowane ryzyko (roast 13.07):** zapytanie `/ask` może pracować równolegle z jobem Pulsa na tym samym vaulcie (ask celowo omija serializowaną kolejkę executora — musi odpowiadać od ręki). To samo ryzyko co dzisiejsza ręczna praca w Obsidianie/terminalu podczas joba. Wracamy do tematu tylko, jeśli kolizje realnie zabolą — wtedy prosta zasada „polecenia zapisujące czekają, pytania nie". Nie budujemy tego na zapas.

---

## Szacunek

Serwer: ~250 linii + testy, jedna–dwie sesje (doszła teczka + gwarancja powiadomień). Shortcut Mac: 10 minut klikania.
