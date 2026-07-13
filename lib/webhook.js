// Dopasowanie tokenu webhooka z URL żądania.
// Token: [a-zA-Z0-9_-]+ po prefiksie /webhook/. Regex kończy się na (?:\?|$),
// więc poprawnie obcina query string (np. /webhook/abc?foo=1 → "abc").
// Zwraca token (string) albo null gdy URL nie pasuje / token zawiera nielegalny znak.
const WEBHOOK_URL_PATTERN = /^\/webhook\/([a-zA-Z0-9_-]+)(?:\?|$)/;

function matchWebhookToken(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(WEBHOOK_URL_PATTERN);
  return match ? match[1] : null;
}

// Bliźniaczy matcher dla publicznego endpointu asystenta głosowego (/ask/:token) —
// te same reguły tokenu i obcinania query co w webhookach.
const ASK_URL_PATTERN = /^\/ask\/([a-zA-Z0-9_-]+)(?:\?|$)/;

function matchAskToken(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(ASK_URL_PATTERN);
  return match ? match[1] : null;
}

module.exports = { matchWebhookToken, matchAskToken };
