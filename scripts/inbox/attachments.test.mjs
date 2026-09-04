// Testy przygotowania załączników nadawcy. Mockowany wyłącznie klient huba (uploadBlob);
// pliki są prawdziwe (tmp), bo testowanym zachowaniem jest właśnie odczyt metadanych i hash.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_ATTACHMENT_BYTES,
  ROLE_AGENT,
  downloadRequestedAttachments,
  formatBytes,
  guessMime,
  prepareAttachments,
  resolveAttachmentTarget,
} from './attachments.mjs';
import { attachmentFileName, renderAttachmentLine } from './inbox-pull.mjs';

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

// ──────── odbiór: pobranie odhaczonych załączników (IU-8) ────────
// Mockowany wyłącznie klient huba (pull/downloadBlob); Skrzynka, katalog załączników i pliki
// są PRAWDZIWE — testowanym zachowaniem jest właśnie to, co ląduje na dysku i gdzie.
// Wiersz Skrzynki budujemy prawdziwym renderem (roundtrip render → odhaczenie → pobranie),
// bo kontrakt render↔parser↔zapis jest najkruchszym miejscem tej ścieżki.

const ATT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ATT_ID2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MSG_AT = '2026-07-24T07:12:00.000Z';
const MONTH = '2026-07';

// Zawartość katalogu miesiąca (pusta lista, gdy katalogu nie ma) — asercja „nic nie zostało"
// musi patrzeć na FAKTYCZNE nazwy plików, bo te niosą skrót sha, nie gołą nazwę nadawcy.
function listMonth(attachmentsDir) {
  const dir = path.join(attachmentsDir, MONTH);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Skrzynka z odhaczonymi wierszami „Pobierz" — linie pochodzą z prawdziwego renderu,
// więc test padnie, gdy render i parser się rozjadą.
function skrzynkaWithChecked(attachments) {
  const lines = attachments.map(att =>
    renderAttachmentLine(att, MONTH, () => false).replace('- [ ] Pobierz', '- [x] Pobierz')
  );
  return [
    '# Skrzynka',
    '',
    '%% inbox:items:start %%',
    '> [!todo]- Wiadomosc z plikiem',
    ...lines,
    '%% inbox:items:end %%',
    '',
  ].join('\n');
}

function attachment({ id = ATT_ID, filename = 'raport.pdf', content = 'PDF-1' } = {}) {
  return { id, filename, size_bytes: content.length, mime: 'application/pdf', sha256: sha256Of(content), content };
}

// Hub-atrapa: `pull` oddaje jedną wiadomość z podanymi załącznikami, `downloadBlob` zapisuje
// bajty pod wskazaną ścieżką. `done` istnieje po to, by test R9 mógł udowodnić, że NIKT go
// nie woła — nie po to, by go obsłużyć.
function fakeHub(attachments, { onDownload = null } = {}) {
  const calls = [];
  const byHash = new Map(attachments.map(a => [a.sha256, a.content]));
  return {
    calls,
    pull: async () => {
      calls.push('pull');
      const message = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        created_at: MSG_AT,
        attachments: attachments.map(({ content, ...meta }) => meta),
      };
      return { v: 1, user: 'alicja', active: [message], threadRows: [message], delegated: [] };
    },
    downloadBlob: async (sha256, destPath) => {
      calls.push(`downloadBlob:${path.basename(destPath)}`);
      if (onDownload) return onDownload(sha256, destPath);
      fs.writeFileSync(destPath, byHash.get(sha256) ?? '');
      return { path: destPath, size: (byHash.get(sha256) ?? '').length };
    },
    done: async () => {
      calls.push('done');
      throw new Error('done nie powinno byc wolane dla akcji lokalnej');
    },
  };
}

function vault(skrzynkaContent) {
  const skrzynka = path.join(dir, 'Skrzynka.md');
  fs.writeFileSync(skrzynka, skrzynkaContent, 'utf8');
  return { skrzynka, attachmentsDir: path.join(dir, 'Zasoby', 'inbox-zalaczniki') };
}

test('odhaczony zalacznik → plik laduje w katalogu miesiaca pod sanityzowana nazwa (happy path)', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([att]);

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  // Nazwa na dysku niesie skrót sha256 — to kontrakt renderu z pobieraniem (render
  // rozstrzyga „pobrany?" jednym `stat`, bez czytania zawartości).
  const target = path.join(attachmentsDir, MONTH, attachmentFileName('raport.pdf', att.sha256));
  assert.equal(fs.readFileSync(target, 'utf8'), 'PDF-1');
  assert.equal(stats.downloaded, 1);
});

test('pobranie jest akcja WYLACZNIE lokalna — zero wywolan zmieniajacych stan huba (R9)', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([att]);

  await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.deepEqual(client.calls, ['pull', `downloadBlob:${attachmentFileName('raport.pdf', att.sha256)}`]);
  assert.ok(!client.calls.includes('done'), 'done() nie moze pasc przy pobraniu');
});

