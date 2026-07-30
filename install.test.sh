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

# --- Test 5: pusta odpowiedź na pytanie o katalog → wartość domyślna ---
test_install_dir_empty_answer_uses_default() {
  local result
  result="$(resolve_install_dir "" "$HOME/claude-cron")"
  if [ "$result" = "$HOME/claude-cron" ]; then
    pass "resolve_install_dir: sam Enter → domyślny \$HOME/claude-cron"
  else
    problem "resolve_install_dir: pusta odpowiedź dała '$result' zamiast $HOME/claude-cron"
  fi
}

# --- Test 6: odpowiedź z drag&drop (cudzysłowy, escape'y, spacje) → czysta ścieżka ---
test_install_dir_sanitizes_answer() {
  local result
  result="$(resolve_install_dir "  '/Users/x/moje\\ pulsy'  " "$HOME/claude-cron")"
  if [ "$result" = "/Users/x/moje pulsy" ]; then
    pass "resolve_install_dir: czyści cudzysłowy/escape'y/spacje z odpowiedzi"
  else
    problem "resolve_install_dir: oczekiwano '/Users/x/moje pulsy', otrzymano '$result'"
  fi
}

# --- Test 7: ~ i ścieżka względna → absolutna (read NIE rozwija tyldy) ---
test_install_dir_expands_tilde_and_relative() {
  local tilde relative
  tilde="$(resolve_install_dir "~/puls" "$HOME/claude-cron")"
  relative="$(resolve_install_dir "puls" "$HOME/claude-cron" "/base")"
  if [ "$tilde" = "$HOME/puls" ] && [ "$relative" = "/base/puls" ]; then
    pass "resolve_install_dir: rozwija ~ i uzupełnia ścieżkę względną do absolutnej"
  else
    problem "resolve_install_dir: tylda='$tilde' względna='$relative'"
  fi
}

# --- Test 8: instalacja w NIESTANDARDOWYM katalogu (odpowiedź usera → realny install) ---
test_custom_install_dir_receives_repo() {
  local fresh tmp answer
  answer="$SANDBOX/moje pulsy/instancja"
  INSTALL_DIR="$(resolve_install_dir "$answer" "$HOME/claude-cron")"
  fresh="$SANDBOX/t8-fresh"
  tmp="$SANDBOX/t8-tmp"
  mkdir -p "$fresh" "$tmp"
  echo "code" > "$fresh/server.js"
  echo "x" > "$fresh/setup.mjs"

  install_fresh_repo "$fresh" "$tmp"

  # handoff_to_setup odpala dokładnie "$REPO_DIR/setup.mjs", a REPO_DIR=INSTALL_DIR —
  # obecność tego pliku to warunek startu instalacji w wybranym katalogu.
  if [ -f "$answer/setup.mjs" ] && [ -f "$answer/server.js" ]; then
    pass "niestandardowy katalog: repo (z setup.mjs do handoffu) wylądowało w wybranej ścieżce"
  else
    problem "niestandardowy katalog: brak repo w '$answer'"
  fi
  INSTALL_DIR="$SANDBOX/claude-cron" # przywróć
}

# --- Test 11: odpowiedź „z terminala" → instalacja w podanym katalogu ---
# INSTALL_TTY podstawia plik za /dev/tty: w harnessie testowym nie ma terminala,
# a to właśnie ścieżkę terminalową (nie stdin!) trzeba pokryć — w curl|bash stdin
# jest zajęty treścią skryptu.
test_ask_install_dir_reads_from_tty() {
  local tty_file="$SANDBOX/tty-answer"
  printf '%s\n' "$SANDBOX/z-terminala/puls" > "$tty_file"
  INSTALL_TTY="$tty_file"
  INSTALL_DIR_EXPLICIT=0

  ask_install_dir > /dev/null

  if [ "$INSTALL_DIR" = "$SANDBOX/z-terminala/puls" ]; then
    pass "ask_install_dir: czyta odpowiedź z terminala (nie ze stdin)"
  else
    problem "ask_install_dir wziął '$INSTALL_DIR' zamiast odpowiedzi z terminala"
  fi
  INSTALL_TTY="/dev/tty"
  INSTALL_DIR="$SANDBOX/claude-cron" # przywróć
}

