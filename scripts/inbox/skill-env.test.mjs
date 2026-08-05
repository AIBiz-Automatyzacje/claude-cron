// Testy loadera sekretu skilli w vaultcie (deleguj). Kod przyjechał tu z vaulta —
// tam żył poza `npm test`, więc kolejność szukania INBOX_TOKEN nie była niczym przybita.
// To ten plik rozstrzyga, skąd bierze się PEŁNA tożsamość w hubie, więc test jest
// granicą bezpieczeństwa, nie formalnością.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { findEnvFile, loadEnv, MISSING_CONFIG_MESSAGE } from './skill-env.mjs';

function makeInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-install-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const secret = path.join(dir, 'data', 'inbox.env');
  fs.writeFileSync(secret, 'INBOX_HUB_URL=https://hub.example\nINBOX_TOKEN=t\n');
  return { dir, secret };
}

function makeHome(installDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-home-'));
  if (installDir) fs.writeFileSync(path.join(home, '.claude-cron-home'), `${installDir}\n`);
  return home;
}

test('findEnvFile: brak PULS_HOME, obecny wskaźnik ~/.claude-cron-home → sekret znaleziony', async () => {
  const { dir, secret } = makeInstall();
  const home = makeHome(dir);

  assert.equal(await findEnvFile({}, home), secret);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('findEnvFile: PULS_HOME z istniejącym sekretem wygrywa ze wskaźnikiem', async () => {
  const preferred = makeInstall();
  const other = makeInstall();
  const home = makeHome(other.dir);

  assert.equal(await findEnvFile({ PULS_HOME: preferred.dir }, home), preferred.secret);

  fs.rmSync(preferred.dir, { recursive: true, force: true });
  fs.rmSync(other.dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('findEnvFile: INBOX_ENV_FILE ma pierwszeństwo przed wskaźnikiem', async () => {
  const { dir } = makeInstall();
  const home = makeHome(dir);

  assert.equal(await findEnvFile({ INBOX_ENV_FILE: '/jawna/sciezka.env' }, home), '/jawna/sciezka.env');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// Sedno kroku 2: liczy się ISTNIENIE pliku, nie sama wartość zmiennej — settings.json
// vaulta bywa synchronizowany z maszyny o innej ścieżce instalacji.
test('findEnvFile: PULS_HOME wskazujący nieistniejący sekret spada na wskaźnik', async () => {
  const { dir, secret } = makeInstall();
  const home = makeHome(dir);

  assert.equal(await findEnvFile({ PULS_HOME: '/nieistniejaca/instalacja' }, home), secret);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('loadEnv: sekret z INBOX_ENV_FILE ląduje w process.env (happy path)', async () => {
  const { dir, secret } = makeInstall();
  const snapshot = {
    INBOX_ENV_FILE: process.env.INBOX_ENV_FILE,
    INBOX_HUB_URL: process.env.INBOX_HUB_URL,
    INBOX_TOKEN: process.env.INBOX_TOKEN,
  };
  delete process.env.INBOX_HUB_URL;
  delete process.env.INBOX_TOKEN;
  process.env.INBOX_ENV_FILE = secret;

  await loadEnv();

  assert.equal(process.env.INBOX_HUB_URL, 'https://hub.example');
  assert.equal(process.env.INBOX_TOKEN, 't');

  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnv: brak sekretu → błąd kierujący do instalatora, nie ciche powodzenie (error case)', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-brak-'));
  const snapshot = {
    INBOX_ENV_FILE: process.env.INBOX_ENV_FILE,
    INBOX_HUB_URL: process.env.INBOX_HUB_URL,
    INBOX_TOKEN: process.env.INBOX_TOKEN,
  };
  delete process.env.INBOX_HUB_URL;
  delete process.env.INBOX_TOKEN;
  process.env.INBOX_ENV_FILE = path.join(empty, 'nie-ma.env');

  await assert.rejects(() => loadEnv(), /instalator Pulsa/);

  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(empty, { recursive: true, force: true });
});

test('komunikat błędu NIE namawia do zapisu sekretu w vaulcie — wskazuje instalator', () => {
  assert.match(MISSING_CONFIG_MESSAGE, /instalator Pulsa/);
  assert.match(MISSING_CONFIG_MESSAGE, /\.claude-cron-home/);
  // Jedyny wymieniony plik sekretu leży POZA vaultem; żadnej zachęty do wskazania
  // własnej ścieżki (INBOX_ENV_FILE) ani do utworzenia .env w workspace.
  assert.match(MISSING_CONFIG_MESSAGE, /poza vaultem/);
  assert.doesNotMatch(MISSING_CONFIG_MESSAGE, /INBOX_ENV_FILE/);
  assert.doesNotMatch(MISSING_CONFIG_MESSAGE, /workspace|vaulcie/);
});
