const { spawn, execSync } = require('node:child_process');
const { CLAUDE_BIN, WORKSPACE_DIR, MAX_LOG_SIZE, IDLE_TIMEOUT_MS, WATCHDOG_INTERVAL_MS, IS_MAC, IS_WIN } = require('./config');
const claudeSpawn = require('./claude-spawn');
const db = require('./db');
const discord = require('./discord');
const telegram = require('./telegram');

let currentProcess = null;
let currentRunId = null;

function truncate(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(-max); // Keep the tail (most recent output)
}

// Krok tykania zegara timeoutu. Krótszy niż WATCHDOG_INTERVAL_MS, bo od niego zależy
// dokładność zabicia runu: job z limitem 60 s (inbox sync) przy kroku 30 s ginąłby
// dopiero między 60 a 90 s. 5 s to kompromis — narzut zerowy (interwał żyje tyle,
// co run), a rozjazd względem limitu mieści się w szumie.
const TIMEOUT_TICK_MS = 5_000;

// Luka między tyknięciami, od której uznajemy, że maszyna spała.
//
// Celowo 60 s, a nie „3× interwał" jak w watchdogu idle: zablokowany event loop
// wygląda DOKŁADNIE tak samo jak sen — po odblokowaniu Node odpala zaległe callbacki,
// a pierwszy z nich widzi całą lukę naraz. Przy progu kilkunastu sekund zwykłe
// zadławienie procesu przesuwałoby deadline i twardy timeout przestawałby cokolwiek
// znaczyć. Sen liczy się w minutach i godzinach (zmierzone luki: 900–2000 s), a event
// loop zablokowany na pełną minutę to awaria sama w sobie — ten próg rozdziela jedno
// od drugiego z zapasem.
const SLEEP_GAP_MS = 60_000;

// Twardy timeout odporny na sen maszyny.
//
// `setTimeout(timeout_ms)` mierzy WALL-CLOCK, więc uśpiony Mac zjada budżet runu:
// proces nie dostaje ani milisekundy CPU, a po wybudzeniu natychmiast obrywa
// „Timeout exceeded". Tak ginęło 15 runów inbox synca (wall-clock 900–2000 s przy
// limicie 60 s) i tak job „Aktualizacja .env" był zabijany po 600 s mając za sobą
// sześć realnych porcji roboty.
//
// Zamiast jednego setTimeout tykamy interwałem i przy luce większej niż SLEEP_GAP_MS
// przesuwamy deadline o jej długość — czas snu po prostu nie liczy się do limitu.
// Zwraca `clear()`; `onSleep(gap)` jest opcjonalne (ścieżka claude dopisuje diagnostykę).
function startSleepAwareTimeout({ timeoutMs, onExpire, onSleep }) {
  let deadline = Date.now() + timeoutMs;
  let lastTickAt = Date.now();

  const id = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTickAt;
    lastTickAt = now;

    if (gap > SLEEP_GAP_MS) {
      deadline += gap;
      if (onSleep) onSleep(gap);
      return;
    }

    if (now >= deadline) {
      clearInterval(id);
      onExpire();
    }
  }, TIMEOUT_TICK_MS);

  return { clear: () => clearInterval(id) };
}

// Czy fail jest OSTATECZNY — dopiero wtedy wysyłamy ❌ (R9), nie per próbę retry.
// timeout: scheduler nie retry'uje timeoutów → zawsze ostateczny.
// killed: świadome ubicie przez usera → nigdy nie powiadamiamy.
// failed: ostateczny gdy liczba failów w oknie ostatnich max_retries+1 runów
// PRZEKRACZA max_retries — to samo okno co logika retry w scheduler.processQueue,
// żeby próg "będzie retry / nie będzie" był spójny między modułami.
function isFinalFailure(status, maxRetries, recentFailedCount) {
  if (status === 'timeout') return true;
  if (status !== 'failed') return false;
  if (!maxRetries || maxRetries <= 0) return true;
  return recentFailedCount > maxRetries;
}

// Powiadomienia po zakończeniu runu — fire-and-forget: pad jednego kanału nie blokuje
// drugiego ani NIGDY nie wpływa na status runu; błąd logujemy (bez tokenu — komunikaty
// kanałów celowo nie zawierają path), żeby zły token/chat_id nie znikał bez śladu.
// Okno liczenia failów = db.countRecentFailedRuns — TA SAMA definicja co retry
// w scheduler.processQueue; liczone PO db.updateRun (bieżący fail już w bazie).
function notifyRunOutcome(job, status, { stdout, stderr, errorMsg }) {
  const logNotifyError = (err) => console.error('[notify]', err.message);
  if (status === 'success') {
    // Joby routine (np. inbox sync co 1 min): sukces to szum — UI też go chowa.
    // Flagi kanałów działają wtedy jako czysty alarm o failach.
    if (job.routine) return;
    if (job.discord_notify) discord.sendNotification(job, stdout).catch(logNotifyError);
    if (job.telegram_notify) telegram.sendNotification(job, stdout).catch(logNotifyError);
    return;
  }
  if (!isFinalFailure(status, job.max_retries, db.countRecentFailedRuns(job.id, job.max_retries))) return;

  const failure = { status, error_msg: errorMsg, stderr };
  if (job.discord_notify) discord.sendFailureNotification(job, failure).catch(logNotifyError);
  if (job.telegram_notify) telegram.sendFailureNotification(job, failure).catch(logNotifyError);
}

