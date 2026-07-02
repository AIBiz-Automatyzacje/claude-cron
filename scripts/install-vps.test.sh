#!/usr/bin/env bash
# Skryptowe testy szkieletu install-vps.sh — flagi, ask_tty, run_login, rollback.
# Wzorzec z install.test.sh: lib-only source + sandbox mktemp + pass/problem.
#
# Każdy scenariusz działa w ŚWIEŻYM subshellu (bash -c + source lib-only):
# izoluje exit code, stan zmiennych i trap ERR między testami — instalator
# ustawia set -Eeuo pipefail przy source'owaniu, więc nie źródłujemy go
# bezpośrednio do harnessu.
#
# Uruchom: bash scripts/install-vps.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$SCRIPT_DIR/install-vps.sh"
PASS=0
FAIL=0

pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
problem() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

# === Arrange: izolowana piaskownica ===
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# Uruchamia snippet (plik) z załadowanymi funkcjami instalatora.
# TTY_DEVICE domyślnie wskazuje nieistniejący plik = środowisko BEZ terminala
# (symulacja curl|bash bez tty); snippet może nadpisać na wstrzyknięty plik.
run_snippet() {
  local snippet="$1"
  bash -c "export CLAUDE_CRON_LIB_ONLY=1; source '$INSTALLER'; TTY_DEVICE='$SANDBOX/no-tty'; source '$snippet'" 2>&1
}

# --- Test 1: bash -n — skrypt bez błędów składni ---
test_syntax() {
  if bash -n "$INSTALLER" 2>"$SANDBOX/syntax.err"; then
    pass "bash -n: składnia install-vps.sh poprawna"
  else
    problem "bash -n zgłasza błędy składni: $(cat "$SANDBOX/syntax.err")"
  fi
}

# --- Test 2: parse_flags --port 8888 ustawia PORT ---
test_flags_port() {
  local snippet="$SANDBOX/t-port.sh" out
  cat > "$snippet" <<'EOF'
parse_flags --port 8888
echo "PORT=$PORT"
EOF
  out="$(run_snippet "$snippet")"
  if [ "$?" -eq 0 ] && [[ "$out" == *"PORT=8888"* ]]; then
    pass "parse_flags: --port 8888 ustawia PORT=8888"
  else
    problem "parse_flags: --port 8888 NIE ustawił PORT (output: $out)"
  fi
}

# --- Test 3: nieznana flaga → exit ≠ 0 ---
test_flags_unknown() {
  local snippet="$SANDBOX/t-unknown.sh" rc
  echo 'parse_flags --bogus' > "$snippet"
  run_snippet "$snippet" > /dev/null
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "parse_flags: nieznana flaga → exit ≠ 0"
  else
    problem "parse_flags: nieznana flaga NIE spowodowała błędu"
  fi
}

# --- Test 4: --reset + --only-puls wzajemnie wykluczające → exit ≠ 0 ---
test_flags_reset_exclusion() {
  local snippet="$SANDBOX/t-reset.sh" rc rc2
  echo 'parse_flags --reset --only-puls' > "$snippet"
  run_snippet "$snippet" > /dev/null
  rc=$?
  echo 'parse_flags --no-obsidian --reset' > "$snippet"
  run_snippet "$snippet" > /dev/null
  rc2=$?
  if [ "$rc" -ne 0 ] && [ "$rc2" -ne 0 ]; then
    pass "parse_flags: --reset wyklucza się z --only-puls / --no-obsidian"
  else
    problem "parse_flags: --reset + flagi zakresu NIE zostały odrzucone (rc=$rc rc2=$rc2)"
  fi
}

# --- Test 5: --port bez wartości → exit ≠ 0 ---
test_flags_port_missing_value() {
  local snippet="$SANDBOX/t-port-missing.sh" rc
  echo 'parse_flags --port' > "$snippet"
  run_snippet "$snippet" > /dev/null
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "parse_flags: --port bez wartości → exit ≠ 0"
  else
    problem "parse_flags: --port bez wartości NIE spowodował błędu"
  fi
}

