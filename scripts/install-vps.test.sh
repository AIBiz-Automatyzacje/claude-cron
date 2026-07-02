#!/usr/bin/env bash
# Skryptowe testy install-vps.sh — flagi, ask_tty, run_login, rollback (faza 1),
# preflight, guardy has_*, walidacja bloku pytań (faza 2) oraz sekwencja
# narzędzi install_* przed login_block i warunkowy rollback userdel (faza 3).
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
# Osobna piaskownica pod /tmp dla testów workspace: domyślny mktemp na macOS
# daje ścieżkę pod /var/folders/..., którą is_valid_workspace_path słusznie
# odrzuca (/var jest na liście katalogów systemowych).
WS_SANDBOX="$(mktemp -d /tmp/install-vps-ws.XXXXXX)"
trap 'rm -rf "$SANDBOX" "$WS_SANDBOX"' EXIT

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

# --- Test 17: normalize_repo — user/repo → URL; https → bez zmian; ssh/śmieci → fail ---
test_normalize_repo() {
  local snippet="$SANDBOX/t-repo.sh" out
  cat > "$snippet" <<'EOF'
n1="$(normalize_repo 'user/repo')"
echo "N1=$n1"
n2="$(normalize_repo 'https://github.com/user/repo.git')"
echo "N2=$n2"
rc_ssh=0; normalize_repo 'git@github.com:user/repo.git' >/dev/null || rc_ssh=$?
rc_junk=0; normalize_repo 'to nie jest repo' >/dev/null || rc_junk=$?
echo "SSH=$rc_ssh JUNK=$rc_junk"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"N1=https://github.com/user/repo.git"* ]] \
    && [[ "$out" == *"N2=https://github.com/user/repo.git"* ]] \
    && [[ "$out" == *"SSH=1 JUNK=1"* ]]; then
    pass "normalize_repo: user/repo → pełny URL; https bez zmian; ssh/śmieci → exit ≠ 0"
  else
    problem "normalize_repo: zła normalizacja/walidacja (output: $out)"
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

# --- Test 20: walidacja emaila — brak @ → ponowne pytanie, potem fail; poprawny → OK ---
test_ask_valid_email() {
  local snippet="$SANDBOX/t-email.sh" out rc out2 warn_count
  echo "brak-malpy" > "$SANDBOX/tty-email-bad"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-email-bad"
ask_valid OUT "Email konta Obsidian: " is_valid_email "Niepoprawny email"
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  # Wstrzyknięty tty oddaje w kółko tę samą złą odpowiedź → ponowne pytanie
  # widać jako ≥2 komunikaty błędu, a po wyczerpaniu prób exit ≠ 0.
  warn_count=$(grep -c "Niepoprawny email" <<<"$out" || true)
  echo "kursant@example.com" > "$SANDBOX/tty-email-ok"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-email-ok"
ask_valid OUT "Email konta Obsidian: " is_valid_email "Niepoprawny email"
echo "GOT=\$OUT"
EOF
  out2="$(run_snippet "$snippet")"
  if [ "$rc" -ne 0 ] && [ "$warn_count" -ge 2 ] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [[ "$out2" == *"GOT=kursant@example.com"* ]]; then
    pass "walidacja emaila: brak @ → ponowne pytanie → fail; poprawny → przyjęty"
  else
    problem "walidacja emaila zawiodła (rc=$rc, warny=$warn_count, out: $out, out2: $out2)"
  fi
}

# --- Test 21: walidacja Discord URL — zły prefix → ponowne pytanie; puste = pomiń ---
test_ask_valid_discord() {
  local snippet="$SANDBOX/t-discord.sh" out rc out2 out3 warn_count
  echo "https://zly.example.com/webhooks/1" > "$SANDBOX/tty-dc-bad"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-dc-bad"
ask_valid OUT "Discord webhook (puste = pomiń): " is_valid_discord_webhook "Niepoprawny webhook" ""
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  warn_count=$(grep -c "Niepoprawny webhook" <<<"$out" || true)
  echo "https://discord.com/api/webhooks/123/abc" > "$SANDBOX/tty-dc-ok"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-dc-ok"
ask_valid OUT "Discord webhook (puste = pomiń): " is_valid_discord_webhook "Niepoprawny webhook" ""
echo "GOT=[\$OUT]"
EOF
  out2="$(run_snippet "$snippet")"
  : > "$SANDBOX/tty-dc-empty"
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-dc-empty"
ask_valid OUT "Discord webhook (puste = pomiń): " is_valid_discord_webhook "Niepoprawny webhook" ""
echo "GOT=[\$OUT]"
EOF
  out3="$(run_snippet "$snippet")"
  if [ "$rc" -ne 0 ] && [ "$warn_count" -ge 2 ] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [[ "$out2" == *"GOT=[https://discord.com/api/webhooks/123/abc]"* ]] \
    && [[ "$out3" == *"GOT=[]"* ]]; then
    pass "walidacja Discord: zły prefix → ponowne pytanie → fail; poprawny → OK; puste = pomiń"
  else
    problem "walidacja Discord zawiodła (rc=$rc, warny=$warn_count, out2: $out2, out3: $out3)"
  fi
}

