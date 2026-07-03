const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractResult, smartSplit, RESULT_FALLBACK } = require('./notify-format');

// --- extractResult ---

test('extractResult: stdout z wpisem type:result → zwraca treść', () => {
  // Arrange — stream-json: jeden JSON per linia, wpis result między innymi typami
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: 'thinking...' } }),
    JSON.stringify({ type: 'result', result: 'Zrobione: 3 pliki zaktualizowane' }),
  ].join('\n');

  // Act
  const result = extractResult(stdout);

  // Assert
  assert.equal(result, 'Zrobione: 3 pliki zaktualizowane');
});

test('extractResult: brak wpisu type:result → fallback "Job completed…"', () => {
  // Arrange
  const stdout = JSON.stringify({ type: 'system', subtype: 'init' });

  // Act / Assert
  assert.equal(extractResult(stdout), RESULT_FALLBACK);
  assert.match(RESULT_FALLBACK, /^Job completed/);
});

test('extractResult: pusty/whitespace stdout → fallback', () => {
  assert.equal(extractResult(''), RESULT_FALLBACK);
  assert.equal(extractResult('   \n  '), RESULT_FALLBACK);
  assert.equal(extractResult(undefined), RESULT_FALLBACK);
});

test('extractResult: linia z niepoprawnym JSON nie wywala parsowania', () => {
  // Arrange — warning CLI (nie-JSON) przed wpisem result
  const stdout = [
    'Warning: something noisy on stdout',
    '{broken json',
    JSON.stringify({ type: 'result', result: 'OK mimo śmieci' }),
  ].join('\n');

  // Act / Assert — nie rzuca i znajduje wpis result
  assert.equal(extractResult(stdout), 'OK mimo śmieci');
});

test('extractResult: wpis result z pustą treścią → fallback (falsy result pomijany)', () => {
  const stdout = JSON.stringify({ type: 'result', result: '' });
  assert.equal(extractResult(stdout), RESULT_FALLBACK);
});

// --- smartSplit ---

test('smartSplit: tekst krótszy niż maxLen → dokładnie 1 chunk', () => {
  // Arrange / Act
  const chunks = smartSplit('krótki tekst', 100);

  // Assert
  assert.deepEqual(chunks, ['krótki tekst']);
});

test('smartSplit: dzieli po \\n gdy newline mieści się w limicie', () => {
  // Arrange — newline na pozycji 11, limit 15; druga linia mieści się w limicie
  const text = 'linia jeden\nlinia druga';

  // Act
  const chunks = smartSplit(text, 15);

  // Assert — podział po newline, nie twardo na 15. znaku
  assert.deepEqual(chunks, ['linia jeden', 'linia druga']);
});

test('smartSplit: bez \\n dzieli po ". " z zachowaniem kropki', () => {
  // Arrange — brak newline, zdanie kończy się przed limitem
  const text = 'Pierwsze zdanie. Drugie zdanie jest znacznie dłuższe niż limit';

  // Act
  const chunks = smartSplit(text, 30);

  // Assert — kropka zostaje w pierwszym chunku
  assert.equal(chunks[0], 'Pierwsze zdanie.');
});

test('smartSplit: słowo dłuższe niż maxLen → twardy podział', () => {
  // Arrange — 25 znaków bez separatorów
  const text = 'a'.repeat(25);

  // Act
  const chunks = smartSplit(text, 10);

  // Assert
  assert.deepEqual(chunks, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
});

test('smartSplit: każdy chunk ≤ maxLen (tekst mieszany)', () => {
  // Arrange — mieszanka newline, zdań i długich słów
  const text = ('Zdanie pierwsze. Zdanie drugie.\n' + 'x'.repeat(120) + '\nKońcówka po długim słowie.').repeat(3);
  const maxLen = 50;

  // Act
  const chunks = smartSplit(text, maxLen);

  // Assert — invariant limitu na KAŻDYM chunku + brak pustych chunków
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= maxLen, `chunk przekracza limit: ${chunk.length} > ${maxLen}`);
    assert.ok(chunk.length > 0, 'pusty chunk');
  }
});
