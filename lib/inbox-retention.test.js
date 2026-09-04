const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inboxDb = require('./inbox-db');
const inboxBlobs = require('./inbox-blobs');
const {
  GRACE_AFTER_CLOSE_MS,
  HARD_TTL_MS,
  ORPHAN_GRACE_MS,
  SWEEP_INTERVAL_MS,
  computeExpiredAttachments,
  computeOrphanedBlobs,
  sweepInboxRetention,
  startInboxRetention,
  stopInboxRetention,
} = require('./inbox-retention');

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Jawny jitter: w produkcji próg NIGDY nie jest trafiany co do milisekundy (przemiatanie
// biegnie raz na godzinę, znacznik bywa przestarzały o 0–60 min). Test na okrągłej różnicy
// przechodziłby przy złamanym porównaniu — learned pattern o mock timers, które dają odstęp
// dokładnie równy progowi, czyli wartość poza testem nieosiągalną.
const JITTER_MS = 137_411;

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

function attachment({ id = 'a1', sha256 = 'sha-1', createdAgo = DAY, closedAgo = null } = {}) {
  return {
    id,
    sha256,
    created_at: iso(createdAgo),
    thread_closed_at: closedAgo === null ? null : iso(closedAgo),
  };
}

// === Próg 14 dni od domknięcia wątku ===

test('wątek domknięty 13 dni temu — bajty zostają', () => {
  const { expired, blobsToDelete } = computeExpiredAttachments({
    now: NOW,
    rows: [attachment({ closedAgo: 13 * DAY })],
  });
  assert.deepStrictEqual(expired, []);
  assert.deepStrictEqual(blobsToDelete, []);
});

test('wątek domknięty 15 dni temu — bajty do skasowania, rekord metadanych nietknięty', () => {
  const row = attachment({ closedAgo: 15 * DAY });
  const rowsBefore = JSON.stringify([row]);
  const { expired, blobsToDelete } = computeExpiredAttachments({ now: NOW, rows: [row] });

  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, 'a1');
  assert.deepStrictEqual(blobsToDelete, ['sha-1']);
  // Funkcja progowa NIE dotyka wierszy: znikają wyłącznie bajty, metadane zostają,
  // żeby render pokazał trzeci stan („wygasł") zamiast gubić wiersz z wątku.
  assert.strictEqual(JSON.stringify([row]), rowsBefore);
});

test('jitter po obu stronach progu domknięcia daje ten sam werdykt co wartości okrągłe', () => {
  const tuzPrzed = computeExpiredAttachments({
    now: NOW,
    rows: [attachment({ closedAgo: GRACE_AFTER_CLOSE_MS - JITTER_MS })],
  });
  const tuzPo = computeExpiredAttachments({
    now: NOW,
    rows: [attachment({ closedAgo: GRACE_AFTER_CLOSE_MS + JITTER_MS })],
  });

  assert.deepStrictEqual(tuzPrzed.blobsToDelete, [], 'przed progiem bajty muszą zostać');
  assert.deepStrictEqual(tuzPo.blobsToDelete, ['sha-1'], 'po progu bajty muszą zniknąć');
});

// === Twardy próg 90 dni od wysłania ===

test('wątek otwarty, wysłany 89 dni temu — bajty zostają', () => {
  const { blobsToDelete } = computeExpiredAttachments({
    now: NOW,
    rows: [attachment({ createdAgo: 89 * DAY, closedAgo: null })],
  });
  assert.deepStrictEqual(blobsToDelete, []);
});

test('wątek otwarty, wysłany 91 dni temu — bajty kasowane mimo otwartego wątku', () => {
  const { expired, blobsToDelete } = computeExpiredAttachments({
    now: NOW,
    rows: [attachment({ createdAgo: 91 * DAY, closedAgo: null })],
  });
  assert.strictEqual(expired.length, 1);
  assert.deepStrictEqual(blobsToDelete, ['sha-1']);
});

