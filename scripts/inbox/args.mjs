// Team OS — wspólny parser argumentów skryptów skrzynki (send/reply/close).
//
// Dlaczego osobny plik: dotąd każdy skrypt miał własną kopię tej samej pętli, a kopia
// milczała, gdy argument został rozbity na kawałki. 17.08.2026 zjadło to połowę raportu
// wysłanego z Windowsa: PowerShell 5.1 nie escapuje cudzysłowów w argumencie do natywnego
// exe, więc treść `Lekcja "Asystent AI odbierający telefony"` dotarła do node jako pięć
// osobnych argumentów. Stary parser brał pierwszy kawałek, resztę wyrzucał w kosmos —
// exit 0, JSON z id, wygląda na sukces. Cicha utrata danych.
//
// Kontrakt: każdy argument spoza pary `--klucz wartość` to BŁĄD, nie śmieć do pominięcia.
// Lepiej wywalić się głośno niż wysłać obciętą wiadomość.

export class ArgError extends Error {}

export function parseArgs(argv, { start = 2 } = {}) {
  const out = {};
  for (let i = start; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new ArgError(
        `Nierozpoznany argument: ${JSON.stringify(a)}\n` +
          'Najczęstsza przyczyna: cudzysłowy w treści rozbiły jeden argument na kilka ' +
          '(PowerShell 5.1 nie escapuje " przed przekazaniem do node.exe).\n' +
          'Lekarstwo: przekaż treść plikiem — --content-file <ścieżka> — zamiast --content "...".'
      );
    }
    const key = a.slice(2);
    const value = argv[i + 1];
    // Świadomie NIE odrzucamy wartości zaczynającej się od `--`: treść wiadomości
    // bywa markdownem i legalnie zaczyna się od `---`.
    if (value === undefined) {
      throw new ArgError(`Brak wartości dla argumentu --${key}`);
    }
    out[key] = value;
    i++;
  }
  return out;
}
