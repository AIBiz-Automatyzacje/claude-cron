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

```bash
git clone https://github.com/AIBiz-Automatyzacje/claude-cron.git /tmp/claude-cron-install && bash /tmp/claude-cron-install/scripts/install-vps.sh
```

Installer zrobi wszystko automatycznie. Po drodze zapyta:

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
> Instalacja Claude Code (i wielu narzędzi CLI) odpala skrypt prosto z internetu — to wygodne, ale wykonujesz kod, którego nie widziałeś. Świadomie omija to ostrzeżenia Gatekeeper (Mac) / SmartScreen (Windows). Zanim odpalisz, możesz **najpierw obejrzeć skrypt**:
> - Mac/Linux: `curl -fsSL https://claude.ai/install.sh -o install.sh` → otwórz `install.sh` w edytorze → dopiero potem `bash install.sh`
> - Windows: `irm https://claude.ai/install.ps1 -OutFile install.ps1` → otwórz `install.ps1` → dopiero potem `.\install.ps1`
>
> Installer Pulsa (`install.sh` / `install.ps1`) pobiera przenośny Node z `nodejs.org` i **weryfikuje sumę kontrolną `SHASUMS256`** przed rozpakowaniem — uszkodzone lub podmienione archiwum przerywa instalację.

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

#### Krok 2 — Stwórz folder na projekt

Wybierz folder w którym chcesz trzymać claude-cron i wejdź do niego w terminalu. Przykład:

```bash
cd ~/Documents
```

#### Krok 3 — Sklonuj repo

```bash
git clone https://github.com/AIBiz-Automatyzacje/claude-cron.git
cd claude-cron
```

#### Krok 4 — Uruchom installer

```bash
bash install.sh
```

`install.sh` to cienki bootstrap: stawia przenośny Node w `.node/` (weryfikując sumę `SHASUMS256` z nodejs.org), a potem przekazuje sterowanie do `setup.mjs`, który pyta o konfigurację. Następnie pyta o 2 rzeczy:

| Krok | Co wpisać |
|------|-----------|
| **1. Workspace** | Folder w którym Claude ma wykonywać joby (najczęściej Twój vault Obsidian). **Tip:** przeciągnij folder z Findera do terminala — automatycznie wklei ścieżkę |
| **2. Autostart** | `Y` — serwer startuje automatycznie z każdą sesją Claude Code |

#### Krok 5 — Odpal serwer

```bash
.node/node-v22.17.0-darwin-arm64/bin/node server.js
```

> **Procesor Intel?** Zamień w ścieżce `darwin-arm64` na `darwin-x64`. Jeśli włączyłeś autostart, możesz ten krok pominąć — hook autostartu odpala serwer sam (z wypaloną ścieżką do portable Node).

> **To pierwszy i ostatni raz kiedy uruchamiasz serwer ręcznie.** Jeśli włączyłeś autostart — od następnej sesji Claude Code serwer odpali się sam w tle. Nie musisz nic robić.

#### Krok 6 — Sprawdź dashboard

Otwórz w przeglądarce: **[http://localhost:7777](http://localhost:7777)**

Powinieneś zobaczyć retro arcade dashboard. Gotowe! 🎉

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

#### Krok 2 — Stwórz folder na projekt

W Eksploratorze plików stwórz folder gdzie chcesz, np. `C:\Users\<ty>\Documents\Kodowanie\`. Potem **kliknij prawym przyciskiem na folder → "Open in Terminal"** (Windows 11) lub otwórz PowerShell i wejdź do folderu:

```powershell
cd $env:USERPROFILE\Documents\Kodowanie
```

#### Krok 3 — Sklonuj repo

```powershell
git clone https://github.com/AIBiz-Automatyzacje/claude-cron.git
cd claude-cron
```

#### Krok 4 — Uruchom installer

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` to cienki bootstrap: stawia przenośny Node w `.node\` (weryfikując sumę `SHASUMS256` z nodejs.org), a potem przekazuje sterowanie do `setup.mjs`, który pyta o konfigurację. Następnie pyta o 2 rzeczy:

| Krok | Co wpisać |
|------|-----------|
| **1. Workspace** | **Wklej pełną ścieżkę** do folderu, np. `C:\Users\kacpe\OneDrive\Obsidian\Vault`. Drag & drop z Eksploratora **nie działa** w PowerShell — musisz wkleić ścieżkę ręcznie |
| **2. Autostart** | `Y` — serwer startuje automatycznie z Claude Code |

#### Krok 5 — Odpal serwer

```powershell
.node\node-v22.17.0-win-x64\node.exe server.js
```

> Jeśli włączyłeś autostart, możesz ten krok pominąć — hook autostartu odpala serwer sam (z wypaloną ścieżką do portable Node).

#### Krok 6 — Sprawdź dashboard

Otwórz w przeglądarce: **[http://localhost:7777](http://localhost:7777)**

Gotowe! 🎉

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
| Uruchomić ręcznie | `cd ~/Documents/Kodowanie/claude-cron && .node/node-v22.17.0-darwin-arm64/bin/node server.js` |
| Zaktualizować kod | `cd ~/Documents/Kodowanie/claude-cron && git pull` |
| Sprawdzić co zajmuje port | `lsof -i :7777` |

### 🪟 Windows

| Co chcesz zrobić | Komenda |
|------------------|---------|
| Uruchomić ręcznie | `cd $env:USERPROFILE\Documents\Kodowanie\claude-cron; .node\node-v22.17.0-win-x64\node.exe server.js` |
| Zaktualizować kod | `cd $env:USERPROFILE\Documents\Kodowanie\claude-cron; git pull` |
| Sprawdzić co zajmuje port | `netstat -ano \| findstr :7777` |
| Uruchomić na innym porcie | `$env:CLAUDE_CRON_PORT=7778; .node\node-v22.17.0-win-x64\node.exe server.js` |

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

🍎 Mac:
```bash
lsof -i :7777
CLAUDE_CRON_PORT=7778 .node/node-v22.17.0-darwin-arm64/bin/node server.js
```

🪟 Windows:
```powershell
netstat -ano | findstr :7777
$env:CLAUDE_CRON_PORT = 7778
.node\node-v22.17.0-win-x64\node.exe server.js
```

---

## Odinstalowanie

### 🍎 Mac

1. Usuń hook z `{workspace}/.claude/settings.json` (sekcja `hooks.UserPromptSubmit`, wpis z `claude-cron-autostart`)
2. Usuń z `~/.zshrc` zmienne `CLAUDE_CRON_VPS_URL`, `CLAUDE_CRON_WORKSPACE`, `DISCORD_WEBHOOK_URL`
3. Usuń folder repo:
   ```bash
   rm -rf ~/Documents/Kodowanie/claude-cron
   ```

### 🪟 Windows

1. Usuń hook z `{workspace}\.claude\settings.json`
2. Usuń zmienne i pliki:
   ```powershell
   [Environment]::SetEnvironmentVariable('CLAUDE_CRON_WORKSPACE', $null, 'User')
   [Environment]::SetEnvironmentVariable('CLAUDE_CRON_VPS_URL', $null, 'User')
   [Environment]::SetEnvironmentVariable('DISCORD_WEBHOOK_URL', $null, 'User')
   Remove-Item -Recurse -Force $env:USERPROFILE\Documents\Kodowanie\claude-cron
   ```

> Dane (historia jobów, baza SQLite) są w folderze `data/` wewnątrz repo — usuwane razem z nim.
