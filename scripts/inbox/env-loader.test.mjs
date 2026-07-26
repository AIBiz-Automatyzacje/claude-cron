// Testy env-loader.mjs — scenariusze z sesji diagnostycznej 13.07:
// (1) INBOX_ENV_FILE ustawia ścieżki ZAWSZE (bug: pull robił early-return bez ścieżek),
// (2) cudzysłowy w .env są zdejmowane (Windows onboarding),
// (3) brak workspace'u = czytelny błąd, nie writeFile(undefined).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_INBOX_SECRET_FILE, loadEnv, readEnvFile, resolveInboxSecretFile } from './env-loader.mjs';

const INBOX_VARS = [
  'INBOX_ENV_FILE', 'INBOX_HUB_URL', 'INBOX_TOKEN',
  'INBOX_TODO_PATH', 'INBOX_SKRZYNKA_PATH', 'INBOX_ARCHIVE_DIR',
  'CLAUDE_CRON_WORKSPACE',
];

beforeEach(() => {
  for (const v of INBOX_VARS) delete process.env[v];
});

async function withTmpEnvFile(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-loader-test-'));
  const envPath = path.join(dir, '.env');
  await fs.writeFile(envPath, content, 'utf8');
  try {
    await fn(envPath, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('INBOX_ENV_FILE: ścieżki rozwiązane ZAWSZE, także przy komplecie HUB_URL+TOKEN', async () => {
  await withTmpEnvFile(
    'INBOX_HUB_URL=https://hub.example\nINBOX_TOKEN=tok123\nCLAUDE_CRON_WORKSPACE=/tmp/ws\n',
    async (envPath) => {
      process.env.INBOX_ENV_FILE = envPath;
      await loadEnv();
      assert.equal(process.env.INBOX_TODO_PATH, path.join('/tmp/ws', 'Zadania/to_do.md'));
      assert.equal(process.env.INBOX_SKRZYNKA_PATH, path.join('/tmp/ws', 'Zadania/Skrzynka.md'));
      assert.equal(process.env.INBOX_ARCHIVE_DIR, path.join('/tmp/ws', 'Zasoby/inbox-archive'));
    }
  );
});

test('readEnvFile: zdejmuje cudzysłowy podwójne i pojedyncze', async () => {
  await withTmpEnvFile(
    `INBOX_HUB_URL="https://hub.example/api"\nINBOX_TOKEN='tok-marcin'\n`,
    async (envPath) => {
      await readEnvFile(envPath);
      assert.equal(process.env.INBOX_HUB_URL, 'https://hub.example/api');
      assert.equal(process.env.INBOX_TOKEN, 'tok-marcin');
    }
  );
});

test('readEnvFile: nie nadpisuje już ustawionych zmiennych', async () => {
  process.env.INBOX_TOKEN = 'tok-kacper';
  await withTmpEnvFile('INBOX_TOKEN=intruz\n', async (envPath) => {
    await readEnvFile(envPath);
    assert.equal(process.env.INBOX_TOKEN, 'tok-kacper');
  });
});

test('loadEnv: brak workspace = czytelny błąd konfiguracji', async (t) => {
  const home = process.env.HOME;
  const userprofile = process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  t.after(() => {
    if (home !== undefined) process.env.HOME = home;
    if (userprofile !== undefined) process.env.USERPROFILE = userprofile;
  });
  await assert.rejects(loadEnv(), /Ustaw INBOX_TODO_PATH/);
});

// === lokalizacja sekretu — POZA vaultem (review fazy 3, P1) ===
// Job auto-reply spawnuje `claude -p` z cwd = vault i Read/Glob/Grep, a promptem jest
// niezaufana treść cudzej wiadomości. Sekret w drzewie vaulta = oddanie INBOX_TOKENA
// (pełnej tożsamości w hubie) każdemu, kto przyśle odpowiednio sformułowane query.

test('resolveInboxSecretFile: domyślnie katalog stanowy instalacji (data/), nie workspace', () => {
  process.env.CLAUDE_CRON_WORKSPACE = '/vault';

  const resolved = resolveInboxSecretFile({ CLAUDE_CRON_WORKSPACE: '/vault' });

  assert.equal(resolved, DEFAULT_INBOX_SECRET_FILE);
  assert.equal(path.basename(path.dirname(resolved)), 'data', 'sekret obok bazy schedulera');
  assert.equal(resolved.startsWith(`${path.sep}vault${path.sep}`), false, 'nigdy w drzewie vaulta');
});

test('resolveInboxSecretFile: INBOX_ENV_FILE nadpisuje domyślną lokalizację', () => {
  assert.equal(resolveInboxSecretFile({ INBOX_ENV_FILE: '/etc/puls/inbox.env' }), '/etc/puls/inbox.env');
});

test('loadEnv: sekret spoza vaulta wygrywa nad LEGACY .env workspace’u', async () => {
  await withTmpEnvFile('INBOX_HUB_URL=https://hub.nowy\nINBOX_TOKEN=tok-nowy\n', async (secretPath, secretDir) => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'env-loader-ws-'));
    await fs.writeFile(path.join(ws, '.env'), 'INBOX_HUB_URL=https://hub.stary\nINBOX_TOKEN=tok-stary\n', 'utf8');
    process.env.INBOX_ENV_FILE = secretPath;
    process.env.CLAUDE_CRON_WORKSPACE = ws;
    try {
      await loadEnv();
      assert.equal(process.env.INBOX_TOKEN, 'tok-nowy', 'plik sekretu ma pierwszeństwo');
      assert.equal(process.env.INBOX_HUB_URL, 'https://hub.nowy');
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
      assert.ok(secretDir, 'katalog sekretu sprzątany przez withTmpEnvFile');
    }
  });
});

test('loadEnv: bez pliku sekretu wchodzi LEGACY .env workspace’u (maszyna przed re-onboardingiem)', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'env-loader-ws-'));
  await fs.writeFile(path.join(ws, '.env'), 'INBOX_HUB_URL=https://hub.stary\nINBOX_TOKEN=tok-stary\n', 'utf8');
  process.env.INBOX_ENV_FILE = path.join(ws, 'nie-ma-takiego-pliku.env');
  process.env.CLAUDE_CRON_WORKSPACE = ws;
  try {
    await loadEnv();
    assert.equal(process.env.INBOX_TOKEN, 'tok-stary', 'stara instalacja nie ucicha przed re-onboardingiem');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('loadEnv: jawne INBOX_*_PATH wygrywają nad workspace', async () => {
  process.env.CLAUDE_CRON_WORKSPACE = '/tmp/ws';
  process.env.INBOX_SKRZYNKA_PATH = '/custom/vault/Zadania/Skrzynka.md';
  await loadEnv();
  assert.equal(process.env.INBOX_SKRZYNKA_PATH, '/custom/vault/Zadania/Skrzynka.md');
  assert.equal(process.env.INBOX_TODO_PATH, path.join('/tmp/ws', 'Zadania/to_do.md'));
  assert.equal(process.env.INBOX_ARCHIVE_DIR, path.join('/custom/vault', 'Zasoby/inbox-archive'));
});
