const { EventEmitter } = require('node:events');
const https = require('node:https');
const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');
const { sendNotification } = require('./discord');

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
