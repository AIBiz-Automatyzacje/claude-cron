const { IS_WIN } = require('./config');

let intervalId = null;
let setThreadExecutionState = null;

// Prevent Windows sleep by calling kernel32 SetThreadExecutionState directly
// via koffi (pure JS FFI). No PowerShell, no spawned processes, no window flash.
//
// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = prevent sleep
// ES_CONTINUOUS (0x80000000) alone = allow sleep again

function load() {
  if (setThreadExecutionState) return true;
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    setThreadExecutionState = kernel32.func('__stdcall', 'SetThreadExecutionState', 'uint32', ['uint32']);
    return true;
  } catch (err) {
    console.log('[keep-awake] koffi not available:', err.message);
    return false;
  }
}

function start() {
  if (!IS_WIN || intervalId) return;
  if (!load()) return;

  setThreadExecutionState(0x80000001);
  // Refresh every 30s — Windows resets after ~60s of inactivity
  intervalId = setInterval(() => {
    try { setThreadExecutionState(0x80000001); } catch {}
  }, 30000);

  console.log('[keep-awake] Windows sleep blocked');
}

function stop() {
  if (!intervalId) return;

  clearInterval(intervalId);
  intervalId = null;

  // Reset: allow sleep again
  try { setThreadExecutionState(0x80000000); } catch {}

  console.log('[keep-awake] Windows sleep unblocked');
}

module.exports = { start, stop };