test('jitter po obu stronach twardego progu daje ten sam werdykt co wartości okrągłe', () => {
  const tuzPrzed = computeExpiredAttachments({
    now: NOW,
    rows: [attachment({ createdAgo: HARD_TTL_MS - JITTER_MS })],
  });
  const tuzPo = computeExpiredAttachments({
    now: NOW,
    rows: [attachment({ createdAgo: HARD_TTL_MS + JITTER_MS })],
  });

  assert.deepStrictEqual(tuzPrzed.blobsToDelete, []);
  assert.deepStrictEqual(tuzPo.blobsToDelete, ['sha-1']);
});

test('uszkodzony znacznik czasu nie kwalifikuje bajtów do skasowania (fail-closed)', () => {
  const { expired, blobsToDelete } = computeExpiredAttachments({
    now: NOW,
    rows: [{ id: 'a1', sha256: 'sha-1', created_at: 'nie-data', thread_closed_at: 'też-nie' }],
  });
  assert.deepStrictEqual(expired, []);
  assert.deepStrictEqual(blobsToDelete, []);
});

// === Dedup: blob współdzielony ===

test('dwa rekordy o tym samym sha256, jeden wygasły — blob NIE jest kasowany', () => {
  const { expired, blobsToDelete } = computeExpiredAttachments({
    now: NOW,
    rows: [
      attachment({ id: 'stary', sha256: 'wspolny', closedAgo: 20 * DAY + JITTER_MS }),
      attachment({ id: 'swiezy', sha256: 'wspolny', closedAgo: 2 * DAY + JITTER_MS }),
    ],
  });
  assert.strictEqual(expired.length, 1, 'wygasł tylko jeden wiersz');
  assert.deepStrictEqual(blobsToDelete, [], 'świeży wątek trzyma współdzielone bajty przy życiu');
});

test('oba rekordy wygasłe — blob kasowany dokładnie raz', () => {
  const { blobsToDelete } = computeExpiredAttachments({
    now: NOW,
    rows: [
      attachment({ id: 'a', sha256: 'wspolny', closedAgo: 20 * DAY + JITTER_MS }),
      attachment({ id: 'b', sha256: 'wspolny', closedAgo: 30 * DAY + JITTER_MS }),
    ],
  });
  assert.deepStrictEqual(blobsToDelete, ['wspolny']);
});

// === Sieroty ===

test('blob bez rekordu załącznika, młodszy niż karencja sierot — nie jest kasowany', () => {
  const orphans = computeOrphanedBlobs({
    now: NOW,
    uploads: [{ sha256: 'swiezy', uploaded_at: iso(ORPHAN_GRACE_MS - JITTER_MS) }],
    referencedShas: new Set(),
  });
  assert.deepStrictEqual(orphans, []);
});

test('blob bez rekordu załącznika, starszy niż karencja sierot — kasowany', () => {
  const orphans = computeOrphanedBlobs({
    now: NOW,
    uploads: [{ sha256: 'porzucony', uploaded_at: iso(ORPHAN_GRACE_MS + JITTER_MS) }],
    referencedShas: new Set(),
  });
  assert.deepStrictEqual(orphans, ['porzucony']);
});

test('stary upload z żywym rekordem załącznika nie jest sierotą', () => {
  const orphans = computeOrphanedBlobs({
    now: NOW,
    uploads: [{ sha256: 'uzywany', uploaded_at: iso(30 * DAY) }],
    referencedShas: new Set(['uzywany']),
  });
  assert.deepStrictEqual(orphans, []);
});

// === Przemiatanie (sweep) ===