function executeRun(run) {
  return new Promise((resolve) => {
    const job = db.getJob(run.job_id);
    if (!job) {
      db.updateRun(run.id, { status: 'failed', error_msg: 'Job not found', finished_at: new Date().toISOString() });
      return resolve();
    }

    currentRunId = run.id;

    const jobType = job.job_type || 'claude';

    // Script jobs — run a Node.js script directly, skip Claude CLI
    if (jobType === 'script') {
      return executeScriptRun(run, job, resolve);
    }

    // Build prompt: /skillname (if set) + arguments + webhook payload
    let prompt = '';
    if (job.skill_name && job.skill_name.trim()) {
      prompt = `/${job.skill_name}`;
    }
    if (job.arguments && job.arguments.trim()) {
      prompt += (prompt ? ' ' : '') + job.arguments.trim();
    }
    if (run.webhook_payload) {
      prompt += `\n\nWebhook payload:\n${run.webhook_payload}`;
    }
    if (!prompt) {
      db.updateRun(run.id, { status: 'failed', error_msg: 'No skill or prompt defined', finished_at: new Date().toISOString() });
      return resolve();
    }

    const args = ['--dangerously-skip-permissions', '--verbose', '--output-format', 'stream-json', '-p', prompt];

    db.updateRun(run.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let timedOut = false;

    // Diagnostics
    const t0 = Date.now();
    const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
    let diagLog = `${ts()} SPAWN: ${CLAUDE_BIN} ${args.join(' ')}\n`;
    let firstStdout = true;
    let lastChunkAt = t0;
    let chunkCount = 0;

    // Czysty env (strip CLAUDE_CODE*/CLAUDECODE → OAuth), resolve binarki
    // i opcje spawnu żyją we wspólnym helperze — dzielone z lib/ask.js.
    // Pad resolve binarki (Windows: brak `claude` w PATH) = fail runu z czytelnym
    // błędem — celowo BEZ fallbacku shell:true (command injection przez metaznaki
    // cmd.exe w treści promptu).
    let proc;
    try {
      proc = claudeSpawn.spawnClaude(args);
    } catch (err) {
      currentRunId = null;
      db.updateRun(run.id, { status: 'failed', error_msg: err.message, finished_at: new Date().toISOString() });
      return resolve();
    }

    currentProcess = proc;

    // Caffeinate — prevent Mac idle sleep while job is running
    let caffeinateProc = null;
    if (IS_MAC) {
      caffeinateProc = spawn('caffeinate', ['-is', '-w', String(proc.pid)], {
        detached: true,
        stdio: 'ignore',
      });
      caffeinateProc.unref();
      diagLog += `${ts()} CAFFEINATE: pid=${caffeinateProc.pid} watching proc=${proc.pid}\n`;
    }

    // Per-job idle timeout — falls back to global default when job has no explicit value
    const idleTimeoutMs = job.idle_timeout_ms && job.idle_timeout_ms > 0 ? job.idle_timeout_ms : IDLE_TIMEOUT_MS;

    // Kill helpers — Windows uses taskkill /T /F (kills tree), Mac/Linux uses signals
    let idleKill = false;
    function forceKillProc(p) {
      if (IS_WIN) {
        try { execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch {}
      } else {
        try { p.kill('SIGKILL'); } catch {}
      }
    }
    function gracefulKillProc(p) {
      if (IS_WIN) {
        forceKillProc(p);
      } else {
        p.kill('SIGTERM');
        setTimeout(() => forceKillProc(p), 5000);
      }
    }
    function killProc(reason) {
      if (timedOut) return; // already killing
      timedOut = true;
      idleKill = reason === 'idle';
      const label = idleKill ? 'IDLE_TIMEOUT' : 'TIMEOUT';
      const detail = idleKill
        ? `no output for ${idleTimeoutMs / 1000}s`
        : `killed after ${job.timeout_ms}ms`;
      diagLog += `${ts()} ${label}: ${detail} (chunks: ${chunkCount}, last chunk: ${((Date.now() - lastChunkAt) / 1000).toFixed(1)}s ago)\n`;
      gracefulKillProc(proc);
    }

    // Total timeout — hard cap on entire job
    // Sleep-aware: caffeinate blokuje wyłącznie idle sleep, więc przy zamkniętej klapie
    // (albo wymuszonym uśpieniu) run i tak przesypia część limitu. Nie karzemy go za to.
    const totalTimeout = startSleepAwareTimeout({
      timeoutMs: job.timeout_ms,
      onExpire: () => killProc('total'),
      onSleep: (gap) => {
        diagLog += `${ts()} TIMEOUT_CLOCK: sleep detected (gap ${(gap / 1000).toFixed(1)}s) — deadline przesunięty\n`;
      },
    });

    // Idle timeout — reset on every stdout chunk
    let idleTimeoutId = setTimeout(() => killProc('idle'), idleTimeoutMs);

    // Watchdog — wall-clock backup for idle timeout (survives Mac sleep)
    let lastWatchdogAt = Date.now();
    const watchdogId = setInterval(() => {
      const now = Date.now();
      const watchdogGap = now - lastWatchdogAt;
      lastWatchdogAt = now;

      // If watchdog itself was delayed by >3x its interval, Mac was sleeping
      // Reset idle timer — give the process a chance to resume after wake
      if (watchdogGap > WATCHDOG_INTERVAL_MS * 3) {
        diagLog += `${ts()} WATCHDOG: sleep detected (gap ${(watchdogGap / 1000).toFixed(1)}s) — resetting idle timer\n`;
        lastChunkAt = now;
        clearTimeout(idleTimeoutId);
        idleTimeoutId = setTimeout(() => killProc('idle'), idleTimeoutMs);
        return;
      }

      if (now - lastChunkAt > idleTimeoutMs) {
        diagLog += `${ts()} WATCHDOG: wall-clock idle detected (last chunk ${((now - lastChunkAt) / 1000).toFixed(1)}s ago)\n`;
        killProc('idle');
      }
    }, WATCHDOG_INTERVAL_MS);

    proc.stdout.on('data', (chunk) => {
      const now = Date.now();
      const gap = ((now - lastChunkAt) / 1000).toFixed(1);
      chunkCount++;
      if (firstStdout) {
        diagLog += `${ts()} FIRST_STDOUT: ${chunk.length}B\n`;
        firstStdout = false;
      } else if (chunkCount <= 20 || chunkCount % 50 === 0 || parseFloat(gap) > 10) {
        diagLog += `${ts()} CHUNK #${chunkCount}: ${chunk.length}B (gap: ${gap}s, total: ${stdout.length}B)\n`;
      }
      lastChunkAt = now;
      stdout += chunk.toString();

      // Reset idle timeout on every chunk
      clearTimeout(idleTimeoutId);
      idleTimeoutId = setTimeout(() => killProc('idle'), idleTimeoutMs);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      totalTimeout.clear();
      clearTimeout(idleTimeoutId);
      clearInterval(watchdogId);
      if (caffeinateProc) {
        try { caffeinateProc.kill(); } catch {}
      }
      currentProcess = null;
      currentRunId = null;

      diagLog += `${ts()} CLOSE: code=${code} stdout=${stdout.length}B stderr=${stderr.length}B chunks=${chunkCount}\n`;

      // Kill przez usera: killCurrent zapisał już w DB status 'killed' zanim proces zdążył
      // się domknąć — bez tego odczytu close policzyłby 'failed' (exit code po SIGTERM ≠ 0),
      // nadpisał status i R9 wysłałoby ❌ mimo świadomej decyzji usera.
      const priorRun = db.getRunWithPayload(run.id);
      if (priorRun && priorRun.status === 'killed') killed = true;

      const status = timedOut ? 'timeout' : killed ? 'killed' : code === 0 ? 'success' : 'failed';

      const fullStderr = diagLog + '\n' + stderr;

      const errorMsg = timedOut
        ? (idleKill ? `Idle timeout — no output for ${idleTimeoutMs / 1000}s` : 'Timeout exceeded')
        : killed ? 'Killed by user' : '';

      db.updateRun(run.id, {
        status,
        finished_at: new Date().toISOString(),
        exit_code: code,
        stdout: truncate(stdout, MAX_LOG_SIZE),
        stderr: truncate(fullStderr, MAX_LOG_SIZE),
        error_msg: errorMsg,
      });

      notifyRunOutcome(job, status, { stdout, stderr: fullStderr, errorMsg });

      resolve();
    });

    proc.on('error', (err) => {
      totalTimeout.clear();
      clearTimeout(idleTimeoutId);
      clearInterval(watchdogId);
      if (caffeinateProc) {
        try { caffeinateProc.kill(); } catch {}
      }
      currentProcess = null;
      currentRunId = null;

      db.updateRun(run.id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_msg: err.message,
      });

      resolve();
    });
  });
}

// Script executor — simpler path, no Claude CLI, no caffeinate, no stream-json parsing.
// Just spawn `node <command>` with workspace cwd, inherit env, collect output, enforce timeout.
function executeScriptRun(run, job, resolve) {
  if (!job.command || !job.command.trim()) {
    db.updateRun(run.id, { status: 'failed', error_msg: 'Script job missing command', finished_at: new Date().toISOString() });
    return resolve();
  }

  db.updateRun(run.id, { status: 'running', started_at: new Date().toISOString() });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const proc = spawn('node', [job.command], {
    cwd: WORKSPACE_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  currentProcess = proc;

  // Finalizacja runu w JEDNYM miejscu, z guardem przed podwójnym wywołaniem: woła ją
  // zdarzenie 'close' ORAZ ratunkowy timer po zabiciu (patrz niżej). Bez guardu
  // spóźnione 'close' nadpisałoby wynik i wywołało `resolve()` drugi raz.
  let settled = false;
  function finishScriptRun(code, { orphaned = false } = {}) {
    if (settled) return;
    settled = true;
    totalTimeout.clear();
    currentProcess = null;
    currentRunId = null;

    // Ten sam guard co w ścieżce claude: kill przez usera nie może skończyć jako 'failed' + ❌ (R9).
    const priorRun = db.getRunWithPayload(run.id);
    const wasKilled = !!(priorRun && priorRun.status === 'killed');

    const status = wasKilled ? 'killed' : timedOut ? 'timeout' : code === 0 ? 'success' : 'failed';
    const errorMsg = wasKilled
      ? 'Killed by user'
      : orphaned
        ? 'Timeout exceeded — proces nie zgłosił zakończenia (prawdopodobnie ubity przez system przy uśpieniu)'
        : timedOut ? 'Timeout exceeded' : '';
    db.updateRun(run.id, {
      status,
      finished_at: new Date().toISOString(),
      exit_code: code,
      stdout: truncate(stdout, MAX_LOG_SIZE),
      stderr: truncate(stderr, MAX_LOG_SIZE),
      error_msg: errorMsg,
    });

    notifyRunOutcome(job, status, { stdout, stderr, errorMsg });

    resolve();
  }

  // Sleep-aware timeout — ścieżka skryptowa świadomie NIE odpala caffeinate (job
  // chodzący co minutę trzymałby Maca wybudzonego bez końca), więc sen jest tu
  // stanem normalnym, nie wyjątkiem. Wall-clock go karał: 15 timeoutów inbox synca
  // przy realnym czasie pracy rzędu 0,2 s.
  const totalTimeout = startSleepAwareTimeout({
    timeoutMs: job.timeout_ms,
    onExpire: () => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      // Ratunek na wypadek, gdy 'close' nigdy nie przyjdzie — proces bywa uprzątany
      // przez system tak, że Node nie dostaje zdarzenia. Wtedy run zostaje 'running'
      // NA ZAWSZE, a `isRunning()` blokuje całą kolejkę Pulsa (tak powstał zombie
      // 2760267: 14 h w stanie running). Dajemy zapas na uporządkowane zamknięcie.
      setTimeout(() => finishScriptRun(null, { orphaned: true }), 15_000);
    },
  });

  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  proc.on('close', (code) => finishScriptRun(code));

  // Błąd spawnu (np. brak node w PATH) — 'close' po nim nie przyjdzie, więc własna
  // ścieżka finalizacji. Ten sam guard `settled`, żeby nie kolidowała z ratunkowym timerem.
  proc.on('error', (err) => {
    if (settled) return;
    settled = true;
    totalTimeout.clear();
    currentProcess = null;
    currentRunId = null;
    db.updateRun(run.id, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_msg: err.message,
    });
    resolve();
  });
}

function killCurrent() {
  if (!currentProcess) return false;
  if (IS_WIN) {
    try { execSync(`taskkill /PID ${currentProcess.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch {}
  } else {
    currentProcess.kill('SIGTERM');
    const proc = currentProcess;
    setTimeout(() => {
      if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 5000);
  }

  if (currentRunId) {
    db.updateRun(currentRunId, {
      status: 'killed',
      finished_at: new Date().toISOString(),
      error_msg: 'Killed by user',
    });
  }
  return true;
}

function getCurrentRunId() {
  return currentRunId;
}

function isRunning() {
  return currentProcess !== null;
}

// readOauthToken przeniósł się do lib/claude-spawn.js — re-eksport dla
// kompatybilności istniejących importów (m.in. lib/executor.test.js).
module.exports = {
  executeRun,
  killCurrent,
  getCurrentRunId,
  isRunning,
  isFinalFailure,
  notifyRunOutcome,
  startSleepAwareTimeout,
  TIMEOUT_TICK_MS,
  SLEEP_GAP_MS,
  readOauthToken: claudeSpawn.readOauthToken,
};