# --- Test 22: detect_timezone — pusty wynik timedatectl → Europe/Warsaw ---
test_detect_timezone() {
  local snippet="$SANDBOX/t-tz.sh" out
  cat > "$snippet" <<'EOF'
t1="$(detect_timezone '')"
t2="$(detect_timezone 'Europe/Berlin')"
echo "T1=$t1 T2=$t2"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"T1=Europe/Warsaw T2=Europe/Berlin"* ]]; then
    pass "detect_timezone: pusta autodetekcja → Europe/Warsaw; niepusta → bez zmian"
  else
    problem "detect_timezone: zły fallback (output: $out)"
  fi
}

# --- Test 23: has_ob_auth vs has_ob_sync — DWA OSOBNE checki (zalogowany-bez-synca = 0,1) ---
test_ob_guards_separate() {
  # DI: run_as_claude podmienione na lokalny bash, atrapa `ob` przez PATH —
  # login przechodzi (exit 0), sync-status pada (exit 1). Sklejenie checków
  # w jeden dałoby (0,0) albo (1,1).
  local snippet="$SANDBOX/t-ob-guards.sh" out
  mkdir -p "$SANDBOX/stub-bin"
  cat > "$SANDBOX/stub-bin/ob" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  login) exit 0 ;;
  sync-status) exit 1 ;;
esac
exit 1
STUB
  chmod +x "$SANDBOX/stub-bin/ob"
  cat > "$snippet" <<EOF
export PATH="$SANDBOX/stub-bin:\$PATH"
has_user_claude() { return 0; }
run_as_claude() { bash -c "\$1"; }
if has_ob_auth; then echo "AUTH=0"; else echo "AUTH=1"; fi
if has_ob_sync; then echo "SYNC=0"; else echo "SYNC=1"; fi
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"AUTH=0"* ]] && [[ "$out" == *"SYNC=1"* ]]; then
    pass "has_ob_auth vs has_ob_sync: zalogowany-bez-synca daje (0,1) — checki osobne"
  else
    problem "guardy ob sklejone lub błędne (output: $out)"
  fi
}

# --- Test 24: is_supported_os — ubuntu/ID_LIKE → 0; fedora/brak pliku → 1 ---
test_is_supported_os() {
  local snippet="$SANDBOX/t-os.sh" out
  printf 'NAME="Ubuntu"\nID=ubuntu\n' > "$SANDBOX/os-ubuntu"
  printf 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n' > "$SANDBOX/os-mint"
  printf 'NAME="Fedora"\nID=fedora\n' > "$SANDBOX/os-fedora"
  cat > "$snippet" <<EOF
rc_u=0; is_supported_os "$SANDBOX/os-ubuntu" || rc_u=\$?
rc_m=0; is_supported_os "$SANDBOX/os-mint" || rc_m=\$?
rc_f=0; is_supported_os "$SANDBOX/os-fedora" || rc_f=\$?
rc_x=0; is_supported_os "$SANDBOX/os-nie-istnieje" || rc_x=\$?
echo "U=\$rc_u M=\$rc_m F=\$rc_f X=\$rc_x"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"U=0 M=0 F=1 X=1"* ]]; then
    pass "is_supported_os: ubuntu/ID_LIKE → wspierany; fedora/brak pliku → odrzucony"
  else
    problem "is_supported_os: zła detekcja OS (output: $out)"
  fi
}

# --- Test 25: normalize_path — cudzysłowy/spacje/~ jak w dotychczasowej normalizacji ---
test_normalize_path() {
  local snippet="$SANDBOX/t-path.sh" out
  cat > "$snippet" <<'EOF'
CLAUDE_HOME="/home/claude"
p1="$(normalize_path "'/tmp/moj vault' ")"
p2="$(normalize_path "~/vault")"
echo "P1=[$p1] P2=[$p2]"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"P1=[/tmp/moj vault] P2=[/home/claude/vault]"* ]]; then
    pass "normalize_path: zdejmuje cudzysłowy/brzegowe spacje, rozwija ~ na home claude"
  else
    problem "normalize_path: zła normalizacja (output: $out)"
  fi
}

