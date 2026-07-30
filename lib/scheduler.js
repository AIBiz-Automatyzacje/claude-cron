const { Cron } = require('croner');
const db = require('./db');
const executor = require('./executor');
const { HEARTBEAT_INTERVAL_MS } = require('./config');

const activeJobs = new Map(); // jobId -> Cron instance
let queueProcessing = false;
let heartbeatInterval = null;

// === Klasyfikacja krótki/długi (R3) ===

// Próg podziału: mediana czasu ostatnich udanych runów < 60 s = zadanie krótkie.
// Rozkład czasów w systemie jest bimodalny (0–18 s ‖ 115–747 s), więc dokładna wartość
// progu nie zmienia podziału — 60 s leży w pustce między skupiskami.
const FAST_THRESHOLD_MS = 60_000;

// Ile ostatnich UDANYCH runów bierzemy do mediany. Timeout mówi o limicie, nie o pracy.
const DURATION_SAMPLE_SIZE = 10;

const MAX_CONCURRENT_STATE_KEY = 'max_concurrent';
// Nie „ile wlezie": limit planu Claude jest wspólny dla wszystkich procesów, więc
// równoległość nie tworzy przepustowości — przyspiesza zużycie okna. 3 = 2 długie + rezerwa.
const DEFAULT_MAX_CONCURRENT = 3;

// Pure. Mediana, NIE średnia: inbox sync ma typowo 0,2 s przy pojedynczych próbkach rzędu
// 975 s (sen maszyny) — średnia wrzuciłaby najlżejszy job systemu do długich.
// Pusta historia → 'long' (fail-safe): pomyłka „nowy uznany za krótki, a jest 12-minutowy"
// zjada slot rezerwowy i łamie R1; odwrotna kosztuje jedno opóźnione uruchomienie.
// Granica domknięta w dół — wartość dokładnie na progu jest jeszcze długa.
function classifyJob(durations, thresholdMs = FAST_THRESHOLD_MS) {
  if (!Array.isArray(durations) || durations.length === 0) return 'long';
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return median < thresholdMs ? 'short' : 'long';
}

// Pure. Klucze wyłączności joba: ten sam skill albo ten sam skrypt = rozłączenie
// AUTOMATYCZNE (bez deklaracji), lock_group = rozłączenie deklaratywne (R5).
// Puste wartości NIE są kluczami — inaczej wszystkie script-joby (skill_name '')
// zablokowałyby się nawzajem.
function exclusionKeys(job) {
  if (!job) return [];
  const keys = [];
  if (job.skill_name && job.skill_name.trim()) keys.push(`skill:${job.skill_name.trim()}`);
  if (job.command && job.command.trim()) keys.push(`command:${job.command.trim()}`);
  if (job.lock_group && job.lock_group.trim()) keys.push(`lock:${job.lock_group.trim()}`);
  return keys;
}

// Pure. Sanityzacja limitu współbieżności — wartość przychodzi ze `state` (edytowalna
// z dashboardu), więc każdy śmieć musi degradować się do wartości domyślnej, nie do 0
// (limit 0 zatrzymałby cały scheduler bez żadnego komunikatu).
function resolveMaxConcurrent(rawValue) {
  const parsed = parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_CONCURRENT;
}

// Odczyt limitu ze `state` — świadomie NIE cache'owany: rozwiązywany w czasie użycia
// (wzorzec notify-config.js), żeby zmiana z dashboardu działała bez restartu daemona.
function readMaxConcurrent() {
  return resolveMaxConcurrent(db.getState(MAX_CONCURRENT_STATE_KEY));
}

// Sufit wartości przyjmowanej z API. Nie jest własnością mechanizmu (picker poradzi sobie
// z każdą liczbą), tylko bramką sanity: limit planu Claude jest wspólny dla wszystkich
// procesów, więc 50 równoległych agentów nie tworzy przepustowości — wypala okno i pamięć.
const MAX_CONCURRENT_CEILING = 10;

