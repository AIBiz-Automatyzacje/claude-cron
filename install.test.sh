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

# --- Test 14: GUARD — obcy katalog NIE zostaje skasowany (brak terminala = odmowa) ---
# Katalog instalacji jest wolną odpowiedzią usera, a stara zawartość leci do kosza w tmp,
# który trap kasuje `rm -rf`. Literówka („~/Documents") nie może kosztować danych.
test_install_dir_rejects_foreign_content() {
  local target fresh tmp rc=0
  target="$SANDBOX/obcy-katalog"
  mkdir -p "$target/podkatalog"
  echo "prywatne" > "$target/moje-dane.txt"
  fresh="$SANDBOX/t14-fresh"
  tmp="$SANDBOX/t14-tmp"
  mkdir -p "$fresh" "$tmp"
  echo "code" > "$fresh/server.js"
  echo "x" > "$fresh/setup.mjs"

  (
    INSTALL_DIR="$target"
    INSTALL_TTY="$SANDBOX/nie-ma-takiego-tty"
    install_fresh_repo "$fresh" "$tmp"
  ) > /dev/null 2>&1 || rc=$?

  if [ "$rc" -ne 0 ] \
    && [ -f "$target/moje-dane.txt" ] \
    && [ "$(cat "$target/moje-dane.txt")" = "prywatne" ] \
    && [ -d "$target/podkatalog" ] \
    && [ ! -f "$target/server.js" ]; then
    pass "guard: obcy katalog odrzucony bez terminala — dane usera nietknięte"
  else
    problem "guard: obcy katalog NIE został ochroniony (rc=$rc, dane=$([ -f "$target/moje-dane.txt" ] && echo ok || echo ZGINELY))"
  fi
}

# --- Test 15: GUARD — odpowiedź „n" na potwierdzenie zostawia katalog nietknięty ---
test_install_dir_declined_confirmation_keeps_data() {
  local target fresh tmp tty_file rc=0
  target="$SANDBOX/obcy-katalog-n"
  mkdir -p "$target"
  echo "prywatne" > "$target/moje-dane.txt"
  fresh="$SANDBOX/t15-fresh"
  tmp="$SANDBOX/t15-tmp"
  mkdir -p "$fresh" "$tmp"
  echo "code" > "$fresh/server.js"
  echo "x" > "$fresh/setup.mjs"
  tty_file="$SANDBOX/t15-tty"
  printf 'n\n' > "$tty_file"

  (
    INSTALL_DIR="$target"
    INSTALL_TTY="$tty_file"
    install_fresh_repo "$fresh" "$tmp"
  ) > /dev/null 2>&1 || rc=$?

  if [ "$rc" -ne 0 ] && [ -f "$target/moje-dane.txt" ] && [ ! -f "$target/server.js" ]; then
    pass "guard: odmowa potwierdzenia zostawia zawartość katalogu"
  else
    problem "guard: po odmowie katalog został naruszony (rc=$rc)"
  fi
}

# --- Test 16: GUARD — jawne „t" z terminala pozwala zainstalować w obcym katalogu ---
test_install_dir_confirmed_replaces_content() {
  local target fresh tmp tty_file rc=0
  target="$SANDBOX/obcy-katalog-t"
  mkdir -p "$target"
  echo "prywatne" > "$target/moje-dane.txt"
  fresh="$SANDBOX/t16-fresh"
  tmp="$SANDBOX/t16-tmp"
  mkdir -p "$fresh" "$tmp"
  echo "code" > "$fresh/server.js"
  echo "x" > "$fresh/setup.mjs"
  tty_file="$SANDBOX/t16-tty"
  printf 't\n' > "$tty_file"

  (
    INSTALL_DIR="$target"
    INSTALL_TTY="$tty_file"
    install_fresh_repo "$fresh" "$tmp"
  ) > /dev/null 2>&1 || rc=$?

  if [ "$rc" -eq 0 ] && [ -f "$target/setup.mjs" ] && [ -f "$target/server.js" ]; then
    pass "guard: jawne potwierdzenie „t\" pozwala podmienić katalog"
  else
    problem "guard: potwierdzenie „t\" nie doprowadziło do instalacji (rc=$rc)"
  fi
}

