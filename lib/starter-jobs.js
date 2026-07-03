const fs = require('node:fs');
const path = require('node:path');

const db = require('./db');
const { getAllSkills } = require('./skills');

const TEMPLATES_FILE = path.join(__dirname, '..', 'templates', 'starter-jobs.json');

// Powody pominięcia szablonu — stały kontrakt dla raportu w setupie.
const SKIP_REASON = {
  EXISTS: 'exists',
  MISSING_SKILL: 'missing_skill',
};

// Pure: dzieli definicje szablonów na te do seedu i pominięte (z powodem).
// Bez I/O — istniejące joby i dostępne skille wchodzą argumentami (wzorzec computeMissedJobs).
// Idempotencja po `name`: job o tej samej nazwie w bazie = pominięty, bez sentinela w state —
// user może świadomie usunąć taska, ale re-run setupu z odpowiedzią „T" przywróci go (opt-in).
function computeStarterJobsToSeed(defs, existingJobs, availableSkillNames) {
  const existingNames = new Set(existingJobs.map((job) => job.name));
  const skillNames = new Set(availableSkillNames);

  const toSeed = [];
  const skipped = [];
  for (const def of defs) {
    if (existingNames.has(def.name)) {
      skipped.push({ name: def.name, reason: SKIP_REASON.EXISTS });
      continue;
    }
    if (!skillNames.has(def.skill_name)) {
      skipped.push({ name: def.name, reason: SKIP_REASON.MISSING_SKILL });
      continue;
    }
    toSeed.push(def);
  }
  return { toSeed, skipped };
}

function loadStarterJobDefs() {
  return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
}

// Skill jest „dostępny" gdy pasuje po name LUB dir_name — lustrzane wobec
// lib/skills.getSkill(), a executor woła prompt `/${skill_name}` (slash = dir/name).
function listAvailableSkillNames() {
  return getAllSkills().flatMap((skill) => [skill.name, skill.dir_name]);
}

// Skorupa I/O: czyta szablony z JSON, skanuje dostępne skille i tworzy joby przez
// db.createJob. Argumenty nadpisywalne dla testów (DI); domyślnie produkcyjne źródła.
// Zwraca { added: [name], skipped: [{name, reason}] }.
function seedStarterJobs({
  defs = loadStarterJobDefs(),
  availableSkillNames = listAvailableSkillNames(),
} = {}) {
  const { toSeed, skipped } = computeStarterJobsToSeed(defs, db.getAllJobs(), availableSkillNames);

  const added = [];
  for (const def of toSeed) {
    db.createJob(def);
    added.push(def.name);
  }
  return { added, skipped };
}

module.exports = {
  SKIP_REASON,
  computeStarterJobsToSeed,
  loadStarterJobDefs,
  seedStarterJobs,
};