function fakeDeps({ rows = [], uploads = [], deleted = [], marked = [], uploadsDeleted = [], temps = 0, failOn = null } = {}) {
  return {
    db: {
      listAttachmentsForRetention: () => rows,
      // Referencje dla sierot biorą się z WSZYSTKICH wierszy, także tych ze znacznikiem
      // zwolnienia bajtów — stąd osobna metoda, nie hashe z `rows`.
      listAttachmentShas: () => [...new Set(rows.map((r) => r.sha256))],
      listBlobUploads: () => uploads,
      markAttachmentBytesDeleted: (sha, at) => {
        marked.push({ sha, at });
        return 1;
      },
      deleteBlobUploads: (sha) => {
        uploadsDeleted.push(sha);
        return 1;
      },
    },
    blobs: {
      deleteBlob: (sha) => {
        if (sha === failOn) throw new Error('EACCES');
        deleted.push(sha);
        return true;
      },
      sweepTempUploads: () => temps,
    },
  };
}

test('przemiatanie przy braku czegokolwiek do skasowania nie rzuca i nie loguje ostrzeżeń', () => {
  const warns = [];
  const deps = fakeDeps({ rows: [attachment({ closedAgo: DAY })] });
  const result = sweepInboxRetention({ now: NOW, ...deps, warn: (m) => warns.push(m) });

  assert.deepStrictEqual(result, { expired: 0, deletedBlobs: 0, deletedOrphans: 0, deletedTemps: 0 });
  assert.deepStrictEqual(warns, []);
});

test('przemiatanie kasuje bajty wygasłych i sierot, licząc oba osobno', () => {
  const deleted = [];
  const deps = fakeDeps({
    rows: [attachment({ sha256: 'wygasly', closedAgo: 20 * DAY + JITTER_MS })],
    uploads: [
      { sha256: 'wygasly', uploaded_at: iso(20 * DAY) },
      { sha256: 'sierota', uploaded_at: iso(2 * DAY + JITTER_MS) },
    ],
    deleted,
  });

  const result = sweepInboxRetention({ now: NOW, ...deps, warn: () => {} });

  assert.deepStrictEqual(result, { expired: 1, deletedBlobs: 1, deletedOrphans: 1, deletedTemps: 0 });
  // Bajty wygasłego załącznika NIE są liczone drugi raz jako sierota — jego wiersz
  // metadanych żyje dalej, więc pozostaje referencją.
  assert.deepStrictEqual(deleted, ['wygasly', 'sierota']);
});

test('pad kasowania jednego bloba nie przerywa przemiatania — warn i kolejne blob dalej idą', () => {
  const warns = [];
  const deleted = [];
  const deps = fakeDeps({
    rows: [
      attachment({ id: 'a', sha256: 'zly', closedAgo: 20 * DAY + JITTER_MS }),
      attachment({ id: 'b', sha256: 'dobry', closedAgo: 20 * DAY + JITTER_MS }),
    ],
    deleted,
    failOn: 'zly',
  });

  const result = sweepInboxRetention({ now: NOW, ...deps, warn: (m) => warns.push(m) });

  assert.strictEqual(result.deletedBlobs, 1);
  assert.deepStrictEqual(deleted, ['dobry']);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /zly/);
});

// === Guard huba i pętla ===

test('startInboxRetention nie przemiata, gdy instancja nie jest hubem', () => {
  const logs = [];
  let asked = 0;
  startInboxRetention({
    isHub: () => {
      asked += 1;
      return false;
    },
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  });
  stopInboxRetention();

  assert.strictEqual(asked, 1, 'guard pytany już przy przemiataniu startowym');
  assert.deepStrictEqual(logs, [], 'nie-hub milczy i nie dotyka bazy');
});

test('startInboxRetention wymaga funkcji jako guardu (wartość zamrażałaby stan startu)', () => {
  assert.throws(() => startInboxRetention({ isHub: true }), TypeError);
});

test('okres przemiatania jest wielokrotnie krótszy od karencji sierot', () => {
  // Karencja sierot MUSI mieć zapas nad granulacją przemiatania — inaczej trwający upload
  // trafiłby na przemiatanie jako „sierota".
  assert.ok(ORPHAN_GRACE_MS > 10 * SWEEP_INTERVAL_MS);
});

