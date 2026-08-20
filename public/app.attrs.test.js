const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Bariera na jedną konkretną klasę błędu, nie na styl: wklejanie WARTOŚCI do treści
// inline'owego handlera zdarzeń (`onclick="fn('${x}')"`). Atrybut zdarzenia jest najpierw
// dekodowany jako HTML, dopiero potem parsowany jako JavaScript, więc escapowanie encjami
// (`&#39;`) NIE chroni stringa w środku — apostrof wraca przed wykonaniem i zamyka literał.
// Bezpieczny wzorzec: wartość do `data-*` (tam escapowanie działa) + delegacja zdarzenia.
//
// Liczbowe id (`onclick="triggerJob(${j.id})"`) są poza zakresem — nie ma tam literału
// stringa do zamknięcia, a id przechodzi przez parsowanie po stronie serwera.
const SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('żaden inline handler nie wkleja wartości do literału stringa', () => {
  const znalezione = [];
  SRC.split('\n').forEach((linia, i) => {
    // on<zdarzenie>="…('${…" — interpolacja wewnątrz apostrofów lub cudzysłowów w handlerze
    if (/\son[a-z]+="[^"]*\(\s*['`][^"]*\$\{/.test(linia)) znalezione.push(`${i + 1}: ${linia.trim()}`);
  });
  assert.deepEqual(znalezione, [], `wartość w inline handlerze — przenieś do data-* i użyj delegacji:\n${znalezione.join('\n')}`);
});
