#!/usr/bin/env node
// Classroom sync → repo zespołu (aibiz-classroom)
// Pełny re-pull Classroom ze Skool do repo + git push. Deterministyczny, bez LLM.
// Uruchamiany jako claude-cron script-job (node <ten plik>). Wymaga żywej sesji Skool w dev-browser.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const REPO = join(HOME, 'Documents/Kodowanie/aibiz-classroom');
const CLASSROOM_DIR = join(REPO, 'Classroom');
const ORCHESTRATOR = join(HOME, '.claude/skills/akademia-classroom-sync/scripts/orchestrator.py');
const today = new Date().toISOString().slice(0, 10);

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  return r.status;
}

// 1. Pełny re-pull całego Classroom do repo (fetch all = stan 1:1 ze Skool, omija duplikaty przy przenumerowaniu)
console.log(`[classroom-sync] ${today} — fetch all → ${CLASSROOM_DIR}`);
const fetchStatus = run('python3', [ORCHESTRATOR, 'fetch', 'all'], {
  env: { ...process.env, CLASSROOM_OUTPUT_DIR: CLASSROOM_DIR },
});
if (fetchStatus !== 0) {
  console.error(`[classroom-sync] fetch all zwrócił ${fetchStatus} — przerywam, repo nietknięte`);
  process.exit(1);
}

// 2. Commit + push tylko jeśli są zmiany
const diff = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
if (!diff.stdout.trim()) {
  console.log('[classroom-sync] brak zmian — nic do commitu, koniec ✅');
  process.exit(0);
}

run('git', ['add', '-A'], { cwd: REPO });
const commitStatus = run('git', ['commit', '-m', `sync Classroom ${today}`], { cwd: REPO });
if (commitStatus !== 0) {
  console.error('[classroom-sync] commit nieudany');
  process.exit(1);
}
const pushStatus = run('git', ['push'], { cwd: REPO });
if (pushStatus !== 0) {
  console.error('[classroom-sync] push nieudany — commit lokalny zrobiony, repo zdalne NIE zaktualizowane');
  process.exit(1);
}

console.log(`[classroom-sync] ${today} — sync + push OK ✅`);
process.exit(0);
