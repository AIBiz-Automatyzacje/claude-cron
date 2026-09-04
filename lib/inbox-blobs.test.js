const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');

const {
  setBlobsDir,
  getBlobsDir,
  blobPath,
  hasBlob,
  openBlobRead,
  writeBlobFromStream,
  deleteBlob,
  awaitWriteStreamClose,
  InboxBlobError,
} = require('./inbox-blobs');

const MAX = 1024 * 1024;

let tmpRoot;

// Świeży katalog magazynu przed każdym testem — moduł pisze na dysk, więc izolacja
// per test jest jedyną gwarancją, że dedup testujemy na pustym stanie.
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-blobs-test-'));
  setBlobsDir(tmpRoot);
});
afterEach(() => {
  setBlobsDir(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function streamOf(...chunks) {
  return Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
}

// Liczy WSZYSTKIE pliki w magazynie (razem z tymczasowymi) — testy błędów sprawdzają,
// że po nieudanym zapisie nie zostaje ani plik docelowy, ani śmieć w tmp.
function countFiles(dir = tmpRoot) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? countFiles(full) : 1);
  }, 0);
}

test('zapis strumienia tworzy plik pod ścieżką wyprowadzoną z sha256', async () => {
  const content = Buffer.from('zawartość załącznika');
  const sha = sha256(content);

  const result = await writeBlobFromStream(streamOf(content), sha, MAX);

  assert.strictEqual(result.sha256, sha);
  assert.strictEqual(result.size, content.length);
  assert.strictEqual(result.deduped, false);
  assert.strictEqual(blobPath(sha), path.join(tmpRoot, sha.slice(0, 2), sha));
  assert.ok(hasBlob(sha));
  assert.deepStrictEqual(fs.readFileSync(blobPath(sha)), content);
});

test('powtórzony zapis tej samej treści nie tworzy drugiego pliku (dedup)', async () => {
  const content = Buffer.from('ten sam plik wysłany dwa razy');
  const sha = sha256(content);

  await writeBlobFromStream(streamOf(content), sha, MAX);
  const second = await writeBlobFromStream(streamOf(content), sha, MAX);

  assert.strictEqual(second.deduped, true);
  assert.strictEqual(countFiles(), 1);
  assert.deepStrictEqual(fs.readFileSync(blobPath(sha)), content);
});

test('treść niezgodna z deklarowanym hashem → błąd, zero plików w magazynie', async () => {
  const declared = sha256(Buffer.from('to co nadawca obiecał'));

  await assert.rejects(
    () => writeBlobFromStream(streamOf('coś zupełnie innego'), declared, MAX),
    (err) => err instanceof InboxBlobError && err.code === 'hash_mismatch',
  );

  assert.strictEqual(hasBlob(declared), false);
  assert.strictEqual(countFiles(), 0);
});

test('strumień przekraczający maxBytes → błąd, zero plików w magazynie', async () => {
  const content = Buffer.alloc(50, 0x61);
  const sha = sha256(content);

  await assert.rejects(
    () => writeBlobFromStream(streamOf(content.subarray(0, 20), content.subarray(20)), sha, 30),
    (err) => err instanceof InboxBlobError && err.code === 'too_large',
  );

  assert.strictEqual(hasBlob(sha), false);
  assert.strictEqual(countFiles(), 0);
});

test('zerwany strumień → błąd, zero plików w magazynie', async () => {
  const sha = sha256(Buffer.from('nieistotne'));
  const broken = new Readable({
    read() {
      this.destroy(new Error('zerwane połączenie'));
    },
  });

  await assert.rejects(
    () => writeBlobFromStream(broken, sha, MAX),
    (err) => err instanceof InboxBlobError && err.code === 'stream_error',
  );

  assert.strictEqual(countFiles(), 0);
});

test('sha256 spoza [a-f0-9]{64} jest odrzucany, zanim trafi do ścieżki', async () => {
  const wrogie = [
    '../../../etc/passwd',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64), // wielkie litery: jedyna dozwolona forma to lowercase hex
    `${'a'.repeat(62)}/..`,
    '',
    null,
    undefined,
    42,
  ];

  for (const zly of wrogie) {
    assert.throws(
      () => blobPath(zly),
      (err) => err instanceof InboxBlobError && err.code === 'invalid_sha256',
      `blobPath powinien odrzucić: ${String(zly)}`,
    );
    assert.throws(() => hasBlob(zly), (err) => err.code === 'invalid_sha256');
    assert.throws(() => deleteBlob(zly), (err) => err.code === 'invalid_sha256');
    assert.throws(() => openBlobRead(zly), (err) => err.code === 'invalid_sha256');
    await assert.rejects(
      () => writeBlobFromStream(streamOf('x'), zly, MAX),
      (err) => err.code === 'invalid_sha256',
    );
  }

  // Fail-closed: odrzucenie nastąpiło PRZED dotknięciem dysku.
  assert.strictEqual(countFiles(), 0);
});

