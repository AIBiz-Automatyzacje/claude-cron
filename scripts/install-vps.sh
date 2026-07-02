#!/usr/bin/env bash
# -E (errtrace): trap ERR musi być dziedziczony do funkcji, inaczej rollback
# nie odpali się dla błędu wewnątrz funkcji-komponentu.
set -Eeuo pipefail

# ============================================
#  PULS (claude-cron) — Instalator VPS
#  Interaktywna instalacja na Linux VPS (Debian/Ubuntu)
#  Uruchom jako root: sudo bash install-vps.sh
#
#  Struktura: stałe → helpery (log/tty/rollback/login) →
#  funkcje-komponenty → main "$@" za guardem lib-only.
#  Test harness ładuje same funkcje (CLAUDE_CRON_LIB_ONLY=1),
#  bez odpalania main — wzorzec z install.sh / install.test.sh.
# ============================================

# ============ STAŁE ============

# Env-override źródła kodu — pozwala przetestować instalator z forka/brancha
# prawdziwym `curl|bash` PRZED mergem (wzorzec CLAUDE_CRON_TARBALL_URL z install.sh).
REPO="${CLAUDE_CRON_REPO:-https://github.com/AIBiz-Automatyzacje/claude-cron.git}"
REF="${CLAUDE_CRON_REF:-main}"

# One-liner instalacji do komunikatu resume (R6 spec-u: „wklej tę samą komendę").
# W podstawowym trybie dostarczenia (R2: curl | sudo bash) plik install-vps.sh
# NIE istnieje lokalnie, więc instrukcja „sudo bash install-vps.sh" kończyłaby
# się „No such file or directory" — pokazujemy pełną komendę do wklejenia.
RESUME_ONE_LINER="curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash"

SERVICE_NAME="claude-cron"
CLAUDE_USER="claude"

DEFAULT_PORT=7777
DEFAULT_TZ="Europe/Warsaw"

# Wspierany zakres Node — node:sqlite stabilne dopiero od 22.13, górna granica
# wykluczająca <25 (spójne z package.json "engines >=22.13 <25" i lib/config.js
# MIN_NODE_VERSION/MAX_NODE_VERSION). Bez górnej granicy instalator/cron-guard
# zrestartowałby serwis na Node 25+, który lib/runtime-guard.js ubije exit(1)
# przy starcie — dokładnie scenariusz padu jobów, któremu guard ma zapobiegać.
# Format: major.minor (min) i major (max, wykluczające).
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13
MAX_NODE_MAJOR=25

# Maksymalna liczba prób w bloku loginów (run_login), zanim instalator
# czysto zatrzyma się w trybie leave-partial.
LOGIN_MAX_ATTEMPTS=3

# Maksymalna liczba ponowień pytania z walidacją (ask_valid), zanim instalator
# sfailuje — chroni przed pętlą bez końca, gdy tty w kółko oddaje tę samą
# niepoprawną odpowiedź (martwy/wstrzyknięty tty, przypadkowy pipe).
ASK_MAX_ATTEMPTS=3

# Urządzenie terminala do pytań interaktywnych. Pod `curl|bash` stdin to pipe
# z treścią skryptu (gołe `read` dostaje EOF), więc odpowiedzi czytamy z /dev/tty.
# Override przez env / testy (wstrzyknięcie pliku = symulacja odpowiedzi).
TTY_DEVICE="${CLAUDE_CRON_TTY_DEVICE:-/dev/tty}"

# Kolory
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ============ FLAGI (parse_flags) ============

# Bez flag = pełna instalacja (Obsidian + Puls). Flagi sterują fazami
# w kolejnych Implementation Units (preflight/pytania/Obsidian/reset).
FLAG_ONLY_PULS=0       # --only-puls / --no-obsidian: pomiń kroki Obsidianowe
FLAG_RESET=0           # --reset: deinstalacja (osobna ścieżka, IU7)
FLAG_PORT=""           # --port <n>
FLAG_TZ=""             # --tz <tz>
FLAG_DEVICE=""         # --device-name <s> (default: vps-<hostname>, zob. resolve_auto_values)
FLAG_NO_AUTO_UPDATE=0  # --no-auto-update: opt-out z crona 02:00

# ============ HELPERY: LOG ============

info()  { echo -e "${CYAN}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}  ✓${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; exit 1; }
ask()   { echo -en "${BOLD}$1${NC}"; }

usage() {
  cat <<'USAGE'
Użycie: sudo bash install-vps.sh [flagi]

Flagi:
  --only-puls         instaluj tylko Puls (pomiń Obsidian + LiveSync)
  --no-obsidian       to samo co --only-puls
  --reset             deinstalacja (usuwa serwisy, usera, vault) — nie łączy się
                      z --only-puls / --no-obsidian
  --port <n>          port serwera Puls (domyślnie 7777)
  --tz <tz>           strefa czasowa (domyślnie autodetekcja / Europe/Warsaw)
  --device-name <s>   nazwa urządzenia dla Obsidian Sync (domyślnie vps-<hostname>)
  --no-auto-update    bez codziennego crona auto-update (02:00)
  --help              ten ekran
USAGE
}

# ============ HELPERY: FLAGI ============

# Walidacja flagi --port (port to auto-wartość — spec FAZA 1 nie ma pytania
# o port). Sama cyfra nie wystarczy: 0 i >65535 są nieadresowalne, a śmieć
# typu "7777x" szedłby dalej do ufw/systemd/tailscale funnel — błąd ufw
# maskuje `|| true`, więc reguła DENY cicho by nie powstała, a summary kłamało.
is_valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

parse_flags() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --only-puls|--no-obsidian) FLAG_ONLY_PULS=1 ;;
      --reset) FLAG_RESET=1 ;;
      --port)
        shift
        [ "$#" -gt 0 ] || fail "Flaga --port wymaga wartości (np. --port 7777)."
        FLAG_PORT="$1"
        ;;
      --tz)
        shift
        [ "$#" -gt 0 ] || fail "Flaga --tz wymaga wartości (np. --tz Europe/Warsaw)."
        FLAG_TZ="$1"
        ;;
      --device-name)
        shift
        [ "$#" -gt 0 ] || fail "Flaga --device-name wymaga wartości (np. --device-name vps-1)."
        FLAG_DEVICE="$1"
        ;;
      --no-auto-update) FLAG_NO_AUTO_UPDATE=1 ;;
      --help|-h) usage; exit 0 ;;
      *) fail "Nieznana flaga: $1 (zobacz: bash install-vps.sh --help)" ;;
    esac
    shift
  done

  # --reset to osobna ścieżka (deinstalacja) — flagi zakresu instalacji nie mają sensu.
  if [ "$FLAG_RESET" = 1 ] && [ "$FLAG_ONLY_PULS" = 1 ]; then
    fail "Flaga --reset nie łączy się z --only-puls / --no-obsidian."
  fi

  if [ -n "$FLAG_PORT" ] && ! is_valid_port "$FLAG_PORT"; then
    fail "Flaga --port wymaga liczby z zakresu 1-65535, otrzymano: $FLAG_PORT"
  fi

  PORT="${FLAG_PORT:-$DEFAULT_PORT}"
}