// Pure. Walidacja WEJŚCIA z API — inaczej niż resolveMaxConcurrent (odczyt ze `state`,
// ciche zejście do wartości domyślnej). Tu śmieć MUSI zostać odrzucony z komunikatem:
// user, który wpisał „pięć", ma zobaczyć błąd zamiast cichego 3.
// parseInt świadomie NIEUŻYWANY do rozpoznania kształtu — zjadłby ogon i przyjął "5x".
function sanitizeMaxConcurrent(rawValue) {
  const isNumber = typeof rawValue === 'number' && Number.isInteger(rawValue);
  // String cyfr jest legalnym wejściem: dashboard wysyła wartość z <input>.
  const isDigits = typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim());
  if (!isNumber && !isDigits) {
    return { ok: false, error: 'max_concurrent musi być liczbą całkowitą' };
  }

  const value = isNumber ? rawValue : parseInt(rawValue.trim(), 10);
  if (value < 1 || value > MAX_CONCURRENT_CEILING) {
    return { ok: false, error: `max_concurrent musi być z zakresu 1–${MAX_CONCURRENT_CEILING}` };
  }
  return { ok: true, value };
}

// === Picker (pure, R1/R2/R4/R5) ===

// Pure: co startować TERAZ. Zero I/O i zero Date.now() — wzorzec computeMissedJobs.
// Reguły w kolejności: globalny limit → budżet długich (rezerwa dla krótkich) →
// jeden run per job → wyłączność skill/command → wyłączność lock_group.
function pickEligibleRuns({
  queued = [],
  jobsById = {},
  activeRuns = [],
  // Joby, których proces już zdechł, ale run nie jest jeszcze rozliczony (finalizacja
  // statusu + retry-check). NIE zajmują slotu — proces nie żyje, więc trzymanie slotu
  // byłoby cichym obniżeniem limitu — ale blokują KOLEJNY run tego samego joba, żeby
  // retry-check nie liczył failów przy już biegnącej powtórce.
  finalizingJobIds = [],
  durationsByJob = {},
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  fastThresholdMs = FAST_THRESHOLD_MS,
} = {}) {
  const limit = resolveMaxConcurrent(maxConcurrent);
  // Zadania długie nie mogą zająć OSTATNIEGO slotu — to rezerwa, dzięki której run krótki
  // (inbox sync) nigdy nie czeka za długim (R1). Przy limicie 1 rezerwy nie ma z czego zrobić.
  const longLimit = Math.max(1, limit - 1);
  const classOf = (jobId) => classifyJob(durationsByJob[jobId] || [], fastThresholdMs);

  const busyJobIds = new Set(finalizingJobIds);
  const busyKeys = new Set();
  let used = 0;
  let usedLong = 0;

  for (const active of activeRuns) {
    used++;
    busyJobIds.add(active.jobId);
    for (const key of exclusionKeys(jobsById[active.jobId])) busyKeys.add(key);
    if (classOf(active.jobId) === 'long') usedLong++;
  }

  const picked = [];
  // Skan po id ASC — FIFO w obrębie każdej blokady wychodzi z samego porządku skanu.
  // Sortujemy kopię, żeby kontrakt funkcji nie zależał od ORDER BY po stronie wołającego.
  for (const run of [...queued].sort((a, b) => a.id - b.id)) {
    if (used >= limit) break;

    const job = jobsById[run.job_id];
    // Brak joba (skasowany między odczytami): nie zgadujemy klasy ani blokad — executeRun
    // domknie taki run jako failed, więc puszczamy go dalej zamiast zostawiać w kolejce na wieki.
    const kind = job ? classOf(job.id) : 'long';
    if (kind === 'long' && usedLong >= longLimit) continue;
    if (busyJobIds.has(run.job_id)) continue;

    const keys = exclusionKeys(job);
    if (keys.some((key) => busyKeys.has(key))) continue;

    picked.push(run);
    used++;
    if (kind === 'long') usedLong++;
    busyJobIds.add(run.job_id);
    for (const key of keys) busyKeys.add(key);
  }

  return picked;
}

// === Sygnał nowej pracy („dzwonek") ===

// Pętla drain czeka na Promise.race([...aktywne runy, dzwonek]). Bez dzwonka re-pick
// następowałby dopiero po zakończeniu któregoś runu — inbox sync dokolejkowany o 9:01
// czekałby do 9:14 mimo wolnego slotu, czyli cała równoległość byłaby ozdobą (R1).
let newWorkSignal = null;
// Dzwonek, który zabrzmiał, gdy nikt nie czekał (np. executor zwolnił slot MIĘDZY
// startEligibleRuns a Promise.race). Bez zapamiętania sygnał by przepadł, a wolny slot
// czekałby na domknięcie czyjegoś runu — dokładnie ta cisza, przed którą broni dzwonek.
let newWorkPending = false;

