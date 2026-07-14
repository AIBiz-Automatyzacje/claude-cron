const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchWebhookToken, matchAskToken } = require('./webhook');

// Subprocess z kontrolowanym env — config czyta env raz przy require,
// więc override/fallback testujemy w izolacji od ambient env runnera.
function readAskTimeoutsWithEnv(envOverrides) {
  const out = execFileSync(
    process.execPath,
    ['-e', "const c=require('./lib/config'); console.log(JSON.stringify([c.ASK_TIMEOUT_MS, c.ASK_MAX_MS]));"],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, ...envOverrides },
      encoding: 'utf-8',
    }
  );
  return JSON.parse(out);
}

test('matchWebhookToken jest wyeksportowany', () => {
  assert.equal(typeof matchWebhookToken, 'function');
});

test('plain token bez query → zwraca token', () => {
  // Arrange / Act
  const token = matchWebhookToken('/webhook/abc123');

  // Assert
  assert.equal(token, 'abc123');
});

test('token z query string → obcina query, zwraca sam token (regresja query-string)', () => {
  // Arrange / Act — fix (?:\?|$): query NIE może wpaść do tokenu
  const token = matchWebhookToken('/webhook/abc123?source=zapier&id=7');

  // Assert
  assert.equal(token, 'abc123');
});

test('token z dozwolonymi znakami _ i - → zwraca cały token', () => {
  // Arrange / Act
  const token = matchWebhookToken('/webhook/my_token-42');

  // Assert
  assert.equal(token, 'my_token-42');
});

test('URL z nielegalnym znakiem w tokenie → null', () => {
  // Arrange / Act — kropka nie należy do [a-zA-Z0-9_-]; po "abc" jest ".def",
  // więc kotwica (?:\?|$) nie pasuje i cały match zawodzi → null (nie częściowy "abc").
  const token = matchWebhookToken('/webhook/abc.def');

  // Assert
  assert.equal(token, null);
});

test('pusty token po prefiksie → null', () => {
  // Arrange / Act — brak żadnego znaku tokenu po /webhook/
  const token = matchWebhookToken('/webhook/');

  // Assert
  assert.equal(token, null);
});

test('URL nie będący webhookiem → null', () => {
  // Arrange / Act
  const token = matchWebhookToken('/api/jobs/5');

  // Assert
  assert.equal(token, null);
});

test('nie-string input → null (fail fast, bez rzucania)', () => {
  // Arrange / Act / Assert
  assert.equal(matchWebhookToken(undefined), null);
  assert.equal(matchWebhookToken(null), null);
});

// --- matchAskToken (/ask/:token) ---

test('matchAskToken: token z query string → obcina query, zwraca sam token', () => {
  // Arrange / Act
  const token = matchAskToken('/ask/abc123?x=1');

  // Assert
  assert.equal(token, 'abc123');
});

test('matchAskToken: zły prefiks (/askk/) → null', () => {
  // Arrange / Act — prefiks musi być dokładnie /ask/, nie dłuższy segment
  const token = matchAskToken('/askk/abc123');

  // Assert
  assert.equal(token, null);
});

test('matchAskToken: pusty token po prefiksie → null', () => {
  // Arrange / Act
  const token = matchAskToken('/ask/');

  // Assert
  assert.equal(token, null);
});

test('matchAskToken: nie-string input → null (fail fast, bez rzucania)', () => {
  // Arrange / Act / Assert
  assert.equal(matchAskToken(undefined), null);
  assert.equal(matchAskToken(null), null);
});

test('matchAskToken: URL webhooka NIE pasuje do matchera ask', () => {
  // Arrange / Act — matchery są rozłączne: /webhook/* nie może wpaść w /ask/*
  const token = matchAskToken('/webhook/abc123');

  // Assert
  assert.equal(token, null);
});

// --- defaulty config ASK_* (R10) ---

test('config: defaulty ASK_* — opt-in wyłączony, timeouty i model z planu', () => {
  // Arrange — testy odpalane bez env ASK_*; ASK_ENABLED jest opt-in (truthy tylko przy '1')
  const config = require('./config');

  // Assert
  assert.equal(config.ASK_ENABLED, false);
  assert.equal(config.ASK_TIMEOUT_MS, 55_000);
  assert.equal(config.ASK_MAX_MS, 600_000);
  assert.equal(config.ASK_MODEL, 'sonnet');
});

test('config: ASK_TOKEN/ASK_SECRET bez env → puste stringi (zero defaultów sekretów w repo)', () => {
  // Arrange
  const config = require('./config');

  // Assert
  assert.equal(config.ASK_TOKEN, '');
  assert.equal(config.ASK_SECRET, '');
});

test('config: ASK_TIMEOUT_MS/ASK_MAX_MS z override przez env (mitygacja bez zmiany kodu)', () => {
  // Act
  const [timeoutMs, maxMs] = readAskTimeoutsWithEnv({ ASK_TIMEOUT_MS: '30000', ASK_MAX_MS: '120000' });

  // Assert
  assert.equal(timeoutMs, 30_000);
  assert.equal(maxMs, 120_000);
});

test('config: nie-liczbowy env ASK_TIMEOUT_MS → fallback na defaulty (error case)', () => {
  // Act — Number('abc')=NaN, Number('')=NaN → || default
  const [timeoutMs, maxMs] = readAskTimeoutsWithEnv({ ASK_TIMEOUT_MS: 'abc', ASK_MAX_MS: '' });

  // Assert
  assert.equal(timeoutMs, 55_000);
  assert.equal(maxMs, 600_000);
});