# ============ HELPERY: TTY ============

# ask_tty VAR "prompt" ["default"] — JEDYNE miejsce z `read` w instalatorze.
# Pod curl|bash stdin to pipe, więc odpowiedź czytamy z TTY_DEVICE (/dev/tty).
# Fallback bez terminala: przyjmij default; pytanie bez defaultu = twardy fail
# (lepiej zatrzymać niż cicho zainstalować ze złą konfiguracją).
ask_tty() {
  local __var="$1" __prompt="$2" __default="${3-}" __has_default=0 __answer="" __tty_ok=0
  [ "$#" -ge 3 ] && __has_default=1

  # Probe otwarcia zamiast [ -r ]: /dev/tty ma prawa rw-rw-rw-, więc -r zwraca
  # true nawet bez kontrolującego terminala (ssh bez -t, cron, CI) — dopiero
  # open() pada z ENXIO, a `read || __answer=""` połykałby ten błąd jak EOF
  # i pytanie bez defaultu cicho zwracałoby pusty string zamiast twardego faila.
  if { : < "$TTY_DEVICE"; } 2>/dev/null; then
    __tty_ok=1
    ask "$__prompt"
    if ! read -r __answer < "$TTY_DEVICE" 2>/dev/null; then
      # rc!=0 to EOF (Ctrl+D = pusta odpowiedź) ALBO błąd redirekcji (tty
      # zniknął między probe a read). Ponowny probe je rozróżnia: po EOF tty
      # wciąż daje się otworzyć, po błędzie redirekcji nie → gałąź bez tty.
      __answer=""
      { : < "$TTY_DEVICE"; } 2>/dev/null || __tty_ok=0
    fi
  fi

  if [ "$__tty_ok" -eq 0 ]; then
    if [ "$__has_default" -eq 1 ]; then
      warn "Brak terminala ($TTY_DEVICE) — przyjmuję wartość domyślną: ${__prompt}${__default}"
    else
      fail "Brak terminala ($TTY_DEVICE) — nie mogę zadać pytania bez wartości domyślnej: ${__prompt}"
    fi
  fi

  if [ -z "$__answer" ] && [ "$__has_default" -eq 1 ]; then
    __answer="$__default"
  fi
  printf -v "$__var" '%s' "$__answer"
}

# ask_valid VAR "prompt" validator "komunikat błędu" ["default"] — pytanie
# z walidacją i ponowieniem. Wniosek z review fazy 1: walidacja musi być
# SYMETRYCZNA flaga↔prompt — KAŻDA odpowiedź z tty przechodzi walidator,
# nie tylko wartości z flag. Po ASK_MAX_ATTEMPTS niepoprawnych → fail
# (bez limitu martwy tty oddawałby w kółko tę samą złą odpowiedź).
ask_valid() {
  local __out="$1" __prompt="$2" __validator="$3" __errmsg="$4" __attempt __ans=""
  for (( __attempt=1; __attempt<=ASK_MAX_ATTEMPTS; __attempt++ )); do
    if [ "$#" -ge 5 ]; then
      ask_tty __ans "$__prompt" "$5"
    else
      ask_tty __ans "$__prompt"
    fi
    if "$__validator" "$__ans"; then
      printf -v "$__out" '%s' "$__ans"
      return 0
    fi
    warn "$__errmsg"
  done
  fail "Zbyt wiele niepoprawnych odpowiedzi na pytanie: $__prompt"
}

# ============ HELPERY: WALIDACJA I NORMALIZACJA (czyste funkcje) ============

# Wartości idące później do komend/unitów (repo, webhook) mają regexy bez
# białych znaków — wniosek z review fazy 1 (input w komendach cron/su/sed).

is_valid_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]]; }

is_nonempty() { [ -n "$1" ]; }