# --- Test 6: --help → exit 0 + tekst usage ---
test_flags_help() {
  local snippet="$SANDBOX/t-help.sh" out rc
  echo 'parse_flags --help' > "$snippet"
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"--only-puls"* ]]; then
    pass "parse_flags: --help wypisuje usage i kończy z exit 0"
  else
    problem "parse_flags: --help nie zadziałał (rc=$rc)"
  fi
}

# --- Test 7: ask_tty bez tty, pytanie z defaultem → zwraca default ---
test_ask_tty_default_without_tty() {
  local snippet="$SANDBOX/t-ask-default.sh" out
  cat > "$snippet" <<'EOF'
ask_tty ANSWER "Pytanie [x]: " "wartosc-domyslna"
echo "GOT=$ANSWER"
EOF
  out="$(run_snippet "$snippet")"
  if [ "$?" -eq 0 ] && [[ "$out" == *"GOT=wartosc-domyslna"* ]]; then
    pass "ask_tty: bez tty + default → zwraca default"
  else
    problem "ask_tty: bez tty NIE zwrócił defaultu (output: $out)"
  fi
}

# --- Test 8: ask_tty bez tty, pytanie BEZ defaultu → fail z czytelnym komunikatem ---
test_ask_tty_no_default_without_tty() {
  local snippet="$SANDBOX/t-ask-nodefault.sh" out rc
  cat > "$snippet" <<'EOF'
ask_tty ANSWER "Pytanie bez defaultu: "
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" == *"terminala"* ]] && [[ "$out" != *"NIEOSIAGALNE"* ]]; then
    pass "ask_tty: bez tty + brak defaultu → fail z komunikatem o braku terminala"
  else
    problem "ask_tty: brak defaultu bez tty NIE sfailował czytelnie (rc=$rc, output: $out)"
  fi
}

# --- Test 9: ask_tty z wstrzykniętym tty (plik) → czyta odpowiedź ---
test_ask_tty_reads_injected_tty() {
  local snippet="$SANDBOX/t-ask-tty.sh" out
  echo "odpowiedz-usera" > "$SANDBOX/fake-tty"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/fake-tty"
ask_tty ANSWER "Pytanie: " "default"
echo "GOT=\$ANSWER"
EOF
  out="$(run_snippet "$snippet")"
  if [ "$?" -eq 0 ] && [[ "$out" == *"GOT=odpowiedz-usera"* ]]; then
    pass "ask_tty: czyta odpowiedź z wstrzykniętego urządzenia tty"
  else
    problem "ask_tty: NIE odczytał odpowiedzi z tty (output: $out)"
  fi
}

# --- Test 10: run_login — verify fail 2× + pass za 3. razem → sukces ---
test_run_login_succeeds_third_attempt() {
  local snippet="$SANDBOX/t-login-ok.sh" cnt="$SANDBOX/login-cnt" out rc
  echo 0 > "$cnt"
  cat > "$snippet" <<EOF
run_login "test-login" ":" "c=\\\$(cat '$cnt'); c=\\\$((c+1)); echo \\\$c > '$cnt'; [ \\\$c -ge 3 ]"
echo "PO_LOGINIE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_LOGINIE"* ]] && [ "$(cat "$cnt")" = "3" ]; then
    pass "run_login: verify fail 2× + pass za 3. próbą → sukces"
  else
    problem "run_login: retry NIE doprowadził do sukcesu (rc=$rc, próby=$(cat "$cnt"), output: $out)"
  fi
}

