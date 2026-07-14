---
title: "'close' child_process nie odpala, gdy wnuk dziedziczy stdio po killu rodzica → wyciek slotu współbieżności"
date: 2026-07-14
category: runtime-errors
severity: high
stack:
  - Node.js
  - child_process
tags:
  - child-process
  - spawn
  - stdio
  - process-tree
  - concurrency
  - resource-leak
status: verified
last_verified: 2026-07-14
---

# 'close' nie nadchodzi, gdy wnuk trzyma odziedziczony pipe — wyciek slotu tła

## Symptomy

- Endpoint `/ask` po kilku zapytaniach na stałe odpowiada „⏳ Mam pełne ręce" (wyczerpane 3 sloty tła) mimo że żaden run już nie działa.
- Stan wraca do normy dopiero po restarcie serwera.
- Run w DB bywa domknięty (przez bezpiecznik `ASK_MAX_MS` lub reaper), ale in-memory licznik slotów tła nigdy nie jest zwalniany.
- Zdarzenie `'close'` na `ChildProcess` po prostu nie przychodzi — mimo że proces-rodzic (`claude`) już nie żyje.

## Root Cause

`'close'` na `ChildProcess` odpala dopiero, gdy **wszystkie deskryptory stdio potoku zamkną się** — nie gdy proces umrze. CLI `claude` spawnuje proces-wnuka, który **dziedziczy** `stdout`/`stderr` rodzica. `killProcessTree` na Unix (`kill(-pid)` / kill bezpośredniego dziecka) ubija tylko rodzica; wnuk żyje dalej i trzyma otwarty koniec pipe'a. Dopóki wnuk nie zamknie deskryptora, `'close'` nie nadejdzie **nigdy**. Cała logika zwolnienia slotu wisiała wyłącznie na `'close'` → slot wyciekał na zawsze (3 takie zdarzenia = permanentna blokada do restartu).

Kluczowa różnica semantyczna Node:
- **`'exit'`** — odpala ZAWSZE, gdy proces-dziecko umiera (kod/sygnał), niezależnie od stdio.
- **`'close'`** — odpala, gdy zamknięte zostaną stdio-streamy dziecka; przy odziedziczonych deskryptorach żyjącego wnuka może nie odpalić wcale.

## Rozwiązanie

Nie domykaj cyklu życia procesu wyłącznie na `'close'`. Dodaj siatkę bezpieczeństwa na `'exit'` z krótką karencją, dając `'close'` pierwszeństwo (pełny, spłukany stdout), a wspólną ścieżkę domknięcia zabezpiecz flagą `settled` (idempotencja — oba zdarzenia mogą przyjść).

```js
// Karencja: streamy flushują ogon stdout PO 'exit', więc normalnie domyka 'close'.
// Gdy wnuk trzyma pipe, 'close' nie nadejdzie — 'exit' + timer są jedyną drogą.
const EXIT_CLOSE_GRACE_MS = 2000;

let settled = false;          // 'close'/'exit'/'error' domykają RAZ
let exitGraceTimerId = null;

function settle(result) {
  if (settled) return;
  settled = true;
  clearTimeout(exitGraceTimerId);
  finalize(result);
  releaseBackgroundSlot();    // zwolnienie slotu żyje w settle(), nie w 'close'
}

proc.on('close', (code) => settle({ /* pełny stdout */ }));

proc.on('exit', (code) => {
  if (settled) return;
  // 'close' dostaje pierwszeństwo; po karencji domykamy tym, co spłynęło.
  exitGraceTimerId = setTimeout(() => settle({ /* stdout as-is */ }), EXIT_CLOSE_GRACE_MS);
  exitGraceTimerId.unref();   // timer nie trzyma event-loopu przy życiu
});

proc.on('error', (err) => settle({ status: 'failed', errorMsg: String(err) }));
```

Uwaga na `unref()` — bez niego zaległy timer karencji trzymałby proces przy życiu. Guard `settled` czyni timer no-opem w normalnej ścieżce (gdy `'close'` wygrał wyścig).

## Komendy diagnostyczne

```bash
# Test regresyjny: atrapa CLI spawnuje wnuka dziedziczącego stdio i kończy się.
node --test lib/ask.test.js

# Podejrzenie wyciekających slotów — czy 'close' faktycznie przychodzi:
# w atrapie: const child = spawn(process.execPath, ['-e','setTimeout(()=>{},60000)'],
#   { stdio: 'inherit' }); potem proces-rodzic kończy się od razu.
```

## Zapobieganie

- Nie wieszaj zwolnienia zasobu (slot, licznik, lock) wyłącznie na `'close'`, gdy spawnowany proces może mieć potomków dziedziczących stdio. Domykaj cykl na `'exit'` (przychodzi zawsze) z karencją dla `'close'`.
- Wspólną ścieżkę domknięcia rób idempotentną (flaga `settled`) — `close`, `exit` i `error` mogą przyjść w dowolnej kombinacji.
- `killProcessTree` na Unix nie gwarantuje śmierci wnuków ani zamknięcia odziedziczonych deskryptorów — nie zakładaj, że zabicie rodzica zamknie pipe.
- Każdy timer domykający owijaj `unref()`, żeby nie blokował wygaszenia procesu.

## Powiązane

- `docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md` — pokrewny motyw: domknięcie stanu na świeżym odczycie DB, nie na stale-owym obiekcie/zdarzeniu.

## Kontekst

- Plik: `lib/ask.js` (`executeAsk`), naprawa w commicie `c157bc0` (faza 2 ask-endpoint).
- Środowisko: asystent głosowy Puls, run „teczki" odczepiony w tło; sloty współbieżności trzymane in-memory (świadomie zero agregatów SQL — pułapka BigInt `node:sqlite`).
- Wykryte podczas review fazy 2 (P2), zweryfikowane testem: atrapa spawnuje wnuka dziedziczącego `stdio` i kończy się — bez fixu `'close'` nie nadchodzi, slot nie wraca; po fixie cykl domyka `exit`-grace.
