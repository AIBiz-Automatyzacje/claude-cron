// Testy CLI onboardingu skrzynki (most bash → Node). Sedno kontraktu, którego pilnujemy:
// (1) kod wyjścia jest rozłączny i to on niesie decyzję dla instalatora,
// (2) każda ścieżka porażki zostawia maszynę BEZ zapisanego tokenu i BEZ ustawionej roli,
// (3) żaden komunikat nie wypisuje tokenu ani kodu zaproszenia (log instalacji bywa czytany).
// Mockujemy WYŁĄCZNIE świat zewnętrzny (hub przez `probe`, git przez `ensureIgnored` tam,
// gdzie testujemy odmowę guardu); zapis `.env` i state są prawdziwe — to one są dowodem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT,
  describeRoleChange,
  isEntryPoint,
  main,
  parseArgs,
  redactToken,
  runOnboard,
} from './onboard.mjs';

const require = createRequire(import.meta.url);
const db = require('../../lib/db');
const { ROLE_STATE_KEY } = require('../../lib/inbox-seed');

// Baza w pamięci — testy nie mogą dotknąć data/claude-cron.db operatora.
db.setDbPath(':memory:');

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HUB_URL = 'https://hub.example.com';
const CODE = `puls-inbox:${HUB_URL}#${TOKEN}`;

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-onboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function envPath(workspace) {
  return path.join(workspace, '.env');
}

const okProbe = async () => ({ ok: true, user: 'kacper' });

// Rejestrator zapisu roli — używany TYLKO w testach porażek, gdzie dowodem jest
// „state nie został dotknięty" (w bazie w pamięci trwa stan z poprzednich testów).
function roleRecorder() {
  const calls = [];
  return { calls, setRole: (role) => calls.push(role) };
}

function captureLogs(t) {
  const saved = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  t.after(() => { console.log = saved; });
  return logs;
}

// ──────── parseArgs (czysty) ────────

test('parseArgs: obie formy argumentów (--flag wartość i --flag=wartość) dają ten sam wynik', () => {
  const spaced = parseArgs(['--code', CODE, '--role', 'agent', '--workspace', '/vault']);
  const inline = parseArgs([`--code=${CODE}`, '--role=agent', '--workspace=/vault']);

  assert.deepEqual(spaced, { ok: true, code: CODE, role: 'agent', workspace: '/vault' });
  assert.deepEqual(inline, spaced);
});

test('parseArgs: brak --workspace → workspace z CLAUDE_CRON_WORKSPACE (czytane w momencie wywołania)', () => {
  const parsed = parseArgs(['--code', CODE, '--role', 'client'], { CLAUDE_CRON_WORKSPACE: '/from/env' });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.workspace, '/from/env');
});

test('parseArgs: brak kodu zaproszenia → odrzucone', () => {
  const parsed = parseArgs(['--role', 'agent', '--workspace', '/vault']);

  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /kod/i);
});

test('parseArgs: rola spoza dziedziny → odrzucone, a powód nie cytuje wartości (mogłaby nią być tożsamość)', () => {
  const wrongCase = parseArgs(['--code', CODE, '--role', 'Agent', '--workspace', '/vault']);
  const swapped = parseArgs(['--code', CODE, '--role', CODE, '--workspace', '/vault']);

  assert.equal(wrongCase.ok, false, 'strict equality w seedzie: „Agent" ≠ „agent"');
  assert.equal(swapped.ok, false);
  assert.ok(!swapped.reason.includes(TOKEN), 'powód odrzucenia nie może nieść tokenu');
});

test('parseArgs: kod podany pozycyjnie (bez flagi) → odrzucone bez echa argumentu', () => {
  const parsed = parseArgs([CODE]);

  assert.equal(parsed.ok, false);
  assert.ok(!parsed.reason.includes(TOKEN), 'nieznany argument nie może trafić do komunikatu — bywa nim kod zaproszenia');
});

test('parseArgs: flaga bez wartości na końcu argv → odrzucone', () => {
  const parsed = parseArgs(['--code', CODE, '--role']);

  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /wartości/i);
});

// ──────── runOnboard: happy path ────────

