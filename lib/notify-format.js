// Wspólne formatowanie powiadomień (Discord, Telegram, ...) — czyste funkcje bez I/O.
// Wydzielone z lib/discord.js, żeby drugi kanał nie duplikował parsowania stream-json
// ani dzielenia na chunki (limity per kanał: Discord 2000, Telegram 4096 — maxLen parametrem).

const RESULT_FALLBACK = 'Job completed (no result text)';

// Wyciąga treść wpisu type:'result' ze stdout CLI w formacie stream-json (JSON per linia).
// Fallback żyje tutaj (nie u wołającego), żeby każdy kanał dostał ten sam tekst zastępczy.
function extractResult(stdout) {
  if (!stdout || !stdout.trim()) return RESULT_FALLBACK;

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
      // linia nie-JSON (np. warning CLI) — ignorujemy i szukamy dalej
      continue;
    }
  }
  return RESULT_FALLBACK;
}

// Dzieli tekst na chunki ≤ maxLen, preferując granice naturalne: najpierw '\n', potem '. '.
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

module.exports = { extractResult, smartSplit, RESULT_FALLBACK };
