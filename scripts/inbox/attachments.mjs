// Team OS — przygotowanie załączników nadawcy: próg rozmiaru, hash, upload bajtów.
//
// Kolejność jest kontraktem, nie estetyką (R2/R3): NAJPIERW sprawdzamy próg dla WSZYSTKICH
// plików, dopiero potem cokolwiek leci przez sieć. Odwrotnie — plik ponad limit wykryty jako
// drugi zostawiłby na hubie bajty pierwszego, wgrane pod wiadomość, która nigdy nie powstanie.
// Z tego samego powodu wywołujący ma wołać `send` DOPIERO po sukcesie wszystkich uploadów:
// pad któregokolwiek transferu znaczy „wiadomość nie powstaje", nie „powstaje bez pliku".

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import * as inboxClient from './inbox-client.mjs';

// Próg mierzy WYŁĄCZNIE pojedynczy plik — sumy wiadomości nie limitujemy (kwoty miejsca
// zostały świadomie wycofane). Lustro MAX_ATTACHMENT_BYTES z lib/inbox-api.js: hub egzekwuje
// tę samą wartość w strumieniu, tutaj jest po to, by nie zaczynać transferu skazanego na 413.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// `mime` jest wyłącznie PODPOWIEDZIĄ do renderu u odbiorcy (R14) — nigdy nie decyduje
// o miejscu ani sposobie zapisu (o tym rozstrzyga hash). Nieznane rozszerzenie = brak
// deklaracji, bo zgadywanie „application/octet-stream" niczego nie wnosi.
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function guessMime(filename) {
  return MIME_BY_EXT[path.extname(String(filename)).toLowerCase()] ?? null;
}

// Rozmiar dla człowieka w komunikacie odmowy. Przecinek dziesiętny, bo komunikat jest polski.
export function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1).replace('.', ',')} MB`;
}

export class AttachmentError extends Error {}

async function sha256OfFile(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// Pierwsze przejście: wyłącznie odczyt metadanych pliku, zero sieci. Rzuca przy pierwszym
// problemie — nadawca ma poprawić polecenie, a nie zobaczyć wiadomość z połową plików.
async function inspectFiles(paths) {
  const files = [];
  for (const raw of paths) {
    const filePath = String(raw);
    let info;
    try {
      info = await stat(filePath);
    } catch (err) {
      throw new AttachmentError(
        err.code === 'ENOENT'
          ? `Nie znalazłem pliku do załączenia: ${filePath}`
          : `Nie mogę odczytać pliku do załączenia: ${filePath} (${err.message})`
      );
    }
    if (!info.isFile()) {
      throw new AttachmentError(`To nie jest plik: ${filePath} (katalogów nie da się załączyć).`);
    }
    const filename = path.basename(filePath);
    if (info.size > MAX_ATTACHMENT_BYTES) {
      // Tekst verbatim z planu — kieruje wprost na Dysk, bo hub nie przyjmie tego pliku
      // ani teraz, ani po retry.
      throw new AttachmentError(
        `Plik ${filename} ma ${formatBytes(info.size)} i przekracza limit 25 MB. ` +
          'Wrzuć go na Dysk i wyślij link w treści wiadomości.'
      );
    }
    files.push({ filePath, filename, size_bytes: info.size });
  }
  return files;
}

// Zwraca metadane gotowe do przekazania w polu `attachments` wywołania `send`.
// client wstrzykiwany dla testowalności (mock huba) — wzorzec send.mjs/close.mjs.
export async function prepareAttachments(paths, { client = inboxClient } = {}) {
  if (paths == null) return [];
  const list = Array.isArray(paths) ? paths : [paths];
  if (list.length === 0) return [];

  const files = await inspectFiles(list);

  const prepared = [];
  for (const file of files) {
    const sha256 = await sha256OfFile(file.filePath);
    // Upload jest adresowany treścią i idempotentny: ten sam plik wysłany drugi raz trafia
    // w istniejący blob (hub odsyła `deduped`), a powstają DWA rekordy metadanych na jeden
    // sha256 (R4) — dedup jest po stronie bajtów, nie wiadomości.
    await client.uploadBlob(sha256, file.filePath);
    prepared.push({
      sha256,
      filename: file.filename,
      size_bytes: file.size_bytes,
      mime: guessMime(file.filename),
    });
  }
  return prepared;
}
