const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isFinalFailure } = require('./executor');

// Czysta decyzja "czy wysłać ❌" (R9): tylko OSTATECZNY fail/timeout, nigdy killed,
// nigdy gdy retry jeszcze przed nami. Okno liczenia failów = to samo co retry
// w scheduler.processQueue (max_retries + 1 ostatnich runów joba).

test('timeout jest zawsze ostateczny (scheduler nie retry\'uje timeoutów)', () => {
  assert.equal(isFinalFailure('timeout', 3, 0), true);
});

test('killed nigdy nie powiadamia — świadoma decyzja usera', () => {
  assert.equal(isFinalFailure('killed', 0, 1), false);
});

test('success nie jest failem — brak wysyłki ❌', () => {
  assert.equal(isFinalFailure('success', 1, 0), false);
});

test('failed z max_retries=0 → od razu ostateczny', () => {
  assert.equal(isFinalFailure('failed', 0, 1), true);
});

test('failed z retry jeszcze dostępnym → brak wysyłki (1 fail w oknie, max_retries=1)', () => {
  assert.equal(isFinalFailure('failed', 1, 1), false);
});

test('failed po wyczerpaniu retry → wysyłka (2 faile w oknie, max_retries=1)', () => {
  assert.equal(isFinalFailure('failed', 1, 2), true);
});