test('poprawny kod + osiągalny hub → .env zapisany, rola w state, kod wyjścia OK', async (t) => {
  const workspace = makeWorkspace(t);

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, { probe: okProbe });

  assert.equal(result.exitCode, EXIT.OK);
  const content = fs.readFileSync(envPath(workspace), 'utf-8');
  assert.match(content, /^INBOX_HUB_URL="https:\/\/hub\.example\.com"$/m);
  assert.match(content, new RegExp(`^INBOX_TOKEN="${TOKEN}"$`, 'm'));
  assert.equal(db.getState(ROLE_STATE_KEY), 'agent');
  assert.match(result.message, /^\[ok\]/);
  assert.match(result.message, /kacper/, 'komunikat identyfikuje członka nazwą z probe');
});

test('rola client → w state ląduje dokładnie przekazana wartość (nie domyślna)', async (t) => {
  const workspace = makeWorkspace(t);

  const result = await runOnboard({ code: CODE, role: 'client', workspace }, { probe: okProbe });

  assert.equal(result.exitCode, EXIT.OK);
  assert.equal(db.getState(ROLE_STATE_KEY), 'client');
});

test('powtórne wywołanie z tym samym kodem → idempotentne (jedna linia INBOX_TOKEN)', async (t) => {
  const workspace = makeWorkspace(t);

  await runOnboard({ code: CODE, role: 'client', workspace }, { probe: okProbe });
  const second = await runOnboard({ code: CODE, role: 'client', workspace }, { probe: okProbe });

  assert.equal(second.exitCode, EXIT.OK);
  const lines = fs.readFileSync(envPath(workspace), 'utf-8').split('\n');
  assert.equal(lines.filter((line) => line.startsWith('INBOX_TOKEN=')).length, 1);
  assert.equal(lines.filter((line) => line.startsWith('INBOX_HUB_URL=')).length, 1);
});

test('guard naprawił .gitignore (fixed) → zapis wykonany, komunikat mówi o zmianie w repozytorium', async (t) => {
  const workspace = makeWorkspace(t);
  const gitignoreFile = path.join(workspace, '.gitignore');

  const result = await runOnboard({ code: CODE, role: 'client', workspace }, {
    probe: okProbe,
    ensureIgnored: () => ({ status: 'fixed', gitignoreFile }),
  });

  assert.equal(result.exitCode, EXIT.OK);
  assert.ok(fs.existsSync(envPath(workspace)));
  assert.match(result.message, /\.gitignore/, 'użytkownik ma wiedzieć, że instalator zmienił jego repozytorium');
});

// ──────── zmiana roli między instalacjami (re-run instalatora) ────────
// Instalator sam kieruje na ponowne uruchomienie przy każdej porażce, a pytanie o auto-reply
// pada wtedy od nowa. Seed jobów nigdy nie robi UPDATE, więc zmiana odpowiedzi zostawia
// maszynę z DWOMA włączonymi jobami — człowiek musi się o tym dowiedzieć z komunikatu.

test('zmiana roli client → agent: komunikat wskazuje job sync z poprzedniej instalacji do wyłączenia', async (t) => {
  const workspace = makeWorkspace(t);

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, {
    probe: okProbe,
    getRole: () => 'client',
  });

  assert.equal(result.exitCode, EXIT.OK);
  assert.match(result.message, /Team OS — inbox sync/, 'nazwa joba do wyłączenia musi paść wprost');
  assert.match(result.message, /client → agent/);
  assert.equal(db.getState(ROLE_STATE_KEY), 'agent', 'nowa rola i tak zostaje zapisana');
});

test('zmiana roli agent → client: komunikat wskazuje job auto-reply (drugi kierunek)', async (t) => {
  const workspace = makeWorkspace(t);

  const result = await runOnboard({ code: CODE, role: 'client', workspace }, {
    probe: okProbe,
    getRole: () => 'agent',
  });

  assert.equal(result.exitCode, EXIT.OK);
  assert.match(result.message, /Team OS — asystent auto-reply/);
});

test('ta sama rola przy re-runie → zero ostrzeżenia o zmianie (nie strasz bez powodu)', async (t) => {
  const workspace = makeWorkspace(t);

  const result = await runOnboard({ code: CODE, role: 'client', workspace }, {
    probe: okProbe,
    getRole: () => 'client',
  });

  assert.equal(result.exitCode, EXIT.OK);
  assert.ok(!result.message.includes('Rola tej maszyny zmieniła się'), 'brak zmiany = brak noty');
});

