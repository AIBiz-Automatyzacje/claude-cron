const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { once } = require('node:events');

const { INBOX_BLOBS_DIR } = require('./config');

// Magazyn bajtów załączników skrzynki: adresowanie TREŚCIĄ (`<aa>/<sha256>`), więc dedup
// wychodzi za darmo — ten sam plik to ta sama ścieżka (R4). Metadane (nazwa, mime, autor)
// żyją w SQLite; tutaj są wyłącznie bajty. Zapis biegnie POZA transakcją SQLite: trzymanie
// transakcji przez kilkanaście sekund transferu wypchnęłoby innych pisarzy poza busy_timeout
// i zwróciło `database is locked` jako błąd zamiast czekania.

// Jedyny element ścieżki pochodzący z sieci to sha256, więc wzorzec jest granicą
// bezpieczeństwa (R14): nazwa pliku od nadawcy NIE wyznacza miejsca zapisu, a `../`
// w hashu nie ma szans dotrzeć do path.join.
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHARD_LENGTH = 2;
const TMP_DIR_NAME = 'tmp';
// Bajty załączników to cudze dane — plik tylko dla użytkownika daemona (wzorzec inbox.env).
const BLOB_FILE_MODE = 0o600;

let blobsDirOverride = null;

// Typed error — warstwa API mapuje `code` na kod HTTP bez parsowania komunikatu
// (komunikaty zmieniają się przy korektach językowych). Wzorzec InboxDbError.
class InboxBlobError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'InboxBlobError';
    this.code = code;
  }
}

// Wstrzyknięcie katalogu magazynu dla izolacji testów. Wzorzec db.setDbPath/setInboxDbPath.
function setBlobsDir(testDir) {
  blobsDirOverride = testDir || null;
}

function getBlobsDir() {
  return blobsDirOverride || INBOX_BLOBS_DIR;
}

// Fail-closed walidacja PRZED path.join. Każda publiczna funkcja przyjmująca hash woła ją
// jako pierwszą instrukcję — jedno miejsce, więc nowa ścieżka wejścia nie może jej ominąć.
function assertValidSha256(sha256) {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new InboxBlobError('sha256 musi być 64 znakami [a-f0-9]', 'invalid_sha256');
  }
}

function blobPath(sha256) {
  assertValidSha256(sha256);
  return path.join(getBlobsDir(), sha256.slice(0, SHARD_LENGTH), sha256);
}

function hasBlob(sha256) {
  return fs.existsSync(blobPath(sha256));
}

// Rozmiar bajtów LEŻĄCYCH w magazynie — źródło autorytatywne dla metadanych załącznika.
// Deklaracja nadawcy służy wyłącznie do wczesnej odmowy przed transferem; zapisana do bazy
// awansowałaby pole opisowe do roli sterującej (render odbiorcy porównuje rozmiar pliku na
// dysku z metadanymi, więc fałszywa liczba na zawsze blokowałaby stan „pobrany").
// Zwraca `null`, gdy bajtów nie ma — brak pliku to normalna ścieżka (retencja, rewokacja).
function blobSize(sha256) {
  try {
    return fs.statSync(blobPath(sha256)).size;
  } catch (err) {
    if (err instanceof InboxBlobError) throw err;
    return null;
  }
}

// Zwraca strumień odczytu. Brak bloba rozstrzygamy TU typowanym błędem, nie zdarzeniem
// 'error' na strumieniu — wołający dostaje odpowiedź synchronicznie, zanim zacznie
// budować odpowiedź HTTP wokół pustego strumienia.
function openBlobRead(sha256) {
  const file = blobPath(sha256);
  if (!fs.existsSync(file)) {
    throw new InboxBlobError('blob nie istnieje w magazynie', 'blob_not_found');
  }
  return fs.createReadStream(file);
}

// Kasowanie jest bezpieczne do wołania warunkowo (warstwa wyżej liczy referencje —
// blob jest współdzielony przez dedup). Brak pliku to `false`, nie wyjątek.
function deleteBlob(sha256) {
  const file = blobPath(sha256);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new InboxBlobError(`nie udało się skasować bloba: ${err.message}`, 'delete_failed');
  }
}