test('nazwa "../../../etc/passwd" → zapis WEWNATRZ katalogu miesiaca, nigdy poza nim (R14)', async () => {
  const att = attachment({ filename: '../../../etc/passwd', content: 'ZLE' });
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([att]);

  await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  const zapisany = attachmentFileName('passwd', att.sha256);
  assert.equal(fs.readFileSync(path.join(attachmentsDir, MONTH, zapisany), 'utf8'), 'ZLE');
  // Nic nie wyszlo poza katalog miesiaca — ani do vaulta, ani wyzej.
  assert.deepEqual(fs.readdirSync(path.join(attachmentsDir, MONTH)), [zapisany]);
  assert.deepEqual(fs.readdirSync(attachmentsDir), [MONTH]);
});

test('resolveAttachmentTarget: separator, znak sterujacy i ".." sprowadzone do basename (R14)', () => {
  const base = path.join(dir, 'zal');
  const cases = [
    ['podkatalog/plik.txt', 'plik.txt'],
    // Separator Windows na POSIX-ie nie jest separatorem dla `path.basename`, wiec zostaje
    // WYCIETY ze srodka nazwy (nie rozbija sciezki). Nazwa wychodzi brzydka, ale wlasnosc,
    // ktora chronimy, to EFEKT: zero separatorow i zapis w katalogu miesiaca (asercja nizej).
    ['..\\..\\plik.txt', '....plik.txt'],
    // Znak sterujacy budowany z kodu, nie wklejony do zrodla — niewidzialny znak w pliku
    // testu jest pulapka dla kazdego, kto go pozniej czyta (wzorzec neutralizeMarkers).
    [`plik${String.fromCharCode(0x01)}.txt`, 'plik.txt'],
    ['..', 'zalacznik'],
    ['.', 'zalacznik'],
    ['', 'zalacznik'],
  ];
  for (const [raw, expected] of cases) {
    const out = resolveAttachmentTarget(base, MONTH, raw);
    assert.notEqual(out, null, `brak wyniku dla ${JSON.stringify(raw)}`);
    assert.equal(out.name, expected, `nazwa dla ${JSON.stringify(raw)}`);
    // Sedno: sprawdzamy EFEKT — wynik po resolve lezy w katalogu miesiaca.
    assert.equal(path.dirname(out.target), path.resolve(base, MONTH));
  }
});

test('powtorne pobranie tego samego pliku → brak drugiego pliku i brak transferu (idempotencja)', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  fs.mkdirSync(path.join(attachmentsDir, MONTH), { recursive: true });
  const naDysku = attachmentFileName('raport.pdf', att.sha256);
  fs.writeFileSync(path.join(attachmentsDir, MONTH, naDysku), att.content);
  const client = fakeHub([att]);

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.deepEqual(fs.readdirSync(path.join(attachmentsDir, MONTH)), [naDysku]);
  assert.equal(stats.already, 1);
  assert.equal(stats.downloaded, 0);
  assert.deepEqual(client.calls, ['pull'], 'bajty nie leca drugi raz');
});

test('kolizja nazw przy INNEJ tresci → dwa pliki obok siebie, pierwszy nietkniety', async () => {
  const att = attachment({ id: ATT_ID2, content: 'NOWA TRESC' });
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  fs.mkdirSync(path.join(attachmentsDir, MONTH), { recursive: true });
  // Plik innej wiadomosci o TEJ SAMEJ nazwie od nadawcy — lezy pod nazwa ze SWOIM skrotem.
  const cudzy = attachmentFileName('raport.pdf', sha256Of('STARA TRESC'));
  fs.writeFileSync(path.join(attachmentsDir, MONTH, cudzy), 'STARA TRESC');
  const client = fakeHub([att]);

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.equal(fs.readFileSync(path.join(attachmentsDir, MONTH, cudzy), 'utf8'), 'STARA TRESC');
  const moj = attachmentFileName('raport.pdf', att.sha256);
  assert.notEqual(moj, cudzy, 'ta sama nazwa od nadawcy, inne nazwy na dysku');
  assert.equal(fs.readFileSync(path.join(attachmentsDir, MONTH, moj), 'utf8'), 'NOWA TRESC');
  assert.equal(stats.downloaded, 1);
});

test('odmowa: plik o wlasciwej nazwie, ale UCIETY (inny rozmiar) nie uchodzi za pobrany', async () => {
  const att = attachment({ content: 'PELNA TRESC PLIKU' });
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  fs.mkdirSync(path.join(attachmentsDir, MONTH), { recursive: true });
  const naDysku = path.join(attachmentsDir, MONTH, attachmentFileName('raport.pdf', att.sha256));
  fs.writeFileSync(naDysku, 'PELNA'); // przerwany zapis spoza naszej sciezki / konflikt Sync
  const client = fakeHub([att]);

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.equal(stats.downloaded, 1, 'ucięty plik jest nadpisywany, nie uznawany za pobranie');
  assert.equal(stats.already, 0);
  assert.equal(fs.readFileSync(naDysku, 'utf8'), 'PELNA TRESC PLIKU');
});

