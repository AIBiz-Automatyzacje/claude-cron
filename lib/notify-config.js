// Konfiguracja powiadomień: state (DB) > env fallback — rozwiązywana w CZASIE WYSYŁKI,
// nie przy require (stary discord.js zamrażał DISCORD_WEBHOOK_URL przy imporcie, więc
// zmiana z dashboardu wymagałaby restartu). Czyste funkcje: stateGetter i env wstrzykiwane.

const NOTIFY_STATE_KEYS = ['discord_webhook_url', 'telegram_bot_token', 'telegram_chat_id'];

// Mapowanie klucz state → env fallback (R3: istniejące instalacje z env działają bez zmian).
const ENV_FALLBACK = {
  discord_webhook_url: 'DISCORD_WEBHOOK_URL',
  telegram_bot_token: 'TELEGRAM_BOT_TOKEN',
  telegram_chat_id: 'TELEGRAM_CHAT_ID',
};

const MASK_VISIBLE_CHARS = 4;

function resolveKey(stateGetter, env, key) {
  // Pusty string w state = "brak wartości w state" (czyszczenie z UI), NIE "nadpisz env pustym"
  // — fallback env dalej działa. Semantyka utrwalona w testach.
  const fromState = stateGetter(key);
  if (typeof fromState === 'string' && fromState.trim() !== '') return fromState.trim();
  const fromEnv = env[ENV_FALLBACK[key]];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return '';
}

function resolveNotifyConfig(stateGetter, env) {
  return {
    discordWebhookUrl: resolveKey(stateGetter, env, 'discord_webhook_url'),
    telegramBotToken: resolveKey(stateGetter, env, 'telegram_bot_token'),
    telegramChatId: resolveKey(stateGetter, env, 'telegram_chat_id'),
  };
}

function maskSecret(value) {
  return value ? `…${value.slice(-MASK_VISIBLE_CHARS)}` : null;
}

// Kształt odpowiedzi GET /api/settings/notifications — sekrety NIGDY w pełnej formie.
function buildMaskedNotifySettings(config) {
  return {
    discord: {
      configured: !!config.discordWebhookUrl,
      masked: maskSecret(config.discordWebhookUrl),
    },
    telegram: {
      // Telegram wymaga OBU wartości do wysyłki — sam token to jeszcze nie konfiguracja
      configured: !!(config.telegramBotToken && config.telegramChatId),
      masked_token: maskSecret(config.telegramBotToken),
      chat_id: config.telegramChatId || null,
    },
  };
}

// Sanityzacja body PUT: whitelist trzech kluczy, wyłącznie stringi.
// Pusty string jest LEGALNY — czyści klucz w state (fallback env przejmuje).
function sanitizeNotifySettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const updates = {};
  for (const [key, value] of Object.entries(body)) {
    if (!NOTIFY_STATE_KEYS.includes(key)) {
      return { ok: false, error: `unknown key: ${key}` };
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `${key} must be a string` };
    }
    updates[key] = value.trim();
  }
  return { ok: true, updates };
}

module.exports = {
  NOTIFY_STATE_KEYS,
  resolveNotifyConfig,
  maskSecret,
  buildMaskedNotifySettings,
  sanitizeNotifySettings,
};