function waitForNewWork() {
  if (newWorkPending) {
    newWorkPending = false;
    return Promise.resolve();
  }
  if (!newWorkSignal) {
    let resolveSignal;
    const promise = new Promise((resolve) => { resolveSignal = resolve; });
    newWorkSignal = { promise, resolve: resolveSignal };
  }
  return newWorkSignal.promise;
}

function ringNewWorkBell() {
  if (!newWorkSignal) {
    newWorkPending = true;
    return;
  }
  const signal = newWorkSignal;
  newWorkSignal = null; // po wybudzeniu kolejne czekanie dostaje ŚWIEŻY sygnał
  signal.resolve();
}

// === Queue ===

// Retry po failu — logika przeniesiona z dawnej pętli BEZ zmian semantycznych.
// Status czytamy ŚWIEŻO z DB: executeRun zapisuje wynik wyłącznie przez db.updateRun
// i NIE mutuje obiektu z getQueuedRuns() (in-memory zostałby 'queued', retry nigdy by
// nie odpaliło i ❌/R9 byłoby martwe). Okno failów = db.countRecentFailedRuns, ta sama
// definicja co executor.notifyRunOutcome — próg „będzie retry / final fail" jest jeden.
function maybeQueueRetry(run) {
  const finished = db.getRunWithPayload(run.id);
  if (!finished || finished.status !== 'failed') return;

  const job = db.getJob(run.job_id);
  if (!job || !job.max_retries || job.max_retries <= 0) return;
  if (db.countRecentFailedRuns(run.job_id, job.max_retries) > job.max_retries) return;

  db.createRun({ job_id: run.job_id, trigger_type: 'retry' });
}

// Aktywne runy dla pickera = widok executora (właściciel cyklu życia procesu — nie
// duplikujemy go) POSZERZONY o nasze runy w locie, które executor JESZCZE zna.
// Wpis oznaczony `released` (executor zwolnił go na 'exit', bo 'close' może nie przyjść
// nigdy — wnuk trzyma pipe) świadomie NIE liczy się do slotu: jego proces nie żyje,
// a trzymanie slotu do 'close' cicho obniżałoby limit współbieżności. Taki run wraca
// osobno jako finalizingJobIds (wyłączność joba na czas retry-checku).
function mergeActiveRuns(executorRuns, inFlight) {
  const byRunId = new Map();
  for (const entry of executorRuns) byRunId.set(entry.runId, { runId: entry.runId, jobId: entry.jobId });
  for (const [runId, entry] of inFlight) {
    if (entry.released) continue;
    byRunId.set(runId, { runId, jobId: entry.jobId });
  }
  return [...byRunId.values()];
}

// Joby runów w locie, których proces już zdechł, ale rozliczenie (status + retry-check) trwa.
function collectFinalizingJobIds(inFlight) {
  const jobIds = [];
  for (const [, entry] of inFlight) {
    if (entry.released) jobIds.push(entry.jobId);
  }
  return jobIds;
}

// Run, który nie doszedł nawet do zapisania wyniku, MUSI opuścić kolejkę. Bez tego zostaje
// 'queued', picker wybiera go w następnej iteracji natychmiast, a pętla drain kręci się na
// samych rozstrzygniętych obietnicach — nie oddaje kontroli do fazy timerów, więc razem
// z nią zamarza heartbeat, cron i HTTP serwera (livelock, nie pojedynczy padnięty run).
function failRunAfterCrash(run, err, ctx) {
  try {
    db.updateRun(run.id, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_msg: `Scheduler: ${err.message}`,
    });
  } catch (dbErr) {
    // Nie da się nawet zapisać porażki (np. SQLITE_BUSY) — run zostaje w bazie 'queued',
    // więc pomijamy go do końca TEJ pętli; następne processQueue spróbuje ponownie.
    console.error(`[scheduler] run #${run.id}: nie udało się oznaczyć jako failed: ${dbErr.message}`);
    ctx.skipRunIds.add(run.id);
  }
}

