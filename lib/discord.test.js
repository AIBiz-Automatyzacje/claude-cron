const { EventEmitter } = require('node:events');
const https = require('node:https');
const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');
const { sendNotification, sendFailureNotification, sendPlain } = require('./discord');

// Testy wiringu sendNotification → resolveNotifyConfig(db.getState, process.env):
// webhook URL rozwiązywany przy KAŻDEJ wysyłce (state > env), nie zamrożony przy require.
// Mockujemy TYLKO zewnętrzny serwis (https.request) — db jest realny, in-memory.

const STATE_WEBHOOK = 'https://discord.com/api/webhooks/1/state-token';
const ENV_WEBHOOK = 'https://env.example.com/api/webhooks/2/env-token';
const JOB = { name: 'test-job' };

const savedEnvWebhook = process.env.DISCORD_WEBHOOK_URL;

before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
  // przywrócenie env — testy nie mogą śmiecić w środowisku innych plików testowych
  if (savedEnvWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = savedEnvWebhook;
});

beforeEach(() => {
  db.setState('discord_webhook_url', '');
  delete process.env.DISCORD_WEBHOOK_URL;
});

// Fake https.request: nagrywa options, odpowiada 204 (jak realny webhook Discorda).
// discord.js trzyma referencję do TEGO SAMEGO zcache'owanego modułu node:https,
// więc mock.method na nim przechwytuje wysyłkę bez dotykania sieci.
function mockHttpsRequest(t) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 204;
      callback(res);
      res.emit('end');
    };
    return req;
  });
  return calls;
}

test('sendNotification: URL ze state wygrywa nad env', async (t) => {
  // Arrange — oba źródła skonfigurowane, state ma priorytet
  const calls = mockHttpsRequest(t);
  db.setState('discord_webhook_url', STATE_WEBHOOK);
  process.env.DISCORD_WEBHOOK_URL = ENV_WEBHOOK;

  // Act
  await sendNotification(JOB, 'wynik joba');

  // Assert — wysyłka poszła na host/path ze state, nie z env
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'discord.com');
  assert.equal(calls[0].path, '/api/webhooks/1/state-token');
  assert.equal(calls[0].method, 'POST');
});

test('sendNotification: pusty state → fallback na env (R3)', async (t) => {
  // Arrange — state pusty (wyczyszczony z UI), env skonfigurowany
  const calls = mockHttpsRequest(t);
  process.env.DISCORD_WEBHOOK_URL = ENV_WEBHOOK;

  // Act
  await sendNotification(JOB, 'wynik joba');

  // Assert
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'env.example.com');
  assert.equal(calls[0].path, '/api/webhooks/2/env-token');
});

test('sendNotification: state i env puste → early return, zero prób sieciowych', async (t) => {
  // Arrange — beforeEach wyczyścił oba źródła
  const calls = mockHttpsRequest(t);

  // Act — nie może rzucić ani nic wysłać
  await sendNotification(JOB, 'wynik joba');

  // Assert
  assert.equal(calls.length, 0);
});

// Fake https.request nagrywający też body — dla asercji na treści embeda (wariant ❌, R9).
// Osobny helper zamiast zmiany mockHttpsRequest: istniejące testy polegają na calls[i] = options.
function mockHttpsRequestWithBody(t) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter();
    req.end = (data) => {
      calls.push({ options, body: JSON.parse(data) });
      const res = new EventEmitter();
      res.statusCode = 204;
      callback(res);
      res.emit('end');
    };
    return req;
  });
  return calls;
}

test('sendFailureNotification: brak konfiguracji → zero prób sieciowych', async (t) => {
  // Arrange — beforeEach wyczyścił state i env
  const calls = mockHttpsRequestWithBody(t);

  // Act
  await sendFailureNotification(JOB, { status: 'failed', error_msg: 'boom', stderr: '' });

  // Assert
  assert.equal(calls.length, 0);
});

test('sendFailureNotification: czerwony embed ❌ ze statusem i error_msg (R9)', async (t) => {
  // Arrange
  const calls = mockHttpsRequestWithBody(t);
  db.setState('discord_webhook_url', STATE_WEBHOOK);

  // Act
  await sendFailureNotification(JOB, { status: 'timeout', error_msg: 'Timeout exceeded', stderr: 'ogon stderr' });

  // Assert — jeden POST, embed czerwony, error_msg wygrywa nad stderr
  assert.equal(calls.length, 1);
  const embed = calls[0].body.embeds[0];
  assert.equal(embed.title, '❌ test-job padł (timeout)');
  assert.equal(embed.description, 'Timeout exceeded');
  assert.equal(embed.color, 0xFF0000);
});

test('sendFailureNotification: brak error_msg → ogon stderr w opisie', async (t) => {
  // Arrange — stderr dłuższy niż ogon (1000 znaków); przyczyna na końcu
  const calls = mockHttpsRequestWithBody(t);
  db.setState('discord_webhook_url', STATE_WEBHOOK);
  const stderr = 'DIAG '.repeat(400) + 'Error: connection refused';

  // Act
  await sendFailureNotification(JOB, { status: 'failed', error_msg: '', stderr });

  // Assert
  assert.equal(calls.length, 1);
  const description = calls[0].body.embeds[0].description;
  assert.ok(description.endsWith('Error: connection refused'), 'ogon stderr musi być w opisie');
  assert.ok(description.length <= 2000, 'opis embeda w limicie Discorda');
});

// === sendPlain — seam plain-text dla ask (Unit 4) ===

test('sendPlain: brak konfiguracji → zero prób sieciowych', async (t) => {
  // Arrange — beforeEach wyczyścił state i env
  const calls = mockHttpsRequestWithBody(t);

  // Act — nie może rzucić ani nic wysłać
  await sendPlain('✅ Asystent głosowy\nwynik');

  // Assert
  assert.equal(calls.length, 0);
});

test('sendPlain: surowy tekst jako content bez embedów, długi tekst w chunkach ≤2000', async (t) => {
  // Arrange — tekst dłuższy niż limit Discorda wymusza podział przez smartSplit
  const calls = mockHttpsRequestWithBody(t);
  db.setState('discord_webhook_url', STATE_WEBHOOK);
  const text = 'linia wyniku asystenta\n'.repeat(150); // ~3450 znaków

  // Act
  await sendPlain(text);

  // Assert — plain content (bez embeds — to seam ask, nie ✅ embed jobów), każdy chunk w limicie
  assert.ok(calls.length >= 2, 'tekst ponad limit musi pójść w wielu wiadomościach');
  for (const call of calls) {
    assert.equal(call.body.embeds, undefined);
    assert.ok(call.body.content.length <= 2000, 'chunk w limicie Discorda');
  }
  assert.ok(calls[0].body.content.startsWith('linia wyniku asystenta'));
});

test('sendNotification: zmiana state między wysyłkami działa bez restartu (R4)', async (t) => {
  // Arrange — pierwsza wysyłka na stary URL, potem user zmienia konfigurację w dashboardzie
  const calls = mockHttpsRequest(t);
  db.setState('discord_webhook_url', STATE_WEBHOOK);
  await sendNotification(JOB, 'pierwszy run');

  // Act — nowy URL w state, bez re-require modułu
  db.setState('discord_webhook_url', 'https://discord.com/api/webhooks/9/new-token');
  await sendNotification(JOB, 'drugi run');

  // Assert — druga wysyłka poszła już na nowy path
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/api/webhooks/1/state-token');
  assert.equal(calls[1].path, '/api/webhooks/9/new-token');
});
