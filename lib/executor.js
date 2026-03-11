const { spawn } = require('node:child_process');
const { CLAUDE_BIN, WORKSPACE_DIR, MAX_LOG_SIZE, IDLE_TIMEOUT_MS } = require('./config');
const db = require('./db');

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

    // Build prompt: /skillname (if set) + arguments
    let prompt = '';
    if (job.skill_name && job.skill_name.trim()) {
      prompt = `/${job.skill_name}`;
    }
    if (job.arguments && job.arguments.trim()) {
      prompt += (prompt ? ' ' : '') + job.arguments.trim();
    }
    if (!prompt) {
      db.updateRun(run.id, { status: 'failed', error_msg: 'No skill or prompt defined', finished_at: new Date().toISOString() });
      return resolve();
    }

    const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '-p', prompt];

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

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    currentProcess = proc;

    // Kill helper (shared by both timeouts)
    let idleKill = false;
    function killProc(reason) {
      if (timedOut) return; // already killing
      timedOut = true;
      idleKill = reason === 'idle';
      const label = idleKill ? 'IDLE_TIMEOUT' : 'TIMEOUT';
      const detail = idleKill
        ? `no output for ${IDLE_TIMEOUT_MS / 1000}s`
        : `killed after ${job.timeout_ms}ms`;
      diagLog += `${ts()} ${label}: ${detail} (chunks: ${chunkCount}, last chunk: ${((Date.now() - lastChunkAt) / 1000).toFixed(1)}s ago)\n`;
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
    }

    // Total timeout — hard cap on entire job
    const timeoutId = setTimeout(() => killProc('total'), job.timeout_ms);

    // Idle timeout — reset on every stdout chunk
    let idleTimeoutId = setTimeout(() => killProc('idle'), IDLE_TIMEOUT_MS);

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
      idleTimeoutId = setTimeout(() => killProc('idle'), IDLE_TIMEOUT_MS);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      clearTimeout(idleTimeoutId);
      currentProcess = null;
      currentRunId = null;

      diagLog += `${ts()} CLOSE: code=${code} stdout=${stdout.length}B stderr=${stderr.length}B chunks=${chunkCount}\n`;

      const status = timedOut ? 'timeout' : killed ? 'killed' : code === 0 ? 'success' : 'failed';

      const fullStderr = diagLog + '\n' + stderr;

      const errorMsg = timedOut
        ? (idleKill ? `Idle timeout — no output for ${IDLE_TIMEOUT_MS / 1000}s` : 'Timeout exceeded')
        : killed ? 'Killed by user' : '';

      db.updateRun(run.id, {
        status,
        finished_at: new Date().toISOString(),
        exit_code: code,
        stdout: truncate(stdout, MAX_LOG_SIZE),
        stderr: truncate(fullStderr, MAX_LOG_SIZE),
        error_msg: errorMsg,
      });

      resolve();
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      clearTimeout(idleTimeoutId);
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

function killCurrent() {
  if (!currentProcess) return false;
  currentProcess.kill('SIGTERM');
  setTimeout(() => {
    if (currentProcess && !currentProcess.killed) {
      currentProcess.kill('SIGKILL');
    }
  }, 5000);

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