// === Kontrakt SQL: skąd biorą się wiersze dla funkcji progowej ===

const CAST = ['kacper', 'kamil'];
const SHA_A = 'a'.repeat(64);
const SHA_F = 'f'.repeat(64);

// Hooki żyją WEWNĄTRZ tego bloku: w node:test hook z poziomu pliku obowiązuje wszystkie
// testy, więc kilkanaście testów czystych funkcji progowych („zero I/O, zero bazy")
// dostawało przy każdym przebiegu close() + migrate() + dwa addMember.
describe('kontrakt SQL', () => {
  beforeEach(() => {
    inboxDb.close();
    inboxDb.setInboxDbPath(':memory:');
    CAST.forEach((name) => inboxDb.addMember(name));
  });
  afterEach(() => {
    inboxDb.close();
  });

  test('listAttachmentsForRetention: wątek z żywą wiadomością ma thread_closed_at = null', () => {
    const msg = inboxDb.sendMessage({
      from_user: 'kacper',
      to_user: 'kamil',
      type: 'task',
      title: 'Z załącznikiem',
      attachments: [{ filename: 'a.pdf', size_bytes: 10, mime: 'application/pdf', sha256: SHA_F }],
    });
    assert.ok(msg.id);

    const rows = inboxDb.listAttachmentsForRetention();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].sha256, SHA_F);
    assert.strictEqual(rows[0].thread_closed_at, null);
  });

  // Przypadek POZYTYWNY szwu moduł↔SQL: bez niego odwrócenie gałęzi CASE/EXISTS przechodzi
  // całą suitą — w jedną stronę próg 14-dniowy jest martwy, w drugą retencja kasuje bajty
  // żywej korespondencji po 14 dniach od wysłania.
  test('listAttachmentsForRetention: domknięta nitka ma thread_closed_at = najświeższe updated_at', () => {
    const msg = inboxDb.sendMessage({
      from_user: 'kacper',
      to_user: 'kamil',
      type: 'task',
      title: 'Do domknięcia',
      attachments: [{ filename: 'a.pdf', size_bytes: 10, mime: 'application/pdf', sha256: SHA_F }],
    });
    // markDone taska dokłada reply od adresata — nitkę domykamy dopiero, gdy oba wiersze
    // są `done`, więc bez tej drugiej operacji wątek wciąż żyje.
    inboxDb.markDone({ id: msg.id, action: 'Zrobione', user: 'kamil' });
    for (const m of inboxDb.getThread(msg.thread_id)) {
      inboxDb.markDone({ id: m.id, action: 'Zapoznane', user: m.to_user });
    }

    const rows = inboxDb.listAttachmentsForRetention();
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].thread_closed_at, 'domknięta nitka MUSI mieć znacznik domknięcia');
    const newest = inboxDb
      .getThread(msg.thread_id)
      .map((m) => m.updated_at)
      .sort()
      .pop();
    assert.strictEqual(rows[0].thread_closed_at, newest);
  });

  test('listBlobUploads zwraca jeden wiersz per hash z najświeższym wgraniem', () => {
    inboxDb.recordBlobUpload(SHA_A, 'kacper');
    inboxDb.recordBlobUpload(SHA_A, 'kamil');

    const uploads = inboxDb.listBlobUploads();
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0].sha256, SHA_A);
    assert.ok(Date.parse(uploads[0].uploaded_at) > 0);
  });

  // Niezmiennik zapisany wprost w lib/inbox-retention.js: karencja sierot liczy się od
  // NAJŚWIEŻSZEGO wgrania. INSERT OR IGNORE zamrażał znacznik, więc retry po dobie dawał
  // ślad starszy niż karencja i przemiatanie kasowało właśnie wgrane bajty przed `send`.
  test('powtórne recordBlobUpload podnosi uploaded_at', async () => {
    inboxDb.recordBlobUpload(SHA_A, 'kacper');
    const first = inboxDb.listBlobUploads()[0].uploaded_at;
    await new Promise((r) => setTimeout(r, 5));
    inboxDb.recordBlobUpload(SHA_A, 'kacper');
    const second = inboxDb.listBlobUploads()[0].uploaded_at;

    assert.strictEqual(inboxDb.listBlobUploads().length, 1, 'ślad wgrania pozostaje jeden');
    assert.ok(Date.parse(second) > Date.parse(first), `${second} musi być świeższe niż ${first}`);
  });
});

