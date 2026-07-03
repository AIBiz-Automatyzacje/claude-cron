#!/usr/bin/env bash
# Skryptowe testy install-vps.sh — flagi, ask_tty, run_login, rollback (faza 1),
# preflight, guardy has_*, walidacja bloku pytań (faza 2), sekwencja
# narzędzi install_* przed login_block, warunkowy rollback userdel/npm rm,
# neutralizacja userdel na granicy loginów i testy jednostkowe funkcji
# install_* — guard-skip + fail-fast (faza 3) oraz blok 5 loginów: pełny
# resume, wskok w brakującą pauzę, retry walidacji repo, leave-partial
# bez rollbacku i pomijanie pauz ob przy --only-puls (faza 4) oraz Obsidian +
# unity systemd: ENV_LINES, unit obsidian-sync, weryfikacja file-types,
# sparse checkout/symlink .claude, kolejność sync-config → enable, rollback
# unit-plików utworzonych w tym runie (faza 5) oraz finał: CRON_CMD auto-update
# (02:00, cytowanie %q, --only-puls bez vault-git, --no-auto-update bez crona),
# weryfikacja serwisów + pętla pierwszego synca, plik-dowód Witaj-z-VPS.md,
# Funnel opt-in (N → zero wywołań tailscale) i podsumowanie PL (faza 6) oraz
# reset/deinstalacja: potwierdzenie dosłownym TAK, guardy ${…:?} listy ścieżek,
# idempotencja na czystym systemie i kolejność serwisy→pliki→cron→userdel (faza 7).
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
  # DI: run_as_claude podmienione na lokalny bash, atrapa `ob` przez PATH.
  # Realny kontrakt ob (cli.js 0.0.12): ZALOGOWANY login wypisuje
  # "Logged in as <nazwa> (<email>)" i kończy 0; NIEZALOGOWANY pod </dev/null
  # też kończy 0, ale BEZ tej frazy (zawieszony prompt hasła → pusty event
  # loop → cichy exit 0). Guard musi rozróżniać po outputcie, nie kodzie.
  local snippet="$SANDBOX/t-ob-guards.sh" out
  mkdir -p "$SANDBOX/stub-bin"
  cat > "$SANDBOX/stub-bin/ob" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  login) echo "Logged in as Test User (t@example.com)"; exit 0 ;;
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

  # Adversarial (realny pad z VPS 2026-07-02): niezalogowany ob kończy się
  # kodem 0 BEZ "Logged in as" — guard po samym kodzie wyjścia pominąłby
  # KROK 3/5 (ob login) i sync-setup padłby na "No account logged in".
  local snippet2="$SANDBOX/t-ob-guards-falsepos.sh" out2
  mkdir -p "$SANDBOX/stub-bin-noauth"
  cat > "$SANDBOX/stub-bin-noauth/ob" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  login) exit 0 ;;
esac
exit 1
STUB
  chmod +x "$SANDBOX/stub-bin-noauth/ob"
  cat > "$snippet2" <<EOF
export PATH="$SANDBOX/stub-bin-noauth:\$PATH"
has_user_claude() { return 0; }
run_as_claude() { bash -c "\$1"; }
if has_ob_auth; then echo "AUTH=0"; else echo "AUTH=1"; fi
EOF
  out2="$(run_snippet "$snippet2")"
  if [[ "$out2" == *"AUTH=1"* ]]; then
    pass "has_ob_auth: exit 0 bez 'Logged in as' (niezalogowany ob pod EOF) → NIE zalogowany"
  else
    problem "has_ob_auth: fałszywy pozytyw na cichym exit 0 niezalogowanego ob (output: $out2)"
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

# --- Test 70: collect_config REALNY przebieg — komplet pytań bez Discorda, bez wiszącego read ---
test_collect_config_no_discord_question() {
  # Unit 7 (faza 3): instalator NIE pyta o Discord. Harness main() mockuje
  # collect_config (MAIN_COMPONENT_FNS), więc regresja przywracająca pytanie
  # przeszłaby suite — a pod curl|bash wiszący `read` dostaje EOF i ciche
  # domyślne (learned pattern). TEN test wykonuje REALNY collect_config ze
  # stubem ask_tty na granicy tty (DI jak w t.27B): kolejka odpowiedzi o ZNANEJ
  # długości — każde DODATKOWE pytanie sięga poza kolejkę i wywala test
  # (guard :?), a licznik ASK_I przypina dokładną liczbę interakcji.
  local snippet="$SANDBOX/t-collect-full.sh" out rc out2 rc2

  # Część A: pełny tryb — dokładnie 4 pytania (email, vault, repo, potwierdzenie).
  cat > "$snippet" <<EOF
parse_flags
CLAUDE_HOME="$SANDBOX/home-claude"
ASK_QUEUE=("kursant@example.com" "MojVault" "user/repo" "T")
ASK_I=0
ask_tty() {
  echo "PYTANIE: \$2"
  printf -v "\$1" '%s' "\${ASK_QUEUE[\$ASK_I]:?za duzo pytan - wiszacy read}"
  ASK_I=\$((ASK_I + 1))
}
collect_config
echo "QUESTIONS=\$ASK_I REPO=\$VAULT_GIT_REPO"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?

  # Część B: --only-puls — dokładnie 2 pytania (workspace, potwierdzenie).
  mkdir -p "$WS_SANDBOX/ws-collect"
  cat > "$snippet" <<EOF
parse_flags --only-puls
CLAUDE_HOME="$SANDBOX/home-claude"
ASK_QUEUE=("$WS_SANDBOX/ws-collect" "T")
ASK_I=0
ask_tty() {
  echo "PYTANIE: \$2"
  printf -v "\$1" '%s' "\${ASK_QUEUE[\$ASK_I]:?za duzo pytan - wiszacy read}"
  ASK_I=\$((ASK_I + 1))
}
collect_config
echo "QUESTIONS=\$ASK_I WS=\$WORKSPACE"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?

  if [ "$rc" -eq 0 ] && [[ "$out" == *"QUESTIONS=4 REPO=https://github.com/user/repo.git"* ]] \
    && ! grep -qiE 'discord|webhook' <<<"$out" \
    && [ "$rc2" -eq 0 ] && [[ "$out2" == *"QUESTIONS=2 WS=$WS_SANDBOX/ws-collect"* ]] \
    && ! grep -qiE 'discord|webhook' <<<"$out2"; then
    pass "collect_config: realny przebieg — 4 pytania (pełny) / 2 (--only-puls), zero Discorda, brak wiszącego read"
  else
    problem "collect_config: zły przebieg bloku pytań (rc=$rc, out: $out, rc2=$rc2, out2: $out2)"
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
apply_timezone setup_apt_lock_wait install_base_packages install_node ensure_claude_user ensure_workspace \
install_claude_cli install_ob install_tailscale login_block \
configure_obsidian_file_types setup_vault_git link_vault_claude \
create_obsidian_sync_service clone_repo \
setup_puls_dependencies create_systemd_service configure_firewall setup_tailscale \
setup_auto_update verify_services create_welcome_note setup_funnel print_summary"

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

# --- Test 32: login_block zdejmuje rollback userdel — ERR po loginach nie kasuje usera ---
test_login_block_drops_userdel_rollback() {
  # P2-1 review fazy 3: świeży user (userdel na stosie) + wejście w blok
  # loginów → wpis userdel zdjęty (ERR w clone/npm nie skasuje credentiali
  # OAuth w /home/claude). Inne wpisy stosu zostają nietknięte.
  # Wszystkie pauzy stubowane (od IU4 blok ma ich 5) — test bada wyłącznie
  # rollback-stos na granicy bloku, nie same loginy.
  local snippet="$SANDBOX/t-login-drop.sh" out
  cat > "$snippet" <<'EOF'
useradd() { :; }
resolve_install_paths() { :; }
has_user_claude() { return 1; }
login_claude_cli() { :; }
login_gh() { :; }
login_ob() { :; }
login_ob_sync() { :; }
login_tailscale() { :; }
push_rollback "echo inne"
ensure_claude_user
echo "PRZED=[${ROLLBACK_STACK[*]-}]"
login_block
echo "PO=[${ROLLBACK_STACK[*]-}]"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"PRZED=[echo inne userdel -r claude]"* ]] \
    && [[ "$out" == *"PO=[echo inne]"* ]]; then
    pass "login_block: wpis 'userdel -r' zdjęty ze stosu, pozostałe wpisy zostają"
  else
    problem "login_block: rollback userdel NIE został zneutralizowany (output: $out)"
  fi
}

# --- Test 33: install_base_packages — guard-skip bez apt; brak narzędzia po instalacji → fail ---
test_install_base_packages() {
  # Happy: wszystkie binarki obecne (atrapy przez PATH jak w t.23) →
  # zero wywołań apt-get (guard-skip, cudzy stan nietykany).
  local snippet="$SANDBOX/t-base.sh" log="$SANDBOX/apt.log" bin="$SANDBOX/stub-bin-base" out rc t
  mkdir -p "$bin"
  for t in git curl crontab gh; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/$t"
    chmod +x "$bin/$t"
  done
  cat > "$snippet" <<EOF
export PATH="$bin:\$PATH"
apt-get() { echo "APT \$*" >> "$log"; }
systemctl() { :; }
install_base_packages
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$log" ]; then
    pass "install_base_packages: komplet narzędzi obecny → zero wywołań apt-get"
  else
    problem "install_base_packages: guard-skip zawiódł (rc=$rc, apt-log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # Error: gh nieobecne (restrykcyjny PATH — maszyna dev może mieć gh),
  # apt-get (stub) nic nie instaluje → weryfikacja po instalacji fail-fast.
  local bin2="$SANDBOX/stub-bin-base-err" log2="$SANDBOX/apt-err.log" out2 rc2
  mkdir -p "$bin2"
  for t in git curl crontab; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$bin2/$t"
    chmod +x "$bin2/$t"
  done
  cat > "$snippet" <<EOF
export PATH="$bin2"
apt-get() { echo "APT \$*" >> "$log2"; }
systemctl() { :; }
install_base_packages
echo "NIEOSIAGALNE"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -ne 0 ] && [[ "$out2" == *"brak 'gh'"* ]] && [[ "$out2" != *"NIEOSIAGALNE"* ]] \
    && grep -q "APT install" "$log2" 2>/dev/null; then
    pass "install_base_packages: brak gh po instalacji → fail-fast z komunikatem"
  else
    problem "install_base_packages: fail-fast zawiódł (rc=$rc2, output: $out2)"
  fi
}

# --- Test 34: install_claude_cli — guard-skip bez curl; weryfikacja po instalacji pada → fail ---
test_install_claude_cli() {
  # DI: run_as_claude podmienione (szew per-user jak w t.23) i logujące
  # wywołania — guard-skip nie może pobierać instalatora.
  local snippet="$SANDBOX/t-claude-cli.sh" log="$SANDBOX/rac.log" out rc
  cat > "$snippet" <<EOF
run_as_claude() { echo "RAC \$1" >> "$log"; return 0; }
install_claude_cli
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"już zainstalowane"* ]] && ! grep -q "curl" "$log" 2>/dev/null; then
    pass "install_claude_cli: claude obecny → guard-skip bez pobierania instalatora"
  else
    problem "install_claude_cli: guard-skip zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # Error: instalator (curl|bash) "przechodzi", ale binarka claude dalej
  # nieobecna → weryfikacja po instalacji fail-fast z czytelną przyczyną.
  local log2="$SANDBOX/rac-err.log" out2 rc2
  cat > "$snippet" <<EOF
run_as_claude() {
  echo "RAC \$1" >> "$log2"
  case "\$1" in *curl*) return 0 ;; *) return 1 ;; esac
}
install_claude_cli
echo "NIEOSIAGALNE"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -ne 0 ] && [[ "$out2" == *"brak 'claude'"* ]] && [[ "$out2" != *"NIEOSIAGALNE"* ]] \
    && grep -q "curl" "$log2" 2>/dev/null; then
    pass "install_claude_cli: instalacja nie dała binarki → fail-fast"
  else
    problem "install_claude_cli: fail-fast zawiódł (rc=$rc2, output: $out2)"
  fi
}

