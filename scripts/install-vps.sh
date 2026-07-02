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
OB_SYNC_SERVICE="obsidian-sync"
CLAUDE_USER="claude"

# Katalog unit-plików systemd — zmienna (nie literał w funkcjach), żeby testy
# mogły ją nadpisać na sandbox (DI jak TTY_DEVICE) bez pisania po /etc.
SYSTEMD_DIR="/etc/systemd/system"

# Katalog wpisów sudoers — zmienna z tego samego powodu co SYSTEMD_DIR
# (DI: testy auto-update piszą po sandboxie, nie po /etc).
SUDOERS_DIR="/etc/sudoers.d"

# Typy plików Obsidian Sync — 'unsupported' = przełącznik "All other file types"
# z GUI Obsidiana. Bez niego pliki nie-media (raporty HTML/JSON/CSV ze skilli)
# zostają na VPS i nigdy nie docierają na komputer/telefon — selektywny sync
# jest per-device (przewodnik headless sekcja 3). Stała bez pytania (decyzja 8).
OB_FILE_TYPES="image,audio,video,pdf,unsupported"

# Okno czekania na pierwszy sync vaulta (spec FAZA 6: „do 90 s") i interwał
# odpytywania `ob sync-status`. Timeout = warn, nie fail: duży vault legalnie
# synchronizuje się dłużej, a ERR odwinąłby rollback działającej instalacji.
SYNC_WAIT_MAX_SECONDS=90
SYNC_POLL_SECONDS=5

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

# Katalogi, których instalator NIE może przejąć jako workspace — root robi
# na tej ścieżce mkdir -p i chown, więc "/", "/etc" czy katalog innego
# serwisu oznaczałyby ciche przejęcie ownership przez usera claude.
WORKSPACE_FORBIDDEN_DIRS=(/bin /boot /dev /etc /lib /lib64 /proc /root /run /sbin /sys /usr /var)