function startRun(run, ctx) {
  const entry = { jobId: run.job_id, released: false, promise: null };
  entry.promise = (async () => {
    try {
      await executor.executeRun(run);
      maybeQueueRetry(run);
    } catch (err) {
      // Pad jednego runu nie może przerwać drainu ani zabić pozostałych aktywnych.
      console.error(`[scheduler] run #${run.id} zakończony błędem: ${err.message}`);
      failRunAfterCrash(run, err, ctx);
    } finally {
      ctx.inFlight.delete(run.id);
    }
  })();
  ctx.inFlight.set(run.id, entry);
}

// I/O — cienka skorupa wokół pickera: zbiera stan, oddaje decyzję czystej funkcji, startuje.
function startEligibleRuns(ctx) {
  const inFlight = ctx.inFlight;
  const queued = db.getQueuedRuns().filter((run) => !ctx.skipRunIds.has(run.id));
  if (queued.length === 0) return;

  const jobsById = {};
  for (const job of db.getAllJobs()) jobsById[job.id] = job;

  const activeRuns = mergeActiveRuns(executor.getActiveRuns(), inFlight);
  const finalizingJobIds = collectFinalizingJobIds(inFlight);

  // Mediany liczone w JS z próbek, nie agregatem SQL (agregaty node:sqlite bywają BigInt).
  const durationsByJob = {};
  for (const jobId of new Set([...activeRuns.map((a) => a.jobId), ...queued.map((r) => r.job_id)])) {
    durationsByJob[jobId] = db.getRecentSuccessDurations(jobId, DURATION_SAMPLE_SIZE);
  }

  const picked = pickEligibleRuns({
    queued,
    jobsById,
    activeRuns,
    finalizingJobIds,
    durationsByJob,
    // Limit czytany w MOMENCIE picku (wzorzec notify-config.js) — zmiana z dashboardu
    // działa bez restartu daemona.
    maxConcurrent: readMaxConcurrent(),
  });

  for (const run of picked) startRun(run, ctx);
}

async function processQueue() {
  // Jedna pętla naraz (współbieżne pętle mnożyłyby retry-check). Wołanie przy pracującej
  // pętli NIE jest no-opem: dzwoni dzwonkiem, więc każdy producent pracy — enqueueJob,
  // webhook w server.js — budzi drain natychmiast, zamiast czekać na koniec czyjegoś runu.
  if (queueProcessing) {
    ringNewWorkBell();
    return;
  }
  queueProcessing = true;

  const ctx = {
    // runId → { jobId, released, promise } — promise żyje tyle, co run + retry-check,
    // `released` mówi, że proces już zdechł (executor oddał slot na 'exit').
    inFlight: new Map(),
    // Runy, których nie udało się nawet rozliczyć jako failed — pomijane do końca pętli.
    skipRunIds: new Set(),
  };

  // Zwolnienie wpisu przez executora budzi pętlę NATYCHMIAST: bez tego wolny slot czekałby
  // na 'close', które przy wnuku trzymającym pipe potrafi nie przyjść nigdy.
  const stopListening = executor.onRunReleased((runId) => {
    const entry = ctx.inFlight.get(runId);
    if (!entry || entry.released) return;
    entry.released = true;
    ringNewWorkBell();
  });

  try {
    while (true) {
      startEligibleRuns(ctx);
      // Nic nie biegnie i nic nie ruszyło → kolejka wyczerpana (albo to, co w niej stoi,
      // jest zablokowane przez run spoza tej pętli — obudzi je kolejne enqueueJob).
      if (ctx.inFlight.size === 0) break;

      const running = [...ctx.inFlight.values()].map((entry) => entry.promise);
      await Promise.race([...running, waitForNewWork()]);
    }
  } finally {
    stopListening();
    queueProcessing = false;
  }
}

function enqueueJob(jobId, triggerType = 'scheduled') {
  const run = db.createRun({ job_id: jobId, trigger_type: triggerType });
  // processQueue albo startuje pętlę, albo — gdy już biegnie — dzwoni dzwonkiem (R1).
  processQueue().catch((err) => console.error('[scheduler] processQueue:', err.message));
  return run;
}

// === Cron scheduling ===

function scheduleJob(job) {
  // Remove existing if re-scheduling
  unscheduleJob(job.id);

  if (!job.enabled || !job.cron_expr) return;

  try {
    const cronJob = new Cron(job.cron_expr, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, () => {
      enqueueJob(job.id, 'scheduled');
    });

    activeJobs.set(job.id, cronJob);
  } catch (err) {
    console.error(`[scheduler] Invalid cron for job ${job.id} "${job.name}": ${err.message}`);
  }
}

