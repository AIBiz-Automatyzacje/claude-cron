const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { MAINTENANCE_WINDOW } = require('./lib/config');

// Integracyjny test kontraktu GET /api/env (review fazy 4, P2 E2E app.js:1138):
// realnie wystartowany serwer musi zwracać maintenance_window ze startHour:6.
// Serwer odpalamy jako proces potomny na efemerycznym porcie, bo server.js
// startuje DB/scheduler przy require — driver przez HTTP omija te side-effecty.

const TEST_PORT = 7798;
let child;

function waitForServerReady(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serwer nie wystartował w 10s')), 10000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Puls running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

before(async () => {
  child = spawn('node', [path.join(__dirname, 'server.js')], {
    env: { ...process.env, CLAUDE_CRON_PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServerReady(child);
});

after(() => {
  if (child) child.kill('SIGKILL');
});

test('GET /api/env zwraca maintenance_window ze startHour:6 (kontrakt z config)', async () => {
  // Act
  const res = await fetch(`http://localhost:${TEST_PORT}/api/env`);
  const body = await res.json();

  // Assert — pole obecne i równe stałej z config.js
  assert.equal(res.status, 200);
  assert.ok(body.maintenance_window, 'odpowiedź zawiera maintenance_window');
  assert.equal(body.maintenance_window.startHour, 6);
  assert.deepEqual(body.maintenance_window, MAINTENANCE_WINDOW);
});