# --- Test 11: run_login — verify fail 3× → halt_leave_partial, BEZ rollbacku ---
test_run_login_halts_leave_partial() {
  local snippet="$SANDBOX/t-login-halt.sh" log="$SANDBOX/halt-rollback.log" out rc
  cat > "$snippet" <<EOF
trap on_err ERR
push_rollback "echo cofniete >> '$log'"
run_login "test-login" ":" "false"
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" == *"ZATRZYMANA"* ]] && [[ "$out" != *"NIEOSIAGALNE"* ]] && [ ! -s "$log" ]; then
    pass "run_login: 3× fail → halt_leave_partial (exit ≠ 0), rollback-stos NIE odwinięty"
  else
    problem "run_login: leave-partial zawiódł (rc=$rc, rollback-log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 12: rollback — błąd odwija stos w ODWROTNEJ kolejności ---
test_rollback_reverse_order() {
  local snippet="$SANDBOX/t-rb-order.sh" log="$SANDBOX/rb-order.log" rc
  cat > "$snippet" <<EOF
trap on_err ERR
push_rollback "echo A >> '$log'"
push_rollback "echo B >> '$log'"
false
EOF
  run_snippet "$snippet" > /dev/null
  rc=$?
  if [ "$rc" -ne 0 ] \
    && [ "$(sed -n 1p "$log" 2>/dev/null)" = "B" ] \
    && [ "$(sed -n 2p "$log" 2>/dev/null)" = "A" ]; then
    pass "rollback: błąd odwija stos w odwrotnej kolejności (B przed A)"
  else
    problem "rollback: zła kolejność lub brak odwinięcia (rc=$rc, log: $(cat "$log" 2>/dev/null))"
  fi
}

# --- Test 13: disable_rollback — błąd w bloku NIE odwija stosu ---
test_rollback_disabled() {
  local snippet="$SANDBOX/t-rb-off.sh" log="$SANDBOX/rb-off.log" rc
  cat > "$snippet" <<EOF
trap on_err ERR
push_rollback "echo A >> '$log'"
disable_rollback
false
EOF
  run_snippet "$snippet" > /dev/null
  rc=$?
  if [ "$rc" -ne 0 ] && [ ! -s "$log" ]; then
    pass "disable_rollback: błąd NIE odwija stosu (exit ≠ 0, log pusty)"
  else
    problem "disable_rollback: stos został odwinięty mimo wyłączenia (rc=$rc, log: $(cat "$log" 2>/dev/null))"
  fi
}

# --- Test 14: enable_rollback po disable — błąd znowu odwija stos ---
test_rollback_reenabled() {
  local snippet="$SANDBOX/t-rb-on.sh" log="$SANDBOX/rb-on.log" rc
  cat > "$snippet" <<EOF
trap on_err ERR
push_rollback "echo A >> '$log'"
disable_rollback
enable_rollback
false
EOF
  run_snippet "$snippet" > /dev/null
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$(sed -n 1p "$log" 2>/dev/null)" = "A" ]; then
    pass "enable_rollback: po ponownym włączeniu błąd odwija stos"
  else
    problem "enable_rollback: stos NIE został odwinięty po ponownym włączeniu (rc=$rc)"
  fi
}

# --- Test 15: grep-strażnik — goły `read` poza definicją ask_tty = 0 trafień ---
test_no_read_outside_ask_tty() {
  # Pod curl|bash stdin to pipe: goły `read` dostaje EOF i cicho psuje
  # instalator. ask_tty (czytający z TTY_DEVICE) to JEDYNE dozwolone miejsce
  # (plan IU1: zakaz egzekwowany testem grep, nie jednorazową ręczną weryfikacją).
  # Wycinamy definicję ask_tty i komentarze, potem szukamy wywołań read.
  # `grep -w` (word-match), nie alternacja `(^|...)` — tę ostatnią różnie
  # interpretują implementacje grep (GNU/BSD/ugrep), a -w działa wszędzie.
  local hits
  hits=$(sed -e '/^ask_tty()/,/^}/d' -e 's/#.*//' "$INSTALLER" \
    | grep -nw 'read' || true)
  if [ -z "$hits" ]; then
    pass "grep-strażnik: brak gołego \`read\` poza ask_tty"
  else
    problem "grep-strażnik: goły \`read\` poza ask_tty: $hits"
  fi
}

# --- Test 16: --port nienumeryczny / poza zakresem 1-65535 → exit ≠ 0 ---
test_flags_port_invalid() {
  local snippet="$SANDBOX/t-port-bad.sh" val rc all_ok=1
  for val in abc 7777x 0 70000; do
    echo "parse_flags --port $val" > "$snippet"
    run_snippet "$snippet" > /dev/null
    rc=$?
    if [ "$rc" -eq 0 ]; then
      problem "parse_flags: --port $val NIE został odrzucony"
      all_ok=0
    fi
  done
  if [ "$all_ok" -eq 1 ]; then
    pass "parse_flags: --port abc/7777x/0/70000 → exit ≠ 0"
  fi
}

# --- Test 17: ask_port — odpowiedź z tty przez tę samą walidację co --port ---
test_ask_port_validation() {
  local snippet="$SANDBOX/t-ask-port.sh" out rc out2
  echo "abc" > "$SANDBOX/tty-port-bad"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-port-bad"
PORT=7777
ask_port
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  echo "8080" > "$SANDBOX/tty-port-ok"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-port-ok"
PORT=7777
ask_port
echo "PORT=\$PORT"
EOF
  out2="$(run_snippet "$snippet")"
  if [ "$rc" -ne 0 ] && [[ "$out" != *"NIEOSIAGALNE"* ]] && [[ "$out2" == *"PORT=8080"* ]]; then
    pass "ask_port: śmieciowy port z tty → exit ≠ 0; poprawny → PORT ustawiony"
  else
    problem "ask_port: walidacja portu z tty zawiodła (rc=$rc, out: $out, out2: $out2)"
  fi
}

# --- Test 18: ask_tty z urządzeniem przechodzącym [ -r ], ale niepodłączonym ---
test_ask_tty_unopenable_device() {
  # Realna semantyka /dev/tty BEZ kontrolującego terminala (ssh bez -t, cron):
  # [ -r ] przechodzi (prawa rw-rw-rw-), ale open() pada (ENXIO). Symulacja
  # plikiem socketa — open() na sockecie pada tak samo, a [ -r ] zwraca true.
  local sock="$SANDBOX/fake-socket" snippet="$SANDBOX/t-ask-sock.sh" out rc out2
  perl -MSocket -e 'socket(S,AF_UNIX,SOCK_STREAM,0); bind(S, sockaddr_un($ARGV[0])) or die' "$sock" 2>/dev/null
  if [ ! -S "$sock" ]; then
    problem "ask_tty: nie udało się utworzyć socketa do symulacji braku tty"
    return
  fi
  cat > "$snippet" <<EOF
TTY_DEVICE="$sock"
ask_tty ANSWER "Pytanie bez defaultu: "
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  cat > "$snippet" <<EOF
TTY_DEVICE="$sock"
ask_tty ANSWER "Pytanie: " "domyslna"
echo "GOT=\$ANSWER"
EOF
  out2="$(run_snippet "$snippet")"
  if [ "$rc" -ne 0 ] && [[ "$out" == *"terminala"* ]] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [[ "$out2" == *"GOT=domyslna"* ]]; then
    pass "ask_tty: [ -r ] true + open() pada → fail bez defaultu / default z defaultem"
  else
    problem "ask_tty: nieotwieralne tty źle obsłużone (rc=$rc, out: $out, out2: $out2)"
  fi
}

# --- Test 19: halt_leave_partial — resume to one-liner curl, nie lokalny plik ---
test_halt_resume_message() {
  # R6 spec-u: pod curl|sudo bash plik install-vps.sh nie istnieje lokalnie,
  # więc instrukcja "sudo bash install-vps.sh" prowadziłaby donikąd.
  local snippet="$SANDBOX/t-halt-msg.sh" out rc
  echo 'halt_leave_partial "krok-testowy"' > "$snippet"
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" == *"curl -fsSL"* ]] && [[ "$out" != *"sudo bash install-vps.sh"* ]]; then
    pass "halt_leave_partial: komunikat resume pokazuje one-liner curl | sudo bash"
  else
    problem "halt_leave_partial: komunikat resume zły (rc=$rc, output: $out)"
  fi
}

echo "== install-vps.sh — testy szkieletu (flagi/tty/login/rollback) =="
test_syntax
test_flags_port
test_flags_unknown
test_flags_reset_exclusion
test_flags_port_missing_value
test_flags_help
test_ask_tty_default_without_tty
test_ask_tty_no_default_without_tty
test_ask_tty_reads_injected_tty
test_run_login_succeeds_third_attempt
test_run_login_halts_leave_partial
test_rollback_reverse_order
test_rollback_disabled
test_rollback_reenabled
test_no_read_outside_ask_tty
test_flags_port_invalid
test_ask_port_validation
test_ask_tty_unopenable_device
test_halt_resume_message

echo ""
echo "Wynik: ${PASS} PASS / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ] || exit 1