# --- Test 35: install_ob — guard-skip; rollback npm rm TYLKO gdy zainstalowano w tym runie; fail-fast ---
test_install_ob() {
  # Symetria z t.31 (userdel): ob obecny przed runem = cudza instalacja —
  # zero npm i PUSTY stos (fail późniejszego kroku nie może jej skasować).
  local snippet="$SANDBOX/t-ob.sh" bin="$SANDBOX/stub-bin-ob" log="$SANDBOX/npm.log" out rc
  mkdir -p "$bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/ob"
  chmod +x "$bin/ob"
  cat > "$snippet" <<EOF
export PATH="$bin:\$PATH"
npm() { echo "NPM \$*" >> "$log"; }
install_ob
echo "STACK=[\${ROLLBACK_STACK[*]-}]"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$log" ] && [[ "$out" == *"STACK=[]"* ]]; then
    pass "install_ob: ob obecny przed runem → zero npm i pusty stos rollbacku"
  else
    problem "install_ob: guard-skip/rollback zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # Instalacja w TYM runie: ob nieobecny (restrykcyjny PATH), stub npm
  # materializuje binarkę → rollback npm rm na stosie PO udanej weryfikacji.
  local bin2="$SANDBOX/stub-bin-ob-run" out2 rc2
  mkdir -p "$bin2"
  ln -sf "$(command -v tail)" "$bin2/tail"
  ln -sf "$(command -v chmod)" "$bin2/chmod"
  cat > "$snippet" <<EOF
export PATH="$bin2"
npm() { printf '#!/usr/bin/env bash\nexit 0\n' > "$bin2/ob"; chmod +x "$bin2/ob"; }
install_ob
echo "STACK=[\${ROLLBACK_STACK[*]-}]"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -eq 0 ] && [[ "$out2" == *"STACK=[npm rm -g obsidian-headless]"* ]]; then
    pass "install_ob: zainstalowany w tym runie → rollback npm rm na stosie"
  else
    problem "install_ob: brak rollbacku po instalacji w tym runie (rc=$rc2, output: $out2)"
  fi
  # Error: npm nic nie zainstalowało → weryfikacja po instalacji fail-fast.
  local bin3="$SANDBOX/stub-bin-ob-err" out3 rc3
  mkdir -p "$bin3"
  ln -sf "$(command -v tail)" "$bin3/tail"
  cat > "$snippet" <<EOF
export PATH="$bin3"
npm() { :; }
install_ob
echo "NIEOSIAGALNE"
EOF
  out3="$(run_snippet "$snippet")"
  rc3=$?
  if [ "$rc3" -ne 0 ] && [[ "$out3" == *"brak 'ob'"* ]] && [[ "$out3" != *"NIEOSIAGALNE"* ]]; then
    pass "install_ob: instalacja nie dała binarki → fail-fast"
  else
    problem "install_ob: fail-fast zawiódł (rc=$rc3, output: $out3)"
  fi
}

# --- Test 36: install_tailscale — guard-skip bez curl; brak binarki po instalacji → fail ---
test_install_tailscale() {
  local snippet="$SANDBOX/t-ts.sh" bin="$SANDBOX/stub-bin-ts" log="$SANDBOX/ts-curl.log" out rc
  mkdir -p "$bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/tailscale"
  chmod +x "$bin/tailscale"
  cat > "$snippet" <<EOF
export PATH="$bin:\$PATH"
curl() { echo "CURL \$*" >> "$log"; }
install_tailscale
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$log" ] && [[ "$out" == *"już zainstalowany"* ]]; then
    pass "install_tailscale: tailscale obecny → guard-skip bez pobierania instalatora"
  else
    problem "install_tailscale: guard-skip zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # Error: install.sh (stub curl|sh) nic nie zainstalowało → fail-fast.
  # seq/sleep stubowane, żeby test nie czekał realnych ~12 s pętli daemona.
  local bin2="$SANDBOX/stub-bin-ts-err" log2="$SANDBOX/ts-curl-err.log" out2 rc2
  mkdir -p "$bin2"
  cat > "$snippet" <<EOF
export PATH="$bin2"
curl() { echo "CURL \$*" >> "$log2"; }
sh() { :; }
seq() { :; }
sleep() { :; }
install_tailscale
echo "NIEOSIAGALNE"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -ne 0 ] && [[ "$out2" == *"brak 'tailscale'"* ]] && [[ "$out2" != *"NIEOSIAGALNE"* ]] \
    && grep -q "CURL" "$log2" 2>/dev/null; then
    pass "install_tailscale: instalacja nie dała binarki → fail-fast"
  else
    problem "install_tailscale: fail-fast zawiódł (rc=$rc2, output: $out2)"
  fi
}

# --- Test 37: login_block — wszystkie guardy=zrobione → zero wywołań loginów (pełny resume) ---
test_login_block_full_resume() {
  # R13: re-run po sukcesie przelatuje przez blok bez żadnej pauzy. setup-git
  # i walidacja repo biegną też przy resume (poprzedni run mógł paść między
  # loginem gh a nimi) — ale to automaty, nie loginy; run_login = 0 wywołań.
  local snippet="$SANDBOX/t-lb-resume.sh" log="$SANDBOX/lb-resume.log" out rc
  cat > "$snippet" <<EOF
has_claude_auth() { return 0; }
has_gh_auth() { return 0; }
has_ob_auth() { return 0; }
has_ob_sync() { return 0; }
has_tailscale_ip() { return 0; }
run_login() { echo "RUN_LOGIN \$1" >> "$log"; }
run_as_claude() { echo "RAC \$1" >> "$log"; return 0; }
VAULT_GIT_REPO="https://github.com/user/repo.git"
login_block
echo "PO_BLOKU"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_BLOKU"* ]] \
    && ! grep -q "RUN_LOGIN" "$log" 2>/dev/null \
    && grep -q "RAC gh repo view" "$log" 2>/dev/null; then
    pass "login_block: wszystkie guardy=zrobione → zero loginów, repo zwalidowane (resume)"
  else
    problem "login_block: pełny resume zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 38: guard gh=brak, reszta=zrobione → tylko PAUZA 2 (+ setup-git + walidacja repo) ---
test_login_block_resumes_into_gh() {
  local snippet="$SANDBOX/t-lb-gh.sh" log="$SANDBOX/lb-gh.log" out rc
  cat > "$snippet" <<EOF
has_claude_auth() { return 0; }
has_gh_auth() { return 1; }
has_ob_auth() { return 0; }
has_ob_sync() { return 0; }
has_tailscale_ip() { return 0; }
run_login() { echo "RUN_LOGIN \$1" >> "$log"; }
run_as_claude() { echo "RAC \$1" >> "$log"; return 0; }
VAULT_GIT_REPO="https://github.com/user/repo.git"
login_block
echo "PO_BLOKU"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_BLOKU"* ]] \
    && [ "$(grep -c '^RUN_LOGIN' "$log" 2>/dev/null)" = "1" ] \
    && grep -q "RUN_LOGIN GitHub CLI" "$log" 2>/dev/null \
    && grep -q "RAC gh auth setup-git" "$log" 2>/dev/null \
    && grep -q "RAC gh repo view" "$log" 2>/dev/null; then
    pass "login_block: guard gh=brak → tylko PAUZA 2 + setup-git + walidacja repo"
  else
    problem "login_block: resume w pauzę gh zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 39: walidacja repo — gh repo view fail → ponowne pytanie → drugie podejście z nowym repo ---
test_validate_repo_access_retry() {
  # Retry-in-place (R5): 404 na pierwszym repo → ask_tty (stub jak w t.27)
  # oddaje poprawkę user/dobre → drugi gh repo view przechodzi, VAULT_GIT_REPO
  # znormalizowany do nowego URL-a.
  local snippet="$SANDBOX/t-repo-retry.sh" log="$SANDBOX/repo-retry.log" out rc
  cat > "$snippet" <<EOF
run_as_claude() {
  echo "RAC \$1" >> "$log"
  case "\$1" in
    *zle-repo*) return 1 ;;
    *) return 0 ;;
  esac
}
ask_tty() { printf -v "\$1" '%s' "user/dobre"; }
VAULT_GIT_REPO="https://github.com/user/zle-repo.git"
validate_repo_access
echo "REPO=\$VAULT_GIT_REPO"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"REPO=https://github.com/user/dobre.git"* ]] \
    && [ "$(grep -c '^RAC gh repo view' "$log" 2>/dev/null)" = "2" ] \
    && grep -q "zle-repo" "$log" && grep -q "user/dobre" "$log"; then
    pass "validate_repo_access: fail → ponowne pytanie → drugie podejście z nowym repo"
  else
    problem "validate_repo_access: retry zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 40: rollback-stos nietknięty przy halt_leave_partial w środku bloku ---
