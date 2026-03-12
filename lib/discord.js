const https = require('node:https');
const { DISCORD_WEBHOOK_URL } = require('./config');

const DISCORD_MAX_LEN = 2000;

function extractResult(stdout) {
  if (!stdout || !stdout.trim()) return '';

  const lines = stdout.trim().split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type === 'result' && entry.result) {
        return entry.result;
      }
    } catch {
      continue;
    }
  }
  return '';
}

function smartSplit(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    else if (remaining[splitAt] === '.') splitAt += 1; // include the dot

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function postWebhook(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_WEBHOOK_URL);
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
  if (!DISCORD_WEBHOOK_URL) return;

  const resultText = extractResult(stdout) || 'Job completed (no result text)';
  const chunks = smartSplit(resultText, DISCORD_MAX_LEN);

  // First message as embed
  const description = chunks[0].length > DISCORD_MAX_LEN
    ? chunks[0].slice(0, DISCORD_MAX_LEN)
    : chunks[0];

  await postWebhook({
    embeds: [{
      title: `✅ ${job.name}`,
      description,
      color: 0x00FF00,
      timestamp: new Date().toISOString(),
    }],
  });

  // Follow-up chunks as plain messages
  for (let i = 1; i < chunks.length; i++) {
    await postWebhook({ content: chunks[i] });
  }
}

module.exports = { sendNotification, extractResult, smartSplit };
