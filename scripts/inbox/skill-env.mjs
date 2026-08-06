// Loader sekretu skrzynki dla SKILLI w vaultcie (deleguj: send/reply/close).
//
// Mieszka W REPO, nie w vaultcie — dokładnie z tego powodu, z którego przeniesiono tu
// `close.mjs`: kopia w vaultcie nie jest objęta `npm test` i cicho rozjeżdża się z repo,
// a to TEN kod rozstrzyga, skąd bierze się `INBOX_TOKEN`, czyli pełna tożsamość w hubie.
// Skill w vaultcie importuje ten plik przez `$PULS_HOME` (albo wskaźnik ~/.claude-cron-home).
//
// Kolejność szukania pliku z sekretem — pierwszy ISTNIEJĄCY wygrywa:
//   1) INBOX_ENV_FILE (jawna ścieżka; też DI dla testów)
//   2) $PULS_HOME/data/inbox.env
//   3) wskaźnik ~/.claude-cron-home → <ścieżka>/data/inbox.env
//   4) walk-up po `.env` (LEGACY: instalacje sprzed przeniesienia sekretu poza vault —
//      wyłącznie do ODCZYTU, nigdy tam nie piszemy).
// Kroki 2 i 3 sprawdzają ISTNIENIE pliku, nie samą wartość zmiennej: `settings.json`
// vaulta bywa synchronizowany między maszynami z obcą ścieżką instalacji, a milczące
// przyjęcie jej dałoby błąd „brak konfiguracji" zamiast przejścia do wskaźnika.
// Krok 3 istnieje, bo PULS_HOME z settings.json działa wyłącznie w sesjach Claude Code
// odpalonych w TYM workspace; wskaźnik o stałej nazwie działa dla każdego procesu.
//
// Tożsamości NIE czytamy z niczego — hub wyprowadza ją z tokenu (`from_user` ustawiany
// po stronie serwera). To zamyka stary problem podszywania się: `INBOX_USER` z .env dało
// się podmienić, tokenu nie.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEnvFile } from './env-loader.mjs';

export const PULS_HOME_POINTER = '.claude-cron-home';

// Wskaźnik to JEDNA linia ze ścieżką instalacji (pisze go setup.mjs i install-vps.sh).
// `trim()` zdejmuje końcowy `\n`; pusta zawartość = brak wskaźnika, nie katalog "".
async function readPointerDir(homeDir) {
  try {
    const raw = await fs.readFile(path.join(homeDir, PULS_HOME_POINTER), 'utf8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}

// env/homeDir wstrzykiwane, żeby kolejność dało się przetestować bez mutowania procesu.
export async function findEnvFile(env = process.env, homeDir = os.homedir()) {
  if (env.INBOX_ENV_FILE) return env.INBOX_ENV_FILE;

  const installDirs = [env.PULS_HOME, await readPointerDir(homeDir)].filter(Boolean);
  for (const dir of installDirs) {
    const candidate = path.join(dir, 'data', 'inbox.env');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // ta instalacja nie ma sekretu — próbujemy kolejnego źródła
    }
  }

  const starts = [
    env.CLAUDE_PROJECT_DIR,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter(Boolean);

  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, '.env');
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // brak .env na tym poziomie — idziemy wyżej
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// Komunikat ŚWIADOMIE nie proponuje wpisania sekretu do pliku w vaultcie: agent
// auto-reply czyta ten katalog z niezaufanym promptem, więc token tutaj = eksfiltracja
// jednym zdaniem atakującego. Jedyna droga naprawy to instalator Pulsa.
export const MISSING_CONFIG_MESSAGE =
  'Brak konfiguracji skrzynki Team OS (INBOX_HUB_URL / INBOX_TOKEN). '
  + 'Uruchom ponownie instalator Pulsa i wklej kod zaproszenia — zapisze sekret w '
  + 'data/inbox.env instalacji (poza vaultem) i ustawi wskaźnik ~/.claude-cron-home. '
  + 'Potem otwórz NOWĄ sesję: zmienne nie propagują się do już działających procesów.';

export async function loadEnv() {
  const envPath = await findEnvFile();
  // readEnvFile z env-loader.mjs: jedna implementacja parsera .env dla całego inboxa
  // (nie nadpisuje zmiennych już obecnych w process.env, zdejmuje cudzysłowy).
  if (envPath) await readEnvFile(envPath);

  if (!process.env.INBOX_HUB_URL || !process.env.INBOX_TOKEN) {
    throw new Error(MISSING_CONFIG_MESSAGE);
  }
}
