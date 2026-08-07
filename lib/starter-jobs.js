const fs = require('node:fs');
const path = require('node:path');

const db = require('./db');
const { getAllSkills } = require('./skills');

const TEMPLATES_FILE = path.join(__dirname, '..', 'templates', 'starter-jobs.json');

// Powody pominięcia szablonu — stały kontrakt dla raportu w setupie.
const SKIP_REASON = {
  EXISTS: 'exists',
  MISSING_SKILL: 'missing_skill',
  // Boot-seed: task był już kiedyś zaseedowany na tej maszynie i go nie ma = user go
  // skasował; nie wskrzeszamy (sentinel w state, patrz computeStarterBootPlan).
  ALREADY_SEEDED: 'already_seeded',
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
    // Script-joby (job_type: 'script') nie mają skilla — odpalają `node <command>`, więc
    // sprawdzanie dostępności skilla wyrzucałoby je z seedu zawsze (missing_skill dla `undefined`).
    if (def.job_type !== 'script' && !skillNames.has(def.skill_name)) {
      skipped.push({ name: def.name, reason: SKIP_REASON.MISSING_SKILL });
      continue;
    }
    toSeed.push(def);
  }
  return { toSeed, skipped };
}

// Szablony script-jobów trzymają `command` WZGLĘDNY wobec katalogu instalacji — ścieżka
// absolutna w JSON-ie byłaby przypisana do maszyny autora. Rozwiązujemy przy odczycie,
// tak jak inbox-seed składa ścieżkę z `repoRoot`.
function loadStarterJobDefs(repoRoot = path.join(__dirname, '..')) {
  const defs = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
  return defs.map((def) =>
    def.command && !path.isAbsolute(def.command)
      ? { ...def, command: path.join(repoRoot, def.command) }
      : def,
  );
}

// Skill jest „dostępny" gdy pasuje po name LUB dir_name — lustrzane wobec
// lib/skills.getSkill(), a executor woła prompt `/${skill_name}` (slash = dir/name).
function listAvailableSkillNames() {
  return getAllSkills().flatMap((skill) => [skill.name, skill.dir_name]);
}

// Sentinel per SZABLON w state: „ten task był już na tej maszynie zaseedowany".
// Rozstrzyga jedyną trudność seedu przy boocie: skasowany przez usera job nie może wracać
// co restart (to byłby backfill-clobber z learned pattern), ale NOWY szablon dołożony
// w aktualizacji MA się pojawić bez re-instalacji. Sentinel = seed najwyżej RAZ per task
// per maszyna; od tego momentu obecność joba jest wyłącznie decyzją usera.
const SENTINEL_PREFIX = 'starter_seeded:';

function sentinelKey(name) {
  return SENTINEL_PREFIX + name;
}

// Pure: plan seedu przy boocie. Wejście jak computeStarterJobsToSeed + zbiór nazw już
// zaseedowanych (sentinele). Zwraca dodatkowo `toMark` — joby istniejące bez sentinela
// (instalacje sprzed tego mechanizmu): dostają sentinel bez tworzenia, żeby ich PÓŹNIEJSZE
// skasowanie przez usera było ostateczne.
function computeStarterBootPlan(defs, existingJobs, availableSkillNames, seededNames) {
  const existingNames = new Set(existingJobs.map((job) => job.name));
  const skillNames = new Set(availableSkillNames);

  const toSeed = [];
  const toMark = [];
  const skipped = [];
  for (const def of defs) {
    if (existingNames.has(def.name)) {
      if (!seededNames.has(def.name)) toMark.push(def.name);
      skipped.push({ name: def.name, reason: SKIP_REASON.EXISTS });
      continue;
    }
    if (seededNames.has(def.name)) {
      // Był zaseedowany i go nie ma = user go skasował. Decyzja usera jest ostateczna.
      skipped.push({ name: def.name, reason: SKIP_REASON.ALREADY_SEEDED });
      continue;
    }
    // Brak skilla = pomiń BEZ sentinela — skill może dojść później (plugin, vault)
    // i wtedy task zaseeduje się przy kolejnym boocie.
    if (def.job_type !== 'script' && !skillNames.has(def.skill_name)) {
      skipped.push({ name: def.name, reason: SKIP_REASON.MISSING_SKILL });
      continue;
    }
    toSeed.push(def);
  }
  return { toSeed, toMark, skipped };
}

