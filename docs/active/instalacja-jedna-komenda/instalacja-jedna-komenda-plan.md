# Plan: Instalacja Pulsa jedną komendą (Mac + Windows + VPS)

**Branch:** `feature/one-command-install`
**Ostatnia aktualizacja:** 2026-06-30

## Podsumowanie wykonawcze

Domknięcie „najłatwiejszej instalacji" na trzech torach: **otwórz terminal → wklej 1 komendę →
odpowiedz na pytania → koniec** (serwer sam startuje, przeglądarka sama się otwiera na Mac/Win).
Buduje na zakończonym `ulatwienie-instalacji` (portable Node + `node:sqlite` + `setup.mjs` +
folder-picker — już na `main`).

Docelowe komendy:
- **Mac/Linux:** `curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.sh | bash`
- **Windows:** `irm https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.ps1 | iex`
- **VPS:** `curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash`

## Analiza obecnego stanu

- `install.sh` (Mac/Linux) i `install.ps1` (Windows) — bliźniacze cienkie bootstrapy portable Node
  22.17.0 + weryfikacja SHASUMS256 → handoff do `setup.mjs`. Oba dziś działają **tylko z repo obok**
  (brak trybu dualnego, wymagają `git clone`).
- `setup.mjs` — już cross-platform (`resolveNodeBinPath`, `buildFolderPickerCommand` darwin/win32,
  `detectPortableNodeBin`, generator hooka spawnujący detached serwer). Brak auto-startu serwera i auto-open.
- `scripts/install-vps.sh` — samodzielny instalator VPS (systemd, root, `git clone`), **nie woła `setup.mjs`**.
- **Windows nigdy nie był uruchomiony end-to-end** na realnej maszynie (parent task: Operator checklist, niewykonalne headless).

Poszarpane brzegi: ręczny `git clone` (na Macu odpala Xcode CLT), ręczny start serwera brzydką
wersjonowaną ścieżką, ręczne „otwórz localhost:7777".

## Proponowany stan docelowy

- One-liner pobiera repo **bez `git`** (Mac: tarball+tar; Windows: zip+Expand-Archive) do
  `~/claude-cron` / `$HOME\claude-cron` i kontynuuje. Tryb dualny: uruchomiony z repo obok → lokalnie jak dziś.
- Pytania interaktywne działają pod potokiem (Mac: `/dev/tty`; Windows: weryfikacja GATE 0).
- Po konfiguracji serwer startuje sam; na Mac/Win przeglądarka otwiera się sama + link zawsze wypisany.
- README: trójplatformowe one-linery, usunięty ręczny start.

## Kluczowe decyzje (kontrakty)

1. **Kontrakt bezpieczeństwa danych:** re-run one-linera na istniejącej instalacji **NIE może skasować
   `data/claude-cron.db`**. Preserve-copy atomowo: przenieś `data/` + `.node/` do świeżego repo przed
   swapem; allowlist (nie blacklist). Config usera żyje poza repo (workspace `.claude/` + shell rc) → przeżywa re-extract.
2. **Auto-open = tylko Mac/Win**, zawsze + link jako siatka bezpieczeństwa. VPS nie woła `setup.mjs` → bez auto-open.
3. **GATE 0 Windows:** zanim cokolwiek nad bootstrapem — zweryfikuj na realnym Windows, że pisanie w pytaniach działa pod `irm|iex`.
4. **Port 7777 zakładamy wolny** — kolizji nie obsługujemy (poza scope).

## Fazy wdrożenia (Implementation Units)

### Unit 1 — `install.sh` (Mac/Linux) tryb dualny + fix TTY · **Nakład: M**
- **Wymagania:** R1, R2 · **Zależności:** brak · **Delegate:** feature-builder-data
- **Cel:** `curl|bash` pobiera repo bez `git` do `~/claude-cron` i odpala setup z działającym stdin.
- **Kryteria akceptacji:** tryb dualny (detekcja `setup.mjs` obok), bootstrap `curl tarball | tar -xz`,
  uruchomienie `"$NODE_BIN" setup.mjs < /dev/tty` z fallbackiem; kontrakt danych przy re-run.

### Unit 2 — `install.ps1` (Windows) tryb dualny + GATE 0 · **Nakład: L**
- **Wymagania:** R3 · **Zależności:** brak (równoległy do Unit 1) · **Delegate:** feature-builder-data
- **⛔ GATE 0 (pierwszy krok):** weryfikacja pisania pod `irm|iex` na realnym Windows; łatka jeśli EOF.
- **Cel:** `irm|iex` pobiera repo bez `git` do `$HOME\claude-cron` (zip + `Expand-Archive`), parytet z Unit 1.
- **Kryteria akceptacji:** detekcja trybu przez puste `$PSScriptRoot`, bootstrap zip, kontrakt danych przy re-run.

### Unit 3 — `setup.mjs` auto-start + auto-open (Mac/Win) · **Nakład: M**
- **Wymagania:** R4, R5 · **Zależności:** samodzielny z lokalnego repo; korzysta z Unit 1/2 · **Delegate:** feature-builder-data
- **Cel:** serwer startuje sam, zawsze wypisany link, na Mac/Win best-effort auto-open. VPS nie dotyczy.
- **Kryteria akceptacji:** pure `buildOpenBrowserCommand` (darwin `open`, win32 `Start-Process`, inne → null);
  zawsze `console.log` z linkiem; auto-open best-effort nie crashuje.

### Unit 4 — README trójplatformowe one-linery · **Nakład: S**
- **Wymagania:** R6 · **Zależności:** Unit 1, 2, 3 · **Delegate:** feature-builder-data
- **Cel:** dokumentacja odzwierciedla flow „1 komenda" na każdym torze.
- **Kryteria akceptacji:** one-linery Mac + Windows + VPS; usunięty ręczny start `.node/...server.js`; korekta „2 pytania"→4.

## Ocena ryzyka i mitygacje

- **`curl|bash` / `irm|iex` z internetu** → README ma sekcję trust + weryfikacja SHASUMS256. Zostawić.
- **TTY Mac** → fallback bez TTY. **stdin Windows** → GATE 0 (twardy gate, nie założenie).
- **Re-run kasuje bazę** → kontrakt preserve-copy + test ze „strażnikiem" `data/SENTINEL`. Najgroźniejsze ryzyko.
- **Windows nigdy nie odpalony** → operator testuje na realnej maszynie przed mergem.

## Mierniki sukcesu

- Czysty Mac: jeden one-liner → pełna instalacja + auto-open, zero ręcznych kroków.
- Czysty Windows: jeden one-liner → pełna instalacja + auto-open (po przejściu GATE 0).
- Re-run one-linera → baza i `.node/` nietknięte.
- README: zero brzydkich ręcznych kroków startu serwera.

## Zależności i kolejność

Unit 1 ∥ Unit 2 (równoległe) → Unit 3 (samodzielny, ale spina się z 1/2) → Unit 4 (README, po reszcie).
Merge do `main` dopiero po teście (one-liner pobiera `main`).

## Źródła
- Requirements doc: brak (`docs/brainstorms/` nie istnieje)
- Plan techniczny: `docs/plans/2026-06-30-001-feat-instalacja-jedna-komenda-plan.md`
</content>
