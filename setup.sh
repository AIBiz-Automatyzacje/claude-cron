#!/usr/bin/env bash
set -euo pipefail

# ============================================
#  CLAUDE-CRON — macOS Setup
#  Dashboard + proxy do VPS
# ============================================

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
ask()   { echo -en "${BOLD}$1${NC}"; }

# Repo = directory where this script lives
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo -e "${CYAN}🕹️  CLAUDE-CRON — macOS Setup${NC}"
echo "========================================"
echo ""
echo -e "  Ten skrypt konfiguruje lokalny dashboard claude-cron"
echo -e "  i podłącza go do Twojego VPS-a (który działa 24/7)."
echo ""
echo -e "  ${DIM}Jeśli nie masz jeszcze VPS-a — najpierw uruchom install-vps.sh${NC}"
echo -e "  ${DIM}Można też użyć bez VPS-a (tylko lokalnie), ale wtedy${NC}"
echo -e "  ${DIM}joby działają tylko gdy Mac nie śpi.${NC}"
echo ""

# ============ PREFLIGHT ============

info "Sprawdzam wymagania..."

# macOS check
[ "$(uname)" = "Darwin" ] || fail "Ten skrypt jest dla macOS. Użyj install-vps.sh na Linuxie."

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js nie znaleziony. Zainstaluj z https://nodejs.org (18+)"
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VER" -ge 18 ] || fail "Wymagany Node.js 18+ (znaleziono $(node -v))"
ok "Node.js $(node -v)"

# npm
command -v npm &>/dev/null || fail "npm nie znaleziony"
ok "npm $(npm -v)"

# Claude CLI
if command -v claude &>/dev/null; then
  ok "Claude CLI znaleziony"
else
  warn "Claude CLI nie znaleziony!"
  warn "Zainstaluj: npm install -g @anthropic-ai/claude-code"
  warn "Joby nie będą działać bez niego. Setup kontynuuje."
  echo ""
fi

# ============ NPM INSTALL ============

echo ""
info "Instaluję zależności..."
cd "$REPO_DIR"
npm install --production 2>&1 | tail -3
mkdir -p "$REPO_DIR/data"
ok "Zależności zainstalowane"

# ============ STEP 1: VPS CONNECTION ============

echo ""
echo "========================================"
echo -e "${CYAN}  KROK 1/4 — Połączenie z VPS${NC}"
echo "========================================"
echo ""
echo -e "  Claude-cron na VPS działa 24/7 i odpala joby wg harmonogramu."
echo -e "  Ten dashboard podłącza się do niego przez Tailscale."
echo ""
echo -e "  ${DIM}Podaj Tailscale IP Twojego VPS-a (np. 100.x.x.x).${NC}"
echo -e "  ${DIM}Znajdziesz go na VPS: tailscale ip -4${NC}"
echo -e "  ${DIM}Puste = pomiń (tryb tylko lokalny)${NC}"
echo ""

SHELL_RC="$HOME/.zshrc"

ask "Tailscale IP VPS-a: "
read -r VPS_HOST

if [ -n "$VPS_HOST" ]; then
  # Strip spaces
  VPS_HOST="${VPS_HOST%% }"
  VPS_HOST="${VPS_HOST## }"

  VPS_PORT=7777
  ask "Port VPS [$VPS_PORT]: "
  read -r VPS_PORT_INPUT
  VPS_PORT="${VPS_PORT_INPUT:-$VPS_PORT}"

  VPS_URL="http://${VPS_HOST}:${VPS_PORT}"

  if grep -q "CLAUDE_CRON_VPS_URL" "$SHELL_RC" 2>/dev/null; then
    sed -i '' "s|^export CLAUDE_CRON_VPS_URL=.*|export CLAUDE_CRON_VPS_URL=\"$VPS_URL\"|" "$SHELL_RC"
    ok "VPS: $VPS_URL (zaktualizowano w $SHELL_RC)"
  else
    echo "" >> "$SHELL_RC"
    echo "# Claude-Cron VPS connection" >> "$SHELL_RC"
    echo "export CLAUDE_CRON_VPS_URL=\"$VPS_URL\"" >> "$SHELL_RC"
    ok "VPS: $VPS_URL"
  fi