test('brak poprzedniej roli (pierwsza instalacja) i wartość spoza dziedziny → brak noty o zmianie', () => {
  assert.equal(describeRoleChange(undefined, 'agent'), '', 'świeża maszyna nie ma czego rekoncyliować');
  assert.equal(describeRoleChange('sentinel', 'agent'), '', 'śmieć w state to nie poprzednia rola');
});

test('pad odczytu poprzedniej roli nie wywraca onboardingu (.env już zapisany)', async (t) => {
  const workspace = makeWorkspace(t);
  const logs = captureLogs(t);

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, {
    probe: okProbe,
    getRole: () => { throw new Error('SQLITE_BUSY: database is locked'); },
  });

  assert.equal(result.exitCode, EXIT.OK, 'konfiguracja zapisana = sukces mimo nieczytelnego state');
  assert.equal(db.getState(ROLE_STATE_KEY), 'agent', 'rola i tak zapisana');
  assert.match(logs.join('\n'), /poprzedniej roli/, 'cicha porażka odczytu byłaby nie do zdiagnozowania');
});

// ──────── runOnboard: porażki (zero zapisów) ────────

test('zły format kodu → EXIT.BAD_CODE, zero zapisów do .env i state, hub w ogóle nie pytany', async (t) => {
  const workspace = makeWorkspace(t);
  const role = roleRecorder();
  let probeCalls = 0;

  const result = await runOnboard({ code: 'przypadkowo-wklejony-tekst', role: 'agent', workspace }, {
    probe: async () => { probeCalls += 1; return { ok: true, user: 'kacper' }; },
    setRole: role.setRole,
  });

  assert.equal(result.exitCode, EXIT.BAD_CODE);
  assert.equal(fs.existsSync(envPath(workspace)), false);
  assert.deepEqual(role.calls, []);
  assert.equal(probeCalls, 0, 'walidacja formatu jest czysta — nie dotykamy sieci');
});

test('hub nie odpowiedział poprawnie (zła wersja / timeout) → EXIT.HUB, zero zapisów', async (t) => {
  const workspace = makeWorkspace(t);
  const role = roleRecorder();

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, {
    probe: async () => ({ ok: false, reason: 'niezgodna wersja API skrzynki (v:2)' }),
    setRole: role.setRole,
  });

  assert.equal(result.exitCode, EXIT.HUB);
  assert.equal(fs.existsSync(envPath(workspace)), false);
  assert.deepEqual(role.calls, []);
  assert.match(result.message, /v:2/, 'powód pada w komunikacie, żeby operator wiedział co naprawić');
});

test('guard .gitignore = unfixable → EXIT.GITIGNORE, token NIE zapisany (fail-closed)', async (t) => {
  const workspace = makeWorkspace(t);
  const role = roleRecorder();

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, {
    probe: okProbe,
    ensureIgnored: () => ({ status: 'unfixable', gitignoreFile: path.join(workspace, '.gitignore') }),
    setRole: role.setRole,
  });

  assert.equal(result.exitCode, EXIT.GITIGNORE);
  assert.equal(fs.existsSync(envPath(workspace)), false, 'sekret w repozytorium jest nieodwracalny — nie zapisujemy');
  assert.deepEqual(role.calls, []);
  assert.match(result.message, /git rm --cached/, 'komunikat niesie konkretną instrukcję naprawy');
});

test('guard .gitignore = unknown (git niedostępny) → EXIT.GITIGNORE, token NIE zapisany', async (t) => {
  const workspace = makeWorkspace(t);
  const role = roleRecorder();

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, {
    probe: okProbe,
    ensureIgnored: () => ({ status: 'unknown', gitignoreFile: path.join(workspace, '.gitignore') }),
    setRole: role.setRole,
  });

  assert.equal(result.exitCode, EXIT.GITIGNORE);
  assert.equal(fs.existsSync(envPath(workspace)), false, 'nierozstrzygnięty guard odmawia operacji');
  assert.deepEqual(role.calls, []);
});

