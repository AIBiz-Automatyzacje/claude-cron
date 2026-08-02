# Równoległe joby w Pulsie — decyzja architektoniczna (30.07.2026)

> ⚠️ **NIEAKTUALNE ARCHITEKTONICZNIE — nie implementuj z tego pliku.**
> Plan wykonawczy: [`2026-07-30-001-feat-rownolegle-joby-sprint-plan.md`](./2026-07-30-001-feat-rownolegle-joby-sprint-plan.md).
> Sesja roastu 30.07 obaliła podział na pasy po `job_type` (najdłuższy job w systemie,
> Classroom sync 747 s, jest typu `script`) oraz limit „1 ciężki naraz". Ten dokument
> zostaje jako zapis rozważań i odrzuconych alternatyw.

> Ustalenia z sesji koncepcyjnej Kacper + Claude (workspace Obsidian). Wybrane z trzech
> niezależnych koncepcji architektury; dwie odrzucone opisane na końcu. Ten plik jest
> zleceniem dla asystenta kodującego w tym repo — NIE zaczynaj kodować bez przeczytania
> sekcji „Kontrakty, których nie wolno naruszyć".

## Problem (zmierzony)

`lib/executor.js` ma jeden globalny slot (`currentRunId`, `isRunning()`), a
`scheduler.processQueue` wykonuje jeden run naraz. Efekt na Macu (60 ostatnich runów):
Classroom sync **865 s**, Weekly memory 601 s, skill-scout 416 s, Daily memory 358 s —
a `inbox sync` (0,2 s, co minutę) czeka przez cały ten czas. W poniedziałek ~9:00
Skrzynka stoi kwadrans, choć obiecuje latencję minuty.

## Decyzja: „Dwa pasy i śluzy"

Dwa niezależne pasy wykonania rozdzielone po istniejącym `job_type` + deklaratywne
grupy wyłączności plikowej. **Świadomie NIE robimy pełnej N-równoległości jobów claude** —
domyślnie nadal 1 naraz (zasoby: pełny proces Claude CLI, tokeny, wspólna sesja
dev-browser/OAuth). Zmienia się jedno: lekkie joby script przestają czekać za ciężkimi.

### ① Limity współbieżności

- Pas `claude`: **default 1**, konfigurowalny — klucz `max_concurrent_claude` w istniejącej
  tabeli `state` (zero migracji schematu), edytowalny w ustawieniach dashboardu.
- Pas `script`: **sztywno 1** (joby script to sekundy; auto-reply na roli `agent` jest
  jedynym jobem script tej maszyny, więc nie koliduje).
- Limit jest per maszyna z natury — każda instancja ma własny SQLite.
- Default odtwarza dzisiejsze zachowanie 1:1 dla jobów claude; nietechniczny user niczego
  nie ustawia.

### ② Wyłączność plikowa: `lock_group`

- Nowa nullable kolumna `lock_group TEXT` w `jobs` (migracja wzorcem `job_type`,
  db.js:107-112) + pole w allowed-listach `createJob`/`updateJob`.
- Dwie reguły pickera kolejki:
  - **(a) niejawna:** nigdy dwa równoczesne runy tego samego `job_id` (dziś gwarantuje to
    globalny slot — gwarancja musi zostać jawna, inaczej inbox sync co 1 min nałoży się
    sam na siebie przy runie > 60 s);
  - **(b) jawna:** nigdy dwa równoczesne runy z tą samą niepustą `lock_group`.
- Konwencja: grupa = współdzielony artefakt (np. `dashboard`), NIE „cały vault" — grupa
  `vault` odtworzyłaby stary problem.
- Seed: `inbox-seed.js` → job inbox sync dostaje `lock_group: 'dashboard'` (przepisuje
  banner w Dashboard.md). Job `/daily` (u Kacpra) dostaje tę samą grupę — instrukcja
  w skillu `/puls`.
- Konflikt = odroczenie: run zostaje `queued`, picker bierze następny kwalifikujący się;
  po zakończeniu blokującego runu callback woła `processQueue` ponownie. FIFO w obrębie
  grupy naturalne (skan po `id ASC`).
- Wykrywanie plików / parsowanie promptów — ODRZUCONE z definicji (prompt claude jest
  nieanalizowalny ex ante).

### ③ Kill i watchdog per-run

- Kluczowe (zweryfikowane w kodzie): timery idle/watchdog/sleep-aware **już są per-run** —
  żyją w domknięciu `executeRun` (executor.js:218-250). Globalne są tylko singletony
  `currentProcess`/`currentRunId` (executor.js:8-9).
