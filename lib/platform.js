const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { IS_MAC, IS_WIN, HOME, PROJECT_ROOT } = require('./config');

const PLIST_LABEL = 'com.claude-cron.scheduler';
const PLIST_PATH = IS_MAC ? path.join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`) : '';
const WIN_TASK_NAME = 'ClaudeCron';

function generatePlist() {
  const nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${path.join(PROJECT_ROOT, 'server.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(PROJECT_ROOT, 'data', 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(PROJECT_ROOT, 'data', 'stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;
}

function installMac() {
  const dir = path.dirname(PLIST_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PLIST_PATH, generatePlist(), 'utf-8');
  execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: 'inherit' });
  return PLIST_PATH;
}

function uninstallMac() {
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'inherit' });
  } catch { /* already unloaded */ }
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
}

function getStatus() {
  if (IS_MAC) {
    try {
      const out = execSync(`launchctl list | grep ${PLIST_LABEL}`, { encoding: 'utf-8' });
      return { installed: true, running: !out.includes('-'), platform: 'macos' };
    } catch {
      return { installed: fs.existsSync(PLIST_PATH), running: false, platform: 'macos' };
    }
  }
  if (IS_WIN) {
    try {
      execSync('schtasks /Query /TN "ClaudeCron"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { installed: true, running: true, platform: 'windows' };
    } catch {
      return { installed: false, running: false, platform: 'windows' };
    }
  }
  return { installed: false, running: false, platform: process.platform };
}

// === Windows Task Scheduler ===

function installWin() {
  const nodePath = execSync('where node', { encoding: 'utf-8' }).trim().split('\n')[0].trim();
  const serverPath = path.join(PROJECT_ROOT, 'server.js');

  try {
    execSync(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F`, { stdio: 'ignore' });
  } catch { /* not installed */ }

  execSync(
    `schtasks /Create /TN "${WIN_TASK_NAME}" /TR "\\"${nodePath}\\" \\"${serverPath}\\"" /SC ONLOGON /RL HIGHEST /F`,
    { stdio: 'inherit' }
  );
  return WIN_TASK_NAME;
}

function uninstallWin() {
  try {
    execSync(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F`, { stdio: 'inherit' });
  } catch { /* not installed */ }
}

function install() {
  if (IS_MAC) return installMac();
  if (IS_WIN) return installWin();
  throw new Error(`Autostart not supported on ${process.platform}`);
}

function uninstall() {
  if (IS_MAC) return uninstallMac();
  if (IS_WIN) return uninstallWin();
  throw new Error(`Autostart not supported on ${process.platform}`);
}

module.exports = { install, uninstall, installMac, uninstallMac, installWin, uninstallWin, getStatus, PLIST_PATH };
