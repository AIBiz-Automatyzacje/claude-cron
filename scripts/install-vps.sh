#!/usr/bin/env bash
set -euo pipefail

# ============================================
#  CLAUDE-CRON — VPS Installer
#  Interactive setup for Linux VPS (Debian/Ubuntu)
#  Run as root: sudo bash install-vps.sh
# ============================================

REPO="https://github.com/AIBiz-Automatyzacje/claude-cron.git"
SERVICE_NAME="claude-cron"
CLAUDE_USER="claude"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}  ✓${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; exit 1; }
ask()   { echo -en "${BOLD}$1${NC}"; }

echo ""
echo -e "${CYAN}🕹️  CLAUDE-CRON — VPS Setup${NC}"
echo "========================================"
echo ""

# ============ ROOT CHECK ============

if [ "$(id -u)" -ne 0 ]; then
  fail "Run as root: sudo bash install-vps.sh"
fi

# ============ 1. NODE.JS ============

info "Checking Node.js..."

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 18 ]; then
    warn "Node.js $(node -v) is too old (18+ required)"
    ask "Install Node.js 22? [Y/n]: "
    read -r INSTALL_NODE
    INSTALL_NODE="${INSTALL_NODE:-Y}"
    if [[ "$INSTALL_NODE" =~ ^[Yy]$ ]]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
    else
      fail "Node.js 18+ required"
    fi
  fi
  ok "Node.js $(node -v)"
else
  info "Node.js not found — installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  ok "Node.js $(node -v)"
fi

# ============ 2. GIT ============

if ! command -v git &>/dev/null; then
  info "Installing git..."
  apt-get update -qq && apt-get install -y -qq git
fi
ok "git $(git --version | awk '{print $3}')"

# ============ 2b. CRON ============

if ! command -v crontab &>/dev/null; then
  info "Installing cron..."
  apt-get update -qq && apt-get install -y -qq cron
fi
systemctl enable cron 2>/dev/null || true
systemctl start cron 2>/dev/null || true
ok "cron"

# ============ 3. BUILD TOOLS (for better-sqlite3) ============

if ! dpkg -l | grep -q build-essential 2>/dev/null; then
  info "Installing build tools (needed for SQLite)..."
  apt-get update -qq && apt-get install -y -qq build-essential python3
fi
ok "Build tools"

# ============ 4. DEDICATED USER ============

if id -u "$CLAUDE_USER" &>/dev/null; then
  ok "User '$CLAUDE_USER' exists"
else
  info "Creating dedicated user '$CLAUDE_USER'..."
  useradd -m -s /bin/bash "$CLAUDE_USER"
  ok "User '$CLAUDE_USER' created"
fi

CLAUDE_HOME=$(eval echo "~$CLAUDE_USER")
INSTALL_DIR="$CLAUDE_HOME/claude-cron"

# ============ 5. CLAUDE CLI ============

info "Installing Claude CLI globally..."
npm install -g @anthropic-ai/claude-code 2>&1 | tail -1
ok "Claude CLI installed"

echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Claude CLI needs to be logged in as '$CLAUDE_USER'.${NC}"
echo -e "${YELLOW}  This is interactive — you'll need to complete the${NC}"
echo -e "${YELLOW}  login flow in your browser.${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
ask "Log in to Claude CLI now? [Y/n]: "
read -r DO_LOGIN
DO_LOGIN="${DO_LOGIN:-Y}"

if [[ "$DO_LOGIN" =~ ^[Yy]$ ]]; then
  echo ""
  echo "Launching Claude CLI as '$CLAUDE_USER' — complete login in your browser."
  echo "After login, exit Claude (Ctrl+C or /exit) to continue installation."
  echo ""
  su - "$CLAUDE_USER" -c "claude" || true
  echo ""
  ok "Claude CLI login step completed"
else
  warn "Skipping login — jobs won't run until Claude CLI is logged in"
  warn "Login later: su - $CLAUDE_USER -c 'claude'"
fi

# ============ 6. CLONE REPO ============

echo ""
info "Setting up repository..."

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  su - "$CLAUDE_USER" -c "cd $INSTALL_DIR && git pull --ff-only"
else
  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR exists without git — creating backup..."
    mv "$INSTALL_DIR" "${INSTALL_DIR}.backup.$(date +%s)"
  fi
  info "Cloning repository..."
  su - "$CLAUDE_USER" -c "git clone $REPO $INSTALL_DIR"
