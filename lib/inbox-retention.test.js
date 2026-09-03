const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const inboxDb = require('./inbox-db');
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

function fakeDeps({ rows = [], uploads = [], deleted = [], failOn = null } = {}) {
  return {
    db: {
      listAttachmentsForRetention: () => rows,
      listBlobUploads: () => uploads,
    },
    blobs: {
      deleteBlob: (sha) => {
        if (sha === failOn) throw new Error('EACCES');
        deleted.push(sha);
        return true;
      },
    },
  };
}

test('przemiatanie przy braku czegokolwiek do skasowania nie rzuca i nie loguje ostrzeżeń', () => {
  const warns = [];
  const deps = fakeDeps({ rows: [attachment({ closedAgo: DAY })] });
  const result = sweepInboxRetention({ now: NOW, ...deps, warn: (m) => warns.push(m) });

  assert.deepStrictEqual(result, { expired: 0, deletedBlobs: 0, deletedOrphans: 0 });
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

  assert.deepStrictEqual(result, { expired: 1, deletedBlobs: 1, deletedOrphans: 1 });
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

  assert.strictEqual(asked, 1, 'guard pytany przy każdym przemiataniu');
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
    attachments: [{ filename: 'a.pdf', size_bytes: 10, mime: 'application/pdf', sha256: 'f'.repeat(64) }],
  });
  assert.ok(msg.id);

  const rows = inboxDb.listAttachmentsForRetention();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sha256, 'f'.repeat(64));
  assert.strictEqual(rows[0].thread_closed_at, null);
});

test('listBlobUploads zwraca jeden wiersz per hash z najświeższym wgraniem', () => {
  const sha = 'a'.repeat(64);
  inboxDb.recordBlobUpload(sha, 'kacper');
  inboxDb.recordBlobUpload(sha, 'kamil');

  const uploads = inboxDb.listBlobUploads();
  assert.strictEqual(uploads.length, 1);
  assert.strictEqual(uploads[0].sha256, sha);
  assert.ok(Date.parse(uploads[0].uploaded_at) > 0);
});
