// Team OS — wspólny env loader dla inbox-pull i inbox-push.
// Jedna implementacja = koniec driftu (bug: pull robił early-return przy INBOX_ENV_FILE
// PRZED rozwiązaniem ścieżek → writeFile(undefined) FATAL).
// Kontrakt: po loadEnv() ZAWSZE ustawione są INBOX_TODO_PATH, INBOX_SKRZYNKA_PATH,
// INBOX_ARCHIVE_DIR — albo rzucamy czytelny błąd konfiguracji.

import fs from 'node:fs/promises';
import path from 'node:path';

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
  // INBOX_ENV_FILE → rekomendowana ścieżka konfiguracji (Windows onboarding)
  if (process.env.INBOX_ENV_FILE) {
    await readEnvFile(process.env.INBOX_ENV_FILE);
  }

  const home = process.env.HOME || process.env.USERPROFILE;
  const workspace = process.env.CLAUDE_CRON_WORKSPACE
    || (home ? path.resolve(home, 'Documents/kacper_trzepiecinski_workspace') : null);

  // Fallback na .env workspace'u tylko gdy INBOX_ENV_FILE nie dał kompletu
  if (!(process.env.INBOX_DB_URL && process.env.INBOX_USER) && workspace) {
    await readEnvFile(path.join(workspace, '.env'));
  }

  // Ścieżki rozwiązywane ZAWSZE — niezależnie od źródła env
  const requireWorkspace = (varName) => {
    if (!workspace) {
      throw new Error(`Ustaw ${varName} w .env (brak HOME/USERPROFILE/CLAUDE_CRON_WORKSPACE)`);
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
