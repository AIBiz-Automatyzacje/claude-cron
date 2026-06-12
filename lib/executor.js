const { spawn, execSync } = require('node:child_process');
const { CLAUDE_BIN, WORKSPACE_DIR, MAX_LOG_SIZE, IDLE_TIMEOUT_MS, WATCHDOG_INTERVAL_MS, IS_MAC, IS_WIN } = require('./config');
const db = require('./db');
const { sendNotification } = require('./discord');

let currentProcess = null;
let currentRunId = null;

function truncate(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(-max); // Keep the tail (most recent output)
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

    // Strip all Claude Code env vars so spawned CLI doesn't think it's nested
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('CLAUDE_CODE') || key === 'CLAUDECODE') {
        delete cleanEnv[key];
      }
    }

    // Diagnostics
    const t0 = Date.now();
    const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
    let diagLog = `${ts()} SPAWN: ${CLAUDE_BIN} ${args.join(' ')}\n`;
    let firstStdout = true;
    let lastChunkAt = t0;
    let chunkCount = 0;

    // On Windows, resolve the full path to claude.exe so we can avoid shell: true
    // (shell: true causes cmd.exe to split multi-word -p arguments)
    let bin = CLAUDE_BIN;
    let useShell = false;
    if (IS_WIN) {
      try {
        bin = execSync('where claude', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim();
      } catch {
        useShell = true;
      }
    }

    const proc = spawn(bin, args, {
      cwd: WORKSPACE_DIR,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });

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
    const timeoutId = setTimeout(() => killProc('total'), job.timeout_ms);

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
      clearTimeout(timeoutId);
      clearTimeout(idleTimeoutId);
      clearInterval(watchdogId);
      if (caffeinateProc) {
        try { caffeinateProc.kill(); } catch {}
      }
      currentProcess = null;
      currentRunId = null;

      diagLog += `${ts()} CLOSE: code=${code} stdout=${stdout.length}B stderr=${stderr.length}B chunks=${chunkCount}\n`;

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

      if (status === 'success' && job.discord_notify) {
        sendNotification(job, stdout).catch(() => {});
      }

      resolve();
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
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

  const timeoutId = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
  }, job.timeout_ms);

  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  proc.on('close', (code) => {
    clearTimeout(timeoutId);
    currentProcess = null;
    currentRunId = null;

    const status = timedOut ? 'timeout' : code === 0 ? 'success' : 'failed';
    db.updateRun(run.id, {
      status,
      finished_at: new Date().toISOString(),
      exit_code: code,
      stdout: truncate(stdout, MAX_LOG_SIZE),
      stderr: truncate(stderr, MAX_LOG_SIZE),
      error_msg: timedOut ? 'Timeout exceeded' : '',
    });

    if (status === 'success' && job.discord_notify) {
      sendNotification(job, stdout).catch(() => {});
    }

    resolve();
  });

  proc.on('error', (err) => {
    clearTimeout(timeoutId);
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

module.exports = { executeRun, killCurrent, getCurrentRunId, isRunning };
