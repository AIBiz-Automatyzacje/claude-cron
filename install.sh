#!/usr/bin/env bash
set -euo pipefail

# ============================================
#  CLAUDE-CRON — Portable Node bootstrap (Mac/Linux)
#
#  Cienki bootstrap: stawia pinowany, przenośny Node
#  w .node/ (z weryfikacją sumy SHASUMS256) i przekazuje
#  sterowanie do setup.mjs. Bootstrap NIE zawiera logiki
#  konfiguracyjnej — robi wyłącznie portable Node.
#
#  Nie dotyka systemowego Node, PATH ani profilu (.zshrc/.bashrc).
# ============================================

# Pinowany patch portable Node — najnowszy stabilny 22.x LTS,
# spójny z oknem engines ">=22.13 <25".
NODE_VERSION="22.17.0"

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

# Repo = katalog, w którym leży ten skrypt
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BASE="$REPO_DIR/.node"

echo ""
echo -e "${CYAN}🕹️  CLAUDE-CRON — Portable Node bootstrap${NC}"
echo "========================================"
echo ""
echo -e "  ${DIM}Stawiam przenośny Node ${NODE_VERSION} w .node/ (bez globalnej instalacji)${NC}"
echo -e "  ${DIM}i przekazuję dalej do setup.mjs.${NC}"
echo ""

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

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"

# node-v<ver>-<platform>-<arch>.tar.gz  (np. node-v22.17.0-darwin-arm64.tar.gz)
DIST_NAME="node-v${NODE_VERSION}-${PLATFORM}-${ARCH}"
ARCHIVE="${DIST_NAME}.tar.gz"
DIST_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
NODE_BIN="$NODE_BASE/$DIST_NAME/bin/node"

# ============ DETECT-AND-TOUCH-ONLY-MISSING ============

if [ -x "$NODE_BIN" ]; then
  INSTALLED_VER="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
  if [ "$INSTALLED_VER" = "$NODE_VERSION" ]; then
    ok "Portable Node ${NODE_VERSION} już obecny — pomijam pobieranie."
    info "Przekazuję sterowanie do setup.mjs..."
    exec "$NODE_BIN" "$REPO_DIR/setup.mjs"
  fi
fi

# ============ DOWNLOAD TOOL ============

download() {
  # download <url> <output-path>
  local url="$1" out="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$out" || return 1
  elif command -v wget &>/dev/null; then
    wget -q "$url" -O "$out" || return 1
  else
    fail "Brak curl ani wget — nie mogę pobrać Node."
  fi
}

# ============ DOWNLOAD ARCHIVE + CHECKSUMS ============

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "Pobieram $ARCHIVE z nodejs.org/dist..."
download "$DIST_BASE_URL/$ARCHIVE" "$TMP_DIR/$ARCHIVE" \
  || fail "Pobranie $ARCHIVE nie powiodło się (sprawdź połączenie / wersję $NODE_VERSION)."

info "Pobieram SHASUMS256.txt (weryfikacja integralności)..."
download "$DIST_BASE_URL/SHASUMS256.txt" "$TMP_DIR/SHASUMS256.txt" \
  || fail "Pobranie SHASUMS256.txt nie powiodło się."

# ============ VERIFY SHASUMS256 ============

verify_checksum() {
  local expected actual
  # Linia z SHASUMS256.txt: "<sha256>  node-v...-<platform>-<arch>.tar.gz"
  expected="$(grep " ${ARCHIVE}\$" "$TMP_DIR/SHASUMS256.txt" | awk '{print $1}')"
  [ -n "$expected" ] || fail "Brak wpisu dla $ARCHIVE w SHASUMS256.txt."

  if command -v shasum &>/dev/null; then
    actual="$(shasum -a 256 "$TMP_DIR/$ARCHIVE" | awk '{print $1}')"
  elif command -v sha256sum &>/dev/null; then
    actual="$(sha256sum "$TMP_DIR/$ARCHIVE" | awk '{print $1}')"
  else
    fail "Brak shasum ani sha256sum — nie mogę zweryfikować sumy."
  fi

  [ "$expected" = "$actual" ] \
    || fail "Suma SHA256 się nie zgadza! Oczekiwano $expected, otrzymano $actual. Przerywam (archiwum uszkodzone lub podmienione)."
}

info "Weryfikuję sumę SHA256..."
verify_checksum
ok "Suma SHA256 zgodna."

# ============ EXTRACT TO .node/ ============

info "Rozpakowuję do .node/..."
mkdir -p "$NODE_BASE"
# Czyścimy ewentualną starą wersję pod tą samą nazwą dist (idempotencja)
rm -rf "$NODE_BASE/$DIST_NAME"
tar -xzf "$TMP_DIR/$ARCHIVE" -C "$NODE_BASE" \
  || fail "Rozpakowanie $ARCHIVE nie powiodło się."

[ -x "$NODE_BIN" ] || fail "Nie znaleziono binarki Node po rozpakowaniu: $NODE_BIN"
ok "Portable Node ${NODE_VERSION} gotowy: $NODE_BIN"

# ============ HANDOFF DO setup.mjs ============

info "Przekazuję sterowanie do setup.mjs..."
exec "$NODE_BIN" "$REPO_DIR/setup.mjs"