function unscheduleJob(jobId) {
  const existing = activeJobs.get(jobId);
  if (existing) {
    existing.stop();
    activeJobs.delete(jobId);
  }
}

function getNextRun(jobId) {
  const cronJob = activeJobs.get(jobId);
  if (!cronJob) return null;
  const next = cronJob.nextRun();
  return next ? next.toISOString() : null;
}

// === Missed job detection ===

// Pure: zwraca id-ki jobów przegapionych podczas downtime'u [lastActive, now).
// Bez I/O i bez new Date() — now/lastActive/timezone wchodzą argumentami, by była unit-testowalna.
// Strefa MUSI być ta sama co w scheduleJob, inaczej granica okna cyklu się rozjeżdża (bug R3).
function computeMissedJobs(jobs, lastActive, now, timezone) {
  const missed = [];

  for (const job of jobs) {
    if (!job.enabled || !job.run_on_wake) continue;

    try {
      const cron = new Cron(job.cron_expr, { timezone });
      // nextRun(fromDate) zwraca pierwszy zaplanowany czas po fromDate.
      // Pojedyncze id (collapse) nawet gdy przegapiono N cykli — liczymy tylko najbliższy.
      const nextFromLast = cron.nextRun(lastActive);
      if (nextFromLast && nextFromLast < now) {
        missed.push(job.id);
      }
    } catch {
      // Skip invalid cron
    }
  }

  return missed;
}

function detectMissedJobs() {
  const lastActive = db.getState('last_active_at');
  if (!lastActive) return;

  const lastDate = new Date(lastActive);
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const jobs = db.getAllJobs();

  const missedIds = computeMissedJobs(jobs, lastDate, now, timezone);
  for (const jobId of missedIds) {
    console.log(`[scheduler] Missed job detected: ${jobId} — enqueueing`);
    enqueueJob(jobId, 'wake');
  }
}

// === Heartbeat ===

function startHeartbeat() {
  db.setState('last_active_at', new Date().toISOString());
  heartbeatInterval = setInterval(() => {
    db.setState('last_active_at', new Date().toISOString());
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// === Retention — czyść stare successful runy script-jobów (zapobiega puchnięciu DB przy job co min) ===

let retentionInterval = null;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000; // co godzinę
const RETENTION_OLDER_THAN_HOURS = 24;

function runRetention() {
  try {
    const deleted = db.deleteOldRoutineRuns(RETENTION_OLDER_THAN_HOURS);
    if (deleted > 0) {
      console.log(`[retention] usunięto ${deleted} starych success runs script-jobów (> ${RETENTION_OLDER_THAN_HOURS}h)`);
    }
  } catch (err) {
    console.error('[retention] błąd:', err.message);
  }
}

function startRetention() {
  runRetention();
  retentionInterval = setInterval(runRetention, RETENTION_INTERVAL_MS);
}

function stopRetention() {
  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
  }
}

// === Init ===

function start() {
  // Detect missed jobs from downtime
  detectMissedJobs();

  // Schedule all enabled jobs
  const jobs = db.getAllJobs();
  for (const job of jobs) {
    scheduleJob(job);
  }

  startHeartbeat();
  startRetention();
  console.log(`[scheduler] Started with ${activeJobs.size} active jobs`);
}

function stop() {
  for (const [id] of activeJobs) {
    unscheduleJob(id);
  }
  stopHeartbeat();
  stopRetention();
}

function rescheduleAll() {
  for (const [id] of activeJobs) {
    unscheduleJob(id);
  }
  const jobs = db.getAllJobs();
  for (const job of jobs) {
    scheduleJob(job);
  }
}

module.exports = {
  start,
  stop,
  scheduleJob,
  unscheduleJob,
  enqueueJob,
  getNextRun,
  rescheduleAll,
  processQueue,
  computeMissedJobs,
  classifyJob,
  pickEligibleRuns,
  resolveMaxConcurrent,
  readMaxConcurrent,
  sanitizeMaxConcurrent,
  FAST_THRESHOLD_MS,
  DEFAULT_MAX_CONCURRENT,
  MAX_CONCURRENT_CEILING,
  MAX_CONCURRENT_STATE_KEY,
};