test('openBlobRead zwraca zapisane bajty, a dla braku bloba rzuca typowanym błędem', async () => {
  const content = Buffer.from('bajty do odczytu strumieniowego');
  const sha = sha256(content);
  await writeBlobFromStream(streamOf(content), sha, MAX);

  const chunks = [];
  for await (const chunk of openBlobRead(sha)) chunks.push(chunk);
  assert.deepStrictEqual(Buffer.concat(chunks), content);

  const brak = sha256(Buffer.from('nigdy nie zapisane'));
  assert.throws(
    () => openBlobRead(brak),
    (err) => err instanceof InboxBlobError && err.code === 'blob_not_found',
  );
});

test('deleteBlob kasuje plik i jest bezpieczny do wołania warunkowo', async () => {
  const content = Buffer.from('blob do skasowania');
  const sha = sha256(content);
  await writeBlobFromStream(streamOf(content), sha, MAX);

  assert.strictEqual(deleteBlob(sha), true);
  assert.strictEqual(hasBlob(sha), false);
  // Drugie wywołanie (np. gdy warstwa wyżej policzyła referencje równolegle) nie rzuca.
  assert.strictEqual(deleteBlob(sha), false);
});

test('getBlobsDir domyślnie wskazuje data/inbox-blobs w katalogu instalacji', () => {
  setBlobsDir(null);
  const { INBOX_BLOBS_DIR } = require('./config');
  // Świadomie BEZ asercji o układzie `…/data/…`: `CLAUDE_CRON_INBOX_BLOBS_DIR` (lib/config.js)
  // pozwala ten układ nadpisać, więc taka asercja mierzyłaby środowisko uruchomienia, nie kontrakt.
  assert.strictEqual(getBlobsDir(), INBOX_BLOBS_DIR);
});

test('przerwanie po limicie NIE niszczy strumienia wołającego (drenaż odmowy musi się wykonać)', async () => {
  // W produkcji strumieniem jest `req` serwera: zniszczony pomija drenaż ciała, a odmowa
  // dociera do klienta jako RST („fetch failed" zamiast 413).
  const stream = streamOf(Buffer.alloc(8, 0x61), Buffer.alloc(8, 0x62));

  await assert.rejects(
    writeBlobFromStream(stream, sha256(Buffer.alloc(16)), 8),
    (err) => err instanceof InboxBlobError && err.code === 'too_large'
  );

  assert.strictEqual(stream.destroyed, false, 'cykl życia strumienia należy do wołającego');
  assert.strictEqual(countFiles(), 0);
});

test('granica limitu: treść o DOKŁADNIE maxBytes bajtach przechodzi, maxBytes+1 → too_large', async () => {
  // Arrange — limit reklamowany userowi ma być osiągalny, więc `>` a nie `>=`
  const limit = 64;
  const naGranicy = Buffer.alloc(limit, 0x62);
  const shaGranica = sha256(naGranicy);

  // Act
  const result = await writeBlobFromStream(streamOf(naGranicy), shaGranica, limit);

  // Assert — plik dokładnie w limicie jest zapisany
  assert.strictEqual(result.deduped, false);
  assert.strictEqual(result.size, limit);
  assert.strictEqual(hasBlob(shaGranica), true);

  // Arrange + Act + Assert — jeden bajt ponad limit odrzucony
  const zaDuzy = Buffer.alloc(limit + 1, 0x63);
  const shaZaDuzy = sha256(zaDuzy);
  await assert.rejects(
    () => writeBlobFromStream(streamOf(zaDuzy), shaZaDuzy, limit),
    (err) => err instanceof InboxBlobError && err.code === 'too_large',
  );
  assert.strictEqual(hasBlob(shaZaDuzy), false);
});

