#!/usr/bin/env node
// Team OS — wykrywanie CICHEJ awarii Obsidian Sync.
//
// Po co to istnieje: 29.07.2026 klient `ob sync` na VPS wisiał 26 godzin bez jednej
// przesłanej zmiany w żadną stronę. Proces żył, `ob sync-status` raportował
// „bidirectional", a UI na Macu pisało „Obsidian Sync jest teraz aktywny". Żaden
// wskaźnik stanu nie kłamał wprost — po prostu ŻADEN nie mierzył tego, co ważne.
//
// Dlatego ten skrypt nie sprawdza ani procesu, ani statusu, tylko JEDYNĄ rzecz,
// która ma znaczenie: czy dane faktycznie płyną. Każda maszyna zapisuje własny
// znacznik czasu, a MAC patrzy na znacznik drugiej strony. Znacznik przestał się
// odświeżać = kanał stoi, niezależnie od tego, co twierdzą statusy.
//
// Osąd siedzi wyłącznie po stronie Maca, bo tylko Mac wie, czy Mac śpi albo jest
// offline. VPS nie odróżni „Mac wyłączony" od „sync padł" — pierwszego dnia
// działania wysłał 28 fałszywych alarmów, gdy laptop po prostu spał. Dlatego VPS
// jest write-only (pisze vps.md, niczego nie sprawdza), a Mac przed kontrolą
// wyklucza dwa niewinne scenariusze: właśnie wstał po uśpieniu (własny znacznik
// stary — sync nie miał kiedy nadrobić) i brak internetu (sync nie ma prawa
// działać). Alarm zostaje tylko na sytuację: Mac włączony, online, a vps.md stoi.
//
// Użycie (script-job w Pulsie, cwd = workspace):
//   node scripts/sync-heartbeat.mjs --write Zasoby/_sync/mac.md \
//        --check Zasoby/_sync/vps.md --max-age-min 45
//
// Kod wyjścia 1 = alarm (job pada → Puls wysyła powiadomienie skonfigurowanym
// kanałem). Zero nowej integracji z Discordem: korzystamy z mechanizmu, który
// już obsługuje nieudane joby.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Znacznik czytamy Z TREŚCI pliku, nie z mtime. Przy synchronizacji plik jest
// zapisywany lokalnie w momencie odbioru, więc mtime pokazuje „kiedy do mnie
// dotarł", a nie „kiedy druga maszyna go wystawiła" — czyli dokładnie odwrotnie
// niż potrzeba: przy zepsutym syncu mtime potrafi być świeży mimo starych danych.
const UPDATED_RE = /^updated:\s*(\S+)/m;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    }
  }
  return out;
}

export function renderHeartbeat({ device, now }) {
  return `---\nupdated: ${now}\ndevice: ${device}\n---\n\n` +
    'Znacznik żywotności Obsidian Sync — plik generowany automatycznie przez Pulsa.\n' +
    'Druga maszyna sprawdza, czy data powyżej się odświeża. Nie edytuj ręcznie.\n';
}

