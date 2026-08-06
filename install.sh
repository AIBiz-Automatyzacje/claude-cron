#!/usr/bin/env bash
set -euo pipefail

# ============================================
#  CLAUDE-CRON — Portable Node bootstrap (Mac/Linux)
#
#  Tryb DUALNY:
#   - LOKALNY: skrypt leży obok setup.mjs (sklonowane repo) →
#     stawia przenośny Node w .node/ i odpala setup.mjs. Bez pobierania kodu.
#   - BOOTSTRAP (curl|bash): skryptu nie ma obok setup.mjs →
#     pobiera repo tarballem (bez git) do ~/claude-cron, zachowuje
#     istniejące data/ i .node/ (re-run NIE kasuje bazy), po czym
#     wchodzi w tryb lokalny w docelowym katalogu.
#
#  Bootstrap NIE zawiera logiki konfiguracyjnej — robi wyłącznie
#  portable Node + pobranie kodu. Nie dotyka systemowego Node,
#  PATH ani profilu (.zshrc/.bashrc).
# ============================================

# Pinowany patch portable Node — najnowszy stabilny 22.x LTS,
# spójny z oknem engines ">=22.13 <25".
NODE_VERSION="22.17.0"

# Bootstrap: skąd bierzemy kod. Archiwum adresujemy po SHA commita (rozstrzyganym przed
# pobraniem), nie po nazwie gałęzi — nazwa gałęzi jest cache'owana po stronie GitHuba,
# a przy okazji nie mówi, CO faktycznie rozpakowaliśmy. Override URL-a przez env
# (test z brancha przed mergem, forki, mirrory) pomija rozstrzyganie.
REPO_SLUG="${CLAUDE_CRON_REPO_SLUG:-AIBiz-Automatyzacje/claude-cron}"
REPO_REF="${CLAUDE_CRON_REF:-main}"
TARBALL_URL="${CLAUDE_CRON_TARBALL_URL:-}"
TARBALL_TOPDIR="${CLAUDE_CRON_TARBALL_TOPDIR:-}"

# Rewizja faktycznie pobranego kodu — przekazywana do setup.mjs, który zapisuje ją do
# data/version.json (widoczne w /api/status). Pusta = nieznana; instalacja leci dalej.
INSTALL_REVISION="${CLAUDE_CRON_INSTALL_REVISION:-}"
INSTALL_SOURCE="${CLAUDE_CRON_INSTALL_SOURCE:-tarball}"

# Docelowy katalog instalacji w trybie bootstrap. Env-override (testy, automatyzacja,
# druga instancja obok pierwszej) wygrywa i POMIJA pytanie — inaczej nieinteraktywny
# przebieg z jawnie podanym katalogiem i tak pytałby o niego użytkownika.
INSTALL_DIR_DEFAULT="$HOME/claude-cron"
INSTALL_DIR_EXPLICIT=0
# Forma if/then, NIE `[ ... ] && VAR=1`: pod `set -e` fałszywy test na końcu listy kończy
# cały skrypt (przy pustym INSTALL_DIR instalator wychodził tu z kodem 1, bez komunikatu).
if [ -n "${INSTALL_DIR:-}" ]; then
  INSTALL_DIR_EXPLICIT=1
fi
INSTALL_DIR="${INSTALL_DIR:-$INSTALL_DIR_DEFAULT}"

# Katalogi przenoszone ze starej instalacji do świeżej (allowlist, NIE blacklist).
# data/  = baza SQLite + logi (NIGDY nie kasować przy re-run).
# .node/ = przenośny Node (oszczędza ponowne pobieranie).
PRESERVE_DIRS=("data" ".node")

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}[ok]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

# ============ DOWNLOAD TOOL ============

download() {
  # download <url> <output-path>
  local url="$1" out="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$out" || return 1
  elif command -v wget &>/dev/null; then
    wget -q "$url" -O "$out" || return 1
  else
    fail "Brak curl ani wget — nie mogę pobrać plików."
  fi
}

# ============ DETECT PLATFORM + ARCH ============

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux)  echo "linux" ;;
    *) fail "Nieobsługiwany system: $(uname -s). Ten bootstrap jest dla Mac/Linux (Windows: install.ps1)." ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64)  echo "x64" ;;
    *) fail "Nieobsługiwana architektura: $(uname -m)." ;;
  esac
}

