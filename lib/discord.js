const https = require('node:https');
const db = require('./db');
const { resolveNotifyConfig } = require('./notify-config');
const { extractResult, smartSplit } = require('./notify-format');

const DISCORD_MAX_LEN = 2000;

function postWebhook(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const data = JSON.stringify(body);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Discord ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', reject);
    req.end(data);
  });
}

async function sendNotification(job, stdout) {
  // URL rozwiązywany przy KAŻDEJ wysyłce (state > env), nie przy require — zmiana
  // konfiguracji z dashboardu działa bez restartu serwera (R4), env fallback zostaje (R3).
  const { discordWebhookUrl } = resolveNotifyConfig(db.getState, process.env);
  if (!discordWebhookUrl) return;

  // fallback "Job completed…" żyje teraz w extractResult (notify-format) — wspólny dla kanałów
  const resultText = extractResult(stdout);
  const chunks = smartSplit(resultText, DISCORD_MAX_LEN);

  // First message as embed
  const description = chunks[0].length > DISCORD_MAX_LEN
    ? chunks[0].slice(0, DISCORD_MAX_LEN)
    : chunks[0];

  await postWebhook(discordWebhookUrl, {
    embeds: [{
      title: `✅ ${job.name}`,
      description,
      color: 0x00FF00,
      timestamp: new Date().toISOString(),
    }],
  });

  // Follow-up chunks as plain messages
  for (let i = 1; i < chunks.length; i++) {
    await postWebhook(discordWebhookUrl, { content: chunks[i] });
  }
}

module.exports = { sendNotification };
