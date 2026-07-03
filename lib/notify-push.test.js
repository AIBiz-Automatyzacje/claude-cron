const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMaskedNotifySettings } = require('./notify-config');
const { pushNotifySettings, buildPushPayload, isPushConfirmed, SETTINGS_PATH } = require('./notify-push');

const VPS_URL = 'http://100.64.0.1:7777';
const SETTINGS = {
  discord_webhook_url: 'https://discord.com/api/webhooks/1/token-abcd',
  telegram_bot_token: '111:secret-wxyz',
  telegram_chat_id: '42',
};

// Zamaskowana odpowiedź GET, jaką zwróciłby VPS PO poprawnym zapisie tych settings.
function maskedResponseFor(settings) {
  return buildMaskedNotifySettings({
    discordWebhookUrl: settings.discord_webhook_url || '',
    telegramBotToken: settings.telegram_bot_token || '',
    telegramChatId: settings.telegram_chat_id || '',
  });
}

function mockResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Mock fetch nagrywający wywołania; odpowiedzi zdejmowane z kolejki.
function makeFetchMock(responses) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return responses.shift();
  };
  return { fetchImpl, calls };
}

// --- pushNotifySettings ---

test('pushNotifySettings: sukces potwierdzony GET-em po PUT', async () => {
  // Arrange — PUT 200, potem GET zwraca maski zgodne z wypchniętymi wartościami
  const { fetchImpl, calls } = makeFetchMock([
    mockResponse(200, {}),
    mockResponse(200, maskedResponseFor(SETTINGS)),
  ]);

  // Act
  const result = await pushNotifySettings({ vpsUrl: VPS_URL, settings: SETTINGS, fetchImpl });

  // Assert — dokładnie 2 wywołania: PUT z pełnym payloadem, potem GET na ten sam URL
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, VPS_URL + SETTINGS_PATH);
  assert.equal(calls[0].opts.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].opts.body), SETTINGS);
  assert.equal(calls[1].url, VPS_URL + SETTINGS_PATH);
  assert.equal(calls[1].opts.method, 'GET');
});

test('pushNotifySettings: VPS bez endpointu (404, stary serwer) → {ok:false, reason} bez rzucania', async () => {
  // Arrange
  const { fetchImpl, calls } = makeFetchMock([mockResponse(404, { error: 'Not found' })]);

  // Act — nie może rzucić
  const result = await pushNotifySettings({ vpsUrl: VPS_URL, settings: SETTINGS, fetchImpl });

  // Assert — bez próby potwierdzenia GET-em
  assert.deepEqual(result, { ok: false, reason: 'endpoint_missing' });
  assert.equal(calls.length, 1);
});

test('pushNotifySettings: timeout → {ok:false, reason:"timeout"}', async () => {
  // Arrange — fetch wisi w nieskończoność, reaguje tylko na abort z AbortSignal.timeout.
  // Timer AbortSignal.timeout jest unref'owany — bez ref'owanego keep-alive event loop
  // testu umarłby zanim abort odpali (Promise pending → test cancelled).
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const keepAlive = setTimeout(() => {}, 5000);

  try {
    // Act
    const result = await pushNotifySettings({ vpsUrl: VPS_URL, settings: SETTINGS, fetchImpl, timeoutMs: 20 });

    // Assert
    assert.deepEqual(result, { ok: false, reason: 'timeout' });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('pushNotifySettings: GET po zapisie nie potwierdza wartości → confirm_mismatch', async () => {
  // Arrange — VPS odpowiada 200 na PUT, ale GET pokazuje pusty stan (zapis się nie przyjął)
  const { fetchImpl } = makeFetchMock([
    mockResponse(200, {}),
    mockResponse(200, maskedResponseFor({})),
  ]);

  // Act
  const result = await pushNotifySettings({ vpsUrl: VPS_URL, settings: SETTINGS, fetchImpl });

  // Assert — kod 200 na PUT to za mało, liczy się stan faktyczny
  assert.deepEqual(result, { ok: false, reason: 'confirm_mismatch' });
});

test('pushNotifySettings: PUT z błędem 500 → put_failed_500 bez rzucania', async () => {
  const { fetchImpl } = makeFetchMock([mockResponse(500, {})]);
  const result = await pushNotifySettings({ vpsUrl: VPS_URL, settings: SETTINGS, fetchImpl });
  assert.deepEqual(result, { ok: false, reason: 'put_failed_500' });
});

test('pushNotifySettings: błąd sieci (fetch rzuca) → {ok:false} bez rzucania', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const result = await pushNotifySettings({ vpsUrl: VPS_URL, settings: SETTINGS, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
});

test('pushNotifySettings: brak vpsUrl → vps_not_configured, zero wywołań sieciowych', async () => {
  const { fetchImpl, calls } = makeFetchMock([]);
  const result = await pushNotifySettings({ vpsUrl: '', settings: SETTINGS, fetchImpl });
  assert.deepEqual(result, { ok: false, reason: 'vps_not_configured' });
  assert.equal(calls.length, 0);
});

test('pushNotifySettings: puste settings → nothing_to_push, zero wywołań sieciowych', async () => {
  const { fetchImpl, calls } = makeFetchMock([]);
  assert.deepEqual(
    await pushNotifySettings({ vpsUrl: VPS_URL, settings: null, fetchImpl }),
    { ok: false, reason: 'nothing_to_push' },
  );
  assert.deepEqual(
    await pushNotifySettings({ vpsUrl: VPS_URL, settings: {}, fetchImpl }),
    { ok: false, reason: 'nothing_to_push' },
  );
  assert.equal(calls.length, 0);
});

// --- buildPushPayload ---

test('buildPushPayload: pełny config → payload z kluczami state', () => {
  const payload = buildPushPayload({
    discordWebhookUrl: 'https://d/x-abcd',
    telegramBotToken: '111:t-wxyz',
    telegramChatId: '42',
  });
  assert.deepEqual(payload, {
    discord_webhook_url: 'https://d/x-abcd',
    telegram_bot_token: '111:t-wxyz',
    telegram_chat_id: '42',
  });
});

test('buildPushPayload: tylko niepuste wartości; wszystko puste → null (pomiń push)', () => {
  assert.deepEqual(
    buildPushPayload({ discordWebhookUrl: 'https://d/x', telegramBotToken: '', telegramChatId: '' }),
    { discord_webhook_url: 'https://d/x' },
  );
  assert.equal(
    buildPushPayload({ discordWebhookUrl: '', telegramBotToken: '', telegramChatId: '' }),
    null,
  );
});

// --- isPushConfirmed ---

test('isPushConfirmed: częściowy push (sam Discord) ignoruje stan Telegrama', () => {
  const settings = { discord_webhook_url: 'https://d/x-abcd' };
  const masked = maskedResponseFor(settings);
  assert.equal(isPushConfirmed(masked, settings), true);
});

test('isPushConfirmed: rozjazd maski → false; brak kluczy w odpowiedzi → false', () => {
  const settings = { telegram_bot_token: '111:t-wxyz' };
  assert.equal(isPushConfirmed(maskedResponseFor({ telegram_bot_token: '111:t-inne' }), settings), false);
  assert.equal(isPushConfirmed({}, settings), false);
});