test_login_block_halt_keeps_stack() {
  # PAUZA 1 pada 3× (guard=brak, verify w kółko fail) → halt_leave_partial.
  # Stos automatów sprzed bloku NIE może być odwinięty (R6/R7: leave-partial,
  # nigdy rollback). login_cmd_as_claude stubowany — test nie odpala su.
  local snippet="$SANDBOX/t-lb-halt.sh" log="$SANDBOX/lb-halt.log" out rc
  cat > "$snippet" <<EOF
trap on_err ERR
push_rollback "echo cofniete >> '$log'"
has_claude_auth() { return 1; }
login_cmd_as_claude() { printf ':'; }
login_block
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" == *"ZATRZYMANA"* ]] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [ ! -s "$log" ]; then
    pass "login_block: halt_leave_partial w środku bloku → rollback-stos nietknięty"
  else
    problem "login_block: halt w bloku odwinął stos lub nie zatrzymał (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 41: --only-puls → pauzy 3–4 (ob) pomijane; pełny tryb → wywoływane ---
test_login_block_only_puls_skips_ob_pauses() {
  # Guardy ob mówią "brak" w obu wariantach — różnicę robi WYŁĄCZNIE flaga.
  local snippet="$SANDBOX/t-lb-onlypuls.sh" log="$SANDBOX/lb-op.log" log2="$SANDBOX/lb-full.log" out out2
  cat > "$snippet" <<EOF
has_claude_auth() { return 0; }
has_gh_auth() { return 0; }
has_ob_auth() { return 1; }
has_ob_sync() { return 1; }
has_tailscale_ip() { return 0; }
run_login() { echo "RUN_LOGIN \$1" >> "$log"; }
run_as_claude() { return 0; }
OB_EMAIL="kursant@example.com"; VAULT_NAME="Moj Vault"; DEVICE_NAME="vps-test"
FLAG_ONLY_PULS=1
login_block
echo "PO_BLOKU"
EOF
  out="$(run_snippet "$snippet")"
  cat > "$snippet" <<EOF
has_claude_auth() { return 0; }
has_gh_auth() { return 0; }
has_ob_auth() { return 1; }
has_ob_sync() { return 1; }
has_tailscale_ip() { return 0; }
run_login() { echo "RUN_LOGIN \$1" >> "$log2"; }
run_as_claude() { return 0; }
OB_EMAIL="kursant@example.com"; VAULT_NAME="Moj Vault"; DEVICE_NAME="vps-test"
FLAG_ONLY_PULS=0
login_block
echo "PO_BLOKU"
EOF
  out2="$(run_snippet "$snippet")"
  if [[ "$out" == *"PO_BLOKU"* ]] && [ ! -s "$log" ] \
    && [[ "$out2" == *"PO_BLOKU"* ]] \
    && grep -q "RUN_LOGIN Obsidian (ob login)" "$log2" 2>/dev/null \
    && grep -q "RUN_LOGIN Obsidian Sync" "$log2" 2>/dev/null; then
    pass "login_block: --only-puls pomija pauzy ob; pełny tryb je wywołuje"
  else
    problem "login_block: pomijanie pauz ob zawiodło (log-op: $(cat "$log" 2>/dev/null), log-full: $(cat "$log2" 2>/dev/null))"
  fi
}

# --- Test 42: login_cmd_as_claude — roundtrip dwóch poziomów parsowania (%q) ---
test_login_cmd_as_claude_quoting_roundtrip() {
  # Injection-krytyczna granica user-input→shell (review fazy 4, P2-1):
  # bash -c "$login_cmd" parsuje słowa komendy su (poziom 1), potem shell
  # usera claude parsuje argument -c (poziom 2). Wartość ze spacją,
  # apostrofem, średnikiem i $() musi po OBU poziomach oddać oryginał —
  # usunięcie któregokolwiek %q = brak L1_OK/L2_OK.
  local snippet="$SANDBOX/t-quoting.sh" log="$SANDBOX/quoting.log" out
  cat > "$snippet" <<EOF
LOG='$log'
EOF
  cat >> "$snippet" <<'EOF'
nasty="O'Brien Vault; \$(echo INJ)"
inner="ob login --email $(printf '%q' "$nasty")"
cmd="$(login_cmd_as_claude "$inner")"
# Poziom 1: jak bash -c "$login_cmd" w run_login — słowa komendy su.
eval "set -- $cmd"
if [ "$1" = "su" ] && [ "$4" = "-c" ] && [ "$5" = "$inner" ]; then
  echo "L1_OK" >> "$LOG"
fi
# Poziom 2: shell usera claude parsuje argument -c.
ob() { if [ "$3" = "$nasty" ]; then echo "L2_OK" >> "$LOG"; fi; }
eval "$5"
EOF
  out="$(run_snippet "$snippet")"
  if grep -q "L1_OK" "$log" 2>/dev/null && grep -q "L2_OK" "$log" 2>/dev/null \
    && ! grep -q "^INJ$" "$log" 2>/dev/null; then
    pass "login_cmd_as_claude: wartość ze spacją/'/;/\$() przeżywa dwa poziomy parsowania"
  else
    problem "login_cmd_as_claude: escapowanie %q NIE oddaje oryginału (log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 43: login_ob / login_ob_sync — inner %q chroni OB_EMAIL/VAULT_NAME/DEVICE_NAME ---
test_login_ob_commands_survive_double_parsing() {
  # Przechwytujemy KOMENDY budowane przez login_ob/login_ob_sync (nie fakt
  # wywołania) i parsujemy je jak produkcja: poziom 1 bash -c, poziom 2 shell
  # usera claude. Wartości z $() / średnikiem / apostrofem muszą trafić do ob
  # jako JEDEN argument równy oryginałowi — regresja %q = brak *_OK w logu.
  local snippet="$SANDBOX/t-ob-quoting.sh" log="$SANDBOX/ob-quoting.log" out
  cat > "$snippet" <<EOF
LOG='$log'
EOF
  cat >> "$snippet" <<'EOF'
has_ob_auth() { return 1; }
has_ob_sync() { return 1; }
print_pause_header() { :; }
OB_EMAIL='obrien$(echo INJ)@example.pl'
VAULT_NAME="Moj Vault; echo INJ"
DEVICE_NAME="vps'owy dev"
declare -a CMDS=()
run_login() { CMDS+=("$2"); }
login_ob
login_ob_sync
ob() {
  case "$1" in
    login) if [ "$3" = "$OB_EMAIL" ]; then echo "OB_LOGIN_OK" >> "$LOG"; fi ;;
    sync-setup) if [ "$3" = "$VAULT_NAME" ] && [ "$7" = "$DEVICE_NAME" ]; then echo "OB_SYNC_OK" >> "$LOG"; fi ;;
  esac
}
for cmd in "${CMDS[@]}"; do
  eval "set -- $cmd"
  eval "$5"
done
EOF
  out="$(run_snippet "$snippet")"
  if grep -q "OB_LOGIN_OK" "$log" 2>/dev/null && grep -q "OB_SYNC_OK" "$log" 2>/dev/null; then
    pass "login_ob/login_ob_sync: OB_EMAIL/VAULT_NAME/DEVICE_NAME oddane 1:1 po dwóch poziomach parsowania"
  else
    problem "login_ob/login_ob_sync: inner %q NIE chroni wartości usera (log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 44: validate_repo_access — repo z metaznakami przechodzi %q do gh jako jeden argument ---
test_validate_repo_access_repo_quoted() {
  # run_as_claude robi su -c "$1" → JEDEN poziom parsowania w shellu usera.
  # Repo ze spacją/średnikiem/$() musi dojść do gh jako pojedynczy argument
  # równy VAULT_GIT_REPO bez sufiksu .git.
  local snippet="$SANDBOX/t-repo-quoting.sh" log="$SANDBOX/repo-quoting.log" out
  cat > "$snippet" <<EOF
LOG='$log'
EOF
  cat >> "$snippet" <<'EOF'
VAULT_GIT_REPO='user/re po;$(echo INJ).git'
expected="${VAULT_GIT_REPO%.git}"
captured=""
run_as_claude() { captured="$1"; return 0; }
validate_repo_access
gh() {
  if [ "$1" = "repo" ] && [ "$2" = "view" ] && [ "$3" = "$expected" ]; then
    echo "REPO_OK" >> "$LOG"
  fi
}
eval "$captured"
EOF
  out="$(run_snippet "$snippet")"
  if grep -q "REPO_OK" "$log" 2>/dev/null; then
    pass "validate_repo_access: repo z metaznakami dociera do gh jako jeden argument (bez .git)"
  else
    problem "validate_repo_access: %q NIE chroni VAULT_GIT_REPO (log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 45: build_puls_env_lines — WORKSPACE/PORT/PATH; bez DISCORD_WEBHOOK_URL ---
test_build_puls_env_lines() {
  # Kontrakt z lib/config.js: CLAUDE_CRON_PORT / CLAUDE_CRON_WORKSPACE;
  # PATH musi zawierać ~/.local/bin (natywny Claude CLI).
  # DISCORD_WEBHOOK_URL nie ma prawa się tu pojawić niezależnie od env —
  # powiadomienia idą pushem z lokalnego setupu, nie z instalatora VPS.
  # WEBHOOK_BASE_URL nie ma prawa się tu pojawić (Funnel = Faza 6).
  local snippet="$SANDBOX/t-env-lines.sh" out
  cat > "$snippet" <<'EOF'
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/1/a"
build_puls_env_lines "/home/claude/vault" "7777" "/home/claude"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"Environment=CLAUDE_CRON_PORT=7777"* ]] \
    && [[ "$out" == *"Environment=CLAUDE_CRON_WORKSPACE=/home/claude/vault"* ]] \
    && [[ "$out" == *"Environment=PATH=/home/claude/.local/bin:/home/claude/.npm-global/bin:"* ]] \
    && [[ "$out" != *"DISCORD_WEBHOOK_URL"* ]] \
    && [[ "$out" != *"WEBHOOK_BASE_URL"* ]]; then
    pass "build_puls_env_lines: WORKSPACE/PORT/PATH zawsze; bez DISCORD_WEBHOOK_URL i WEBHOOK_BASE_URL"
  else
    problem "build_puls_env_lines: złe linie Environment (output: $out)"
  fi
}

# --- Test 46: build_obsidian_sync_unit — Restart=always, User=claude, vault, lock cleanup ---
test_build_obsidian_sync_unit() {
  local snippet="$SANDBOX/t-ob-unit.sh" out
  cat > "$snippet" <<'EOF'
build_obsidian_sync_unit "/usr/local/bin/ob" "/home/claude/vault"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"Restart=always"* ]] \
    && [[ "$out" == *"User=claude"* ]] \
    && [[ "$out" == *"ExecStart=/usr/local/bin/ob sync --path /home/claude/vault --continuous"* ]] \
    && [[ "$out" == *"ExecStartPre=/bin/rm -rf /home/claude/vault/.obsidian/.sync.lock"* ]]; then
    pass "build_obsidian_sync_unit: Restart=always, User=claude, ścieżka vaulta, lock cleanup"
  else
    problem "build_obsidian_sync_unit: brakuje wymaganych linii unitu (output: $out)"
  fi
}

# --- Test 47: weryfikacja file-types — bez 'unsupported' → fail; z → pass; sync-config PRZED sync-status ---
test_configure_obsidian_file_types() {
  # Czysta funkcja: parsowanie wyjścia sync-status (atrapy formatu z przewodnika).
  local snippet="$SANDBOX/t-ft.sh" log="$SANDBOX/ft.log" out rc out2 rc2
  cat > "$snippet" <<'EOF'
rc_no=0; verify_ob_file_types "File types: image, audio, video, pdf" || rc_no=$?
rc_yes=0; verify_ob_file_types "$(printf 'Vault: moj\nFile types: image, audio, video, pdf, unsupported\n')" || rc_yes=$?
echo "NO=$rc_no YES=$rc_yes"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"NO=1 YES=0"* ]]; then
    pass "verify_ob_file_types: wyjście bez 'unsupported' → fail; z → pass"
  else
    problem "verify_ob_file_types: złe rozpoznanie (output: $out)"
  fi
  # Fail-fast całej funkcji: sync-status (stub run_as_claude) nie potwierdza
  # 'unsupported' → fail; sync-config MUSI polecieć PRZED sync-status.
  cat > "$snippet" <<EOF
run_as_claude() {
  echo "RAC \$1" >> "$log"
  case "\$1" in *sync-status*) echo "File types: image, audio, video, pdf" ;; esac
  return 0
}
configure_obsidian_file_types
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" == *"unsupported"* ]] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [[ "$(sed -n 1p "$log")" == *"sync-config"* ]] \
    && [[ "$(sed -n 2p "$log")" == *"sync-status"* ]]; then
    pass "configure_obsidian_file_types: brak 'unsupported' w sync-status → fail; sync-config przed sync-status"
  else
    problem "configure_obsidian_file_types: fail-fast/kolejność zawiodły (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # Happy path: sync-status potwierdza → exit 0.
  cat > "$snippet" <<EOF
run_as_claude() {
  case "\$1" in *sync-status*) echo "File types: image, audio, video, pdf, unsupported" ;; esac
  return 0
}
configure_obsidian_file_types
echo "PO_KONFIGU"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -eq 0 ] && [[ "$out2" == *"PO_KONFIGU"* ]]; then
    pass "configure_obsidian_file_types: sync-status z 'unsupported' → sukces"
  else
    problem "configure_obsidian_file_types: happy path zawiódł (rc=$rc2, output: $out2)"
  fi
}

# --- Test 48: symlink .claude idempotentny — drugi run nie failuje, cel bez zmian ---
test_link_vault_claude_idempotent() {
  # run_as_claude wykonuje lokalnie (DI jak w t.23) — komenda ln używa
  # absolutnych ścieżek po %q, więc nie potrzebuje home usera claude.
  local snippet="$SANDBOX/t-symlink.sh" home="$SANDBOX/home-sym" out rc
  mkdir -p "$home/vault-git/.claude" "$home/vault"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$home"
run_as_claude() { bash -c "\$1"; }
link_vault_claude
t1="\$(readlink "$home/vault/.claude")"
link_vault_claude
t2="\$(readlink "$home/vault/.claude")"
echo "T1=[\$t1] T2=[\$t2]"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [ -L "$home/vault/.claude" ] \
    && [[ "$out" == *"T1=[$home/vault-git/.claude] T2=[$home/vault-git/.claude]"* ]]; then
    pass "link_vault_claude: idempotentny — drugi run bez błędu, cel symlinku bez zmian"
  else
    problem "link_vault_claude: symlink nie-idempotentny (rc=$rc, output: $out)"
  fi
}

