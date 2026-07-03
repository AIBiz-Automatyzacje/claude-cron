const { Cron } = require('croner');
const db = require('./db');
const executor = require('./executor');
const { HEARTBEAT_INTERVAL_MS } = require('./config');

const activeJobs = new Map(); // jobId -> Cron instance
let queueProcessing = false;
let heartbeatInterval = null;

// === Queue ===

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  try {
    while (true) {
      if (executor.isRunning()) break;

      const queued = db.getQueuedRuns();
      if (queued.length === 0) break;

      const run = queued[0];
      const job = db.getJob(run.job_id);

      await executor.executeRun(run);

      // Status po runie czytamy ŚWIEŻO z DB — executeRun zapisuje wynik wyłącznie przez
      // db.updateRun i NIE mutuje obiektu z getQueuedRuns() (in-memory zostałby 'queued',
      // retry nigdy by nie odpaliło i ❌/R9 byłoby martwe w domyślnej konfiguracji).
      const finished = db.getRunWithPayload(run.id);

      // Retry on failure if retries remain — okno failów wspólne z executor.notifyRunOutcome
      // (db.countRecentFailedRuns), żeby próg "będzie retry / final fail" był jedną definicją.
      if (finished && finished.status === 'failed' && job && job.max_retries > 0) {
        if (db.countRecentFailedRuns(run.job_id, job.max_retries) <= job.max_retries) {
          db.createRun({ job_id: run.job_id, trigger_type: 'retry' });
        }
      }
    }
  } finally {
    queueProcessing = false;
  }
}

function enqueueJob(jobId, triggerType = 'scheduled') {
  const run = db.createRun({ job_id: jobId, trigger_type: triggerType });
  processQueue();
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
};
