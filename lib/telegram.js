const https = require('node:https');
const db = require('./db');
const { resolveNotifyConfig } = require('./notify-config');
const { extractResult, smartSplit } = require('./notify-format');

const TELEGRAM_MAX_LEN = 4096;
// Skrót przyczyny failu: gdy brak error_msg bierzemy OGON stderr — ostatnie linie
// mówią najwięcej o przyczynie (stack trace / ostatni błąd przed exitem).
const STDERR_TAIL_LEN = 1000;

function postSendMessage(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: chatId, text });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        // Komunikat błędu NIE zawiera path (tam żyje token) — tylko status + body Telegrama.
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Telegram ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', reject);
    req.end(data);
  });
}

// Czysta (bez sieci): lista wiadomości po UDANYM runie. Nagłówek ✅ tylko w pierwszej.
// smartSplit dostaje limit pomniejszony o nagłówek + '\n', żeby KAŻDA wiadomość
// (z nagłówkiem włącznie) mieściła się w limicie Telegrama (4096, plain text bez parse_mode).
function buildMessages(jobName, stdout) {
  const header = `✅ ${jobName}`;
  const chunks = smartSplit(extractResult(stdout), TELEGRAM_MAX_LEN - header.length - 1);
  return chunks.map((chunk, i) => (i === 0 ? `${header}\n${chunk}` : chunk));
}

// Czysta: wiadomość o OSTATECZNYM failu (R9) — ❌ + skrót przyczyny (error_msg gdy jest,
// inaczej ogon stderr). Jedna wiadomość, twardo ucięta do limitu.
function buildFailureMessage(jobName, status, errorMsg, stderr) {
  const header = `❌ ${jobName} padł (${status})`;
  const detail = (errorMsg && errorMsg.trim()) || (stderr || '').trim().slice(-STDERR_TAIL_LEN);
  const message = detail ? `${header}\n${detail}` : header;
  return message.slice(0, TELEGRAM_MAX_LEN);
}

async function sendNotification(job, stdout) {
  // Konfiguracja rozwiązywana przy KAŻDEJ wysyłce (state > env), nie przy require —
  // zmiana z dashboardu działa bez restartu (R4), env fallback zostaje (R3). Jak lib/discord.js.
  const { telegramBotToken, telegramChatId } = resolveNotifyConfig(db.getState, process.env);
  if (!telegramBotToken || !telegramChatId) return;

  for (const text of buildMessages(job.name, stdout)) {
    await postSendMessage(telegramBotToken, telegramChatId, text);
  }
}

async function sendFailureNotification(job, run) {
  const { telegramBotToken, telegramChatId } = resolveNotifyConfig(db.getState, process.env);
  if (!telegramBotToken || !telegramChatId) return;

  await postSendMessage(
    telegramBotToken,
    telegramChatId,
    buildFailureMessage(job.name, run.status, run.error_msg, run.stderr)
  );
}

module.exports = { sendNotification, sendFailureNotification, buildMessages, buildFailureMessage };