// Zwraca wiek znacznika w minutach albo powód, dla którego nie da się go ustalić.
export function evaluateHeartbeat(raw, nowMs) {
  if (raw == null) return { ok: false, reason: 'missing' };
  const m = raw.match(UPDATED_RE);
  if (!m) return { ok: false, reason: 'malformed' };
  const stampMs = Date.parse(m[1]);
  if (Number.isNaN(stampMs)) return { ok: false, reason: 'malformed' };
  // Znacznik z przyszłości (rozjechane zegary maszyn) traktujemy jak wiek 0 —
  // alarmujemy o zastoju, nie o niezsynchronizowanym czasie.
  return { ok: true, ageMin: Math.max(0, (nowMs - stampMs) / 60000) };
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Rola maszyny bez argumentów CLI.
//
// Script-joby Pulsa uruchamiają `node <command>` i NIE przekazują argumentów, więc
// job nie może podać ścieżek. Wyprowadzamy je z platformy: w tej topologii jest
// dokładnie jeden Mac (laptop) i jeden Linux (VPS). Gdy dojdzie trzecia maszyna,
// nadpisz jawnie przez SYNC_HEARTBEAT_SELF / SYNC_HEARTBEAT_PEER — wtedy platforma
// przestaje cokolwiek rozstrzygać.
export function resolveRole({ platform, env = {} }) {
  if (env.SYNC_HEARTBEAT_SELF && env.SYNC_HEARTBEAT_PEER) {
    return { self: env.SYNC_HEARTBEAT_SELF, peer: env.SYNC_HEARTBEAT_PEER, device: env.SYNC_HEARTBEAT_DEVICE || platform };
  }
  // VPS pisze tylko własny znacznik (peer: null) — patrz nagłówek: nie umie
  // odróżnić uśpionego Maca od zepsutego synca, więc nie jemu oceniać.
  return platform === 'darwin'
    ? { self: 'Zasoby/_sync/mac.md', peer: 'Zasoby/_sync/vps.md', device: 'maczek' }
    : { self: 'Zasoby/_sync/vps.md', peer: null, device: 'vps' };
}

// Kontrola znacznika drugiej strony ma sens tylko, gdy TA maszyna była na chodzie
// przez ostatnie okno i ma internet. Własny znacznik stary/nieobecny = dopiero
// wstaliśmy (albo pierwszy run) — sync nie miał kiedy dostarczyć pliku, prawdziwy
// test zrobi następny run. `ownVerdict: null` = tryb bez zapisu (samo --check):
// nie znamy własnej historii, więc gate „wake" nie ma podstaw i nie blokuje.
export function shouldSkipCheck({ ownVerdict, online, maxAgeMin }) {
  if (!online) return { skip: true, reason: 'offline' };
  if (ownVerdict && (!ownVerdict.ok || ownVerdict.ageMin > maxAgeMin)) {
    return { skip: true, reason: 'wake' };
  }
  return { skip: false };
}

// Dowolna odpowiedź HTTP = jest sieć (status nie ma znaczenia); błąd/timeout = offline.
export async function checkOnline({ url = 'https://api.obsidian.md/', timeoutMs = 5000 } = {}) {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const workspace = process.env.CLAUDE_CRON_WORKSPACE || process.cwd();
  const maxAgeMin = Number(args['max-age-min'] ?? 45);

  // Bez jawnych ścieżek działamy w trybie automatycznym (tak woła nas job Pulsa).
  if (!args.write && !args.check) {
    const role = resolveRole({ platform: process.platform, env: process.env });
    args.write = role.self;
    args.check = role.peer;
    args.device = args.device || role.device;
  }

  const device = args.device || os.hostname();

  // Offline = ani zapisu, ani kontroli. To nie skąpstwo: własny znacznik pełni
  // rolę „ostatni run, w którym byłem online". Gdy pisaliśmy go też offline
  // (30.07), stemp pozostawał świeży przez całą przerwę w sieci — po powrocie
  // internetu gate „wake" nie zadziałał i kontrola odpaliła, zanim Obsidian Sync
  // zdążył ściągnąć vps.md → fałszywy alarm „121 min". Bez zapisu offline powrót
  // sieci wygląda jak pobudka: jeden run gracji, prawdziwy test w następnym.
  const online = args.check ? await checkOnline() : true;
  if (!online) {
    console.log('[heartbeat] offline — pomijam zapis i kontrolę, sync i tak nie może działać.');
    return;
  }

  // Poprzednią wersję własnego znacznika czytamy PRZED nadpisaniem: jej wiek
  // mówi, czy maszyna była na chodzie (i online) w poprzednim oknie.
  let ownVerdict = null;
  if (args.write) {
    const target = path.resolve(workspace, args.write);
    ownVerdict = evaluateHeartbeat(await readIfExists(target), Date.now());
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, renderHeartbeat({ device, now: new Date().toISOString() }), 'utf8');
    console.log(`[heartbeat] zapisano ${args.write} (device: ${device})`);
  }

  if (args.check) {
    const gate = shouldSkipCheck({ ownVerdict, online, maxAgeMin });
    if (gate.skip) {
      console.log('[heartbeat] pomijam kontrolę — maszyna dopiero wróciła (sen albo brak sieci), sync nie miał kiedy nadrobić; prawdziwy test w następnym runie.');
      return;
    }

    const target = path.resolve(workspace, args.check);
    const verdict = evaluateHeartbeat(await readIfExists(target), Date.now());

    if (!verdict.ok) {
      const why = verdict.reason === 'missing'
        ? `brak pliku ${args.check}`
        : `plik ${args.check} nie zawiera czytelnego pola "updated:"`;
      console.error(
        `[heartbeat] SYNCHRONIZACJA NIE DZIAŁA — ${why}.\n` +
        'Druga maszyna nie dostarczyła znacznika. Zrestartuj klienta sync na VPS:\n' +
        '  pkill -f "ob sync --path"\n' +
        '  setsid nohup ob sync --path /home/claude/vault --continuous < /dev/null > ~/ob-sync.log 2>&1 &'
      );
      process.exit(1);
    }

    const age = Math.round(verdict.ageMin);
    if (verdict.ageMin > maxAgeMin) {
      console.error(
        `[heartbeat] SYNCHRONIZACJA STOI — znacznik ${args.check} nie odświeżył się od ${age} min (próg: ${maxAgeMin}).\n` +
        'Uwaga: status procesu i UI Obsidiana mogą przy tym pokazywać „aktywny" — nie sugeruj się nimi.\n' +
        'Restart klienta sync na VPS:\n' +
        '  pkill -f "ob sync --path"\n' +
        '  setsid nohup ob sync --path /home/claude/vault --continuous < /dev/null > ~/ob-sync.log 2>&1 &'
      );
      process.exit(1);
    }

    console.log(`[heartbeat] OK — ${args.check} sprzed ${age} min (próg: ${maxAgeMin}).`);
  }
}

// Uruchomienie bezpośrednie vs import w teście.
if (process.argv[1] && process.argv[1].endsWith('sync-heartbeat.mjs')) {
  main().catch((e) => { console.error('[heartbeat] FATAL:', e.message); process.exit(1); });
}