# --- Test 17: GUARD — katalog domowy i plik są odrzucane, instalacja Pulsa przechodzi ---
# $HOME testujemy na PODSTAWIONYM katalogu domowym — realnego $HOME nie ruszamy nawet w teście.
test_classify_install_target_kinds() {
  local fake_home="$SANDBOX/fake-home" file_target="$SANDBOX/plik-nie-katalog"
  local puls_dir="$SANDBOX/rozpoznany-puls" empty_dir="$SANDBOX/pusty" home_kind file_kind
  mkdir -p "$fake_home" "$empty_dir" "$puls_dir/data"
  echo "code" > "$puls_dir/server.js"
  echo "to plik" > "$file_target"

  home_kind="$(HOME="$fake_home" classify_install_target "$fake_home")"
  file_kind="$(classify_install_target "$file_target")"

  if [ "$home_kind" = "forbidden" ] \
    && [ "$file_kind" = "file" ] \
    && [ "$(classify_install_target "$empty_dir")" = "empty" ] \
    && [ "$(classify_install_target "$SANDBOX/nie-ma-mnie")" = "empty" ] \
    && [ "$(classify_install_target "$puls_dir")" = "puls" ]; then
    pass "classify_install_target: \$HOME=forbidden, plik=file, pusty/nieistniejący=empty, instalacja=puls"
  else
    problem "classify_install_target: home='$home_kind' file='$file_kind'"
  fi
}

# --- Test 17b: GUARD katalogu domowego jest odporny na WIELOKROTNE ukośniki ---
# Regresja z review CodeRabbita (PR #2): `${dir%/}` zdejmuje tylko JEDEN końcowy
# ukośnik, więc „~//" → „$HOME/" ≠ „$HOME" i katalog domowy klasyfikował się jako
# `foreign` — user dostawał pytanie [t/N] zamiast odmowy, a „t" kasowało mu $HOME.
test_classify_install_target_home_with_trailing_slashes() {
  local fake_home="$SANDBOX/fake-home-slash" one two three root_kind
  mkdir -p "$fake_home"
  echo "moje dane" > "$fake_home/waz.txt"

  one="$(HOME="$fake_home" classify_install_target "$fake_home/")"
  two="$(HOME="$fake_home" classify_install_target "$fake_home//")"
  three="$(HOME="$fake_home" classify_install_target "$fake_home///")"
  # $HOME z ukośnikiem na końcu (bywa w env) też musi się zredukować do tej samej wartości.
  root_kind="$(HOME="$fake_home/" classify_install_target "$fake_home")"

  if [ "$one" = "forbidden" ] && [ "$two" = "forbidden" ] \
    && [ "$three" = "forbidden" ] && [ "$root_kind" = "forbidden" ]; then
    pass "classify_install_target: \$HOME z 1/2/3 ukośnikami i \$HOME z ukośnikiem w env = forbidden"
  else
    problem "classify_install_target ukośniki: '/'='$one' '//'='$two' '///'='$three' env='$root_kind'"
  fi
}

# --- Test 17c: GUARD katalogu domowego redukuje segmenty "." i ".." ---
# Druga runda review CodeRabbita (PR #2): samo obcięcie ukośników nie łapie ścieżek
# RÓWNOWAŻNYCH katalogowi domowemu — „~/." i „~/podkatalog/.." wychodziły jako `foreign`,
# więc instalator pytał [t/N] o skasowanie $HOME zamiast odmówić.
test_classify_install_target_home_with_dot_segments() {
  local fake_home="$SANDBOX/fake-home-dots" dot dotdot dot_slash deep
  mkdir -p "$fake_home/podkatalog/glebiej"
  echo "moje dane" > "$fake_home/waz.txt"

  dot="$(HOME="$fake_home" classify_install_target "$fake_home/.")"
  dotdot="$(HOME="$fake_home" classify_install_target "$fake_home/podkatalog/..")"
  dot_slash="$(HOME="$fake_home" classify_install_target "$fake_home/./")"
  deep="$(HOME="$fake_home" classify_install_target "$fake_home/podkatalog/glebiej/../..")"

  if [ "$dot" = "forbidden" ] && [ "$dotdot" = "forbidden" ] \
    && [ "$dot_slash" = "forbidden" ] && [ "$deep" = "forbidden" ]; then
    pass "classify_install_target: \$HOME zapisany przez '.' i '..' też jest forbidden"
  else
    problem "classify_install_target kropki: '.'='$dot' '..'='$dotdot' './'='$dot_slash' glebokie='$deep'"
  fi
}

