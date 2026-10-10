// Wykrywanie incydentu w wyniku runu — eskalacja powiadomienia z sukcesu na alarm.
//
// Problem: status runu liczy się WYŁĄCZNIE z exit code (executor: `code === 0 ?
// 'success' : 'failed'`). Agent, który wyrządził szkodę i zakończył się zerem, dostaje
// powiadomienie o sukcesie. Zdarzyło się 06.10.2026: zaplanowany job przeglądu zadań
// usunął rekurencyjnie katalog roboczy (61 plików), sam to opisał w swoim raporcie,
// wyszedł z exit code 0 — i kanał powiadomień wysłał potwierdzenie sukcesu. Nikt nie
// zauważył do następnej sesji.
//
// Status w bazie zostaje zgodny z exit code: nie udajemy, że proces padł, więc logika
// retry (countRecentFailedRuns) jest nietknięta. Eskalowane jest samo POWIADOMIENIE.
//
// POWIERZCHNIE (10.10.2026). Marker nie jest już testowany na całym stdout, bo strumień
// `--output-format stream-json` zawiera nie tylko to, co agent ZROBIŁ, ale też wszystko,
// co przeczytał: treść plików, wyniki greps, zrzuty poprzednich rozmów. Wzorzec ścieżkowy
// (`rm -rf <workspace>`) trafiał więc w CYTAT komendy — w instalacji Krzysztofa w opis
// incydentu z 06.10 wklejony do dokumentacji i do zrzutu sesji, który job przeglądu
// pamięci czyta z założenia. Alarm, który wyje przy opisie starej awarii, zostanie po
// trzecim razie zignorowany, a wtedy nie zadziała przy prawdziwej.
//
// Dlatego każdy marker deklaruje, w której części strumienia go szukać:
//   akcja  — pola `input` bloków tool_use, czyli komendy, które agent faktycznie wywołał
//   wynik  — wyniki narzędzi i rekordy system (tu trafiają komunikaty hooków)
//   blad   — wyniki narzędzi z is_error, czyli m.in. zablokowane wywołania
//   tekst  — własne wypowiedzi modelu i pole `result`, czyli to, co agent sam napisał
//
// Wzorzec ścieżkowy siedzi na `akcja` — cytat w cudzym tekście go nie uruchomi, a
// prawdziwy incydent z 06.10 uruchomiłby, bo tam `rm -rf` było realnym wywołaniem Bash.
// Samooskarżenia modelu siedzą na `tekst` (w `wynik` wpadałby zrzut dawnej rozmowy).
//
// Gdy stdout nie jest strumieniem stream-json (job odpalający skrypt, nie agenta),
// wszystkie powierzchnie są całym tekstem — zachowanie identyczne jak przed zmianą.
//
// Markery domyślne są ogólne (ścieżka workspace'u + frazy, którymi model opisuje własny
// poważny błąd). Instalacja może dołożyć swoje — nazwy własnych hooków, skilli,
// kontroli — w pliku `data/incident-markers.txt`, po jednym wyrażeniu na linię.
// Plik jest opcjonalny i leży w `data/` (poza gitem), więc lokalne markery nie
// konfliktują przy aktualizacji kodu.

const fs = require('fs');
const path = require('path');

const PLIK_MARKEROW = 'incident-markers.txt';

const POWIERZCHNIE = ['akcja', 'wynik', 'blad', 'tekst'];

// Markery z pliku bez prefiksu: wszystko poza `akcja`. Distinctive frazy w rodzaju
// "ZABLOKOWANE przez destructive-guard" są bezpieczne w wynikach narzędzi, a zawężenie
// ich do jednej powierzchni odebrałoby zasięg markerom, które już działają.
const DOMYSLNE_POWIERZCHNIE_Z_PLIKU = ['wynik', 'blad', 'tekst'];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function marker(re, powierzchnie) {
  return { re, powierzchnie };
}

// Markery niezależne od instalacji.
function domyslneMarkery(workspaceDir) {
  const markery = [
    // Model przyznaje się do poważnego błędu — w praktyce najmocniejszy sygnał,
    // bo pojawia się też przy szkodach, których nie przewidzieliśmy wzorcem.
    // Tylko `tekst`: w wynikach narzędzi to bywa zrzut dawnej rozmowy, nie wyznanie.
    marker(/pope[łl]ni[łl]em powa[żz]ny b[łl][ąa]d/i, ['tekst']),
    marker(/I made a serious (mistake|error)/i, ['tekst']),
    marker(/deleted the entire/i, ['tekst']),
    marker(/nie da si[ęe] odzyska[ćc]/i, ['tekst']),
    marker(/(unrecoverable|cannot be recovered)/i, ['tekst']),
  ];
  // Rekurencyjne usuwanie wewnątrz workspace'u — ścieżka bierze się z konfiguracji,
  // nie z kodu, więc wzorzec działa na każdej instalacji. `akcja` + `blad`: realne
  // wywołanie albo wywołanie zablokowane przez hook, nigdy cytat w cudzym tekście.
  if (workspaceDir) {
    markery.unshift(marker(
      new RegExp('rm\\s+-[a-zA-Z]*[rR][a-zA-Z]*\\s+' + escapeRe(workspaceDir)),
      ['akcja', 'blad'],
    ));
  }
  return markery;
}

