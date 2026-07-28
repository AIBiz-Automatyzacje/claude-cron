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

// Pełna decyzja „czy ta instancja jest hubem" — jedno miejsce, zamiast składania warunku
// w server.js. Funnel jest wymagany ZAWSZE: bez `WEBHOOK_BASE_URL` tworzenie członka kończy
// się 503 (kod zaproszenia bez publicznego URL-a jest bezużyteczny), więc „hub bez Funnela"
// to sprzeczność — pokazanie tam zakładki prowadzi wprost do tego samego 503, przed którym
// ta logika ma chronić. Drugi człon (są członkowie) ratuje hub z nieudanym onboardingiem
// admina: skrzynka istnieje, `INBOX_HUB_URL` się nie zapisał, a bez zakładki nie dałoby się
// tego naprawić z dashboardu.
function isInboxHub({ inboxHubUrl = '', webhookBaseUrl = '', memberCount = 0 } = {}) {
  if (!webhookBaseUrl) return false;
  return isSelfHub(inboxHubUrl, webhookBaseUrl) || memberCount > 0;
}

module.exports = { isSelfHub, isInboxHub };
