const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  zbudujMarkery, wykryjIncydent, markeryZPliku, rozbijStrumien, PLIK_MARKEROW,
} = require('./incident-markers');

// Strumien stream-json skladany z pojedynczych zdarzen — tak wyglada stdout agenta.
const zdarzenie = (o) => JSON.stringify(o);
const toolUse = (command) => zdarzenie({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});
const toolResult = (content, is_error = false) => zdarzenie({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content, is_error }] },
});
const wypowiedz = (text) => zdarzenie({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const wynikKoncowy = (result) => zdarzenie({ type: 'result', subtype: 'success', result });

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

// Ten sam incydent w strumieniu stream-json: komenda jako realne wywolanie Bash.
test('wykryjIncydent: realne wywolanie rm w tool_use jest lapane w strumieniu', () => {
  const m = zbudujMarkery({ workspaceDir: '/home/user/vault' });
  const strumien = [
    zdarzenie({ type: 'system', subtype: 'init', cwd: '/home/user/vault' }),
    toolUse('rm -rf /home/user/vault/Zadania/w_trakcie'),
    toolResult('(Bash completed with no output)'),
    wynikKoncowy('Zrobione: 0 zadan.'),
  ].join('\n');

  assert.match(wykryjIncydent(strumien, m), /\(akcja\)$/, 'komunikat ma nazwac powierzchnie');
});

// Regresja 10.10.2026: alarm o incydencie przy runie, ktory niczego nie usunal.
// Job przegladu pamieci czyta zrzut poprzednich rozmow, a te cytowaly komende z opisu
// awarii z 06.10 — wzorzec sciezkowy trafial w dokumentacje, nie w dzialanie.
test('wykryjIncydent: cytat komendy w wyniku narzedzia i w tekscie to NIE incydent', () => {
  const m = zbudujMarkery({ workspaceDir: '/home/claude/vault' });

  const zrzutSesji = [
    zdarzenie({ type: 'system', subtype: 'init', cwd: '/home/claude/vault' }),
    toolUse('cat /tmp/mu-dialog.txt'),
    toolResult('Powod (06.10.2026): job 8 Pulsa wykonal `rm -rf /home/claude/vault/Zadania/w_trakcie`'
      + ' pod opisem "noop safety check" i zabral 61 zadan.'),
    wypowiedz('Opisana w dokumentacji awaria z 06.10 nie wymaga dzialania.'),
    wynikKoncowy('Memory Update: timestamp przesuniety, zero zmian merytorycznych.'),
  ].join('\n');

  assert.equal(wykryjIncydent(zrzutSesji, m), null, 'cytat w wyniku narzedzia nie moze alarmowac');

  // To samo dla samooskarzenia: zrzut dawnej rozmowy nie jest wyznaniem z tego runu.
  const cudzeWyznanie = [
    toolUse('grep -n "blad" Notatki/retro.md'),
    toolResult('2026-09-01: popelnilem powazny blad przy archiwizacji, opis w retro'),
    wynikKoncowy('Przeczytane, bez zmian.'),
  ].join('\n');
  assert.equal(wykryjIncydent(cudzeWyznanie, m), null, 'cytat wyznania nie moze alarmowac');

  // Ale wyznanie wypowiedziane przez model w TYM runie — alarm.
  const wlasneWyznanie = [toolUse('ls'), wypowiedz('Popelnilem powazny blad: nadpisalem dashboard.')].join('\n');
  assert.ok(wykryjIncydent(wlasneWyznanie, m), 'wyznanie modelu musi alarmowac');
});

// Bariera dziala tylko wtedy, gdy o zablokowanej probie dowiemy sie od razu.
test('wykryjIncydent: wywolanie zablokowane przez hook alarmuje (powierzchnia blad)', () => {
  const m = zbudujMarkery({ workspaceDir: '/home/claude/vault' });
  const strumien = [
    toolUse('rm -rf /home/claude/vault/Notatki'),
    toolResult('ZABLOKOWANE przez destructive-guard: rm -rf /home/claude/vault/Notatki', true),
    wynikKoncowy('Nie udalo sie wykonac kroku 3.'),
  ].join('\n');
  assert.ok(wykryjIncydent(strumien, m));
});

test('rozbijStrumien: zwraca null dla zwyklego tekstu, powierzchnie dla stream-json', () => {
  assert.equal(rozbijStrumien('Kontrola spojnosci — 2 problemy'), null);

  const p = rozbijStrumien([
    toolUse('ls -la'),
    toolResult('plik.md'),
    toolResult('brak dostepu', true),
    wypowiedz('Gotowe.'),
    wynikKoncowy('Raport.'),
  ].join('\n'));

  assert.match(p.akcja, /ls -la/);
  assert.match(p.wynik, /plik\.md/);
  assert.match(p.blad, /brak dostepu/);
  assert.match(p.tekst, /Gotowe/);
  assert.match(p.tekst, /Raport/);
  assert.doesNotMatch(p.akcja, /plik\.md/, 'wynik narzedzia nie moze wyciekac do akcji');
});

// Job odpalajacy skrypt (nie agenta) nie produkuje stream-json — detekcja musi dzialac
// jak przed zmiana, czyli na calym tekscie.
test('wykryjIncydent: stdout niebedacy strumieniem jest sprawdzany w calosci', () => {
  const m = zbudujMarkery({ workspaceDir: '/home/user/vault' });
  assert.ok(wykryjIncydent('skrypt porzadkowy: rm -rf /home/user/vault/stare', m));
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

test('markeryZPliku: prefiks zaweza powierzchnie, dwukropek w wyrazeniu zostaje nietknięty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markery-'));
  fs.writeFileSync(path.join(dir, PLIK_MARKEROW),
    'akcja: chmod -R 000 /srv\n'
    + 'tekst, blad: skasowalem baze\n'
    + 'ALARM: stan krytyczny\n');

  const m = markeryZPliku(dir);
  assert.deepEqual(m.map((x) => x.powierzchnie), [
    ['akcja'],
    ['tekst', 'blad'],
    ['wynik', 'blad', 'tekst'], // "ALARM:" nie jest nazwa powierzchni — caly tekst to wzorzec
  ]);
  assert.equal(m[2].re.source, 'ALARM: stan krytyczny');

  // Marker na `akcja` nie reaguje na cytat w wyniku narzedzia.
  assert.equal(wykryjIncydent(toolResult('w logu bylo chmod -R 000 /srv'), m), null);
  assert.ok(wykryjIncydent(toolUse('chmod -R 000 /srv'), m));
});

test('markeryZPliku: brak pliku = pusta lista, bez wyjatku', () => {
  assert.deepEqual(markeryZPliku('/nie/ma/takiego/katalogu'), []);
});
