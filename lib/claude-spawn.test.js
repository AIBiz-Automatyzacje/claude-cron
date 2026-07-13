const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WORKSPACE_DIR } = require('./config');
const { spawnClaude, buildCleanEnv, setClaudeBin } = require('./claude-spawn');

// === buildCleanEnv — czysty env dla spawnowanego CLI (strip → inject OAuth) ===

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('buildCleanEnv: strip CLAUDE_CODE*/CLAUDECODE, token wstrzyknięty PO stripie', (t) => {
  // Arrange — baseEnv zawiera też CLAUDE_CODE_OAUTH_TOKEN ze "starą" wartością:
  // jeśli inject byłby PRZED stripem, token z pliku zostałby usunięty razem z resztą.
  const dir = tmpDir(t, 'claude-spawn-env-');
  const tokenFile = path.join(dir, '.claude-cron-oauth-token');
  fs.writeFileSync(tokenFile, 'sk-ant-oat01-z-pliku\n');
  const baseEnv = {
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '12345',
    CLAUDE_CODE_OAUTH_TOKEN: 'stary-token-z-sesji',
  };

  // Act
  const env = buildCleanEnv(baseEnv, tokenFile);

  // Assert — żadnego klucza CLAUDE_CODE*/CLAUDECODE poza wstrzykniętym tokenem
  const leftover = Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE');
  assert.deepEqual(leftover, ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-z-pliku');
  assert.equal(env.PATH, '/usr/bin', 'pozostałe zmienne przechodzą nietknięte');
  assert.equal(baseEnv.CLAUDECODE, '1', 'baseEnv nie jest mutowany (kopia, nie in-place)');
});

test('buildCleanEnv: brak pliku OAuth (ENOENT) → env bez tokenu, bez wyjątku', () => {
  // Act — nieistniejąca ścieżka nie może rzucić (normalny przypadek instalacji z loginem)
  const env = buildCleanEnv(
    { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', FOO: 'bar' },
    '/nieistniejacy/katalog/.claude-cron-oauth-token'
  );

  // Assert
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false);
  assert.equal('CLAUDECODE' in env, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in env, false);
  assert.equal(env.FOO, 'bar');
});

// === spawnClaude — realny spawn przez override binarki (wzorzec db.setDbPath) ===

function collectProc(proc) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('spawnClaude: override binarki node + skrypt tmp → stdout, kod wyjścia i cwd=WORKSPACE_DIR', async (t) => {
  // Arrange — atrapa wypisuje swój cwd i kończy się kodem 3
  const dir = tmpDir(t, 'claude-spawn-bin-');
  const scriptPath = path.join(dir, 'atrapa.js');
  fs.writeFileSync(scriptPath, 'process.stdout.write(process.cwd()); process.exit(3);');
  setClaudeBin(process.execPath);
  t.after(() => setClaudeBin(null));

  // Act
  const { code, stdout } = await collectProc(spawnClaude([scriptPath]));

  // Assert — realpathSync po OBU stronach: macOS symlinkuje /var,/tmp do /private/*
  assert.equal(code, 3);
  assert.equal(fs.realpathSync(stdout), fs.realpathSync(WORKSPACE_DIR));
});

test('spawnClaude: argumenty CLI przechodzą do procesu bez modyfikacji', async (t) => {
  // Arrange — echo argv; wielowyrazowy prompt z cudzysłowami i $HOME łapie
  // regresję do shell:true (shell rozbiłby słowa i rozwinął zmienną)
  const dir = tmpDir(t, 'claude-spawn-argv-');
  const scriptPath = path.join(dir, 'echo-argv.js');
  fs.writeFileSync(scriptPath, 'console.log(JSON.stringify(process.argv.slice(2)));');
  setClaudeBin(process.execPath);
  t.after(() => setClaudeBin(null));
  const cliArgs = ['--output-format', 'text', '--model', 'sonnet', '-p', 'wielo wyrazowy prompt "w cudzysłowie" i $HOME'];

  // Act
  const { code, stdout } = await collectProc(spawnClaude([scriptPath, ...cliArgs]));

  // Assert
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), cliArgs);
});

test('spawnClaude: proces dziecka nie widzi CLAUDE_CODE*/CLAUDECODE rodzica', async (t) => {
  // Arrange — snapshot nadpisywanych wartości env PRZED statefulnym testem
  const snapshot = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_TEST_MARKER: process.env.CLAUDE_CODE_TEST_MARKER };
  t.after(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_TEST_MARKER = 'x';

  const dir = tmpDir(t, 'claude-spawn-strip-');
  const scriptPath = path.join(dir, 'echo-env.js');
  fs.writeFileSync(
    scriptPath,
    "console.log(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE')));"
  );
  setClaudeBin(process.execPath);
  t.after(() => setClaudeBin(null));

  // Act
  const { code, stdout } = await collectProc(spawnClaude([scriptPath]));

  // Assert — jedyny dopuszczalny klucz to token OAuth (gdy maszyna ma realny
  // ~/.claude-cron-oauth-token); markery rodzica NIE mogą przeciec
  assert.equal(code, 0);
  const keys = JSON.parse(stdout);
  assert.equal(keys.includes('CLAUDECODE'), false);
  assert.equal(keys.includes('CLAUDE_CODE_TEST_MARKER'), false);
  assert.deepEqual(keys.filter((k) => k !== 'CLAUDE_CODE_OAUTH_TOKEN'), []);
});