test('przerwane pobranie → brak pliku docelowego, stan pozostaje "niepobrany"', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([att], {
    onDownload: async () => { throw new Error('przerwany transfer'); },
  });

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  // Nazwa na dysku niesie skrót sha (attachmentFileName) — sprawdzanie gołego 'raport.pdf'
  // było asercją zawsze prawdziwą, także gdy ucięty plik ZOSTAJE w vaultcie.
  assert.equal(fs.existsSync(path.join(attachmentsDir, MONTH, attachmentFileName('raport.pdf', att.sha256))), false);
  assert.deepEqual(listMonth(attachmentsDir), [], 'po przerwanym transferze nie zostaje żaden plik');
  assert.equal(stats.failed, 1);
  assert.equal(stats.downloaded, 0);
});

test('rola maszyny = agent → krok pobran jest no-opem mimo odhaczonych checkboxow (R10)', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([att]);

  const stats = await downloadRequestedAttachments({ client, role: ROLE_AGENT, skrzynkaPath: skrzynka, attachmentsDir });

  assert.deepEqual(client.calls, [], 'agent nie dotyka huba');
  assert.equal(fs.existsSync(path.join(attachmentsDir, MONTH)), false);
  assert.equal(stats.role_skipped, true);
});

test('brak odhaczonych pobran → zero zadan do huba (najczestszy przebieg syncu)', async () => {
  const att = attachment();
  const nieodhaczona = skrzynkaWithChecked([att]).replace('- [x] Pobierz', '- [ ] Pobierz');
  const { skrzynka, attachmentsDir } = vault(nieodhaczona);
  const client = fakeHub([att]);

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.deepEqual(client.calls, []);
  assert.equal(stats.downloaded, 0);
});

test('odhaczony zalacznik nieznany hubowi → pominiety bez rzutu', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  // Hub oddaje INNY zalacznik niz odhaczony (watek domkniety, bajty wygasly).
  const client = fakeHub([attachment({ id: ATT_ID2, filename: 'inny.pdf', content: 'X' })]);

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.equal(stats.skipped, 1);
  assert.equal(stats.downloaded, 0);
});

// Regresja po review fazy 3: bajty z sieci lądują w vaultcie pod nazwą, którą człowiek
// uzna za zaufaną, więc werdykt musi zapadać na FAKTYCZNEJ treści, nie na obietnicy huba.
test('hub oddaje INNE bajty niż zamówiony sha256 → plik skasowany i pad zgłoszony', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([att], {
    onDownload: async (sha256, destPath) => {
      fs.writeFileSync(destPath, 'PODMIENIONA TRESC');
      return { path: destPath, size: 17 };
    },
  });

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.equal(
    fs.existsSync(path.join(attachmentsDir, MONTH, attachmentFileName('raport.pdf', att.sha256))),
    false,
    'wadliwy plik nie zostaje w vaultcie'
  );
  assert.deepEqual(listMonth(attachmentsDir), [], 'po rozjeździe sumy nie zostaje żaden plik');
  assert.equal(stats.failed, 1);
  assert.equal(stats.downloaded, 0);
});

test('metadane deklarujące plik ponad limit 25 MB → zero transferu', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([{ ...att, size_bytes: MAX_ATTACHMENT_BYTES + 1 }]);

  const stats = await downloadRequestedAttachments({ client, skrzynkaPath: skrzynka, attachmentsDir });

  assert.deepEqual(client.calls, ['pull'], 'bajty nie lecą w ogóle');
  assert.equal(stats.skipped, 1);
  assert.equal(stats.downloaded, 0);
});

test('rola maszyny czytana LENIWIE: brak odhaczeń = zero wywołań getRole', async () => {
  const att = attachment();
  const nieodhaczona = skrzynkaWithChecked([att]).replace('- [x] Pobierz', '- [ ] Pobierz');
  const { skrzynka, attachmentsDir } = vault(nieodhaczona);
  const client = fakeHub([att]);
  let wywolania = 0;

  await downloadRequestedAttachments({
    client,
    getRole: () => { wywolania++; return 'client'; },
    skrzynkaPath: skrzynka,
    attachmentsDir,
  });

  assert.equal(wywolania, 0, 'baza Pulsa nie jest otwierana w najczęstszym przebiegu syncu');
});

test('getRole zwracające agenta blokuje pobranie tak samo jak jawne role (R10)', async () => {
  const att = attachment();
  const { skrzynka, attachmentsDir } = vault(skrzynkaWithChecked([att]));
  const client = fakeHub([att]);

  const stats = await downloadRequestedAttachments({
    client,
    getRole: () => ROLE_AGENT,
    skrzynkaPath: skrzynka,
    attachmentsDir,
  });

  assert.equal(stats.role_skipped, true);
  assert.deepEqual(client.calls, [], 'agent nie dotyka huba');
});