# is_valid_workspace_path <ścieżka> — absolutna i poza katalogami systemowymi
# (sam katalog LUB cokolwiek pod nim). Oczekuje ścieżki już po normalize_path.
is_valid_workspace_path() {
  [[ "$1" == /* ]] || return 1
  local p="${1%/}" d
  [ -n "$p" ] || return 1  # "/" po zdjęciu końcowego slasha = pusty string
  for d in "${WORKSPACE_FORBIDDEN_DIRS[@]}"; do
    if [ "$p" = "$d" ] || [[ "$p" == "$d"/* ]]; then
      return 1
    fi
  done
  return 0
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

# drop_rollback <cmd> — zdejmuje ze stosu wcześniej zarejestrowaną akcję
# (dokładne dopasowanie). Użycie: neutralizacja `userdel -r` na granicy bloku
# loginów — od tej pauzy /home/$CLAUDE_USER przechowuje credentiale loginów
# i cofnięcie usera niszczyłoby je (R6 leave-partial, decyzja 25).
# Idiom ${arr[@]+...} — bezpieczna ekspansja pustej tablicy pod set -u (bash 3.2).
drop_rollback() {
  local cmd="$1" entry
  local kept=()
  for entry in ${ROLLBACK_STACK[@]+"${ROLLBACK_STACK[@]}"}; do
    [ "$entry" = "$cmd" ] || kept+=("$entry")
  done
  ROLLBACK_STACK=(${kept[@]+"${kept[@]}"})
}

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

# run_verify <cmd> — weryfikacja pauzy: nazwa funkcji instalatora (guardy
# has_*) wołana WPROST, bo child bash z `bash -c` nie widzi funkcji; pozostałe
# komendy (stringi złożone) przez bash -c. eval odpada: bash 3.2 (macOS,
# na którym biega harness) odpala trap ERR dla eval nawet w kontekście
# warunku if — rollback odwijałby się mimo weryfikacji „w warunku".
run_verify() {
  if declare -F "$1" >/dev/null 2>&1; then
    "$1"
  else
    bash -c "$1"
  fi
}

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
    if run_verify "$verify_cmd"; then
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

# login_cmd_as_claude <cmd> — buduje komendę pauzy interaktywnej wykonywanej
# jako user claude. JEDYNE miejsce z formą `su - … -c` dla loginów: spike
# granicy su+/dev/tty (Operator gate IU4) jest wciąż otwarty, więc ewentualna
# zmiana na runuser/sudo -u po spike'u jest jednopunktowa. Klawiaturę
# (< $TTY_DEVICE) podpina run_login — forma redirectu też ma jeden punkt zmiany.
login_cmd_as_claude() {
  printf 'su - %s -c %q' "$CLAUDE_USER" "$1"
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
    print_state_line "serwis $OB_SYNC_SERVICE" has_service "$OB_SYNC_SERVICE"
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

# ============ FAZA 2: NARZĘDZIA (install_*) ============

# Wszystkie funkcje install_* MUSZĄ wykonać się w main() PRZED login_block —
# po pierwszej pauzie interaktywnej nie instaluje się już żadne narzędzie
# (egzekwowane testem sekwencji w harnessie). Guard-first: nic nie instalujemy
# ponownie i nie rejestrujemy rollbacku dla stanu zastanego sprzed runa.

# Pakiety bazowe jednym apt (git/curl/cron/gh; gh jest w Ubuntu universe).
# ca-certificates dokładane przy każdej instalacji brakujących — nie ma
# własnej binarki do prostego guardu, a apt i tak pominie zainstalowany pakiet.
install_base_packages() {
  local missing=()
  command -v git &>/dev/null || missing+=(git)
  command -v curl &>/dev/null || missing+=(curl)
  command -v crontab &>/dev/null || missing+=(cron)
  command -v gh &>/dev/null || missing+=(gh)

  if [ "${#missing[@]}" -gt 0 ]; then
    info "Instaluję pakiety bazowe: ${missing[*]}..."
    apt-get update -qq
    apt-get install -y -qq ca-certificates "${missing[@]}"
  fi

  # Weryfikacja po instalacji — gh jest twardym prerequisitem bloku loginów
  # (R5: device flow zamiast PAT), więc brak = zatrzymanie tu, nie w Fazie 3.
  local tool
  for tool in git curl crontab gh; do
    command -v "$tool" &>/dev/null \
      || fail "Instalacja pakietów bazowych nie powiodła się — brak '$tool' w PATH."
  done

  systemctl enable cron 2>/dev/null || true
  systemctl start cron 2>/dev/null || true
  ok "Pakiety bazowe: git, curl, ca-certificates, cron, gh"
}

install_node() {
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
    # Rollback TYLKO gdy user powstał w TYM runie — istniejącego wcześniej
    # usera (z jego /home) nigdy nie cofamy, to cudzy stan.
    push_rollback "userdel -r $CLAUDE_USER"
    ok "Użytkownik '$CLAUDE_USER' utworzony"
  fi
  # Realny home mógł odbiec od założenia z FAZY 1 (nietypowa konfiguracja
  # useradd) — przelicz ścieżki po utworzeniu usera.
  resolve_install_paths
}

# Claude Code NATYWNIE (nie przez npm): oficjalny instalator kładzie binarkę
# w ~/.local/bin/claude usera claude — spójne z PATH w unicie systemd
# (Environment=PATH=$CLAUDE_HOME/.local/bin:...) i z guardem has_claude_auth.
install_claude_cli() {
  if run_as_claude "command -v claude" &>/dev/null; then
    ok "Claude CLI już zainstalowane"
    return 0
  fi
  info "Instaluję Claude CLI (natywnie, jako '$CLAUDE_USER')..."
  run_as_claude "curl -fsSL https://claude.ai/install.sh | bash"
  run_as_claude "command -v claude" &>/dev/null \
    || fail "Instalacja Claude CLI nie powiodła się — brak 'claude' w PATH usera '$CLAUDE_USER'."
  ok "Claude CLI zainstalowane (~/.local/bin/claude)"
}

# obsidian-headless (bin `ob`) — globalnie przez npm (root); user claude widzi
# binarkę przez systemowy PATH. Pomijane w main() przy --only-puls.
install_ob() {
  if command -v ob &>/dev/null; then
    ok "obsidian-headless (ob) już zainstalowany"
    return 0
  fi
  info "Instaluję obsidian-headless (CLI 'ob')..."
  npm install -g obsidian-headless 2>&1 | tail -1
  command -v ob &>/dev/null \
    || fail "Instalacja obsidian-headless nie powiodła się — brak 'ob' w PATH."
  push_rollback "npm rm -g obsidian-headless"
  ok "obsidian-headless (ob) zainstalowany"
}

# Instalacja Tailscale w fundamencie (FAZA 2) — samo połączenie (`tailscale up`)
# to pauza interaktywna i idzie do bloku loginów (IU4). Czekanie na daemon
# zostaje przy instalacji: świeżo postawiony tailscaled potrzebuje chwili,
# zanim `tailscale up`/`tailscale ip` przestaną zwracać błąd połączenia.
install_tailscale() {
  if command -v tailscale &>/dev/null; then
    ok "Tailscale już zainstalowany"
    return 0
  fi
  info "Instaluję Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh

  info "Czekam na daemon Tailscale..."
  local i
  for i in $(seq 1 10); do
    if systemctl is-active --quiet tailscaled 2>/dev/null; then
      break
    fi
    sleep 1
  done
  sleep 2

  command -v tailscale &>/dev/null \
    || fail "Instalacja Tailscale nie powiodła się — brak 'tailscale' w PATH."
  ok "Tailscale zainstalowany"
}

# ============ FAZA 3: BLOK 5 LOGINÓW ============

# Jedyna strefa interaktywna instalacji (R6): 5 pauz pod rząd, każda przez
# run_login (handoff klawiatury, natychmiastowa weryfikacja, 3 próby →
# halt_leave_partial). Rollback zdjęty na czas bloku (R7) — pad loginu
# zostawia stan częściowy do wznowienia, NIGDY nie cofa automatów.
# Każda pauza za swoim guardem has_* → re-run wskakuje w brakujący login (R13).
# Kolejność stała: Claude → gh → ob → sync → tailscale.
login_block() {
  # Granica leave-partial: od pierwszej pauzy interaktywnej /home/$CLAUDE_USER
  # zaczyna przechowywać credentiale loginów (Claude OAuth ~/.claude/
  # .credentials.json, gh, ob). ERR w późniejszych krokach automatycznych
  # (clone_repo, npm install) odwija stos rollbacku — `userdel -r` skasowałby
  # świeżo wykonany login wbrew R6/decyzji 25, więc wpis zdejmujemy na wejściu.
  drop_rollback "userdel -r $CLAUDE_USER"
  disable_rollback

  echo ""
  echo -e "${CYAN}Logowania — jedyne kroki interaktywne${NC}"
  echo "─────────────────────────────────────"

  login_claude_cli                      # PAUZA 1
  login_gh                              # PAUZA 2 (+ setup-git + walidacja repo)
  if [ "$FLAG_ONLY_PULS" != 1 ]; then
    login_ob                            # PAUZA 3
    login_ob_sync                       # PAUZA 4
  fi
  login_tailscale                       # PAUZA 5

  enable_rollback
}

# Nagłówek pauzy interaktywnej — kursant widzi, który to krok i co ma zrobić.
print_pause_header() {
  local step="$1" hint="$2"
  echo ""
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}  $step${NC}"
  echo -e "${YELLOW}  $hint${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

# PAUZA 1: login Claude CLI (OAuth w przeglądarce). Weryfikacja nieinteraktywna
# przez has_claude_auth (niepusty ~/.claude/.credentials.json) — probe
# `claude -p` celowo NIE: kosztuje tokeny i czas, a o zalogowaniu mówi plik
# credentiali (forma odroczona w planie — rozstrzygnięta tutaj).
login_claude_cli() {
  if has_claude_auth; then
    ok "Claude CLI już zalogowany — pomijam"
    return 0
  fi
  print_pause_header "KROK 1/5: Logowanie Claude CLI (użytkownik '$CLAUDE_USER')" \
    "Dokończ logowanie w przeglądarce, potem wyjdź z Claude (Ctrl+C lub /exit)."
  run_login "Claude CLI" "$(login_cmd_as_claude "claude")" "has_claude_auth"
}

# PAUZA 2: gh device flow (R5 — zero PAT). Po loginie ZAWSZE (także przy
# resume z guardem): `gh auth setup-git` (credential helper dla sparse
# checkoutu i nocnego crona) + walidacja dostępu do repo — poprzedni run
# mógł paść MIĘDZY loginem a tymi krokami, guard loginu by je pominął.
login_gh() {
  if has_gh_auth; then
    ok "GitHub CLI (gh) już zalogowany — pomijam"
  else
    print_pause_header "KROK 2/5: Logowanie GitHub CLI (gh)" \
      "Przepisz jednorazowy kod na stronie github.com/login/device."
    run_login "GitHub CLI (gh)" \
      "$(login_cmd_as_claude "gh auth login --hostname github.com --git-protocol https --web")" \
      "has_gh_auth"
  fi
  run_as_claude "gh auth setup-git" &>/dev/null \
    || halt_leave_partial "gh auth setup-git (credential helper gita)"
  ok "gh: credential helper gita skonfigurowany"
  validate_repo_access
}

# Walidacja DOSTĘPU do repo .claude (FORMAT pilnowała FAZA 1): `gh repo view`
# jako user claude — 404/brak uprawnień → ponowne pytanie o repo w pętli
# 3 prób (retry-in-place, R5). Wartość idzie do komendy `su -c` → printf %q
# (konwencja z review fazy 1). Sufiks .git zdjęty — gh repo view oczekuje
# OWNER/REPO lub czystego URL-a.
validate_repo_access() {
  # --only-puls: brak repo .claude w konfiguracji — nic do walidacji.
  [ -n "${VAULT_GIT_REPO:-}" ] || return 0
  local attempt repo_input
  for (( attempt=1; attempt<=LOGIN_MAX_ATTEMPTS; attempt++ )); do
    if run_as_claude "gh repo view $(printf '%q' "${VAULT_GIT_REPO%.git}")" &>/dev/null; then
      ok "Repo .claude dostępne: $VAULT_GIT_REPO"
      return 0
    fi
    warn "Nie mam dostępu do repo: $VAULT_GIT_REPO (nie istnieje albo konto gh nie ma uprawnień)."
    if [ "$attempt" -lt "$LOGIN_MAX_ATTEMPTS" ]; then
      repo_input=""
      ask_valid repo_input "Repo GitHub z katalogiem .claude (user/repo lub URL https): " \
        is_valid_repo_format \
        "Niepoprawny format — podaj user/repo albo https://github.com/user/repo."
      VAULT_GIT_REPO="$(normalize_repo "$repo_input")"
    fi
  done
  halt_leave_partial "walidacja dostępu do repo .claude"
}

# PAUZA 3: login Obsidian — email z FAZY 1 w komendzie, kursant podaje tylko
# hasło konta (+ ewentualne 2FA). Email przez %q — walidacja FAZY 1 wyklucza
# spacje, ale nie znaki specjalne shella.
login_ob() {
  if has_ob_auth; then
    ok "Obsidian (ob) już zalogowany — pomijam"
    return 0
  fi
  print_pause_header "KROK 3/5: Logowanie do konta Obsidian" \
    "Podaj hasło konta Obsidian (i kod 2FA, jeśli masz włączone)."
  run_login "Obsidian (ob login)" \
    "$(login_cmd_as_claude "ob login --email $(printf '%q' "$OB_EMAIL")")" \
    "has_ob_auth"
}

# PAUZA 4: podpięcie vaulta (Obsidian Sync) — kursant podaje hasło szyfrowania
# end-to-end (INNE niż hasło konta). ~/vault celowo bez %q — ma się rozwinąć
# w shellu usera claude (ścieżka spójna z has_ob_sync i WORKSPACE pełnego trybu).
login_ob_sync() {
  if has_ob_sync; then
    ok "Obsidian Sync już skonfigurowany — pomijam"
    return 0
  fi
  print_pause_header "KROK 4/5: Podpięcie vaulta (Obsidian Sync)" \
    "Podaj hasło szyfrowania end-to-end vaulta (to INNE hasło niż do konta!)."
  local inner
  inner="ob sync-setup --vault $(printf '%q' "$VAULT_NAME") --path ~/vault --device-name $(printf '%q' "$DEVICE_NAME")"
  run_login "Obsidian Sync (ob sync-setup)" "$(login_cmd_as_claude "$inner")" "has_ob_sync"
}

# PAUZA 5: połączenie Tailscale — jako root (bez su, więc bez helpera
# login_cmd_as_claude); klawiaturę i tak podpina run_login.
login_tailscale() {
  if has_tailscale_ip; then
    ok "Tailscale już połączony — pomijam"
    return 0
  fi
  print_pause_header "KROK 5/5: Połączenie Tailscale" \
    "Wejdź w link logowania, który wypisze tailscale."
  run_login "Tailscale (tailscale up)" "tailscale up" "has_tailscale_ip"
}

# ============ FAZA 4: OBSIDIAN (sync-config, vault-git, symlink, systemd) ============

# Automaty pod trapem ERR (R7/R8) — pomijane w main() przy --only-puls
# (decyzja jak przy install_ob: rejestrator wywołań w testach widzi realny
# brak wywołania, nie early-return).

# verify_ob_file_types <wyjście ob sync-status> — czysta funkcja: linia
# "File types:" musi zawierać 'unsupported'. Wyjątkowo parsujemy tekst
# (guardy są exit-code-first), bo sam exit code sync-status nie mówi,
# KTÓRE typy plików są włączone — a brak 'unsupported' to cichy ubytek
# danych (raporty zostają na VPS), nie błąd.
verify_ob_file_types() {
  grep -q 'File types:.*unsupported' <<<"$1"
}

# Konfiguracja typów plików + natychmiastowa weryfikacja. TWARDA kolejność
# (spec FAZA 4): sync-config PRZED `systemctl enable --now obsidian-sync`,
# bo config czytany jest przy starcie procesu sync — odwrotna kolejność
# wymagałaby restartu serwisu i zostawiała okno bez plików nie-media.
configure_obsidian_file_types() {
  echo ""
  info "Ustawiam typy plików Obsidian Sync ($OB_FILE_TYPES)..."
  run_as_claude "ob sync-config --path ~/vault --file-types $OB_FILE_TYPES"
  local status_out
  status_out="$(run_as_claude "ob sync-status --path ~/vault" 2>/dev/null || true)"
  if ! verify_ob_file_types "$status_out"; then
    fail "Konfiguracja typów plików nie przyjęła się — w wyjściu 'ob sync-status --path ~/vault' linia 'File types:' nie zawiera 'unsupported'. Uruchom ręcznie: su - $CLAUDE_USER -c \"ob sync-config --path ~/vault --file-types $OB_FILE_TYPES\", sprawdź sync-status i wklej ponownie komendę instalacji."
  fi
  ok "Typy plików Obsidian Sync zawierają 'unsupported'"
}

# Sparse checkout katalogu .claude z repo vaulta → ~/vault-git. Obsidian Sync
# celowo ignoruje dotfoldery (poza .obsidian), więc .claude jedzie gitem,
# a vault widzi go przez symlink (link_vault_claude). Auth: credential helper
# gh z login_gh — czysty URL bez tokenu (R5). `--sparse` + `sparse-checkout set`
# zamiast `--no-checkout` + jawnego `git checkout <branch>`: checkout dzieje
# się sam na domyślnym branchu repo usera (main/master — nie zgadujemy nazwy).
# Guard .git → git pull (kontrakt re-run: nigdy re-clone istniejącego repo,
# CHYBA że origin nie zgadza się z VAULT_GIT_REPO — collect_config pyta o repo
# przy każdym pełnym runie, więc pull ze STAREGO origin ciągnąłby skille
# (wykonywane z --dangerously-skip-permissions) z innego źródła niż operator
# skonfigurował; mismatch → backup + świeży clone).
clone_vault_git_sparse() {
  local vault_git="$1"
  info "Pobieram katalog .claude (sparse checkout z $VAULT_GIT_REPO)..."
  run_as_claude "git clone --filter=blob:none --sparse $(printf '%q' "$VAULT_GIT_REPO") $(printf '%q' "$vault_git") && cd $(printf '%q' "$vault_git") && git sparse-checkout set .claude"
}

setup_vault_git() {
  local vault_git="$CLAUDE_HOME/vault-git" origin_url
  echo ""
  if [ -d "$vault_git/.git" ]; then
    origin_url="$(run_as_claude "git -C $(printf '%q' "$vault_git") remote get-url origin" 2>/dev/null || true)"
    if [ "$origin_url" = "$VAULT_GIT_REPO" ]; then
      info "Aktualizuję repo .claude (git pull)..."
      run_as_claude "cd $(printf '%q' "$vault_git") && git pull --ff-only"
    else
      warn "Origin $vault_git (${origin_url:-brak}) różni się od skonfigurowanego repo ($VAULT_GIT_REPO) — kopia zapasowa i ponowny clone..."
      mv "$vault_git" "${vault_git}.backup.$(date +%s)"
      clone_vault_git_sparse "$vault_git"
    fi
  else
    if [ -d "$vault_git" ]; then
      warn "$vault_git istnieje bez gita — tworzę kopię zapasową..."
      mv "$vault_git" "${vault_git}.backup.$(date +%s)"
    fi
    clone_vault_git_sparse "$vault_git"
  fi
  # Post-condition (fail-fast): `git sparse-checkout set .claude` przechodzi
  # nawet gdy repo NIE zawiera .claude (git nie waliduje ścieżki) — bez tego
  # guardu link_vault_claude tworzyłby WISZĄCY symlink i skille nigdy nie
  # trafiłyby do vaulta (cichy ubytek), mimo raportu sukcesu.
  [ -d "$vault_git/.claude" ] \
    || fail "Repo $VAULT_GIT_REPO nie zawiera katalogu .claude (sparse checkout nie zmaterializował $vault_git/.claude). Dodaj katalog .claude do repo vaulta i wklej ponownie komendę instalacji."
  ok "Repo .claude: $vault_git"
}

# Symlink ~/vault/.claude → ~/vault-git/.claude. -n (no-dereference) konieczne:
# cel to symlink NA KATALOG — bez -n drugi run tworzyłby link WEWNĄTRZ
# katalogu docelowego zamiast podmienić sam symlink (idempotencja re-run).
link_vault_claude() {
  local vault_claude="$CLAUDE_HOME/vault/.claude"
  # Cudzy stan: REALNY katalog .claude (stary obsidian-vps-installer / ręczna
  # instalacja wg MIGRACJA-PULS) wywala ln -sfn ("cannot overwrite directory")
  # → trap ERR → rollback całego runu. Wzorzec backup-mv jak w setup_vault_git.
  if [ -d "$vault_claude" ] && [ ! -L "$vault_claude" ]; then
    warn "$vault_claude istnieje jako katalog — tworzę kopię zapasową..."
    mv "$vault_claude" "${vault_claude}.backup.$(date +%s)"
  fi
  run_as_claude "ln -sfn $(printf '%q' "$CLAUDE_HOME/vault-git/.claude") $(printf '%q' "$vault_claude")"
  ok "Symlink .claude podpięty: $vault_claude"
}

# build_obsidian_sync_unit <ścieżka ob> <ścieżka vaulta> — czysta funkcja
# zwracająca treść unitu (testowalna bez systemd). ExecStartPre czyści lock
# sync po crashu (bez tego serwis wpada w pętlę restartów — przewodnik
# sekcja 4); Restart=always, bo proces sync ma żyć non-stop.
build_obsidian_sync_unit() {
  local ob_path="$1" vault_path="$2"
  cat <<EOF
[Unit]
Description=Obsidian Headless Sync (Puls)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CLAUDE_USER
ExecStartPre=/bin/rm -rf $vault_path/.obsidian/.sync.lock
ExecStart=$ob_path sync --path $vault_path --continuous
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

create_obsidian_sync_service() {
  echo ""
  info "Tworzę serwis systemd $OB_SYNC_SERVICE..."
  local unit_file="$SYSTEMD_DIR/${OB_SYNC_SERVICE}.service" ob_path unit_existed=0
  ob_path="$(command -v ob)" \
    || fail "Brak binarki 'ob' w PATH — nie mogę utworzyć serwisu $OB_SYNC_SERVICE."
  # Rollback TYLKO dla unit-pliku utworzonego w TYM runie — istniejący unit
  # to cudzy/wcześniejszy stan (kontrakt jak userdel/npm rm z Fazy 3).
  [ -f "$unit_file" ] && unit_existed=1
  build_obsidian_sync_unit "$ob_path" "$CLAUDE_HOME/vault" > "$unit_file"
  if [ "$unit_existed" -eq 0 ]; then
    push_rollback "systemctl disable --now $OB_SYNC_SERVICE 2>/dev/null || true; rm -f '$unit_file'; systemctl daemon-reload"
  fi
  systemctl daemon-reload
  # enable + restart zamiast `enable --now`: --now NIE restartuje działającego
  # serwisu, więc przy re-runie nowy sync-config (czytany przy starcie procesu
  # sync) i nadpisany unit nie weszłyby w życie. Symetria z unitem Pulsa.
  systemctl enable "$OB_SYNC_SERVICE"
  systemctl restart "$OB_SYNC_SERVICE"
  ok "Serwis $OB_SYNC_SERVICE uruchomiony"
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

# Zależności npm aplikacji Puls (po clone) — celowo BEZ prefixu install_*:
# ten prefix jest zarezerwowany dla narzędzi FAZY 2 (przed login_block),
# a test sekwencji w harnessie pilnuje tego po nazwach.
setup_puls_dependencies() {
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
# Walidacja SYMETRYCZNA z resztą bloku pytań (jak ask_valid): ścieżka absolutna,
# poza katalogami systemowymi — root robi na niej mkdir/chown. Nieistniejący
# folder wymaga potwierdzenia, żeby literówka nie była cicho zmaterializowana
# przez mkdir -p w ensure_workspace.
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

  local workspace_input="" candidate="" confirm="" attempt
  for (( attempt=1; attempt<=ASK_MAX_ATTEMPTS; attempt++ )); do
    ask_tty workspace_input "Ścieżka do workspace [$CLAUDE_HOME/workspace]: " "$CLAUDE_HOME/workspace"
    candidate="$(normalize_path "$workspace_input")"
    if ! is_valid_workspace_path "$candidate"; then
      warn "Niepoprawna ścieżka — wymagana absolutna, poza katalogami systemowymi (np. $CLAUDE_HOME/vault)."
      continue
    fi
    if [ ! -d "$candidate" ]; then
      ask_tty confirm "Folder $candidate nie istnieje. Utworzyć? [T/n]: " "T"
      [[ "$confirm" =~ ^[Nn]$ ]] && continue
    fi
    WORKSPACE="$candidate"
    return 0
  done
  fail "Zbyt wiele niepoprawnych odpowiedzi na pytanie o workspace."
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
# chown TYLKO dla świeżo utworzonego katalogu — istniejący mógł należeć do
# innego serwisu i root nie może po cichu przejąć jego ownership.
ensure_workspace() {
  if [ ! -d "$WORKSPACE" ]; then
    mkdir -p "$WORKSPACE"
    chown "$CLAUDE_USER:$CLAUDE_USER" "$WORKSPACE"
    ok "Utworzono workspace: $WORKSPACE"
  fi
  ok "Workspace: $WORKSPACE"
}

# build_puls_env_lines <workspace> <port> <home> <discord_url> — czysta funkcja
# budująca blok Environment= unitu Pulsa. Nazwy zmiennych = kontrakt z
# lib/config.js (CLAUDE_CRON_PORT / CLAUDE_CRON_WORKSPACE / DISCORD_WEBHOOK_URL).
# WEBHOOK_BASE_URL celowo NIE tutaj — dopisuje go dopiero opcjonalny Funnel
# (Faza 6). PATH z ~/.local/bin, bo tam żyje natywnie zainstalowany Claude CLI.
build_puls_env_lines() {
  local workspace="$1" port="$2" home="$3" discord_url="$4"
  printf 'Environment=CLAUDE_CRON_PORT=%s\n' "$port"
  printf 'Environment=CLAUDE_CRON_WORKSPACE=%s\n' "$workspace"
  printf 'Environment=PATH=%s/.local/bin:%s/.npm-global/bin:/usr/local/bin:/usr/bin:/bin\n' "$home" "$home"
  if [ -n "$discord_url" ]; then
    printf 'Environment=DISCORD_WEBHOOK_URL=%s\n' "$discord_url"
  fi
}

create_systemd_service() {
  echo ""
  info "Tworzę serwis systemd..."

  SERVICE_FILE="$SYSTEMD_DIR/${SERVICE_NAME}.service"
  local node_path env_lines unit_existed=0
  node_path=$(which node)
  env_lines="$(build_puls_env_lines "$WORKSPACE" "$PORT" "$CLAUDE_HOME" "$DISCORD_URL")"
  # Rollback TYLKO dla unit-pliku utworzonego w TYM runie (jak obsidian-sync).
  [ -f "$SERVICE_FILE" ] && unit_existed=1

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

  if [ "$unit_existed" -eq 0 ]; then
    push_rollback "systemctl disable --now $SERVICE_NAME 2>/dev/null || true; rm -f '$SERVICE_FILE'; systemctl daemon-reload"
  fi

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

# Odczyt adresu Tailscale do podsumowania — samo łączenie (`tailscale up`)
# to PAUZA 5 bloku loginów (login_tailscale), tu już tylko odczyt IP.
setup_tailscale() {
  TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
  if [ -n "$TS_IP" ]; then
    ok "Tailscale IP: $TS_IP"
  else
    warn "Tailscale niepołączony — uruchom 'tailscale up' później"
  fi
}

# ============ FAZA 6: FUNNEL (opt-in NA SAMYM KOŃCU) ============

# parse_funnel_url <wyjście `tailscale funnel status`> — czysta funkcja:
# pierwszy URL https, bez końcowego slasha. Format wyjścia funnel status jest
# nieudokumentowany (odroczone w planie) — brak dopasowania → setup_funnel
# pyta usera o URL. grep -oE, nie -oP: harness biega też na BSD grep.
parse_funnel_url() {
  { grep -oE 'https://[^[:space:]]+' <<<"$1" || true; } | head -1 | sed 's|/$||'
}

# add_webhook_env_line <url> — czysta funkcja (stdin: treść unitu → stdout):
# linia Environment=WEBHOOK_BASE_URL wstawiona przed SyslogIdentifier, stara
# usuwana (idempotentny re-run z Funnelem). Przepisanie treści zamiast
# `sed -i "/…/i …"`: to składnia GNU — BSD sed (macOS, gdzie biega harness)
# jej nie zna, a test ma weryfikować REALNĄ transformację, nie stub seda.
add_webhook_env_line() {
  local url="$1"
  grep -v '^Environment=WEBHOOK_BASE_URL=' \
    | awk -v line="Environment=WEBHOOK_BASE_URL=$url" \
        '/SyslogIdentifier/ { print line } { print }'
}

# Wpis WEBHOOK_BASE_URL do unitu Pulsa + restart — env czytany przez server.js
# przy starcie, więc bez restartu Funnel nie działałby do najbliższego bootu.
set_service_webhook_env() {
  local service_file="$SYSTEMD_DIR/${SERVICE_NAME}.service" updated
  updated="$(add_webhook_env_line "$WEBHOOK_BASE_URL" < "$service_file")"
  # Zapis atomowy (temp+mv) — pad w połowie zapisu nie zostawia okaleczonego unitu.
  printf '%s\n' "$updated" > "${service_file}.tmp"
  mv "${service_file}.tmp" "$service_file"
  # Warn-nie-fail (konwencja finału, jak verify_services/create_welcome_note):
  # Funnel to opcjonalny krok NA SAMYM KOŃCU — pad restartu pod trap ERR
  # odwinąłby rollback działającej, zweryfikowanej instalacji.
  if ! systemctl daemon-reload || ! systemctl restart "$SERVICE_NAME"; then
    warn "Restart serwisu z WEBHOOK_BASE_URL nie powiódł się — uruchom ręcznie: systemctl daemon-reload && systemctl restart $SERVICE_NAME (diagnoza: journalctl -u $SERVICE_NAME -n 30)"
    return 0
  fi
  sleep 1
  ok "WEBHOOK_BASE_URL ustawiony w serwisie systemd"
}

# Opcjonalny Tailscale Funnel — pytanie celowo NA SAMYM KOŃCU przebiegu
# (spec FAZA 6): jego koszt (jednorazowe zatwierdzenie w admin console
# Tailscale) ma paść PO tym, jak wszystko działa. W lekcji B1 webhooki są
# nieużywane — kto nie wie, klika N; wraca re-runem po lekcji o webhookach.
setup_funnel() {
  echo ""
  local answer=""
  ask_tty answer "Włączyć Tailscale Funnel dla webhooków? (wystawia /webhook/* na internet) [t/N]: " "N"

  WEBHOOK_BASE_URL=""
  if [[ ! "$answer" =~ ^[TtYy]$ ]]; then
    return 0
  fi

  if ! command -v tailscale &>/dev/null; then
    warn "Tailscale niezainstalowany — pomijam Funnel"
    return 0
  fi

  info "Uruchamiam Tailscale Funnel na porcie $PORT..."
  # rc łapany w if, stderr NIEtłumiony (konwencja z review fazy 5) — komunikat
  # tailscale z linkiem do zatwierdzenia node-attribute musi dotrzeć do usera.
  if ! tailscale funnel --bg "$PORT"; then
    warn "Funnel nie wystartował — pierwsze uruchomienie może wymagać zatwierdzenia w panelu Tailscale (link w komunikacie powyżej)."
  fi

  local funnel_status=""
  if ! funnel_status="$(tailscale funnel status)"; then
    funnel_status=""
  fi
  WEBHOOK_BASE_URL="$(parse_funnel_url "$funnel_status")"
  if [ -n "$WEBHOOK_BASE_URL" ]; then
    ok "Funnel aktywny: $WEBHOOK_BASE_URL"
  else
    ask_tty WEBHOOK_BASE_URL "Podaj URL Tailscale Funnel (np. https://srv123.tail456.ts.net): " ""
  fi

  if [ -z "$WEBHOOK_BASE_URL" ]; then
    warn "Brak URL Funnela — webhooki włączysz później, wklejając ponownie komendę instalacji."
    return 0
  fi
  set_service_webhook_env
}

# ============ FAZA 6: AUTO-UPDATE (cron 02:00, opt-out --no-auto-update) ============

# build_cron_cmd <vault_git> <install_dir> <guard_script> <cron_log> <only_puls>
# — czysta funkcja: linia crontaba auto-update. Godziny 02:00 NIE ZMIENIAĆ —
# spójność z oknem maintenance 02:00–02:15 (lib/config.js MAINTENANCE_WINDOW)
# i missed-job detection schedulera. Ścieżki przez %q (fix P3 z zadania
# ulatwienie-instalacji: niecytowany $VAULT_GIT psuł cron przy spacji);
# dla zwykłych ścieżek %q nie emituje znaku % (specjalnego w crontabie).
# Pull leci jako $CLAUDE_USER (gh credential helper z bloku loginów) z logiem
# do claude-cron-update.log (odwołanie autoryzacji gh na GitHubie = cichy
# fail crona, log wystarczy — spec FAZA 6); restart jako root, wstrzymywany
# przez node-guard. Przy --only-puls nie ma vault-git — segment pomijany.
build_cron_cmd() {
  local vault_git="$1" install_dir="$2" guard_script="$3" cron_log="$4" only_puls="$5"
  local inner=""
  if [ "$only_puls" != 1 ]; then
    inner="cd $(printf '%q' "$vault_git") && git pull && "
  fi
  inner+="cd $(printf '%q' "$install_dir") && git pull && bash $(printf '%q' "$guard_script")"
  inner="{ $inner; } >> $(printf '%q' "$cron_log") 2>&1"
  printf '0 2 * * * su - %s -c %q && systemctl restart %s\n' \
    "$CLAUDE_USER" "$inner" "$SERVICE_NAME"
}

# Passwordless sudo dla restartu serwisu przez usera claude — rollback tylko
# gdy plik sudoers powstał w TYM runie (kontrakt jak unit-pliki), wpis na
# stosie PRZED zapisem (konwencja z review fazy 5, wpis idempotentny).
write_update_sudoers() {
  local sudoers_file="$SUDOERS_DIR/$SERVICE_NAME"
  if [ ! -f "$sudoers_file" ]; then
    push_rollback "rm -f '$sudoers_file'"
  fi
  echo "$CLAUDE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE_NAME" > "$sudoers_file"
  chmod 440 "$sudoers_file"
  ok "Passwordless sudo dla restartu serwisu"
}

# Pre-check wersji Node dla crona — wstrzymuje restart, gdy Node serwisu jest
# niekompatybilny (np. operator zdegradował Node po instalacji). git pull i tak
# się wykona (kod się zaktualizuje), ale restart na złym Node tylko ubiłby wszystkie
# joby (node:sqlite rzuca przy starcie — zob. lib/runtime-guard.js). Skrypt zapisany
# obok instalacji, uruchamiany jako user $CLAUDE_USER (ten sam Node co serwis).
write_cron_node_guard() {
  local guard_script="$1" cron_log="$2"

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
  # chown może paść (nietypowy fs) — nie blokuje auto-update (guard jest
  # world-readable), więc warn zamiast fail; stderr chown zostaje widoczny.
  if ! chown "$CLAUDE_USER:$CLAUDE_USER" "$guard_script"; then
    warn "Nie udało się zmienić właściciela $guard_script — auto-update zadziała mimo to."
  fi
  ok "Cron Node guard: $guard_script"
}

# Wpis do crontaba roota z dedupem (grep -v po $SERVICE_NAME) — re-run
# nadpisuje własną linię zamiast dublować. Rollback tylko gdy crontab nie
# miał jeszcze wpisu Pulsa (wpis sprzed runa = cudzy stan); rejestrowany
# PRZED zapisem, sam wpis idempotentny.
install_update_cron() {
  local guard_script="$1" cron_log="$2" cron_cmd existing_cron
  cron_cmd="$(build_cron_cmd "$CLAUDE_HOME/vault-git" "$INSTALL_DIR" "$guard_script" "$cron_log" "$FLAG_ONLY_PULS")"

  if ! crontab -l 2>/dev/null | grep -q "$SERVICE_NAME"; then
    push_rollback "crontab -l 2>/dev/null | grep -v '$SERVICE_NAME' | crontab - || true"
  fi

  existing_cron=$(crontab -l 2>/dev/null | grep -v "$SERVICE_NAME" || true)
  if [ -n "$existing_cron" ]; then
    printf '%s\n%s\n' "$existing_cron" "$cron_cmd" | crontab -
  else
    printf '%s\n' "$cron_cmd" | crontab -
  fi
  ok "Cron: codziennie o 02:00 — auto-update + restart serwisu"
}

# Auto-update ZAWSZE (spec FAZA 6) — bez pytania; jedyny opt-out to flaga
# --no-auto-update. Konsekwencję kursant widzi wcześniej w podsumowaniu
# konfiguracji i zatwierdza przez „Kontynuujemy?".
setup_auto_update() {
  if [ "$FLAG_NO_AUTO_UPDATE" = 1 ]; then
    info "Auto-update pominięty (--no-auto-update)"
    return 0
  fi

  echo ""
  info "Ustawiam codzienny auto-update (cron o 02:00)..."
  local guard_script="$INSTALL_DIR/scripts/cron-node-guard.sh"
  local cron_log="$CLAUDE_HOME/claude-cron-update.log"
  write_update_sudoers
  write_cron_node_guard "$guard_script" "$cron_log"
  install_update_cron "$guard_script" "$cron_log"
}

# ============ FAZA 6: WERYFIKACJA + PLIK-DOWÓD ============

check_service_active() {
  local svc="$1"
  if systemctl is-active --quiet "$svc"; then
    ok "Serwis $svc działa"
  else
    warn "Serwis $svc NIE działa — sprawdź: journalctl -u $svc -n 30"
  fi
}

# is_sync_complete <wyjście `ob sync-status`> — czysta heurystyka pierwszego
# synca. Dokładne stringi wyjść ob odroczone (młody pakiet, format może się
# zmieniać) — dopasowanie odporne, case-insensitive; potwierdzenie na żywym
# narzędziu = Operator checklist. 'syncing' celowo NIE matchuje ('synced'
# wymaga pełnego 'ed').
is_sync_complete() {
  grep -qiE 'synced|up.to.date|complete' <<<"$1"
}

# Pętla do SYNC_WAIT_MAX_SECONDS na pierwszy sync vaulta (R11). Timeout =
# warn + instrukcja, nie fail — zob. komentarz przy stałych SYNC_*.
wait_for_first_sync() {
  info "Czekam na pierwszy sync vaulta (do ${SYNC_WAIT_MAX_SECONDS} s)..."
  local waited=0 status_out=""
  while [ "$waited" -lt "$SYNC_WAIT_MAX_SECONDS" ]; do
    if status_out="$(run_as_claude "ob sync-status --path ~/vault" 2>&1)" \
      && is_sync_complete "$status_out"; then
      ok "Pierwszy sync zakończony"
      return 0
    fi
    sleep "$SYNC_POLL_SECONDS"
    waited=$((waited + SYNC_POLL_SECONDS))
  done
  warn "Sync jeszcze trwa po ${SYNC_WAIT_MAX_SECONDS} s — przy dużym vaulcie to normalne."
  warn "Postęp sprawdzisz: su - $CLAUDE_USER -c 'ob sync-status --path ~/vault'"
}

# Weryfikacja finału (R11): oba serwisy active + czekanie na pierwszy sync.
# Padnięty serwis = warn z instrukcją, nie fail — instalacja jest kompletna,
# a ERR tutaj odwinąłby rollback stanu, który w większości działa.
verify_services() {
  echo ""
  info "Sprawdzam serwisy..."
  check_service_active "$SERVICE_NAME"
  if [ "$FLAG_ONLY_PULS" != 1 ]; then
    check_service_active "$OB_SYNC_SERVICE"
    wait_for_first_sync
  fi
}

# build_welcome_note — czysta funkcja: treść pliku-dowodu (PL, spec FAZA 6).
build_welcome_note() {
  cat <<'NOTE'
# 🎉 Twój asystent w chmurze działa!

Ta notatka powstała na Twoim serwerze VPS i dotarła tu przez Obsidian Sync.
Jeśli czytasz ją na telefonie lub komputerze, cały łańcuch działa:

VPS → Obsidian Sync → Twoje urządzenie

Możesz spokojnie usunąć tę notatkę.
NOTE
}

# Plik-dowód: prawdziwy test end-to-end (zapis na VPS → ob sync → serwer →
# telefon) i moment „wow" kursanta — nagroda na JEGO urządzeniu, nie w
# terminalu (dashboard w B1 jeszcze nieosiągalny). Pad zapisu = warn, nie
# fail (notatka to dowód, nie stan krytyczny — rollback działającej
# instalacji byłby gorszy niż brak notatki). Pomijany w main() przy
# --only-puls (konwencja rejestratora wywołań).
create_welcome_note() {
  echo ""
  info "Tworzę notatkę-dowód w vaulcie..."
  if build_welcome_note | run_as_claude "cat > ~/vault/Witaj-z-VPS.md"; then
    ok "Notatka zapisana: ~/vault/Witaj-z-VPS.md"
    echo ""
    echo -e "  ${BOLD}📱 Otwórz Obsidiana na telefonie — za chwilę pojawi się notatka${NC}"
    echo -e "  ${BOLD}   «Witaj z VPS». Jeśli ją widzisz — wszystko działa.${NC}"
  else
    warn "Nie udało się zapisać notatki ~/vault/Witaj-z-VPS.md — sprawdź, czy vault istnieje."
  fi
}

print_summary() {
  echo ""
  echo "========================================"
  echo -e "${GREEN}🕹️  PULS — instalacja na VPS zakończona!${NC}"
  echo "========================================"
  echo ""
  echo -e "  ${BOLD}Serwis:${NC}     $SERVICE_NAME (systemd)"
  [ "$FLAG_ONLY_PULS" = 1 ] || echo -e "  ${BOLD}Serwis:${NC}     $OB_SYNC_SERVICE (systemd)"
  echo -e "  ${BOLD}Użytkownik:${NC} $CLAUDE_USER"
  echo -e "  ${BOLD}Repo:${NC}       $INSTALL_DIR"
  echo -e "  ${BOLD}Workspace:${NC}  $WORKSPACE"
  echo -e "  ${BOLD}Port:${NC}       $PORT"

  if [ -n "$TS_IP" ]; then
    echo ""
    echo -e "  ${BOLD}Dashboard:${NC}  ${CYAN}http://$TS_IP:$PORT${NC}"
    echo "              Otworzysz go po zainstalowaniu Tailscale na swoim komputerze —"
    echo "              pokażemy to w lekcji o Pulsie."
  fi
  if [ -n "$WEBHOOK_BASE_URL" ]; then
    echo -e "  ${BOLD}Webhooki:${NC}   ${CYAN}$WEBHOOK_BASE_URL/webhook/<token>${NC}"
  fi
  if [ -n "$DISCORD_URL" ]; then
    echo -e "  ${BOLD}Discord:${NC}    powiadomienia włączone"
  fi

  echo ""
  echo -e "  ${BOLD}Przydatne komendy:${NC}"
  echo "    systemctl status $SERVICE_NAME        # status serwisu"
  echo "    journalctl -u $SERVICE_NAME -f        # logi na żywo"
  echo "    systemctl restart $SERVICE_NAME       # restart"
  [ "$FLAG_ONLY_PULS" = 1 ] || echo "    systemctl status $OB_SYNC_SERVICE       # status synca Obsidiana"
  echo "    su - $CLAUDE_USER -c 'cd ~/claude-cron && git pull'  # aktualizacja kodu"
  echo ""

  if [ -n "$TS_IP" ]; then
    echo -e "  ${BOLD}Połączenie z Twojego komputera (po lekcji o Pulsie):${NC}"
    echo "    Dodaj do ~/.zshrc:"
    echo "      export CLAUDE_CRON_VPS_URL=http://$TS_IP:$PORT"
    echo ""
  fi

  echo -e "  ${BOLD}Bezpieczeństwo:${NC}"
  echo "    - Port $PORT jest ZABLOKOWANY w firewallu (dostęp tylko przez Tailscale)"
  echo "    - Dashboard NIE jest dostępny z publicznego internetu"
  if [ -n "$WEBHOOK_BASE_URL" ]; then
    echo "    - Publicznie wystawione są tylko endpointy /webhook/* (Tailscale Funnel)"
  else
    echo "    - Nic nie jest wystawione na publiczny internet (Funnel wyłączony)"
  fi
  echo "    - Claude CLI działa jako dedykowany użytkownik '$CLAUDE_USER' (nie root)"
  echo ""
}

# ============ FAZA 7: RESET (deinstalacja, --reset) ============

# build_reset_paths — wypełnia tablicę RESET_PATHS plikami-artefaktami
# instalacji do usunięcia. Tablica zamiast stdout+read: grep-strażnik
# harnessu zakazuje `read` poza ask_tty. Osobna funkcja (nie inline
# w run_reset), żeby test mógł zwalidować listę BEZ wykonywania rm —
# każda ścieżka musi być niepusta i absolutna, zanim remove_reset_path
# dostanie ją do rm -rf.
RESET_PATHS=()
build_reset_paths() {
  RESET_PATHS=(
    "$SYSTEMD_DIR/${OB_SYNC_SERVICE}.service"
    "$SYSTEMD_DIR/${SERVICE_NAME}.service"
    "$SUDOERS_DIR/$SERVICE_NAME"
  )
}

# remove_reset_path <ścieżka> — usunięcie artefaktu resetu. Guard ${…:?}
# (pusta wartość = twardy fail PRZED rm, nie rm -rf na przypadkowej ścieżce)
# + guard istnienia (nieistniejący artefakt = no-op, reset na czystym
# systemie przechodzi bez błędów). -L łapie wiszący symlink ([ -e ] podąża
# za linkiem i dla wiszącego zwraca false).
remove_reset_path() {
  local path="${1:?remove_reset_path: pusta ścieżka — odmawiam rm -rf}"
  if [ -e "$path" ] || [ -L "$path" ]; then
    rm -rf "${path:?}"
    ok "Usunięto: $path"
  else
    info "Brak $path — pomijam."
  fi
}

# DOKŁADNA lista do usunięcia (spec R12) — kursant widzi każdy artefakt
# PRZED potwierdzeniem, plus jawną listę tego, czego reset świadomie
# NIE usuwa (Tailscale/UFW/pakiety współdzielone z systemem).
print_reset_plan() {
  echo ""
  echo -e "${YELLOW}${BOLD}RESET — deinstalacja Pulsa i Obsidian Sync z tego VPS${NC}"
  echo "─────────────────────────────────────"
  echo "Zostanie usunięte:"
  echo "  • serwis $OB_SYNC_SERVICE (stop + disable)"
  echo "  • serwis $SERVICE_NAME (stop + disable)"
  local reset_path
  build_reset_paths
  for reset_path in "${RESET_PATHS[@]}"; do
    echo "  • plik $reset_path"
  done
  echo "  • wpis auto-update w crontabie roota (linie z '$SERVICE_NAME')"
  echo "  • użytkownik '$CLAUDE_USER' wraz z całym $CLAUDE_HOME"
  echo "    (vault lokalny, vault-git, baza data/, loginy Claude/gh/ob)"
  echo ""
  echo -e "  ${GREEN}Dane vaulta są BEZPIECZNE na serwerze Obsidian Sync${NC} — VPS trzymał"
  echo "  tylko lokalną kopię; komputer i telefon nadal mają wszystko."
  echo ""
  echo "NIE zostanie usunięte (współdzielone z systemem):"
  echo "  • Tailscale — urządzenie zostaje w tailnecie; odłącz je ręcznie:"
  echo "      tailscale logout"
  echo "    i usuń maszynę w panelu: https://login.tailscale.com/admin/machines"
  echo "  • reguły UFW — port odblokujesz ręcznie: ufw delete deny $PORT/tcp"
  echo "  • Node.js, gh i pakiety apt (git, curl, cron)"
  echo ""
}

# Potwierdzenie DOSŁOWNYM „TAK" — nie [T/n]: operacja kasuje /home/claude,
# więc samo Enter (odruchowe) nie może jej uruchomić. Brak tty → default ""
# → anulowanie: bez jawnej zgody z klawiatury niczego nie kasujemy.
confirm_reset() {
  local answer=""
  ask_tty answer "Aby potwierdzić deinstalację, wpisz TAK (wielkimi literami; Enter = anuluj): " ""
  if [ "$answer" != "TAK" ]; then
    info "Reset anulowany — nic nie zostało usunięte."
    exit 0
  fi
}

# Stop/disable serwisów PRZED usuwaniem plików (proces sync/serwera nie może
# przeżyć skasowania swojego unitu). Guard [ -f ] na unit-pliku: świeży system
# bez serwisu = no-op; `|| true` — padnięty/zamaskowany serwis nie przerywa resetu.
reset_services() {
  command -v systemctl &>/dev/null || return 0
  local svc
  for svc in "$OB_SYNC_SERVICE" "$SERVICE_NAME"; do
    if [ -f "$SYSTEMD_DIR/$svc.service" ]; then
      systemctl disable --now "$svc" 2>/dev/null || true
      ok "Serwis $svc zatrzymany i wyłączony"
    else
      info "Serwis $svc nie istnieje — pomijam."
    fi
  done
}

# Usunięcie wpisu auto-update z crontaba roota — odwrócony dedup-filter
# z install_update_cron (grep -v po $SERVICE_NAME): cudze wpisy roota zostają.
# `|| true` na pipeline: grep -v zwraca 1, gdy wpis Pulsa był jedyną linią
# (pusty wynik), a pipefail zrobiłby z tego ERR mimo poprawnego czyszczenia.
remove_update_cron() {
  if ! command -v crontab &>/dev/null; then
    info "Brak crontab — pomijam wpis auto-update."
    return 0
  fi
  local current
  if ! current="$(crontab -l 2>/dev/null)"; then
    info "Crontab roota pusty — brak wpisu auto-update."
    return 0
  fi
  if ! grep -q "$SERVICE_NAME" <<<"$current"; then
    info "Brak wpisu auto-update w crontabie — pomijam."
    return 0
  fi
  printf '%s\n' "$current" | grep -v "$SERVICE_NAME" | crontab - || true
  ok "Wpis auto-update usunięty z crontaba roota"
}

# `userdel -r` kasuje cały /home/claude (vault lokalny, vault-git, loginy
# Claude/gh/ob) — dane vaulta zostają na serwerze Obsidian Sync (komunikat
# w print_reset_plan/summary). Pad userdel (np. proces usera jeszcze żyje)
# = warn z instrukcją, nie ERR — reset ma usunąć co się da i powiedzieć,
# co zostało do ręcznego dokończenia.
remove_claude_user() {
  if ! has_user_claude; then
    info "Użytkownik '$CLAUDE_USER' nie istnieje — pomijam."
    return 0
  fi
  info "Usuwam użytkownika '$CLAUDE_USER' wraz z katalogiem domowym..."
  if userdel -r "$CLAUDE_USER"; then
    ok "Użytkownik '$CLAUDE_USER' usunięty (dane vaulta są nadal na serwerze Obsidian Sync)"
  else
    warn "userdel nie powiódł się — dokończ ręcznie: userdel -r $CLAUDE_USER"
  fi
}

print_reset_summary() {
  echo ""
  echo "========================================"
  echo -e "${GREEN}Deinstalacja zakończona.${NC}"
  echo "========================================"
  echo ""
  echo -e "  ${BOLD}Dane vaulta są bezpieczne${NC} — serwer Obsidian Sync nadal je przechowuje;"
  echo "  VPS miał tylko lokalną kopię."
  echo ""
  echo -e "  ${BOLD}Pozostało na VPS (usuń ręcznie, jeśli chcesz):${NC}"
  echo "    - Tailscale: tailscale logout, potem usuń maszynę w"
  echo "      https://login.tailscale.com/admin/machines"
  echo "    - UFW: ufw delete deny $PORT/tcp"
  echo "    - Node.js, gh, git, curl, cron (pakiety apt współdzielone z systemem)"
  echo ""
  echo "  Ponowna instalacja: wklej komendę instalacji jeszcze raz."
  echo ""
}

# --reset (R12): pełna deinstalacja — osobna ścieżka wykonywana WCZEŚNIE
# w main(), przed jakimkolwiek flow instalacyjnym; kończy skrypt. Kolejność:
# lista → potwierdzenie TAK → stop/disable serwisów → pliki (unit-pliki,
# sudoers) → daemon-reload → cron roota → userdel -r. Wszystkie kroki
# idempotentne (guardy [ -f ]/has_*) — reset na czystym systemie przechodzi.
# Rollback wyłączony: reset przy błędzie niczego nie „cofa" — usuwa co się
# da i raportuje, co zostało.
run_reset() {
  check_root
  disable_rollback
  resolve_install_paths
  print_reset_plan
  confirm_reset

  reset_services
  local reset_path
  build_reset_paths
  for reset_path in "${RESET_PATHS[@]}"; do
    remove_reset_path "$reset_path"
  done
  if command -v systemctl &>/dev/null; then
    systemctl daemon-reload 2>/dev/null || true
  fi
  remove_update_cron
  remove_claude_user
  print_reset_summary
}

# ============ MAIN ============

main() {
  trap on_err ERR
  parse_flags "$@"

  # --reset = deinstalacja: osobna ścieżka PRZED całym flow instalacyjnym,
  # kończy skrypt (spec R12) — żadne pytanie/instalacja nie może jej poprzedzić.
  if [ "$FLAG_RESET" = 1 ]; then
    run_reset
    exit 0
  fi

  print_banner
  run_preflight          # FAZA 0: root/OS/internet + checklist + detekcja stanu
  resolve_install_paths
  collect_config         # FAZA 1: blok 4 pytań + auto-wartości + potwierdzenie
  apply_timezone

  # FAZA 2: WSZYSTKIE narzędzia przed pierwszą pauzą interaktywną — re-run po
  # padzie loginu (leave-partial) wskakuje od razu w brakujący login, bez
  # powrotu do instalacji pakietów. Decyzja o pominięciu kroków Obsidianowych
  # zapada TUTAJ (nie wewnątrz install_ob) — rejestrator wywołań w testach
  # widzi wtedy realny brak wywołania, nie early-return.
  install_base_packages
  install_node
  ensure_claude_user
  ensure_workspace
  install_claude_cli
  [ "$FLAG_ONLY_PULS" = 1 ] || install_ob
  install_tailscale

  login_block            # FAZA 3: blok 5 loginów — jedyna strefa interaktywna

  # FAZA 4 spec-u (Obsidian) — automaty pod trapem ERR. KOLEJNOŚĆ TWARDA:
  # sync-config + weryfikacja PRZED `systemctl enable --now obsidian-sync`
  # (config czytany przy starcie procesu sync). Pominięcie przy --only-puls
  # zapada TUTAJ (jak install_ob) — rejestrator wywołań w testach widzi
  # realny brak wywołania.
  if [ "$FLAG_ONLY_PULS" != 1 ]; then
    configure_obsidian_file_types
    setup_vault_git
    link_vault_claude
    create_obsidian_sync_service
  fi

  clone_repo
  setup_puls_dependencies
  create_systemd_service

  # FAZA 5 spec-u: sieć — zero interakcji (UFW + odczyt TS_IP; samo
  # `tailscale up` to PAUZA 5 bloku loginów).
  configure_firewall
  setup_tailscale

  # FAZA 6 spec-u: auto-update ZAWSZE (opt-out --no-auto-update) → weryfikacja
  # serwisów (do 90 s na pierwszy sync) → plik-dowód (nagroda na telefonie) →
  # opcjonalny Funnel NA SAMYM KOŃCU → podsumowanie. Pominięcie pliku-dowodu
  # przy --only-puls zapada TUTAJ (konwencja rejestratora wywołań w testach,
  # jak install_ob i blok Obsidian).
  setup_auto_update
  verify_services
  [ "$FLAG_ONLY_PULS" = 1 ] || create_welcome_note
  setup_funnel
  print_summary
}

# Test harness może wczytać tylko funkcje (CLAUDE_CRON_LIB_ONLY=1),
# bez odpalania main (instalacji pakietów / pytań interaktywnych).
if [ "${CLAUDE_CRON_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi
