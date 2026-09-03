// Team OS — przygotowanie załączników nadawcy: próg rozmiaru, hash, upload bajtów.
//
// Kolejność jest kontraktem, nie estetyką (R2/R3): NAJPIERW sprawdzamy próg dla WSZYSTKICH
// plików, dopiero potem cokolwiek leci przez sieć. Odwrotnie — plik ponad limit wykryty jako
// drugi zostawiłby na hubie bajty pierwszego, wgrane pod wiadomość, która nigdy nie powstanie.
// Z tego samego powodu wywołujący ma wołać `send` DOPIERO po sukcesie wszystkich uploadów:
// pad któregokolwiek transferu znaczy „wiadomość nie powstaje", nie „powstaje bez pliku".

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { attachmentMonth, safeAttachmentName } from './inbox-pull.mjs';
import { extractInboxSection, parseRequestedDownloads } from './inbox-push.mjs';

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
  // Zaokrąglenie W GÓRĘ, nie do najbliższej dziesiątej: przy 26 214 401 B toFixed(1) dałby
  // „ma 25,0 MB i przekracza limit 25 MB" — zdanie wewnętrznie sprzeczne dla całego przedziału
  // 25,00–25,05 MB, w którym odmowa jest jak najbardziej słuszna.
  const mb = Math.ceil((bytes / (1024 * 1024)) * 10) / 10;
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
// `client` jest WYMAGANY (bez domyślki na inbox-client): ten moduł zna pliki, nie transport,
// a każdy wywołujący i tak wstrzykuje klienta jawnie — wzorzec send.mjs/reply.mjs/close.mjs.
// `paths` to wartość `args.attach` z REPEATABLE_KEYS, więc zawsze tablica albo undefined.
export async function prepareAttachments(paths, { client }) {
  const list = paths ?? [];
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

// ──────── odbiór: pobranie odhaczonych załączników do vaulta (R6/R7/R10/R14) ────────

// Lustro ROLE_AGENT z lib/inbox-seed.js. Świadomy duplikat przez granicę modułów (CJS↔ESM),
// jak EXPECTED_API_VERSION w inbox-client: ten skrypt nie ma powodu ciągnąć całej warstwy
// lib/ tylko po jeden literał, a wartość jest zapisana w bazie i nie zmieni się bez migracji.
export const ROLE_AGENT = 'agent';

// Ile razy wolno dokładać sufiks porządkowy przy kolizji nazw, zanim uznamy sytuację za
// patologię (setka plików „raport (n).pdf" to nie kolizja, to pętla) i zgłosimy błąd.
const MAX_NAME_ATTEMPTS = 50;

// Sanityzacja sprawdza EFEKT, nie kształt (R14). `safeAttachmentName` (jedno źródło prawdy,
// współdzielone z renderem) sprowadza nazwę do basename bez separatorów i znaków sterujących,
// ale sama zgodność ze wzorcem niczego nie dowodzi: dopiero `path.resolve` mówi, GDZIE plik
// naprawdę wyląduje. Ta sama przesłanka, dla której guard `.gitignore` pyta gita o efekt
// zamiast czytać wzorce z pliku. Zwraca null, gdy wynik wyszedłby poza katalog miesiąca.
export function resolveAttachmentTarget(attachmentsDir, month, rawFilename) {
  const name = safeAttachmentName(rawFilename);
  const dir = path.resolve(String(attachmentsDir), String(month));
  const target = path.resolve(dir, name);
  // Porównanie po KATALOGU RODZICU, nie po prefiksie stringa: prefiks przepuszcza
  // „<dir>-inny/plik" (ten sam początek, inny katalog).
  if (path.dirname(target) !== dir) return null;
  return { dir, name, target };
}

// Rozstrzyga, dokąd zapisać bajty o danym sha256. Zwraca null, gdy plik o TEJ TREŚCI już
// leży na dysku — pobranie jest wtedy no-opem (idempotencja: obecność pliku JEST stanem
// pobrania, więc powtórka nie może dokładać kopii). Kolizja nazw przy INNEJ treści dostaje
// sufiks porządkowy; pierwszy plik zostaje nietknięty, bo należy do innej wiadomości.
export async function pickDownloadDestination(dir, name, sha256, sizeBytes) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    let st;
    try {
      st = await stat(candidate);
    } catch (err) {
      if (err.code === 'ENOENT') return candidate;
      throw err;
    }
    // Rozmiar rozstrzyga większość kolizji jednym `stat`; bez tego skrótu każda kolizja
    // nazw kosztowała pełny odczyt i hash istniejącego pliku (do 25 MB) tylko po to,
    // by stwierdzić, że treść jest inna.
    if (Number.isFinite(sizeBytes) && st.size !== sizeBytes) continue;
    if ((await sha256OfFile(candidate)) === sha256) return null;
  }
  throw new AttachmentError(
    `Nie mam wolnej nazwy dla pliku ${name} w ${dir} (${MAX_NAME_ATTEMPTS} kolizji) — posprzątaj katalog.`
  );
}

// Indeks załączników z odpowiedzi huba: id → { sha256, filename, month }. Miesiąc bierze się
// z czasu WIADOMOŚCI (tak samo jak w renderze), nie z Date.now(). Przeglądamy wszystkie
// listy pulla, bo wiersz z checkboxem renderuje się dla całej nitki, nie tylko dla `active`.
function indexAttachments(pullData) {
  const index = new Map();
  const lists = [pullData?.active, pullData?.threadRows, pullData?.delegated];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      const month = attachmentMonth(message?.created_at);
      for (const att of attachments) {
        if (!att || typeof att.id !== 'string' || att.id === '') continue;
        if (index.has(att.id)) continue;
        index.set(att.id, { sha256: att.sha256, filename: att.filename, size_bytes: att.size_bytes, month });
      }
    }
  }
  return index;
}

async function readSkrzynka(skrzynkaPath) {
  try {
    return await readFile(skrzynkaPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Weryfikacja bajtów, które właśnie wylądowały w vaultcie. Rozjazd hasha albo przekroczony
// limit rozmiaru = plik kasujemy i zgłaszamy pad; zostawienie go byłoby gorsze niż brak
// pobrania, bo obecność pliku JEST stanem „pobrane" (render przestałby oferować checkbox).
async function verifyDownloadedFile(dest, expectedSha) {
  let size;
  try {
    size = (await stat(dest)).size;
  } catch (err) {
    throw new AttachmentError(`zapisany plik zniknął przed weryfikacją (${err.message})`);
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    await removeFailedDownload(dest);
    throw new AttachmentError(`pobrane bajty mają ${formatBytes(size)} i przekraczają limit 25 MB`);
  }
  const actual = await sha256OfFile(dest);
  if (actual !== expectedSha) {
    await removeFailedDownload(dest);
    throw new AttachmentError(`hub oddał inne bajty niż zamówione (sha256 ${actual} ≠ ${expectedSha})`);
  }
}

async function removeFailedDownload(dest) {
  try {
    await unlink(dest);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[inbox-attachments] nie skasowałem wadliwego pliku ${dest}: ${err.message}`);
    }
  }
}

// Krok „pobrania" syncu. Wykonuje WYŁĄCZNIE akcje lokalne (R9): czyta Skrzynkę, ściąga bajty
// po sha256 i zapisuje plik. Zero `client.done()`, zero zmiany statusu, zero archiwum —
// hub nie dowiaduje się o pobraniu niczego.
//
// `role` to rola maszyny (state.inbox_role) wstrzykiwana przez wywołującego. Maszyna-agent
// nie pobiera NIGDY (R10): job syncu z natury na niej nie powstaje (lib/inbox-seed.js),
// ale rolę bywa ustawiana ręcznie, więc druga warstwa obrony siedzi tutaj — przed odczytem
// pliku i przed jakimkolwiek żądaniem do huba.
export async function downloadRequestedAttachments({
  client,
  role = null,
  getRole = null,
  skrzynkaPath,
  attachmentsDir,
} = {}) {
  const stats = { downloaded: 0, already: 0, skipped: 0, failed: 0, pullData: null };

  if (!client) throw new AttachmentError('downloadRequestedAttachments: wymagany klient huba.');
  if (!skrzynkaPath) throw new AttachmentError('downloadRequestedAttachments: brak INBOX_SKRZYNKA_PATH.');
  if (!attachmentsDir) throw new AttachmentError('downloadRequestedAttachments: brak INBOX_ATTACHMENTS_DIR.');

  const raw = await readSkrzynka(skrzynkaPath);
  if (raw === null) return stats;

  const requested = parseRequestedDownloads(extractInboxSection(raw));
  // Brak odhaczeń = brak ruchu w sieci ANI w bazie. To najczęstszy przebieg (sync co minutę,
  // świeży proces), więc i pull po metadane, i odczyt roli maszyny (leniwe otwarcie
  // data/claude-cron.db razem z pełnym migrate) robimy dopiero, gdy jest co pobierać.
  if (requested.length === 0) return stats;

  // Rola sprawdzana PRZED pullem, mkdir i jakimkolwiek zapisem — R10 (maszyna-agent nie
  // pobiera nigdy) zostaje nietknięte, mimo że odczyt zszedł za bramkę „czy jest co robić".
  const effectiveRole = role !== null && role !== undefined ? role : (getRole ? getRole() : null);
  if (effectiveRole === ROLE_AGENT) {
    console.log('[inbox-attachments] rola maszyny = agent — pobrania pominięte');
    return { ...stats, role_skipped: true };
  }

  const pullData = await client.pull();
  stats.pullData = pullData;
  const index = indexAttachments(pullData);

  for (const { attachment_id: id } of requested) {
    const meta = index.get(id);
    // Załącznik nieznany w bieżącym pullu (wątek domknięty, bajty wygasły, ręczna edycja
    // markera) — pomijamy bez rzutu; przy następnym renderze wiersz i tak zniknie.
    if (!meta || !meta.sha256 || !meta.filename) {
      console.warn(`[inbox-attachments] pomijam ${id}: brak metadanych w odpowiedzi huba`);
      stats.skipped++;
      continue;
    }

    const target = resolveAttachmentTarget(attachmentsDir, meta.month, meta.filename);
    if (target === null) {
      console.warn(`[inbox-attachments] odmowa zapisu ${id}: nazwa wyprowadza poza katalog załączników`);
      stats.skipped++;
      continue;
    }

    const declaredSize = Number(meta.size_bytes);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_BYTES) {
      console.warn(`[inbox-attachments] odmowa zapisu ${id}: metadane deklarują ${formatBytes(declaredSize)} (limit 25 MB)`);
      stats.skipped++;
      continue;
    }

    try {
      await mkdir(target.dir, { recursive: true });
      const dest = await pickDownloadDestination(target.dir, target.name, meta.sha256, declaredSize);
      if (dest === null) {
        stats.already++;
        continue;
      }
      // Zapis idzie przez plik tymczasowy i `rename` po stronie klienta — przerwane pobranie
      // NIE zostawia w vaultcie pliku wyglądającego na kompletny, a to istotne, bo obecność
      // pliku jest jedynym stanem pobrania.
      await client.downloadBlob(meta.sha256, dest);
      // Bajty przyszły z sieci i lądują w vaultcie pod nazwą, którą człowiek uzna za zaufaną.
      // Hub (albo cokolwiek stoi między nami a hubem) oddający INNĄ treść niż zamówiony
      // sha256 podłożyłby obcy plik bez jednego słowa w logu, a strumień bez limitu potrafi
      // zapełnić dysk vaulta. Dlatego werdykt zapada PO zapisie, na faktycznych bajtach.
      await verifyDownloadedFile(dest, meta.sha256);
      stats.downloaded++;
    } catch (err) {
      // Pad jednego pliku nie zabiera reszty ani całego syncu. Retry NIE jest automatyczne:
      // krok 3 syncu przerenderuje blok i wiersz wróci jako nieodhaczone „Pobierz", więc
      // ponowienie jest świadomą decyzją człowieka (a nieudany plik nie znika po cichu —
      // idzie do stats.failed i na stderr runu).
      console.error(`[inbox-attachments] nie pobrałem ${id}: ${err.message}`);
      stats.failed++;
    }
  }

  console.log(
    `[inbox-attachments] ${new Date().toISOString()} — ` +
      `downloaded=${stats.downloaded} already=${stats.already} skipped=${stats.skipped} failed=${stats.failed}`
  );
  return stats;
}