# --- Test 26: is_valid_workspace_path — absolutna poza systemowymi OK; /, /etc, względna → fail ---
test_is_valid_workspace_path() {
  local snippet="$SANDBOX/t-ws-valid.sh" out
  cat > "$snippet" <<'EOF'
ok_home=0; is_valid_workspace_path "/home/claude/vault" || ok_home=$?
ok_srv=0;  is_valid_workspace_path "/srv/moj-projekt" || ok_srv=$?
r_rel=0;   is_valid_workspace_path "vault" || r_rel=$?
r_root=0;  is_valid_workspace_path "/" || r_root=$?
r_etc=0;   is_valid_workspace_path "/etc" || r_etc=$?
r_etcs=0;  is_valid_workspace_path "/etc/nginx" || r_etcs=$?
r_var=0;   is_valid_workspace_path "/var/lib/postgresql" || r_var=$?
echo "OKH=$ok_home OKS=$ok_srv REL=$r_rel ROOT=$r_root ETC=$r_etc ETCS=$r_etcs VAR=$r_var"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"OKH=0 OKS=0 REL=1 ROOT=1 ETC=1 ETCS=1 VAR=1"* ]]; then
    pass "is_valid_workspace_path: /home,/srv OK; względna, /, /etc(+pod), /var → odrzucone"
  else
    problem "is_valid_workspace_path: zła walidacja (output: $out)"
  fi
}

# --- Test 27: ask_workspace — systemowa ścieżka → retry → fail; literówka bez zgody → retry; istniejący → OK ---
test_ask_workspace_flow() {
  # Część A: wstrzyknięty tty w kółko oddaje "/etc" → warn ≥2 + exit ≠ 0
  # (symetria z ask_valid: zła ścieżka NIGDY nie ląduje w WORKSPACE).
  local snippet="$SANDBOX/t-ws-ask.sh" out rc out2 warn_count
  echo "/etc" > "$SANDBOX/tty-ws-bad"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$SANDBOX/home-claude"
TTY_DEVICE="$SANDBOX/tty-ws-bad"
ask_workspace
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  warn_count=$(grep -c "katalogami systemowymi" <<<"$out" || true)
  # Część B: sekwencja odpowiedzi przez stub granicy tty (DI jak run_as_claude
  # w teście 23): systemowa → odrzucona; nieistniejąca + odmowa utworzenia →
  # ponowione pytanie; istniejący katalog → przyjęty bez pytania o utworzenie.
  mkdir -p "$WS_SANDBOX/ws-istnieje"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$SANDBOX/home-claude"
ASK_QUEUE=("/etc" "$WS_SANDBOX/ws-literowka" "n" "$WS_SANDBOX/ws-istnieje")
ASK_I=0
ask_tty() { printf -v "\$1" '%s' "\${ASK_QUEUE[\$ASK_I]}"; ASK_I=\$((ASK_I + 1)); }
ask_workspace
echo "WS=\$WORKSPACE"
EOF
  out2="$(run_snippet "$snippet")"
  if [ "$rc" -ne 0 ] && [ "$warn_count" -ge 2 ] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [[ "$out2" == *"WS=$WS_SANDBOX/ws-istnieje"* ]] \
    && [ ! -d "$WS_SANDBOX/ws-literowka" ]; then
    pass "ask_workspace: systemowa → retry → fail; odmowa utworzenia → retry; istniejący → OK"
  else
    problem "ask_workspace: zły przepływ (rc=$rc, warny=$warn_count, out: $out, out2: $out2)"
  fi
}