// Sprzątanie pliku tymczasowego. Idempotentne i nigdy nie rzuca — biegnie na ścieżce
// błędu, gdzie prawdziwą przyczyną jest błąd wołającego, nie nieudany unlink.
function removeTemp(tmpFile) {
  try {
    fs.unlinkSync(tmpFile);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[inbox-blobs] nie udało się skasować pliku tymczasowego ${tmpFile}: ${err.message}`);
    }
  }
}

// Czeka, aż strumień zapisu FAKTYCZNIE domknie deskryptor — `destroy()` zamyka fd
// asynchronicznie, a na Windows unlink otwartego pliku pada EPERM/EBUSY i zostawia `.part`.
// Kluczowy warunek to `out.closed`: gdy błąd przyszedł od SAMEGO strumienia zapisu
// (ENOSPC/EACCES/EPERM), 'close' padło już PRZED wejściem tutaj, a `once(out, 'close')`
// czekałoby na drugie zdarzenie, którego nigdy nie będzie — żądanie PUT wisiałoby bez
// odpowiedzi, a plik tymczasowy nie zostałby skasowany.
async function awaitWriteStreamClose(out) {
  if (out.closed) return;
  try {
    await once(out, 'close');
  } catch (err) {
    // 'error' wyścigujące się z 'close' odrzuca `once`. To nie jest przyczyna przerwania
    // transferu (tę niesie błąd wołającego), więc tylko logujemy — sprzątanie leci dalej.
    console.warn(`[inbox-blobs] strumień zapisu nie domknął się czysto: ${err.message}`);
  }
}

// Zapisuje bajty ze strumienia do pliku tymczasowego, licząc sha256 W LOCIE, i dopiero po
// zgodności z deklaracją nadawcy robi rename na ścieżkę docelową — plik pod finalną ścieżką
// jest więc ZAWSZE kompletny i zgodny ze swoją nazwą (rename jest atomowy w obrębie FS).
// `expectedSha` to deklaracja z URL-a, nie dowód: hub liczy sumę sam, inaczej nadawca
// podstawiłby dowolną treść pod cudzy hash. Zwraca { sha256, size, deduped }.
// `skipIfPresent` to zgoda wołającego na SKRÓT: bajtów o tym hashu nie przyjmujemy w ogóle,
// gdy już leżą w magazynie. Wolno ją dać wyłącznie komuś, kto tę treść realnie wgrał
// wcześniej (retry uploadu, ten sam plik do wielu adresatów) — dla kogoś obcego skrót
// zamieniłby znajomość hasha w dowód posiadania pliku, więc domyślnie jest WYŁĄCZONY
// i treść przechodzi pełną weryfikację sumą.
async function writeBlobFromStream(stream, expectedSha, maxBytes, { skipIfPresent = false } = {}) {
  assertValidSha256(expectedSha);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new InboxBlobError('maxBytes musi być dodatnią liczbą całkowitą', 'invalid_max_bytes');
  }

  // Dedup (R4) ZANIM dotkniemy dysku i strumienia: powtórzony transfer tej samej treści to
  // sukces bez zapisu, więc nie ma po co otwierać pliku tymczasowego ani pompować megabajtów.
  if (skipIfPresent && hasBlob(expectedSha)) {
    return { sha256: expectedSha, size: fs.statSync(blobPath(expectedSha)).size, deduped: true };
  }

  const dir = getBlobsDir();
  const tmpDir = path.join(dir, TMP_DIR_NAME);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${crypto.randomUUID()}.part`);

  // Deskryptor otwieramy SYNCHRONICZNIE i dopiero na nim stawiamy strumień. Gołe
  // `createWriteStream(ścieżka)` otwiera plik asynchronicznie, więc przerwanie zaraz po
  // starcie (limit na pierwszym chunku) kasowało tmp ZANIM open zdążył się wykonać —
  // a spóźnione `open` z flagą 'w' tworzyło plik-ducha na nowo i zostawiało śmieć na dysku.
  const fd = fs.openSync(tmpFile, 'w', BLOB_FILE_MODE);
  const out = fs.createWriteStream(null, { fd, autoClose: true });
  const hash = crypto.createHash('sha256');
  let size = 0;

  try {
    // Domyślny iterator Readable ma `destroyOnReturn: true`, więc wyjście z pętli przez
    // `throw` (limit, rozjazd hasha) NISZCZY strumień wołającego. W produkcji tym strumieniem
    // jest `req` serwera, a zniszczone żądanie pomija drenaż ciała (drainRequestBody wychodzi
    // przez settle(false)) — odmowa 413/400 leci wtedy w gniazdo, które klient zaraz dostaje
    // jako RST, i nadawca widzi „fetch failed" zamiast powodu. Cykl życia strumienia należy
    // do wołającego, więc nie domykamy go za niego.
    const source =
      typeof stream.iterator === 'function' ? stream.iterator({ destroyOnReturn: false }) : stream;
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new InboxBlobError(`załącznik przekracza limit ${maxBytes} B`, 'too_large');
      }
      hash.update(chunk);
      // Respektujemy backpressure: bez tego cały plik wylądowałby w pamięci procesu,
      // gdy dysk jest wolniejszy od sieci.
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await finished(out);
  } catch (err) {
    // Sprzątanie jest wspólne dla wszystkich powodów przerwania (limit, zerwany strumień,
    // błąd zapisu) — plik tymczasowy nie może przeżyć żadnego z nich. Sprzątamy WYŁĄCZNIE
    // to, czego jesteśmy właścicielem: strumień wejściowy należy do wołającego (w produkcji
    // to `req` serwera, którego gniazdo domyka skorupa server.js dopiero po flushu odpowiedzi).
    // Na unlink czekamy aż deskryptor faktycznie się zamknie (patrz awaitWriteStreamClose).
    out.destroy();
    await awaitWriteStreamClose(out);
    removeTemp(tmpFile);
    if (err instanceof InboxBlobError) throw err;
    throw new InboxBlobError(`przerwany transfer załącznika: ${err.message}`, 'stream_error');
  }

  const actualSha = hash.digest('hex');
  if (actualSha !== expectedSha) {
    removeTemp(tmpFile);
    throw new InboxBlobError('treść nie zgadza się z deklarowanym sha256', 'hash_mismatch');
  }

  // Dedup (R4): bajty już są, więc świeżo policzona kopia jest zbędna. Nie nadpisujemy —
  // istniejący plik przeszedł tę samą weryfikację i może być właśnie czytany.
  const target = blobPath(actualSha);
  if (fs.existsSync(target)) {
    removeTemp(tmpFile);
    return { sha256: actualSha, size, deduped: true };
  }

  // Finalizacja też może paść (ENOSPC na tworzeniu sharda, EACCES, EXDEV, EPERM na Windows).
  // Bez tego bloku plik tymczasowy zostawałby na zawsze, a wołający dostawałby nietypowany
  // Error zamiast InboxBlobError — łamiąc kontrakt „magazyn sprzątnął po sobie".
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(tmpFile, target);
  } catch (err) {
    removeTemp(tmpFile);
    throw new InboxBlobError(`nie udało się zapisać załącznika: ${err.message}`, 'store_failed');
  }
  return { sha256: actualSha, size, deduped: false };
}