# --- Test 48b: link_vault_claude — REALNY katalog .claude (cudzy stan) → backup, nie ERR/rollback ---
test_link_vault_claude_foreign_dir_backup() {
  # Pozostałość po starym instalatorze: ~/vault/.claude jako katalog.
  # Bez guardu `ln -sfn` failuje ("cannot overwrite directory") → trap ERR
  # → rollback całego runu. Oczekiwane: backup-mv (wzorzec setup_vault_git).
  local snippet="$SANDBOX/t-symlink-dir.sh" home="$SANDBOX/home-sym-dir" out rc
  mkdir -p "$home/vault-git/.claude" "$home/vault/.claude"
  echo "stare-skille" > "$home/vault/.claude/relikt.md"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$home"
run_as_claude() { bash -c "\$1"; }
link_vault_claude
echo "TARGET=[\$(readlink "$home/vault/.claude")]"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [ -L "$home/vault/.claude" ] \
    && [[ "$out" == *"TARGET=[$home/vault-git/.claude]"* ]] \
    && ls "$home"/vault/.claude.backup.*/relikt.md >/dev/null 2>&1; then
    pass "link_vault_claude: realny katalog .claude → kopia zapasowa + symlink (bez ERR)"
  else
    problem "link_vault_claude: cudzy katalog .claude nieobsłużony (rc=$rc, output: $out)"
  fi
}

# --- Test 49: setup_vault_git — clone sparse przy braku; .git + zgodny origin → git pull; non-git → backup ---
test_setup_vault_git_guard() {
  # Atrapa run_as_claude symuluje realny kontrakt gita: clone materializuje
  # vault-git/.claude (post-condition), a `remote get-url origin` odpowiada
  # skonfigurowanym repo (zgodny origin → gałąź pull).
  local snippet="$SANDBOX/t-vg.sh" log="$SANDBOX/vg.log" home="$SANDBOX/home-vg" out rc
  mkdir -p "$home"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$home"
VAULT_GIT_REPO="https://github.com/user/repo.git"
run_as_claude() {
  echo "RAC \$1" >> "$log"
  case "\$1" in
    *"remote get-url origin"*) echo "https://github.com/user/repo.git" ;;
    *"git clone"*) mkdir -p "$home/vault-git/.claude" ;;
  esac
  return 0
}
setup_vault_git
mkdir -p "$home/vault-git/.git"
setup_vault_git
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] \
    && [[ "$(sed -n 1p "$log")" == *"git clone --filter=blob:none --sparse"* ]] \
    && [[ "$(sed -n 1p "$log")" == *"https://github.com/user/repo.git"* ]] \
    && [[ "$(sed -n 1p "$log")" == *"git sparse-checkout set .claude"* ]] \
    && [[ "$(sed -n 2p "$log")" == *"remote get-url origin"* ]] \
    && [[ "$(sed -n 3p "$log")" == *"git pull"* ]] \
    && [[ "$(sed -n 3p "$log")" != *"git clone"* ]]; then
    pass "setup_vault_git: brak repo → clone sparse .claude; .git + zgodny origin → git pull"
  else
    problem "setup_vault_git: zły guard clone/pull (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # Katalog bez .git = cudzy stan → kopia zapasowa, potem clone (wzorzec clone_repo).
  local log2="$SANDBOX/vg2.log" out2 rc2
  rm -rf "$home/vault-git" "$home"/vault-git.backup.*
  mkdir -p "$home/vault-git/costam"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$home"
VAULT_GIT_REPO="https://github.com/user/repo.git"
run_as_claude() {
  echo "RAC \$1" >> "$log2"
  case "\$1" in *"git clone"*) mkdir -p "$home/vault-git/.claude" ;; esac
  return 0
}
setup_vault_git
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  # Stary katalog (z 'costam') poszedł do backupu, a nowy vault-git to świeży
  # clone atrapy — zawiera już tylko .claude.
  if [ "$rc2" -eq 0 ] && [ ! -d "$home/vault-git/costam" ] \
    && ls -d "$home"/vault-git.backup.*/costam >/dev/null 2>&1 \
    && [ -d "$home/vault-git/.claude" ] \
    && grep -q "git clone" "$log2" 2>/dev/null; then
    pass "setup_vault_git: katalog bez .git → kopia zapasowa + clone"
  else
    problem "setup_vault_git: backup non-git zawiódł (rc=$rc2, log: $(cat "$log2" 2>/dev/null), output: $out2)"
  fi
}

# --- Test 49b: setup_vault_git — post-condition: repo bez .claude → fail-fast (bez cichego sukcesu) ---
test_setup_vault_git_postcondition() {
  # Atrapa git NIE tworzy .claude (repo usera bez tego katalogu) —
  # `git sparse-checkout set .claude` przechodzi mimo braku ścieżki w repo,
  # więc bez post-condition instalator raportowałby sukces z wiszącym
  # symlinkiem (skille nigdy nie docierają do vaulta).
  local snippet="$SANDBOX/t-vg-post.sh" home="$SANDBOX/home-vg-post" out rc
  mkdir -p "$home"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$home"
VAULT_GIT_REPO="https://github.com/user/repo.git"
run_as_claude() { case "\$1" in *"git clone"*) mkdir -p "$home/vault-git" ;; esac; return 0; }
setup_vault_git
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" == *".claude"* ]] && [[ "$out" != *"NIEOSIAGALNE"* ]]; then
    pass "setup_vault_git: clone bez .claude → fail-fast (post-condition), nie cichy sukces"
  else
    problem "setup_vault_git: brak fail-fast przy repo bez .claude (rc=$rc, output: $out)"
  fi
}

# --- Test 49c: setup_vault_git — origin mismatch przy re-runie → backup + re-clone z NOWEGO repo ---
test_setup_vault_git_origin_mismatch() {
  # Istniejący vault-git wskazuje INNE repo niż aktualny VAULT_GIT_REPO
  # (collect_config pyta o repo przy każdym runie) — pull ze starego origin
  # ciągnąłby skille z niezweryfikowanego źródła. Oczekiwane: backup + clone.
  local snippet="$SANDBOX/t-vg-origin.sh" log="$SANDBOX/vg-origin.log" home="$SANDBOX/home-vg-origin" out rc
  mkdir -p "$home/vault-git/.git"
  cat > "$snippet" <<EOF
CLAUDE_HOME="$home"
VAULT_GIT_REPO="https://github.com/user/NOWE-repo.git"
run_as_claude() {
  echo "RAC \$1" >> "$log"
  case "\$1" in
    *"remote get-url origin"*) echo "https://github.com/user/STARE-repo.git" ;;
    *"git clone"*) mkdir -p "$home/vault-git/.claude" ;;
  esac
  return 0
}
setup_vault_git
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] \
    && ls -d "$home"/vault-git.backup.*/.git >/dev/null 2>&1 \
    && grep -q "git clone" "$log" 2>/dev/null \
    && grep -q "NOWE-repo.git" "$log" 2>/dev/null \
    && [[ "$(cat "$log")" != *"git pull"* ]] \
    && [[ "$out" == *"różni się"* ]]; then
    pass "setup_vault_git: origin mismatch → warn + backup starego repo + clone z nowego (bez pull)"
  else
    problem "setup_vault_git: origin mismatch nieobsłużony (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 50: main() — sync-config PRZED enable obsidian-sync; --only-puls pomija blok Obsidian ---
test_main_obsidian_order_and_skip() {
  # Kolejność twarda (spec FAZA 4): config czytany przy starcie procesu sync,
  # więc configure_obsidian_file_types MUSI poprzedzać create_obsidian_sync_service
  # (w którym siedzi `systemctl enable --now obsidian-sync`).
  local snippet="$SANDBOX/t-ob-order.sh" out calls pos_cfg pos_svc out2
  write_recorder_snippet "$snippet" ""
  out="$(run_snippet "$snippet")"
  calls="$(grep '^CALL ' <<<"$out" || true)"
  pos_cfg="$(grep -n '^CALL configure_obsidian_file_types$' <<<"$calls" | cut -d: -f1)"
  pos_svc="$(grep -n '^CALL create_obsidian_sync_service$' <<<"$calls" | cut -d: -f1)"
  if [ -n "$pos_cfg" ] && [ -n "$pos_svc" ] && [ "$pos_cfg" -lt "$pos_svc" ] \
    && grep -q '^CALL setup_vault_git$' <<<"$calls" \
    && grep -q '^CALL link_vault_claude$' <<<"$calls"; then
    pass "main(): configure_obsidian_file_types PRZED create_obsidian_sync_service (+ vault-git/symlink obecne)"
  else
    problem "main(): zła kolejność bloku Obsidian (cfg=$pos_cfg svc=$pos_svc, calls: $calls)"
  fi
  write_recorder_snippet "$snippet" "--only-puls"
  out2="$(run_snippet "$snippet")"
  if [[ "$out2" != *"CALL configure_obsidian_file_types"* ]] \
    && [[ "$out2" != *"CALL setup_vault_git"* ]] \
    && [[ "$out2" != *"CALL link_vault_claude"* ]] \
    && [[ "$out2" != *"CALL create_obsidian_sync_service"* ]] \
    && [[ "$out2" == *"CALL create_systemd_service"* ]]; then
    pass "main --only-puls: cały blok Obsidian pominięty, unit Pulsa tworzony"
  else
    problem "main --only-puls: blok Obsidian NIE został pominięty (output: $out2)"
  fi
}

# --- Test 51: rollback unit-plików TYLKO gdy utworzone w tym runie ---
test_unit_rollback_only_when_created() {
  # Kontrakt jak userdel/npm rm (t.31/35): istniejący unit sprzed runa to
  # cudzy stan — ERR w późniejszym kroku nie może go skasować.
  local snippet="$SANDBOX/t-unit-rb.sh" sysd="$SANDBOX/systemd" bin="$SANDBOX/stub-bin-unit" out rc
  mkdir -p "$sysd" "$bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/ob"
  chmod +x "$bin/ob"
  cat > "$snippet" <<EOF
export PATH="$bin:\$PATH"
SYSTEMD_DIR="$sysd"
CLAUDE_HOME="/home/claude"
systemctl() { :; }
create_obsidian_sync_service
echo "STACK_A=[\${ROLLBACK_STACK[*]-}]"
ROLLBACK_STACK=()
create_obsidian_sync_service
echo "STACK_B=[\${ROLLBACK_STACK[*]-}]"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [ -f "$sysd/obsidian-sync.service" ] \
    && [[ "$out" == *"STACK_A=[systemctl disable --now obsidian-sync"* ]] \
    && [[ "$out" == *"rm -f '$sysd/obsidian-sync.service'"* ]] \
    && [[ "$out" == *"STACK_B=[]"* ]]; then
    pass "create_obsidian_sync_service: rollback unitu tylko przy utworzeniu w tym runie"
  else
    problem "create_obsidian_sync_service: zła rejestracja rollbacku (rc=$rc, output: $out)"
  fi
  # To samo dla unitu Pulsa (claude-cron).
  local sysd2="$SANDBOX/systemd-puls" out2 rc2
  mkdir -p "$sysd2"
  cat > "$snippet" <<EOF
SYSTEMD_DIR="$sysd2"
CLAUDE_HOME="/home/claude"
WORKSPACE="/home/claude/vault"
PORT=7777
INSTALL_DIR="/home/claude/claude-cron"
systemctl() { :; }
sleep() { :; }
create_systemd_service
echo "STACK_A=[\${ROLLBACK_STACK[*]-}]"
ROLLBACK_STACK=()
create_systemd_service
echo "STACK_B=[\${ROLLBACK_STACK[*]-}]"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -eq 0 ] && [ -f "$sysd2/claude-cron.service" ] \
    && [[ "$out2" == *"STACK_A=[systemctl disable --now claude-cron"* ]] \
    && [[ "$out2" == *"STACK_B=[]"* ]] \
    && grep -q "Environment=CLAUDE_CRON_WORKSPACE=/home/claude/vault" "$sysd2/claude-cron.service" \
    && ! grep -q "WEBHOOK_BASE_URL" "$sysd2/claude-cron.service"; then
    pass "create_systemd_service: rollback unitu Pulsa tylko przy utworzeniu; unit bez WEBHOOK_BASE_URL"
  else
    problem "create_systemd_service: zła rejestracja rollbacku/treść unitu (rc=$rc2, output: $out2)"
  fi
}