// === Przemiatanie na PRAWDZIWEJ bazie i magazynie (trzeci stan renderu, R5) ===

function useTempBlobStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-retention-blobs-'));
  inboxBlobs.setBlobsDir(dir);
  t.after(() => {
    inboxBlobs.setBlobsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeBlob(sha, bytes = 'x') {
  const file = inboxBlobs.blobPath(sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function countAttachments() {
  return inboxDb
    .getInboxDb()
    .prepare('SELECT id FROM inbox_attachments')
    .all().length;
}

describe('przemiatanie na żywej inbox.db', () => {
  beforeEach(() => {
    inboxDb.close();
    inboxDb.setInboxDbPath(':memory:');
    CAST.forEach((name) => inboxDb.addMember(name));
  });
  afterEach(() => {
    inboxDb.close();
  });

  test('po twardym progu znika PLIK, a wiersz metadanych zostaje', (t) => {
    useTempBlobStore(t);
    writeBlob(SHA_F);
    const msg = inboxDb.sendMessage({
      from_user: 'kacper',
      to_user: 'kamil',
      type: 'task',
      title: 'Stary',
      attachments: [{ filename: 'a.pdf', size_bytes: 1, mime: 'application/pdf', sha256: SHA_F }],
    });
    assert.ok(msg.id);

    const result = sweepInboxRetention({ now: Date.now() + HARD_TTL_MS + DAY, warn: () => {} });

    assert.strictEqual(result.deletedBlobs, 1);
    assert.strictEqual(fs.existsSync(inboxBlobs.blobPath(SHA_F)), false, 'bajty muszą zniknąć');
    assert.strictEqual(countAttachments(), 1, 'metadane zostają — render pokazuje „wygasł"');
  });

  test('drugie przemiatanie nie próbuje już kasować zwolnionych bajtów', (t) => {
    useTempBlobStore(t);
    writeBlob(SHA_F);
    inboxDb.sendMessage({
      from_user: 'kacper',
      to_user: 'kamil',
      type: 'task',
      title: 'Stary',
      attachments: [{ filename: 'a.pdf', size_bytes: 1, mime: 'application/pdf', sha256: SHA_F }],
    });
    const now = Date.now() + HARD_TTL_MS + DAY;
    sweepInboxRetention({ now, warn: () => {} });

    // Ktoś wgrywa tę samą treść na nowo — drugi przebieg NIE MOŻE zabrać świeżych bajtów.
    writeBlob(SHA_F);
    const second = sweepInboxRetention({ now: now + HOUR, warn: () => {} });

    assert.strictEqual(second.deletedBlobs, 0, 'wygasły wiersz nie wraca do kasowania');
    assert.strictEqual(fs.existsSync(inboxBlobs.blobPath(SHA_F)), true);
  });
});

// === Ochrona świeżo wgranych bajtów ===

test('wygasły wiersz + wgranie sprzed godziny — bajty NIE są kasowane', () => {
  const deleted = [];
  const marked = [];
  const deps = fakeDeps({
    rows: [attachment({ sha256: 'wraca', createdAgo: HARD_TTL_MS + DAY })],
    uploads: [{ sha256: 'wraca', uploaded_at: iso(HOUR) }],
    deleted,
    marked,
  });

  const result = sweepInboxRetention({ now: NOW, ...deps, warn: () => {} });

  assert.strictEqual(result.deletedBlobs, 0, 'świeże wgranie chroni bajty przed retencją');
  assert.deepStrictEqual(deleted, []);
  assert.deepStrictEqual(marked, [], 'nie stawiamy znacznika zwolnienia na bajtach, których nie ruszyliśmy');
});

test('skasowanie bajtów stawia znacznik zwolnienia na wierszu', () => {
  const marked = [];
  const deps = fakeDeps({
    rows: [attachment({ sha256: 'stary', createdAgo: HARD_TTL_MS + DAY })],
    uploads: [{ sha256: 'stary', uploaded_at: iso(30 * DAY) }],
    marked,
  });

  sweepInboxRetention({ now: NOW, ...deps, warn: () => {} });

  assert.strictEqual(marked.length, 1);
  assert.strictEqual(marked[0].sha, 'stary');
  assert.strictEqual(marked[0].at, new Date(NOW).toISOString());
});

// === Porzucone pliki tymczasowe ===

test('sweepTempUploads kasuje .part starsze niż karencja, młodsze zostawia', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-tmp-sweep-'));
  t.after(() => {
    inboxBlobs.setBlobsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  inboxBlobs.setBlobsDir(dir);
  const tmpDir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stary = path.join(tmpDir, 'stary.part');
  const swiezy = path.join(tmpDir, 'swiezy.part');
  fs.writeFileSync(stary, 'x');
  fs.writeFileSync(swiezy, 'x');
  const oldMs = Date.now() - (ORPHAN_GRACE_MS + HOUR);
  fs.utimesSync(stary, new Date(oldMs), new Date(oldMs));

  const deleted = inboxBlobs.sweepTempUploads({ olderThanMs: ORPHAN_GRACE_MS, warn: () => {} });

  assert.strictEqual(deleted, 1);
  assert.strictEqual(fs.existsSync(stary), false, 'porzucony .part musi zniknąć');
  assert.strictEqual(fs.existsSync(swiezy), true, 'trwający transfer nie może stracić pliku');
});

test('sweepTempUploads na hubie bez katalogu tmp zwraca 0 i nie ostrzega', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-tmp-brak-'));
  t.after(() => {
    inboxBlobs.setBlobsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  inboxBlobs.setBlobsDir(dir);
  const warns = [];

  assert.strictEqual(inboxBlobs.sweepTempUploads({ warn: (m) => warns.push(m) }), 0);
  assert.deepStrictEqual(warns, []);
});

// === runSweep: pozytywna ścieżka i łapanie błędu ===

test('sprzątnięta sierota traci ślad wgrania — nie wraca do kasowania w kolejnym ticku', () => {
  const uploadsDeleted = [];
  const deps = fakeDeps({
    uploads: [{ sha256: 'sierota', uploaded_at: iso(2 * DAY + JITTER_MS) }],
    uploadsDeleted,
  });

  const result = sweepInboxRetention({ now: NOW, ...deps, warn: () => {} });

  assert.strictEqual(result.deletedOrphans, 1);
  assert.deepStrictEqual(uploadsDeleted, ['sierota'], 'bez tego hash wraca co godzinę na zawsze');
});

test('pad unlinku sieroty ZOSTAWIA ślad wgrania — bajty leżą dalej i muszą wrócić', () => {
  const uploadsDeleted = [];
  const warns = [];
  const deps = fakeDeps({
    uploads: [{ sha256: 'zablokowana', uploaded_at: iso(2 * DAY + JITTER_MS) }],
    uploadsDeleted,
    failOn: 'zablokowana',
  });

  const result = sweepInboxRetention({ now: NOW, ...deps, warn: (m) => warns.push(m) });

  assert.strictEqual(result.deletedOrphans, 0);
  assert.deepStrictEqual(uploadsDeleted, []);
  assert.strictEqual(warns.length, 1);
});

test('startInboxRetention na hubie przemiata wstrzykniętymi zależnościami i loguje raz', () => {
  const logs = [];
  const deleted = [];
  const deps = fakeDeps({
    rows: [attachment({ sha256: 'wygasly', closedAgo: 20 * DAY + JITTER_MS, createdAgo: 30 * DAY })],
    uploads: [{ sha256: 'wygasly', uploaded_at: iso(30 * DAY) }],
    deleted,
  });

  startInboxRetention({ isHub: () => true, log: (m) => logs.push(m), warn: (m) => logs.push(m), deps });
  stopInboxRetention();

  assert.deepStrictEqual(deleted, ['wygasly']);
  assert.strictEqual(logs.length, 1, 'jedna linia loga na przemiatanie, które coś zwolniło');
  assert.match(logs[0], /\[inbox-retention\] skasowano bajty 1/);
});

test('startInboxRetention: wyjątek z bazy nie wypływa — jest warn z prefiksem modułu', () => {
  const warns = [];
  const deps = {
    db: {
      listAttachmentsForRetention: () => {
        throw new Error('database is locked');
      },
    },
    blobs: { deleteBlob: () => true, sweepTempUploads: () => 0 },
  };

  assert.doesNotThrow(() =>
    startInboxRetention({ isHub: () => true, log: () => {}, warn: (m) => warns.push(m), deps })
  );
  stopInboxRetention();

  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /^\[inbox-retention\] przemiatanie padło: database is locked/);
});

// === Znacznik zwolnienia a wynik kasowania ===
// Znacznik wypycha wiersz z listAttachmentsForRetention NA ZAWSZE, więc wolno go postawić
// tylko wtedy, gdy bajtów faktycznie nie ma na dysku.

test('pad unlinku NIE stawia znacznika zwolnienia — bajty wracają przy następnym przemiataniu', () => {
  const marked = [];
  const deps = {
    db: {
      listAttachmentsForRetention: () => [attachment({ sha256: 'zablokowany', createdAgo: HARD_TTL_MS + DAY })],
      listAttachmentShas: () => ['zablokowany'],
      listBlobUploads: () => [{ sha256: 'zablokowany', uploaded_at: iso(30 * DAY) }],
      markAttachmentBytesDeleted: (sha, at) => {
        marked.push({ sha, at });
        return 1;
      },
    },
    blobs: {
      deleteBlob: () => {
        throw new Error('EACCES: permission denied');
      },
      sweepTempUploads: () => 0,
    },
  };
  const warns = [];

  const result = sweepInboxRetention({ now: NOW, ...deps, warn: (m) => warns.push(m) });

  assert.strictEqual(result.deletedBlobs, 0);
  assert.deepStrictEqual(marked, [], 'błąd I/O nie może udawać zwolnionego miejsca');
  assert.strictEqual(warns.length, 1);
});

test('brak pliku (ENOENT) stawia znacznik — stan docelowy osiągnięty, bez pętli co godzinę', () => {
  const marked = [];
  const deps = {
    db: {
      listAttachmentsForRetention: () => [attachment({ sha256: 'nieistnieje', createdAgo: HARD_TTL_MS + DAY })],
      listAttachmentShas: () => ['nieistnieje'],
      listBlobUploads: () => [{ sha256: 'nieistnieje', uploaded_at: iso(30 * DAY) }],
      markAttachmentBytesDeleted: (sha, at) => {
        marked.push({ sha, at });
        return 1;
      },
    },
    // deleteBlob zwraca false wyłącznie przy ENOENT (lib/inbox-blobs.js) — realny błąd rzuca.
    blobs: { deleteBlob: () => false, sweepTempUploads: () => 0 },
  };

  const result = sweepInboxRetention({ now: NOW, ...deps, warn: () => {} });

  assert.strictEqual(result.deletedBlobs, 0, 'nie liczymy pliku, którego nie było');
  assert.deepStrictEqual(marked, [{ sha: 'nieistnieje', at: new Date(NOW).toISOString() }]);
});
