// Testy env-loader.mjs — scenariusze z sesji diagnostycznej 13.07:
// (1) INBOX_ENV_FILE ustawia ścieżki ZAWSZE (bug: pull robił early-return bez ścieżek),
// (2) cudzysłowy w .env są zdejmowane (Windows onboarding),
// (3) brak workspace'u = czytelny błąd, nie writeFile(undefined).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, readEnvFile } from './env-loader.mjs';

const INBOX_VARS = [
  'INBOX_ENV_FILE', 'INBOX_DB_URL', 'INBOX_USER',
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

test('INBOX_ENV_FILE: ścieżki rozwiązane ZAWSZE, także przy komplecie DB_URL+USER', async () => {
  await withTmpEnvFile(
    'INBOX_DB_URL=postgres://x\nINBOX_USER=tester\nCLAUDE_CRON_WORKSPACE=/tmp/ws\n',
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
    `INBOX_DB_URL="postgres://user:pass@host/db"\nINBOX_USER='marcin'\n`,
    async (envPath) => {
      await readEnvFile(envPath);
      assert.equal(process.env.INBOX_DB_URL, 'postgres://user:pass@host/db');
      assert.equal(process.env.INBOX_USER, 'marcin');
    }
  );
});

test('readEnvFile: nie nadpisuje już ustawionych zmiennych', async () => {
  process.env.INBOX_USER = 'kacper';
  await withTmpEnvFile('INBOX_USER=intruz\n', async (envPath) => {
    await readEnvFile(envPath);
    assert.equal(process.env.INBOX_USER, 'kacper');
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

test('loadEnv: jawne INBOX_*_PATH wygrywają nad workspace', async () => {
  process.env.CLAUDE_CRON_WORKSPACE = '/tmp/ws';
  process.env.INBOX_SKRZYNKA_PATH = '/custom/vault/Zadania/Skrzynka.md';
  await loadEnv();
  assert.equal(process.env.INBOX_SKRZYNKA_PATH, '/custom/vault/Zadania/Skrzynka.md');
  assert.equal(process.env.INBOX_TODO_PATH, path.join('/tmp/ws', 'Zadania/to_do.md'));
  assert.equal(process.env.INBOX_ARCHIVE_DIR, path.join('/custom/vault', 'Zasoby/inbox-archive'));
});
