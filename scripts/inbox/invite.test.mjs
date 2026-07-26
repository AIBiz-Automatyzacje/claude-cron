// Testy wspólnego rdzenia kodu zaproszenia (invite.mjs).
// Sekcja parse/upsert/write/probe to siatka bezpieczeństwa ekstrakcji z setup.mjs —
// zachowanie MUSI być identyczne jak przed przeniesieniem (te same przypadki co w setup.test.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  GITIGNORE_PATTERN,
  INVITE_CODE_PREFIX,
  ensureEnvIgnored,
  parseInviteCode,
  planGitignoreFix,
  probeInviteCode,
  upsertDotenvLine,
  writeInboxEnv,
} from './invite.mjs';

// Bity uprawnień POSIX — na Windows `chmod` to najwyżej flaga read-only, więc asercja
// trybu 0600 nie ma tam sensu (ta sama konwencja co lib/ask.test.js).
const SKIP_WIN = process.platform === 'win32'
  ? 'uprawnienia POSIX nieobecne na Windows — sekret chroniony ACL-em katalogu użytkownika'
  : false;

function makeWorkspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-invite-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return ws;
}

// Repo testowe odcięte od konfiguracji usera: globalny core.excludesFile ignorujący `.env`
// dałby fałszywy `ok` i test przechodziłby przy zepsutym guardzie. Pusty plik config
// (cross-platform, bez /dev/null) na czas testu.
function makeGitRepo(t, gitignoreContent) {
  const ws = makeWorkspace(t);
  const emptyConfig = path.join(ws, 'pusty-gitconfig');
  fs.writeFileSync(emptyConfig, '', 'utf-8');
  const prev = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyConfig;
  t.after(() => {
    if (prev.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev.global;
    if (prev.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prev.system;
  });
  const init = spawnSync('git', ['-C', ws, 'init', '-q'], { encoding: 'utf-8' });
  assert.equal(init.status, 0, `git init nie powiódł się: ${init.stderr || init.error?.message}`);
  if (typeof gitignoreContent === 'string') {
    fs.writeFileSync(path.join(ws, '.gitignore'), gitignoreContent, 'utf-8');
  }
  return ws;
}

// Snapshot env INBOX_* — probe je tymczasowo ustawia; testy nie mogą zostawić side-effectu.
function snapshotInboxEnv(t) {
  const prev = { url: process.env.INBOX_HUB_URL, token: process.env.INBOX_TOKEN };
  t.after(() => {
    if (prev.url === undefined) delete process.env.INBOX_HUB_URL;
    else process.env.INBOX_HUB_URL = prev.url;
    if (prev.token === undefined) delete process.env.INBOX_TOKEN;
    else process.env.INBOX_TOKEN = prev.token;
  });
}

// Lokalny hub: KAŻDE żądanie → 200 z podanym JSON body (probe trafia /inbox/v1/:token/ping).
async function startFakeHub(t, responseBody) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// === parseInviteCode — odwrotnik buildInviteCode (server.js) ===

test('parseInviteCode happy path: puls-inbox:<url>#<token> → hubUrl + token', () => {
  const result = parseInviteCode(`${INVITE_CODE_PREFIX}https://kacper.tail-scale.ts.net#tok-abc123`);
  assert.deepEqual(result, { hubUrl: 'https://kacper.tail-scale.ts.net', token: 'tok-abc123' });
});

test('parseInviteCode trimuje otaczające białe znaki (wklejenie z bufora)', () => {
  assert.deepEqual(parseInviteCode('  puls-inbox:https://hub.example#tok42  '), {
    hubUrl: 'https://hub.example',
    token: 'tok42',
  });
});

test('parseInviteCode error: zły prefiks → null', () => {
  assert.equal(parseInviteCode('inbox:https://hub.example#tok'), null);
  assert.equal(parseInviteCode('https://hub.example#tok'), null);
});

test('parseInviteCode error: brak `#` (brak separatora tokenu) → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example'), null);
});

test('parseInviteCode error: pusty token lub pusty URL → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#   '), null);
  assert.equal(parseInviteCode('puls-inbox:#tok'), null);
});

