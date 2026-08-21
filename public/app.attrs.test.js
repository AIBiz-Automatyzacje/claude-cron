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

// on<zdarzenie>="…" zawierające literał stringa z interpolacją — w DOWOLNYM argumencie,
// nie tylko pierwszym: `onclick="fn(${id}, '${nazwa}')"` jest równie podatne jak
// `onclick="fn('${nazwa}')"`, a wzorzec zakotwiczony zaraz za nawiasem przepuszczał ten
// pierwszy zapis. Stała jest WSPÓLNA dla obu testów niżej: skaner i jego własny test
// muszą sprawdzać dokładnie ten sam wzorzec, inaczej weryfikacja niczego nie gwarantuje.
const INTERPOLACJA_W_HANDLERZE = /\son[a-z]+="[^"]*\([^"]*['`][^"]*\$\{/;

test('żaden inline handler nie wkleja wartości do literału stringa', () => {
  const znalezione = [];
  SRC.split('\n').forEach((linia, i) => {
    if (INTERPOLACJA_W_HANDLERZE.test(linia)) znalezione.push(`${i + 1}: ${linia.trim()}`);
  });
  assert.deepEqual(znalezione, [], `wartość w inline handlerze — przenieś do data-* i użyj delegacji:\n${znalezione.join('\n')}`);
});

// Bariera, która nie sprawdza samej siebie, jest zielona także wtedy, gdy przestała cokolwiek
// wykrywać (literówka w klasie znaków, nieudana edycja wzorca). Te przypadki pilnują, że
// skaner nadal łapie to, co ma łapać — i nadal przepuszcza to, co jest bezpieczne.
test('skaner inline handlerów faktycznie wykrywa podatne zapisy', () => {
  const podatne = [
    `<button onclick="filtruj('\${nazwa}')">x</button>`,
    `<button onclick="filtruj(\${id}, '\${nazwa}')">x</button>`,  // interpolacja w DALSZYM argumencie
    `<button onmouseover="pokaz(\`\${tekst}\`)">x</button>`,     // backtick zamiast apostrofu
  ];
  for (const linia of podatne) {
    assert.ok(INTERPOLACJA_W_HANDLERZE.test(linia), `niewykryty podatny zapis: ${linia}`);
  }
});

test('skaner inline handlerów nie zgłasza zapisów bezpiecznych', () => {
  const bezpieczne = [
    `<button onclick="triggerJob(\${j.id})">x</button>`,           // liczbowe id, brak literału do zamknięcia
    `<button data-name="\${escAttr(nazwa)}" onclick="filtruj(this.dataset.name)">x</button>`,
    `<button onclick="clearRunsFilter()">x</button>`,
  ];
  for (const linia of bezpieczne) {
    assert.equal(INTERPOLACJA_W_HANDLERZE.test(linia), false, `fałszywy alarm: ${linia}`);
  }
});
