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