# ============ KATALOG INSTALACJI ============

# resolve_install_dir <odpowiedz> <domyslny> [baza] — czysta zamiana odpowiedzi na ścieżkę.
# Puste (sam Enter) → domyślny katalog. Drag & drop z Findera dokleja cudzysłowy i escape'y
# spacji, a `~` w wartości z `read` NIE jest rozwijane przez powłokę (rozwijanie tyldy
# działa tylko na tekście kodu) — obie rzeczy trzeba obsłużyć tu, inaczej powstałby
# katalog o nazwie "~". Ścieżka względna → absolutna, bo cwd instalatora bywa przypadkowy.
resolve_install_dir() {
  local answer="$1" fallback="$2" base="${3:-$PWD}"
  answer="${answer//\"/}"
  answer="${answer//\'/}"
  answer="${answer//\\/}"
  answer="$(printf '%s' "$answer" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

  [ -n "$answer" ] || { printf '%s' "$fallback"; return 0; }

  case "$answer" in
    "~")   answer="$HOME" ;;
    "~/"*) answer="$HOME/${answer#\~/}" ;;
    /*)    ;;
    *)     answer="$base/$answer" ;;
  esac
  printf '%s' "$answer"
}

# Źródło odpowiedzi interaktywnych. Override WYŁĄCZNIE dla testów (podstawiony plik
# udaje terminal) — w realnym przebiegu zawsze /dev/tty.
INSTALL_TTY="${INSTALL_TTY:-/dev/tty}"

# is_puls_install <dir> — czy katalog wygląda na instalację Pulsa (kod + stan).
# Rozpoznajemy po ARTEFAKTACH instalacji, nie po nazwie katalogu: nazwa jest wolną
# odpowiedzią usera, a decyzja „wolno to skasować" musi wisieć na zawartości.
is_puls_install() {
  local dir="$1"
  if [ -f "$dir/package.json" ] \
    && grep -q '"name"[[:space:]]*:[[:space:]]*"claude-cron"' "$dir/package.json" 2>/dev/null; then
    return 0
  fi
  # Instalacja bootstrapowa: kod serwera + katalog stanu (data/) albo portable Node (.node/).
  if [ -f "$dir/server.js" ] && { [ -d "$dir/data" ] || [ -d "$dir/.node" ]; }; then
    return 0
  fi
  return 1
}

# classify_install_target <dir> — czysta klasyfikacja celu instalacji:
#   forbidden = $HOME albo korzeń (podmiana = katastrofa, nigdy nie ruszamy)
#   file      = ścieżka istnieje, ale nie jest katalogiem
#   empty     = nie istnieje albo jest pusty (wolno zająć)
#   puls      = rozpoznana instalacja Pulsa (re-run — wolno podmienić)
#   foreign   = niepusty katalog z CUDZĄ zawartością (wymaga potwierdzenia)
# Sprowadza ścieżkę do postaci porównywalnej z $HOME. Dwa kroki, bo dotyczą dwóch
# różnych klas zapisu tego samego katalogu:
#   1) wszystkie końcowe ukośniki („~//" → „$HOME") — `${dir%/}` zdejmuje tylko jeden,
#   2) segmenty „." i ".." („~/." , „~/kat/.." → „$HOME") — dla ścieżek ISTNIEJĄCYCH
#      robi to jądro przez `cd` + `pwd -P` (rozwija przy okazji symlinki).
# Ścieżki nieistniejącej nie ma czego kanonizować — i tak wyjdzie `empty`.
canonicalize_dir_path() {
  local p="$1" resolved
  while [ "$p" != "${p%/}" ]; do p="${p%/}"; done
  if [ -d "$p" ] && resolved="$(cd "$p" 2>/dev/null && pwd -P)" && [ -n "$resolved" ]; then
    printf '%s' "$resolved"
    return 0
  fi
  printf '%s' "$p"
}

classify_install_target() {
  local dir="$1" normalized home_normalized
  # Guard MUSI porównywać skanonizowane ścieżki: „~/." i „~/kat/.." wskazują katalog
  # domowy, a bez redukcji wychodziły jako `foreign` — czyli pytanie [t/N] zamiast
  # twardej odmowy. (Samo `mv` odmawia przeniesienia ścieżki kończącej się na „."/„..",
  # więc dane ocalały, ale user dostawał kryptyczny błąd systemowy zamiast komunikatu.)
  normalized="$(canonicalize_dir_path "$dir")"
  home_normalized="$(canonicalize_dir_path "$HOME")"

  if [ -z "$normalized" ] || [ "$normalized" = "$home_normalized" ]; then
    printf 'forbidden'
    return 0
  fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    printf 'file'
    return 0
  fi
  if [ ! -d "$dir" ] || [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
    printf 'empty'
    return 0
  fi
  if is_puls_install "$dir"; then
    printf 'puls'
  else
    printf 'foreign'
  fi
}

# Guard PRZED destrukcyjnym `mv "$INSTALL_DIR" "$trash"`: kosz leży w katalogu tmp,
# który `trap ... rm -rf` kasuje na wyjściu, więc pomyłka w odpowiedzi o katalog
# („~", „~/Documents", literówka we wklejonej ścieżce z Findera) trwale kasowałaby
# dane usera — `preserve_existing_dirs` ratuje wyłącznie data/ i .node/.
# Fail-closed: obcą zawartość podmieniamy WYŁĄCZNIE po jawnym „t" z terminala;
# brak terminala (curl|bash w CI) = odmowa, nie domyślna zgoda.
assert_install_dir_replaceable() {
  local dir="$1" kind answer=""
  kind="$(classify_install_target "$dir")"

  case "$kind" in
    empty|puls) return 0 ;;
    forbidden)
      fail "Katalog instalacji '$dir' to katalog domowy albo korzeń — instalacja podmienia ten katalog w całości. Podaj podkatalog, np. $HOME/claude-cron."
      ;;
    file)
      fail "Ścieżka instalacji '$dir' wskazuje plik, nie katalog. Podaj ścieżkę katalogu."
      ;;
  esac

  warn "Katalog '$dir' nie jest pusty i NIE wygląda na instalację Pulsa."
  warn "Instalacja podmienia go w całości — zachowane zostaną tylko data/ i .node/."
  if ! has_tty; then
    fail "Brak terminala, żeby potwierdzić skasowanie zawartości '$dir'. Podaj pusty katalog przez INSTALL_DIR albo uruchom instalator interaktywnie."
  fi
  printf "Skasować zawartość %s i zainstalować tam Pulsa? [t/N]: " "$dir"
  IFS= read -r answer < "$INSTALL_TTY" || answer=""
  case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
    t|tak|y|yes) ok "Potwierdzono podmianę katalogu $dir." ;;
    *) fail "Przerwane na życzenie — zawartość '$dir' nietknięta. Uruchom instalator ponownie i podaj inny katalog." ;;
  esac
}

# find_puls_pids <dir> <snapshot-ps> — czysta filtracja snapshotu `ps` po ŚCIEŻCE
# instalacji. Nigdy po nazwie `node`: obce procesy Node (Claude Code, dev-serwery)
# muszą przeżyć. Separator katalogu na końcu wzorca jest granicą — bez niego
# „/x/puls" łapałoby „/x/puls-backup". Daemon ma ścieżkę instalacji w linii poleceń,
# bo startuje portable Nodem z <dir>/.node/... (setup.mjs: spawnServer / hook).
find_puls_pids() {
  local dir="${1%/}" snapshot="$2"
  [ -n "$dir" ] || return 0
  printf '%s\n' "$snapshot" \
    | awk -v needle="$dir/" 'index($0, needle) && index($0, "server.js") { print $1 }'
}

# Zatrzymuje daemona Pulsa działającego Z TEGO katalogu instalacji, PRZED podmianą
# katalogu. Na Unixie przeniesienie otwartego katalogu jest legalne, więc bez tego
# stary proces biegnie dalej ze STARYM kodem, a setup.mjs widzi żywy dashboard na
# porcie i nie startuje nowego serwera — user po aktualizacji zostaje na starej wersji.
# (Parytet ze Stop-PulsProcesses z install.ps1, gdzie powód jest inny: blokady plików.)
stop_puls_processes() {
  local dir="${1%/}" snapshot pids pid killed=0
  [ -n "$dir" ] || return 0
  command -v ps >/dev/null 2>&1 || return 0

  # Snapshot PRZED odpaleniem filtra: inaczej awk (którego linia poleceń zawiera
  # szukaną ścieżkę) trafiłby na własną listę.
  snapshot="$(ps -axo pid=,command= 2>/dev/null || true)"
  pids="$(find_puls_pids "$dir" "$snapshot")"

  for pid in $pids; do
    if [ "$pid" != "$$" ]; then
      info "Zatrzymuję daemona Pulsa (PID $pid) — biegnie ze starego kodu w $dir."
      kill "$pid" 2>/dev/null || true
      killed=1
    fi
  done
  [ "$killed" = 1 ] && sleep 1
  return 0
}

# Czy da się CZYTAĆ z terminala. Test `-r /dev/tty` kłamie: na macOS węzeł urządzenia
# istnieje i jest „czytelny" także dla procesu bez terminala kontrolującego, a dopiero
# otwarcie zwraca „Device not configured" — pod `set -e` wywalało to instalator bez
# komunikatu. Guard musi więc SPRAWDZIĆ stan faktyczny: otworzyć i zamknąć.
has_tty() {
  { : < "$INSTALL_TTY"; } 2>/dev/null
}

# Pytanie o katalog instalacji (tylko tryb bootstrap). W `curl|bash` stdin to potok z
# treścią skryptu — `read` dostałby EOF i cicho wziął domyślną wartość — więc czytamy
# z terminala. Prompt idzie na stdout (w curl|bash to nadal terminal usera; przekierowanie
# na /dev/tty nic by nie dało, a zepsułoby testowalność). Brak terminala = środowisko
# nieinteraktywne → domyślny katalog z komunikatem, nigdy zwis na prompcie.
ask_install_dir() {
  local answer=""
  if [ "$INSTALL_DIR_EXPLICIT" = "1" ]; then
    info "Katalog instalacji z env INSTALL_DIR: $INSTALL_DIR"
    return 0
  fi
  if has_tty; then
    printf "Katalog instalacji [%s]: " "$INSTALL_DIR_DEFAULT"
    IFS= read -r answer < "$INSTALL_TTY" || answer=""
  else
    warn "Brak terminala — instaluję w domyślnym katalogu (środowisko nieinteraktywne)."
  fi
  INSTALL_DIR="$(resolve_install_dir "$answer" "$INSTALL_DIR_DEFAULT")"
  ok "Katalog instalacji: $INSTALL_DIR"
}

# ============ BOOTSTRAP (curl|bash, bez git) ============

# Przenosi allowlistowane katalogi (data/, .node/) ze starej instalacji
# do świeżo rozpakowanego repo. Robione PRZED podmianą katalogów, żeby
# nie było okna, w którym baza nie istnieje.
#   preserve_existing_dirs <stara-instalacja> <swieze-repo>
preserve_existing_dirs() {
  local old_dir="$1" fresh_dir="$2" name
  [ -d "$old_dir" ] || return 0
  for name in "${PRESERVE_DIRS[@]}"; do
    if [ -e "$old_dir/$name" ]; then
      # Świeży tarball nie zawiera data/ ani .node/ (gitignore), ale
      # gdyby zawierał — nie chcemy nadpisać żywych danych usera.
      rm -rf "${fresh_dir:?}/$name"
      mv "$old_dir/$name" "$fresh_dir/$name"
    fi
  done
}

# Pyta API GitHuba o SHA commita wskazywanego przez gałąź. Bez `jq` — instalator nie
# zakłada narzędzi ponad curl/wget. Pierwsze "sha" w odpowiedzi to sha commita.
#   fetch_ref_sha <owner/repo> <ref>
fetch_ref_sha() {
  local slug="$1" ref="$2" out sha
  out="$(mktemp)"
  if ! download "https://api.github.com/repos/$slug/commits/$ref" "$out"; then
    rm -f "$out"
    return 1
  fi
  # `tr ',' '\n'` PRZED sedem: POSIX-owy `.*` jest zachłanny, więc na odpowiedzi w JEDNEJ
  # linii wzorzec dowiązałby się do OSTATNIEGO "sha" w dokumencie (blob z `files`) zamiast
  # do sha commita — instalator pobrałby wtedy nieistniejące archiwum. Rozbicie po przecinkach
  # daje jedno pole w linii, więc `head -n1` wybiera pierwsze "sha" niezależnie od formatowania.
  sha="$(tr ',' '\n' < "$out" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' | head -n1)"
  rm -f "$out"
  [ -n "$sha" ] || return 1
  printf '%s' "$sha"
}

# Ustala URL archiwum, nazwę katalogu po rozpakowaniu i rewizję do zapisania.
# Pad rozstrzygania (brak sieci, limit API) NIE przerywa instalacji — schodzimy na URL
# po nazwie gałęzi, a wersja zostaje nieznana. Lepiej działający Puls bez metadanych
# niż instalacja przerwana przez API GitHuba.
resolve_tarball_source() {
  if [ -n "$TARBALL_URL" ]; then
    # Jawny override: nie zgadujemy rewizji, ufamy temu, co podał wołający.
    TARBALL_TOPDIR="${TARBALL_TOPDIR:-claude-cron-$REPO_REF}"
    return 0
  fi

  local sha=""
  info "Ustalam rewizję gałęzi $REPO_REF..."
  sha="$(fetch_ref_sha "$REPO_SLUG" "$REPO_REF")" || sha=""

  if [ -n "$sha" ]; then
    TARBALL_URL="https://github.com/$REPO_SLUG/archive/$sha.tar.gz"
    TARBALL_TOPDIR="claude-cron-$sha"
    INSTALL_REVISION="$sha"
    ok "Rewizja: $sha"
  else
    warn "Nie ustaliłem rewizji — pobieram po nazwie gałęzi (wersja instalacji: unknown)."
    TARBALL_URL="https://github.com/$REPO_SLUG/archive/refs/heads/$REPO_REF.tar.gz"
    TARBALL_TOPDIR="claude-cron-$REPO_REF"
  fi
}

# Pobiera tarball brancha, rozpakowuje do tmp i zwraca (echo) ścieżkę do
# rozpakowanego repo. Weryfikuje obecność setup.mjs (fail fast).
#   extract_repo_from_tarball <tmp-dir>
extract_repo_from_tarball() {
  local tmp_dir="$1"
  local archive="$tmp_dir/repo.tar.gz"

  info "Pobieram repo (tarball, bez git)..." >&2
  download "$TARBALL_URL" "$archive" \
    || fail "Pobranie repo z $TARBALL_URL nie powiodło się (sprawdź połączenie)."

  info "Rozpakowuję repo..." >&2
  tar -xzf "$archive" -C "$tmp_dir" \
    || fail "Rozpakowanie repo nie powiodło się."

  local fresh_dir="$tmp_dir/$TARBALL_TOPDIR"
  [ -f "$fresh_dir/setup.mjs" ] \
    || fail "Po rozpakowaniu brak setup.mjs w $fresh_dir — uszkodzony lub nieoczekiwany tarball."

  echo "$fresh_dir"
}

# Atomowy(-ish) swap: świeże repo → INSTALL_DIR, stare → kosz w tmp.
# Najpierw przenosi data/ i .node/ ze starej instalacji do świeżej.
#   install_fresh_repo <swieze-repo> <tmp-dir>
install_fresh_repo() {
  local fresh_dir="$1" tmp_dir="$2"

  # Guard PRZED jakąkolwiek zmianą na dysku — katalog to wolna odpowiedź usera.
  assert_install_dir_replaceable "$INSTALL_DIR"

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -d "$INSTALL_DIR" ]; then
    # PRZED przenoszeniem: stary daemon musi zniknąć, inaczej biegnie dalej ze starym kodem.
    stop_puls_processes "$INSTALL_DIR"
    preserve_existing_dirs "$INSTALL_DIR" "$fresh_dir"
    # Stara instalacja idzie do kosza w tmp (sprzątane przez trap EXIT).
    local trash="$tmp_dir/old-install"
    rm -rf "$trash"
    mv "$INSTALL_DIR" "$trash"
  fi

  # Świeże repo na miejsce docelowe.
  mv "$fresh_dir" "$INSTALL_DIR"
  ok "Repo gotowe w $INSTALL_DIR"
}

# Pełny przebieg bootstrap → ustawia REPO_DIR na INSTALL_DIR.
run_bootstrap() {
  echo ""
  echo -e "${CYAN}🕹️  CLAUDE-CRON — instalacja jedną komendą${NC}"
  echo "========================================"
  echo ""

  ask_install_dir

  echo ""
  echo -e "  ${DIM}Pobieram repo do ${INSTALL_DIR} (bez git) i konfiguruję.${NC}"
  echo ""

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  resolve_tarball_source

  local fresh_dir
  fresh_dir="$(extract_repo_from_tarball "$tmp_dir")"
  install_fresh_repo "$fresh_dir" "$tmp_dir"

  REPO_DIR="$INSTALL_DIR"
}

# ============ PORTABLE NODE (w REPO_DIR/.node) ============

# Pobiera + weryfikuje + rozpakowuje przenośny Node do REPO_DIR/.node,
# jeśli jeszcze go tam nie ma. Ustawia NODE_BIN.
ensure_portable_node() {
  local platform arch dist_name archive dist_base_url node_base
  platform="$(detect_platform)"
  arch="$(detect_arch)"

  node_base="$REPO_DIR/.node"
  dist_name="node-v${NODE_VERSION}-${platform}-${arch}"
  archive="${dist_name}.tar.gz"
  dist_base_url="https://nodejs.org/dist/v${NODE_VERSION}"
  NODE_BIN="$node_base/$dist_name/bin/node"

  if [ -x "$NODE_BIN" ]; then
    local installed_ver
    installed_ver="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
    if [ "$installed_ver" = "$NODE_VERSION" ]; then
      ok "Portable Node ${NODE_VERSION} już obecny — pomijam pobieranie."
      return 0
    fi
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  info "Pobieram $archive z nodejs.org/dist..."
  download "$dist_base_url/$archive" "$tmp_dir/$archive" \
    || fail "Pobranie $archive nie powiodło się (sprawdź połączenie / wersję $NODE_VERSION)."

  info "Pobieram SHASUMS256.txt (weryfikacja integralności)..."
  download "$dist_base_url/SHASUMS256.txt" "$tmp_dir/SHASUMS256.txt" \
    || fail "Pobranie SHASUMS256.txt nie powiodło się."

  info "Weryfikuję sumę SHA256..."
  verify_node_checksum "$tmp_dir" "$archive"
  ok "Suma SHA256 zgodna."

  info "Rozpakowuję do .node/..."
  mkdir -p "$node_base"
  rm -rf "${node_base:?}/$dist_name"
  tar -xzf "$tmp_dir/$archive" -C "$node_base" \
    || fail "Rozpakowanie $archive nie powiodło się."

  [ -x "$NODE_BIN" ] || fail "Nie znaleziono binarki Node po rozpakowaniu: $NODE_BIN"
  ok "Portable Node ${NODE_VERSION} gotowy: $NODE_BIN"
}

verify_node_checksum() {
  local tmp_dir="$1" archive="$2" expected actual
  expected="$(grep " ${archive}\$" "$tmp_dir/SHASUMS256.txt" | awk '{print $1}')"
  [ -n "$expected" ] || fail "Brak wpisu dla $archive w SHASUMS256.txt."

  if command -v shasum &>/dev/null; then
    actual="$(shasum -a 256 "$tmp_dir/$archive" | awk '{print $1}')"
  elif command -v sha256sum &>/dev/null; then
    actual="$(sha256sum "$tmp_dir/$archive" | awk '{print $1}')"
  else
    fail "Brak shasum ani sha256sum — nie mogę zweryfikować sumy."
  fi

  [ "$expected" = "$actual" ] \
    || fail "Suma SHA256 się nie zgadza! Oczekiwano $expected, otrzymano $actual. Przerywam (archiwum uszkodzone lub podmienione)."
}

# ============ ZALEŻNOŚCI (node_modules przez portable npm) ============

# Instaluje zależności produkcyjne przez npm z portable Node (nie systemowego —
# bootstrap nie dotyka PATH). Bootstrap NIE przenosi node_modules ze starej
# instalacji, więc świeży katalog zawsze wymaga instalacji. Portable Node musi
# być w PATH, bo install-script koffi (cnoke) spawnuje `node`.
ensure_dependencies() {
  local node_dir npm_cli
  node_dir="$(dirname "$NODE_BIN")"
  npm_cli="$node_dir/../lib/node_modules/npm/bin/npm-cli.js"
  [ -f "$npm_cli" ] || fail "Nie znaleziono npm w portable Node: $npm_cli"

  info "Instaluję zależności (npm install)..."
  ( cd "$REPO_DIR" && PATH="$node_dir:$PATH" "$NODE_BIN" "$npm_cli" install --omit=dev --no-audit --no-fund ) \
    || fail "npm install nie powiódł się — sprawdź połączenie sieciowe."
  ok "Zależności zainstalowane."
}

# ============ HANDOFF DO setup.mjs (z fixem TTY) ============

# curl|bash zajmuje stdin pipe'em ze skryptem → setup.mjs nie może czytać
# odpowiedzi z klawiatury. Podpinamy /dev/tty, gdy jest dostępne.
# --disable-warning=ExperimentalWarning: setup.mjs czyta lib/db (node:sqlite),
# a ostrzeżenie o eksperymentalnym module wypadłoby POMIĘDZY pytaniami setupu —
# dla kursanta nieodróżnialne od błędu. Ta sama flaga co w package.json.
handoff_to_setup() {
  info "Przekazuję sterowanie do setup.mjs..."
  # Rewizja jedzie env-em (exec zachowuje eksport): setup.mjs zapisuje ją do
  # data/version.json JUŻ PO swapie katalogów — inaczej plik trafiłby do katalogu,
  # który za chwilę ląduje w koszu. W trybie lokalnym nic nie eksportujemy i setup
  # sam sięga po `git rev-parse`.
  if [ -n "$INSTALL_REVISION" ]; then
    export CLAUDE_CRON_INSTALL_REVISION="$INSTALL_REVISION"
    export CLAUDE_CRON_INSTALL_SOURCE="$INSTALL_SOURCE"
  fi
  # has_tty zamiast `-r /dev/tty`: samo prawo odczytu nie znaczy, że urządzenie da się
  # otworzyć (macOS bez terminala kontrolującego) — a nieudany `exec ... < /dev/tty`
  # kończy instalację twardym błędem zamiast wejść w ścieżkę nieinteraktywną.
  if has_tty; then
    exec "$NODE_BIN" --disable-warning=ExperimentalWarning "$REPO_DIR/setup.mjs" < "$INSTALL_TTY"
  else
    warn "Brak terminala — setup uruchamiam bez interaktywnego stdin (środowisko nieinteraktywne)."
    exec "$NODE_BIN" --disable-warning=ExperimentalWarning "$REPO_DIR/setup.mjs"
  fi
}

# ============ MAIN ============

main() {
  # REPO_DIR = katalog, w którym leży ten skrypt.
  REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

  if [ -f "$REPO_DIR/setup.mjs" ]; then
    # Tryb LOKALNY — repo obok skryptu (bez zmian względem dziś).
    echo ""
    echo -e "${CYAN}🕹️  CLAUDE-CRON — Portable Node bootstrap${NC}"
    echo "========================================"
    echo ""
    echo -e "  ${DIM}Stawiam przenośny Node ${NODE_VERSION} w .node/ (bez globalnej instalacji)${NC}"
    echo -e "  ${DIM}i przekazuję dalej do setup.mjs.${NC}"
    echo ""
  else
    # Tryb BOOTSTRAP — curl|bash bez sklonowanego repo.
    run_bootstrap
  fi

  ensure_portable_node
  ensure_dependencies
  handoff_to_setup
}

# Test harness może wczytać tylko funkcje (CLAUDE_CRON_LIB_ONLY=1),
# bez odpalania main (pobierania Node / setup.mjs).
if [ "${CLAUDE_CRON_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi
