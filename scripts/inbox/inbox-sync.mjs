#!/usr/bin/env node
// Team OS — inbox sync (push → pobrania → pull sekwencyjnie w jednym procesie)
// Eliminuje race condition: user odhacza [x] → push czyta plik i UPDATE'uje DB → pull regeneruje plik z DB.
// Wszystko w jednym procesie, bez okna gdzie pull mógłby nadpisać akcję usera.
//
// Krok pobrań siedzi POMIĘDZY nimi z tej samej przesłanki: odhaczone „Pobierz" jest akcją
// wyłącznie lokalną (nie idzie do huba), a jedynym jego stanem jest obecność pliku na dysku.
// Gdyby pull poszedł pierwszy, przerenderowałby wiersz z powrotem na nieodhaczony checkbox
// i zdmuchnąłby żądanie usera, zanim ktokolwiek by je wykonał.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { downloadRequestedAttachments } from './attachments.mjs';
import { loadEnv } from './env-loader.mjs';
import * as inboxClient from './inbox-client.mjs';
import { main as runPull } from './inbox-pull.mjs';
import { main as runPush } from './inbox-push.mjs';

// ESM → CommonJS dla warstwy lib/ (precedens: onboard.mjs, auto-reply.mjs). Samo wymaganie
// modułu NIE otwiera bazy — getDb() jest leniwe, więc koszt ponosimy dopiero przy odczycie roli.
const require = createRequire(import.meta.url);

// Rola maszyny ze stanu Pulsa (state.inbox_role). Brak flagi = zachowanie sprzed ról ('client'),
// tak samo jak w lib/inbox-seed.js — nie zgadujemy roli po platformie. Pad odczytu bazy zwraca
// null, a nie rzuca: sync ma dojechać do pulla nawet wtedy, a maszyna-agent i tak nie ma tego
// joba (pierwsza warstwa R10).
export function readMachineRole() {
  try {
    const db = require('../../lib/db');
    const { ROLE_STATE_KEY } = require('../../lib/inbox-seed');
    return db.getState(ROLE_STATE_KEY) || null;
  } catch (e) {
    console.warn(`[inbox-sync] nie odczytałem roli maszyny: ${e.message}`);
    return null;
  }
}

// client/role wstrzykiwane dla testowalności (mock huba, rola bez dotykania bazy).
export async function main({ client = inboxClient, role } = {}) {
  // 1. PUSH najpierw — zaktualizuj DB ze stanu pliku (odhaczone checkboxy → status=done + archive)
  try {
    await runPush({ client });
  } catch (e) {
    console.error('[inbox-sync] push FAILED:', e.message);
    // Kontynuujemy do pull — lepiej mieć stary stan w pliku niż nic
  }

  // 2. POBRANIA — odhaczone „Pobierz" wykonane lokalnie, zanim pull przerenderuje blok.
  try {
    await loadEnv();
    await downloadRequestedAttachments({
      client,
      role: role === undefined ? readMachineRole() : role,
      skrzynkaPath: process.env.INBOX_SKRZYNKA_PATH,
      attachmentsDir: process.env.INBOX_ATTACHMENTS_DIR,
    });
  } catch (e) {
    console.error('[inbox-sync] pobrania FAILED:', e.message);
    // Kontynuujemy do pull — nieudane pobranie zostawia checkbox, następny sync spróbuje znowu
  }

  // 3. PULL — regeneruj Skrzynkę z DB (rekordy ze status=done już nie są renderowane)
  await runPull({ client });
}

// Odpalamy TYLKO przy uruchomieniu wprost (job Pulsa), nie przy imporcie z testu —
// wzorzec identyczny jak w inbox-push.mjs / inbox-pull.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('[inbox-sync] FATAL:', e.message); process.exit(1); });
}
