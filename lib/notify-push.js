// Push konfiguracji powiadomień na VPS (R10): lokalny serwer czyta PEŁNE wartości
// z własnego state/env i PUT-uje na VPS — dashboard nigdy nie operuje pełnymi sekretami.
// Zapis potwierdzany GET-em po PUT (learned pattern: fałszywe sygnały statusów —
// kod odpowiedzi to nie stan faktyczny). Kontrakt: NIGDY nie rzuca — zawsze { ok, reason? }.
// Konsumenci: POST /api/settings/notifications/push-to-vps (server.js) i setup.mjs (Unit 6).

const { maskSecret } = require('./notify-config');

const SETTINGS_PATH = '/api/settings/notifications';
const PUSH_TIMEOUT_MS = 10_000; // spójny z timeoutem proxy /api/vps/* w server.js

// Resolved config (camelCase) → payload PUT (klucze state). Tylko niepuste wartości —
// push nie czyści konfiguracji na VPS. Wszystko puste → null (nic do wypchnięcia).
function buildPushPayload(config) {
  const payload = {};
  if (config.discordWebhookUrl) payload.discord_webhook_url = config.discordWebhookUrl;
  if (config.telegramBotToken) payload.telegram_bot_token = config.telegramBotToken;
  if (config.telegramChatId) payload.telegram_chat_id = config.telegramChatId;
  return Object.keys(payload).length > 0 ? payload : null;
}

// Porównuje zamaskowaną odpowiedź GET z wypchniętymi wartościami — maska (ostatnie 4 znaki)
// musi się zgadzać dla każdego wypchniętego klucza, chat_id porównywany wprost (jawny).
function isPushConfirmed(masked, settings) {
  if (settings.discord_webhook_url
    && masked?.discord?.masked !== maskSecret(settings.discord_webhook_url)) return false;
  if (settings.telegram_bot_token
    && masked?.telegram?.masked_token !== maskSecret(settings.telegram_bot_token)) return false;
  if (settings.telegram_chat_id
    && masked?.telegram?.chat_id !== settings.telegram_chat_id) return false;
  return true;
}

async function pushNotifySettings({ vpsUrl, settings, fetchImpl = fetch, timeoutMs = PUSH_TIMEOUT_MS }) {
  if (!vpsUrl) return { ok: false, reason: 'vps_not_configured' };
  if (!settings || Object.keys(settings).length === 0) return { ok: false, reason: 'nothing_to_push' };

  // Parsowanie vpsUrl POD kontraktem "nigdy nie rzuca": CLAUDE_CRON_VPS_URL bez
  // protokołu (np. 'localhost:7777') rzuca TypeError: Invalid URL — mapujemy na reason.
  let url;
  try {
    url = new URL(SETTINGS_PATH, vpsUrl).toString();
  } catch {
    return { ok: false, reason: 'invalid_vps_url' };
  }

  try {
    const putRes = await fetchImpl(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (putRes.status === 404) {
      // Stary serwer VPS bez endpointu settings — wymaga aktualizacji (cron auto-update 02:00)
      return { ok: false, reason: 'endpoint_missing' };
    }
    if (!putRes.ok) return { ok: false, reason: `put_failed_${putRes.status}` };

    const getRes = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!getRes.ok) return { ok: false, reason: `confirm_failed_${getRes.status}` };

    const masked = await getRes.json();
    if (!isPushConfirmed(masked, settings)) return { ok: false, reason: 'confirm_mismatch' };
    return { ok: true };
  } catch (err) {
    const isTimeout = err && err.name === 'TimeoutError';
    return { ok: false, reason: isTimeout ? 'timeout' : `error_${err && err.message}` };
  }
}

module.exports = { pushNotifySettings, buildPushPayload, isPushConfirmed, SETTINGS_PATH };