else
  info "Tryb tylko lokalny — joby działają gdy Mac nie śpi"
fi

# ============ STEP 2: WORKSPACE ============

echo ""
echo "========================================"
echo -e "${CYAN}  KROK 2/4 — Workspace${NC}"
echo "========================================"
echo ""
echo -e "  Folder, w którym Claude CLI wykonuje joby (np. Twój vault Obsidian)."
echo -e "  ${YELLOW}Tip: przeciągnij folder z Findera tutaj i naciśnij Enter${NC}"
echo ""
ask "Ścieżka do workspace [$HOME]: "
read -r WORKSPACE_INPUT
WORKSPACE="${WORKSPACE_INPUT:-$HOME}"

# Strip quotes, backslash-escapes and trailing spaces (drag & drop from Finder adds them)
WORKSPACE="${WORKSPACE//\'/}"
WORKSPACE="${WORKSPACE//\"/}"
WORKSPACE="${WORKSPACE//\\/}"
WORKSPACE="${WORKSPACE%% }"
WORKSPACE="${WORKSPACE## }"

# Expand ~ to $HOME
WORKSPACE="${WORKSPACE/#\~/$HOME}"

# Resolve to absolute path
WORKSPACE="$(cd "$WORKSPACE" 2>/dev/null && pwd)" || fail "Folder nie istnieje: $WORKSPACE_INPUT"

ok "Workspace: $WORKSPACE"

# Save to .zshrc
if grep -q "CLAUDE_CRON_WORKSPACE" "$SHELL_RC" 2>/dev/null; then
  sed -i '' "s|^export CLAUDE_CRON_WORKSPACE=.*|export CLAUDE_CRON_WORKSPACE=\"$WORKSPACE\"|" "$SHELL_RC"
  ok "Workspace zaktualizowany w $SHELL_RC"
else
  echo "" >> "$SHELL_RC"
  echo "# Claude-Cron workspace" >> "$SHELL_RC"
  echo "export CLAUDE_CRON_WORKSPACE=\"$WORKSPACE\"" >> "$SHELL_RC"
  ok "Zapisano w $SHELL_RC"
fi

# ============ STEP 3: AUTOSTART HOOK ============

echo ""
echo "========================================"
echo -e "${CYAN}  KROK 3/4 — Autostart${NC}"
echo "========================================"
echo ""
echo -e "  Serwer claude-cron może startować automatycznie"
echo -e "  przy każdym uruchomieniu Claude Code."
echo ""

HOOKS_DIR="$WORKSPACE/.claude/hooks"
HOOK_FILE="$HOOKS_DIR/claude-cron-autostart.js"
SETTINGS_FILE="$WORKSPACE/.claude/settings.json"

# Cleanup: remove old global hook from previous installations
OLD_HOOK="$HOME/.claude/hooks/claude-cron-autostart.js"
if [ -f "$OLD_HOOK" ]; then
  rm -f "$OLD_HOOK"
  info "Usunięto stary globalny hook: $OLD_HOOK"
fi

ask "Zainstalować autostart? [Y/n]: "
read -r INSTALL_HOOK
INSTALL_HOOK="${INSTALL_HOOK:-Y}"

if [[ "$INSTALL_HOOK" =~ ^[Yy]$ ]]; then
  mkdir -p "$HOOKS_DIR"

  cat > "$HOOK_FILE" <<HOOKEOF
const http = require('http');
const { spawn } = require('child_process');

const CRON_DIR = '$REPO_DIR';

const req = http.get('http://localhost:7777/api/status', { timeout: 1000 }, () => {
  process.exit(0);
});