test('parseInviteCode error: URL nie-http (śmieć / zły protokół) → null', () => {
  assert.equal(parseInviteCode('puls-inbox:ftp://hub.example#tok'), null);
  assert.equal(parseInviteCode('puls-inbox:nie-url#tok'), null);
});

test('parseInviteCode error: nie-string / puste wejście → null', () => {
  assert.equal(parseInviteCode(''), null);
  assert.equal(parseInviteCode(null), null);
  assert.equal(parseInviteCode(undefined), null);
});

test('parseInviteCode: URL z `#` w środku rozdzielany po OSTATNIM separatorze', () => {
  assert.deepEqual(parseInviteCode('puls-inbox:https://hub.example/a#b#tok-x'), {
    hubUrl: 'https://hub.example/a#b',
    token: 'tok-x',
  });
});

// === parseInviteCode — WROGIE wejścia (kod zaproszenia przychodzi kanałem czatu) ===
// Kod wkleja człowiek ze źródła, którego moduł nie kontroluje, a wartości lądują w `.env`
// czytanym przez env-loader → `process.env` script-jobów → spawn `claude`. Dziedzina musi
// być zamknięta PRZED `new URL`, bo parser WHATWG po cichu wycina CR/LF/TAB i po nim string
// wygląda niewinnie. Te testy pilnują, żeby cofnięcie walidacji nie przeszło na zielono.

test('parseInviteCode wróg: token z newline (wstrzyknięcie linii do .env) → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#tok\nNODE_OPTIONS=--require /tmp/evil.js'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#tok\r\nEVIL=1'), null);
});

test('parseInviteCode wróg: URL z CR/LF/TAB (URL wycina je po cichu) → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example\nEVIL_VAR=1#tok'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.exa\tmple#tok'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.example\rEVIL_VAR=1#tok'), null);
});

test('parseInviteCode wróg: cudzysłów lub backslash (ucieczka spod KEY="…") → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#tok"EVIL="1'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#tok\\'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.exa"mple#tok'), null);
});

test('parseInviteCode wróg: znak sterujący w tokenie lub URL-u → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#tok\x00evil'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#tok\x7f'), null);
  assert.equal(parseInviteCode('puls-inbox:https://hub.exa\x1bmple#tok'), null);
});

test('parseInviteCode wróg: spacja w tokenie (drugi argument w linii .env) → null', () => {
  assert.equal(parseInviteCode('puls-inbox:https://hub.example#tok evil'), null);
});

// === upsertDotenvLine — idempotentny zapis KEY=value (format env-loader, bez `export`) ===

test('upsertDotenvLine dopisuje KEY="value" gdy klucza nie ma (bez export)', () => {
  const result = upsertDotenvLine('CLAUDE_CRON_WORKSPACE="/ws"\n', 'INBOX_HUB_URL', 'https://hub.example');
  assert.ok(result.includes('INBOX_HUB_URL="https://hub.example"'));
  assert.ok(result.includes('CLAUDE_CRON_WORKSPACE="/ws"'), 'istniejąca treść zachowana');
  assert.ok(!result.includes('export INBOX_HUB_URL'), 'format .env bez prefiksu export');
});

test('upsertDotenvLine podmienia istniejącą linię (idempotentny re-run, brak duplikatu)', () => {
  const initial = upsertDotenvLine('', 'INBOX_TOKEN', 'stary');
  const updated = upsertDotenvLine(initial, 'INBOX_TOKEN', 'nowy');
  assert.equal((updated.match(/INBOX_TOKEN=/g) || []).length, 1, 'tylko jedna linia — bez duplikatu');
  assert.ok(updated.includes('INBOX_TOKEN="nowy"'));
});

test('upsertDotenvLine dokłada brakujący newline przed nową linią', () => {
  const result = upsertDotenvLine('INBOX_HUB_URL="https://hub"', 'INBOX_TOKEN', 'tok');
  assert.equal(result, 'INBOX_HUB_URL="https://hub"\nINBOX_TOKEN="tok"\n');
});

