// Testy przygotowania załączników nadawcy. Mockowany wyłącznie klient huba (uploadBlob);
// pliki są prawdziwe (tmp), bo testowanym zachowaniem jest właśnie odczyt metadanych i hash.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareAttachments, guessMime, formatBytes, MAX_ATTACHMENT_BYTES } from './attachments.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-attach-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function fakeClient({ failOn = null } = {}) {
  const uploads = [];
  return {
    uploads,
    uploadBlob: async (sha256, filePath) => {
      uploads.push({ sha256, filePath });
      if (failOn !== null && uploads.length === failOn) {
        throw new Error('hub padł w połowie transferu');
      }
      return { v: 1, sha256, deduped: false };
    },
  };
}

test('prepareAttachments: dwa pliki → dwa komplety metadanych i dwa uploady', async () => {
  const a = writeFile('raport.pdf', 'AAA');
  const b = writeFile('zrzut.png', 'BBB');
  const client = fakeClient();

  const out = await prepareAttachments([a, b], { client });

  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((x) => [x.filename, x.size_bytes, x.mime]),
    [['raport.pdf', 3, 'application/pdf'], ['zrzut.png', 3, 'image/png']]
  );
  assert.equal(out[0].sha256, createHash('sha256').update('AAA').digest('hex'));
  assert.equal(client.uploads.length, 2);
});

test('prepareAttachments: plik ponad 25 MB → odmowa PRZED jakimkolwiek uploadem (R3)', async () => {
  // Plik rzadki (truncate) zamiast realnych 26 MB zapisanych na dysk: próg czyta wyłącznie
  // rozmiar ze `stat`, a pompowanie megabajtów w teście spowalnia całą suitę.
  const big = path.join(dir, 'wideo.mp4');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, MAX_ATTACHMENT_BYTES + 1024 * 1024);
  const small = writeFile('mała.txt', 'x');
  const client = fakeClient();

  await assert.rejects(
    prepareAttachments([small, big], { client }),
    /Plik wideo\.mp4 ma 26,0 MB i przekracza limit 25 MB\. Wrzuć go na Dysk i wyślij link w treści wiadomości\./
  );
  // Próg dla WSZYSTKICH plików sprawdzany przed transferem — mock nie dostał żadnego żądania.
  assert.equal(client.uploads.length, 0);
});

test('prepareAttachments: pad uploadu drugiego pliku → wyjątek, brak metadanych (R2)', async () => {
  const a = writeFile('a.txt', 'A');
  const b = writeFile('b.txt', 'B');
  const client = fakeClient({ failOn: 2 });

  await assert.rejects(prepareAttachments([a, b], { client }), /hub padł/);
  assert.equal(client.uploads.length, 2);
});

test('prepareAttachments: ten sam plik dwa razy → jeden sha256, dwa rekordy metadanych (R4)', async () => {
  const a = writeFile('logo.png', 'TRESC');
  const client = fakeClient();

  const out = await prepareAttachments([a, a], { client });

  assert.equal(out.length, 2);
  assert.equal(out[0].sha256, out[1].sha256);
  assert.equal(client.uploads.length, 2); // upload jest idempotentny — drugi trafia w istniejący blob
});

test('prepareAttachments: nieistniejąca ścieżka → czytelny błąd przed transferem', async () => {
  const client = fakeClient();
  await assert.rejects(
    prepareAttachments([path.join(dir, 'nie-ma.txt')], { client }),
    /Nie znalazłem pliku do załączenia/
  );
  assert.equal(client.uploads.length, 0);
});

test('prepareAttachments: katalog zamiast pliku → błąd przed transferem', async () => {
  const client = fakeClient();
  await assert.rejects(prepareAttachments([dir], { client }), /To nie jest plik/);
  assert.equal(client.uploads.length, 0);
});

test('prepareAttachments: brak --attach → pusta lista i zero żądań', async () => {
  const client = fakeClient();
  assert.deepEqual(await prepareAttachments(undefined, { client }), []);
  assert.deepEqual(await prepareAttachments([], { client }), []);
  assert.equal(client.uploads.length, 0);
});

test('prepareAttachments: plik DOKŁADNIE na progu 25 MB → przechodzi (granica po stronie dozwolonej)', async () => {
  // Bez tego przypadku zamiana `>` na `>=` w inspectFiles rozjechałaby klienta z hubem
  // (server.js i lib/inbox-blobs.js porównują ostro) — plik legalny dla huba byłby odrzucany
  // lokalnie, a diagnoza wskazywałaby na hub.
  const edge = path.join(dir, 'na-progu.bin');
  fs.writeFileSync(edge, '');
  fs.truncateSync(edge, MAX_ATTACHMENT_BYTES);
  const client = fakeClient();

  const out = await prepareAttachments([edge], { client });

  assert.equal(out.length, 1);
  assert.equal(out[0].size_bytes, MAX_ATTACHMENT_BYTES);
  assert.equal(client.uploads.length, 1);
});

test('guessMime: znane rozszerzenie → typ, nieznane → null (podpowiedź, nie decyzja)', () => {
  assert.equal(guessMime('a.PNG'), 'image/png');
  assert.equal(guessMime('a.xyz'), null);
  assert.equal(guessMime('bez-rozszerzenia'), null);
});

test('formatBytes: przecinek dziesiętny w komunikacie po polsku', () => {
  assert.equal(formatBytes(26 * 1024 * 1024), '26,0 MB');
  // Zaokrąglenie w górę: pierwszy bajt ponad limit nie może wyświetlić się jako „25,0 MB",
  // bo komunikat odmowy przeczyłby wtedy sam sobie.
  assert.equal(formatBytes(MAX_ATTACHMENT_BYTES + 1), '25,1 MB');
});
