---
data: 2026-06-25
typ: ustalenia / pre-plan
status: zwalidowane (sesja /zroastuj-mnie)
temat: Ułatwienie instalacji Pulsa dla użytkownika niepewnego w terminalu
---

# Ułatwienie instalacji — ustalenia

Rekord decyzji z sesji walidacyjnej (`/zroastuj-mnie`). Każdy punkt został przepytany
scenariuszem i zaakceptowany. To NIE jest jeszcze plan z Implementation Units — żeby
go takim zrobić, odpal `/dev-plan` na tym dokumencie.

## Kontekst wyjściowy

- **Problem:** instalacja wymaga ~6-10 kroków terminalowych, ręcznej instalacji prereqs,
  a na Windows **3-5 GB VS Build Tools** (bo `better-sqlite3` kompiluje się natywnie).
- **Odrzucone:** pakowanie jako `.dmg`/`.exe` (#4) — wymaga płatnych certyfikatów
  (Apple Developer $99/rok, Windows code-signing ~$200-400/rok), inaczej Gatekeeper/SmartScreen
  straszy. Terminalowy one-liner (`curl|bash` / `irm|iex`) **omija te ostrzeżenia za darmo**,
  bo nic nie ląduje na dysku jako podpisywalny plik wykonywalny.

## Zakres i target

1. **Target:** istniejący użytkownik Claude Code, który nie czuje się pewnie w terminalu.
   NIE „osoba zupełnie nietechniczna" — login Claude (interaktywny OAuth w przeglądarce)
   i subskrypcja to kroki, których żaden installer nie zautomatyzuje.
2. **Dwa różne zasięgi platformowe:**
   - **#1 (migracja DB) — GLOBALNE:** Mac / Windows / VPS (Linux). `lib/db.js` jest jeden,
     wspólny dla wszystkich.
   - **#2 (smart setup) — LOKALNE:** tylko Mac / Windows. VPS ma własny autonomiczny installer
     (root na serwerze, nie „niepewny user").

## #1 — Migracja DB (globalna)

3. **`better-sqlite3` → `node:sqlite`** (wbudowany w Node). Diff ~4 linie w `lib/db.js`:
   ```js
   // PRZED
   const Database = require('better-sqlite3');
   db = new Database(target);
   db.pragma('journal_mode = WAL');
   db.pragma('foreign_keys = ON');
   // PO
   const { DatabaseSync } = require('node:sqlite');
   db = new DatabaseSync(target);
   db.exec('PRAGMA journal_mode = WAL');
   db.exec('PRAGMA foreign_keys = ON');
   ```
   Reszta API (`prepare().get()/.all()/.run()`, `.exec()`, `lastInsertRowid`, `changes`,
   `:memory:`, `.close()`) identyczna.
   - **Zweryfikowane lokalnie (Mac, Node 22.22.3):** `db.test.js` 20/20, pełny suite 84/84.
     Działają `ROW_NUMBER() OVER`, `ON DELETE CASCADE`, `PRAGMA table_info`,
     `datetime('now','localtime')`, WAL.
   - **`koffi` to non-issue:** używa `--prebuild` (zero kompilacji), wozi gotowe `.node`
     m.in. dla `darwin_arm64`, `darwin_x64`, `win32_x64`. Po migracji projekt **nie ma
     ani jednego natywnie kompilowanego modułu** → koniec VS Build Tools na Windows.
4. **Przypięte okno wersji Node:** `engines: ">=22.5 <25"`. Installer instaluje **konkretną
   przetestowaną LTS, NIE `latest`** (ochrona przed zmianą experimental API w przyszłym Node).
   Plus **smoke-test typów na starcie serwera:** po `migrate()` trywialny `SELECT`, sprawdź
   że typy są `number` a nie `BigInt` (patrz ostrzeżenie o `SUM(...)` w
   `docs/completed/migracja-puls-rebrand/review-faza-3.md:61`) → fail fast z czytelnym
   komunikatem zamiast cicho serwować śmieci do frontu.
5. **Obejmuje VPS:** `scripts/install-vps.sh` musi zapewnić Node ≥22.5, a **nocny auto-update
   cron (`git pull` o 6:00, README:379) musi być zabezpieczony** przed restartem serwisu na
   niekompatybilnym Node. Ryzyko bez tego: po merge migracji VPS ze starym Node 18 wstaje na
   `require('node:sqlite')` → `ERR_UNKNOWN_BUILTIN_MODULE` → wszystkie joby 24/7 padają w nocy.

## #2 — Smart setup (lokalny, Mac/Windows)

6. **Wykrywaj-i-dotykaj-tylko-braków** (zamiast bezwarunkowego bootstrapu instalującego wszystko —
   to byłby anty-pattern over-specification/defensive over-engineering). Nie nadpisuj
   systemowego Node usera.
   - **Claude Code = warunek wstępny z łagodnym handoffem:** jeśli brak → setup zatrzymuje się
     z jasnym komunikatem („zainstaluj jedną komendą, uruchom `claude` raz, zaloguj się,
     wróć tu"), **NIE** próbuje instalować Claude sam (login + subskrypcja są interaktywne;
     połowiczna instalacja zostawia usera w gorszym stanie).
7. **Portable Node w folderze projektu** (np. `claude-cron/.node/`) — **jeden mechanizm dla
   obu OS.** Smart setup pobiera pinowaną wersję jako portable (tarball Mac / zip Windows).
   Zalety: zero globalnej instalacji, zero zmian PATH, zero `.zshrc`/profilu PS,
   zero `fnm`/`nvm`, systemowy Node usera nietknięty, identyczna logika Mac+Windows.
   Koszt ~50 MB runtime per instalacja — zaakceptowany.
8. **Absolutna ścieżka Node wypalona w hooka autostartu.** Obecny hook (`setup.sh:202`,
   `setup-windows.ps1:225`) woła **gołe `node`** w detached/non-interactive procesie →
   shimy `fnm`/`nvm` się nie załadują, `node` może wskazać zły/systemowy Node → serwer nie
   wstaje. Fix: rozwiąż absolutną ścieżkę portable Node i wstaw ją na sztywno w `spawn()`
   oraz w komendzie w `settings.json`. (Side-note do sprawdzenia: `caffeinate` wklejany do
   hooka także na Windows — `setup-windows.ps1:233` — to komenda macOS, musi być pod
   guardem `process.platform === 'darwin'`.)

## Architektura skryptów

9. **Cienki bootstrap per-OS + wspólny rdzeń w Node.**
   - **Bootstrap per-OS (natywny shell, minimalny):** `install.sh` (Mac/Linux) +
     `install.ps1` (Windows) — robi *tylko* postawienie portable Node.
   - **Wspólny `setup.mjs` (Node, identyczny na wszystkich OS):** pytania konfiguracyjne,
     generowanie hooka, manipulacja `settings.json`, smoke-test (pkt 4), wypalenie ścieżki
     Node (pkt 8). Eliminuje duplikację logiki bash↔PowerShell (`setup.sh` już dziś woła
     `node -e` do JSON-a, linia 230 — domykamy wzorzec).
   - **Sprzątanie:** usuń martwe `scripts/install-macos.sh` + `scripts/install-windows.ps1`
     (LaunchAgent, README ich nie używa, ale `package.json` `install:mac`/`install:win`
     wciąż na nie wskazuje — przepiąć na nową ścieżkę). Koniec dwóch konkurencyjnych ścieżek
     instalacji dla Maca.

## Ryzyka wykonawcze (flagi na etap implementacji, nie decyzje)

- **Realny test na Windowsie** — wszystko zweryfikowane na Macu. `node:sqlite` jest wbudowane
  w binarkę Node (kompilowane przez zespół Node, nie nas), więc ryzyko niskie, ale autostart
  hook + portable Node trzeba odpalić na prawdziwym Windowsie przed deklaracją „gotowe".
- **Uninstall** — `scripts/uninstall-macos.sh` / `uninstall-windows.ps1` zaktualizować pod
  nowy layout (portable `.node/`, przepięty hook, absolutna ścieżka).
- **Trust `curl|bash` / `irm|iex`** — świadomie akceptowane (standard branżowy, omija
  Gatekeeper/SmartScreen, zero certów). W README dać sprawdzalny checksum / „przeczytaj
  skrypt najpierw".

## Następny krok

Odpal `/dev-plan` na tym dokumencie, żeby rozbić #1 i #2 na Implementation Units z fazowaniem
(najpierw #1 globalne z zabezpieczeniem VPS, potem #2 lokalne).