// === upsertDotenvLine — WROGIE wejścia: druga warstwa fail-closed na granicy zapisu ===
// parseInviteCode nie jest jedynym wołającym (setup/onboard mogą dojść), więc sam zapis
// też musi odmawiać — inaczej regresja w parse od razu produkuje wstrzyknięcie do `.env`.

test('upsertDotenvLine wróg: wartość z CR/LF rzuca zamiast rozerwać linię', () => {
  assert.throws(
    () => upsertDotenvLine('', 'INBOX_TOKEN', 'tok\nNODE_OPTIONS=--require /tmp/evil.js'),
    /Niedozwolona wartość/,
  );
  assert.throws(() => upsertDotenvLine('', 'INBOX_HUB_URL', 'https://hub\r\nEVIL=1'), /Niedozwolona wartość/);
});

test('upsertDotenvLine wróg: wartość z cudzysłowem, backslashem lub znakiem sterującym rzuca', () => {
  assert.throws(() => upsertDotenvLine('', 'INBOX_TOKEN', 'tok"EVIL="1'), /Niedozwolona wartość/);
  assert.throws(() => upsertDotenvLine('', 'INBOX_TOKEN', 'tok\\'), /Niedozwolona wartość/);
  assert.throws(() => upsertDotenvLine('', 'INBOX_TOKEN', 'tok\x00'), /Niedozwolona wartość/);
  assert.throws(() => upsertDotenvLine('', 'INBOX_TOKEN', ''), /Niedozwolona wartość/);
});

test('upsertDotenvLine wróg: komunikat błędu NIE zawiera wartości (to bywa sekret w logu)', () => {
  const secret = 'sekret-abc123\nEVIL=1';
  assert.throws(
    () => upsertDotenvLine('', 'INBOX_TOKEN', secret),
    (error) => {
      assert.ok(!error.message.includes('sekret-abc123'), 'wartość nie wycieka do komunikatu');
      assert.ok(error.message.includes('INBOX_TOKEN'), 'nazwa zmiennej wystarcza do diagnozy');
      return true;
    },
  );
});

test('upsertDotenvLine wróg: klucz spoza dziedziny env-loadera rzuca (klucz idzie do RegExp)', () => {
  assert.throws(() => upsertDotenvLine('', 'INBOX.*', 'tok'), /Niedozwolona nazwa zmiennej/);
  assert.throws(() => upsertDotenvLine('', 'inbox_token', 'tok'), /Niedozwolona nazwa zmiennej/);
  assert.throws(() => upsertDotenvLine('', '', 'tok'), /Niedozwolona nazwa zmiennej/);
});

test('upsertDotenvLine: wartość ze wzorcem `$&` zapisana DOSŁOWNIE przy podmianie linii', () => {
  // String.replace ze stringiem-replacerem rozwinąłby `$&` do całego dopasowania,
  // cicho przekłamując zapisany sekret. Replacer funkcyjny musi to wykluczyć.
  const initial = upsertDotenvLine('', 'INBOX_TOKEN', 'stary');
  const updated = upsertDotenvLine(initial, 'INBOX_TOKEN', 'tok$&$1$`');

  assert.ok(updated.includes('INBOX_TOKEN="tok$&$1$`"'), 'wartość dosłowna, bez rozwinięcia wzorców');
  assert.equal((updated.match(/INBOX_TOKEN=/g) || []).length, 1);
});

// === writeInboxEnv — zapis do <workspace>/.env bez ruszania pozostałych kluczy ===

test('writeInboxEnv upsertuje INBOX_* nie ruszając pozostałych kluczy w .env', (t) => {
  const ws = makeWorkspace(t);
  const envFile = path.join(ws, '.env');
  fs.writeFileSync(envFile, 'CLAUDE_CRON_WORKSPACE="/ws"\nINBOX_TOKEN="stary"\nDISCORD_WEBHOOK_URL="https://d"\n', 'utf-8');

  const written = writeInboxEnv(ws, 'https://hub.example', 'tok-nowy');

  assert.equal(written, envFile);
  const content = fs.readFileSync(envFile, 'utf-8');
  assert.ok(content.includes('INBOX_HUB_URL="https://hub.example"'), 'hub URL zapisany');
  assert.ok(content.includes('INBOX_TOKEN="tok-nowy"'), 'token podmieniony');
  assert.ok(content.includes('CLAUDE_CRON_WORKSPACE="/ws"'), 'obcy klucz nietknięty');
  assert.ok(content.includes('DISCORD_WEBHOOK_URL="https://d"'), 'obcy klucz nietknięty');
  assert.equal((content.match(/INBOX_TOKEN=/g) || []).length, 1, 'brak duplikatu po re-runie');
});

