# 🫀 Puls

**Puls** — scheduler agentów AI (Claude Code), AIBIZ. Ustawiasz co i kiedy ma się odpalić — Claude robi resztę. Dashboard w stylu retro arcade do zarządzania wszystkim.

**Działa na:** 🍎 macOS · 🪟 Windows · 🐧 Linux (VPS)

## Co to robi?

- **Harmonogram** — Claude odpala Twoje skille/prompty o wybranej godzinie (codziennie, co X godzin, w wybrane dni)
- **Webhoki** — zewnętrzne serwisy (Make, n8n, Zapier) mogą triggerować joby przez link
- **Dashboard** — przeglądarka, `localhost:7777`, zarządzasz jobami, widzisz historię, przeglądasz skille
- **VPS 24/7** — joby lecą non-stop na serwerze, nawet gdy śpisz
- **Powiadomienia Discord i Telegram** — wynik joba (✅) albo ostateczny fail (❌) ląduje na Twoim kanale; konfigurujesz raz — lokalnie ([szczegóły](#-powiadomienia-discord--telegram))
- **Podstawowe taski + skill `puls`** — setup proponuje gotowy zestaw jobów startowych i instaluje skill, dzięki któremu zarządzasz Pulsem rozmową z Claude Code

---

## 📋 Instalacja

Kolejność:

1. **Krok 1 — VPS** (jeśli go używasz, opcjonalne)
2. **Krok 2 — Komputer lokalny** — wybierz swoją platformę: 🍎 Mac lub 🪟 Windows

> *Nie masz VPS-a?* Pomiń krok 1 — Puls zadziała tylko lokalnie. Joby będą lecieć tylko gdy komputer nie śpi.

---

## ☁️ Krok 1 — Instalacja na VPS (opcjonalne)

Jeśli chcesz harmonogram lecący 24/7 — postaw Puls na VPS-ie i podłącz dashboard przez Tailscale. Instalator stawia też **Obsidian Sync w trybie headless** (vault na serwerze — Claude pracuje na Twoich notatkach, wyniki lądują na telefonie). Nie używasz Obsidiana? Dodaj flagę `--only-puls`.

### 1.1 — Prerequisites (zanim zaczniesz)

Instalator poprosi Cię o zalogowanie do każdej z tych usług — przygotuj je wcześniej:

- [ ] świeży VPS z Ubuntu/Debianem i dostępem root przez SSH (Hostinger, DigitalOcean, Hetzner, etc.)
- [ ] konto Obsidian + vault lokalny + remote vault (Obsidian Sync)
- [ ] hasło szyfrowania end-to-end remote vaulta (to **INNE** hasło niż do konta!)
- [ ] prywatne repo GitHub z katalogiem `.claude` (skille)
- [ ] konto GitHub (logowanie `gh` przez przeglądarkę)
- [ ] konto Tailscale

> Przy `--only-puls` wystarczą: VPS, konto GitHub i konto Tailscale.

### 1.2 — SSH na VPS

```bash
ssh root@TWOJE_IP_SERWERA
```

> **Gdzie znaleźć IP serwera?** W panelu hostingu (np. Hostinger → VPS → IPv4).

### 1.3 — Odpal instalator (one-liner)

Jedna komenda — pobiera i odpala instalator prosto z `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash
```

Nie masz `curl` na świeżym serwerze? Wariant z `wget`:

```bash
wget -qO- https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash
```

> **🔒 Wykonujesz kod z internetu.** Ta komenda odpala skrypt prosto z GitHuba jako `root`. Jeśli wolisz najpierw go obejrzeć:
> ```bash
> curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh -o install-vps.sh
> # otwórz install-vps.sh w edytorze, przejrzyj — dopiero potem:
> sudo bash install-vps.sh
> ```

Instalator prowadzi Cię przez cały przebieg i jest **bezpieczny do ponownego uruchomienia** — re-run wykrywa, co już jest zrobione, i wskakuje w brakujący krok:

1. checklist + detekcja stanu (co już jest zainstalowane)
2. wszystkie pytania naraz: email Obsidian, nazwa vaulta, repo `.claude` (o powiadomienia instalator VPS **nie pyta** — konfigurujesz je raz przy instalacji lokalnej, a Puls sam wypycha je na VPS)
3. automatyczna instalacja narzędzi: Node 22, Claude CLI, `gh`, `obsidian-headless`, Tailscale
4. blok 5 logowań (jedyne kroki interaktywne): Claude → GitHub → Obsidian → Obsidian Sync → Tailscale
5. serwisy systemd (`claude-cron`, `obsidian-sync`), firewall, auto-update o 02:00 i notatka-dowód **„Witaj z VPS"**, która za chwilę pojawi się w Obsidianie na Twoim telefonie
6. na końcu opcjonalne pytanie o Tailscale Funnel (webhooki) — w razie wątpliwości wybierz `N`, wrócisz do tego później

### 1.4 — Flagi

Flagi przekazuje się przez `bash -s --` (wszystko po `--` trafia do skryptu):

```bash
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash -s -- --only-puls
```

| Flaga | Działanie |
|-------|-----------|
| `--only-puls` / `--no-obsidian` | instaluje tylko Puls (bez Obsidian Sync i vaulta) |
| `--port <n>` | port serwera Puls (domyślnie 7777) |
| `--tz <tz>` | strefa czasowa (domyślnie autodetekcja / Europe/Warsaw) |
| `--device-name <s>` | nazwa urządzenia w Obsidian Sync (domyślnie `vps-<hostname>`) |
| `--no-auto-update` | bez codziennego crona auto-update (02:00) |
| `--reset` | deinstalacja (patrz niżej) — nie łączy się z `--only-puls` |

### 1.5 — Reset (deinstalacja)

```bash
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash -s -- --reset
```

Instalator wypisze **dokładną listę** tego, co usunie, i poprosi o potwierdzenie wpisaniem `TAK` (samo Enter anuluje). Usuwa: oba serwisy systemd, wpis auto-update z crona, plik sudoers i użytkownika `claude` z całym `/home/claude` (vault lokalny, vault-git, loginy). **Dane vaulta są bezpieczne na serwerze Obsidian Sync** — komputer i telefon nadal mają wszystko.

Reset świadomie **nie usuwa** rzeczy współdzielonych z systemem:
- **Tailscale** — odłącz ręcznie: `tailscale logout`, potem usuń maszynę w [admin console](https://login.tailscale.com/admin/machines)
- **reguły UFW** — odblokuj port: `ufw delete deny 7777/tcp`
- **Node.js, gh i pakiety apt** (git, curl, cron)

Po resecie ponowna instalacja działa od zera — wklej one-liner jeszcze raz.

### 1.6 — Test z brancha (env-override, dla testerów)

Instalator z forka/brancha PRZED merge — prawdziwym pipe, nie lokalnym plikiem:

```bash
curl -fsSL https://raw.githubusercontent.com/<user>/claude-cron/<branch>/scripts/install-vps.sh \
  | sudo CLAUDE_CRON_REPO=https://github.com/<user>/claude-cron.git CLAUDE_CRON_REF=<branch> bash
```

`CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF` wskazują, skąd instalator sklonuje kod Pulsa (domyślnie to repo, branch `main`).

### 1.7 — Zapisz Tailscale IP

Na końcu installer pokaże **Tailscale IP VPS-a**. **Zapisz to IP** — będziesz go potrzebować w kroku 2! Jeśli nie widzisz:

```bash
tailscale ip -4
```

Przykład: `100.86.100.113`

---

## 💻 Krok 2 — Instalacja lokalna

> **🔒 O komendach `curl … | bash` i `irm … | iex`**
> Instalacja Pulsa (i Claude Code, i wielu narzędzi CLI) odpala skrypt prosto z internetu — to wygodne, ale **wykonujesz kod, którego nie widziałeś**. Świadomie omija to ostrzeżenia Gatekeeper (Mac) / SmartScreen (Windows). Zanim odpalisz, możesz **najpierw obejrzeć skrypt** — pobierz do pliku, przejrzyj w edytorze, dopiero potem uruchom:
> - Mac/Linux: `curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.sh -o install.sh` → otwórz `install.sh` → dopiero potem `bash install.sh`
> - Windows: `irm https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.ps1 -OutFile install.ps1` → otwórz `install.ps1` → dopiero potem `.\install.ps1`
> - VPS: `curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh -o install-vps.sh` → otwórz `install-vps.sh` → dopiero potem `sudo bash install-vps.sh`
>
> (to samo dotyczy installera Claude Code — `curl -fsSL https://claude.ai/install.sh -o install.sh` / `irm https://claude.ai/install.ps1 -OutFile install.ps1`)
>
> Installer Pulsa (`install.sh` / `install.ps1`) pobiera przenośny Node z `nodejs.org` i **weryfikuje sumę kontrolną `SHASUMS256`** przed rozpakowaniem — uszkodzone lub podmienione archiwum przerywa instalację. Dotyczy to obu komend: i `curl … | bash`, i `irm … | iex` wykonują kod z internetu, więc weryfikacja sumy jest twardym warunkiem każdego toru.

Wybierz swoją platformę:

### 🍎 Mac — instalacja krok po kroku

#### Krok 1 — Sprawdź wymagania

Otwórz terminal (Cmd+Space → "Terminal").

> **Node.js?** Nie musisz go instalować ręcznie. Installer (`install.sh`) sam pobiera przenośny Node 22.x LTS do folderu `.node/` wewnątrz repo (z weryfikacją sumy SHA256) i używa go tylko na potrzeby Pulsa — nie dotyka Twojego systemowego Node ani PATH.

Sprawdź Claude Code:

```bash
claude --version
```

- Jeśli działa — masz ✅
- Jeśli `command not found` — zainstaluj:
  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  claude   # pierwsze uruchomienie poprosi o logowanie w przeglądarce
  ```

Zainstaluj też **Tailscale** jeśli używasz VPS-a:
```bash
brew install --cask tailscale
```
Albo pobierz z [tailscale.com/download](https://tailscale.com/download).

#### Krok 2 — Wklej jedną komendę

```bash
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.sh | bash
```

To wszystko. Ta jedna komenda:

1. Pobiera repo do `~/claude-cron` (bez `git` — przez tarball, więc nie odpala instalacji Xcode CLT),
2. Stawia przenośny Node w `.node/` (weryfikując sumę `SHASUMS256` z nodejs.org),
3. Przekazuje sterowanie do `setup.mjs`, który **pyta o 6 rzeczy** (odpowiadasz w terminalu):

| Pytanie | Co wpisać |
|---------|-----------|
| **1. Workspace** | Folder w którym Claude ma wykonywać joby (najczęściej Twój vault Obsidian). Otworzy się **natywne okno wyboru folderu** (macOS `osascript` „choose folder" w Finderze) — zaznacz folder i kliknij OK. Jeśli okno się nie pojawi, wpisz ścieżkę w terminalu |
| **2. VPS** | Tailscale IP VPS-a z kroku 1.7 (np. `100.86.100.113`) albo Enter, jeśli używasz Pulsa tylko lokalnie |
| **3. Powiadomienia** | `T`, jeśli chcesz dostawać powiadomienia po zakończeniu zadań (albo `n` — skonfigurujesz później w dashboardzie) |
| **4. Kanał** | `1` = Discord (podasz URL webhooka) lub `2` = Telegram (podasz token bota z [@BotFather](#telegram--bot-krok-po-kroku); chat ID setup **wykryje sam** — napisz cokolwiek do swojego bota, gdy poprosi, i wciśnij Enter; na koniec dostaniesz wiadomość testową „✅ Puls połączony z Telegramem"). Drugi kanał możesz dodać później w dashboardzie |
| **5. Autostart** | `Y` — serwer startuje automatycznie z każdą sesją Claude Code |
| **6. Podstawowe taski** | `T` — dodaje [gotowy zestaw jobów startowych](#-podstawowe-taski-onboarding) (memory update, reflect, skill scout) |

#### Gotowe 🎉

Po odpowiedziach **serwer startuje sam w tle**, a **przeglądarka otwiera się automatycznie** na retro arcade dashboardzie. Link jest też zawsze wypisany w terminalu jako siatka bezpieczeństwa:

**[http://localhost:7777](http://localhost:7777)**

> Od następnej sesji Claude Code (jeśli włączyłeś autostart) serwer odpala się sam — nie musisz nic robić, nigdy nie uruchamiasz go ręcznie.

---

### 🪟 Windows — instalacja krok po kroku

#### Krok 1 — Sprawdź wymagania

Otwórz **PowerShell** (Win+X → "Windows PowerShell" lub "Terminal"):

> **Node.js?** Nie musisz go instalować ręcznie. Installer (`install.ps1`) sam pobiera przenośny Node 22.x LTS do folderu `.node\` wewnątrz repo (z weryfikacją sumy SHA256) i używa go tylko na potrzeby Pulsa — nie dotyka Twojego systemowego Node ani PATH.

**Git:**
```powershell
git --version
```

- Jeśli działa — masz ✅
- Jeśli `not recognized` — zainstaluj:
  ```powershell
  winget install Git.Git
  ```

**Claude Code:**
```powershell
claude --version
```

- Jeśli działa — masz ✅
- Jeśli `not recognized`:
  ```powershell
  irm https://claude.ai/install.ps1 | iex
  ```
  Po instalacji **najpewniej dostaniesz info że Claude nie jest w PATH** — zobacz [Rozwiązywanie problemów](#-windows-claude-nie-jest-rozpoznawany).

**Tailscale** (jeśli używasz VPS-a):
```powershell
winget install Tailscale.Tailscale
```
Albo pobierz z [tailscale.com/download](https://tailscale.com/download).

#### Krok 2 — Wklej jedną komendę

W PowerShell:

```powershell
irm https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.ps1 | iex
```

To wszystko. Ta jedna komenda:

1. Pobiera repo do `$HOME\claude-cron` (bez `git` — przez zip + `Expand-Archive`),
2. Stawia przenośny Node w `.node\` (weryfikując sumę `SHASUMS256` z nodejs.org),
3. Przekazuje sterowanie do `setup.mjs`, który **pyta o 6 rzeczy** (odpowiadasz w terminalu):

| Pytanie | Co wpisać |
|---------|-----------|
| **1. Workspace** | Folder w którym Claude ma wykonywać joby (najczęściej Twój vault Obsidian). Otworzy się **natywne okno wyboru folderu** (Windows `FolderBrowserDialog`) — zaznacz folder i kliknij OK. Jeśli okno się nie pojawi, wklej pełną ścieżkę w terminalu, np. `C:\Users\kacpe\OneDrive\Obsidian\Vault` |
| **2. VPS** | Tailscale IP VPS-a z kroku 1.7 (np. `100.86.100.113`) albo Enter, jeśli używasz Pulsa tylko lokalnie |
| **3. Powiadomienia** | `T`, jeśli chcesz dostawać powiadomienia po zakończeniu zadań (albo `n` — skonfigurujesz później w dashboardzie) |
| **4. Kanał** | `1` = Discord (podasz URL webhooka) lub `2` = Telegram (podasz token bota z [@BotFather](#telegram--bot-krok-po-kroku); chat ID setup **wykryje sam** — napisz cokolwiek do swojego bota, gdy poprosi, i wciśnij Enter; na koniec dostaniesz wiadomość testową „✅ Puls połączony z Telegramem"). Drugi kanał możesz dodać później w dashboardzie |
| **5. Autostart** | `Y` — serwer startuje automatycznie z Claude Code |
| **6. Podstawowe taski** | `T` — dodaje [gotowy zestaw jobów startowych](#-podstawowe-taski-onboarding) (memory update, reflect, skill scout) |

#### Gotowe 🎉

Po odpowiedziach **serwer startuje sam w tle**, a **przeglądarka otwiera się automatycznie** na dashboardzie. Link jest też zawsze wypisany w terminalu:

**[http://localhost:7777](http://localhost:7777)**

> Od następnej sesji Claude Code (jeśli włączyłeś autostart) serwer odpala się sam — nigdy nie uruchamiasz go ręcznie.

---

## Jak korzystać z dashboardu

Dashboard ma 3 zakładki:

### JOBS — Twoje zadania

Tu tworzysz i zarządzasz jobami. Kliknij **+ NEW JOB** i ustaw:

- **Nazwa** — jak chcesz nazwać joba
- **Skill** — wybierz z listy (pogrupowane: Project, User, Plugin)
- **Harmonogram** — codziennie, dni robocze, co X godzin, itp.
- **Prompt** — dodatkowe instrukcje dla Claude'a (opcjonalne)
- **Powiadomienia** — zaznacz Discord i/lub Telegram, jeśli chcesz dostać wynik joba na kanał (kanały konfigurujesz w modalu 🔔 — patrz [Powiadomienia](#-powiadomienia-discord--telegram))

Każdy job ma przyciski: ▶ (uruchom teraz), ⏻ (włącz/wyłącz), ✎ (edytuj), ✕ (usuń).

### HISTORY — Historia uruchomień

Kliknij dowolny wpis żeby zobaczyć co Claude zrobił — pełny output z narzędziami, czasem i kosztem.

### SKILLS — Dostępne skille

Przeglądaj wszystkie skille z filtrami:
- **📁 Project** — skille z Twojego workspace'u
- **👤 User** — Twoje globalne skille
- **🔌 Plugin** — skille z zainstalowanych pluginów

---

## 🔔 Powiadomienia (Discord + Telegram)

Puls wysyła powiadomienie po runie joba, jeśli zaznaczysz kanał w formularzu joba:

- **✅ sukces** — wynik joba (odpowiedź agenta), długie wyniki dzielone na kilka wiadomości (Discord ≤2000 znaków, Telegram ≤4096)
- **❌ ostateczny fail** — gdy job padnie (`failed`/`timeout`) i **wyczerpie wszystkie retry**, dostajesz wiadomość ze skrótem przyczyny (komunikat błędu albo końcówka stderr). Pojedynczy fail, po którym Puls jeszcze ponawia, nie spamuje
- **zabicie ręczne (`killed`)** — bez powiadomienia (sam to zrobiłeś, wiesz)

Oba kanały działają symetrycznie i niezależnie — możesz mieć jeden, drugi albo oba.

### Konfigurujesz raz — lokalnie

Dane kanałów (webhook Discorda, token i chat ID Telegrama) podajesz **jeden raz, w setupie lokalnym** (`node setup.mjs` — pytania 3 i 4 z instalacji). Setup:

1. zapisuje konfigurację w lokalnej bazie Pulsa (state DB),
2. wysyła wiadomość testową „✅ Puls połączony z Telegramem",
3. **sam wypycha konfigurację na VPS** (jeśli masz VPS skonfigurowany) — na serwerze nic nie ustawiasz.

Później wszystko zmienisz w dashboardzie: przycisk **🔔 Powiadomienia** otwiera modal z trzema polami (webhook Discord, token Telegrama, chat ID). Masz tam **Zapisz** (lokalnie), **Wyślij na VPS** i **Wyczyść** per kanał. Zmiany działają od razu — bez restartu serwera.

> **Skąd Puls bierze konfigurację?** Najpierw z bazy (state DB), a gdy tam pusto — ze zmiennych środowiskowych `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (fallback dla starszych instalacji — jeśli masz je w `.zshrc`, nadal działają). Wartość zapisana w dashboardzie/setupie **wygrywa** z env.

> **⚠️ Re-run instalatora VPS a Discord.** Instalator VPS **nie pyta już** o webhook Discorda i przy ponownym uruchomieniu **usuwa `DISCORD_WEBHOOK_URL` z konfiguracji serwisu** na serwerze. Jeśli po re-runie instalatora VPS powiadomienia z VPS-a zamilkły — wypchnij konfigurację z lokalnej instalacji: dashboard → 🔔 Powiadomienia → **Wyślij na VPS** (albo przejdź jeszcze raz `node setup.mjs`).

> **🔒 Sekrety w bazie.** Token bota i webhook są zapisane w pliku bazy `data/claude-cron.db` **czystym tekstem** (ten sam poziom zaufania co zmienne w `.zshrc`). Nie udostępniaj nikomu pliku bazy ani folderu `data/`. Dashboard i API nigdy nie pokazują pełnych wartości — tylko maskę (ostatnie 4 znaki).

### Telegram — bot krok po kroku

1. **Załóż bota**: otwórz w Telegramie czat z [@BotFather](https://t.me/BotFather) → wyślij `/newbot` → podaj nazwę (np. `Puls`) i unikalny username (musi kończyć się na `bot`, np. `moj_puls_bot`)
2. **Skopiuj token** — BotFather odpisze tokenem w formacie `123456789:AAH...` — to jest wartość, którą wklejasz w setupie / modalu 🔔
3. **Chat ID wykryje setup**: gdy setup poprosi, **napisz cokolwiek do swojego bota** (otwórz z nim czat i wyślij np. „hej"), wróć do terminala i wciśnij Enter — Puls odczyta chat ID sam (przez `getUpdates`) i poprosi o potwierdzenie. Jeśli auto-detekcja się nie uda, wpiszesz chat ID ręcznie
4. **Sprawdź telefon** — powinna przyjść wiadomość „✅ Puls połączony z Telegramem"

Potem w każdym jobie zaznacz checkbox **Telegram** — i wyniki lecą na Twój czat.

---

## 🧰 Podstawowe taski (onboarding)

Na końcu setupu lokalnego Puls proponuje (jedno pytanie `[T/n]`) gotowy zestaw czterech jobów startowych z `templates/starter-jobs.json`:

| Job | Harmonogram | Skill |
|-----|-------------|-------|
| Daily memory update | codziennie 6:00 | `memory-update` |
| Weekly memory update | poniedziałek 8:00 | `memory-update` (tryb weekly) |
| Reflect tygodniowy | poniedziałek 8:00 | `reflect` |
| Poszukiwanie nowych skillów | piątek 9:00 | `skill-scout` |

Zasady:

- **Idempotencja po nazwie** — job o tej samej nazwie już istnieje? Zostanie pominięty (re-run setupu niczego nie zdubluje). Jeśli świadomie usunąłeś taska, ponowny setup z odpowiedzią `T` przywróci go
- **Brak skilla = pominięcie z powodem** — jeśli nie masz danego skilla (np. `skill-scout`), setup pominie ten szablon i powie dlaczego
- Joby startują z **wyłączonymi powiadomieniami** — włączysz je per job w dashboardzie
- Seed działa **tylko lokalnie** — na VPS taski trafiają tak, jak wszystkie inne (tworzysz je przez dashboard w widoku VPS)

---

## 🤖 Skill `puls` — zarządzaj Pulsem rozmową

Setup instaluje globalnie skill `puls` (kopiuje `skills/puls` z repo do `~/.claude/skills/puls`), dzięki któremu **każda sesja Claude Code umie obsługiwać Pulsa przez REST API**. Zamiast klikać w dashboard, mówisz:

- „dodaj do Pulsa zadanie: raport tygodniowy co poniedziałek 8:00"
- „dlaczego ostatni run joba X padł?"
- „zmień harmonogram joba Y na dni robocze o 7:00"
- „zabij bieżący run"

Skill zna endpointy, pola jobów i format logów — tworzy, edytuje i diagnozuje joby sam. Re-run setupu nadpisuje skill najnowszą wersją z repo.

---

## Webhoki — triggerowanie z zewnątrz

Chcesz żeby Make, n8n albo inny serwis odpalał joba? Potrzebujesz webhooka.

### Jak to ustawić

1. W dashboardzie edytuj joba (✎)
2. Na dole znajdź sekcję **WEBHOOK**
3. Kliknij **🔗 GENERATE WEBHOOK URL**
4. Skopiuj URL (📋) i wklej go w zewnętrznym serwisie

### Wysyłanie danych do joba

Webhook akceptuje **POST z JSON body**. Cała zawartość body trafia do Claude jako `webhook_payload` i możesz się do niej odwołać w prompcie joba.

Przykład:

```bash
curl -X POST "https://twoj-funnel.ts.net/webhook/<token>" \
  -H "Content-Type: application/json" \
  -d '{"haslo":"widzew","tekst":"Witaj świecie"}'
```

W Make / n8n / Zapier ustaw:
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: JSON z dowolnymi polami

> Uwaga: query string (`?haslo=widzew`) **nie jest obsługiwany** — użyj body.

### Wymagania

Webhoki działają tylko jeśli podczas instalacji VPS-a włączyłeś **Tailscale Funnel**. Jeśli nie, możesz włączyć później:

```bash
sudo tailscale funnel --bg 7777
```

---

## Przydatne komendy

### 🍎 Mac

| Co chcesz zrobić | Komenda |
|------------------|---------|
| Wymusić start serwera | Odpal nową sesję Claude Code w workspace — hook autostartu startuje serwer sam |
| Przeinstalować od nowa | `curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.sh \| bash` (re-run nie kasuje bazy ani `.node/`) |
| Zaktualizować kod | `cd ~/claude-cron && git pull` |
| Sprawdzić co zajmuje port | `lsof -i :7777` |

### 🪟 Windows

| Co chcesz zrobić | Komenda |
|------------------|---------|
| Wymusić start serwera | Odpal nową sesję Claude Code w workspace — hook autostartu startuje serwer sam |
| Przeinstalować od nowa | `irm https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.ps1 \| iex` (re-run nie kasuje bazy ani `.node\`) |
| Zaktualizować kod | `cd $HOME\claude-cron; git pull` |
| Sprawdzić co zajmuje port | `netstat -ano \| findstr :7777` |

### Na VPS-ie (przez SSH)

| Co chcesz zrobić | Komenda |
|------------------|---------|
| Sprawdzić czy działa | `systemctl status claude-cron` |
| Zobaczyć logi na żywo | `journalctl -u claude-cron -f` |
| Zrestartować serwis | `systemctl restart claude-cron` |
| Zaktualizować kod | `su - claude -c 'cd ~/claude-cron && git pull' && systemctl restart claude-cron` |
| Sprawdzić Tailscale IP | `tailscale ip -4` |

> Auto-update cron na VPS robi `git pull` codziennie o 2:00 i restartuje serwis. Nie musisz pamiętać.

---

## Rozwiązywanie problemów

### 🪟 Windows: `claude` nie jest rozpoznawany

Claude CLI nie został dodany do PATH. Wklej w PowerShell (3 linijki, działają na każdym Windowsie):

```powershell
$claudePath = "$env:USERPROFILE\.local\bin"
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";$claudePath", "User")
$env:Path += ";$claudePath"
```

Linia 1: ścieżka do Claude. Linia 2: dodaje na stałe. Linia 3: dodaje do bieżącej sesji.

Zamknij i otwórz nowy terminal — `claude` powinno działać.

### 🪟 Windows: `install.ps1` nie chce się odpalić

Execution Policy blokuje skrypt. Użyj flagi `-ExecutionPolicy Bypass`:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

### Dashboard nie wczytuje danych z VPS-a

Sprawdź czy Tailscale działa na obu urządzeniach.

🍎 Mac:
```bash
tailscale status
```

🪟 Windows: otwórz aplikację Tailscale i sprawdź czy VPS jest na liście.

### Joby się nie odpalają na VPS-ie

Sprawdź logi:
```bash
journalctl -u claude-cron -n 30
```

Najczęstsza przyczyna: Claude CLI nie jest zalogowany. Napraw:
```bash
su - claude
claude
# przejdź logowanie w przeglądarce
exit
sudo systemctl restart claude-cron
```

### Joby odpalają się o złej godzinie (VPS)

Serwer ma inną strefę czasową:
```bash
timedatectl set-timezone Europe/Warsaw
sudo systemctl restart claude-cron
```

### Port 7777 jest zajęty

Sprawdź co trzyma port:

🍎 Mac:
```bash
lsof -i :7777
```

🪟 Windows:
```powershell
netstat -ano | findstr :7777
```

Najczęściej to wcześniej uruchomiony serwer Pulsa — wystarczy go ubić. Hook autostartu odpali nowy proces przy następnej sesji Claude Code.

---

## Odinstalowanie

### 🍎 Mac

1. Usuń hook z `{workspace}/.claude/settings.json` (sekcja `hooks.UserPromptSubmit`, wpis z `claude-cron-autostart`)
2. Usuń z `~/.zshrc` zmienne `CLAUDE_CRON_VPS_URL`, `CLAUDE_CRON_WORKSPACE`, `DISCORD_WEBHOOK_URL`
3. Usuń folder repo:
   ```bash
   rm -rf ~/claude-cron
   ```

### 🪟 Windows

1. Usuń hook z `{workspace}\.claude\settings.json`
2. Usuń zmienne i pliki:
   ```powershell
   [Environment]::SetEnvironmentVariable('CLAUDE_CRON_WORKSPACE', $null, 'User')
   [Environment]::SetEnvironmentVariable('CLAUDE_CRON_VPS_URL', $null, 'User')
   [Environment]::SetEnvironmentVariable('DISCORD_WEBHOOK_URL', $null, 'User')
   Remove-Item -Recurse -Force $HOME\claude-cron
   ```

> Dane (historia jobów, baza SQLite) są w folderze `data/` wewnątrz repo — usuwane razem z nim.