- Zmiana: `activeRuns = Map(runId → {proc, jobId, jobType})`; rejestracja na starcie,
  wyrejestrowanie w close/error/finishScriptRun. Timery NIETKNIĘTE.
- `killCurrent` → `killRun(runId)`: ta sama sekwencja (zapis `killed` do DB PRZED ubiciem,
  SIGTERM→SIGKILL / taskkill) — guardy z executor.js:289-290, 370-371 działają bez zmian.
- API: nowy `POST /api/runs/:id/kill`; stary `/api/runs/current/kill` zostaje —
  1 aktywny run → kill, >1 → **409 z listą** (żadnego zgadywania).
- `GET /api/status`: nowe `current_runs` (tablica z `db.getRunningRuns` = dzisiejszy
  `getCurrentRun` bez LIMIT 1); pole `current_run` zostaje jako pierwszy element
  (kompatybilność).
- Dashboard: kill-bar (public/app.js:328-334) → lista biegnących runów (nazwa joba +
  czas + „Zatrzymaj" per wiersz). Formularz joba: opcjonalne pole „Grupa wyłączności".
  Ustawienia: liczba równoległych jobów Claude. Przycisku „zatrzymaj wszystko" celowo
  NIE ma (sufit 2 równoczesnych runów).
- `reapOrphanedRuns` (db.js:329-341) już obsługuje wiele wierszy `running` — zero zmian.

### Scheduler: nowy processQueue

Picker kwalifikowalności zamiast „weź pierwszy i czekaj": skan `getQueuedRuns()` po
`id ASC`, run startuje gdy (pas jego `job_type` ma wolny slot) AND (brak aktywnego runu
tego `job_id`) AND (brak aktywnego runu z tą samą niepustą `lock_group`). Wystartowane
lecą równolegle; po każdym zakończeniu callback robi dzisiejszy retry-check (logika
z linii 28-39 przenosi się bez zmian) i woła `processQueue` ponownie.

## Kontrakty, których nie wolno naruszyć

1. **Istniejące 635 testów przechodzi BEZ modyfikacji.** `processQueue` nadal zwraca
   promise rozwiązywany po opróżnieniu kolejki (pętla: startuj kwalifikujące się →
   `Promise.race` aktywnych → re-pick) — scheduler.test.js:285 musi przejść.
   Shimy `isRunning()`/`getCurrentRunId()` na mapie dla starych call-site'ów.
2. Kontrakt „killed milczy": zapis `killed` do DB przed ubiciem procesu, per run.id.
3. Guard `settled` + ratunkowy timer (naprawy 29.07) zostają — czyszczą swój wpis
   w Map zamiast zerować singleton.
4. Sleep-aware timeouty (`startSleepAwareTimeout`, 29.07) — nietknięte.
5. Seed nigdy nie robi UPDATE istniejących jobów (chroni ręczne wyłączenia usera).

## Nowe testy (~12-15)

- killRun celuje w jeden z dwóch aktywnych runów, drugi żyje
- run script startuje podczas biegnącego runu claude (dwa pasy)
- dwa joby z tą samą lock_group nie biegną naraz; drugi startuje po pierwszym (FIFO)
- job nie nakłada się sam na siebie
- retry (R9) działa przy równoległym drainie
- 409 dla `/current/kill` przy dwóch runach

## Ryzyka (świadomie zaakceptowane)

- Niezadeklarowana kolizja plikowa = cichy lost update — ALE realne dopiero po
  podniesieniu `max_concurrent_claude` > 1 (przy 1 pas claude serializuje wszystkie joby
  claude między sobą). Zapisać wprost w docs skilla `/puls`.
- Pętla drain (start równoległy + Promise.race + re-pick) to najbardziej podatny na błędy
  fragment — testy na wolnych skryptach (sleep-script fixtures) obowiązkowe.
- Poniedziałkowy korek jobów claude ZOSTAJE — to problem harmonogramu (rozstrzelić
  godziny startu w panelu), nie architektury.
- Stary klient skilla `/puls` dostanie 409 przy dwóch runach — zaktualizować skill razem
  z deployem.
- Windows/CAVE: dwa równoczesne drzewa procesów przy wybudzeniu — nietestowane; CAVE
  i tak stoi na starym kodzie (najpierw git pull).
- Pile-up runów routine podczas blokady grupy rozładowuje się seryjnie —
  `writeIfChanged` robi z nich no-opy; dedup kolejki NIE jest potrzebny.

## Zakres zmian (6 plików + skill)

| Plik | Zmiana | Skala |
|------|--------|-------|
| `lib/executor.js` | singletony → Map activeRuns, killRun(runId) | ~70 linii |
| `lib/scheduler.js` | picker kwalifikowalności + drain | ~80 linii |
| `lib/db.js` | migracja lock_group, getRunningRuns | ~25 linii |
| `server.js` | /api/runs/:id/kill, 409, current_runs, ustawienie limitu | ~35 linii |
| `public/app.js` + `index.html` | lista aktywnych runów, pole grupy, ustawienie | ~50 linii |
| `lib/inbox-seed.js` | `lock_group: 'dashboard'` na jobie sync | ~3 linie |
| skill `/puls` (vault, poza repo) | dokumentacja lock_group + instrukcja dla /daily | docs |

Szacunek: 2-3 dni robocze; ~połowa wysiłku to pętla drain i jej testy.

## Dodatkowe zakresy przed finalną wersją (decyzja Kacpra 30.07)

Oprócz równoległych jobów do domknięcia w tym projekcie:

### 1. 🔴 Panel kłamie o autostarcie na Macu

`lib/platform.js` szuka etykiety `com.claude-cron.scheduler`, a w systemie działa
`com.claude-cron.daemon` — stąd `autostart: installed:false` mimo poprawnie działającego
launchd. ⚠️ **NIE naprawiać samej etykiety:** `generatePlist()` pisze logi do
`<repo>/data/` w `~/Documents`, czyli prosto w TCC (`EX_CONFIG 78`, daemon nie wstanie),
nie ustawia env i bierze `which node` zamiast portable Node. Naprawa = przepisanie
`installMac` pod wzorzec działającego plista z 23.07: wrapper `/bin/sh -c`, logi w
`~/Library/Logs/claude-cron/`. Szacunek: ~pół dnia.

### 2. Opóźnienie startu jobów po wybudzeniu (martwa sieć)

Mac budzi się, sieć jeszcze nie wróciła → joby failują (`Connection closed`,
`ENOTFOUND api.telegram.org`; historycznie joby 5 i 12). Obejście (przesunięte godziny)
działa; realny fix to kilkanaście linii w schedulerze: po wykryciu wybudzenia odczekaj
np. 30-60 s przed pierwszym runem wymagającym sieci. Retry zostaje bez zmian.

### 3. Instalator: sztywna ścieżka + kolizja portu

Instalator celuje na sztywno w `~/claude-cron` i wywala się / gryzie z innym procesem,
gdy port 7777 jest zajęty. Do zrobienia: konfigurowalny katalog instalacji + wykrycie
zajętego portu z czytelnym komunikatem (albo automatyczny wybór wolnego portu z zapisem
do konfiguracji). To pierwszy kontakt zespołu z produktem — musi przejść gładko.

### Rekomendowana kolejność całości

1. Równoległe joby (główny zakres tego planu)
2. Instalator (pkt 3) — przed onboardingiem pierwszej osoby z zespołu
3. Fix autostartu na Macu (pkt 1)
4. Opóźnienie po wybudzeniu (pkt 2)

> Rebrand na „Puls" **wypadł z zakresu 30.07** — praca jest już w `main`
> (gałąź `feature/migracja-puls-rebrand` jest przodkiem maina, ostatni commit 27.06,
> archiwum w `docs/completed/migracja-puls-rebrand/`). Argument „najpierw rebrand,
> bo rebase będzie bolał" nie ma przedmiotu.

## Odrzucone alternatywy (nie wracamy bez nowych danych)

- **„Locki przy piórze"** — leasy na plik w momencie zapisu (hook PreToolUse na
  Write/Edit w spawnowanym CLI + helper w skryptach). Odrzucone: zapisy Bashem omijają
  hook, ryzyko merge `--settings`, złożoność bez zmierzonej potrzeby.
- **„Budżet i ślady"** — ważony budżet maszyny + profil zapisu mierzony przez fs.watch,
  kwarantanna, incydent-detektor. Odrzucone: najdroższy mechanizm na problem, którego
  nie ma; profile zaśmiecane przez Obsidian Sync i ręczne edycje.
- Kontekst wyboru: trzej niezależni architekci (prostota / poprawność / produkt)
  zbiegli się na wariancie pasów + grup — dwie pozostałe koncepcje powstały dopiero
  po wymuszeniu odmienności.