test('writeInboxEnv tworzy .env gdy pliku jeszcze nie ma', (t) => {
  const ws = makeWorkspace(t);

  writeInboxEnv(ws, 'https://hub.example', 'tok-1');

  const content = fs.readFileSync(path.join(ws, '.env'), 'utf-8');
  assert.ok(content.includes('INBOX_HUB_URL="https://hub.example"'));
  assert.ok(content.includes('INBOX_TOKEN="tok-1"'));
});

test('writeInboxEnv: nowy .env z tokenem powstaje z trybem 0600 (nie world-readable)', { skip: SKIP_WIN }, (t) => {
  const ws = makeWorkspace(t);

  const envFile = writeInboxEnv(ws, 'https://hub.example', 'tok-1');

  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600, 'sekret czytelny tylko dla właściciela');
});

test('writeInboxEnv: istniejący .env w 0644 zostaje ZAWĘŻONY do 0600', { skip: SKIP_WIN }, (t) => {
  // `mode` w writeFileSync działa wyłącznie przy TWORZENIU pliku — plik po starszej
  // instalacji zostałby przy 0644 z tokenem w środku, gdyby zabrakło chmodSync.
  const ws = makeWorkspace(t);
  const envFile = path.join(ws, '.env');
  fs.writeFileSync(envFile, 'CLAUDE_CRON_WORKSPACE="/ws"\n', { encoding: 'utf-8', mode: 0o644 });
  fs.chmodSync(envFile, 0o644);

  writeInboxEnv(ws, 'https://hub.example', 'tok-2');

  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600, 'uprawnienia domykane też na istniejącym pliku');
});

test('writeInboxEnv wróg: token z newline rzuca i NIE zostawia zapisanego pliku', (t) => {
  const ws = makeWorkspace(t);

  assert.throws(
    () => writeInboxEnv(ws, 'https://hub.example', 'tok\nNODE_OPTIONS=--require /tmp/evil.js'),
    /Niedozwolona wartość/,
  );
  assert.equal(fs.existsSync(path.join(ws, '.env')), false, 'zero zapisu przy wrogiej wartości');
});

test('writeInboxEnv wróg: wrogi token nie dopisuje linii do ISTNIEJĄCEGO .env', (t) => {
  const ws = makeWorkspace(t);
  const envFile = path.join(ws, '.env');
  fs.writeFileSync(envFile, 'CLAUDE_CRON_WORKSPACE="/ws"\n', 'utf-8');

  assert.throws(() => writeInboxEnv(ws, 'https://hub.example', 'tok\nEVIL=1'), /Niedozwolona wartość/);

  const content = fs.readFileSync(envFile, 'utf-8');
  assert.equal(content, 'CLAUDE_CRON_WORKSPACE="/ws"\n', 'plik nietknięty');
  assert.ok(!content.includes('EVIL'), 'zero wstrzykniętej zmiennej');
});

// === planGitignoreFix — czysta decyzja o naprawie (każda gałąź bez zakładania repo) ===

test('planGitignoreFix: poza repo → not_a_repo, nic do zapisania', () => {
  assert.deepEqual(planGitignoreFix({ isRepo: false, isIgnored: false, gitignoreContent: '' }), {
    status: 'not_a_repo',
    nextContent: null,
  });
});

test('planGitignoreFix: git już ignoruje → ok, nic do zapisania', () => {
  assert.deepEqual(planGitignoreFix({ isRepo: true, isIgnored: true, gitignoreContent: '.env*\n' }), {
    status: 'ok',
    nextContent: null,
  });
});

