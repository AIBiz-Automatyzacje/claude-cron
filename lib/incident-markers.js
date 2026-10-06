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
// Markery domyślne są ogólne (ścieżka workspace'u + frazy, którymi model opisuje własny
// poważny błąd). Instalacja może dołożyć swoje — nazwy własnych hooków, skilli,
// kontroli — w pliku `data/incident-markers.txt`, po jednym wyrażeniu na linię.
// Plik jest opcjonalny i leży w `data/` (poza gitem), więc lokalne markery nie
// konfliktują przy aktualizacji kodu.

const fs = require('fs');
const path = require('path');

const PLIK_MARKEROW = 'incident-markers.txt';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Markery niezależne od instalacji.
function domyslneMarkery(workspaceDir) {
  const markery = [
    // Model przyznaje się do poważnego błędu — w praktyce najmocniejszy sygnał,
    // bo pojawia się też przy szkodach, których nie przewidzieliśmy wzorcem.
    /pope[łl]ni[łl]em powa[żz]ny b[łl][ąa]d/i,
    /I made a serious (mistake|error)/i,
    /deleted the entire/i,
    /nie da si[ęe] odzyska[ćc]/i,
    /(unrecoverable|cannot be recovered)/i,
  ];
  // Rekurencyjne usuwanie wewnątrz workspace'u — ścieżka bierze się z konfiguracji,
  // nie z kodu, więc wzorzec działa na każdej instalacji.
  if (workspaceDir) {
    markery.unshift(new RegExp('rm\\s+-[a-zA-Z]*[rR][a-zA-Z]*\\s+' + escapeRe(workspaceDir)));
  }
  return markery;
}

// Markery lokalne z data/incident-markers.txt. Linia pusta i rozpoczęta `#` = komentarz.
// Błędne wyrażenie pomijamy z ostrzeżeniem — jedna literówka w pliku nie może wywalić
// całej ścieżki powiadomień.
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
    try {
      out.push(new RegExp(l, 'i'));
    } catch (err) {
      logger.error(`[incident-markers] pomijam niepoprawne wyrażenie "${l}": ${err.message}`);
    }
  }
  return out;
}

function zbudujMarkery({ workspaceDir, dataDir, logger } = {}) {
  return [...domyslneMarkery(workspaceDir), ...markeryZPliku(dataDir, logger)];
}

// Zwraca źródło pasującego wyrażenia (do komunikatu) albo null.
function wykryjIncydent(stdout, markery) {
  if (!stdout || !markery || !markery.length) return null;
  const hit = markery.find((re) => re.test(stdout));
  return hit ? hit.source : null;
}

module.exports = { zbudujMarkery, wykryjIncydent, domyslneMarkery, markeryZPliku, PLIK_MARKEROW };