test('skipIfPresent: istniejący blob kończy zapis BEZ czytania strumienia i bez pliku tymczasowego', async () => {
  // Arrange — bajty już są w magazynie
  const content = Buffer.from('treść wgrana wcześniej');
  const sha = sha256(content);
  await writeBlobFromStream(streamOf(content), sha, MAX);

  // Arrange — strumień, który zapamiętuje, czy ktokolwiek go przeczytał
  let przeczytany = false;
  const stream = new Readable({
    read() {
      przeczytany = true;
      this.push(content);
      this.push(null);
    },
  });

  // Act
  const result = await writeBlobFromStream(stream, sha, MAX, { skipIfPresent: true });

  // Assert — sukces dedupu bez transferu i bez śmiecia w tmp
  assert.strictEqual(result.deduped, true);
  assert.strictEqual(result.size, content.length);
  assert.strictEqual(przeczytany, false, 'ciało nie zostało przeczytane');
  assert.strictEqual(countFiles(path.join(tmpRoot, 'tmp')), 0, 'plik tymczasowy nie powstał');
});

test('skipIfPresent domyślnie WYŁĄCZONY: bez flagi treść przechodzi pełną weryfikację sumą', async () => {
  // Arrange — bajty są w magazynie, ale wołający nie deklaruje skrótu
  const content = Buffer.from('cudza treść w magazynie');
  const sha = sha256(content);
  await writeBlobFromStream(streamOf(content), sha, MAX);

  // Act + Assert — podstawienie innej treści pod ten hash jest wykrywane (skrótu nie ma)
  await assert.rejects(
    () => writeBlobFromStream(streamOf(Buffer.from('podmienione bajty')), sha, MAX),
    (err) => err instanceof InboxBlobError && err.code === 'hash_mismatch',
  );

  // Act + Assert — zgodna treść wraca jako deduped po weryfikacji
  const ok = await writeBlobFromStream(streamOf(content), sha, MAX);
  assert.strictEqual(ok.deduped, true);
});

// Regresja: czekanie na domknięcie deskryptora zdarzeniem 'close' zawieszało żądanie, gdy
// błąd pochodził od SAMEGO strumienia zapisu (ENOSPC/EACCES/EPERM) — 'close' padało wtedy
// PRZED wejściem w blok sprzątający, więc drugie zdarzenie już nie nadchodziło.
// Odtworzenie awarii zapisu: zamykamy deskryptor pod strumieniem, więc flush pada EBADF.
function erroredWriteStream() {
  const file = path.join(tmpRoot, 'awaria.part');
  const fd = fs.openSync(file, 'w', 0o600);
  const out = fs.createWriteStream(null, { fd, autoClose: true });
  out.on('error', () => {}); // błąd konsumuje asercja poniżej, listener chroni proces
  fs.closeSync(fd);
  out.write(Buffer.from('bajty'));
  out.end();
  return out;
}

// Rozstrzyga wyścig „domknęło się" kontra „wisi" — bez limitu czasu zawieszenie
// objawiłoby się timeoutem całego runnera, a nie czytelną asercją.
function withDeadline(promise, ms) {
  return Promise.race([
    promise.then(() => 'zamknięty'),
    new Promise((resolve) => setTimeout(() => resolve('wisi'), ms).unref()),
  ]);
}

test('awaitWriteStreamClose nie wisi na strumieniu, który padł i zdążył się zamknąć', async () => {
  const out = erroredWriteStream();
  await assert.rejects(() => finished(out));
  assert.strictEqual(out.closed, true, 'warunek testu: strumień jest już zamknięty');

  out.destroy(); // dokładnie to robi blok sprzątający writeBlobFromStream

  assert.strictEqual(await withDeadline(awaitWriteStreamClose(out), 500), 'zamknięty');
});

test('awaitWriteStreamClose czeka na faktyczne domknięcie deskryptora żywego strumienia', async () => {
  const file = path.join(tmpRoot, 'zywy.part');
  const fd = fs.openSync(file, 'w', 0o600);
  const out = fs.createWriteStream(null, { fd, autoClose: true });
  out.write(Buffer.from('bajty'));
  assert.strictEqual(out.closed, false);

  out.destroy();
  assert.strictEqual(await withDeadline(awaitWriteStreamClose(out), 500), 'zamknięty');
  assert.strictEqual(out.closed, true, 'po powrocie deskryptor jest zamknięty — unlink jest bezpieczny');
});