test('planGitignoreFix: nie ignoruje i brak wzorca → needs_fix z dopisanym wzorcem', () => {
  const plan = planGitignoreFix({ isRepo: true, isIgnored: false, gitignoreContent: 'node_modules/\n' });
  assert.equal(plan.status, 'needs_fix');
  assert.ok(plan.nextContent.startsWith('node_modules/\n'), 'istniejąca treść zachowana');
  assert.ok(plan.nextContent.endsWith(`${GITIGNORE_PATTERN}\n`), 'wzorzec dopisany na końcu');
});

test('planGitignoreFix: brak newline na końcu pliku → wzorzec i tak w osobnej linii', () => {
  const plan = planGitignoreFix({ isRepo: true, isIgnored: false, gitignoreContent: 'node_modules/' });
  assert.ok(plan.nextContent.split('\n').includes(GITIGNORE_PATTERN), 'wzorzec jako samodzielna linia');
});

test('planGitignoreFix: wzorzec już w pliku, a git nadal nie ignoruje → unfixable bez duplikatu', () => {
  assert.deepEqual(
    planGitignoreFix({ isRepo: true, isIgnored: false, gitignoreContent: `${GITIGNORE_PATTERN}\n!.env\n` }),
    { status: 'unfixable', nextContent: null },
  );
});

test('planGitignoreFix: stan nierozstrzygnięty (git niedostępny) → unknown, nic do zapisania', () => {
  assert.deepEqual(planGitignoreFix({ isRepo: 'unknown', isIgnored: false, gitignoreContent: '' }), {
    status: 'unknown',
    nextContent: null,
  });
});

// === ensureEnvIgnored — guard na żywym repo: rozstrzyganie na exit-code + ponowna weryfikacja ===

test('ensureEnvIgnored: workspace nie jest repo gitowym → not_a_repo, .gitignore nietknięty', (t) => {
  const ws = makeWorkspace(t);

  const result = ensureEnvIgnored(ws);

  assert.equal(result.status, 'not_a_repo');
  assert.equal(fs.existsSync(path.join(ws, '.gitignore')), false, 'guard nie tworzy pliku poza repo');
});

