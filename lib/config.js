const path = require('node:path');
const os = require('node:os');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const HOME = os.homedir();
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'claude-cron.db');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// Workspace — CWD for Claude CLI (configurable via env, defaults to cwd)
const WORKSPACE_DIR = process.env.CLAUDE_CRON_WORKSPACE || process.cwd();
const SKILLS_DIR = path.join(WORKSPACE_DIR, '.claude', 'skills');
const GLOBAL_SKILLS_DIR = path.join(HOME, '.claude', 'skills');

const PORT = parseInt(process.env.CLAUDE_CRON_PORT || '7777', 10);

// VPS proxy (only used on local instance)
const VPS_API_URL = process.env.CLAUDE_CRON_VPS_URL || '';

// Discord webhook for job notifications
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

// Telegram bot for job notifications — env to fallback; źródłem prawdy jest state w DB
// (rozwiązywanie state > env w czasie wysyłki: lib/notify-config.js)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Defaults
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — fallback default if job has no idle_timeout_ms
const DEFAULT_IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS;
const WATCHDOG_INTERVAL_MS = 30_000; // 30s — wall-clock backup for idle timeout (survives Mac sleep)
const DEFAULT_MAX_RETRIES = 1;
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s
const POLL_INTERVAL_MS = 3000; // frontend polling
const MAX_LOG_SIZE = 50 * 1024; // 50KB stdout/stderr cap

// Webhooks
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED !== '0'; // enabled by default, set WEBHOOK_ENABLED=0 to disable
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || ''; // public URL for webhook links (e.g. https://srv123.tail456.ts.net)

// Ask (asystent głosowy)
// Opt-in (odwrotnie niż WEBHOOK_ENABLED): endpoint publiczny z sekretem, więc domyślnie WYŁĄCZONY —
// truthy tylko przy jawnym ASK_ENABLED=1. Sekrety wyłącznie z env (na VPS), zero defaultów w repo.
const ASK_ENABLED = process.env.ASK_ENABLED === '1';
const ASK_TOKEN = process.env.ASK_TOKEN || '';
const ASK_SECRET = process.env.ASK_SECRET || '';
const ASK_TIMEOUT_MS = 55_000; // okno synchronicznej odpowiedzi — poniżej limitu 60s klienta głosowego
const ASK_MAX_MS = 10 * 60 * 1000; // twardy limit życia odczepionego procesu tła
const ASK_MODEL = 'sonnet';


// Maintenance window — nocny restart VPS (auto-update git pull + systemctl restart) o 02:00.
// Joby zaplanowane w tym oknie mogą zostać przegapione, gdy serwer jest w trakcie restartu.
const MAINTENANCE_WINDOW = { startHour: 2, startMin: 0, endHour: 2, endMin: 15 };

// Claude CLI
const CLAUDE_BIN = 'claude';

// Wspierany zakres Node — musi być spójny z "engines" w package.json (>=22.13 <25).
// Guard startowy (lib/runtime-guard.js) odmawia startu poza tym zakresem.
const MIN_NODE_VERSION = '22.13'; // node:sqlite stabilne dopiero od 22.5; 22.13 = floor testowany w projekcie
const MAX_NODE_VERSION = '25'; // wykluczające: dozwolone <25 (czyli major 22/23/24)

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
  GLOBAL_SKILLS_DIR,
  PORT,
  VPS_API_URL,
  DISCORD_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  DEFAULT_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  DEFAULT_MAX_RETRIES,
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
  MAX_LOG_SIZE,
  WEBHOOK_ENABLED,
  WEBHOOK_BASE_URL,
  ASK_ENABLED,
  ASK_TOKEN,
  ASK_SECRET,
  ASK_TIMEOUT_MS,
  ASK_MAX_MS,
  ASK_MODEL,
  MAINTENANCE_WINDOW,
  CLAUDE_BIN,
  MIN_NODE_VERSION,
  MAX_NODE_VERSION,
};
