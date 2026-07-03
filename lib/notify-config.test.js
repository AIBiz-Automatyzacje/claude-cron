const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  NOTIFY_STATE_KEYS,
  resolveNotifyConfig,
  maskSecret,
  buildMaskedNotifySettings,
  sanitizeNotifySettings,
} = require('./notify-config');

// Fake stateGetter — kontrakt db.getState: string albo null gdy klucza brak.
function makeStateGetter(map) {
  return (key) => (key in map ? map[key] : null);
}

// --- resolveNotifyConfig ---

test('resolveNotifyConfig: state ustawiony → wygrywa z env', () => {
  // Arrange
  const stateGetter = makeStateGetter({
    discord_webhook_url: 'https://discord.com/api/webhooks/1/state-abcd',
    telegram_bot_token: '111:state-token',
    telegram_chat_id: '42',
  });
  const env = {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/9/env-zzzz',
    TELEGRAM_BOT_TOKEN: '999:env-token',
    TELEGRAM_CHAT_ID: '99',
  };

  // Act
  const config = resolveNotifyConfig(stateGetter, env);

  // Assert
  assert.equal(config.discordWebhookUrl, 'https://discord.com/api/webhooks/1/state-abcd');
  assert.equal(config.telegramBotToken, '111:state-token');
  assert.equal(config.telegramChatId, '42');
});

test('resolveNotifyConfig: state pusty string + env ustawione → env (czyszczenie nie blokuje fallbacku)', () => {
  // Arrange — pusty string w state = "brak wartości w state", NIE nadpisanie env pustym
  const stateGetter = makeStateGetter({
    discord_webhook_url: '',
    telegram_bot_token: '',
    telegram_chat_id: '',
  });
  const env = {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/9/env-zzzz',
    TELEGRAM_BOT_TOKEN: '999:env-token',
    TELEGRAM_CHAT_ID: '99',
  };

  // Act
  const config = resolveNotifyConfig(stateGetter, env);

  // Assert
  assert.equal(config.discordWebhookUrl, 'https://discord.com/api/webhooks/9/env-zzzz');
  assert.equal(config.telegramBotToken, '999:env-token');
  assert.equal(config.telegramChatId, '99');
});

test('resolveNotifyConfig: brak klucza w state (null) + env ustawione → env', () => {
  const config = resolveNotifyConfig(makeStateGetter({}), {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/9/env-zzzz',
  });
  assert.equal(config.discordWebhookUrl, 'https://discord.com/api/webhooks/9/env-zzzz');
});

test('resolveNotifyConfig: oba puste → kanał nieskonfigurowany (puste stringi)', () => {
  const config = resolveNotifyConfig(makeStateGetter({}), {});
  assert.deepEqual(config, { discordWebhookUrl: '', telegramBotToken: '', telegramChatId: '' });
});

test('resolveNotifyConfig: wartości są trimowane', () => {
  const config = resolveNotifyConfig(
    makeStateGetter({ telegram_bot_token: '  111:token  ' }),
    {},
  );
  assert.equal(config.telegramBotToken, '111:token');
});

// --- maskSecret ---

test('maskSecret: token 46-znakowy → "…" + ostatnie 4 znaki', () => {
  // Arrange — realistyczna długość tokena bota Telegram
  const token = '1234567890:' + 'A'.repeat(31) + 'wxyz';
  assert.equal(token.length, 46);

  // Act / Assert
  assert.equal(maskSecret(token), '…wxyz');
});

test('maskSecret: pusta wartość → null', () => {
  assert.equal(maskSecret(''), null);
  assert.equal(maskSecret(undefined), null);
});

// --- buildMaskedNotifySettings ---

test('buildMaskedNotifySettings: pełna konfiguracja → configured + maski, chat_id jawny', () => {
  // Arrange
  const config = {
    discordWebhookUrl: 'https://discord.com/api/webhooks/1/token-abcd',
    telegramBotToken: '111:secret-wxyz',
    telegramChatId: '42',
  };

  // Act
  const masked = buildMaskedNotifySettings(config);

  // Assert — sekrety nigdy w pełnej formie
  assert.deepEqual(masked, {
    discord: { configured: true, masked: '…abcd' },
    telegram: { configured: true, masked_token: '…wxyz', chat_id: '42' },
  });
  assert.ok(!JSON.stringify(masked).includes('secret'));
});

test('buildMaskedNotifySettings: puste wartości → configured:false, maski null', () => {
  const masked = buildMaskedNotifySettings({
    discordWebhookUrl: '',
    telegramBotToken: '',
    telegramChatId: '',
  });
  assert.deepEqual(masked, {
    discord: { configured: false, masked: null },
    telegram: { configured: false, masked_token: null, chat_id: null },
  });
});

test('buildMaskedNotifySettings: sam token bez chat_id → telegram nieskonfigurowany', () => {
  const masked = buildMaskedNotifySettings({
    discordWebhookUrl: '',
    telegramBotToken: '111:secret-wxyz',
    telegramChatId: '',
  });
  assert.equal(masked.telegram.configured, false);
  assert.equal(masked.telegram.masked_token, '…wxyz');
});

// --- sanitizeNotifySettings ---

test('sanitizeNotifySettings: poprawny podzbiór kluczy → ok + trimowane updates', () => {
  const result = sanitizeNotifySettings({ discord_webhook_url: '  https://d/x  ' });
  assert.deepEqual(result, { ok: true, updates: { discord_webhook_url: 'https://d/x' } });
});

test('sanitizeNotifySettings: pusty string legalny (czyści klucz)', () => {
  const result = sanitizeNotifySettings({ telegram_bot_token: '' });
  assert.deepEqual(result, { ok: true, updates: { telegram_bot_token: '' } });
});

test('sanitizeNotifySettings: nieznany klucz odrzucony', () => {
  const result = sanitizeNotifySettings({ evil_key: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown key: evil_key/);
});

test('sanitizeNotifySettings: nie-string odrzucony', () => {
  const result = sanitizeNotifySettings({ telegram_chat_id: 42 });
  assert.equal(result.ok, false);
  assert.match(result.error, /telegram_chat_id must be a string/);
});

test('sanitizeNotifySettings: body nie-obiekt → odrzucone', () => {
  assert.equal(sanitizeNotifySettings(null).ok, false);
  assert.equal(sanitizeNotifySettings([1, 2]).ok, false);
  assert.equal(sanitizeNotifySettings('str').ok, false);
});

test('sanitizeNotifySettings: pusty obiekt → ok, zero updates (no-op PUT)', () => {
  assert.deepEqual(sanitizeNotifySettings({}), { ok: true, updates: {} });
});

test('NOTIFY_STATE_KEYS: dokładnie trzy klucze whitelisty', () => {
  assert.deepEqual(NOTIFY_STATE_KEYS, ['discord_webhook_url', 'telegram_bot_token', 'telegram_chat_id']);
});