// Markery lokalne z data/incident-markers.txt. Linia pusta i rozpoczęta `#` = komentarz.
// Opcjonalny prefiks `akcja:`, `wynik:`, `blad:`, `tekst:` (także lista `akcja,blad:`)
// zawęża powierzchnię. Błędne wyrażenie pomijamy z ostrzeżeniem — jedna literówka
// w pliku nie może wywalić całej ścieżki powiadomień.
function markeryZPliku(dataDir, logger = console) {
  const sciezka = path.join(dataDir || '', PLIK_MARKEROW);
  let tekst;
  try {
    tekst = fs.readFileSync(sciezka, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const linia of tekst.split('\n')) {
    const l = linia.trim();
    if (!l || l.startsWith('#')) continue;

    let wyrazenie = l;
    let powierzchnie = DOMYSLNE_POWIERZCHNIE_Z_PLIKU;
    // Prefiks rozpoznajemy tylko wtedy, gdy KAŻDA nazwa przed dwukropkiem jest znaną
    // powierzchnią — inaczej `foo: bar` w wyrażeniu regularnym zostałby zjedzony.
    const m = /^([a-z, ]+):\s*(.+)$/.exec(l);
    if (m) {
      const nazwy = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (nazwy.length && nazwy.every((n) => POWIERZCHNIE.includes(n))) {
        powierzchnie = nazwy;
        wyrazenie = m[2];
      }
    }

    try {
      out.push(marker(new RegExp(wyrazenie, 'i'), powierzchnie));
    } catch (err) {
      logger.error(`[incident-markers] pomijam niepoprawne wyrażenie "${l}": ${err.message}`);
    }
  }
  return out;
}

function zbudujMarkery({ workspaceDir, dataDir, logger } = {}) {
  return [...domyslneMarkery(workspaceDir), ...markeryZPliku(dataDir, logger)];
}

function dopiszBlok(cel, blok) {
  if (!blok) return;
  if (typeof blok === 'string') { cel.push(blok); return; }
  cel.push(JSON.stringify(blok));
}

// Rozbija strumień stream-json na powierzchnie. Zwraca null, gdy stdout nie wygląda
// na strumień zdarzeń — wtedy wołający testuje markery na całym tekście.
function rozbijStrumien(stdout) {
  const linie = String(stdout).split('\n');
  const out = { akcja: [], wynik: [], blad: [], tekst: [] };
  let zdarzen = 0;

  for (const linia of linie) {
    const l = linia.trim();
    if (!l.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object' || !o.type) continue;
    zdarzen++;

    if (o.type === 'result') { dopiszBlok(out.tekst, o.result); continue; }
    // Rekordy system (init, hook_started, hook_response) niosą komunikaty hooków —
    // tam trafia m.in. odmowa z PreToolUse.
    if (o.type === 'system') { out.wynik.push(JSON.stringify(o)); continue; }

    const bloki = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of bloki) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') dopiszBlok(out.akcja, b.input);
      else if (b.type === 'text') dopiszBlok(out.tekst, b.text);
      else if (b.type === 'tool_result') dopiszBlok(b.is_error ? out.blad : out.wynik, b.content);
    }
    // Wypowiedź modelu bywa zwykłym stringiem zamiast listy bloków.
    if (!bloki.length && o.message && typeof o.message.content === 'string') {
      dopiszBlok(o.message.role === 'assistant' ? out.tekst : out.wynik, o.message.content);
    }
  }

  if (!zdarzen) return null;
  return Object.fromEntries(POWIERZCHNIE.map((p) => [p, out[p].join('\n')]));
}

// Zwraca źródło pasującego wyrażenia wraz z powierzchnią (do komunikatu) albo null.
// Nazwa powierzchni jest w komunikacie celowo: przy alarmie 10.10.2026 nie dalo sie
// ustalic, czy marker trafil w komende, czy w cytat, bo baza trzyma tylko ostatnie
// 50 KB stdout — a dopasowanie bylo w odcietej czesci.
function wykryjIncydent(stdout, markery) {
  if (!stdout || !markery || !markery.length) return null;

  const powierzchnie = rozbijStrumien(stdout);
  const tekstDla = (nazwa) => (powierzchnie ? powierzchnie[nazwa] : String(stdout));

  for (const m of markery) {
    // Markery podane jako goły RegExp (starsze wywołania, testy) — cały tekst.
    const re = m instanceof RegExp ? m : m.re;
    const gdzie = m instanceof RegExp || !m.powierzchnie ? POWIERZCHNIE : m.powierzchnie;
    for (const nazwa of gdzie) {
      const t = tekstDla(nazwa);
      if (t && re.test(t)) return powierzchnie ? `${re.source} (${nazwa})` : re.source;
    }
  }
  return null;
}

module.exports = {
  zbudujMarkery,
  wykryjIncydent,
  domyslneMarkery,
  markeryZPliku,
  rozbijStrumien,
  PLIK_MARKEROW,
  POWIERZCHNIE,
};