test('ensureEnvIgnored: repo z wzorcem .env* → ok, zero zapisów do .gitignore', (t) => {
  const ws = makeGitRepo(t, '.env*\n');
  const before = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');

  const result = ensureEnvIgnored(ws);

  assert.equal(result.status, 'ok');
  assert.equal(fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8'), before, 'plik nietknięty');
});

test('ensureEnvIgnored: repo z samym .env → wariant .env.bak nie jest ignorowany, dopisuje wzorzec → fixed', (t) => {
  const ws = makeGitRepo(t, '.env\n');

  const result = ensureEnvIgnored(ws);

  assert.equal(result.status, 'fixed');
  const content = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');
  assert.ok(content.split('\n').includes(GITIGNORE_PATTERN), 'wzorzec .env* dopisany');
  assert.ok(content.startsWith('.env\n'), 'poprzednia reguła zachowana');
  assert.equal(
    spawnSync('git', ['-C', ws, 'check-ignore', '-q', '--', '.env.bak.x']).status,
    0,
    'po naprawie git faktycznie ignoruje wariant z sufiksem',
  );
});

test('ensureEnvIgnored: repo bez .gitignore → tworzy plik z wzorcem, wynik fixed', (t) => {
  const ws = makeGitRepo(t, null);

  const result = ensureEnvIgnored(ws);

  assert.equal(result.status, 'fixed');
  assert.equal(result.gitignoreFile, path.join(ws, '.gitignore'));
  assert.ok(fs.readFileSync(result.gitignoreFile, 'utf-8').split('\n').includes(GITIGNORE_PATTERN));
});

test('ensureEnvIgnored idempotentny: drugie wywołanie → ok, wzorzec dokładnie raz', (t) => {
  const ws = makeGitRepo(t, '.env\n');

  assert.equal(ensureEnvIgnored(ws).status, 'fixed');
  const second = ensureEnvIgnored(ws);

  assert.equal(second.status, 'ok', 'po naprawie guard nie rusza pliku ponownie');
  const lines = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8').split('\n');
  assert.equal(lines.filter((line) => line === GITIGNORE_PATTERN).length, 1, 'brak duplikatu wzorca');
});

test('ensureEnvIgnored: reguła negacji wymuszająca śledzenie .env → unfixable, bez duplikatu wzorca', (t) => {
  const ws = makeGitRepo(t, `${GITIGNORE_PATTERN}\n!.env\n`);

  const result = ensureEnvIgnored(ws);

  assert.equal(result.status, 'unfixable', 'git nie ignoruje .env mimo wzorca → fail-closed');
  const lines = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8').split('\n');
  assert.equal(lines.filter((line) => line === GITIGNORE_PATTERN).length, 1, 'brak dopisanej kopii wzorca');
});

test('ensureEnvIgnored: .env już śledzony w indeksie → po dopisaniu wzorca ponowna weryfikacja daje unfixable', (t) => {
  const ws = makeGitRepo(t, '');
  fs.writeFileSync(path.join(ws, '.env'), 'INBOX_TOKEN="stary"\n', 'utf-8');
  const add = spawnSync('git', ['-C', ws, 'add', '-f', '.env'], { encoding: 'utf-8' });
  assert.equal(add.status, 0, `git add nie powiódł się: ${add.stderr}`);

  const result = ensureEnvIgnored(ws);

  // Wzorzec dopisany, ale git nadal raportuje .env jako NIE-ignorowany (śledzony plik).
  // Dopiero DRUGA odpowiedź gita rozstrzyga wynik — sam zapis wzorca nie jest dowodem.
  assert.equal(result.status, 'unfixable');
  assert.ok(fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8').split('\n').includes(GITIGNORE_PATTERN));
});

test('ensureEnvIgnored: git niedostępny (pusty PATH) → unknown, .gitignore nietknięty', { skip: SKIP_WIN }, (t) => {
  // Realna topologia zadania: VPS bez gita, a workspace to klon repo pushowanego z laptopa.
  // Brak binarki NIE znaczy „to nie repo" — guard musi odmówić potwierdzenia (fail-closed),
  // inaczej instalator po cichu zapisuje token do nieignorowanego `.env`.
  const ws = makeGitRepo(t, '');
  const prevPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = prevPath;
  });

  const result = ensureEnvIgnored(ws);

  process.env.PATH = prevPath;
  assert.equal(result.status, 'unknown', 'brak wiarygodnej odpowiedzi gita → fail-closed');
  assert.equal(fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8'), '', 'guard nie mutuje pliku, gdy nie wie');
});

// === probeInviteCode — ping huba przez inbox-client, nigdy nie rzuca ===

test('probeInviteCode: hub odpowiada v:1 → { ok:true, user }', async (t) => {
  snapshotInboxEnv(t);
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper', hub: 'puls' });

  const result = await probeInviteCode(hubUrl, 'tok-xyz');

  assert.equal(result.ok, true);
  assert.equal(result.user, 'kacper');
});

test('probeInviteCode: zła wersja huba → { ok:false, reason } zamiast wyjątku', async (t) => {
  snapshotInboxEnv(t);
  const hubUrl = await startFakeHub(t, { v: 2, user: 'ktoś' });

  const result = await probeInviteCode(hubUrl, 'tok-xyz');

  assert.equal(result.ok, false);
  assert.ok(result.reason, 'powód pada jest raportowany wołającemu');
});

test('probeInviteCode przywraca process.env po sobie (zero side-effectu)', async (t) => {
  snapshotInboxEnv(t);
  delete process.env.INBOX_HUB_URL;
  delete process.env.INBOX_TOKEN;
  const hubUrl = await startFakeHub(t, { v: 1, user: 'kacper' });

  await probeInviteCode(hubUrl, 'tok-xyz');

  assert.equal(process.env.INBOX_HUB_URL, undefined, 'probe przywraca env po sobie');
  assert.equal(process.env.INBOX_TOKEN, undefined);
});
