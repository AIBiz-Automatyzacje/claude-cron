const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  describeEnvUsage,
  parsePersistedExport,
  readPersistedEnv,
} = require('./persisted-env');

// Fabryka wstrzykiwanego I/O — testy nigdy nie dotykają prawdziwego ~/.zshrc ani rejestru.
function makeIo({ files = {}, platform = 'darwin', shell = '/bin/zsh', spawnResult = null } = {}) {
  return {
    readFile: (filePath) => {
      if (!(filePath in files)) {
        const err = new Error(`ENOENT: ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[filePath];
    },
    spawnSync: () => spawnResult,
    homedir: () => '/home/tester',
    platform: () => platform,
    shell: () => shell,
  };
}

const ZSHRC = path.join('/home/tester', '.zshrc');
const BASHRC = path.join('/home/tester', '.bashrc');

test('parsePersistedExport: czyta wartość z linii export', () => {
  const rc = 'export CLAUDE_CRON_VPS_URL="https://x"\n';
  assert.strictEqual(parsePersistedExport(rc, 'CLAUDE_CRON_VPS_URL'), 'https://x');
});

test('parsePersistedExport: zakomentowana linia → null', () => {
  const rc = '# export CLAUDE_CRON_VPS_URL="https://x"\n';
  assert.strictEqual(parsePersistedExport(rc, 'CLAUDE_CRON_VPS_URL'), null);
});

test('parsePersistedExport: uszkodzony literał → null, bez rzucania', () => {
  const rc = 'export CLAUDE_CRON_VPS_URL="https://x\n';
  assert.strictEqual(parsePersistedExport(rc, 'CLAUDE_CRON_VPS_URL'), null);
});

test('parsePersistedExport: brak linii → null', () => {
  assert.strictEqual(parsePersistedExport('export INNE="1"\n', 'CLAUDE_CRON_VPS_URL'), null);
});

test('parsePersistedExport: wartość ze spacjami i cudzysłowami (format JSON.stringify)', () => {
  // Dokładnie to, co zapisuje upsertEnvLine dla wartości: C:\Moje "Repo"\puls
  const value = 'C:\\Moje "Repo"\\puls';
  const rc = `export CLAUDE_CRON_WORKSPACE=${JSON.stringify(value)}\n`;
  assert.strictEqual(parsePersistedExport(rc, 'CLAUDE_CRON_WORKSPACE'), value);
});

test('parsePersistedExport: ostatni export wygrywa (tak jak w shellu)', () => {
  const rc = 'export A="stary"\nexport A="nowy"\n';
  assert.strictEqual(parsePersistedExport(rc, 'A'), 'nowy');
});

test('readPersistedEnv: brak pliku RC → null, bez rzucania', () => {
  const io = makeIo({ files: {} });
  assert.strictEqual(readPersistedEnv('CLAUDE_CRON_VPS_URL', io), null);
});

test('readPersistedEnv: fallback na drugi plik RC gdy w preferowanym nie ma linii', () => {
  const io = makeIo({
    files: { [ZSHRC]: '# nic tu nie ma\n', [BASHRC]: 'export CLAUDE_CRON_VPS_URL="https://z-bashrc"\n' },
  });
  assert.strictEqual(readPersistedEnv('CLAUDE_CRON_VPS_URL', io), 'https://z-bashrc');
});

test('readPersistedEnv: Windows czyta User Environment przez PowerShell', () => {
  const io = makeIo({ platform: 'win32', spawnResult: { status: 0, stdout: 'https://win\r\n' } });
  assert.strictEqual(readPersistedEnv('CLAUDE_CRON_VPS_URL', io), 'https://win');
});

test('readPersistedEnv: Windows — pad PowerShella → null', () => {
  const io = makeIo({ platform: 'win32', spawnResult: { status: 1, stdout: '', stderr: 'boom' } });
  assert.strictEqual(readPersistedEnv('CLAUDE_CRON_VPS_URL', io), null);
});

test('describeEnvUsage: wartość z pamięci różna od zapisanej → mismatch', () => {
  const out = describeEnvUsage({ inUse: 'https://stary', persisted: 'https://nowy' });
  assert.deepStrictEqual(out, { in_use: 'https://stary', persisted: 'https://nowy', mismatch: true });
});

test('describeEnvUsage: wartości równe → brak mismatchu', () => {
  const out = describeEnvUsage({ inUse: 'https://ten-sam', persisted: 'https://ten-sam' });
  assert.strictEqual(out.mismatch, false);
});

test('describeEnvUsage: nieznana wartość zapisana → mismatch false („nie wiem")', () => {
  const out = describeEnvUsage({ inUse: 'https://cos', persisted: null });
  assert.deepStrictEqual(out, { in_use: 'https://cos', persisted: null, mismatch: false });
});