test('pad zapisu .env → EXIT.WRITE i rola NIE ustawiona (maszyna bez konfiguracji nie dostaje joba)', async (t) => {
  const workspace = makeWorkspace(t);
  const role = roleRecorder();

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, {
    probe: okProbe,
    writeEnv: () => { throw new Error('EACCES: permission denied'); },
    setRole: role.setRole,
  });

  assert.equal(result.exitCode, EXIT.WRITE);
  assert.deepEqual(role.calls, []);
  assert.match(result.message, /EACCES/);
});

// ──────── brak wycieku sekretów do komunikatów ────────

test('komunikat sukcesu nie zawiera tokenu ani kodu zaproszenia', async (t) => {
  const workspace = makeWorkspace(t);

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, { probe: okProbe });

  assert.ok(!result.message.includes(TOKEN));
  assert.ok(!result.message.includes(CODE));
});

test('powód pada z huba z tokenem w URL-u → token zredagowany w komunikacie', async (t) => {
  const workspace = makeWorkspace(t);

  const result = await runOnboard({ code: CODE, role: 'agent', workspace }, {
    probe: async () => ({ ok: false, reason: `fetch failed: ${HUB_URL}/inbox/v1/${TOKEN}/ping` }),
  });

  assert.equal(result.exitCode, EXIT.HUB);
  assert.ok(!result.message.includes(TOKEN), 'undici osadza pełny URL w komunikacie — token nie może trafić do logu instalacji');
  assert.match(result.message, /\*\*\*/);
});

test('redactToken: podmienia każde wystąpienie, znosi się przy braku tokenu', () => {
  assert.equal(redactToken(`a/${TOKEN}/b/${TOKEN}`, TOKEN), 'a/***/b/***');
  assert.equal(redactToken('bez tokenu', ''), 'bez tokenu');
  assert.equal(redactToken(undefined, TOKEN), '');
});

// ──────── skorupa main() + entry-point guard ────────

test('main: brak argumentów → EXIT.BAD_USAGE i wypisane użycie', async (t) => {
  const logs = captureLogs(t);

  const code = await main([], {});

  assert.equal(code, EXIT.BAD_USAGE);
  assert.match(logs.join('\n'), /Użycie:/);
});

test('main: nieistniejący workspace → EXIT.BAD_USAGE (nie mylimy literówki z padem gita)', async (t) => {
  const logs = captureLogs(t);
  const missing = path.join(os.tmpdir(), 'puls-onboard-nie-ma-takiego-katalogu');

  const code = await main(['--code', CODE, '--role', 'client', '--workspace', missing], {});

  assert.equal(code, EXIT.BAD_USAGE);
  assert.match(logs.join('\n'), /workspace nie istnieje/);
});

// URL modułu onboard.mjs — dokładnie to, co skrypt podaje sam sobie jako import.meta.url.
const MODULE_URL = new URL('./onboard.mjs', import.meta.url).href;

test('isEntryPoint: symlink do modułu liczy się jako uruchomienie wprost (macOS /tmp → /private/tmp)', (t) => {
  const dir = makeWorkspace(t);
  const link = path.join(dir, 'onboard-link.mjs');
  fs.symlinkSync(fileURLToPath(MODULE_URL), link);

  assert.equal(isEntryPoint(link, MODULE_URL), true);
});

test('isEntryPoint: inny plik albo brak argv[1] → false (import nie odpala main)', (t) => {
  const dir = makeWorkspace(t);
  const other = path.join(dir, 'inny.mjs');
  fs.writeFileSync(other, '// nie ten plik\n');

  assert.equal(isEntryPoint(other, MODULE_URL), false);
  assert.equal(isEntryPoint(undefined, MODULE_URL), false);
  assert.equal(isEntryPoint(path.join(dir, 'nie-istnieje.mjs'), MODULE_URL), false);
});

test('kody wyjścia są rozłączne i omijają 1 (zarezerwowane dla nieobsłużonego wyjątku)', () => {
  const codes = Object.values(EXIT);

  assert.equal(new Set(codes).size, codes.length, 'bash rozstrzyga wyłącznie na kodzie — kolizja = zła instrukcja dla operatora');
  assert.ok(!codes.includes(1));
});
