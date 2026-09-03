const inboxDb = require('./inbox-db');
const inboxBlobs = require('./inbox-blobs');

// Retencja bajtów załączników na hubie (R11): bajty znikają 14 dni po domknięciu wątku
// oraz twardo 90 dni od wysłania. Po wycofaniu kwot per nadawca (R12, decyzja operatora
// 2026-09-03) to JEDYNY mechanizm zwalniający miejsce na dysku huba — dlatego twardy próg
// nie jest opcją i działa także dla wątków, których nikt nigdy nie domknął.
//
// Kasujemy WYŁĄCZNIE bajty. Rekord w `inbox_attachments` przeżywa, bo render Skrzynki
// pokazuje wtedy trzeci stan wiersza (nazwa + rozmiar + „wygasł", bez checkboxa) — wątek
// zostaje czytelny, a po wprowadzeniu twardego limitu 90 dni to ścieżka NORMALNA, nie awaria.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const GRACE_AFTER_CLOSE_MS = 14 * DAY_MS;
const HARD_TTL_MS = 90 * DAY_MS;

// Karencja dla bajtów wgranych, ale nigdy nieprzypisanych do wiadomości (nadawca przerwał
// między PUT a `send`). Liczona w godzinach i z ogromnym zapasem nad okresem przemiatania:
// znacznik uploadu jest przestarzały o 0–60 min (granulacja przemiatania wchodzi do progu),
// a trwający transfer wielkiego pliku NIE MOŻE zostać uznany za sierotę — kasowanie bajtów
// spod żywego uploadu jest nieodwracalne, a jedyną karą za zwłokę jest chwilowo zajęty dysk.
const ORPHAN_GRACE_MS = 24 * HOUR_MS;

// Przemiatanie raz na godzinę (wzorzec startRetention w schedulerze). Retencja liczona
// w dniach nie potrzebuje krótszego rytmu, a każdy tick to zapytanie do żywej `inbox.db`.
const SWEEP_INTERVAL_MS = HOUR_MS;

// ISO string → ms. Nieczytelny/pusty znacznik daje NaN, a KAŻDE porównanie z NaN jest
// fałszem — więc wiersz z uszkodzonym czasem nigdy nie kwalifikuje się do skasowania.
// To celowy fail-closed: bajtów nie odzyskamy, zajęte miejsce owszem.
function parseTime(iso) {
  return Date.parse(iso ?? '');
}

// Czysta funkcja progowa: zero I/O, zero Date.now() w środku (wzorzec computeMissedJobs).
// `rows` to WSZYSTKIE wiersze załączników z metadanymi wątku — komplet jest warunkiem
// poprawności decyzji o blobie, patrz niżej.
//
// rows: [{ id, sha256, created_at, thread_closed_at }] — `thread_closed_at` jest null,
// dopóki w wątku żyje choć jedna niedomknięta wiadomość.
//
// Blob kasujemy dopiero, gdy WYGASŁY wszystkie wiersze, które go wskazują. To konsekwencja
// dedupu (R4): jedne bajty obsługują wiele wiadomości, więc świeży wątek trzyma przy życiu
// plik współdzielony ze starym.
function computeExpiredAttachments({
  now,
  rows = [],
  graceMs = GRACE_AFTER_CLOSE_MS,
  hardTtlMs = HARD_TTL_MS,
} = {}) {
  const expired = [];
  // sha256 → czy WSZYSTKIE dotąd widziane wiersze o tym hashu wygasły.
  const shaAllExpired = new Map();

  for (const row of rows) {
    const closedAt = parseTime(row.thread_closed_at);
    const createdAt = parseTime(row.created_at);
    const isExpired = now - closedAt > graceMs || now - createdAt > hardTtlMs;

    if (isExpired) expired.push(row);
    const sha = row.sha256;
    shaAllExpired.set(sha, (shaAllExpired.get(sha) ?? true) && isExpired);
  }

  // Set, bo ten sam blob bywa wskazywany przez wiele wygasłych wierszy, a skasować go
  // wolno dokładnie raz — drugi unlink to już potencjalnie CUDZE bajty o tym hashu,
  // wgrane w międzyczasie na nowo.
  const blobsToDelete = [...shaAllExpired.entries()]
    .filter(([, allExpired]) => allExpired)
    .map(([sha]) => sha);

  return { expired, blobsToDelete };
}

