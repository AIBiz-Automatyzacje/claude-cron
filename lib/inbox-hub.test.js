// Tożsamość huba skrzynki: czy TA instancja jest hubem zespołu, czy tylko jego członkiem.
// Pytanie wygląda na kosmetyczne (widoczność zakładki Zespół), ale odpowiedź rozstrzyga,
// czy dashboard pokazuje administrację cudzym zespołem — patrz komentarz w inbox-hub.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isSelfHub } = require('./inbox-hub');

test('isSelfHub: INBOX_HUB_URL wskazuje na własny Funnel → to hub', () => {
  const url = 'https://srv1362522.tail4f19b2.ts.net';
  assert.equal(isSelfHub(url, url), true);
});

test('isSelfHub: INBOX_HUB_URL wskazuje na CUDZY hub → to członek, nie hub', () => {
  // Realny przypadek z testu 27.07: VPS członka z własnym Funnelem (dla webhooków),
  // ale skrzynką na maszynie admina. Sama obecność Funnela NIE czyni huba.
  assert.equal(
    isSelfHub('https://kacper.tail4f19b2.ts.net:8443', 'https://srv1362522.tail4f19b2.ts.net'),
    false,
  );
});

test('isSelfHub: różnica w trailing slash i ścieżce nie zmienia tożsamości (porównanie po origin)', () => {
  assert.equal(isSelfHub('https://hub.ts.net/', 'https://hub.ts.net'), true);
  assert.equal(isSelfHub('https://hub.ts.net/inbox/v1', 'https://hub.ts.net'), true);
});

test('isSelfHub: ten sam host, INNY port → inna instancja', () => {
  // Port jest częścią origin — dwa Pulsy na jednym hoście to dwa różne huby.
  assert.equal(isSelfHub('https://hub.ts.net:8443', 'https://hub.ts.net'), false);
});

test('isSelfHub: brak którejkolwiek wartości → false (fail-closed)', () => {
  assert.equal(isSelfHub('', 'https://hub.ts.net'), false);
  assert.equal(isSelfHub('https://hub.ts.net', ''), false);
  assert.equal(isSelfHub(null, undefined), false);
});

test('isSelfHub: nieparsowalny URL → false, nie wyjątek', () => {
  // Wartość pochodzi z pliku konfiguracyjnego edytowanego ręcznie — śmieć nie może
  // wywrócić /api/env, a „nie wiem" ma znaczyć „nie hub".
  assert.doesNotThrow(() => isSelfHub('to nie jest url', 'https://hub.ts.net'));
  assert.equal(isSelfHub('to nie jest url', 'https://hub.ts.net'), false);
  assert.equal(isSelfHub('https://hub.ts.net', '////'), false);
});

// === Pełna decyzja: isInboxHub (self-hub ALBO ma członków, ale ZAWSZE z Funnelem) ===
// Drugi człon ratuje hub, na którym onboarding admina padł (skrzynka istnieje, ale
// INBOX_HUB_URL się nie zapisał) — bez niego zakładka zniknęłaby i nie dałoby się tego
// naprawić z dashboardu. Warunek Funnela jest twardy: instancja bez WEBHOOK_BASE_URL
// odmawia utworzenia członka (503, server.js), więc „hub bez Funnela" to sprzeczność.
const { isInboxHub } = require('./inbox-hub');

test('isInboxHub: self-hub → hub', () => {
  const url = 'https://hub.ts.net';
  assert.equal(isInboxHub({ inboxHubUrl: url, webhookBaseUrl: url, memberCount: 0 }), true);
});

test('isInboxHub: Funnel + członkowie, bez INBOX_HUB_URL → hub (nieudany onboarding admina)', () => {
  assert.equal(
    isInboxHub({ inboxHubUrl: '', webhookBaseUrl: 'https://hub.ts.net', memberCount: 1 }),
    true,
  );
});

test('isInboxHub: członkowie BEZ Funnela → NIE hub (dodanie członka i tak dałoby 503)', () => {
  // Realny przypadek z 28.07: maszyna deweloperska z resztką w inbox.db po teście
  // pokazywała zakładkę Zespół, mimo że nie ma publicznego URL-a.
  assert.equal(isInboxHub({ inboxHubUrl: '', webhookBaseUrl: '', memberCount: 5 }), false);
});

test('isInboxHub: członek zespołu z własnym Funnelem → NIE hub', () => {
  assert.equal(
    isInboxHub({ inboxHubUrl: 'https://kacper.ts.net:8443', webhookBaseUrl: 'https://cave.ts.net', memberCount: 0 }),
    false,
  );
});

test('isInboxHub: brak danych → false (fail-closed)', () => {
  assert.equal(isInboxHub({}), false);
  assert.equal(isInboxHub(), false);
});