// Przemiatanie porzuconych plików tymczasowych. Blok `catch` w writeBlobFromStream sprząta
// po KAŻDYM błędzie transferu, ale nie biegnie przy twardym zakończeniu procesu (SIGKILL
// z `/api/update`, reboot VPS, OOM) — a po wycofaniu kwot (R12) retencja jest jedynym
// mechanizmem zwalniającym miejsce, więc te `.part` rosłyby bez sufitu i bez sygnału.
// Kasujemy WYŁĄCZNIE pliki starsze niż karencja: młodszy `.part` to najpewniej TRWAJĄCY
// transfer, a wyrwanie mu pliku spod ręki jest nieodwracalne. Nigdy nie rzuca — pojedynczy
// plik bez uprawnień nie może zatrzymać przemiatania reszty.
function sweepTempUploads({ now = Date.now(), olderThanMs = 0, warn = console.warn } = {}) {
  const tmpDir = path.join(getBlobsDir(), TMP_DIR_NAME);
  let names;
  try {
    names = fs.readdirSync(tmpDir);
  } catch (err) {
    // Brak katalogu tmp = hub jeszcze nic nie przyjął. To normalny stan, nie awaria.
    if (err.code !== 'ENOENT') warn(`[inbox-blobs] nie udało się odczytać ${tmpDir}: ${err.message}`);
    return 0;
  }

  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    const file = path.join(tmpDir, name);
    try {
      if (now - fs.statSync(file).mtimeMs <= olderThanMs) continue;
      fs.unlinkSync(file);
      deleted += 1;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      warn(`[inbox-blobs] nie udało się skasować pliku tymczasowego ${file}: ${err.message}`);
    }
  }
  return deleted;
}

module.exports = {
  InboxBlobError,
  sweepTempUploads,
  awaitWriteStreamClose,
  assertValidSha256,
  setBlobsDir,
  getBlobsDir,
  blobPath,
  hasBlob,
  blobSize,
  openBlobRead,
  writeBlobFromStream,
  deleteBlob,
};
