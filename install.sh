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

# Bootstrap: tarball brancha main (rozpakowuje się do claude-cron-main/).
TARBALL_URL="https://github.com/AIBiz-Automatyzacje/claude-cron/archive/refs/heads/main.tar.gz"
TARBALL_TOPDIR="claude-cron-main"

# Docelowy katalog instalacji w trybie bootstrap (override przez env w testach).
INSTALL_DIR="${INSTALL_DIR:-$HOME/claude-cron}"

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

# Pobiera tarball brancha, rozpakowuje do tmp i zwraca (echo) ścieżkę do
# rozpakowanego repo. Weryfikuje obecność setup.mjs (fail fast).
#   extract_repo_from_tarball <tmp-dir>
extract_repo_from_tarball() {
  local tmp_dir="$1"
  local archive="$tmp_dir/repo.tar.gz"

  info "Pobieram repo (tarball brancha main, bez git)..." >&2
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

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -d "$INSTALL_DIR" ]; then
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
  echo -e "  ${DIM}Pobieram repo do ${INSTALL_DIR} (bez git) i konfiguruję.${NC}"
  echo ""

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

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

# ============ HANDOFF DO setup.mjs (z fixem TTY) ============

# curl|bash zajmuje stdin pipe'em ze skryptem → setup.mjs nie może czytać
# odpowiedzi z klawiatury. Podpinamy /dev/tty, gdy jest dostępne.
handoff_to_setup() {
  info "Przekazuję sterowanie do setup.mjs..."
  if [ -r /dev/tty ]; then
    exec "$NODE_BIN" "$REPO_DIR/setup.mjs" < /dev/tty
  else
    warn "Brak /dev/tty — setup uruchamiam bez interaktywnego stdin (środowisko nieinteraktywne)."
    exec "$NODE_BIN" "$REPO_DIR/setup.mjs"
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
  handoff_to_setup
}

# Test harness może wczytać tylko funkcje (CLAUDE_CRON_LIB_ONLY=1),
# bez odpalania main (pobierania Node / setup.mjs).
if [ "${CLAUDE_CRON_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi
