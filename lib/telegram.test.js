const { EventEmitter } = require('node:events');
const https = require('node:https');
const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');
const { sendNotification, sendFailureNotification, sendPlain, buildMessages, buildFailureMessage } = require('./telegram');

// Czyste buildery testowane bez sieci; skorupa sieciowa przez mock https.request
// (mockujemy TYLKO zewnętrzny serwis — db jest realny, in-memory), wzorzec z lib/discord.test.js.

const TELEGRAM_MAX_LEN = 4096;
const STATE_TOKEN = '123456:state-token';
const STATE_CHAT = '111222333';
const JOB = { name: 'test-job' };

const savedEnvToken = process.env.TELEGRAM_BOT_TOKEN;
const savedEnvChat = process.env.TELEGRAM_CHAT_ID;

before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
  // przywrócenie env — testy nie mogą śmiecić w środowisku innych plików testowych
  if (savedEnvToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnvToken;
  if (savedEnvChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = savedEnvChat;
});

beforeEach(() => {
  db.setState('telegram_bot_token', '');
  db.setState('telegram_chat_id', '');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

// Fake https.request: nagrywa options + body, odpowiada 200 (jak realne Bot API).
function mockHttpsRequest(t) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter();
    req.end = (data) => {
      calls.push({ options, body: JSON.parse(data) });
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      res.emit('end');
    };
    return req;
  });
  return calls;
}

// stdout w formacie stream-json z wpisem result — tak jak realny CLI.
function streamJsonStdout(resultText) {
  return JSON.stringify({ type: 'result', result: resultText }) + '\n';
}

// === buildMessages (czysta) ===

test('buildMessages: krótki wynik → 1 wiadomość z nagłówkiem ✅', () => {
  // Act
  const messages = buildMessages('test-job', streamJsonStdout('wszystko gra'));

  // Assert
  assert.equal(messages.length, 1);
  assert.equal(messages[0], '✅ test-job\nwszystko gra');
});

test('buildMessages: wynik > 4096 → N chunków ≤ 4096, nagłówek tylko w pierwszym', () => {
  // Arrange — ~10000 znaków z granicami \n co 80 znaków (naturalne punkty podziału)
  const longResult = Array.from({ length: 125 }, () => 'x'.repeat(80)).join('\n');
  assert.ok(longResult.length > 2 * TELEGRAM_MAX_LEN, 'fixture musi wymusić min. 3 chunki');

  // Act
  const messages = buildMessages('test-job', streamJsonStdout(longResult));

  // Assert
  assert.ok(messages.length >= 3, `oczekiwano ≥3 wiadomości, jest ${messages.length}`);
  for (const msg of messages) {
    assert.ok(msg.length <= TELEGRAM_MAX_LEN, `wiadomość ${msg.length} znaków przekracza limit`);
  }
  assert.ok(messages[0].startsWith('✅ test-job\n'), 'pierwsza wiadomość ma nagłówek');
  for (const msg of messages.slice(1)) {
    assert.ok(!msg.includes('✅'), 'nagłówek tylko w pierwszej wiadomości');
  }
});

// === buildFailureMessage (czysta) ===

test('buildFailureMessage: error_msg trafia do wiadomości ❌ ze statusem', () => {
  // Act
  const msg = buildFailureMessage('test-job', 'failed', 'Idle timeout — no output for 300s', 'stderr którego nie chcemy');

  // Assert — error_msg wygrywa nad stderr
  assert.equal(msg, '❌ test-job padł (failed)\nIdle timeout — no output for 300s');
});

test('buildFailureMessage: brak error_msg → ogon stderr (nie początek)', () => {
  // Arrange — stderr dłuższy niż ogon (1000 znaków); unikalny znacznik początku + przyczyna na końcu
  const stderr = 'UNIKALNY-POCZATEK-DIAGLOGU ' + 'x'.repeat(3000) + '\nError: connection refused';

  // Act
  const msg = buildFailureMessage('test-job', 'timeout', '', stderr);

  // Assert
  assert.ok(msg.startsWith('❌ test-job padł (timeout)\n'));
  assert.ok(msg.endsWith('Error: connection refused'), 'ogon stderr musi być w wiadomości');
  assert.ok(!msg.includes('UNIKALNY-POCZATEK-DIAGLOGU'), 'początek stderr ucięty');
  // detal ograniczony do ogona (1000 znaków) + nagłówek
  assert.ok(msg.length <= '❌ test-job padł (timeout)\n'.length + 1000, 'detal przycięty do ogona');
});

test('buildFailureMessage: bardzo długi error_msg → twarde cięcie do 4096', () => {
  // Act
  const msg = buildFailureMessage('test-job', 'failed', 'e'.repeat(10000), '');

  // Assert
  assert.equal(msg.length, TELEGRAM_MAX_LEN);
});

// === sendNotification (skorupa sieciowa) ===

test('sendNotification: brak konfiguracji (state i env puste) → zero prób sieciowych', async (t) => {
  // Arrange — beforeEach wyczyścił oba źródła
  const calls = mockHttpsRequest(t);

  // Act — nie może rzucić ani nic wysłać
  await sendNotification(JOB, streamJsonStdout('wynik'));

  // Assert
  assert.equal(calls.length, 0);
});

test('sendNotification: sam token bez chat_id → zero prób sieciowych', async (t) => {
  // Arrange — Telegram wymaga OBU wartości
  const calls = mockHttpsRequest(t);
  db.setState('telegram_bot_token', STATE_TOKEN);

  // Act
  await sendNotification(JOB, streamJsonStdout('wynik'));

  // Assert
  assert.equal(calls.length, 0);
});

test('sendNotification: konfiguracja ze state → POST na /bot<TOKEN>/sendMessage z chat_id i tekstem', async (t) => {
  // Arrange
  const calls = mockHttpsRequest(t);
  db.setState('telegram_bot_token', STATE_TOKEN);
  db.setState('telegram_chat_id', STATE_CHAT);

  // Act
  await sendNotification(JOB, streamJsonStdout('wynik joba'));

  // Assert
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.hostname, 'api.telegram.org');
  assert.equal(calls[0].options.path, `/bot${STATE_TOKEN}/sendMessage`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].body.chat_id, STATE_CHAT);
  assert.equal(calls[0].body.text, '✅ test-job\nwynik joba');
});

test('sendNotification: state pusty → fallback na env (R3)', async (t) => {
  // Arrange
  const calls = mockHttpsRequest(t);
  process.env.TELEGRAM_BOT_TOKEN = '999:env-token';
  process.env.TELEGRAM_CHAT_ID = '444555';

  // Act
  await sendNotification(JOB, streamJsonStdout('wynik'));

  // Assert
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.path, '/bot999:env-token/sendMessage');
  assert.equal(calls[0].body.chat_id, '444555');
});

// === sendFailureNotification (skorupa sieciowa) ===

test('sendFailureNotification: brak konfiguracji → zero prób sieciowych', async (t) => {
  // Arrange
  const calls = mockHttpsRequest(t);

  // Act
  await sendFailureNotification(JOB, { status: 'failed', error_msg: 'boom', stderr: '' });

  // Assert
  assert.equal(calls.length, 0);
});

test('sendFailureNotification: konfiguracja ustawiona → 1 wiadomość ❌ z error_msg', async (t) => {
  // Arrange
  const calls = mockHttpsRequest(t);
  db.setState('telegram_bot_token', STATE_TOKEN);
  db.setState('telegram_chat_id', STATE_CHAT);

  // Act
  await sendFailureNotification(JOB, { status: 'failed', error_msg: 'boom', stderr: '' });

  // Assert
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, '❌ test-job padł (failed)\nboom');
});

// === sendPlain — seam plain-text dla ask (Unit 4) ===

test('sendPlain: brak konfiguracji → zero prób sieciowych', async (t) => {
  // Arrange — beforeEach wyczyścił state i env
  const calls = mockHttpsRequest(t);

  // Act — nie może rzucić ani nic wysłać
  await sendPlain('✅ Asystent głosowy\nwynik');

  // Assert
  assert.equal(calls.length, 0);
});

test('sendPlain: surowy tekst bez parse_mode, długi tekst w chunkach ≤4096', async (t) => {
  // Arrange — tekst dłuższy niż limit Telegrama wymusza podział przez smartSplit
  const calls = mockHttpsRequest(t);
  db.setState('telegram_bot_token', STATE_TOKEN);
  db.setState('telegram_chat_id', STATE_CHAT);
  const text = 'linia wyniku asystenta\n'.repeat(300); // ~6900 znaków

  // Act
  await sendPlain(text);

  // Assert — plain text (bez parse_mode i bez nagłówka buildMessages — to seam ask)
  assert.ok(calls.length >= 2, 'tekst ponad limit musi pójść w wielu wiadomościach');
  for (const call of calls) {
    assert.equal(call.body.parse_mode, undefined);
    assert.equal(call.body.chat_id, STATE_CHAT);
    assert.ok(call.body.text.length <= TELEGRAM_MAX_LEN, 'chunk w limicie Telegrama');
  }
  assert.ok(calls[0].body.text.startsWith('linia wyniku asystenta'));
});

test('buildMessages: nazwa joba ~5000 znaków → kończy się (bez pętli DoS), każda wiadomość ≤ 4096', () => {
  // Arrange — POST /api/jobs nie waliduje długości name; bez capu nagłówka limit chunka
  // wychodził ujemny i smartSplit kręcił nieskończoną synchroniczną pętlę (DoS event loopu)
  const longName = 'n'.repeat(5000);

  // Act — samo zakończenie wywołania = brak pętli
  const messages = buildMessages(longName, streamJsonStdout('wynik joba'));

  // Assert
  assert.ok(messages.length >= 1);
  for (const msg of messages) {
    assert.ok(msg.length <= TELEGRAM_MAX_LEN, `wiadomość ${msg.length} znaków przekracza limit`);
  }
  assert.ok(messages[0].startsWith('✅ n'), 'nagłówek (przycięty) zostaje w pierwszej wiadomości');
});

test("buildMessages: '. ' dokładnie na granicy chunka → pierwsza wiadomość ≤ 4096 (repro off-by-one 4097)", () => {
  // Arrange — repro z review: limit chunka = 4096 - len('✅ test-job') - 1 = 4085;
  // kropka zaczynająca się dokładnie na indeksie 4085 dawała chunk 4086 → wiadomość 4097 → Bot API 400
  const chunkLimit = TELEGRAM_MAX_LEN - '✅ test-job'.length - 1;
  const result = 'x'.repeat(chunkLimit) + '. ' + 'ogon po kropce';

  // Act
  const messages = buildMessages('test-job', streamJsonStdout(result));

  // Assert
  assert.ok(messages.length >= 2, 'wynik dłuższy niż limit musi dać ≥2 wiadomości');
  for (const msg of messages) {
    assert.ok(msg.length <= TELEGRAM_MAX_LEN, `wiadomość ${msg.length} znaków przekracza limit 4096`);
  }
});