# --- Test 51b: create_obsidian_sync_service — re-run RESTARTUJE serwis (nowy sync-config/unit wchodzi w życie) ---
test_obsidian_sync_service_restart_on_rerun() {
  # `systemctl enable --now` NIE restartuje działającego serwisu — przy
  # re-runie nowy sync-config (czytany przy starcie procesu sync) i nadpisany
  # unit nie weszłyby w życie mimo raportu OK. Rejestrator systemctl asertuje
  # restart po zapisie unitu (symetria z unitem Pulsa).
  local snippet="$SANDBOX/t-ob-restart.sh" log="$SANDBOX/ob-restart.log" sysd="$SANDBOX/systemd-restart" bin="$SANDBOX/stub-bin-restart" out rc
  mkdir -p "$sysd" "$bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/ob"
  chmod +x "$bin/ob"
  cat > "$snippet" <<EOF
export PATH="$bin:\$PATH"
SYSTEMD_DIR="$sysd"
CLAUDE_HOME="/home/claude"
systemctl() { echo "SYSTEMCTL \$*" >> "$log"; }
create_obsidian_sync_service
echo "---RERUN---" >> "$log"
create_obsidian_sync_service
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  local rerun_log
  rerun_log="$(sed -n '/---RERUN---/,$p' "$log" 2>/dev/null)"
  if [ "$rc" -eq 0 ] \
    && grep -q "SYSTEMCTL enable obsidian-sync" <<<"$rerun_log" \
    && grep -q "SYSTEMCTL restart obsidian-sync" <<<"$rerun_log" \
    && grep -q "SYSTEMCTL daemon-reload" <<<"$rerun_log"; then
    pass "create_obsidian_sync_service: re-run → daemon-reload + enable + restart (unit/config wchodzą w życie)"
  else
    problem "create_obsidian_sync_service: re-run bez restartu serwisu (rc=$rc, log: $(cat "$log" 2>/dev/null))"
  fi
}

# --- Test 52: build_cron_cmd — prefix 02:00, ścieżki ze spacją przez %q, --only-puls bez vault-git ---
test_build_cron_cmd() {
  # Roundtrip jak w produkcji (konwencja review f5: treść komendy, nie kształt):
  # linia crontaba → eval (stub su łapie argument -c) → eval inner (stuby
  # cd/git/bash weryfikują, że ścieżka ze spacją dociera jako JEDEN argument).
  local snippet="$SANDBOX/t-cron-cmd.sh" log="$SANDBOX/cron-cmd.log" \
    vg="$SANDBOX/va ult-git" id="$SANDBOX/cl audecron" out
  mkdir -p "$id"
  cat > "$snippet" <<EOF
LOG='$log'
VG='$vg'
ID='$id'
EOF
  cat >> "$snippet" <<'EOF'
line="$(build_cron_cmd "$VG" "$ID" "$ID/scripts/cron-node-guard.sh" "$ID/update.log" 0)"
case "$line" in "0 2 * * * "*) echo "PREFIX_OK" >> "$LOG" ;; esac
cmd="${line#"0 2 * * * "}"
su() { SU_INNER="$4"; }
systemctl() { echo "SC:$*" >> "$LOG"; }
eval "$cmd"
cd() { echo "CD:$1" >> "$LOG"; }
git() { echo "GIT:$*" >> "$LOG"; }
bash() { echo "BASH:$1" >> "$LOG"; }
eval "$SU_INNER"
line_op="$(build_cron_cmd "$VG" "$ID" "$ID/scripts/cron-node-guard.sh" "$ID/update.log" 1)"
case "$line_op" in *"ult-git"*) echo "OP_HAS_VG" >> "$LOG" ;; esac
EOF
  out="$(run_snippet "$snippet")"
  if grep -q "PREFIX_OK" "$log" 2>/dev/null \
    && grep -q "CD:$vg" "$log" \
    && grep -q "CD:$id" "$log" \
    && [ "$(grep -c '^GIT:pull' "$log")" = "2" ] \
    && grep -q "BASH:$id/scripts/cron-node-guard.sh" "$log" \
    && grep -q "SC:restart claude-cron" "$log" \
    && ! grep -q "OP_HAS_VG" "$log"; then
    pass "build_cron_cmd: 02:00 + ścieżki ze spacją jako jeden argument; --only-puls bez segmentu vault-git"
  else
    problem "build_cron_cmd: złe cytowanie/segmenty (log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
}

# --- Test 53: setup_auto_update — --no-auto-update → cron nie instalowany; pełny → sudoers + guard + cron ---
test_setup_auto_update() {
  local snippet="$SANDBOX/t-au.sh" log="$SANDBOX/au.log" cronfile="$SANDBOX/au-cronfile" \
    sudoers="$SANDBOX/au-sudoers" install="$SANDBOX/au-install" home="$SANDBOX/au-home" out rc out2 rc2
  mkdir -p "$sudoers" "$install/scripts" "$home"
  cat > "$snippet" <<EOF
FLAG_NO_AUTO_UPDATE=1
crontab() { echo "CRONTAB \$*" >> "$log"; }
setup_auto_update
echo "PO_SKIP"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"pominięty"* ]] && [[ "$out" == *"PO_SKIP"* ]] && [ ! -s "$log" ]; then
    pass "setup_auto_update: --no-auto-update → cron w ogóle nie instalowany (zero wywołań crontab)"
  else
    problem "setup_auto_update: opt-out zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # Pełny przebieg w sandboxie (SUDOERS_DIR/INSTALL_DIR przez DI, crontab jako
  # atrapa plikowa — asercje TREŚCI: NOPASSWD, progi guardu, linia 02:00).
  cat > "$snippet" <<EOF
SUDOERS_DIR="$sudoers"
INSTALL_DIR="$install"
CLAUDE_HOME="$home"
FLAG_NO_AUTO_UPDATE=0
FLAG_ONLY_PULS=0
CRONFILE="$cronfile"
crontab() {
  case "\$1" in
    -l) if [ -f "\$CRONFILE" ]; then cat "\$CRONFILE"; else return 1; fi ;;
    -)  cat > "\$CRONFILE" ;;
  esac
}
chown() { :; }
setup_auto_update
echo "STACK=[\${ROLLBACK_STACK[*]-}]"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -eq 0 ] \
    && grep -q "NOPASSWD: /usr/bin/systemctl restart claude-cron" "$sudoers/claude-cron" 2>/dev/null \
    && [ -x "$install/scripts/cron-node-guard.sh" ] \
    && grep -q "MIN_NODE_MAJOR=22" "$install/scripts/cron-node-guard.sh" \
    && grep -q "MIN_NODE_MINOR=13" "$install/scripts/cron-node-guard.sh" \
    && grep -q "^0 2 \* \* \* su - claude -c" "$cronfile" \
    && grep -q "vault-git" "$cronfile" \
    && [[ "$out2" == *"rm -f '$sudoers/claude-cron'"* ]]; then
    pass "setup_auto_update: sudoers NOPASSWD + node-guard (progi 22.13) + cron 02:00 z vault-git; rollback sudoers na stosie"
  else
    problem "setup_auto_update: pełny przebieg zawiódł (rc=$rc2, cron: $(cat "$cronfile" 2>/dev/null), output: $out2)"
  fi
}

# --- Test 54: plik-dowód — build_welcome_note (treść PL) + create_welcome_note (zapis przez run_as_claude) ---
test_welcome_note() {
  local snippet="$SANDBOX/t-note.sh" home="$SANDBOX/home-note" out rc out2 rc2
  mkdir -p "$home/vault"
  echo 'build_welcome_note' > "$snippet"
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"# 🎉 Twój asystent w chmurze działa!"* ]] \
    && [[ "$out" == *"Obsidian Sync"* ]]; then
    pass "build_welcome_note: nagłówek + polska treść dowodu"
  else
    problem "build_welcome_note: zła treść (rc=$rc, output: $out)"
  fi
  # Zapis przez run_as_claude (stub z podmienionym HOME — `~/vault` rozwija
  # się w shellu atrapy) + komunikat „otwórz Obsidiana na telefonie".
  cat > "$snippet" <<EOF
run_as_claude() { HOME="$home" bash -c "\$1"; }
create_welcome_note
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -eq 0 ] && [[ "$out2" == *"telefonie"* ]] && [[ "$out2" == *"Witaj z VPS"* ]] \
    && grep -q "asystent w chmurze" "$home/vault/Witaj-z-VPS.md" 2>/dev/null; then
    pass "create_welcome_note: notatka w vaulcie + komunikat o telefonie"
  else
    problem "create_welcome_note: zapis/komunikat zawiódł (rc=$rc2, output: $out2)"
  fi
}

# --- Test 55: print_summary — bez Funnela adnotacja o lekcji bez webhooków; z Funnelem sekcja webhooków ---
test_print_summary_funnel_variants() {
  local snippet="$SANDBOX/t-summary.sh" out out2
  cat > "$snippet" <<'EOF'
TS_IP="100.64.0.1"; PORT=7777; WORKSPACE="/home/claude/vault"
INSTALL_DIR="/home/claude/claude-cron"; WEBHOOK_BASE_URL=""
FLAG_ONLY_PULS=0
print_summary
EOF
  out="$(run_snippet "$snippet")"
  cat > "$snippet" <<'EOF'
TS_IP="100.64.0.1"; PORT=7777; WORKSPACE="/home/claude/vault"
INSTALL_DIR="/home/claude/claude-cron"; WEBHOOK_BASE_URL="https://srv.ts.net"
FLAG_ONLY_PULS=0
print_summary
EOF
  out2="$(run_snippet "$snippet")"
  if [[ "$out" == *"lekcji o Pulsie"* ]] && [[ "$out" == *"http://100.64.0.1:7777"* ]] \
    && [[ "$out" != *"/webhook/"* ]] && [[ "$out" == *"ZABLOKOWANY"* ]] \
    && [[ "$out2" == *"https://srv.ts.net/webhook/<token>"* ]] \
    && [[ "$out2" == *"lekcji o Pulsie"* ]]; then
    pass "print_summary: bez Funnela adnotacja o lekcji, zero webhooków; z Funnelem sekcja webhooków"
  else
    problem "print_summary: złe warianty podsumowania (out: $out, out2: $out2)"
  fi
}

# --- Test 56: setup_funnel — N → zero wywołań tailscale; T → funnel --bg + wpis do unitu + restart ---
test_setup_funnel() {
  # N (default bez tty): rejestrator tailscale nie może zobaczyć ŻADNEGO wywołania.
  local snippet="$SANDBOX/t-funnel.sh" log="$SANDBOX/funnel-n.log" out rc
  cat > "$snippet" <<EOF
PORT=7777
tailscale() { echo "TS \$*" >> "$log"; }
setup_funnel
echo "URL=[\$WEBHOOK_BASE_URL]"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$log" ] && [[ "$out" == *"URL=[]"* ]]; then
    pass "setup_funnel: odpowiedź N (default) → zero wywołań tailscale funnel"
  else
    problem "setup_funnel: gałąź N zawiodła (rc=$rc, log: $(cat "$log" 2>/dev/null), output: $out)"
  fi
  # T: funnel --bg + URL z parsera + linia WEBHOOK_BASE_URL przed
  # SyslogIdentifier + daemon-reload/restart; drugi run bez duplikatu linii.
  local log2="$SANDBOX/funnel-t.log" sysd="$SANDBOX/systemd-funnel" out2 rc2
  mkdir -p "$sysd"
  echo "t" > "$SANDBOX/tty-funnel"
  cat > "$sysd/claude-cron.service" <<'UNIT'
[Service]
Environment=CLAUDE_CRON_PORT=7777
StandardOutput=journal
SyslogIdentifier=claude-cron
UNIT
  cat > "$snippet" <<EOF
TTY_DEVICE="$SANDBOX/tty-funnel"
PORT=7777
SYSTEMD_DIR="$sysd"
tailscale() {
  echo "TS \$*" >> "$log2"
  if [ "\$1" = "funnel" ] && [ "\$2" = "status" ]; then echo "https://srv123.tail456.ts.net/"; fi
}
systemctl() { echo "SC \$*" >> "$log2"; }
sleep() { :; }
setup_funnel
setup_funnel
echo "URL=[\$WEBHOOK_BASE_URL]"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  local unit="$sysd/claude-cron.service" pos_env="" pos_sys="" env_count=0
  pos_env="$(grep -n '^Environment=WEBHOOK_BASE_URL=https://srv123.tail456.ts.net$' "$unit" 2>/dev/null | cut -d: -f1)"
  pos_sys="$(grep -n 'SyslogIdentifier' "$unit" 2>/dev/null | cut -d: -f1)"
  env_count="$(grep -c 'WEBHOOK_BASE_URL' "$unit" 2>/dev/null)"
  if [ "$rc2" -eq 0 ] && [[ "$out2" == *"URL=[https://srv123.tail456.ts.net]"* ]] \
    && grep -q "TS funnel --bg 7777" "$log2" 2>/dev/null \
    && grep -q "SC restart claude-cron" "$log2" 2>/dev/null \
    && grep -q "SC daemon-reload" "$log2" 2>/dev/null \
    && [ "$env_count" = "1" ] && [ -n "$pos_env" ] && [ -n "$pos_sys" ] && [ "$pos_env" -lt "$pos_sys" ]; then
    pass "setup_funnel: T → funnel --bg + WEBHOOK_BASE_URL przed SyslogIdentifier + restart; re-run bez duplikatu"
  else
    problem "setup_funnel: gałąź T zawiodła (rc=$rc2, env_count=$env_count, unit: $(cat "$unit" 2>/dev/null), log: $(cat "$log2" 2>/dev/null), output: $out2)"
  fi
}