# --- Test 12: brak terminala → domyślny katalog, bez zwisu i bez wywalenia skryptu ---
# Regresja: `[ -r /dev/tty ]` przepuszczało macOS bez terminala kontrolującego,
# a otwarcie urządzenia kończyło instalator błędem „Device not configured" pod set -e.
test_ask_install_dir_without_tty_uses_default() {
  INSTALL_TTY="$SANDBOX/nie-ma-takiego-tty"
  INSTALL_DIR_EXPLICIT=0

  ask_install_dir > /dev/null

  if [ "$INSTALL_DIR" = "$INSTALL_DIR_DEFAULT" ]; then
    pass "ask_install_dir: brak terminala → domyślny katalog (bez błędu)"
  else
    problem "ask_install_dir bez terminala dał '$INSTALL_DIR' zamiast $INSTALL_DIR_DEFAULT"
  fi
  INSTALL_TTY="/dev/tty"
  INSTALL_DIR="$SANDBOX/claude-cron" # przywróć
}

# --- Test 13: sam Enter na terminalu → wartość domyślna ---
test_ask_install_dir_empty_line_uses_default() {
  local tty_file="$SANDBOX/tty-empty"
  printf '\n' > "$tty_file"
  INSTALL_TTY="$tty_file"
  INSTALL_DIR_EXPLICIT=0

  ask_install_dir > /dev/null

  if [ "$INSTALL_DIR" = "$INSTALL_DIR_DEFAULT" ]; then
    pass "ask_install_dir: sam Enter → \$HOME/claude-cron"
  else
    problem "ask_install_dir po pustym Enterze dał '$INSTALL_DIR'"
  fi
  INSTALL_TTY="/dev/tty"
  INSTALL_DIR="$SANDBOX/claude-cron" # przywróć
}

# --- Test 9: REGRESJA — skrypt ładuje się BEZ env INSTALL_DIR (pod set -e) ---
# Pierwsza wersja miała `[ -n "$INSTALL_DIR" ] && INSTALL_DIR_EXPLICIT=1`: przy pustym
# env fałszywy test kończył cały instalator z kodem 1, bez jednego słowa dla usera.
# Ten test MUSI biec w osobnej powłoce bez INSTALL_DIR — tu w harnessie env jest ustawiony.
test_loads_without_install_dir_env() {
  local out
  out="$(env -u INSTALL_DIR CLAUDE_CRON_LIB_ONLY=1 bash -c \
    'set -euo pipefail; source "$1"; echo "LOADED:$INSTALL_DIR_EXPLICIT:$INSTALL_DIR"' \
    _ "$SCRIPT_DIR/install.sh" 2>&1)" || true

  if [ "$out" = "LOADED:0:$HOME/claude-cron" ]; then
    pass "install.sh ładuje się bez env INSTALL_DIR (domyślny katalog, pytanie w bootstrapie)"
  else
    problem "install.sh bez env INSTALL_DIR: '$out' (oczekiwano LOADED:0:$HOME/claude-cron)"
  fi
}

# --- Test 10: env INSTALL_DIR wygrywa i POMIJA pytanie (przebiegi nieinteraktywne) ---
test_ask_install_dir_respects_env() {
  local target="$SANDBOX/z-env/claude-cron"
  INSTALL_DIR="$target"
  INSTALL_DIR_EXPLICIT=1

  # Brak odczytu z /dev/tty to sedno: przy jawnym env instalator nie może czekać na Enter.
  ask_install_dir > /dev/null

  if [ "$INSTALL_DIR" = "$target" ]; then
    pass "ask_install_dir: env INSTALL_DIR wygrywa i nie pyta"
  else
    problem "ask_install_dir zmienił jawnie podany katalog na '$INSTALL_DIR'"
  fi
  INSTALL_DIR="$SANDBOX/claude-cron" # przywróć
}

echo "== install.sh — testy bootstrap/preserve =="
test_preserve_moves_data_and_node
test_preserve_noop_when_no_old
test_rerun_preserves_sentinel
test_fresh_install_when_no_existing
test_install_dir_empty_answer_uses_default
test_install_dir_sanitizes_answer
test_install_dir_expands_tilde_and_relative
test_custom_install_dir_receives_repo
test_loads_without_install_dir_env
test_ask_install_dir_respects_env
test_ask_install_dir_reads_from_tty
test_ask_install_dir_without_tty_uses_default
test_ask_install_dir_empty_line_uses_default

echo ""
echo "Wynik: ${PASS} PASS / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ] || exit 1
