#!/usr/bin/env node
// Team OS — CLI onboardingu członka skrzynki (most bash → Node dla instalatora VPS).
//
// Instalator w bashu NIE zna ani formatu kodu zaproszenia, ani `.env`, ani bazy stanu —
// woła ten skrypt i rozstrzyga WYŁĄCZNIE na kodzie wyjścia. Komunikat jest dla człowieka
// (jedna linia w stylu [ok]/[warn]/[error] z setup.mjs), nigdy do parsowania przez shell:
// treść komunikatów zmienia się przy każdej korekcie językowej, kody wyjścia nie.
//
// Cała logika domenowa siedzi we współdzielonym rdzeniu `invite.mjs` (to samo, czego
// używa interaktywny setup.mjs) — tutaj jest wyłącznie sekwencja + tłumaczenie wyniku
// na kod wyjścia.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  GITIGNORE_PATTERN,
  ensureEnvIgnored,
  parseInviteCode,
  probeInviteCode,
  writeInboxEnv,
} from './invite.mjs';

// ESM → CommonJS dla warstwy lib/ (precedens: auto-reply.mjs → lib/claude-spawn,
// setup.mjs → lib/db). Wymaganie modułu nie otwiera bazy — getDb() jest leniwe.
const require = createRequire(import.meta.url);
const db = require('../../lib/db');
const { ROLE_STATE_KEY, isValidRole } = require('../../lib/inbox-seed');

// Kontrakt maszynowy dla bash-a. Rozłączne kody, bo instalator dobiera po nich komunikat
// naprawczy i decyduje, czy restartować serwis (restart ma sens WYŁĄCZNIE po OK — dopiero
// wtedy w `.env` leży konfiguracja, której żyjący daemon jeszcze nie widzi).
// Świadomie omijamy 1: to kod, który Node zwraca przy nieobsłużonym wyjątku, więc bash
// odróżnia „CLI się wywróciło" od każdego z wyników domenowych poniżej.
export const EXIT = Object.freeze({
  OK: 0,
  BAD_USAGE: 2, // instalator zawołał CLI źle (brak argumentu / zła rola / brak workspace)
  BAD_CODE: 3, // człowiek wkleił zły kod zaproszenia — jedyny wynik do powtórzenia pytania
  HUB: 4, // hub nieosiągalny albo odpowiedział inną wersją API
  GITIGNORE: 5, // git opublikowałby `.env` — sekret NIE zapisany (fail-closed)
  WRITE: 6, // zapis `.env` / roli padł (uprawnienia, dysk, baza)
});

const FLAGS = { '--code': 'code', '--role': 'role', '--workspace': 'workspace' };

const USAGE = 'Użycie: node scripts/inbox/onboard.mjs --code <kod-zaproszenia> --role agent|client [--workspace <ścieżka>]';

// === Pure helper: argv → { code, role, workspace } albo powód odrzucenia ===
// Obsługuje obie formy (`--role agent` i `--role=agent`), bo bash instalatora cytuje
// wartości przez `%q` i obie postacie są tam naturalne.
// Powód NIGDY nie cytuje wartości argumentu: gdyby instalator pomylił kolejność, w polu
// roli (albo w nieznanym argumencie) wylądowałby kod zaproszenia = token w logu instalacji.
export function parseArgs(argv, env = {}) {
  const values = { code: '', role: '', workspace: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = FLAGS[eq === -1 ? arg : arg.slice(0, eq)];
    if (!key) {
      return { ok: false, reason: 'Nieznany argument (oczekiwano --code / --role / --workspace).' };
    }
    if (eq !== -1) {
      values[key] = arg.slice(eq + 1);
      continue;
    }
    i += 1;
    if (i >= argv.length) {
      return { ok: false, reason: 'Brak wartości dla ostatniego argumentu.' };
    }
    values[key] = argv[i];
  }
  // Workspace czytany w MOMENCIE wywołania (wzorzec env-loader.mjs) — env żyjącego
  // procesu bywa nieświeże, a instalator ustawia CLAUDE_CRON_WORKSPACE tuż przed nami.
  const workspace = values.workspace || env.CLAUDE_CRON_WORKSPACE || '';
  if (!values.code) {
    return { ok: false, reason: 'Brak kodu zaproszenia (--code).' };
  }
  // Dziedzina zamknięta: seed porównuje rolę przez strict equality, więc `Agent`/`agent\n`
  // po cichu zdegradowałyby maszynę do klienta. Odrzucamy na wejściu zamiast zapisać śmieć.
  if (!isValidRole(values.role)) {
    return { ok: false, reason: 'Rola musi być dokładnie „agent" albo „client" (--role).' };
  }
  if (!workspace) {
    return { ok: false, reason: 'Brak workspace (--workspace ani CLAUDE_CRON_WORKSPACE).' };
  }
  return { ok: true, code: values.code, role: values.role, workspace };
}

// === Pure helper: usuń token z tekstu przeznaczonego dla człowieka ===
// Część trybów awarii undici osadza w komunikacie pełny URL żądania, a token siedzi
// w ŚCIEŻCE (`/inbox/v1/:token/ping`) — surowy `reason` wypisany do logu instalacji
// oddałby sekret każdemu, kto ten log zobaczy.
export function redactToken(text, token) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  return token ? raw.split(token).join('***') : raw;
}