# --- Test 57: weryfikacja finału — is_sync_complete, pętla pierwszego synca, verify_services ---
test_verify_services_and_sync_wait() {
  local snippet="$SANDBOX/t-sync.sh" cnt="$SANDBOX/sync-cnt" out rc out2 rc2 out3
  # Ground truth z cli.js 0.0.12: `ob sync` loguje "Fully synced" po pełnym
  # przebiegu; "not synced"/"syncing" NIE mogą matchować (fałszywy pozytyw
  # bramki R11 — P3 review fazy 6, potwierdzone w źródłach pakietu).
  cat > "$snippet" <<'EOF'
r_ing=0; is_sync_complete "Removing local-only file x.md" || r_ing=$?
r_ed=0;  is_sync_complete "Fully synced" || r_ed=$?
r_not=0; is_sync_complete "vault not synced" || r_not=$?
echo "ING=$r_ing ED=$r_ed NOT=$r_not"
EOF
  out="$(run_snippet "$snippet")"
  if [[ "$out" == *"ING=1 ED=0 NOT=1"* ]]; then
    pass "is_sync_complete: 'Fully synced' → gotowe; log postępu i 'not synced' → jeszcze nie"
  else
    problem "is_sync_complete: złe rozpoznanie (output: $out)"
  fi
  # Pętla: 3. odczyt journala zwraca 'Fully synced' → sukces bez wyczerpania okna.
  echo 0 > "$cnt"
  cat > "$snippet" <<EOF
sleep() { :; }
journalctl() {
  local c; c=\$(cat "$cnt"); c=\$((c+1)); echo \$c > "$cnt"
  if [ \$c -ge 3 ]; then echo "Fully synced"; else echo "Starting sync:"; fi
}
wait_for_first_sync
echo "PO_SYNC"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  if [ "$rc2" -eq 0 ] && [[ "$out2" == *"Pierwszy sync zakończony"* ]] \
    && [[ "$out2" == *"PO_SYNC"* ]] && [ "$(cat "$cnt")" = "3" ]; then
    pass "wait_for_first_sync: sukces przy 3. odczycie journala serwisu"
  else
    problem "wait_for_first_sync: happy path zawiódł (rc=$rc2, próby=$(cat "$cnt" 2>/dev/null), output: $out2)"
  fi
  # Timeout: sync w kółko trwa → warn (nie fail) + instrukcja; verify_services
  # przy obu serwisach active raportuje oba.
  cat > "$snippet" <<'EOF'
sleep() { :; }
journalctl() { echo "Starting sync:"; }
wait_for_first_sync
echo "PO_TIMEOUT"
FLAG_ONLY_PULS=0
systemctl() { return 0; }
journalctl() { echo "Fully synced"; }
verify_services
EOF
  out3="$(run_snippet "$snippet")"
  if [ "$?" -eq 0 ] && [[ "$out3" == *"PO_TIMEOUT"* ]] && [[ "$out3" == *"jeszcze trwa"* ]] \
    && [[ "$out3" == *"Serwis claude-cron działa"* ]] \
    && [[ "$out3" == *"Serwis obsidian-sync działa"* ]]; then
    pass "wait_for_first_sync: timeout → warn bez faila; verify_services raportuje oba serwisy"
  else
    problem "weryfikacja finału zawiodła (output: $out3)"
  fi
}

# --- Test 58: sekwencja main() fazy 5+6 — auto-update → weryfikacja → dowód → Funnel → podsumowanie ---
test_main_final_phase_order() {
  # Funnel MUSI być NA SAMYM KOŃCU (przed samym podsumowaniem) — spec FAZA 6;
  # plik-dowód pomijany przy --only-puls (decyzja w main(), rejestrator widzi
  # realny brak wywołania).
  local snippet="$SANDBOX/t-final-seq.sh" out calls out2
  write_recorder_snippet "$snippet" ""
  out="$(run_snippet "$snippet")"
  calls="$(grep '^CALL ' <<<"$out" || true)"
  local p_fw p_au p_vs p_note p_fun p_sum
  p_fw="$(grep -n '^CALL configure_firewall$' <<<"$calls" | cut -d: -f1)"
  p_au="$(grep -n '^CALL setup_auto_update$' <<<"$calls" | cut -d: -f1)"
  p_vs="$(grep -n '^CALL verify_services$' <<<"$calls" | cut -d: -f1)"
  p_note="$(grep -n '^CALL create_welcome_note$' <<<"$calls" | cut -d: -f1)"
  p_fun="$(grep -n '^CALL setup_funnel$' <<<"$calls" | cut -d: -f1)"
  p_sum="$(grep -n '^CALL print_summary$' <<<"$calls" | cut -d: -f1)"
  if [ -n "$p_fw" ] && [ -n "$p_au" ] && [ -n "$p_vs" ] && [ -n "$p_note" ] && [ -n "$p_fun" ] && [ -n "$p_sum" ] \
    && [ "$p_fw" -lt "$p_au" ] && [ "$p_au" -lt "$p_vs" ] && [ "$p_vs" -lt "$p_note" ] \
    && [ "$p_note" -lt "$p_fun" ] && [ "$p_fun" -lt "$p_sum" ] \
    && [ "$p_sum" = "$(wc -l <<<"$calls" | tr -d ' ')" ]; then
    pass "main(): UFW → auto-update → weryfikacja → plik-dowód → Funnel → podsumowanie (Funnel na końcu)"
  else
    problem "main(): zła sekwencja finału (fw=$p_fw au=$p_au vs=$p_vs note=$p_note fun=$p_fun sum=$p_sum, calls: $calls)"
  fi
  write_recorder_snippet "$snippet" "--only-puls"
  out2="$(run_snippet "$snippet")"
  if [[ "$out2" != *"CALL create_welcome_note"* ]] \
    && [[ "$out2" == *"CALL verify_services"* ]] \
    && [[ "$out2" == *"CALL setup_funnel"* ]] \
    && [[ "$out2" == *"CALL print_summary"* ]]; then
    pass "main --only-puls: plik-dowód pominięty, weryfikacja/Funnel/podsumowanie obecne"
  else
    problem "main --only-puls: złe wywołania finału (output: $out2)"
  fi
}

# --- Test 59: cron-node-guard.sh — WYKONANIE wygenerowanego skryptu z atrapą node (granice wersji) ---
test_cron_node_guard_behavior() {
  local snippet="$SANDBOX/t-guard-gen.sh" guard="$SANDBOX/guard-inst/cron-node-guard.sh" \
    glog="$SANDBOX/guard.log" shim="$SANDBOX/guard-shim"
  mkdir -p "$SANDBOX/guard-inst" "$shim"
  cat > "$snippet" <<EOF
chown() { :; }
write_cron_node_guard "$guard" "$glog"
EOF
  run_snippet "$snippet" > /dev/null
  if [ ! -x "$guard" ]; then
    problem "cron-node-guard: skrypt nie został wygenerowany ($guard)"
    return
  fi
  # PATH-shim z atrapą node — guard uruchamiany NAPRAWDĘ, nie grep treści:
  # test zachowania łapie np. odwrócony -ge/-gt. Pusta wersja = atrapa
  # padniętego node (brak node i puste `node -v` dają ten sam RAW="").
  run_guard_with_node() {
    if [ -n "$1" ]; then
      printf '#!/bin/sh\necho %s\n' "$1" > "$shim/node"
    else
      printf '#!/bin/sh\nexit 127\n' > "$shim/node"
    fi
    chmod +x "$shim/node"
    PATH="$shim:$PATH" bash "$guard" >/dev/null 2>&1
  }
  local r2212 r2213 r24 r25 rnone
  run_guard_with_node v22.12.0; r2212=$?
  run_guard_with_node v22.13.0; r2213=$?
  run_guard_with_node v24.4.1;  r24=$?
  run_guard_with_node v25.0.0;  r25=$?
  run_guard_with_node "";       rnone=$?
  if [ "$r2212" -eq 1 ] && [ "$r2213" -eq 0 ] && [ "$r24" -eq 0 ] \
    && [ "$r25" -eq 1 ] && [ "$rnone" -eq 1 ]; then
    pass "cron-node-guard: 22.12→1, 22.13→0, 24.x→0, 25.0→1 (granica wykluczająca), brak node→1"
  else
    problem "cron-node-guard: złe granice wersji (22.12=$r2212 22.13=$r2213 24.x=$r24 25.0=$r25 brak=$rnone)"
  fi
  # Wstrzymany restart MUSI zostawić ślad diagnostyczny w cron-logu.
  if grep -q "WSTRZYMANY" "$glog" 2>/dev/null; then
    pass "cron-node-guard: wstrzymanie restartu logowane do cron-loga"
  else
    problem "cron-node-guard: brak wpisu WSTRZYMANY w cron-logu ($glog)"
  fi
}

# --- Test 60: install_update_cron — idempotencja re-run + kontrakt „nigdy cudzego stanu" ---
test_install_update_cron_idempotent() {
  local snippet="$SANDBOX/t-cron-rerun.sh" cronfile="$SANDBOX/rerun-cronfile" \
    install="$SANDBOX/rerun-install" home="$SANDBOX/rerun-home" out rc out2 rc2
  mkdir -p "$install/scripts" "$home"
  local foreign='0 3 * * * tar czf /backup/notes.tgz /home/claude/notes'
  printf '%s\n' "$foreign" > "$cronfile"
  cat > "$snippet" <<EOF
INSTALL_DIR="$install"
CLAUDE_HOME="$home"
FLAG_ONLY_PULS=0
CRONFILE="$cronfile"
crontab() {
  case "\$1" in
    -l) if [ -f "\$CRONFILE" ]; then cat "\$CRONFILE"; else return 1; fi ;;
    -)  cat > "\$CRONFILE" ;;
  esac
}
install_update_cron "$install/scripts/cron-node-guard.sh" "$home/claude-cron-update.log"
install_update_cron "$install/scripts/cron-node-guard.sh" "$home/claude-cron-update.log"
echo "STACK=[\${ROLLBACK_STACK[*]-}]"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  local puls_lines rollback_count
  puls_lines="$(grep -c 'claude-cron' "$cronfile" 2>/dev/null)"
  rollback_count="$(grep -o "grep -v 'claude-cron'" <<<"$out" | grep -c . || true)"
  if [ "$rc" -eq 0 ] && [ "$puls_lines" = "1" ] \
    && grep -qF "$foreign" "$cronfile" \
    && [ "$rollback_count" = "1" ]; then
    pass "install_update_cron: re-run → dokładnie 1 linia Pulsa, cudzy wpis zachowany, rollback zarejestrowany raz"
  else
    problem "install_update_cron: idempotencja re-run zawiodła (rc=$rc, puls_lines=$puls_lines, rollback=$rollback_count, cron: $(cat "$cronfile" 2>/dev/null), out: $out)"
  fi
  # Wpis Pulsa SPRZED runa = cudzy stan — rollback crontaba NIE może być
  # rejestrowany (odwinięcie skasowałoby wpis nie z tego runu).
  printf '%s\n%s\n' "$foreign" '0 2 * * * su - claude -c "stara-instalacja" && systemctl restart claude-cron' > "$cronfile"
  cat > "$snippet" <<EOF