# Puste = pomiń (webhook jest opcjonalny). Niepuste: prefix Discorda + bez
# białych znaków (wartość trafia do linii Environment= w unicie systemd).
is_valid_discord_webhook() {
  [ -z "$1" ] && return 0
  [[ "$1" =~ ^https://discord\.com/api/webhooks/[^[:space:]]+$ ]]
}

# normalize_repo <input> — `user/repo` → https://github.com/user/repo.git;
# pełny URL https → bez zmian; ssh/śmieci → exit 1. Tu tylko walidacja
# FORMATU — walidacja DOSTĘPU (gh repo view) dopiero po gh login (Faza 4).
normalize_repo() {
  local input="$1"
  if [[ "$input" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]]; then
    printf 'https://github.com/%s.git\n' "${input%.git}"
    return 0
  fi
  if [[ "$input" =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9-]+/[A-Za-z0-9._-]+(\.git)?$ ]]; then
    printf '%s\n' "$input"
    return 0
  fi
  return 1
}

is_valid_repo_format() { normalize_repo "$1" >/dev/null; }

# Normalizacja ścieżki z inputu: zdejmij cudzysłowy, backslash-escapy
# i brzegowe spacje (drag & drop dodaje escapy), rozwiń ~ na home usera claude.
normalize_path() {
  local p="$1"
  p="${p//\'/}"
  p="${p//\"/}"
  p="${p//\\/}"
  p="${p%% }"
  p="${p## }"
  p="${p/#\~/$CLAUDE_HOME}"
  printf '%s\n' "$p"
}

# detect_timezone <wynik timedatectl> — pusta autodetekcja (kontener/minimalny
# obraz bez timedatectl) → fallback Europe/Warsaw.
detect_timezone() {
  local detected="${1-}"
  if [ -n "$detected" ]; then
    printf '%s\n' "$detected"
  else
    printf '%s\n' "$DEFAULT_TZ"
  fi
}

# ============ HELPERY: ROLLBACK ============

# Stos akcji cofających. Komponenty rejestrują TYLKO to, co same zmieniły
# w tym runie (guard-first, potem push_rollback) — nigdy cudzego stanu.
ROLLBACK_STACK=()
ROLLBACK_ENABLED=1

push_rollback()    { ROLLBACK_STACK+=("$1"); }
disable_rollback() { ROLLBACK_ENABLED=0; }
enable_rollback()  { ROLLBACK_ENABLED=1; }

# Trap ERR: odwija stos w ODWROTNEJ kolejności (LIFO) i wypisuje każdy
# cofnięty krok. Przy wyłączonym rollbacku (blok loginów) tylko kończy
# z oryginalnym kodem błędu.
on_err() {
  local status=$?
  trap - ERR
  if [ "$ROLLBACK_ENABLED" != "1" ] || [ "${#ROLLBACK_STACK[@]}" -eq 0 ]; then
    exit "$status"
  fi
  echo ""
  warn "Błąd instalacji — cofam kroki wykonane w tym uruchomieniu:"
  local i
  for (( i=${#ROLLBACK_STACK[@]}-1; i>=0; i-- )); do
    warn "  ↩ ${ROLLBACK_STACK[i]}"
    bash -c "${ROLLBACK_STACK[i]}" || warn "    (nie udało się cofnąć: ${ROLLBACK_STACK[i]})"
  done
  exit "$status"
}

# Czyste zatrzymanie w trybie leave-partial (blok loginów): dotychczasowe
# kroki ZOSTAJĄ (bez rollbacku), user dostaje instrukcję wznowienia.
halt_leave_partial() {
  local desc="$1"
  disable_rollback
  echo ""
  warn "Instalacja ZATRZYMANA na kroku: $desc"
  warn "Wykonane dotąd kroki NIE zostały cofnięte."
  warn "Dokończ ten krok ręcznie lub wklej ponownie tę samą komendę instalacji:"
  warn "  $RESUME_ONE_LINER"
  exit 1
}

# ============ HELPERY: LOGIN Z RETRY ============

# run_login "opis" login_cmd verify_cmd — pojedyncza pauza interaktywna:
# handoff logowania przez /dev/tty → natychmiastowa weryfikacja → przy failu
# pytanie o ponowienie. Po LOGIN_MAX_ATTEMPTS nieudanych próbach (lub
# rezygnacji usera) → halt_leave_partial (exit ≠ 0, BEZ rollbacku).
run_login() {
  local desc="$1" login_cmd="$2" verify_cmd="$3" attempt retry
  for (( attempt=1; attempt<=LOGIN_MAX_ATTEMPTS; attempt++ )); do
    info "Logowanie: $desc (próba $attempt/$LOGIN_MAX_ATTEMPTS)"
    # Proces logowania dostaje klawiaturę przez /dev/tty (stdin pod curl|bash
    # to pipe). Exit code loginu ignorujemy — prawdę mówi verify_cmd.
    # Probe otwarcia, nie [ -r ] — zob. komentarz w ask_tty (ENXIO bez ctty).
    if { : < "$TTY_DEVICE"; } 2>/dev/null; then
      bash -c "$login_cmd" < "$TTY_DEVICE" || true
    else
      bash -c "$login_cmd" || true
    fi
    if bash -c "$verify_cmd"; then
      ok "$desc — zweryfikowano"
      return 0
    fi
    warn "$desc — weryfikacja nie powiodła się."
    if [ "$attempt" -lt "$LOGIN_MAX_ATTEMPTS" ]; then
      retry=""
      ask_tty retry "Spróbować ponownie? [T/n]: " "T"
      if [[ "$retry" =~ ^[Nn]$ ]]; then
        halt_leave_partial "$desc"
      fi
    fi
  done
  halt_leave_partial "$desc"
}

# ============ GUARDY DETEKCJI STANU (has_*) ============

# Baza idempotencji/resume (FAZA 0 spec-u): 0 = zrobione (pomiń krok),
# 1 = do zrobienia. Odporność: najpierw command -v / istnienie usera, potem
# exit code narzędzia — parsowania tekstu unikamy (formaty wyjść ob/gh mogą
# się zmieniać, `obsidian-headless` to młody pakiet). DI wzorem setup.test.mjs:
# testy podmieniają run_as_claude/has_user_claude i wstrzykują atrapy przez PATH.

# Wykonanie komendy jako user claude — jedyny szew DI guardów per-user.
run_as_claude() { su - "$CLAUDE_USER" -c "$1"; }

has_user_claude() { id -u "$CLAUDE_USER" &>/dev/null; }

has_supported_node() {
  command -v node &>/dev/null || return 1
  is_node_supported
}

# Claude CLI jest per-user (~/.local/bin). Sygnał zalogowania: niepusty
# ~/.claude/.credentials.json — exit-code-first, bez odpalania CLI;
# nieinteraktywny probe `claude -p` to weryfikacja PO loginie (Faza 4).
has_claude_auth() {
  has_user_claude || return 1
  run_as_claude "command -v claude" &>/dev/null || return 1
  run_as_claude "test -s ~/.claude/.credentials.json" &>/dev/null
}

has_gh_auth() {
  command -v gh &>/dev/null || return 1
  has_user_claude || return 1
  run_as_claude "gh auth status" &>/dev/null
}

# DWA OSOBNE checki Obsidiana (spec FAZA 0): zgrubny pojedynczy check mógłby
# pominąć niedokończony sync-setup i zostawić usera w half-configured stanie.
# `ob login` bez argumentów: zalogowany → pokazuje konto (exit 0);
# </dev/null — żeby niezalogowany ob nie zawisł na interaktywnym pytaniu.
has_ob_auth() {
  has_user_claude || return 1
  run_as_claude "command -v ob" &>/dev/null || return 1
  run_as_claude "ob login </dev/null" &>/dev/null
}

has_ob_sync() {
  has_user_claude || return 1
  run_as_claude "command -v ob" &>/dev/null || return 1
  run_as_claude "ob sync-status --path ~/vault" &>/dev/null
}

has_service() {
  command -v systemctl &>/dev/null || return 1
  systemctl is-active --quiet "$1" 2>/dev/null
}

has_tailscale_ip() {
  command -v tailscale &>/dev/null || return 1
  [ -n "$(tailscale ip -4 2>/dev/null || true)" ]
}

# ============ KOMPONENTY ============

print_banner() {
  echo ""
  echo -e "${CYAN}🕹️  PULS — instalacja na VPS${NC}"
  echo "========================================"
  echo ""
}

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "Uruchom jako root: sudo bash install-vps.sh"
  fi
}

# is_supported_os [plik_os_release] — Debian/Ubuntu po polach ID / ID_LIKE.
# DI: ścieżka pliku wstrzykiwana w testach.
is_supported_os() {
  local os_release="${1:-/etc/os-release}"
  [ -r "$os_release" ] || return 1
  grep -Eq '^(ID|ID_LIKE)=.*(debian|ubuntu)' "$os_release"
}

# Internet sprawdzamy na api.github.com — to i tak pierwsze źródło pobrań.
check_internet() {
  curl -fsI --max-time 15 https://api.github.com >/dev/null 2>&1
}

# Checklist prerequisites (6 pozycji ze spec-u) — kursant potwierdza Enterem,
# ZANIM cokolwiek zostanie zainstalowane.
show_prerequisites_checklist() {
  echo ""
  echo -e "${CYAN}Zanim zaczniemy — upewnij się, że masz:${NC}"
  echo "  1. Świeży VPS (Ubuntu) z dostępem root przez SSH"
  echo "  2. Konto Obsidian + vault lokalny + remote vault (Obsidian Sync)"
  echo "  3. Hasło szyfrowania end-to-end remote vaulta (to INNE hasło niż do konta!)"
  echo "  4. Prywatne repo GitHub z katalogiem .claude"
  echo "  5. Konto GitHub (logowanie gh przez przeglądarkę)"
  echo "  6. Konto Tailscale"
  echo ""
  local go=""
  ask_tty go "Masz wszystko? [Enter = mam wszystko]: " ""
}

print_state_line() {
  local label="$1"
  shift
  if "$@"; then
    ok "$label — już gotowe (pominę)"
  else
    echo "    • $label — do zrobienia"
  fi
}

# Detekcja stanu (FAZA 0) — baza idempotencji/resume: pokazuje kursantowi,
# co już jest zrobione. Kroki Faz 3–5 pomijają gotowe przez TE SAME guardy.
print_detected_state() {
  echo ""
  info "Sprawdzam, co już jest zainstalowane (re-run pomija gotowe kroki):"
  print_state_line "użytkownik '$CLAUDE_USER'" has_user_claude
  print_state_line "Node.js >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} <${MAX_NODE_MAJOR}" has_supported_node
  print_state_line "Claude CLI zalogowany" has_claude_auth
  print_state_line "GitHub CLI (gh) zalogowany" has_gh_auth
  if [ "$FLAG_ONLY_PULS" != 1 ]; then
    print_state_line "Obsidian: zalogowany (ob)" has_ob_auth
    print_state_line "Obsidian: sync skonfigurowany" has_ob_sync
    print_state_line "serwis obsidian-sync" has_service obsidian-sync
  fi
  print_state_line "serwis $SERVICE_NAME" has_service "$SERVICE_NAME"
  print_state_line "Tailscale połączony" has_tailscale_ip
}

# FAZA 0: sanity-checki → checklist prerequisites → detekcja stanu.
run_preflight() {
  check_root
  is_supported_os || fail "Wspierany system to Debian/Ubuntu — w /etc/os-release nie ma wpisu debian/ubuntu."
  check_internet || fail "Brak połączenia z internetem (api.github.com nie odpowiada) — sprawdź sieć na VPS."
  ok "System Debian/Ubuntu, uprawnienia root, internet działa"
  show_prerequisites_checklist
  print_detected_state
}

# Zwraca 0 (true) gdy zainstalowany Node mieści się w [MIN.MIN_MINOR, MAX_MAJOR)
# — czyli >= 22.13 ORAZ major < 25 (górna granica wykluczająca, spójna z "engines").
# node:sqlite jest stabilne dopiero od 22.13 — niższy Node wywala serwer przy starcie
# (lib/runtime-guard.js); Node 25+ też (górna granica), więc oba progi muszą blokować.
is_node_supported() {
  local raw major minor
  raw=$(node -v 2>/dev/null | sed 's/v//')
  major=$(echo "$raw" | cut -d. -f1)
  minor=$(echo "$raw" | cut -d. -f2)
  [ -n "$major" ] && [ -n "$minor" ] || return 1
  # Górna granica wykluczająca: major >= MAX_NODE_MAJOR (25+) → niewspierane.
  if [ "$major" -ge "$MAX_NODE_MAJOR" ]; then
    return 1
  fi
  if [ "$major" -gt "$MIN_NODE_MAJOR" ]; then
    return 0
  fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; then
    return 0
  fi
  return 1
}

ensure_node() {
  info "Sprawdzam Node.js..."

  if command -v node &>/dev/null; then
    if ! is_node_supported; then
      warn "Node.js $(node -v) jest niewspierany (wymagane >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} <${MAX_NODE_MAJOR} dla node:sqlite)"
      local install_node=""
      ask_tty install_node "Zainstalować Node.js 22 LTS? [T/n]: " "T"
      if [[ "$install_node" =~ ^[Nn]$ ]]; then
        fail "Wymagany Node.js >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} <${MAX_NODE_MAJOR}"
      fi
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
    fi
    ok "Node.js $(node -v)"
  else
    info "Brak Node.js — instaluję Node.js 22 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    ok "Node.js $(node -v)"
  fi
}

ensure_git() {
  if ! command -v git &>/dev/null; then
    info "Instaluję git..."
    apt-get update -qq && apt-get install -y -qq git
  fi
  ok "git $(git --version | awk '{print $3}')"
}

ensure_cron() {
  if ! command -v crontab &>/dev/null; then
    info "Instaluję cron..."
    apt-get update -qq && apt-get install -y -qq cron
  fi
  systemctl enable cron 2>/dev/null || true
  systemctl start cron 2>/dev/null || true
  ok "cron"
}

# Uwaga: build-essential/python3 celowo NIE są instalowane — były potrzebne
# wyłącznie pod natywną kompilację better-sqlite3. Projekt używa wbudowanego
# node:sqlite (lib/db.js), koffi ma prebuilt binaries, pg to czysty JS.

# CLAUDE_HOME/INSTALL_DIR muszą być znane PRZED useradd — pytania FAZY 1
# używają ścieżek (default workspace, ~/vault). Istniejący user → getent;
# świeży VPS → /home/claude (default useradd -m).
resolve_install_paths() {
  CLAUDE_HOME="$(getent passwd "$CLAUDE_USER" 2>/dev/null | cut -d: -f6 || true)"
  [ -n "$CLAUDE_HOME" ] || CLAUDE_HOME="/home/$CLAUDE_USER"
  INSTALL_DIR="$CLAUDE_HOME/claude-cron"
}

ensure_claude_user() {
  if has_user_claude; then
    ok "Użytkownik '$CLAUDE_USER' istnieje"
  else
    info "Tworzę dedykowanego użytkownika '$CLAUDE_USER'..."
    useradd -m -s /bin/bash "$CLAUDE_USER"
    ok "Użytkownik '$CLAUDE_USER' utworzony"
  fi
  # Realny home mógł odbiec od założenia z FAZY 1 (nietypowa konfiguracja
  # useradd) — przelicz ścieżki po utworzeniu usera.
  resolve_install_paths
}

install_claude_cli() {
  info "Instaluję Claude CLI globalnie..."
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -1
  ok "Claude CLI zainstalowane"
}

login_claude_cli() {
  echo ""
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}  Claude CLI musi być zalogowane jako '$CLAUDE_USER'.${NC}"
  echo -e "${YELLOW}  To krok interaktywny — dokończ logowanie w przeglądarce.${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  local do_login=""
  ask_tty do_login "Zalogować się do Claude CLI teraz? [T/n]: " "T"

  if [[ "$do_login" =~ ^[Nn]$ ]]; then
    warn "Pomijam logowanie — joby nie ruszą, dopóki Claude CLI nie będzie zalogowane"
    warn "Zaloguj później: su - $CLAUDE_USER -c 'claude'"
    return 0
  fi

  echo ""
  echo "Uruchamiam Claude CLI jako '$CLAUDE_USER' — dokończ logowanie w przeglądarce."
  echo "Po zalogowaniu wyjdź z Claude (Ctrl+C lub /exit), by kontynuować instalację."
  echo ""
  # Handoff klawiatury przez /dev/tty — pod curl|bash stdin to pipe.
  # Probe otwarcia, nie [ -r ] — zob. komentarz w ask_tty (ENXIO bez ctty).
  if { : < "$TTY_DEVICE"; } 2>/dev/null; then
    su - "$CLAUDE_USER" -c "claude" < "$TTY_DEVICE" || true
  else
    su - "$CLAUDE_USER" -c "claude" || true
  fi
  echo ""
  ok "Krok logowania Claude CLI zakończony"
}

clone_repo() {
  echo ""
  info "Przygotowuję repozytorium..."

  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Aktualizuję istniejącą instalację..."
    su - "$CLAUDE_USER" -c "cd $INSTALL_DIR && git pull --ff-only"
  else
    if [ -d "$INSTALL_DIR" ]; then
      warn "$INSTALL_DIR istnieje bez gita — tworzę kopię zapasową..."
      mv "$INSTALL_DIR" "${INSTALL_DIR}.backup.$(date +%s)"
    fi
    info "Klonuję repozytorium (ref: $REF)..."
    su - "$CLAUDE_USER" -c "git clone --branch $REF $REPO $INSTALL_DIR"
  fi
  ok "Repo: $INSTALL_DIR"
}

install_dependencies() {
  info "Instaluję zależności..."
  su - "$CLAUDE_USER" -c "cd $INSTALL_DIR && npm install --production" 2>&1 | tail -3
  mkdir -p "$INSTALL_DIR/data"
  chown "$CLAUDE_USER:$CLAUDE_USER" "$INSTALL_DIR/data"
  ok "Zależności zainstalowane"
}

# ============ FAZA 1: BLOK 4 PYTAŃ ============

# Auto-wartości (spec FAZA 1: „wycięte z pytań" — default/flaga, zero promptów):
# device name, port (ustawiony w parse_flags), strefa czasowa.
resolve_auto_values() {
  DEVICE_NAME="${FLAG_DEVICE:-vps-$(hostname)}"
  TZ_VAL="${FLAG_TZ:-$(detect_timezone "$(timedatectl show -p Timezone --value 2>/dev/null || true)")}"
}

# Pytanie o workspace — wraca TYLKO w --only-puls (pełny tryb: zawsze ~/vault).
ask_workspace() {
  echo -e "  Workspace = folder, w którym Claude CLI wykonuje joby."
  echo -e "  To powinien być Twój vault Obsidian (lub inny projekt)."
  echo ""

  # Pokaż, co jest dostępne w home usera claude (jeśli już istnieje)
  if [ -d "$CLAUDE_HOME" ]; then
    local dirs_found
    dirs_found=$(ls -d "$CLAUDE_HOME"/*/ 2>/dev/null || true)
    if [ -n "$dirs_found" ]; then
      echo -e "  ${CYAN}Foldery w $CLAUDE_HOME/:${NC}"
      echo "$dirs_found" | sed 's/^/    /'
      echo ""
    fi
  fi

  local workspace_input=""
  ask_tty workspace_input "Ścieżka do workspace [$CLAUDE_HOME/workspace]: " "$CLAUDE_HOME/workspace"
  WORKSPACE="$(normalize_path "$workspace_input")"
}

print_config_summary() {
  echo ""
  echo -e "${CYAN}Podsumowanie konfiguracji${NC}"
  echo "─────────────────────────────────────"
  if [ "$FLAG_ONLY_PULS" = 1 ]; then
    echo -e "  ${BOLD}Tryb:${NC}            tylko Puls (bez Obsidiana)"
  else
    echo -e "  ${BOLD}Email Obsidian:${NC}  $OB_EMAIL"
    echo -e "  ${BOLD}Vault:${NC}           $VAULT_NAME"
    echo -e "  ${BOLD}Repo .claude:${NC}    $VAULT_GIT_REPO"
    echo -e "  ${BOLD}Urządzenie Sync:${NC} $DEVICE_NAME"
  fi
  echo -e "  ${BOLD}Workspace:${NC}       $WORKSPACE"
  echo -e "  ${BOLD}Port Pulsa:${NC}      $PORT"
  echo -e "  ${BOLD}Strefa czasowa:${NC}  $TZ_VAL"
  if [ -n "$DISCORD_URL" ]; then
    echo -e "  ${BOLD}Discord:${NC}         powiadomienia włączone"
  else
    echo -e "  ${BOLD}Discord:${NC}         pominięty"
  fi
  if [ "$FLAG_NO_AUTO_UPDATE" = 1 ]; then
    echo -e "  ${BOLD}Auto-update:${NC}     wyłączony (--no-auto-update)"
  else
    echo -e "  ${BOLD}Auto-update:${NC}     codziennie o 02:00"
  fi
  echo ""
}

confirm_config() {
  local confirm=""
  ask_tty confirm "Kontynuujemy? [T/n]: " "T"
  if [[ "$confirm" =~ ^[Nn]$ ]]; then
    info "Przerwano na Twoje życzenie — nic nie zostało zainstalowane."
    exit 0
  fi
}

# FAZA 1: cały typowany config w JEDNYM bloku — potem instalacja leci sama
# aż do bloku loginów. Hasła celowo NIE tutaj (muszą paść przy swoim
# narzędziu, po jego instalacji — Faza 3 spec-u).
collect_config() {
  echo ""
  echo -e "${CYAN}Konfiguracja — wszystkie pytania naraz${NC}"
  echo "─────────────────────────────────────"
  echo ""

  resolve_auto_values

  if [ "$FLAG_ONLY_PULS" = 1 ]; then
    ask_workspace
  else
    ask_valid OB_EMAIL "Email konta Obsidian: " is_valid_email \
      "Niepoprawny email (wymagany znak @, bez spacji) — spróbuj jeszcze raz."
    ask_valid VAULT_NAME "Nazwa vaulta w Obsidian Sync: " is_nonempty \
      "Nazwa vaulta nie może być pusta — spróbuj jeszcze raz."
    local repo_input=""
    ask_valid repo_input "Repo GitHub z katalogiem .claude (user/repo lub URL https): " \
      is_valid_repo_format \
      "Niepoprawny format — podaj user/repo albo https://github.com/user/repo."
    VAULT_GIT_REPO="$(normalize_repo "$repo_input")"
    # Pełny tryb: workspace zawsze ~/vault (pytanie wraca tylko w --only-puls).
    WORKSPACE="$CLAUDE_HOME/vault"
  fi

  ask_valid DISCORD_URL "Discord webhook URL do powiadomień (puste = pomiń): " \
    is_valid_discord_webhook \
    "Niepoprawny webhook — adres musi zaczynać się od https://discord.com/api/webhooks/." \
    ""

  print_config_summary
  confirm_config
}

# Ustawienie strefy czasowej — automat (TZ z autodetekcji/flagi, bez pytania).
apply_timezone() {
  local current_tz
  current_tz=$(timedatectl show -p Timezone --value 2>/dev/null || echo "")
  if [ "$TZ_VAL" != "$current_tz" ]; then
    timedatectl set-timezone "$TZ_VAL"
    ok "Strefa czasowa ustawiona: $TZ_VAL"
  else
    ok "Strefa czasowa: $current_tz (bez zmian)"
  fi
}

# Utworzenie workspace PO utworzeniu usera claude — FAZA 1 tylko pyta
# (na świeżym VPS w momencie pytań /home/claude jeszcze nie istnieje).
ensure_workspace() {
  if [ ! -d "$WORKSPACE" ]; then
    mkdir -p "$WORKSPACE"
    ok "Utworzono workspace: $WORKSPACE"
  fi
  chown "$CLAUDE_USER:$CLAUDE_USER" "$WORKSPACE"
  ok "Workspace: $WORKSPACE"
}

create_systemd_service() {
  echo ""
  info "Tworzę serwis systemd..."

  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  local node_path env_lines
  node_path=$(which node)

  env_lines="Environment=CLAUDE_CRON_PORT=$PORT
Environment=CLAUDE_CRON_WORKSPACE=$WORKSPACE
Environment=PATH=$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

  if [ -n "$DISCORD_URL" ]; then
    env_lines="$env_lines
Environment=DISCORD_WEBHOOK_URL=$DISCORD_URL"
  fi

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Claude-Cron Skill Scheduler
After=network.target

[Service]
Type=simple
User=$CLAUDE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$node_path --disable-warning=ExperimentalWarning $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=10

$env_lines

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  sleep 2

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Serwis działa"
  else
    warn "Serwis nie wystartował. Sprawdź: journalctl -u $SERVICE_NAME -n 30"
  fi
}

configure_firewall() {
  echo ""
  info "Konfiguruję firewall..."

  if ! command -v ufw &>/dev/null; then
    info "Instaluję UFW..."
    apt-get update -qq && apt-get install -y -qq ufw
  fi

  if command -v ufw &>/dev/null; then
    # Najpierw ZAWSZE przepuść SSH — nigdy nie odcinaj sobie dostępu
    ufw allow 22/tcp 2>/dev/null || true

    if ! ufw status | grep -q "active"; then
      info "Włączam UFW..."
      ufw --force enable
    fi

    # Port Pulsa ZABLOKOWANY — dostęp tylko przez Tailscale
    if ufw status | grep -q "$PORT.*ALLOW"; then
      warn "Port $PORT jest OTWARTY w UFW — zamykam (dostęp tylko przez Tailscale)"
      ufw delete allow "$PORT/tcp" 2>/dev/null || true
      ufw delete allow "$PORT" 2>/dev/null || true
    fi
    ufw deny "$PORT/tcp" 2>/dev/null || true
    ok "Port $PORT zablokowany w UFW (dostęp tylko przez Tailscale)"
  fi
}

setup_tailscale() {
  echo ""
  echo -e "${CYAN}Tailscale i webhooki${NC}"
  echo "─────────────────────────────────────"
  echo ""

  if ! command -v tailscale &>/dev/null; then
    info "Instaluję Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh

    # Poczekaj, aż daemon tailscaled będzie w pełni gotowy
    info "Czekam na daemon Tailscale..."
    local i
    for i in $(seq 1 10); do
      if systemctl is-active --quiet tailscaled 2>/dev/null; then
        break
      fi
      sleep 1
    done
    sleep 2
  fi

  if command -v tailscale &>/dev/null; then
    ok "Tailscale zainstalowany"
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
    if [ -z "$TS_IP" ]; then
      echo ""
      echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo -e "${YELLOW}  Tailscale musi zostać połączony.${NC}"
      echo -e "${YELLOW}  Uruchom poniższą komendę i wejdź w link logowania.${NC}"
      echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo ""
      local do_ts=""
      ask_tty do_ts "Połączyć Tailscale teraz? [T/n]: " "T"
      if [[ ! "$do_ts" =~ ^[Nn]$ ]]; then
        tailscale up
      fi
      TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
    fi
    if [ -n "$TS_IP" ]; then
      ok "Tailscale IP: $TS_IP"
    else
      warn "Tailscale niepołączony — uruchom 'tailscale up' później"
    fi
  else
    warn "Instalacja Tailscale nie powiodła się"
    TS_IP=""
  fi
}

setup_funnel() {
  # Tailscale Funnel dla webhooków
  echo ""
  local setup_funnel_answer=""
  ask_tty setup_funnel_answer "Włączyć Tailscale Funnel dla webhooków? (wystawia /webhook/* na internet) [t/N]: " "N"

  WEBHOOK_BASE_URL=""
  if [[ ! "$setup_funnel_answer" =~ ^[TtYy]$ ]]; then
    return 0
  fi

  if ! command -v tailscale &>/dev/null; then
    warn "Tailscale niezainstalowany — pomijam Funnel"
    return 0
  fi

  info "Uruchamiam Tailscale Funnel na porcie $PORT..."
  tailscale funnel --bg "$PORT" 2>/dev/null || warn "Funnel nie wystartował — może wymagać włączenia w panelu Tailscale"

  # Spróbuj odczytać URL funnela
  local funnel_status
  funnel_status=$(tailscale funnel status 2>/dev/null || echo "")
  if echo "$funnel_status" | grep -q "https://"; then
    WEBHOOK_BASE_URL=$(echo "$funnel_status" | grep -oP 'https://[^ ]+' | head -1 | sed 's/\/$//')
    ok "Funnel aktywny: $WEBHOOK_BASE_URL"
  else
    ask_tty WEBHOOK_BASE_URL "Podaj URL Tailscale Funnel (np. https://srv123.tail456.ts.net): " ""
  fi

  # Dopisz WEBHOOK_BASE_URL do systemd
  if [ -n "$WEBHOOK_BASE_URL" ]; then
    sed -i "/SyslogIdentifier/i Environment=WEBHOOK_BASE_URL=$WEBHOOK_BASE_URL" "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl restart "$SERVICE_NAME"
    sleep 1
    ok "WEBHOOK_BASE_URL ustawiony w serwisie systemd"
  fi
}

setup_auto_update() {
  if [ "$FLAG_NO_AUTO_UPDATE" = 1 ]; then
    info "Auto-update pominięty (--no-auto-update)"
    return 0
  fi

  echo ""
  echo -e "${CYAN}Auto-update${NC}"
  echo "─────────────────────────────────────"
  echo ""
  echo -e "  Codzienny cron (2:00) — automatycznie pulluje"
  echo -e "  vault-git i claude-cron, potem restartuje serwis."
  echo ""

  local setup_autoupdate=""
  ask_tty setup_autoupdate "Ustawić automatyczną aktualizację? [T/n]: " "T"

  if [[ "$setup_autoupdate" =~ ^[Nn]$ ]]; then
    info "Pominięto — możesz dodać ręcznie później"
    return 0
  fi

  # Passwordless sudo dla restartu serwisu
  echo "$CLAUDE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE_NAME" > "/etc/sudoers.d/$SERVICE_NAME"
  chmod 440 "/etc/sudoers.d/$SERVICE_NAME"
  ok "Passwordless sudo dla restartu serwisu"

  # Sprawdź, czy vault-git istnieje
  local vault_git="$CLAUDE_HOME/vault-git"
  if [ ! -d "$vault_git/.git" ]; then
    local vault_git_input=""
    ask_tty vault_git_input "Ścieżka do repo vault-git [$vault_git]: " "$vault_git"
    vault_git="$vault_git_input"
    vault_git="${vault_git/#\~/$CLAUDE_HOME}"
  fi

  # Pre-check wersji Node dla crona — wstrzymuje restart, gdy Node serwisu jest
  # niekompatybilny (np. operator zdegradował Node po instalacji). git pull i tak
  # się wykona (kod się zaktualizuje), ale restart na złym Node tylko ubiłby wszystkie
  # joby (node:sqlite rzuca przy starcie — zob. lib/runtime-guard.js). Skrypt zapisany
  # obok instalacji, uruchamiany jako user $CLAUDE_USER (ten sam Node co serwis).
  local guard_script="$INSTALL_DIR/scripts/cron-node-guard.sh"
  local cron_log="$CLAUDE_HOME/claude-cron-update.log"

  cat > "$guard_script" <<GUARD
#!/usr/bin/env bash
# Auto-generowany przez install-vps.sh — pre-check Node przed restartem serwisu.
# Exit 0 = Node kompatybilny (restart OK). Exit 1 = niekompatybilny (wstrzymaj restart).
set -uo pipefail

MIN_NODE_MAJOR=$MIN_NODE_MAJOR
MIN_NODE_MINOR=$MIN_NODE_MINOR
MAX_NODE_MAJOR=$MAX_NODE_MAJOR
SERVICE_NAME="$SERVICE_NAME"
CRON_LOG="$cron_log"

log_warn() {
  local msg="\$1"
  logger -t "\$SERVICE_NAME-update" "\$msg" 2>/dev/null || true
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$msg" >> "\$CRON_LOG" 2>/dev/null || true
}

RAW=\$(node -v 2>/dev/null | sed 's/v//')
MAJOR=\$(echo "\$RAW" | cut -d. -f1)
MINOR=\$(echo "\$RAW" | cut -d. -f2)

if [ -z "\$MAJOR" ] || [ -z "\$MINOR" ]; then
  log_warn "Restart serwisu WSTRZYMANY: nie udało się odczytać wersji Node (node -v puste). Kod zaktualizowany przez git pull, ale serwis działa na starym kodzie do ręcznej interwencji."
  exit 1
fi

# Górna granica wykluczająca: major >= MAX (25+) → niekompatybilny (lib/runtime-guard.js ubije serwis).
if [ "\$MAJOR" -ge "\$MAX_NODE_MAJOR" ]; then
  log_warn "Restart serwisu WSTRZYMANY: Node v\$RAW jest niekompatybilny (wymagane >=\${MIN_NODE_MAJOR}.\${MIN_NODE_MINOR} <\${MAX_NODE_MAJOR} dla node:sqlite). Kod zaktualizowany przez git pull, ale serwis NIE został zrestartowany, by uniknąć padu wszystkich jobów. Zaktualizuj Node i zrestartuj ręcznie: systemctl restart \$SERVICE_NAME"
  exit 1
fi

if [ "\$MAJOR" -gt "\$MIN_NODE_MAJOR" ] || { [ "\$MAJOR" -eq "\$MIN_NODE_MAJOR" ] && [ "\$MINOR" -ge "\$MIN_NODE_MINOR" ]; }; then
  exit 0
fi

log_warn "Restart serwisu WSTRZYMANY: Node v\$RAW jest niekompatybilny (wymagane >=\${MIN_NODE_MAJOR}.\${MIN_NODE_MINOR} <\${MAX_NODE_MAJOR} dla node:sqlite). Kod zaktualizowany przez git pull, ale serwis NIE został zrestartowany, by uniknąć padu wszystkich jobów. Zaktualizuj Node i zrestartuj ręcznie: systemctl restart \$SERVICE_NAME"
exit 1
GUARD
  chmod +x "$guard_script"
  chown "$CLAUDE_USER:$CLAUDE_USER" "$guard_script" 2>/dev/null || true
  ok "Cron Node guard: $guard_script"

  # Komenda crona
  # 02:00 — okno maintenance ciche, by restart nie kolidował z porannymi jobami (zob. lib/config.js MAINTENANCE_WINDOW).
  # git pull ZAWSZE; restart tylko gdy guard (uruchomiony jako $CLAUDE_USER) potwierdzi kompatybilny Node.
  local cron_cmd existing_cron
  cron_cmd="0 2 * * * su - $CLAUDE_USER -c \"cd $vault_git && git pull && cd $INSTALL_DIR && git pull && bash $guard_script\" && systemctl restart $SERVICE_NAME"

  # Dodaj do crontaba roota (bez duplikatów)
  existing_cron=$(crontab -l 2>/dev/null | grep -v "$SERVICE_NAME" || true)
  if [ -n "$existing_cron" ]; then
    printf '%s\n%s\n' "$existing_cron" "$cron_cmd" | crontab -
  else
    echo "$cron_cmd" | crontab -
  fi
  ok "Cron: codziennie o 2:00 — auto-update + restart"
}

print_summary() {
  echo ""
  echo "========================================"
  echo -e "${GREEN}🕹️  PULS — instalacja na VPS zakończona!${NC}"
  echo "========================================"
  echo ""
  echo -e "  ${BOLD}Serwis:${NC}     $SERVICE_NAME (systemd)"
  echo -e "  ${BOLD}Użytkownik:${NC} $CLAUDE_USER"
  echo -e "  ${BOLD}Repo:${NC}       $INSTALL_DIR"
  echo -e "  ${BOLD}Workspace:${NC}  $WORKSPACE"
  echo -e "  ${BOLD}Port:${NC}       $PORT"

  if [ -n "$TS_IP" ]; then
    echo -e "  ${BOLD}Dashboard:${NC}  ${CYAN}http://$TS_IP:$PORT${NC} (przez Tailscale)"
  fi
  if [ -n "$WEBHOOK_BASE_URL" ]; then
    echo -e "  ${BOLD}Webhooki:${NC}   ${CYAN}$WEBHOOK_BASE_URL/webhook/<token>${NC}"
  fi
  if [ -n "$DISCORD_URL" ]; then
    echo -e "  ${BOLD}Discord:${NC}    włączony"
  fi

  echo ""
  echo -e "  ${BOLD}Przydatne komendy:${NC}"
  echo "    systemctl status $SERVICE_NAME        # status serwisu"
  echo "    journalctl -u $SERVICE_NAME -f        # logi na żywo"
  echo "    systemctl restart $SERVICE_NAME       # restart"
  echo "    su - $CLAUDE_USER -c 'cd ~/claude-cron && git pull'  # aktualizacja kodu"
  echo ""

  if [ -n "$TS_IP" ]; then
    echo -e "  ${BOLD}Połączenie z Twojego Maca:${NC}"
    echo "    Dodaj do ~/.zshrc:"
    echo "      export CLAUDE_CRON_VPS_URL=http://$TS_IP:$PORT"
    echo ""
  fi

  echo -e "  ${BOLD}Bezpieczeństwo:${NC}"
  echo "    - Port $PORT jest ZABLOKOWANY w firewallu (dostęp tylko przez Tailscale)"
  echo "    - Dashboard nie jest dostępny z publicznego internetu"
  echo "    - Publicznie wystawione są tylko endpointy /webhook/* (Tailscale Funnel)"
  echo "    - Claude CLI działa jako dedykowany użytkownik '$CLAUDE_USER' (nie root)"
  echo ""
}

# ============ MAIN ============

main() {
  trap on_err ERR
  parse_flags "$@"

  print_banner
  run_preflight          # FAZA 0: root/OS/internet + checklist + detekcja stanu
  resolve_install_paths
  collect_config         # FAZA 1: blok 4 pytań + auto-wartości + potwierdzenie
  apply_timezone
  ensure_node
  ensure_git
  ensure_cron
  ensure_claude_user
  ensure_workspace
  install_claude_cli
  login_claude_cli
  clone_repo
  install_dependencies
  create_systemd_service
  configure_firewall
  setup_tailscale
  setup_funnel
  setup_auto_update
  print_summary
}

# Test harness może wczytać tylko funkcje (CLAUDE_CRON_LIB_ONLY=1),
# bez odpalania main (instalacji pakietów / pytań interaktywnych).
if [ "${CLAUDE_CRON_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi
