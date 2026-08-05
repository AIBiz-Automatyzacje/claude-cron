const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  PERSISTED_ENV_TTL_MS,
  clearPersistedEnvCache,
  describeEnvUsage,
  parsePersistedExport,
  readPersistedEnv,
  readPersistedEnvCached,
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

// Windows: zawieszony PowerShell nie może zamrozić jednowątkowego serwera — spawn dostaje
// twardy timeout, a ubity proces jest dla nas „nieczytelnym źródłem" (null), nie wyjątkiem.
test('readWindowsPersistedEnv: spawn dostaje timeout i killSignal', () => {
  let seenOptions = null;
  const io = {
    ...makeIo({ platform: 'win32' }),
    spawnSync: (_cmd, _args, options) => {
      seenOptions = options;
      return { status: 0, stdout: 'https://win\r\n' };
    },
  };
  assert.strictEqual(readPersistedEnv('CLAUDE_CRON_VPS_URL', io), 'https://win');
  assert.ok(seenOptions && typeof seenOptions.timeout === 'number' && seenOptions.timeout > 0,
    'spawnSync musi dostać dodatni timeout');
  assert.ok(seenOptions.killSignal, 'spawnSync musi dostać killSignal');
});

test('readPersistedEnv: Windows — proces ubity timeoutem (signal, status null) → null', () => {
  const io = makeIo({
    platform: 'win32',
    spawnResult: { status: null, signal: 'SIGKILL', stdout: 'smiec', error: undefined },
  });
  assert.strictEqual(readPersistedEnv('CLAUDE_CRON_VPS_URL', io), null);
});

test('readPersistedEnv: Windows — błąd spawnu (result.error) → null', () => {
  const io = makeIo({
    platform: 'win32',
    spawnResult: { status: null, error: new Error('ENOENT powershell'), stdout: '' },
  });
  assert.strictEqual(readPersistedEnv('CLAUDE_CRON_VPS_URL', io), null);
});

// Cache: /api/status jest odpytywane co 3 s (i przez dowolną stronę bez rate limitu), więc
// drugi odczyt w oknie TTL NIE MOŻE dotknąć I/O — na Windowsie to spawn procesu.
test('readPersistedEnvCached: drugi odczyt w oknie TTL nie robi I/O', () => {
  clearPersistedEnvCache();
  let reads = 0;
  const io = {
    ...makeIo({ files: { [ZSHRC]: 'export CACHE_TEST="https://a"\n' } }),
    readFile: (filePath) => {
      reads += 1;
      if (filePath !== ZSHRC) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return 'export CACHE_TEST="https://a"\n';
    },
  };
  const t0 = 1_000_000;
  assert.strictEqual(readPersistedEnvCached('CACHE_TEST', io, t0), 'https://a');
  const readsAfterFirst = reads;
  assert.strictEqual(readPersistedEnvCached('CACHE_TEST', io, t0 + PERSISTED_ENV_TTL_MS - 1), 'https://a');
  assert.strictEqual(reads, readsAfterFirst, 'odczyt w oknie TTL musi iść z cache');
});

test('readPersistedEnvCached: po wygaśnięciu TTL czyta źródło ponownie', () => {
  clearPersistedEnvCache();
  let value = 'https://stary';
  const io = {
    ...makeIo({}),
    readFile: (filePath) => {
      if (filePath !== ZSHRC) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return `export CACHE_TEST2=${JSON.stringify(value)}\n`;
    },
  };
  const t0 = 2_000_000;
  assert.strictEqual(readPersistedEnvCached('CACHE_TEST2', io, t0), 'https://stary');
  value = 'https://nowy';
  assert.strictEqual(readPersistedEnvCached('CACHE_TEST2', io, t0 + PERSISTED_ENV_TTL_MS), 'https://nowy');
});