req.on('error', () => {
  const child = spawn('node', ['server.js'], {
    cwd: CRON_DIR,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Caffeinate — keep Mac awake while claude-cron is alive
  if (process.platform === 'darwin') {
    spawn('caffeinate', ['-w', String(child.pid)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  console.log('🕹️ Claude-Cron started in background (localhost:7777)');
  process.exit(0);
});

req.on('timeout', () => {
  req.destroy();
});
HOOKEOF

  ok "Hook: $HOOK_FILE"

  # Auto-register hook in workspace settings.json (using Node.js for JSON manipulation)
  mkdir -p "$WORKSPACE/.claude"
  node -e "
    const fs = require('fs');
    const path = '$SETTINGS_FILE';
    const hookCmd = 'node \"$HOOK_FILE\"';
    let settings = {};
    if (fs.existsSync(path)) {
      try { settings = JSON.parse(fs.readFileSync(path, 'utf-8')); } catch { settings = {}; }
    }
    settings.hooks = settings.hooks || {};
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
    const already = settings.hooks.UserPromptSubmit.some(item =>
      item && item.hooks && item.hooks.some(h => h && h.command && h.command.includes('claude-cron-autostart'))
    );
    if (!already) {
      settings.hooks.UserPromptSubmit.push({
        matcher: '',
        hooks: [{ type: 'command', command: hookCmd }]
      });
      fs.writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
      console.log('registered');
    } else {
      console.log('already');
    }
  " > /tmp/claude-cron-hook-status 2>/dev/null

  HOOK_STATUS=$(cat /tmp/claude-cron-hook-status 2>/dev/null || echo "error")
  rm -f /tmp/claude-cron-hook-status

  if [ "$HOOK_STATUS" = "registered" ]; then
    ok "Hook zarejestrowany w $SETTINGS_FILE"
  elif [ "$HOOK_STATUS" = "already" ]; then
    ok "Hook już zarejestrowany w settings.json"
  else
    warn "Nie udało się automatycznie zarejestrować hooka. Dodaj ręcznie do $SETTINGS_FILE:"
    echo ""
    echo -e "  ${CYAN}{\"type\": \"command\", \"command\": \"node $HOOK_FILE\"}${NC}"
    echo ""
  fi
else
  info "Pominięto autostart"
fi

# ============ STEP 4: DISCORD ============

echo ""
echo "========================================"
echo -e "${CYAN}  KROK 4/4 — Powiadomienia Discord${NC}"
echo "========================================"
echo ""
echo -e "  ${DIM}Opcjonalne — po zakończeniu joba dostaniesz wynik na Discorda.${NC}"
echo -e "  ${DIM}Puste = pomiń${NC}"
echo ""
ask "Discord webhook URL: "
read -r DISCORD_URL

if [ -n "$DISCORD_URL" ]; then
  if grep -q "DISCORD_WEBHOOK_URL" "$SHELL_RC" 2>/dev/null; then
    sed -i '' "s|^export DISCORD_WEBHOOK_URL=.*|export DISCORD_WEBHOOK_URL=\"$DISCORD_URL\"|" "$SHELL_RC"
    ok "Discord zaktualizowany w $SHELL_RC"
  else
    echo "" >> "$SHELL_RC"
    echo "# Claude-Cron Discord notifications" >> "$SHELL_RC"
    echo "export DISCORD_WEBHOOK_URL=\"$DISCORD_URL\"" >> "$SHELL_RC"
    ok "Discord webhook zapisany"
  fi
else
  info "Pominięto Discord"
fi

# ============ DONE ============

echo ""
echo "========================================"
echo -e "${GREEN}🕹️  Gotowe!${NC}"
echo "========================================"
echo ""
echo -e "  Repo:       ${CYAN}$REPO_DIR${NC}"
echo -e "  Workspace:  ${CYAN}$WORKSPACE${NC}"
echo -e "  Dashboard:  ${CYAN}http://localhost:7777${NC}"
if [ -n "${VPS_URL:-}" ]; then
echo -e "  VPS:        ${CYAN}$VPS_URL${NC}"
fi
echo ""
echo -e "  ${BOLD}Następne kroki:${NC}"
echo ""
echo "  1. Załaduj zmienne środowiskowe:"
echo -e "     ${CYAN}source ~/.zshrc${NC}"
echo ""
echo "  2. Uruchom serwer:"
echo -e "     ${CYAN}cd $REPO_DIR && node server.js${NC}"
echo ""
echo "  3. Otwórz dashboard:"
echo -e "     ${CYAN}http://localhost:7777${NC}"
echo ""
if [[ "${INSTALL_HOOK:-N}" =~ ^[Yy]$ ]]; then
echo -e "  ${DIM}Przy kolejnych sesjach Claude Code serwer startuje automatycznie.${NC}"
echo ""
fi