// Sieroty: bajty wgrane (ślad w inbox_blob_uploads), do których NIGDY nie powstał wiersz
// załącznika. `uploads` to [{ sha256, uploaded_at }] — przy wielu wgraniach tej samej treści
// liczy się NAJŚWIEŻSZE, inaczej retry po dwóch dniach kasowałby świeżo wgrane bajty.
function computeOrphanedBlobs({
  now,
  uploads = [],
  referencedShas = new Set(),
  orphanGraceMs = ORPHAN_GRACE_MS,
} = {}) {
  const orphans = [];
  for (const upload of uploads) {
    if (referencedShas.has(upload.sha256)) continue;
    if (now - parseTime(upload.uploaded_at) > orphanGraceMs) orphans.push(upload.sha256);
  }
  return orphans;
}

// Kasowanie pojedynczego bloba nie może przerwać przemiatania: jeden plik bez uprawnień
// (albo trzymany przez inny proces na Windows) zablokowałby zwalnianie miejsca dla całej
// reszty. Warn, następny tick spróbuje ponownie.
//
// Wynik jest TRÓJWARTOŚCIOWY, bo od niego zależy znacznik `bytes_deleted_at`, a ten
// odbiera wierszowi prawo do ponownego unlinku. 'deleted' i 'missing' (ENOENT) to ten sam
// stan docelowy — bajtów nie ma — ale 'failed' (EACCES, plik trzymany przez inny proces)
// MUSI wrócić przy następnym ticku: znacznik postawiony po realnym błędzie I/O zostawia
// bajty na dysku na zawsze, przy bazie twierdzącej, że miejsce zwolniono. Retencja jest po
// wycofaniu kwot (R12) jedynym mechanizmem zwalniającym miejsce, więc to trwały wyciek.
function deleteBlobSafely(sha256, blobs, warn) {
  try {
    return blobs.deleteBlob(sha256) ? 'deleted' : 'missing';
  } catch (err) {
    warn(`[inbox-retention] nie udało się skasować bajtów ${sha256}: ${err.message}`);
    return 'failed';
  }
}

// Jedno przemiatanie. Zależności wstrzykiwane, żeby test nie potrzebował dysku ani bazy
// (wzorzec REAL_IO z platform.js). Zwraca liczniki — wołający loguje tylko, gdy coś zrobił.
// Czy te bajty wgrano na tyle świeżo, że kasowanie ich byłoby wyrwaniem pliku spod trwającej
// wysyłki. Ta sama karencja co dla sierot: między PUT a `send` mija czas, a przemiatanie
// biegnie raz na godzinę — bez tej bramki ponowne wysłanie pliku, którego wszystkie stare
// wiersze wygasły, kończy się `unknown_attachment` na POPRAWNEJ wysyłce.
function freshlyUploadedShas({ now, uploads, orphanGraceMs = ORPHAN_GRACE_MS }) {
  const fresh = new Set();
  for (const upload of uploads) {
    if (now - parseTime(upload.uploaded_at) <= orphanGraceMs) fresh.add(upload.sha256);
  }
  return fresh;
}