// === Pure helper: czy ten plik został odpalony wprost (a nie zaimportowany) ===
// realpath po OBU stronach — macOS symlinkuje `/tmp` i `/var` do `/private/*`, więc gołe
// porównanie ścieżek cicho blokuje main() (udokumentowana pułapka).
export function isEntryPoint(argvPath, moduleUrl) {
  if (typeof argvPath !== 'string' || argvPath.length === 0) return false;
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function setRoleInState(role) {
  db.setState(ROLE_STATE_KEY, role);
}

function describeGuardRefusal(guard) {
  if (guard.status === 'unknown') {
    return `[warn] Nie zapisano konfiguracji skrzynki: nie udało się ustalić, czy ${guard.gitignoreFile} chroni plik .env `
      + '(git niedostępny albo zwrócił błąd). Sprawdź instalację gita lub uprawnienia do repozytorium i uruchom onboarding ponownie.';
  }
  return `[warn] Nie zapisano konfiguracji skrzynki: git opublikowałby plik .env z tokenem. Wzorzec „${GITIGNORE_PATTERN}" `
    + `jest już w ${guard.gitignoreFile}, a mimo to git go nie ignoruje — sprawdź reguły negacji (np. „!.env"), wzorce `
    + 'z katalogu nadrzędnego i czy .env nie jest już śledzony (git rm --cached .env). Potem uruchom onboarding ponownie.';
}

// === Sekwencja onboardingu: parse → probe → guard .gitignore → .env → rola ===
// NIGDY nie rzuca (wzorzec notify-push) — zwraca { exitCode, message }.
// Kolejność jest bezpieczeństwem, nie estetyką: probe waliduje kod ZANIM dotkniemy plików,
// guard stoi PRZED zapisem (po zapisie sekret już leży w katalogu i cofnięcie go z historii
// gita bywa niemożliwe), a rola ląduje w state dopiero PO udanym zapisie `.env` — inaczej
// seed utworzyłby na tej maszynie joba auto-reply bez konfiguracji, failującego co minutę.
// Zależności wstrzykiwalne, bo probe i guard sięgają do świata zewnętrznego (hub, git).
export async function runOnboard({ code, role, workspace }, deps = {}) {
  const probe = deps.probe || probeInviteCode;
  const ensureIgnored = deps.ensureIgnored || ensureEnvIgnored;
  const writeEnv = deps.writeEnv || writeInboxEnv;
  const setRole = deps.setRole || setRoleInState;

  const parsed = parseInviteCode(code);
  if (!parsed) {
    return {
      exitCode: EXIT.BAD_CODE,
      message: '[warn] Nieprawidłowy kod zaproszenia (oczekiwano „puls-inbox:<url>#<token>") — nie zapisano konfiguracji.',
    };
  }

  const result = await probe(parsed.hubUrl, parsed.token);
  if (!result.ok) {
    return {
      exitCode: EXIT.HUB,
      message: `[warn] Hub skrzynki nie odpowiedział poprawnie (${redactToken(result.reason, parsed.token)}) — nie zapisano konfiguracji.`,
    };
  }

  const guard = ensureIgnored(workspace);
  // `unknown` traktujemy jak `unfixable`: guard, który nie potrafi POTWIERDZIĆ bezpieczeństwa,
  // odmawia zapisu. Brak konfiguracji to jedno pytanie przy ponownym uruchomieniu; token
  // w historii repozytorium to rotacja dostępu całego członka.
  if (guard.status === 'unfixable' || guard.status === 'unknown') {
    return { exitCode: EXIT.GITIGNORE, message: describeGuardRefusal(guard) };
  }

  let envFile;
  try {
    envFile = writeEnv(workspace, parsed.hubUrl, parsed.token);
  } catch (error) {
    return {
      exitCode: EXIT.WRITE,
      message: `[error] Nie udało się zapisać konfiguracji skrzynki: ${redactToken(error.message, parsed.token)}`,
    };
  }
  try {
    setRole(role);
  } catch (error) {
    return {
      exitCode: EXIT.WRITE,
      message: `[error] Zapisano ${envFile}, ale nie udało się zapisać roli maszyny: ${redactToken(error.message, parsed.token)}`,
    };
  }

  const fixedNote = guard.status === 'fixed'
    ? ` Do ${guard.gitignoreFile} dopisano „${GITIGNORE_PATTERN}", żeby sekret nie trafił do repozytorium.`
    : '';
  return {
    exitCode: EXIT.OK,
    message: `[ok] Skrzynka zespołowa połączona jako „${result.user}" (rola maszyny: ${role}) — konfiguracja w ${envFile}.${fixedNote}`,
  };
}

// === I/O shell: argv → jedna linia dla człowieka + kod wyjścia dla bash-a ===
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (!args.ok) {
    console.log(`[error] ${args.reason} ${USAGE}`);
    return EXIT.BAD_USAGE;
  }
  // Sprawdzamy istnienie workspace'u tutaj, żeby literówka w ścieżce nie przebrała się
  // za „git nie odpowiedział" (guard na nieistniejącym katalogu zwraca `unknown`).
  if (!fs.existsSync(args.workspace)) {
    console.log(`[error] Folder workspace nie istnieje: ${args.workspace}`);
    return EXIT.BAD_USAGE;
  }
  const { exitCode, message } = await runOnboard(args);
  console.log(message);
  return exitCode;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main()
    .then((exitCode) => { process.exit(exitCode); })
    .catch((error) => {
      console.log(`[error] Onboarding skrzynki padł nieoczekiwanie: ${error.message}`);
      process.exit(1);
    });
}
