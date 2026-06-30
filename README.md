# 🫀 Puls

**Puls** — scheduler agentów AI (Claude Code), AIBIZ. Ustawiasz co i kiedy ma się odpalić — Claude robi resztę. Dashboard w stylu retro arcade do zarządzania wszystkim.

**Działa na:** 🍎 macOS · 🪟 Windows · 🐧 Linux (VPS)

## Co to robi?

- **Harmonogram** — Claude odpala Twoje skille/prompty o wybranej godzinie (codziennie, co X godzin, w wybrane dni)
- **Webhoki** — zewnętrzne serwisy (Make, n8n, Zapier) mogą triggerować joby przez link
- **Dashboard** — przeglądarka, `localhost:7777`, zarządzasz jobami, widzisz historię, przeglądasz skille
- **VPS 24/7** — joby lecą non-stop na serwerze, nawet gdy śpisz
- **Powiadomienia Discord** — wynik joba ląduje na Twojego Discorda

---

## 📋 Instalacja

Kolejność:

1. **Krok 1 — VPS** (jeśli go używasz, opcjonalne)
2. **Krok 2 — Komputer lokalny** — wybierz swoją platformę: 🍎 Mac lub 🪟 Windows

> *Nie masz VPS-a?* Pomiń krok 1 — Puls zadziała tylko lokalnie. Joby będą lecieć tylko gdy komputer nie śpi.

---

## ☁️ Krok 1 — Instalacja na VPS (opcjonalne)

Jeśli chcesz harmonogram lecący 24/7 — postaw Puls na VPS-ie i podłącz dashboard przez Tailscale.

### Wymagania
- Serwer VPS z Linuxem (Hostinger, DigitalOcean, Hetzner, etc.) — installer instaluje Tailscale automatycznie

### 1.1 — SSH na VPS

```bash
ssh root@TWOJE_IP_SERWERA
```

> **Gdzie znaleźć IP serwera?** W panelu hostingu (np. Hostinger → VPS → IPv4).

### 1.2 — Zainstaluj prereqs

```bash
apt update && apt install -y git curl
```

### 1.3 — Odpal installer

Jedna komenda — pobiera i odpala installer prosto z `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash
```

> **🔒 Wykonujesz kod z internetu.** Ta komenda odpala skrypt prosto z GitHuba jako `root`. Jeśli wolisz najpierw go obejrzeć:
> ```bash
> curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh -o install-vps.sh
> # otwórz install-vps.sh w edytorze, przejrzyj — dopiero potem:
> sudo bash install-vps.sh
> ```

Installer zrobi wszystko automatycznie (`git clone` repo, portable Node z weryfikacją `SHASUMS256`, systemd). Po drodze zapyta:

| Pytanie | Co wpisać |
|---------|-----------|
| **Log in to Claude CLI** | `Y` — auto-odpali `claude` jako user `claude`. Zaloguj się w przeglądarce, wyjdź przez `/exit` — installer automatycznie kontynuuje |
| **Workspace** | Np. `/home/claude/vault` |
| **Port** | Enter (domyślny 7777) |
| **Discord webhook** | URL albo puste |
| **Timezone** | Enter (Warsaw) |
| **Tailscale Funnel** | `Y` jeśli chcesz webhoki |
| **Auto-update cron** | `Y` — codzienny git pull o 2:00 |

### 1.4 — Zapisz Tailscale IP

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
3. Przekazuje sterowanie do `setup.mjs`, który **pyta o 4 rzeczy** (odpowiadasz w terminalu):

| Pytanie | Co wpisać |
|---------|-----------|
| **1. Workspace** | Folder w którym Claude ma wykonywać joby (najczęściej Twój vault Obsidian). Otworzy się **natywne okno wyboru folderu** (macOS `osascript` „choose folder" w Finderze) — zaznacz folder i kliknij OK. Jeśli okno się nie pojawi, wpisz ścieżkę w terminalu |
| **2. VPS** | Tailscale IP VPS-a z kroku 1.4 (np. `100.86.100.113`) albo Enter, jeśli używasz Pulsa tylko lokalnie |
| **3. Discord** | URL webhooka Discord do powiadomień albo Enter, żeby pominąć |
| **4. Autostart** | `Y` — serwer startuje automatycznie z każdą sesją Claude Code |

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
3. Przekazuje sterowanie do `setup.mjs`, który **pyta o 4 rzeczy** (odpowiadasz w terminalu):

| Pytanie | Co wpisać |
|---------|-----------|
| **1. Workspace** | Folder w którym Claude ma wykonywać joby (najczęściej Twój vault Obsidian). Otworzy się **natywne okno wyboru folderu** (Windows `FolderBrowserDialog`) — zaznacz folder i kliknij OK. Jeśli okno się nie pojawi, wklej pełną ścieżkę w terminalu, np. `C:\Users\kacpe\OneDrive\Obsidian\Vault` |
| **2. VPS** | Tailscale IP VPS-a z kroku 1.4 (np. `100.86.100.113`) albo Enter, jeśli używasz Pulsa tylko lokalnie |
| **3. Discord** | URL webhooka Discord do powiadomień albo Enter, żeby pominąć |
| **4. Autostart** | `Y` — serwer startuje automatycznie z Claude Code |

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
- **Discord** — zaznacz jeśli chcesz powiadomienie na Discorda

Każdy job ma przyciski: ▶ (uruchom teraz), ⏻ (włącz/wyłącz), ✎ (edytuj), ✕ (usuń).

### HISTORY — Historia uruchomień

Kliknij dowolny wpis żeby zobaczyć co Claude zrobił — pełny output z narzędziami, czasem i kosztem.

### SKILLS — Dostępne skille

Przeglądaj wszystkie skille z filtrami:
- **📁 Project** — skille z Twojego workspace'u
- **👤 User** — Twoje globalne skille
- **🔌 Plugin** — skille z zainstalowanych pluginów

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