function sweepInboxRetention({
  now = Date.now(),
  db = inboxDb,
  blobs = inboxBlobs,
  warn = console.warn,
} = {}) {
  const rows = db.listAttachmentsForRetention();
  const { expired, blobsToDelete } = computeExpiredAttachments({ now, rows });

  // Ślady wgrania czytamy PRZED jakimkolwiek kasowaniem — decydują zarówno o sierotach,
  // jak i o tym, czy wygasłego hasha ktoś w międzyczasie nie wgrał na nowo.
  const uploads = db.listBlobUploads();
  const fresh = freshlyUploadedShas({ now, uploads });

  let deletedBlobs = 0;
  for (const sha of blobsToDelete) {
    if (fresh.has(sha)) continue;
    const outcome = deleteBlobSafely(sha, blobs, warn);
    if (outcome === 'deleted') deletedBlobs += 1;
    // Znacznik stawiamy TAKŻE gdy pliku już nie było ('missing'): stan docelowy jest ten sam
    // — bajtów nie ma — a bez znacznika ten hash wracałby do kasowania co godzinę na zawsze.
    // Po 'failed' znacznika NIE ma: wiersz zostaje w kolejce do następnego przemiatania.
    if (outcome !== 'failed') db.markAttachmentBytesDeleted(sha, new Date(now).toISOString());
  }

  // Referencją jest KAŻDY wiersz załącznika, także ten, którego bajty już zwolniliśmy
  // (metadane zostają, więc te bajty nie są sierotą, tylko wygasłym załącznikiem) — dlatego
  // osobne zapytanie, a nie hashe z `rows` (te są już przefiltrowane po bytes_deleted_at).
  const referencedShas = new Set(db.listAttachmentShas());
  const orphans = computeOrphanedBlobs({ now, uploads, referencedShas });

  let deletedOrphans = 0;
  for (const sha of orphans) {
    if (deleteBlobSafely(sha, blobs, warn) === 'deleted') deletedOrphans += 1;
  }

  // Porzucone pliki tymczasowe: blok catch w writeBlobFromStream nie biegnie przy SIGKILL
  // ani reboocie, a retencja jest po wycofaniu kwot (R12) jedynym mechanizmem zwalniającym
  // miejsce — bez tego `.part` rosłyby bez sufitu i bez sygnału.
  const deletedTemps = blobs.sweepTempUploads({ now, olderThanMs: ORPHAN_GRACE_MS, warn });

  return { expired: expired.length, deletedBlobs, deletedOrphans, deletedTemps };
}

let sweepInterval = null;

// `isHub` to FUNKCJA wołana przy każdym ticku, nie wartość policzona przy starcie:
// adres huba czyta w server.js asynchroniczny import, a lista członków zmienia się w locie —
// guard policzony raz w linii startu odpowiadałby na stan sprzed odczytu pliku sekretu
// (learned pattern: async operacja przy starcie vs kod czytający jej wynik).
function runSweep({ isHub, log, warn, deps = {} }) {
  try {
    if (!isHub()) return;
    const { deletedBlobs, deletedOrphans, deletedTemps } = sweepInboxRetention({ ...deps, warn });
    if (deletedBlobs > 0 || deletedOrphans > 0 || deletedTemps > 0) {
      // Świadomie BEZ licznika wygasłych rekordów: te metadane zostają w bazie na zawsze,
      // więc rosnąca liczba czytałaby się jak zaległość do sprzątnięcia, choć tamte bajty
      // zniknęły miesiące temu. W logu są wyłącznie rzeczy zwolnione w TYM ticku.
      log(
        `[inbox-retention] skasowano bajty ${deletedBlobs} załączników` +
          `${deletedOrphans > 0 ? `, sierot: ${deletedOrphans}` : ''}` +
          `${deletedTemps > 0 ? `, plików tymczasowych: ${deletedTemps}` : ''}`
      );
    }
  } catch (err) {
    warn(`[inbox-retention] przemiatanie padło: ${err.message}`);
  }
}

// `deps` (db/blobs) przechodzi w dół do sweepInboxRetention — bez tego jedyna ścieżka
// nieodwracalnie kasująca cudze dane byłaby nietestowalna: test z `isHub: () => true`
// uderzałby w prawdziwą inbox.db i prawdziwy magazyn blobów. Produkcja nie podaje nic.
function startInboxRetention({ isHub, log = console.log, warn = console.warn, deps } = {}) {
  if (typeof isHub !== 'function') {
    throw new TypeError('startInboxRetention: isHub musi być funkcją (guard liczony per tick)');
  }
  stopInboxRetention();
  runSweep({ isHub, log, warn, deps });
  sweepInterval = setInterval(() => runSweep({ isHub, log, warn, deps }), SWEEP_INTERVAL_MS);
  // Przemiatanie nie może trzymać procesu przy życiu — daemon kończy się na sygnale,
  // a nie wtedy, gdy timer retencji łaskawie zwolni event loop.
  if (typeof sweepInterval.unref === 'function') sweepInterval.unref();
  return sweepInterval;
}

function stopInboxRetention() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

module.exports = {
  GRACE_AFTER_CLOSE_MS,
  HARD_TTL_MS,
  ORPHAN_GRACE_MS,
  SWEEP_INTERVAL_MS,
  computeExpiredAttachments,
  computeOrphanedBlobs,
  freshlyUploadedShas,
  sweepInboxRetention,
  startInboxRetention,
  stopInboxRetention,
};