# --- Test 17d: kanonizacja NIE psuje zwykłych katalogów ---
# Płot po drugiej stronie: redukcja ścieżek nie może zamienić legalnego celu instalacji
# w `forbidden` ani zgubić rozpoznania istniejącej instalacji Pulsa.
test_classify_install_target_canonicalization_keeps_normal_dirs() {
  local fake_home="$SANDBOX/fake-home-normal" puls_dir sub empty_kind puls_kind
  mkdir -p "$fake_home"
  puls_dir="$fake_home/puls"
  mkdir -p "$puls_dir/data"
  echo "code" > "$puls_dir/server.js"
  sub="$fake_home/nowy"

  empty_kind="$(HOME="$fake_home" classify_install_target "$sub")"
  puls_kind="$(HOME="$fake_home" classify_install_target "$fake_home/puls/.")"

  if [ "$empty_kind" = "empty" ] && [ "$puls_kind" = "puls" ]; then
    pass "classify_install_target: kanonizacja zachowuje 'empty' i rozpoznanie instalacji Pulsa"
  else
    problem "classify_install_target kanonizacja: nieistniejacy='$empty_kind' puls-z-kropka='$puls_kind'"
  fi
}

# --- Test 18: find_puls_pids filtruje po ŚCIEŻCE z granicą katalogu ---
# Regresja klasy „C:\puls łapie C:\puls-backup" (parytet z install.ps1) — obce procesy
# node MUSZĄ przeżyć, filtr nigdy nie idzie po nazwie binarki.
test_find_puls_pids_matches_only_install_dir() {
  local snapshot result
  snapshot="$(printf '%s\n' \
    "  101 /Users/x/puls/.node/node-v22.17.0-darwin-arm64/bin/node --disable-warning server.js" \
    "  102 /Users/x/puls-backup/.node/node-v22.17.0-darwin-arm64/bin/node server.js" \
    "  103 /usr/local/bin/node /Users/x/inny-projekt/server.js" \
    "  104 /Users/x/puls/.node/node-v22.17.0-darwin-arm64/bin/node scripts/inbox/inbox-sync.mjs")"

  result="$(find_puls_pids "/Users/x/puls" "$snapshot" | tr '\n' ' ')"

  if [ "$result" = "101 " ]; then
    pass "find_puls_pids: łapie tylko daemona z TEGO katalogu (nie -backup, nie cudzy node)"
  else
    problem "find_puls_pids zwrócił '$result' zamiast '101 '"
  fi
}

# --- Test 19: stop_puls_processes nie rusza obcego procesu (parytet z Pesterem) ---
test_stop_puls_ignores_foreign_process() {
  sleep 10 &
  local foreign=$!
  sleep 0.3

  stop_puls_processes "$SANDBOX/nieistniejaca-instalacja" > /dev/null

  if kill -0 "$foreign" 2>/dev/null; then
    pass "stop_puls_processes: obcy proces spoza katalogu instalacji przeżył"
  else
    problem "stop_puls_processes ubił obcy proces"
  fi
  kill "$foreign" 2>/dev/null || true
  wait "$foreign" 2>/dev/null || true
}

# --- Test 20: stop_puls_processes ubija daemona URUCHOMIONEGO Z katalogu instalacji ---
# Bez tego stary proces biegnie dalej ze STARYM kodem po podmianie katalogu, a setup.mjs
# widzi żywy ping i nie startuje nowego serwera (user zostaje na starej wersji).
test_stop_puls_kills_daemon_from_install_dir() {
  local dir="$SANDBOX/stop-target" pid state alive=1
  mkdir -p "$dir/.node/bin"
  printf '#!/bin/sh\nsleep 10\n' > "$dir/.node/bin/node"
  chmod +x "$dir/.node/bin/node"
  "$dir/.node/bin/node" server.js &
  pid=$!
  sleep 0.3

  stop_puls_processes "$dir" > /dev/null

  # `|| true`: harness dziedziczy `set -e` z install.sh, a `ps` na martwym PID-zie
  # kończy się kodem 1 (czyli dokładnie tym, czego test oczekuje).
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  case "$state" in
    ""|Z*) alive=0 ;;
  esac
  if [ "$alive" = 0 ]; then
    pass "stop_puls_processes: daemon z katalogu instalacji zatrzymany przed podmianą"
  else
    problem "stop_puls_processes zostawił daemona z katalogu instalacji (stat='$state')"
  fi
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
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
test_install_dir_rejects_foreign_content
test_install_dir_declined_confirmation_keeps_data
test_install_dir_confirmed_replaces_content
test_classify_install_target_kinds
test_classify_install_target_home_with_trailing_slashes
test_classify_install_target_home_with_dot_segments
test_classify_install_target_canonicalization_keeps_normal_dirs
test_find_puls_pids_matches_only_install_dir
test_stop_puls_ignores_foreign_process
test_stop_puls_kills_daemon_from_install_dir

echo ""
echo "Wynik: ${PASS} PASS / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ] || exit 1
