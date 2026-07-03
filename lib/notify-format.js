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
// Nigdy nie zwraca pustych chunków (Telegram/Discord odrzucają pusty text → 400).
function smartSplit(text, maxLen) {
  // Fail-fast: maxLen <= 0 = nieskończona synchroniczna pętla (slice z ujemnym indeksem
  // nie zmniejsza remaining) — blokada całego event loopu zamiast czytelnego błędu.
  if (!Number.isInteger(maxLen) || maxLen <= 0) {
    throw new RangeError(`smartSplit: maxLen musi być dodatnią liczbą całkowitą (jest: ${maxLen})`);
  }
  if (text.length <= maxLen) return text ? [text] : [];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    // '. ' szukamy od maxLen-1: kropka dokładnie na indeksie maxLen po `splitAt += 1`
    // dawała chunk maxLen+1 znaków (off-by-one → 400 z API kanału).
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', maxLen - 1);
    if (splitAt <= 0) splitAt = maxLen;
    else if (remaining[splitAt] === '.') splitAt += 1; // include the dot

    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) chunks.push(chunk); // guard: ciąg \n na granicy dawał pusty chunk
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

module.exports = { extractResult, smartSplit, RESULT_FALLBACK };
