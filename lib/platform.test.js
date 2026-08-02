const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platform = require('./platform');
const { HOME, PROJECT_ROOT } = require('./config');

// === generatePlist() — kontrakt po zmianie (Unit 8) ===
// Wywodzi się z characterization testu stanu sprzed zmiany: niezmienniki (kształt XML,
// RunAtLoad/KeepAlive, etykieta) zostają, a wady zamienione w asercje odwrotne —
// logi wyprowadzone z <repo>/data/, `which node` zastąpiony portable Node z .node/.
test('generatePlist: kontrakt plista instalowanego na tej maszynie', async (t) => {
  const xml = platform.generatePlist();

  await t.test('nagłówek XML + DOCTYPE plist (niezmiennik)', () => {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.match(xml, /<!DOCTYPE plist PUBLIC/);
    assert.match(xml, /<plist version="1\.0">/);
  });

  await t.test('etykieta = ta sama stała, którą instaluje installMac()', () => {
    assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${platform.PLIST_LABEL}</string>`));
  });

  await t.test('wrapper /bin/sh -c zamiast gołego [node, server.js]', () => {
    assert.match(xml, /<string>\/bin\/sh<\/string>\s*<string>-c<\/string>/);
    assert.ok(xml.includes('exec '));
  });

  await t.test('logi POZA drzewem repo (koniec z <repo>/data/*.log)', () => {
    assert.ok(!xml.includes(path.join(PROJECT_ROOT, 'data', 'stdout.log')));
    assert.ok(!xml.includes(path.join(PROJECT_ROOT, 'data', 'stderr.log')));
    assert.ok(xml.includes(path.join('Library', 'Logs', 'claude-cron', 'daemon.log')));
  });

  await t.test('Node z .node/, nie z systemowego PATH', () => {
    assert.match(xml, /[/\\]\.node[/\\]node-v[\d.]+-\w+-\w+[/\\]bin[/\\]node/);
  });

  await t.test('RunAtLoad i KeepAlive włączone (niezmiennik)', () => {
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  });
});

// === NOWY KONTRAKT: buildPlist() ===

const FIXTURE = {
  label: 'com.claude-cron.scheduler',
  repoDir: '/Users/tester/claude-cron',
  nodeBin: '/Users/tester/claude-cron/.node/node-v22.17.0-darwin-arm64/bin/node',
  logFile: '/Users/tester/Library/Logs/claude-cron/daemon.log',
  env: { PATH: '/usr/bin:/bin', HOME: '/Users/tester' },
};

test('buildPlist: wrapper /bin/sh -c z cd + exec portable Node', () => {
  const xml = platform.buildPlist(FIXTURE);

  assert.match(xml, /<string>\/bin\/sh<\/string>\s*<string>-c<\/string>/);
  // `&&` w komendzie musi być zescapowane jako encja — inaczej plist jest niepoprawnym XML-em.
  assert.ok(xml.includes("cd '/Users/tester/claude-cron' &amp;&amp; exec "));
  assert.ok(xml.includes("'/Users/tester/claude-cron/.node/node-v22.17.0-darwin-arm64/bin/node'"));
  // Ta sama flaga co `npm start` — bez niej daemon spamuje ostrzeżeniem node:sqlite.
  assert.ok(xml.includes('--disable-warning=ExperimentalWarning server.js'));
  assert.ok(!xml.includes('&& exec')); // surowy `&&` = błąd parsera plist
});

test('buildPlist: logi POZA drzewem repo (TCC w ~/Documents)', () => {
  const xml = platform.buildPlist(FIXTURE);

  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/tester\/Library\/Logs\/claude-cron\/daemon\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/tester\/Library\/Logs\/claude-cron\/daemon\.log<\/string>/);
  assert.ok(!xml.includes(`${FIXTURE.repoDir}/data/`));
});

test('buildPlist: EnvironmentVariables z CLAUDE_CRON_WORKSPACE i CLAUDE_CRON_VPS_URL, gdy ustawione', () => {
  const xml = platform.buildPlist({
    ...FIXTURE,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/tester',
      CLAUDE_CRON_WORKSPACE: '/Users/tester/Vault',
      CLAUDE_CRON_VPS_URL: 'http://100.122.215.61:7777',
    },
  });

  assert.match(xml, /<key>CLAUDE_CRON_WORKSPACE<\/key>\s*<string>\/Users\/tester\/Vault<\/string>/);
  assert.match(xml, /<key>CLAUDE_CRON_VPS_URL<\/key>\s*<string>http:\/\/100\.122\.215\.61:7777<\/string>/);
});

test('buildPlist: escapuje znaki XML w wartościach env', () => {
  const xml = platform.buildPlist({
    ...FIXTURE,
    env: { PATH: '/usr/bin', HOME: '/Users/tester', CLAUDE_CRON_WORKSPACE: '/Users/tester/A & B' },
  });

  assert.ok(xml.includes('<string>/Users/tester/A &amp; B</string>'));
});

// === resolvePortableNodeBin() ===

test('resolvePortableNodeBin: preferuje process.execPath, gdy biegnie z .node/', () => {
  const execPath = '/Users/tester/claude-cron/.node/node-v22.17.0-darwin-arm64/bin/node';
  assert.strictEqual(
    platform.resolvePortableNodeBin(execPath, '/Users/tester/claude-cron'),
    execPath,
  );
});

test('resolvePortableNodeBin: execPath z CUDZEJ instalacji nie jest brany za własny', () => {
  // Z review CodeRabbita (PR #2): warunek szukał segmentu `.node` w dowolnym miejscu
  // ścieżki, więc setup instancji B odpalony portable Nodem instancji A wypalał w pliście
  // B binarkę z A. Katalog instalacji jest wolnym wyborem usera (INSTALL_DIR), więc dwie
  // instancje obok siebie to wspierany scenariusz, nie egzotyka.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-own-'));
  const distDir = path.join(repoDir, '.node', `node-v22.17.0-${process.platform}-${process.arch}`, 'bin');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'node'), '#!/bin/sh\n', { mode: 0o755 });

  const obcyExecPath = '/Users/tester/INNA-instalacja/.node/node-v22.17.0-darwin-arm64/bin/node';
  const resolved = platform.resolvePortableNodeBin(obcyExecPath, repoDir);

  assert.notStrictEqual(resolved, obcyExecPath, 'binarka z cudzego katalogu nie może trafić do plista');
  assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(path.join(distDir, 'node')));

  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('resolvePortableNodeBin: czyta faktycznie istniejący katalog w <repo>/.node', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-node-'));
  const distDir = path.join(repoDir, '.node', 'node-v22.99.0-darwin-arm64', 'bin');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'node'), '#!/bin/sh\n', { mode: 0o755 });

  // macOS symlinkuje /tmp -> /private/tmp, więc porównanie po realpath obu stron.
  const resolved = platform.resolvePortableNodeBin('/usr/local/bin/node', repoDir);
  assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(path.join(distDir, 'node')));

  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('resolvePortableNodeBin: przy dwóch dystach wybiera pinowany, nie pierwszy alfabetycznie', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-node-'));
  const pinnedDist = `node-v22.17.0-${process.platform}-${process.arch}`;
  for (const dist of [`node-v20.11.0-${process.platform}-${process.arch}`, pinnedDist]) {
    const binDir = path.join(repoDir, '.node', dist, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  }

  const resolved = platform.resolvePortableNodeBin('/usr/local/bin/node', repoDir);
  assert.strictEqual(path.basename(path.dirname(path.dirname(resolved))), pinnedDist);

  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('resolvePortableNodeBin: fallback na pinowaną wersję, gdy .node/ nie istnieje', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-node-'));
  const resolved = platform.resolvePortableNodeBin('/usr/local/bin/node', repoDir);

  assert.ok(resolved.includes(path.join(repoDir, '.node')));
  assert.match(resolved, /node-v\d+\.\d+\.\d+-\w+-\w+[/\\]bin[/\\]node$/);

  fs.rmSync(repoDir, { recursive: true, force: true });
});

// === parseLaunchctlList() — kolumny PID/Status/Label, nie substring ===

const LAUNCHCTL_OUTPUT = [
  'PID\tStatus\tLabel',
  '1234\t0\tcom.claude-cron.scheduler',
  '-\t0\tcom.claude-cron.daemon',
  '-\t0\tcom.apple.SafariHistoryServiceAgent',
].join('\n');

test('parseLaunchctlList: agent z numerycznym PID = running', () => {
  assert.deepStrictEqual(
    platform.parseLaunchctlList(LAUNCHCTL_OUTPUT, 'com.claude-cron.scheduler'),
    { found: true, running: true, pid: 1234 },
  );
});

test('parseLaunchctlList: PID "-" = wczytany, ale nie biegnie', () => {
  assert.deepStrictEqual(
    platform.parseLaunchctlList(LAUNCHCTL_OUTPUT, 'com.claude-cron.daemon'),
    { found: true, running: false, pid: null },
  );
});

test('parseLaunchctlList: dopasowanie po CAŁEJ etykiecie, nie po podciągu', () => {
  const out = 'PID\tStatus\tLabel\n999\t0\tcom.claude-cron.scheduler.backup';
  assert.deepStrictEqual(
    platform.parseLaunchctlList(out, 'com.claude-cron.scheduler'),
    { found: false, running: false, pid: null },
  );
});

test('parseLaunchctlList: myślnik w etykiecie nie robi z running=false (stary bug includes("-"))', () => {
  // Cała linia zawiera myślniki w nazwie `claude-cron` — decyduje WYŁĄCZNIE kolumna PID.
  const out = 'PID\tStatus\tLabel\n4321\t0\tcom.claude-cron.scheduler';
  assert.strictEqual(platform.parseLaunchctlList(out, 'com.claude-cron.scheduler').running, true);
});

test('parseLaunchctlList: pusty output = nic nie znaleziono', () => {
  assert.deepStrictEqual(
    platform.parseLaunchctlList('', 'com.claude-cron.scheduler'),
    { found: false, running: false, pid: null },
  );
});

// === buildMacStatus() — ta sama etykieta co instaluje installMac() ===

test('buildMacStatus: rozpoznaje agenta po etykiecie instalowanej przez installMac()', () => {
  const status = platform.buildMacStatus({
    launchctlOutput: LAUNCHCTL_OUTPUT,
    plistExists: true,
    legacyAgents: [],
  });

  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.running, true);
  assert.strictEqual(status.platform, 'macos');
  assert.strictEqual(status.label, 'com.claude-cron.scheduler');
  assert.strictEqual(status.legacy, false);
});

// PLIST_PATH jest budowane tylko na darwin (poza macOS to ''), więc asercja o nazwie PLIKU
// ma sens wyłącznie tam — na Linuksie (VPS) dawała FAŁSZYWY czerwony wynik całej suity.
test('buildMacStatus: etykieta statusu = etykieta z PLIST_PATH (jedna stała)', {
  skip: process.platform !== 'darwin' ? 'PLIST_PATH jest puste poza macOS' : false,
}, () => {
  const status = platform.buildMacStatus({
    launchctlOutput: LAUNCHCTL_OUTPUT,
    plistExists: true,
    legacyAgents: [],
  });

  assert.strictEqual(`${status.label}.plist`, path.basename(platform.PLIST_PATH));
});

// Ten sam kontrakt „jedna stała etykiety" bez zależności od platformy — łapie rozjazd
// PLIST_LABEL ↔ buildMacStatus (pierwotny bug modułu) także na Linuksie.
test('buildMacStatus: etykieta statusu = PLIST_LABEL (kontrakt niezależny od platformy)', () => {
  const status = platform.buildMacStatus({
    launchctlOutput: LAUNCHCTL_OUTPUT,
    plistExists: true,
    legacyAgents: [],
  });

  assert.strictEqual(status.label, platform.PLIST_LABEL);
});

test('buildMacStatus: plist na dysku, ale nie wczytany = installed bez running', () => {
  const status = platform.buildMacStatus({
    launchctlOutput: 'PID\tStatus\tLabel\n',
    plistExists: true,
    legacyAgents: [],
  });

  assert.deepStrictEqual(status, {
    installed: true, running: false, platform: 'macos', label: 'com.claude-cron.scheduler', legacy: false,
  });
});

test('buildMacStatus: brak kanonicznego agenta, ale jest ręczny pod starą etykietą', () => {
  const out = 'PID\tStatus\tLabel\n777\t0\tcom.claude-cron.daemon';
  const status = platform.buildMacStatus({
    launchctlOutput: out,
    plistExists: false,
    legacyAgents: [{ label: 'com.claude-cron.daemon', plistExists: true }],
  });

  assert.deepStrictEqual(status, {
    installed: true, running: true, platform: 'macos', label: 'com.claude-cron.daemon', legacy: true,
  });
});

test('buildMacStatus: nic nie zainstalowane', () => {
  const status = platform.buildMacStatus({
    launchctlOutput: 'PID\tStatus\tLabel\n-\t0\tcom.apple.Spotlight',
    plistExists: false,
    legacyAgents: [{ label: 'com.claude-cron.daemon', plistExists: false }],
  });

  assert.deepStrictEqual(status, {
    installed: false, running: false, platform: 'macos', label: 'com.claude-cron.scheduler', legacy: false,
  });
});

// === installMac() / removeLegacyAgents() / unloadAgent() / readLaunchctlList() ===
// Cały kontrakt tych funkcji to KOLEJNOŚĆ kroków i reakcja na pad `launchctl` — czysta funkcja
// tego nie odda, a realny `launchctl load` wymaga sesji GUI. Stąd atrapa I/O (`REAL_IO`),
// która zapisuje ślad wywołań.

function fakeIo({ legacyExists = false, failOn = null, listOutput = '' } = {}) {
  const calls = [];
  const written = [];
  const io = {
    mkdirp: dir => { calls.push(`mkdirp:${dir}`); },
    writeFile: (file, content) => { calls.push(`writeFile:${file}`); written.push(content); },
    exists: file => { calls.push(`exists:${file}`); return legacyExists; },
    unlink: file => { calls.push(`unlink:${file}`); },
    launchctl: args => {
      calls.push(`launchctl:${args.join(' ')}`);
      if (failOn && args[0] === failOn) throw new Error(`launchctl ${failOn} padł`);
      return listOutput;
    },
    log: message => { calls.push(`log:${message}`); },
    warn: message => { calls.push(`warn:${message}`); },
  };
  return { io, calls, written };
}

const firstIndex = (calls, prefix) => calls.findIndex(entry => entry.startsWith(prefix));
const LEGACY_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${platform.LEGACY_PLIST_LABELS[0]}.plist`);
const LOG_DIR = path.join(HOME, 'Library', 'Logs', 'claude-cron');

test('installMac: katalog logów i unload PRZED zapisem plista, `load` na samym końcu', () => {
  const { io, calls, written } = fakeIo();

  const result = platform.installMac(io);

  const iLogDir = calls.indexOf(`mkdirp:${LOG_DIR}`);
  const iUnload = firstIndex(calls, 'launchctl:unload');
  const iWrite = firstIndex(calls, 'writeFile:');
  const iLoad = firstIndex(calls, 'launchctl:load');

  assert.ok(iLogDir >= 0, `brak mkdirp katalogu logów: ${calls.join(' | ')}`);
  assert.ok(iUnload >= 0, `brak unloadu własnej etykiety: ${calls.join(' | ')}`);
  assert.ok(iUnload < iWrite, 'unload musi lecieć PRZED zapisem plista');
  assert.ok(iLogDir < iLoad, 'katalog logów musi istnieć PRZED load (inaczej EX_CONFIG 78)');
  assert.ok(iWrite < iLoad, 'plist musi być zapisany PRZED load');
  assert.strictEqual(calls[iLoad], `launchctl:load -w ${platform.PLIST_PATH}`);
  assert.strictEqual(calls[iLoad], calls[calls.length - 1], '`load` jest ostatnim krokiem');
  assert.match(written[0], new RegExp(`<string>${platform.PLIST_LABEL}</string>`));
  assert.strictEqual(result, platform.PLIST_PATH);
});

test('installMac: legacy agent odpięty i skasowany PRZED zapisem nowego plista (koniec dwóch agentów na 7777)', () => {
  const { io, calls } = fakeIo({ legacyExists: true });

  platform.installMac(io);

  const iUnloadLegacy = calls.indexOf(`launchctl:unload ${LEGACY_PATH}`);
  const iUnlink = calls.indexOf(`unlink:${LEGACY_PATH}`);
  const iWrite = firstIndex(calls, 'writeFile:');

  assert.ok(iUnloadLegacy >= 0, `brak unloadu legacy: ${calls.join(' | ')}`);
  assert.ok(iUnloadLegacy < iUnlink, 'najpierw unload, dopiero potem kasowanie plista');
  assert.ok(iUnlink < iWrite, 'sprzątanie legacy musi się domknąć PRZED zapisem nowego plista');
});

test('installMac: pad `launchctl unload` nie przerywa instalacji (pierwsza instalacja nie ma czego odpinać)', () => {
  const { io, calls } = fakeIo({ failOn: 'unload' });

  assert.doesNotThrow(() => platform.installMac(io));
  assert.ok(firstIndex(calls, 'writeFile:') >= 0, 'plist mimo padu unloadu ma powstać');
  assert.ok(firstIndex(calls, 'launchctl:load') > firstIndex(calls, 'writeFile:'));
});

test('removeLegacyAgents: brak starego plista = zero unloadów i zero kasowania', () => {
  const { io, calls } = fakeIo({ legacyExists: false });

  platform.removeLegacyAgents(io);

  assert.deepStrictEqual(calls, [`exists:${LEGACY_PATH}`]);
});

test('removeLegacyAgents: nieudany unload — plist i tak kasowany, ale z ostrzeżeniem o żyjącym agencie', () => {
  // Świadomy kontrakt modułu: skasowanie plista domyka duplikat po reboocie, a ostrzeżenie
  // ratuje diagnozę EADDRINUSE, gdyby stary agent nadal biegł.
  const { io, calls } = fakeIo({ legacyExists: true, failOn: 'unload' });

  platform.removeLegacyAgents(io);

  assert.ok(calls.includes(`unlink:${LEGACY_PATH}`), 'plist legacy ma zniknąć mimo padu unloadu');
  assert.ok(
    calls.some(entry => entry.startsWith('warn:') && entry.includes(platform.LEGACY_PLIST_LABELS[0])),
    `brak ostrzeżenia o nieudanym unloadzie: ${calls.join(' | ')}`,
  );
});

test('unloadAgent: sukces = ok:true bez błędu', () => {
  const { io, calls } = fakeIo();

  assert.deepStrictEqual(platform.unloadAgent('/tmp/x.plist', io), { ok: true, error: null });
  assert.deepStrictEqual(calls, ['launchctl:unload /tmp/x.plist']);
});

test('unloadAgent: pad zwraca ok:false z błędem zamiast łykać go po cichu', () => {
  const { io } = fakeIo({ failOn: 'unload' });

  const result = platform.unloadAgent('/tmp/x.plist', io);

  assert.strictEqual(result.ok, false);
  assert.match(result.error.message, /launchctl unload padł/);
});

test('readLaunchctlList: zwraca surowy output launchctl', () => {
  const { io, calls } = fakeIo({ listOutput: 'PID\tStatus\tLabel\n1\t0\tcom.example' });

  assert.strictEqual(platform.readLaunchctlList(io), 'PID\tStatus\tLabel\n1\t0\tcom.example');
  assert.deepStrictEqual(calls, ['launchctl:list']);
});

test('readLaunchctlList: pad launchctl = pusty output i ostrzeżenie tylko RAZ na proces', (t) => {
  // Flaga „już ostrzegaliśmy" żyje przez CAŁY proces, więc bez resetu ten test przechodzi
  // tylko dopóki jest pierwszym, który wywoła pad launchctl — dołożenie wcześniejszego
  // przypadku z failOn:'list' dawało zero ostrzeżeń i fałszywą czerwień.
  platform.resetLaunchctlWarning();
  t.after(() => platform.resetLaunchctlWarning());
  const { io, calls } = fakeIo({ failOn: 'list' });

  assert.strictEqual(platform.readLaunchctlList(io), '');
  assert.strictEqual(platform.readLaunchctlList(io), '');

  const warnings = calls.filter(entry => entry.startsWith('warn:'));
  assert.strictEqual(warnings.length, 1, `/api/status poluje co 3 s — ostrzeżenie ma być jedno: ${calls.join(' | ')}`);
});

test('readLaunchctlList: ostrzeżenie wraca po resecie (test nie zależy od kolejności)', (t) => {
  // Strażnik regresji: gdyby reset zniknął, ten przypadek „zużyje" jedyne ostrzeżenie
  // procesu i test powyżej zacznie padać w zależności od kolejności wykonania.
  platform.resetLaunchctlWarning();
  t.after(() => platform.resetLaunchctlWarning());

  const first = fakeIo({ failOn: 'list' });
  platform.readLaunchctlList(first.io);
  assert.strictEqual(first.calls.filter(e => e.startsWith('warn:')).length, 1);

  platform.resetLaunchctlWarning();
  const second = fakeIo({ failOn: 'list' });
  platform.readLaunchctlList(second.io);
  assert.strictEqual(second.calls.filter(e => e.startsWith('warn:')).length, 1, 'po resecie ostrzegamy znowu');
});

test('pickPlistEnv: pomija klucze puste i nieustawione (pusty VPS_URL = proxy 503)', () => {
  const picked = platform.pickPlistEnv({
    PATH: '/usr/bin',
    HOME: '/Users/tester',
    CLAUDE_CRON_VPS_URL: '',
    CLAUDE_CRON_WORKSPACE: '   ',
    IRRELEVANT: 'x',
  });

  assert.deepStrictEqual(picked, { PATH: '/usr/bin', HOME: '/Users/tester' });
});
