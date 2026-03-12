const path = require('node:path');
const os = require('node:os');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const HOME = os.homedir();
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'claude-cron.db');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// Obsidian workspace — CWD for claude CLI (configurable via env)
const DEFAULT_WORKSPACE = path.join(HOME, 'Documents', 'kacper_trzepiecinski_workspace');
const WORKSPACE_DIR = process.env.CLAUDE_CRON_WORKSPACE || DEFAULT_WORKSPACE;
const SKILLS_DIR = path.join(WORKSPACE_DIR, '.claude', 'skills');

const PORT = parseInt(process.env.CLAUDE_CRON_PORT || '7777', 10);

// VPS proxy (only used on local instance)
const VPS_API_URL = process.env.CLAUDE_CRON_VPS_URL || '';

// Discord webhook for job notifications
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

// Defaults
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — kill if no stdout chunks
const WATCHDOG_INTERVAL_MS = 30_000; // 30s — wall-clock backup for idle timeout (survives Mac sleep)
const DEFAULT_MAX_RETRIES = 1;
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s
const POLL_INTERVAL_MS = 3000; // frontend polling
const MAX_LOG_SIZE = 50 * 1024; // 50KB stdout/stderr cap

// Claude CLI
const CLAUDE_BIN = 'claude';

module.exports = {
  IS_MAC,
  IS_WIN,
  HOME,
  PROJECT_ROOT,
  DATA_DIR,
  DB_PATH,
  PUBLIC_DIR,
  WORKSPACE_DIR,
  SKILLS_DIR,
  PORT,
  VPS_API_URL,
  DISCORD_WEBHOOK_URL,
  DEFAULT_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  DEFAULT_MAX_RETRIES,
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
  MAX_LOG_SIZE,
  CLAUDE_BIN,
};
