#!/usr/bin/env node
// Team OS — inbox sync (push + pull sekwencyjnie w jednym procesie)
// Eliminuje race condition: user odhacza [x] → push czyta plik i UPDATE'uje DB → pull regeneruje plik z DB.
// Wszystko w jednym procesie, bez okna gdzie pull mógłby nadpisać akcję usera.

import { main as runPush } from './inbox-push.mjs';
import { main as runPull } from './inbox-pull.mjs';

async function main() {
  // 1. PUSH najpierw — zaktualizuj DB ze stanu pliku (odhaczone checkboxy → status=done + archive)
  try {
    await runPush();
  } catch (e) {
    console.error('[inbox-sync] push FAILED:', e.message);
    // Kontynuujemy do pull — lepiej mieć stary stan w pliku niż nic
  }

  // 2. PULL — regeneruj Skrzynkę z DB (rekordy ze status=done już nie są renderowane)
  await runPull();
}

main().catch(e => { console.error('[inbox-sync] FATAL:', e.message); process.exit(1); });
