// Tożsamość huba skrzynki Team OS — odpowiedź na pytanie „czy TA instancja jest hubem".
//
// Dlaczego to nie jest to samo co „ma Funnel": hub MUSI mieć publiczny URL (bez niego kod
// zaproszenia byłby bezużyteczny — server.js zwraca 503), ale odwrotnie już nie: członek
// zespołu włącza Funnel dla własnych webhooków i dalej hubem nie jest. Sygnałem rozstrzygającym
// jest kierunek `INBOX_HUB_URL`: instalator huba onboarduje admina WŁASNYM kodem zaproszenia,
// więc na hubie adres skrzynki równa się własnemu `WEBHOOK_BASE_URL`; u członka wskazuje na
// cudzą maszynę. Pomyłka w tę stronę pokazuje administrację zespołem tam, gdzie lokalna
// `inbox.db` jest pusta i nie jest niczyim hubem.
//
// I/O (odczyt pliku sekretu) siedzi w server.js — tutaj wyłącznie czysta decyzja.

// Porównanie po `origin` (protokół + host + port), bo `WEBHOOK_BASE_URL` bywa zapisany
// z trailing slashem, a `INBOX_HUB_URL` pochodzi z kodu zaproszenia — ten sam adres
// w dwóch zapisach musi dać tę samą odpowiedź. Fail-closed: brak wartości albo śmieć
// z ręcznie edytowanego pliku znaczy „nie hub", nigdy wyjątek z `/api/env`.
function isSelfHub(inboxHubUrl, webhookBaseUrl) {
  if (typeof inboxHubUrl !== 'string' || typeof webhookBaseUrl !== 'string') return false;
  if (!inboxHubUrl || !webhookBaseUrl) return false;
  try {
    return new URL(inboxHubUrl).origin === new URL(webhookBaseUrl).origin;
  } catch {
    return false;
  }
}

module.exports = { isSelfHub };
