#!/usr/bin/env node
// Team OS — diagnostyka skrzynki („czemu nie ma Skrzynka.md?").
//
// Jeden przebieg, jeden raport do skopiowania. Powstał, bo najczęstsza awaria instalacji jest
// CICHA: seed joba skrzynki wymaga env (`CLAUDE_CRON_WORKSPACE` + sekret), a gdy go brakuje,
// `seedInboxSyncJob` zwraca 'not_configured' bez słowa w logach — user widzi zdrowy panel,
// pusty vault i nie ma czego wkleić osobie, która ma mu pomóc.
//
// Kontrakt: NIGDY nie wypisuje wartości sekretów (token, hasła) — same nazwy kluczy i
// werdykty. Raport jedzie na Discorda/do wiadomości, więc musi być bezpieczny do wklejenia.
// Nigdy nie rzuca i zawsze kończy się kodem 0: to narzędzie diagnostyczne, a nie kolejny
// element, który może paść i zostawić człowieka bez odpowiedzi.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './env-loader.mjs';

const require = createRequire(import.meta.url);
const REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const OK = '[ok]';
const BAD = '[!!]';
const INFO = '[..]';

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// Same NAZWY kluczy z pliku sekretu — nigdy wartości.
async function readEnvKeys(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.match(/^([A-Z_][A-Z0-9_]*)=/))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch {
    return null;
  }
}

// === Pure helper: wiersze raportu z zebranych faktów ===
// Wydzielone od I/O, żeby dało się testować werdykty bez stawiania instalacji.
export function renderReport(facts) {
  const lines = ['=== Team OS — diagnostyka skrzynki ===', ''];
  const say = (mark, text) => lines.push(`${mark} ${text}`);

  say(INFO, `Katalog instalacji: ${facts.repoDir}`);
  say(INFO, `System: ${facts.platform}`);

  if (facts.secretKeys === null) {
    say(BAD, `Brak pliku sekretu (${facts.secretFile}) — onboarding skrzynki nie przeszedł.`);
  } else {
    say(OK, `Plik sekretu istnieje, klucze: ${facts.secretKeys.join(', ') || '(pusty)'}`);
  }

  if (facts.workspace) {
    say(OK, `Workspace: ${facts.workspace}`);
  } else {
    say(BAD, 'Brak CLAUDE_CRON_WORKSPACE w środowisku TEGO procesu — bez niego job skrzynki NIE powstaje.');
  }
  if (facts.workspacePersisted && facts.workspacePersisted !== facts.workspace) {
    say(BAD, `Rozjazd: w konfiguracji zapisano „${facts.workspacePersisted}", proces widzi „${facts.workspace || '(brak)'}" — zrestartuj komputer, żeby procesy wzięły nowe zmienne.`);
  }

  if (facts.envError) {
    say(BAD, `Konfiguracja skrzynki nieczytelna: ${facts.envError}`);
  } else if (facts.hubConfigured) {
    say(OK, 'Adres huba i token rozwiązane poprawnie.');
  } else {
    say(BAD, 'Adres huba lub token nierozwiązane — job skrzynki nie powstanie.');
  }

  say(INFO, `Rola tej maszyny: ${facts.role || '(nie ustawiona)'}`);

  if (facts.job) {
    const state = facts.job.enabled ? 'włączony' : 'WYŁĄCZONY';
    say(facts.job.enabled ? OK : BAD, `Job „${facts.job.name}" istnieje (${state}, harmonogram: ${facts.job.cron_expr}).`);
    say(INFO, `Ostatni przebieg: ${facts.lastRun || '(jeszcze żadnego)'}`);
  } else {
    say(BAD, `Joba „${facts.expectedJobName}" NIE MA w bazie — dlatego nikt nie tworzy pliku Skrzynki.`);
  }

  if (facts.skrzynkaPath) {
    say(facts.skrzynkaExists ? OK : BAD, `Plik Skrzynki: ${facts.skrzynkaPath} — ${facts.skrzynkaExists ? 'jest' : 'BRAK'}`);
  }

  say(INFO, `Wersja instalacji: ${facts.revision || 'unknown'}`);

  lines.push('', '--- co z tym zrobić ---');
  for (const hint of buildHints(facts)) lines.push(`* ${hint}`);
  return lines.join('\n');
}