fi
ok "Repo: $INSTALL_DIR"

# ============ 7. NPM INSTALL ============

info "Installing dependencies..."
su - "$CLAUDE_USER" -c "cd $INSTALL_DIR && npm install --production" 2>&1 | tail -3
mkdir -p "$INSTALL_DIR/data"
chown "$CLAUDE_USER:$CLAUDE_USER" "$INSTALL_DIR/data"
ok "Dependencies installed"

# ============ 8. CONFIGURATION ============

echo ""
echo -e "${CYAN}Configuration${NC}"
echo "─────────────────────────────────────"
echo ""

# Workspace
echo -e "  Workspace = folder, w którym Claude CLI wykonuje joby."
echo -e "  To powinien być Twój vault Obsidian (lub inny projekt)."
echo ""

# Show what's available in claude home
if [ -d "$CLAUDE_HOME" ]; then
  DIRS_FOUND=$(su - "$CLAUDE_USER" -c "ls -d $CLAUDE_HOME/*/ 2>/dev/null" || true)
  if [ -n "$DIRS_FOUND" ]; then
    echo -e "  ${CYAN}Foldery w /home/$CLAUDE_USER/:${NC}"
    echo "$DIRS_FOUND" | while read -r d; do
      echo -e "    ${BOLD}$d${NC}"
    done
    echo ""
  fi
fi

ask "Ścieżka do workspace [$CLAUDE_HOME/workspace]: "
read -r WORKSPACE_INPUT
WORKSPACE="${WORKSPACE_INPUT:-$CLAUDE_HOME/workspace}"

# Strip quotes, backslash-escapes and spaces (drag & drop dodaje escapy)
WORKSPACE="${WORKSPACE//\'/}"
WORKSPACE="${WORKSPACE//\"/}"
WORKSPACE="${WORKSPACE//\\/}"
WORKSPACE="${WORKSPACE%% }"
WORKSPACE="${WORKSPACE## }"
WORKSPACE="${WORKSPACE/#\~/$CLAUDE_HOME}"

if [ ! -d "$WORKSPACE" ]; then
  ask "Folder nie istnieje. Utworzyć $WORKSPACE? [Y/n]: "
  read -r CREATE_WS
  CREATE_WS="${CREATE_WS:-Y}"
  if [[ "$CREATE_WS" =~ ^[Yy]$ ]]; then
    mkdir -p "$WORKSPACE"
    chown "$CLAUDE_USER:$CLAUDE_USER" "$WORKSPACE"
    ok "Utworzono: $WORKSPACE"
  else
    fail "Workspace nie istnieje: $WORKSPACE"
  fi
fi
ok "Workspace: $WORKSPACE"

# Port
ask "Port serwera [7777]: "
read -r PORT_INPUT
PORT="${PORT_INPUT:-7777}"
ok "Port: $PORT"

# Discord webhook (optional)
echo ""
ask "Discord webhook URL do powiadomień (puste = pomiń): "
read -r DISCORD_URL
DISCORD_URL="${DISCORD_URL:-}"
if [ -n "$DISCORD_URL" ]; then
  ok "Discord: configured"
fi

# Timezone
echo ""
CURRENT_TZ=$(timedatectl show -p Timezone --value 2>/dev/null || echo "UTC")
DEFAULT_TZ="Europe/Warsaw"
ask "Timezone [$DEFAULT_TZ]: "
read -r TZ_INPUT
TZ_INPUT="${TZ_INPUT:-$DEFAULT_TZ}"
if [ "$TZ_INPUT" != "$CURRENT_TZ" ]; then
  timedatectl set-timezone "$TZ_INPUT"
  ok "Timezone: $TZ_INPUT"
else
  ok "Timezone: $CURRENT_TZ (unchanged)"
fi

# ============ 9. SYSTEMD SERVICE ============

echo ""
info "Creating systemd service..."

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_PATH=$(which node)

# Build Environment lines
ENV_LINES="Environment=CLAUDE_CRON_PORT=$PORT
Environment=CLAUDE_CRON_WORKSPACE=$WORKSPACE
Environment=PATH=$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

if [ -n "$DISCORD_URL" ]; then
  ENV_LINES="$ENV_LINES
Environment=DISCORD_WEBHOOK_URL=$DISCORD_URL"
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Claude-Cron Skill Scheduler
After=network.target

