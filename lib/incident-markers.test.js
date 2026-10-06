const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { zbudujMarkery, wykryjIncydent, markeryZPliku, PLIK_MARKEROW } = require('./incident-markers');

// Regresja 06.10.2026: job przegladu zadan usunal rekurencyjnie katalog roboczy,
// opisal to w raporcie, wyszedl exit code 0 -> kanal wyslal SUKCES.
test('wykryjIncydent: rekurencyjne rm na workspace i samooskarzenie modelu', () => {
  const m = zbudujMarkery({ workspaceDir: '/home/user/vault' });

  const trafienia = [
    '{"command":"rm -rf /home/user/vault/Zadania/w_trakcie"}',
    'rm -r /home/user/vault/notes',
    'I made a serious mistake and deleted the entire directory',
    'Popelnilem powazny blad przy archiwizacji',
    'tych plikow nie da sie odzyskac',
  ];
  for (const t of trafienia) assert.ok(wykryjIncydent(t, m), 'mial zglosic: ' + t.slice(0, 40));

  const czyste = [
    'RAPORT: 61 pozycji, kalendarz 18 wydarzen',
    'rm -rf /tmp/scratch/restore',            // poza workspace'em
    'rm /home/user/vault/notes/jeden-plik.md', // bez rekurencji
  ];
  for (const t of czyste) assert.equal(wykryjIncydent(t, m), null, 'falszywy alarm: ' + t.slice(0, 40));
});

test('zbudujMarkery: bez workspaceDir dziala, ale nie ma wzorca sciezkowego', () => {
  const m = zbudujMarkery({});
  assert.ok(m.length > 0);
  assert.equal(wykryjIncydent('rm -rf /cokolwiek', m), null);
  assert.ok(wykryjIncydent('I made a serious error', m));
});

test('markeryZPliku: komentarze i puste linie pomijane, bledne wyrazenie nie wywala sciezki', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markery-'));
  fs.writeFileSync(path.join(dir, PLIK_MARKEROW),
    '# komentarz\n\nZABLOKOWANE przez wlasny-hook\n[niepoprawny(\nKONTROLA STANU[^\\n]*NIE wykonana\n');

  const bledy = [];
  const m = markeryZPliku(dir, { error: (e) => bledy.push(e) });

  assert.equal(m.length, 2, 'dwa poprawne wyrazenia');
  assert.equal(bledy.length, 1, 'jedno ostrzezenie o literowce');
  assert.ok(wykryjIncydent('ZABLOKOWANE przez wlasny-hook: rm -rf', m));
  assert.ok(wykryjIncydent('KONTROLA STANU: kontrola NIE wykonana', m));
});

test('markeryZPliku: brak pliku = pusta lista, bez wyjatku', () => {
  assert.deepEqual(markeryZPliku('/nie/ma/takiego/katalogu'), []);
});