// Skorupa I/O: czyta szablony z JSON, skanuje dostępne skille i tworzy joby przez
// db.createJob. Argumenty nadpisywalne dla testów (DI); domyślnie produkcyjne źródła.
// Zwraca { added: [name], skipped: [{name, reason}] }.
// Zapisuje sentinele (added + istniejące) — seed w setupie liczy się tak samo jak przy boocie.
function seedStarterJobs({
  defs = loadStarterJobDefs(),
  availableSkillNames = listAvailableSkillNames(),
} = {}) {
  const { toSeed, skipped } = computeStarterJobsToSeed(defs, db.getAllJobs(), availableSkillNames);

  const added = [];
  for (const def of toSeed) {
    db.createJob(def);
    db.setState(sentinelKey(def.name), '1');
    added.push(def.name);
  }
  for (const skip of skipped) {
    if (skip.reason === SKIP_REASON.EXISTS) db.setState(sentinelKey(skip.name), '1');
  }
  return { added, skipped };
}

// Seed przy starcie DAEMONA (nie tylko w setupie) — „aktualizacje i instalacje pilnują
// podstawowych tasków" (decyzja Kacpra 07.08): aktualizacja przyciskiem/pullem nie odpala
// setup.mjs, więc bez tego nowe starter-taski docierały wyłącznie do świeżych instalacji.
// Gate na rolę `agent` (VPS/hub): starter-taski piszą do vaulta (Dashboard.md) — druga
// maszyna robiąca to samo pod Obsidian Sync to ta sama klasa awarii co konflikt sync/agent.
// Wyłącznie createJob + sentinel, nigdy update — patrz computeStarterBootPlan.
function seedStarterJobsAtBoot({
  defs = loadStarterJobDefs(),
  availableSkillNames = listAvailableSkillNames(),
  role = db.getState('inbox_role'),
  onJobCreated = null,
} = {}) {
  if (role === 'agent') {
    // Egzekwowanie niezmiennika przy KAŻDYM boocie (wzorzec enforceRoleExclusivity):
    // instalator VPS seeduje startery przy pierwszym starcie daemona, ZANIM onboarding
    // ustawi rolę — więc na agencie potrafią istnieć włączone joby piszące do vaulta
    // (incydent srv1362522 07.08). Wyłączamy, nigdy nie kasujemy; ręczne wyłączenia
    // pozostają nietknięte (updateJob tylko dla enabled=1).
    const templateNames = new Set(defs.map((d) => d.name));
    const disabled = [];
    for (const job of db.getAllJobs()) {
      if (!templateNames.has(job.name) || !job.enabled) continue;
      db.updateJob(job.id, { enabled: 0 });
      disabled.push(job.name);
    }
    if (disabled.length > 0) {
      console.error(
        `[starter-jobs] ⚠️ Rola maszyny to "agent", a startery [${disabled.join(', ')}] były WŁĄCZONE — wyłączam. ` +
          'Starter-taski piszą do vaulta (Dashboard.md), a druga maszyna robiąca to samo pod Obsidian Sync ' +
          'to ta sama klasa awarii co konflikt sync/agent (uszkodzony plik, incydent 06.08).'
      );
    }
    return { gated: 'agent', disabled, added: [], marked: [], skipped: [] };
  }

  const seededNames = new Set(defs.map((d) => d.name).filter((name) => db.getState(sentinelKey(name))));
  const { toSeed, toMark, skipped } = computeStarterBootPlan(defs, db.getAllJobs(), availableSkillNames, seededNames);

  const added = [];
  for (const def of toSeed) {
    db.createJob(def);
    db.setState(sentinelKey(def.name), '1');
    added.push(def.name);
  }
  for (const name of toMark) db.setState(sentinelKey(name), '1');

  // Ten sam wzorzec co inbox-seed: świeży job musi trafić do croner-a działającego procesu,
  // a pad haka nie może zabrać ze sobą seedu (job JEST już w bazie).
  if (added.length > 0 && typeof onJobCreated === 'function') {
    try {
      onJobCreated();
    } catch (err) {
      console.error(`[starter-jobs] Hak po seedzie rzucił: ${err.message}`);
    }
  }
  return { gated: null, added, marked: toMark, skipped };
}

module.exports = {
  SKIP_REASON,
  computeStarterJobsToSeed,
  computeStarterBootPlan,
  loadStarterJobDefs,
  seedStarterJobs,
  seedStarterJobsAtBoot,
};