# --- Test 28: ensure_workspace — chown TYLKO dla świeżo utworzonego katalogu ---
test_ensure_workspace_chown_only_on_create() {
  # Bezwarunkowy chown = root po cichu przejmuje istniejący katalog innego
  # serwisu (P2-1 review fazy 2). Stub chown przez funkcję (DI granicy systemu).
  local snippet="$SANDBOX/t-ws-chown.sh" log="$SANDBOX/chown.log" out
  mkdir -p "$SANDBOX/ws-stary"
  cat > "$snippet" <<EOF
chown() { echo "CHOWN \$*" >> "$log"; }
WORKSPACE="$SANDBOX/ws-nowy"
ensure_workspace
WORKSPACE="$SANDBOX/ws-stary"
ensure_workspace
EOF
  out="$(run_snippet "$snippet")"
  if [ "$?" -eq 0 ] && [ -d "$SANDBOX/ws-nowy" ] \
    && [ "$(grep -c '^CHOWN' "$log" 2>/dev/null)" = "1" ] \
    && grep -q "ws-nowy" "$log" && ! grep -q "ws-stary" "$log"; then
    pass "ensure_workspace: chown tylko przy utworzeniu; istniejący katalog nietknięty"
  else
    problem "ensure_workspace: zły chown (log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# Rejestrator wywołań dla testów sekwencji main() (faza 3): każda funkcja-
# komponent podmieniona na stub echo "CALL <nazwa>" — main wykonuje się bez
# side-effectów, a harness bada KOLEJNOŚĆ i OBECNOŚĆ wywołań (DI jak w t.23).
MAIN_COMPONENT_FNS="print_banner run_preflight resolve_install_paths collect_config \
apply_timezone install_base_packages install_node ensure_claude_user ensure_workspace \
install_claude_cli install_ob install_tailscale login_block clone_repo \
setup_puls_dependencies create_systemd_service configure_firewall setup_tailscale \
setup_funnel setup_auto_update print_summary"

write_recorder_snippet() {
  local snippet="$1" main_args="$2"
  cat > "$snippet" <<EOF
for fn in $MAIN_COMPONENT_FNS; do
  eval "\$fn() { echo \"CALL \$fn\"; }"
done
main $main_args
EOF
}

# --- Test 29: sekwencja main() — wszystkie install_* PRZED login_block ---
test_main_installs_before_login_block() {
  # Żadne narzędzie nie może instalować się po pierwszej pauzie interaktywnej:
  # re-run po padzie loginu (leave-partial) musi wskakiwać prosto w login.
  local snippet="$SANDBOX/t-seq.sh" out calls before after
  write_recorder_snippet "$snippet" ""
  out="$(run_snippet "$snippet")"
  calls="$(grep '^CALL ' <<<"$out" || true)"
  if ! grep -q '^CALL login_block$' <<<"$calls"; then
    problem "sekwencja main(): brak wywołania login_block (calls: $calls)"
    return
  fi
  before="$(sed -n '1,/^CALL login_block$/p' <<<"$calls")"
  after="$(sed -n '/^CALL login_block$/,$p' <<<"$calls" | tail -n +2)"
  if grep -q '^CALL install_base_packages$' <<<"$before" \
    && grep -q '^CALL install_node$' <<<"$before" \
    && grep -q '^CALL install_claude_cli$' <<<"$before" \
    && grep -q '^CALL install_ob$' <<<"$before" \
    && grep -q '^CALL install_tailscale$' <<<"$before" \
    && ! grep -q '^CALL install_' <<<"$after"; then
    pass "main(): wszystkie install_* przed login_block, żadnego install_* po"
  else
    problem "main(): zła sekwencja install_*/login_block (calls: $calls)"
  fi
}

# --- Test 30: --only-puls → install_ob NIE wywołane; bez flagi → wywołane ---
test_main_only_puls_skips_ob() {
  # Decyzja o pominięciu zapada w main() (nie wewnątrz install_ob) — rejestrator
  # widzi realny brak wywołania, nie early-return wewnątrz stubowanej funkcji.
  local snippet="$SANDBOX/t-onlypuls.sh" out
  write_recorder_snippet "$snippet" "--only-puls"
  out="$(run_snippet "$snippet")"
  if [[ "$out" != *"CALL install_ob"* ]] \
    && [[ "$out" == *"CALL install_claude_cli"* ]] \
    && [[ "$out" == *"CALL install_tailscale"* ]]; then
    pass "main --only-puls: install_ob pominięte, reszta narzędzi instalowana"
  else
    problem "main --only-puls: zły zestaw wywołań (output: $out)"
  fi
}

# --- Test 31: rollback userdel rejestrowany TYLKO gdy user powstał w tym runie ---
test_userdel_rollback_conditional() {
  # Istniejący user (has_user_claude=0) to cudzy stan sprzed runa — rollback
  # NIE może go skasować. Stub useradd/resolve (DI granicy systemu jak w t.28).
  local snippet="$SANDBOX/t-userdel.sh" out
  cat > "$snippet" <<'EOF'
useradd() { :; }
resolve_install_paths() { :; }
has_user_claude() { return 0; }
ensure_claude_user
echo "STACK_A=[${ROLLBACK_STACK[*]-}]"
has_user_claude() { return 1; }
ensure_claude_user
echo "STACK_B=[${ROLLBACK_STACK[*]-}]"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"STACK_A=[]"* ]] && [[ "$out" == *"STACK_B=[userdel -r claude]"* ]]; then
    pass "rollback: userdel na stosie TYLKO gdy user utworzony w tym runie"
  else
    problem "rollback userdel: zła rejestracja (output: $out)"
  fi
}

echo "== install-vps.sh — testy szkieletu (flagi/tty/login/rollback), fazy 2 (preflight/guardy/pytania) i fazy 3 (narzędzia/sekwencja) =="
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
test_normalize_repo
test_ask_tty_unopenable_device
test_halt_resume_message
test_ask_valid_email
test_ask_valid_discord
test_detect_timezone
test_ob_guards_separate
test_is_supported_os
test_normalize_path
test_is_valid_workspace_path
test_ask_workspace_flow
test_ensure_workspace_chown_only_on_create
test_main_installs_before_login_block
test_main_only_puls_skips_ob
test_userdel_rollback_conditional

echo ""
echo "Wynik: ${PASS} PASS / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ] || exit 1