[Service]
Type=simple
User=$CLAUDE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=10

$ENV_LINES

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "Service running"
else
  warn "Service failed to start. Check: journalctl -u $SERVICE_NAME -n 30"
fi

# ============ 10. FIREWALL ============

echo ""
info "Configuring firewall..."

if ! command -v ufw &>/dev/null; then
  info "Installing UFW..."
  apt-get update -qq && apt-get install -y -qq ufw
fi

if command -v ufw &>/dev/null; then
  # Always allow SSH first — never lock yourself out
  ufw allow 22/tcp 2>/dev/null || true

  if ! ufw status | grep -q "active"; then
    info "Enabling UFW..."
    ufw --force enable
  fi

  # DENY claude-cron port — access only via Tailscale
  if ufw status | grep -q "$PORT.*ALLOW"; then
    warn "Port $PORT is OPEN in UFW — closing it (Tailscale only)"
    ufw delete allow "$PORT/tcp" 2>/dev/null || true
    ufw delete allow "$PORT" 2>/dev/null || true
  fi
  ufw deny "$PORT/tcp" 2>/dev/null || true
  ok "Port $PORT blocked in UFW (access via Tailscale only)"
fi

# ============ 11. TAILSCALE ============

echo ""
echo -e "${CYAN}Tailscale & Webhooks${NC}"
echo "─────────────────────────────────────"
echo ""

if ! command -v tailscale &>/dev/null; then
  info "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh

  # Wait for tailscaled daemon to be fully ready
  info "Waiting for Tailscale daemon..."
  for i in $(seq 1 10); do
    if systemctl is-active --quiet tailscaled 2>/dev/null; then
      break
    fi
    sleep 1
  done
  sleep 2
fi

if command -v tailscale &>/dev/null; then
  ok "Tailscale installed"
  TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
  if [ -z "$TS_IP" ]; then
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  Tailscale needs to be connected.${NC}"
    echo -e "${YELLOW}  Run the command below and follow the login link.${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    ask "Connect Tailscale now? [Y/n]: "
    read -r DO_TS
    DO_TS="${DO_TS:-Y}"
    if [[ "$DO_TS" =~ ^[Yy]$ ]]; then
      tailscale up
    fi
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
  fi
  if [ -n "$TS_IP" ]; then
    ok "Tailscale IP: $TS_IP"
  else
    warn "Tailscale not connected — run 'tailscale up' later"
  fi
else
  warn "Tailscale installation failed"
  TS_IP=""
fi

# Tailscale Funnel for webhooks
echo ""
ask "Włączyć Tailscale Funnel dla webhooków? (wystawia /webhook/* na internet) [y/N]: "
read -r SETUP_FUNNEL
SETUP_FUNNEL="${SETUP_FUNNEL:-N}"

WEBHOOK_BASE_URL=""
if [[ "$SETUP_FUNNEL" =~ ^[Yy]$ ]]; then
  if command -v tailscale &>/dev/null; then
    info "Starting Tailscale Funnel on port $PORT..."
    tailscale funnel --bg "$PORT" 2>/dev/null || warn "Funnel failed — you may need to enable it in Tailscale admin"

    # Try to get funnel URL
    FUNNEL_STATUS=$(tailscale funnel status 2>/dev/null || echo "")
    if echo "$FUNNEL_STATUS" | grep -q "https://"; then
      WEBHOOK_BASE_URL=$(echo "$FUNNEL_STATUS" | grep -oP 'https://[^ ]+' | head -1 | sed 's/\/$//')
      ok "Funnel active: $WEBHOOK_BASE_URL"
    else
      ask "Enter your Tailscale Funnel URL (e.g., https://srv123.tail456.ts.net): "
      read -r WEBHOOK_BASE_URL
    fi

    # Add WEBHOOK_BASE_URL to systemd
    if [ -n "$WEBHOOK_BASE_URL" ]; then
      # Update service file with webhook URL
      sed -i "/SyslogIdentifier/i Environment=WEBHOOK_BASE_URL=$WEBHOOK_BASE_URL" "$SERVICE_FILE"
      systemctl daemon-reload
      systemctl restart "$SERVICE_NAME"
      sleep 1
      ok "WEBHOOK_BASE_URL set in systemd service"
    fi
  else
    warn "Tailscale not installed — skipping Funnel"
  fi
