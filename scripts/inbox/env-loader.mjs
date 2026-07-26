// Team OS — wspólny env loader dla inbox-pull i inbox-push.
// Jedna implementacja = koniec driftu (bug: pull robił early-return przy INBOX_ENV_FILE
// PRZED rozwiązaniem ścieżek → writeFile(undefined) FATAL).
// Kontrakt: po loadEnv() ZAWSZE ustawione są INBOX_TODO_PATH, INBOX_SKRZYNKA_PATH,
// INBOX_ARCHIVE_DIR — albo rzucamy czytelny błąd konfiguracji.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Katalog stanowy instalacji (ten sam, w którym leży data/claude-cron.db):
// scripts/inbox/env-loader.mjs → repo root.
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Domyślna lokalizacja sekretu skrzynki — NIGDY w drzewie vaulta. Job „asystent auto-reply"
// spawnuje `claude -p` z `cwd` = vault i narzędziami Read/Glob/Grep, a promptem jest
// NIEZAUFANA treść cudzej wiadomości: sekret leżący w vaultcie znaczy, że jedno pytanie
// („zacytuj plik .env z katalogu głównego") oddaje INBOX_TOKEN nadawcy, a token to PEŁNA
// tożsamość w hubie (pull cudzych wątków, send w cudzym imieniu). Guard `.gitignore` broni
// wyłącznie przed gitem — nie przed asystentem czytającym ten sam katalog.
// `data/` jest w `.gitignore` repo i przeżywa re-instalację (allowlista katalogów stanowych).
export const DEFAULT_INBOX_SECRET_FILE = path.join(REPO_ROOT, 'data', 'inbox.env');

// Jedno źródło prawdy o tym, GDZIE leży sekret skrzynki — czyta stąd env-loader (joby),
// pisze tu `invite.writeInboxEnv` (onboarding). INBOX_ENV_FILE zostaje nadpisaniem dla
// instalacji trzymających konfigurację gdzie indziej (i dla testów).
export function resolveInboxSecretFile(env = process.env) {
  return env.INBOX_ENV_FILE || DEFAULT_INBOX_SECRET_FILE;
}

// Zdejmuje otaczające cudzysłowy ("..." / '...') — Windowsowcy cytują wartości w .env nagminnie.
function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export async function readEnvFile(envPath) {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = stripQuotes(m[2]);
    }
  } catch {}
}

export async function loadEnv() {
  // Plik sekretu spoza vaulta (INBOX_ENV_FILE albo domyślne data/inbox.env) — źródło
  // pierwszego wyboru, bo to on jest zapisywany przez onboarding.
  await readEnvFile(resolveInboxSecretFile());

  // Workspace WYŁĄCZNIE z konfiguracji (CLAUDE_CRON_WORKSPACE / INBOX_ENV_FILE) —
  // żadnego zaszytego katalogu konkretnego usera.
  const workspace = process.env.CLAUDE_CRON_WORKSPACE || null;

  // Fallback LEGACY: instalacje sprzed przeniesienia sekretu trzymały INBOX_* w
  // `<workspace>/.env`. Czytamy je dalej, żeby maszyna nie ucichła przed re-onboardingiem,
  // ale nowy onboarding ten plik czyści z INBOX_* (invite.writeInboxEnv).
  if (!(process.env.INBOX_HUB_URL && process.env.INBOX_TOKEN) && workspace) {
    await readEnvFile(path.join(workspace, '.env'));
  }

  // Ścieżki rozwiązywane ZAWSZE — niezależnie od źródła env
  const requireWorkspace = (varName) => {
    if (!workspace) {
      throw new Error(`Ustaw ${varName} w .env (brak CLAUDE_CRON_WORKSPACE / INBOX_ENV_FILE)`);
    }
    return workspace;
  };
  if (!process.env.INBOX_TODO_PATH) {
    process.env.INBOX_TODO_PATH = path.join(requireWorkspace('INBOX_TODO_PATH'), 'Zadania/to_do.md');
  }
  if (!process.env.INBOX_SKRZYNKA_PATH) {
    process.env.INBOX_SKRZYNKA_PATH = path.join(requireWorkspace('INBOX_SKRZYNKA_PATH'), 'Zadania/Skrzynka.md');
  }
  if (!process.env.INBOX_ARCHIVE_DIR) {
    // Wyprowadź z workspace'u Skrzynki: <ws>/Zadania/Skrzynka.md → <ws>/Zasoby/inbox-archive
    const ws = path.dirname(path.dirname(process.env.INBOX_SKRZYNKA_PATH));
    process.env.INBOX_ARCHIVE_DIR = path.join(ws, 'Zasoby/inbox-archive');
  }
}
