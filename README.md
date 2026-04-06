# 🕹️ Claude-Cron

Automatyczny scheduler dla [Claude Code](https://claude.ai/code). Ustawiasz co i kiedy ma się odpalić — Claude robi resztę. Dashboard w stylu retro arcade do zarządzania wszystkim.

**Działa na:** 🍎 macOS · 🪟 Windows · 🐧 Linux (VPS)

## Co to robi?

- **Harmonogram** — Claude odpala Twoje skille/prompty o wybranej godzinie (codziennie, co X godzin, w wybrane dni)
- **Webhoki** — zewnętrzne serwisy (Make, n8n, Zapier) mogą triggerować joby przez link
- **Dashboard** — przeglądarka, `localhost:7777`, zarządzasz jobami, widzisz historię, przeglądasz skille
- **VPS 24/7** — joby lecą non-stop na serwerze, nawet gdy śpisz
- **Powiadomienia Discord** — wynik joba ląduje na Twojego Discorda

---

## Czego potrzebujesz?

### Wspólne dla obu platform
1. **Node.js 18+** — [pobierz tutaj](https://nodejs.org)
2. **Claude Code** zainstalowany i zalogowany — `npm install -g @anthropic-ai/claude-code`, potem `claude` żeby się zalogować
3. **Tailscale** (opcjonalnie) — jeśli chcesz połączyć się z VPS-em ([pobierz tutaj](https://tailscale.com/download))
4. **Serwer VPS** z Linuxem (opcjonalnie) — jeśli chcesz joby 24/7

### Dodatkowo na 🪟 Windows
5. **Git for Windows** — [pobierz tutaj](https://git-scm.com/download/win)
6. **Visual Studio Build Tools** — wymagane przez `better-sqlite3` ([pobierz tutaj](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — zaznacz "Desktop development with C++")
7. **Claude CLI w PATH** — jeśli `claude` nie działa po instalacji, wklej w PowerShell:
   ```powershell
   $claudePath = "$env:USERPROFILE\.local\bin"
   [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";$claudePath", "User")
   $env:Path += ";$claudePath"
   ```

---

## Instalacja

> Najpierw VPS (jeśli go używasz), potem komputer lokalny.
>
> *Nie masz VPS-a?* Pomiń krok 1 — claude-cron zadziała tylko lokalnie.

### Krok 1 — Instalacja na VPS (Linux)

Połącz się z VPS-em:

```bash
ssh root@TWOJE_IP_SERWERA
```

Zainstaluj wymagane narzędzia i uruchom installer:

```bash
apt update && apt install -y git curl
git clone https://github.com/AIBiz-Automatyzacje/claude-cron.git /tmp/claude-cron-install && bash /tmp/claude-cron-install/scripts/install-vps.sh
```

Installer zrobi wszystko automatycznie. Po drodze zapyta Cię o:

| Pytanie | Co wpisać |
|---------|-----------|
| **Log in to Claude CLI** | `Y` — przejdź logowanie w przeglądarce, potem `/exit` i `exit` |
| **Ścieżka do workspace** | Np. `/home/claude/vault` |
| **Port** | Enter (domyślny 7777) |
| **Discord webhook** | URL webhooka albo puste — Enter |
| **Timezone** | Enter (domyślnie Europe/Warsaw) |
| **Tailscale Funnel** | `Y` jeśli chcesz webhoki |
| **Auto-update cron** | `Y` — codzienna aktualizacja kodu o 6:00 |

**Na końcu installer pokaże Tailscale IP** — zapisz je! Potrzebujesz go w kroku 2.

```bash
tailscale ip -4
```

---

### Krok 2 — Instalacja lokalna

Stwórz folder gdzie chcesz trzymać projekt (np. `~/Documents/Kodowanie/`), otwórz tam terminal i sklonuj repo:

#### 🍎 Mac

```bash
git clone https://github.com/AIBiz-Automatyzacje/claude-cron.git
cd claude-cron
bash setup.sh
```

Setup pyta o 4 rzeczy:

| Krok | Co wpisać |
|------|-----------|
| **1. Tailscale IP VPS-a** | Wklej IP z kroku 1, np. `100.86.100.113` (puste = tryb lokalny) |
| **2. Workspace** | Przeciągnij folder z Findera do terminala |
| **3. Autostart** | `Y` — serwer startuje automatycznie z Claude Code |
| **4. Discord** | URL webhooka albo puste — Enter |

Po zakończeniu wklej:

```bash
source ~/.zshrc
```

#### 🪟 Windows

W **PowerShell**:

```powershell
git clone https://github.com/AIBiz-Automatyzacje/claude-cron.git
cd claude-cron
powershell -ExecutionPolicy Bypass -File setup-windows.ps1
```

Setup pyta o te same 4 rzeczy. Po zakończeniu **otwórz nowy terminal** (zmienne środowiskowe załadują się dopiero w nowej sesji).

---

### Krok 3 — Sprawdź czy działa

Otwórz przeglądarkę:

```
http://localhost:7777
```

Powinieneś zobaczyć dashboard z przełącznikiem **LOCAL / VPS** na górze:

- **LOCAL** (zielony) — joby lecą lokalnie na Twoim komputerze
- **VPS** (magenta) — joby lecą na serwerze 24/7

Kliknij **VPS** i sprawdź czy się łączy. Jeśli widzisz dane z serwera — wszystko działa! 🎉

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
| Uruchomić ręcznie | `cd ~/<sciezka>/claude-cron && node server.js` |
| Otworzyć dashboard | `http://localhost:7777` w przeglądarce |

### 🪟 Windows

| Co chcesz zrobić | Komenda |
|------------------|---------|
| Uruchomić ręcznie | `cd $env:USERPROFILE\<sciezka>\claude-cron; node server.js` |
| Otworzyć dashboard | `http://localhost:7777` w przeglądarce |
| Sprawdzić co zajmuje port | `netstat -ano \| findstr :7777` |
| Uruchomić na innym porcie | `$env:CLAUDE_CRON_PORT=7778; node server.js` |

### Na VPS-ie (przez SSH)

| Co chcesz zrobić | Komenda |
|------------------|---------|
| Sprawdzić czy działa | `systemctl status claude-cron` |
| Zobaczyć logi na żywo | `journalctl -u claude-cron -f` |
| Zrestartować serwis | `systemctl restart claude-cron` |
| Zaktualizować kod | `su - claude -c 'cd ~/claude-cron && git pull'` + `systemctl restart claude-cron` |
| Sprawdzić Tailscale IP | `tailscale ip -4` |

> Jeśli zainstalowałeś autostart — serwer startuje sam przy każdym uruchomieniu Claude Code w Twoim workspace'cie. Nie musisz nic robić.

---

## Rozwiązywanie problemów

### 🪟 Windows: `claude` nie jest rozpoznawany

Claude CLI nie został dodany do PATH. Wklej w PowerShell:

```powershell
$claudePath = "$env:USERPROFILE\.local\bin"
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";$claudePath", "User")
$env:Path += ";$claudePath"
```

Zamknij i otwórz nowy terminal.

### 🪟 Windows: `npm install` nie działa (node-gyp / MSBuild error)

Potrzebujesz Visual Studio Build Tools:

1. Pobierz: https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. Zaznacz **Desktop development with C++**
3. Zainstaluj i uruchom `npm install` ponownie

### Dashboard nie wczytuje danych z VPS-a

Sprawdź czy Tailscale działa na obu urządzeniach. Na Mac:
```bash
tailscale status
```
Na Windows otwórz aplikację Tailscale i sprawdź czy VPS jest widoczny.

### Joby się nie odpalają na VPS-ie

Sprawdź logi:
```bash
journalctl -u claude-cron -n 30
```

Najczęstsza przyczyna: Claude CLI nie jest zalogowany. Napraw tak:
```bash
su - claude
claude
# przejdź logowanie w przeglądarce
exit
sudo systemctl restart claude-cron
```

### Joby odpalają się o złej godzinie

Serwer może mieć inną strefę czasową:
```bash
timedatectl
timedatectl set-timezone Europe/Warsaw
sudo systemctl restart claude-cron
```

### Port 7777 jest zajęty

🍎 Mac:
```bash
lsof -i :7777
CLAUDE_CRON_PORT=7778 node server.js
```

🪟 Windows:
```powershell
netstat -ano | findstr :7777
$env:CLAUDE_CRON_PORT = 7778
node server.js
```

---

## Odinstalowanie

### 🍎 Mac

Usuń hook z `{workspace}/.claude/settings.json` (sekcja `hooks.UserPromptSubmit`) i z `~/.zshrc` zmienne `CLAUDE_CRON_VPS_URL`, `CLAUDE_CRON_WORKSPACE`, `DISCORD_WEBHOOK_URL`. Potem:

```bash
rm -rf ~/<sciezka>/claude-cron
```

### 🪟 Windows

Usuń hook z `{workspace}\.claude\settings.json`, potem:

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_CRON_WORKSPACE', $null, 'User')
[Environment]::SetEnvironmentVariable('CLAUDE_CRON_VPS_URL', $null, 'User')
[Environment]::SetEnvironmentVariable('DISCORD_WEBHOOK_URL', $null, 'User')
Remove-Item -Recurse -Force $env:USERPROFILE\<sciezka>\claude-cron
```

Dane (historia jobów, baza SQLite) są w folderze `data/` wewnątrz repo — usuwane razem z nim.
