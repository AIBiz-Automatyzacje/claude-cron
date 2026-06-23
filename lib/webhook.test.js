const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchWebhookToken } = require('./webhook');

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
