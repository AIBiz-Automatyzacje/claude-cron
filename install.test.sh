#!/usr/bin/env bash
# Skryptowe testy install.sh — symulują bootstrap/preserve-copy bez sieci.
# Źródłujemy install.sh w trybie lib-only (CLAUDE_CRON_LIB_ONLY=1), żeby
# dostać same funkcje bez odpalania main (pobierania Node / setup.mjs).
#
# Uruchom: bash install.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
problem() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

# === Arrange: izolowana piaskownica + załadowanie funkcji ===
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# INSTALL_DIR celuje w piaskownicę, NIE w ~/claude-cron.
export INSTALL_DIR="$SANDBOX/claude-cron"
export CLAUDE_CRON_LIB_ONLY=1
# shellcheck source=install.sh
source "$SCRIPT_DIR/install.sh"

# --- Test 1: preserve_existing_dirs przenosi data/ i .node/ ---
test_preserve_moves_data_and_node() {
  local old fresh
  old="$SANDBOX/t1-old"
  fresh="$SANDBOX/t1-fresh"
  mkdir -p "$old/data" "$old/.node/bin" "$fresh"
  echo "sentinel-db" > "$old/data/claude-cron.db"
  echo "node-bin" > "$old/.node/bin/node"

  preserve_existing_dirs "$old" "$fresh"

  if [ -f "$fresh/data/claude-cron.db" ] \
    && [ "$(cat "$fresh/data/claude-cron.db")" = "sentinel-db" ] \
    && [ -f "$fresh/.node/bin/node" ]; then
    pass "preserve_existing_dirs przenosi data/ i .node/ do świeżego repo"
  else
    problem "preserve_existing_dirs NIE przeniósł data/ lub .node/"
  fi
}

# --- Test 2: preserve nie wywala się, gdy stara instalacja nie istnieje ---
test_preserve_noop_when_no_old() {
  local fresh
  fresh="$SANDBOX/t2-fresh"
  mkdir -p "$fresh"
  if preserve_existing_dirs "$SANDBOX/does-not-exist" "$fresh"; then
    pass "preserve_existing_dirs to no-op gdy brak starej instalacji"
  else
    problem "preserve_existing_dirs zwrócił błąd przy braku starej instalacji"
  fi
}

# --- Test 3: KONTRAKT DANYCH — re-run z plikiem-strażnikiem nie kasuje data/ ---
test_rerun_preserves_sentinel() {
  local fresh tmp
  # Symulacja istniejącej instalacji w INSTALL_DIR z plikiem-strażnikiem.
  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/.node/bin"
  echo "guard" > "$INSTALL_DIR/data/SENTINEL"
  echo "old-code" > "$INSTALL_DIR/server.js"
  echo "node" > "$INSTALL_DIR/.node/bin/node"

  # Świeże "rozpakowane repo" (jak z tarballa) — nowy kod, BEZ data/.
  fresh="$SANDBOX/t3-fresh"
  tmp="$SANDBOX/t3-tmp"
  mkdir -p "$fresh" "$tmp"
  echo "new-code" > "$fresh/server.js"
  echo "x" > "$fresh/setup.mjs"

  install_fresh_repo "$fresh" "$tmp"

  local ok_sentinel ok_node ok_code
  ok_sentinel=0; ok_node=0; ok_code=0
  [ -f "$INSTALL_DIR/data/SENTINEL" ] && [ "$(cat "$INSTALL_DIR/data/SENTINEL")" = "guard" ] && ok_sentinel=1
  [ -f "$INSTALL_DIR/.node/bin/node" ] && ok_node=1
  [ "$(cat "$INSTALL_DIR/server.js")" = "new-code" ] && ok_code=1

  if [ "$ok_sentinel" = 1 ] && [ "$ok_node" = 1 ] && [ "$ok_code" = 1 ]; then
    pass "re-run: data/SENTINEL i .node/ zachowane, kod nadpisany (kontrakt danych)"
  else
    problem "re-run ZŁAMAŁ kontrakt: sentinel=$ok_sentinel node=$ok_node code=$ok_code"
  fi
}

# --- Test 4: install na czysto (brak istniejącej instalacji) ---
test_fresh_install_when_no_existing() {
  local fresh tmp target
  target="$SANDBOX/t4-install/claude-cron"
  INSTALL_DIR="$target" # nadpisanie lokalne dla tego testu
  fresh="$SANDBOX/t4-fresh"
  tmp="$SANDBOX/t4-tmp"
  mkdir -p "$fresh" "$tmp"
  echo "code" > "$fresh/server.js"
  echo "x" > "$fresh/setup.mjs"

  install_fresh_repo "$fresh" "$tmp"

  if [ -f "$target/setup.mjs" ] && [ -f "$target/server.js" ]; then
    pass "czysta instalacja: repo wylądowało w INSTALL_DIR"
  else
    problem "czysta instalacja NIE umieściła repo w INSTALL_DIR"
  fi
  INSTALL_DIR="$SANDBOX/claude-cron" # przywróć
}

echo "== install.sh — testy bootstrap/preserve =="
test_preserve_moves_data_and_node
test_preserve_noop_when_no_old
test_rerun_preserves_sentinel
test_fresh_install_when_no_existing

echo ""
echo "Wynik: ${PASS} PASS / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ] || exit 1
