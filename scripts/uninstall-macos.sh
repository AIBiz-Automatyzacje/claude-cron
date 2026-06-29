#!/bin/bash
set -euo pipefail

# ============================================
#  CLAUDE-CRON — Deinstalacja autostartu (macOS/Linux)
#
#  Nowy layout (Unit 4/5): hook autostartu w {workspace}/.claude/hooks/
#  + wpis w {workspace}/.claude/settings.json pod hooks.UserPromptSubmit.
#  Logika usuwania wpisu jest WSPÓLNA z setup.mjs (removeHookFromSettings) —
#  jedno źródło prawdy o markerze 'claude-cron-autostart'.
#
#  Confirm-before-delete: portable Node (~50 MB w .node/) NIE jest kasowany
#  bez jawnej flagi --remove-node (memory: potwierdzaj destrukcję).
#
#  Użycie:
#    bash scripts/uninstall-macos.sh [WORKSPACE] [--remove-node]
#    WORKSPACE: ścieżka workspace (domyślnie $HOME — spójna z domyślną odpowiedzią setupu)
# ============================================

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$HOME"
REMOVE_NODE=0

for arg in "$@"; do
  case "$arg" in
    --remove-node) REMOVE_NODE=1 ;;
    -*) echo "[error] Nieznana flaga: $arg" >&2; exit 1 ;;
    *) WORKSPACE="$arg" ;;
  esac
done

echo "🕹️  CLAUDE-CRON — Deinstalacja autostartu"
echo ""
echo "[info] Workspace: $WORKSPACE"

HOOK_FILE="$WORKSPACE/.claude/hooks/claude-cron-autostart.js"
SETTINGS_FILE="$WORKSPACE/.claude/settings.json"

# Wybór Node: preferuj portable z .node/, fallback na systemowy.
NODE_BIN=""
PORTABLE_NODE="$(find "$REPO_DIR/.node" -type f -name node -path '*/bin/node' 2>/dev/null | head -n1 || true)"
if [ -n "$PORTABLE_NODE" ]; then
  NODE_BIN="$PORTABLE_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

# Usuń wpis hooka z settings.json przez wspólny helper removeHookFromSettings.
if [ -f "$SETTINGS_FILE" ]; then
  if [ -z "$NODE_BIN" ]; then
    echo "[warn] Nie znaleziono Node (ani w .node/, ani w PATH) — pomijam edycję settings.json."
    echo "       Usuń ręcznie wpis 'claude-cron-autostart' z $SETTINGS_FILE"
  else
    "$NODE_BIN" --input-type=module -e "
      import fs from 'node:fs';
      import { removeHookFromSettings } from '$REPO_DIR/setup.mjs';
      const file = process.argv[1];
      const existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const { settings, removed } = removeHookFromSettings(existing);
      fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
      console.log(removed ? '[ok] Wpis hooka usunięty z settings.json.' : '[info] Brak wpisu hooka w settings.json — nic do usunięcia.');
    " "$SETTINGS_FILE"
  fi
else
  echo "[info] Brak $SETTINGS_FILE — nic do wyczyszczenia."
fi

# Usuń plik hooka.
if [ -f "$HOOK_FILE" ]; then
  rm -f "$HOOK_FILE"
  echo "[ok] Plik hooka usunięty: $HOOK_FILE"
else
  echo "[info] Brak pliku hooka — nic do usunięcia."
fi

# Portable Node — tylko za jawną zgodą (confirm-before-delete).
if [ "$REMOVE_NODE" -eq 1 ]; then
  if [ -d "$REPO_DIR/.node" ]; then
    rm -rf "$REPO_DIR/.node"
    echo "[ok] Portable Node usunięty: $REPO_DIR/.node"
  else
    echo "[info] Brak katalogu .node/ — nic do usunięcia."
  fi
else
  echo "[info] Portable Node (.node/, ~50 MB) zachowany. Usuń go: bash scripts/uninstall-macos.sh \"$WORKSPACE\" --remove-node"
fi

echo ""
echo "✅ Autostart usunięty. Serwer nie wystartuje już automatycznie."
echo "   Twoje zadania i dane pozostają nietknięte."