INSTALL_DIR="$install"
CLAUDE_HOME="$home"
FLAG_ONLY_PULS=0
CRONFILE="$cronfile"
crontab() {
  case "\$1" in
    -l) if [ -f "\$CRONFILE" ]; then cat "\$CRONFILE"; else return 1; fi ;;
    -)  cat > "\$CRONFILE" ;;
  esac
}
install_update_cron "$install/scripts/cron-node-guard.sh" "$home/claude-cron-update.log"
echo "STACK=[\${ROLLBACK_STACK[*]-}]"
EOF
  out2="$(run_snippet "$snippet")"
  rc2=$?
  puls_lines="$(grep -c 'claude-cron' "$cronfile" 2>/dev/null)"
  if [ "$rc2" -eq 0 ] && [ "$puls_lines" = "1" ] \
    && grep -qF "$foreign" "$cronfile" \
    && ! grep -q 'stara-instalacja' "$cronfile" \
    && [[ "$out2" == *"STACK=[]"* ]]; then
    pass "install_update_cron: wpis sprzed runa → dedup do 1 linii, cudzy wpis nietknięty, rollback NIErejestrowany"
  else
    problem "install_update_cron: kontrakt cudzego stanu zawiódł (rc=$rc2, puls_lines=$puls_lines, cron: $(cat "$cronfile" 2>/dev/null), out: $out2)"
  fi
}

# --- Test 61: set_service_webhook_env — pad restartu = warn, nie trap ERR (finał nie odwija rollbacku) ---
test_set_service_webhook_env_restart_fail_warns() {
  local snippet="$SANDBOX/t-webhook-warn.sh" sysd="$SANDBOX/systemd-webhook" out rc
  mkdir -p "$sysd"
  cat > "$sysd/claude-cron.service" <<'UNIT'
[Service]
StandardOutput=journal
SyslogIdentifier=claude-cron
UNIT
  cat > "$snippet" <<EOF
SYSTEMD_DIR="$sysd"
WEBHOOK_BASE_URL="https://srv.ts.net"
systemctl() { return 1; }
set_service_webhook_env
echo "PO_WEBHOOK"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_WEBHOOK"* ]] && [[ "$out" == *"ręcznie"* ]] \
    && grep -q '^Environment=WEBHOOK_BASE_URL=https://srv.ts.net$' "$sysd/claude-cron.service" \
    && [ ! -f "$sysd/claude-cron.service.tmp" ]; then
    pass "set_service_webhook_env: pad restartu → warn + rc 0 (bez ERR); unit zapisany atomowo (brak .tmp)"
  else
    problem "set_service_webhook_env: pad restartu wyzwala fail/rollback lub zły zapis (rc=$rc, unit: $(cat "$sysd/claude-cron.service" 2>/dev/null), out: $out)"
  fi
}

# --- Test 62: run_reset — odpowiedź ≠ TAK → exit 0 bez ŻADNEGO usunięcia (rejestrator) ---
test_reset_requires_tak() {
  local snippet="$SANDBOX/t-reset-notak.sh" sysd="$SANDBOX/reset-sysd-a" \
    log="$SANDBOX/reset-log-a" tty="$SANDBOX/reset-tty-a" out rc
  mkdir -p "$sysd"
  touch "$sysd/obsidian-sync.service" "$sysd/claude-cron.service"
  # Odpowiedź inna niż dosłowne TAK (w tym "tak" małymi) NIE może potwierdzić.
  printf 'tak\n' > "$tty"
  cat > "$snippet" <<EOF
parse_flags --reset
TTY_DEVICE="$tty"
SYSTEMD_DIR="$sysd"
SUDOERS_DIR="$sysd"
check_root() { :; }
systemctl() { echo "systemctl \$*" >> "$log"; }
userdel() { echo "userdel \$*" >> "$log"; }
crontab() { echo "crontab \$*" >> "$log"; }
run_reset
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"anulowany"* ]] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [ ! -s "$log" ] \
    && [ -f "$sysd/obsidian-sync.service" ] && [ -f "$sysd/claude-cron.service" ]; then
    pass "run_reset: odpowiedź ≠ TAK → exit 0, zero wywołań systemctl/userdel/crontab, pliki nietknięte"
  else
    problem "run_reset: brak TAK NIE zatrzymał usuwania (rc=$rc, log: $(cat "$log" 2>/dev/null), out: $out)"
  fi
}