fi

# ============ 12. AUTO-UPDATE CRON ============

echo ""
echo -e "${CYAN}Auto-update${NC}"
echo "─────────────────────────────────────"
echo ""
echo -e "  Codzienny cron (6:00) — automatycznie pulluje"
echo -e "  vault-git i claude-cron, potem restartuje service."
echo ""

ask "Ustawić automatyczną aktualizację? [Y/n]: "
read -r SETUP_AUTOUPDATE
SETUP_AUTOUPDATE="${SETUP_AUTOUPDATE:-Y}"

if [[ "$SETUP_AUTOUPDATE" =~ ^[Yy]$ ]]; then
  # Passwordless sudo for service restart
  echo "$CLAUDE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE_NAME" > "/etc/sudoers.d/$SERVICE_NAME"
  chmod 440 "/etc/sudoers.d/$SERVICE_NAME"
  ok "Passwordless sudo for service restart"

  # Check if vault-git exists
  VAULT_GIT="$CLAUDE_HOME/vault-git"
  if [ ! -d "$VAULT_GIT/.git" ]; then
    ask "Ścieżka do vault-git repo [$VAULT_GIT]: "
    read -r VAULT_GIT_INPUT
    VAULT_GIT="${VAULT_GIT_INPUT:-$VAULT_GIT}"
    VAULT_GIT="${VAULT_GIT/#\~/$CLAUDE_HOME}"
  fi

  # Build cron command
  CRON_CMD="0 6 * * * su - $CLAUDE_USER -c \"cd $VAULT_GIT && git pull && cd $INSTALL_DIR && git pull\" && systemctl restart $SERVICE_NAME"

  # Add to root crontab (avoid duplicates)
  EXISTING_CRON=$(crontab -l 2>/dev/null | grep -v "$SERVICE_NAME" || true)
  if [ -n "$EXISTING_CRON" ]; then
    printf '%s\n%s\n' "$EXISTING_CRON" "$CRON_CMD" | crontab -
  else
    echo "$CRON_CMD" | crontab -
  fi
  ok "Cron: codziennie o 6:00 — auto-update + restart"
else
  info "Pominięto — możesz dodać ręcznie później"
fi

# ============ SUMMARY ============

echo ""
echo "========================================"
echo -e "${GREEN}🕹️  CLAUDE-CRON — VPS Setup Complete!${NC}"
echo "========================================"
echo ""
echo -e "  ${BOLD}Service:${NC}    $SERVICE_NAME (systemd)"
echo -e "  ${BOLD}User:${NC}       $CLAUDE_USER"
echo -e "  ${BOLD}Repo:${NC}       $INSTALL_DIR"
echo -e "  ${BOLD}Workspace:${NC}  $WORKSPACE"
echo -e "  ${BOLD}Port:${NC}       $PORT"

if [ -n "$TS_IP" ]; then
  echo -e "  ${BOLD}Dashboard:${NC}  ${CYAN}http://$TS_IP:$PORT${NC} (via Tailscale)"
fi
if [ -n "$WEBHOOK_BASE_URL" ]; then
  echo -e "  ${BOLD}Webhooks:${NC}   ${CYAN}$WEBHOOK_BASE_URL/webhook/<token>${NC}"
fi
if [ -n "$DISCORD_URL" ]; then
  echo -e "  ${BOLD}Discord:${NC}    enabled"
fi

echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo "    systemctl status $SERVICE_NAME        # check status"
echo "    journalctl -u $SERVICE_NAME -f        # live logs"
echo "    systemctl restart $SERVICE_NAME       # restart"
echo "    su - $CLAUDE_USER -c 'cd ~/claude-cron && git pull'  # update code"
echo ""

if [ -n "$TS_IP" ]; then
  echo -e "  ${BOLD}Connect from your Mac:${NC}"
  echo "    Add to ~/.zshrc:"
  echo "      export CLAUDE_CRON_VPS_URL=http://$TS_IP:$PORT"
  echo ""
fi

echo -e "  ${BOLD}Security:${NC}"
echo "    - Port $PORT is BLOCKED in firewall (Tailscale access only)"
echo "    - Dashboard is not accessible from the public internet"
echo "    - Only /webhook/* endpoints are exposed via Tailscale Funnel"
echo "    - Claude CLI runs as dedicated '$CLAUDE_USER' user (not root)"
echo ""