// === Pure helper: fakty → kroki naprawcze (kolejność = priorytet) ===
export function buildHints(facts) {
  const hints = [];
  if (facts.secretKeys === null) {
    hints.push('Uruchom instalator ponownie i wklej kod zaproszenia do skrzynki.');
  }
  if (!facts.workspace || (facts.workspacePersisted && facts.workspacePersisted !== facts.workspace)) {
    hints.push('Zrestartuj komputer (nie tylko terminal) — zmienne środowiskowe wchodzą do procesów dopiero po ponownym zalogowaniu.');
  }
  if (facts.workspace && facts.hubConfigured && !facts.job) {
    hints.push('Zrestartuj daemona Pulsa — job skrzynki powstaje przy jego starcie.');
  }
  if (facts.job && !facts.job.enabled) {
    hints.push('Włącz job w panelu Pulsa (widok Zadania) — jest, ale wyłączony.');
  }
  if (hints.length === 0) {
    hints.push('Konfiguracja wygląda poprawnie. Jeśli Skrzynki nadal nie ma, wklej ten raport osobie, która pomaga Ci z instalacją.');
  }
  return hints;
}

async function collectFacts() {
  const facts = {
    repoDir: REPO_DIR,
    platform: `${os.platform()} ${os.release()}`,
    secretFile: process.env.INBOX_ENV_FILE || path.join(REPO_DIR, 'data', 'inbox.env'),
    secretKeys: null,
    workspace: null,
    workspacePersisted: null,
    hubConfigured: false,
    envError: null,
    role: null,
    job: null,
    lastRun: null,
    expectedJobName: '',
    skrzynkaPath: null,
    skrzynkaExists: false,
    revision: null,
  };

  facts.secretKeys = await readEnvKeys(facts.secretFile);

  try {
    const { readPersistedEnv } = require('../../lib/persisted-env');
    facts.workspacePersisted = readPersistedEnv('CLAUDE_CRON_WORKSPACE');
  } catch {
    facts.workspacePersisted = null;
  }

  // Ta sama ścieżka, którą idzie seed joba — dlatego jej błąd jest tu odpowiedzią,
  // a nie awarią narzędzia.
  try {
    await loadEnv();
    facts.hubConfigured = Boolean(process.env.INBOX_HUB_URL && process.env.INBOX_TOKEN);
  } catch (error) {
    facts.envError = error.message;
  }
  facts.workspace = process.env.CLAUDE_CRON_WORKSPACE || null;
  facts.skrzynkaPath = process.env.INBOX_SKRZYNKA_PATH
    || (facts.workspace ? path.join(facts.workspace, 'Zadania', 'Skrzynka.md') : null);
  if (facts.skrzynkaPath) facts.skrzynkaExists = await exists(facts.skrzynkaPath);

  try {
    const db = require('../../lib/db');
    const seed = require('../../lib/inbox-seed');
    facts.role = db.getState(seed.ROLE_STATE_KEY);
    facts.expectedJobName = facts.role === 'agent' ? seed.ASSISTANT_JOB_NAME : seed.JOB_NAME;
    facts.job = db.getAllJobs().find((job) => job.name === facts.expectedJobName) || null;
    if (facts.job) {
      const runs = db.getRuns({ limit: 1, job_id: facts.job.id });
      const run = runs && runs[0];
      if (run) facts.lastRun = `${run.started_at} → ${run.status}`;
    }
  } catch (error) {
    facts.envError = facts.envError || `baza Pulsa nieczytelna: ${error.message}`;
  }

  try {
    facts.revision = require('../../lib/version.js').getInstallVersion().revision;
  } catch {
    facts.revision = null;
  }

  return facts;
}

async function main() {
  console.log(renderReport(await collectFacts()));
}

if (process.argv[1]) {
  const { realpathSync } = require('node:fs');
  const modulePath = fileURLToPath(import.meta.url);
  let isEntry = false;
  try {
    isEntry = realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    isEntry = path.resolve(process.argv[1]) === modulePath;
  }
  // Diagnostyka nigdy nie kończy się błędem: raport ma dotrzeć nawet gdy instalacja leży.
  if (isEntry) main().catch((error) => console.log(`${BAD} Diagnostyka padła: ${error.message}`));
}