# --- Test 63: build_reset_paths bez pustych/względnych ścieżek; remove_reset_path — guard \${…:?} ---
test_reset_paths_guards() {
  local snippet="$SANDBOX/t-reset-paths.sh" out rc
  cat > "$snippet" <<'EOF'
build_reset_paths
printf 'N=%s\n' "${#RESET_PATHS[@]}"
for p in "${RESET_PATHS[@]}"; do
  [ -n "$p" ] || { echo "PUSTA_SCIEZKA"; exit 1; }
  case "$p" in /*) ;; *) echo "WZGLEDNA_SCIEZKA=$p"; exit 1 ;; esac
  printf 'P=%s\n' "$p"
done
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"N=3"* ]] \
    && [[ "$out" == *"P=/etc/systemd/system/obsidian-sync.service"* ]] \
    && [[ "$out" == *"P=/etc/systemd/system/claude-cron.service"* ]] \
    && [[ "$out" == *"P=/etc/sudoers.d/claude-cron"* ]]; then
    pass "build_reset_paths: 3 ścieżki, wszystkie niepuste i absolutne (unit-pliki + sudoers)"
  else
    problem "build_reset_paths: lista z pustą/względną ścieżką lub złym składem (rc=$rc, out: $out)"
  fi

  # Guard ${…:?}: pusta ścieżka → twardy fail PRZED rm; ofiara-plik przeżywa.
  local victim="$SANDBOX/reset-victim"
  touch "$victim"
  cat > "$snippet" <<'EOF'
remove_reset_path ""
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" != *"NIEOSIAGALNE"* ]] && [ -f "$victim" ]; then
    pass "remove_reset_path: pusta ścieżka → fail bez wykonania rm"
  else
    problem "remove_reset_path: pusta ścieżka NIE sfailowała (rc=$rc, out: $out)"
  fi

  # Happy path + no-op: istniejący plik usunięty, nieistniejący → rc 0 (idempotencja).
  cat > "$snippet" <<EOF
remove_reset_path "$victim"
remove_reset_path "$SANDBOX/reset-nie-istnieje"
echo "PO_REMOVE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_REMOVE"* ]] && [ ! -e "$victim" ]; then
    pass "remove_reset_path: usuwa istniejący plik, nieistniejący = no-op bez błędu"
  else
    problem "remove_reset_path: happy path / no-op zawiódł (rc=$rc, out: $out)"
  fi
}

# --- Test 64: run_reset na czystym systemie (brak artefaktów) → przechodzi bez błędów ---
test_reset_idempotent_on_clean_system() {
  local snippet="$SANDBOX/t-reset-clean.sh" sysd="$SANDBOX/reset-sysd-b" \
    sud="$SANDBOX/reset-sud-b" log="$SANDBOX/reset-log-b" tty="$SANDBOX/reset-tty-b" out rc
  mkdir -p "$sysd" "$sud"
  printf 'TAK\n' > "$tty"
  cat > "$snippet" <<EOF
parse_flags --reset
TTY_DEVICE="$tty"
SYSTEMD_DIR="$sysd"
SUDOERS_DIR="$sud"
check_root() { :; }
has_user_claude() { return 1; }
systemctl() { echo "systemctl \$*" >> "$log"; }
userdel() { echo "userdel \$*" >> "$log"; }
crontab() { return 1; }
tailscale() { echo "tailscale \$*" >> "$log"; }
run_reset
echo "PO_RESECIE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_RESECIE"* ]] && [[ "$out" == *"zakończona"* ]] \
    && ! grep -q 'userdel' "$log" 2>/dev/null \
    && ! grep -q 'disable' "$log" 2>/dev/null; then
    pass "run_reset: czysty system (brak artefaktów) → rc 0, bez userdel/disable (idempotentny)"
  else
    problem "run_reset: czysty system zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), out: $out)"
  fi
}

# --- Test 65: run_reset z artefaktami — kolejność (serwisy → pliki → cron → userdel) + skutki ---
test_reset_full_flow_order() {
  local snippet="$SANDBOX/t-reset-full.sh" sysd="$SANDBOX/reset-sysd-c" \
    sud="$SANDBOX/reset-sud-c" log="$SANDBOX/reset-log-c" tty="$SANDBOX/reset-tty-c" \
    cronfile="$SANDBOX/reset-cron-c" out rc
  mkdir -p "$sysd" "$sud"
  touch "$sysd/obsidian-sync.service" "$sysd/claude-cron.service" "$sud/claude-cron"
  local foreign='0 4 * * * /usr/local/bin/certbot renew'
  printf '%s\n%s\n' "$foreign" \
    '0 2 * * * su - claude -c "update" && systemctl restart claude-cron' > "$cronfile"
  printf 'TAK\n' > "$tty"
  cat > "$snippet" <<EOF
parse_flags --reset
TTY_DEVICE="$tty"
SYSTEMD_DIR="$sysd"
SUDOERS_DIR="$sud"
CRONFILE="$cronfile"
check_root() { :; }
has_user_claude() { return 0; }
systemctl() { echo "systemctl \$*" >> "$log"; }
userdel() { echo "userdel \$*" >> "$log"; }
tailscale() { echo "tailscale \$*" >> "$log"; }
crontab() {
  case "\$1" in
    -l) cat "\$CRONFILE" ;;
    -)  cat > "\$CRONFILE" ;;
  esac
}
run_reset
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  local first_line second_line last_line
  first_line="$(head -1 "$log" 2>/dev/null)"
  second_line="$(sed -n 2p "$log" 2>/dev/null)"
  last_line="$(tail -1 "$log" 2>/dev/null)"
  if [ "$rc" -eq 0 ] \
    && [[ "$first_line" == *"tailscale funnel reset"* ]] \
    && [[ "$second_line" == *"disable --now obsidian-sync"* ]] \
    && grep -q 'disable --now claude-cron' "$log" \
    && [[ "$last_line" == *"userdel -r claude"* ]] \
    && [ ! -f "$sysd/obsidian-sync.service" ] && [ ! -f "$sysd/claude-cron.service" ] \
    && [ ! -f "$sud/claude-cron" ] \
    && grep -qF "$foreign" "$cronfile" && ! grep -q 'claude-cron' "$cronfile"; then
    pass "run_reset: funnel off→serwisy stop→pliki→cron→userdel; unit-pliki+sudoers usunięte, cudzy cron zachowany"
  else
    problem "run_reset: pełny przebieg zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), cron: $(cat "$cronfile" 2>/dev/null), out: $out)"
  fi
}

# --- Test 66: disable_funnel — brak tailscale = no-op; `funnel reset` z fallbackiem
# na `--bg <port> off`; pad OBU składni → warn bez przerwania resetu; plan i summary
# wymieniają Funnel jawnie (P2-1 z review fazy 7: persystentny Funnel po deinstalacji) ---
test_disable_funnel() {
  local snippet="$SANDBOX/t-funnel-disable.sh" log="$SANDBOX/funnel-disable.log" out rc

  # Brak tailscale: pusty PATH → guard command -v pomija bez wywołań i bez błędu.
  mkdir -p "$SANDBOX/empty-bin"
  cat > "$snippet" <<EOF
PATH="$SANDBOX/empty-bin"
disable_funnel
echo "PO_OFF"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_OFF"* ]] && [[ "$out" == *"pomijam"* ]]; then
    pass "disable_funnel: brak tailscale → no-op z komunikatem, rc 0"
  else
    problem "disable_funnel: gałąź bez tailscale zawiodła (rc=$rc, out: $out)"
  fi

  # Happy path: `funnel reset` przechodzi → fallback NIE jest wołany.
  cat > "$snippet" <<EOF
tailscale() { echo "tailscale \$*" >> "$log"; }
disable_funnel
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"Funnel wyłączony"* ]] \
    && grep -q '^tailscale funnel reset$' "$log" 2>/dev/null \
    && ! grep -q 'off' "$log" 2>/dev/null; then
    pass "disable_funnel: tailscale dostępny → funnel reset, bez fallbacku"
  else
    problem "disable_funnel: happy path zawiódł (rc=$rc, log: $(cat "$log" 2>/dev/null), out: $out)"
  fi

  # Stary CLI: `funnel reset` pada → fallback `funnel --bg 7777 off`.
  local log2="$SANDBOX/funnel-disable-old.log"
  cat > "$snippet" <<EOF
parse_flags --reset
tailscale() {
  echo "tailscale \$*" >> "$log2"
  [ "\$2" = "reset" ] && return 1
  return 0
}
disable_funnel
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"Funnel wyłączony"* ]] \
    && grep -q -- '^tailscale funnel --bg 7777 off$' "$log2" 2>/dev/null; then
    pass "disable_funnel: pad 'funnel reset' → fallback --bg <port> off"
  else
    problem "disable_funnel: fallback starej składni zawiódł (rc=$rc, log: $(cat "$log2" 2>/dev/null), out: $out)"
  fi

  # Pad OBU składni: warn z instrukcją ręczną, rc 0 — reset leci dalej.
  cat > "$snippet" <<'EOF'
parse_flags --reset
tailscale() { return 1; }
disable_funnel
echo "PO_PADZIE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *"PO_PADZIE"* ]] && [[ "$out" == *"tailscale funnel status"* ]]; then
    pass "disable_funnel: pad obu składni → warn z komendą ręczną, reset kontynuuje"
  else
    problem "disable_funnel: pad obu składni przerwał reset lub brak warn (rc=$rc, out: $out)"
  fi

  # Jawne pozycje o Funnelu w planie resetu i podsumowaniu (dokładna lista R12).
  cat > "$snippet" <<'EOF'
parse_flags --reset
resolve_install_paths
print_reset_plan
echo "===SUMMARY==="
print_reset_summary
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  local plan_part="${out%%===SUMMARY===*}" summary_part="${out#*===SUMMARY===}"
  if [ "$rc" -eq 0 ] && [[ "$plan_part" == *"Funnel"* ]] && [[ "$summary_part" == *"Funnel"* ]]; then
    pass "print_reset_plan/print_reset_summary: Funnel wymieniony jawnie w obu listach"
  else
    problem "print_reset_plan/summary: brak jawnej pozycji o Funnelu (rc=$rc, out: $out)"
  fi
}

# --- Test 69: configure_firewall — 'Status: inactive' MUSI odpalić `ufw --force enable`
# (realny pad z VPS 2026-07-02: goły grep "active" matchował "inactive" → reguły
# w uśpionym firewallu, dashboard publicznie widoczny; granica R "tylko Tailscale") ---
test_configure_firewall_enables_inactive() {
  local snippet="$SANDBOX/t-ufw.sh" log="$SANDBOX/ufw.log" state="$SANDBOX/ufw-state" out rc
  # Stateful stub: status czyta plik stanu; `--force enable` przełącza go na active.
  echo "inactive" > "$state"
  cat > "$snippet" <<EOF
PORT=7777
ufw() {
  echo "ufw \$*" >> "$log"
  if [ "\$1" = "status" ]; then echo "Status: \$(cat "$state")"; return 0; fi
  if [ "\$1" = "--force" ] && [ "\$2" = "enable" ]; then echo "active" > "$state"; fi
  return 0
}
apt-get() { :; }
configure_firewall
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && grep -q '^ufw --force enable$' "$log" \
    && grep -q '^ufw deny 7777/tcp$' "$log" \
    && [[ "$out" == *"zablokowany w UFW"* ]] && [[ "$out" != *"WIDOCZNY"* ]]; then
    pass "configure_firewall: 'Status: inactive' → --force enable + deny + potwierdzenie"
  else
    problem "configure_firewall: inactive NIE włączył UFW (rc=$rc, log: $(cat "$log" 2>/dev/null), out: $out)"
  fi

  # Już aktywny → bez ponownego enable (idempotencja).
  local log2="$SANDBOX/ufw2.log" out2
  echo "active" > "$state"
  cat > "$snippet" <<EOF
PORT=7777
ufw() {
  echo "ufw \$*" >> "$log2"
  [ "\$1" = "status" ] && echo "Status: \$(cat "$state")"
  return 0
}
apt-get() { :; }
configure_firewall
EOF
  out2="$(run_snippet "$snippet")"
  if [ "$?" -eq 0 ] && ! grep -q 'force enable' "$log2" && [[ "$out2" == *"zablokowany w UFW"* ]]; then
    pass "configure_firewall: 'Status: active' → bez ponownego enable"
  else
    problem "configure_firewall: aktywny UFW włączany ponownie lub brak ok (out: $out2)"
  fi

  # Enable nie zadziałał (stan zostaje inactive) → GŁOŚNY warn o widoczności z internetu.
  local log3="$SANDBOX/ufw3.log" out3
  echo "inactive" > "$state"
  cat > "$snippet" <<EOF
PORT=7777
ufw() {
  echo "ufw \$*" >> "$log3"
  [ "\$1" = "status" ] && echo "Status: \$(cat "$state")"
  return 0
}
apt-get() { :; }
configure_firewall
echo "PO_UFW"
EOF
  out3="$(run_snippet "$snippet")"
  if [ "$?" -eq 0 ] && [[ "$out3" == *"WIDOCZNY z publicznego internetu"* ]] && [[ "$out3" == *"PO_UFW"* ]]; then
    pass "configure_firewall: UFW dalej nieaktywny → warn o ekspozycji, bez faila"
  else
    problem "configure_firewall: brak warn przy nieaktywnym UFW (out: $out3)"
  fi
}

# --- Test 67: on_err z PUSTYM stosem rollbacku — komunikat + resume, nie cichy exit
# (realny pad z VPS 2026-07-02: unattended-upgrades ubił apt w install_node PRZED
# pierwszym push_rollback → user dostał goły błąd apt i prompt, zero instrukcji) ---
test_on_err_empty_stack_message() {
  local snippet="$SANDBOX/t-onerr-empty.sh" out rc
  cat > "$snippet" <<'EOF'
trap on_err ERR
false
echo "NIEOSIAGALNE"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" != *"NIEOSIAGALNE"* ]] \
    && [[ "$out" == *"przerwana błędem"* ]] && [[ "$out" == *"curl -fsSL"* ]]; then
    pass "on_err: pusty stos → komunikat błędu + one-liner resume (nie cichy exit)"
  else
    problem "on_err: pusty stos kończy bez komunikatu/resume (rc=$rc, out: $out)"
  fi

  # Blok loginów (rollback wyłączony): cisza ZOSTAJE — run_login/halt_leave_partial
  # mają własne komunikaty, podwójny wydruk by je zaszumił.
  local snippet2="$SANDBOX/t-onerr-disabled.sh" out2 rc2
  cat > "$snippet2" <<'EOF'
trap on_err ERR
disable_rollback
false
EOF
  out2="$(run_snippet "$snippet2")"
  rc2=$?
  if [ "$rc2" -ne 0 ] && [[ "$out2" != *"przerwana błędem"* ]]; then
    pass "on_err: rollback wyłączony → bez komunikatu (komunikaty ma blok loginów)"
  else
    problem "on_err: rollback wyłączony a komunikat się pojawił (rc=$rc2, out: $out2)"
  fi
}

# --- Test 68: setup_apt_lock_wait — eksportuje APT_CONFIG z DPkg::Lock::Timeout;
# main() woła go PRZED pierwszym apt (install_base_packages) ---
test_setup_apt_lock_wait() {
  local snippet="$SANDBOX/t-apt-lock.sh" out rc
  cat > "$snippet" <<'EOF'
setup_apt_lock_wait
[ -n "${APT_CONFIG:-}" ] || { echo "BRAK_EXPORTU"; exit 1; }
cat "$APT_CONFIG"
bash -c 'cat "$APT_CONFIG"' | grep -q 'DPkg::Lock::Timeout' && echo "DZIEDZICZONY"
EOF
  out="$(run_snippet "$snippet")"
  rc=$?
  if [ "$rc" -eq 0 ] && [[ "$out" == *'DPkg::Lock::Timeout "900";'* ]] \
    && [[ "$out" == *"DZIEDZICZONY"* ]]; then
    pass "setup_apt_lock_wait: APT_CONFIG z timeoutem 900 s, widoczny w procesie potomnym"
  else
    problem "setup_apt_lock_wait: brak eksportu/timeoutu (rc=$rc, out: $out)"
  fi

  # Sekwencja main(): timeout locka MUSI być ustawiony przed pierwszym apt.
  local snippet2="$SANDBOX/t-apt-lock-seq.sh" out2 calls
  write_recorder_snippet "$snippet2" ""
  out2="$(run_snippet "$snippet2")"
  calls="$(grep '^CALL ' <<<"$out2" || true)"
  if sed -n '1,/^CALL install_base_packages$/p' <<<"$calls" | grep -q '^CALL setup_apt_lock_wait$'; then
    pass "main(): setup_apt_lock_wait wywołany przed install_base_packages"
  else
    problem "main(): setup_apt_lock_wait NIE poprzedza install_base_packages (calls: $calls)"
  fi
}

echo "== install-vps.sh — testy szkieletu (flagi/tty/login/rollback), fazy 2 (preflight/guardy/pytania), fazy 3 (narzędzia/sekwencja/instalacje), fazy 4 (blok 5 loginów), fazy 5 (Obsidian + unity systemd), fazy 6 (auto-update/weryfikacja/dowód/Funnel/podsumowanie) i fazy 7 (reset: potwierdzenie TAK, guardy ścieżek, idempotencja) =="
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
test_detect_timezone
test_ob_guards_separate
test_is_supported_os
test_normalize_path
test_is_valid_workspace_path
test_ask_workspace_flow
test_collect_config_no_discord_question
test_ensure_workspace_chown_only_on_create
test_main_installs_before_login_block
test_main_only_puls_skips_ob
test_userdel_rollback_conditional
test_login_block_drops_userdel_rollback
test_install_base_packages
test_install_claude_cli
test_install_ob
test_install_tailscale
test_login_block_full_resume
test_login_block_resumes_into_gh
test_validate_repo_access_retry
test_login_block_halt_keeps_stack
test_login_block_only_puls_skips_ob_pauses
test_login_cmd_as_claude_quoting_roundtrip
test_login_ob_commands_survive_double_parsing
test_validate_repo_access_repo_quoted
test_build_puls_env_lines
test_build_obsidian_sync_unit
test_configure_obsidian_file_types
test_link_vault_claude_idempotent
test_link_vault_claude_foreign_dir_backup
test_setup_vault_git_guard
test_setup_vault_git_postcondition
test_setup_vault_git_origin_mismatch
test_main_obsidian_order_and_skip
test_unit_rollback_only_when_created
test_obsidian_sync_service_restart_on_rerun
test_build_cron_cmd
test_setup_auto_update
test_welcome_note
test_print_summary_funnel_variants
test_setup_funnel
test_verify_services_and_sync_wait
test_main_final_phase_order
test_cron_node_guard_behavior
test_install_update_cron_idempotent
test_set_service_webhook_env_restart_fail_warns
test_reset_requires_tak
test_reset_paths_guards
test_reset_idempotent_on_clean_system
test_reset_full_flow_order
test_disable_funnel
test_on_err_empty_stack_message
test_setup_apt_lock_wait
test_configure_firewall_enables_inactive

echo ""
echo "Wynik: ${PASS} PASS / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ] || exit 1
