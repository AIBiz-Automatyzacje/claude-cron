# Plan: Ułatwienie instalacji Pulsa

**Branch:** `feature/ulatwienie-instalacji`
**Ostatnia aktualizacja:** 2026-06-29

## Cel i zakres

Usunięcie największej bariery wejścia w instalacji Pulsa w dwóch krokach:
1. **#1 Migracja DB (globalna, Mac/Win/VPS):** `better-sqlite3` → wbudowany `node:sqlite` (`DatabaseSync`) → koniec natywnej kompilacji i wymogu **3-5 GB VS Build Tools** na Windows.
2. **#2 Smart setup (lokalny, Mac/Win):** portable Node w `.node/`, absolutna ścieżka Node w hooku autostartu, cienki bootstrap per-OS + wspólny `setup.mjs`.

Migracja objęta guardami fail-fast (wersja Node + smoke-test typów DB) i zabezpieczeniem VPS (nocny auto-update nie restartuje serwisu na niekompatybilnym Node).

### Poza zakresem
- Pakowanie `.dmg`/`.exe` (płatne certyfikaty).
- Automatyzacja loginu/subskrypcji Claude (R9 to tylko handoff).
- Zmiana logiki domenowej (cron/webhook/polling) — migracja jest pod-warstwowa.
- Zmiana harmonogramu auto-update VPS (zostaje `0 2 * * *`).

## Śledzenie wymagań

- **R1.** `lib/db.js` na `node:sqlite`; suite PASS bez regresji.
- **R2.** `better-sqlite3` usunięte z deps; `engines` z poprawnym oknem Node.
- **R3.** Fail-fast z czytelnym komunikatem na zbyt starym Node.
- **R4.** Smoke-test typów po `migrate()` (agregaty → `number`, nie `BigInt`).
- **R5.** `install-vps.sh` zapewnia Node ≥ minimum; cron nie restartuje na niekompatybilnym Node.
- **R6.** Portable Node w `.node/` — jeden mechanizm Mac/Win.
- **R7.** Hook woła Node po absolutnej ścieżce (spawn + settings.json).
- **R8.** Cienki bootstrap per-OS + wspólny `setup.mjs`.
- **R9.** Claude Code jako warunek wstępny z handoffem (setup nie instaluje Claude).
- **R10.** Sprzątanie martwych skryptów + przepięcie package.json + uninstall + README.

## Fazy i Implementation Units

### Faza 1 — Migracja DB (globalna) + guardy + VPS *(ląduje pierwsza, samodzielnie)*

**Unit 1 — Migracja `lib/db.js` na `node:sqlite` + `package.json`** · R1, R2 · zależności: brak · **M** · feature-builder-data
Import `DatabaseSync`, `pragma()`→`exec()`, usunięcie `better-sqlite3` z deps, `engines: ">=22.13 <25"`.
Kryteria: suite PASS bez regresji; `better-sqlite3` znika; pragmy przepisane.

**Unit 2 — Guardy startowe (wersja Node + smoke-test typów + wyciszenie ExperimentalWarning)** · R3, R4 · zależności: Unit 1 · **M** · feature-builder-data
`lib/runtime-guard.js` (self-executing, pierwszy w server.js), smoke-test po `migrate()`, flaga `--disable-warning=ExperimentalWarning` w `start`.
Kryteria: fail-fast z czytelnym komunikatem na starym Node; typed error przy złych typach; logi bez warninga.

**Unit 3 — Zabezpieczenie VPS** · R5 · zależności: Unit 1 · **S/M** · feature-builder-data
`install-vps.sh`: próg Node z `<18` na `<22.13`, usunięcie build-tools dla b-s3 (po weryfikacji), flaga w `ExecStart`, cron-guard przed restartem na niekompatybilnym Node.
Kryteria: próg podniesiony; cron robi `git pull` ale nie restartuje na złym Node.

### Faza 2 — Smart setup lokalny (Mac/Win) + sprzątanie

**Unit 4 — Portable Node bootstrap (`install.sh`/`install.ps1`)** · R6, R8 · zależności: brak · **M/L** · feature-builder-data
Pobranie pinowanego Node z `nodejs.org/dist`, weryfikacja `SHASUMS256`, rozpakowanie do `.node/`, przekazanie do `setup.mjs`. Detect-and-touch-only-missing.
Kryteria: portable Node bez globalnej instalacji/zmian PATH; weryfikacja sumy.

**Unit 5 — Wspólny `setup.mjs`** · R7, R8, R9 · zależności: Unit 4, Unit 2 · **L** · feature-builder-data
Pytania, hook z absolutną ścieżką Node (+flaga), merge `settings.json` idempotentnie, handoff Claude Code, wywołanie smoke-testu.
Kryteria: hook woła absolutną ścieżkę (nie goły `node`); brak duplikatu w settings; handoff gdy brak `claude`.

**Unit 6 — Sprzątanie skryptów + package.json + uninstall** · R10 · zależności: Unit 4, Unit 5 · **S/M** · feature-builder-data
Usuń martwe `scripts/install-macos.sh`/`install-windows.ps1`, przepnij `install:mac`/`install:win`, zaktualizuj uninstall pod nowy layout (confirm-before-delete `.node/`).
Kryteria: martwe skrypty usunięte; package.json przepięty; uninstall czysto cofa nowy layout.

**Unit 7 — README** · R10 · zależności: Unit 4-6 · **S** · feature-builder-data
Nowy flow instalacji, usunięcie wymogu VS Build Tools, notka trust/checksum dla `curl|bash`/`irm|iex`.
Kryteria: brak wzmianek build-tools/better-sqlite3; opisany nowy entry point.

## Sekwencjonowanie

- Faza 1 (Unit 1→2→3) niezależna od Fazy 2.
- Faza 2: Unit 4 → Unit 5 → Unit 6 → Unit 7.
- Unit 1 i Unit 4 mogą startować równolegle.

## Ocena ryzyka i mitygacje

- **Windows nietestowany** → portable Node + hook MUSZĄ być odpalone na realnym Windows (Operator checklist Unit 4/5).
- **Próg Node na VPS** → nie usuwać build-tools, jeśli potrzebne przez `koffi`/`pg` (Unit 3 weryfikuje).
- **`defensive: true` od Node 24.14** → ten sam major dev/prod; górna granica `<25`.
- **Backfill flagą `state`** musi przejść po migracji silnika → test parytetu (Unit 1).

## Mierniki sukcesu

- `node --test` (cały suite) PASS bez regresji po migracji.
- Instalacja na czystym Windows bez VS Build Tools.
- Serwer fail-fast z czytelnym komunikatem na Node < 22.13 (zamiast `ERR_UNKNOWN_BUILTIN_MODULE`).

## Źródła
- Requirements doc: (brak — origin to ustalenia, nie `/dev-brainstorm`)
- Plan techniczny: [docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md](../../plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md)
- Dokument źródłowy (ustalenia): [docs/plans/2026-06-25-ulatwienie-instalacji-ustalenia.md](../../plans/2026-06-25-ulatwienie-instalacji-ustalenia.md)
