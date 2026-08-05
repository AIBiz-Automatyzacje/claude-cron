# Naprawy Team OS po testach end-to-end — podsumowanie

**Data ukończenia:** 2026-08-05
**Branch:** `feature/naprawy-team-os`
**Zakres:** 12 Implementation Units w 5 fazach (U1–U12), wszystkie fazy `execute` + `review` + `fix` = done.
**Walidacja końcowa:** `npm test` → **952/952 pass, exit 0** (baseline wejściowy 155/155 nie spadł;
suita urosła wraz z nowymi testami: 837 → 853 → 895 → 912 → 952).

---

## Co zostało dostarczone

| Unit | Rezultat |
|---|---|
| **U1** | `lib/version.js` + `data/version.json`; pole `version` w `/api/status`; instalatory pobierają archiwum **po SHA commita** i przekazują rewizję do `setup.mjs` |
| **U2** | Hub odrzuca nieznanego adresata (`resolveRecipient` w `sendMessage`) z listą członków; `members.name COLLATE NOCASE` z fail-fast przy kolizji nazw; API mapuje na `400 {error:'unknown_recipient', members:[…]}` |
| **U3** | Odpowiedziane `query` znika z „Wysłanych" (`pullForUser` + `NOT EXISTS` reply od kogoś ≠ autor); własne dopowiedzenie **nie** zamyka wątku |
| **U4** | `PULS_HOME` ustawia instalator: `env.PULS_HOME` w `<workspace>/.claude/settings.json` **oraz** wskaźnik `~/.claude-cron-home` z faktycznym katalogiem instalacji |
| **U5** | `close.mjs` przeniesiony do repo (`scripts/inbox/close.mjs`), archiwizuje nitkę raz na wątek; skill w vaulcie woła go przez `$PULS_HOME` z czytelnym guardem |
| **U6** | `mergeFrontmatter` w `inbox-pull.mjs` — brakujące klucze szablonu dochodzą, istniejące (także cudze) nietknięte |
| **U7** | Marker `%% thread:<id> %%` w `renderArchiveThread` + podmiana bloku w `appendToArchive` = archiwum bez duplikatów |
| **U8** | `scripts/consistency-check.mjs` — job „Puls — kontrola spójności": rozjazd motywu/wersji → jedno zadanie w vaulcie z komendą naprawczą, dedup po ukrytym znaczniku `%% puls:consistency-check %%` |
| **U9** | `lib/persisted-env.js` + pole `vps_url {in_use, persisted, mismatch}` w `/api/status`; pasek `#vps-addr` w panelu |
| **U10** | `resolveVpsChoice` w `setup.mjs` — trzy rozłączne stany `kept`/`none`/`set`; pusty Enter = „bez zmian: `<adres>`" |
| **U11** | `lib/updater.js` + `GET/POST /api/update` + pasek aktualizacji w panelu; czterowartościowy stan `current`/`available`/`unknown`/`check_failed` |
| **U12** | Synchronizacja pluginu zespołowego `aibiz-plugin` (`skrzynka.css`, `SKILL.md`, tryb `--refresh-theme`) — **niezacommitowana**, push zabramkowany operator checklistą |

---

## Kluczowe decyzje

- **Wersja z pliku, nie z gita** — CAVE instaluje się zipem bez `.git`; zip pobierany po **skrócie commita**,
  nie po nazwie gałęzi (cache `raw.githubusercontent`, learned pattern 2026-07-28).
- **Walidacja adresata w `sendMessage`, nie w API** — jedno miejsce chroni wszystkie ścieżki wejścia
  („logika trudna po stronie huba").
- **`members.name COLLATE NOCASE` bez backfillu** — `migrate()` leci co boot, więc kolizja nazw daje
  **fail-fast**, a wytarcie kałuży jest jednorazowym krokiem operatora.
- **Predykat R3: „odpowiedział ktoś inny niż ja"** — „istnieje jakikolwiek reply" kasowałoby własne pytanie
  z listy i psuło `findOriginal` w `reply.mjs`. Rekord świadomie **nie** dostaje `status='done'` (dług widok↔status).
- **Wskaźnik `~/.claude-cron-home` obok `settings.json`** — katalog instalacji to wolne wejście usera,
  a `settings.json` ratuje tylko sesje w jednym workspace; konwencja `~/.claude-cron-oauth-token`.
- **Panel pokazuje DWIE wartości adresu, nie przeładowuje env** — „czy używam tego, co ustawiłem" wymaga
  porównania źródeł (`docs/solutions/…2026-07-07…`).
- **Rozłączne stany updatera** — „nie wiem" i „nie udało się sprawdzić" nie mogą udawać „masz aktualne";
  fałszywa zieleń jest gorsza niż brak odpowiedzi. Rewizja bierze się ze **świeżego sprawdzenia serwera,
  nigdy z body** żądania.
- **Dedup po ukrytym znaczniku, nie po tytule** — tytuł zmieni się przy pierwszym porządkowaniu Dashboardu.
- **CSS bez `:has()` nie jest przepisywany** — update Obsidiana na CAVE naprawił wygląd; zostaje wymaganie
  wersji w onboardingu (opisane **objawowo**, bez numeru — brak pewnej mapy Obsidian → Chromium).

---

## Główne pliki

**Nowe:** `lib/version.js`, `lib/updater.js`, `lib/persisted-env.js`, `scripts/inbox/close.mjs`,
`scripts/consistency-check.mjs` (+ kolokowane testy każdego).

**Zmodyfikowane:** `lib/inbox-db.js`, `lib/inbox-api.js`, `lib/starter-jobs.js`, `templates/starter-jobs.json`,
`scripts/inbox/inbox-push.mjs`, `scripts/inbox/inbox-pull.mjs`, `server.js`, `setup.mjs`,
`install.sh`, `install.ps1`, `public/app.js`, `public/index.html`, `public/style.css`,
`public/render-helpers.js`.

**Poza repo:** `<vault>/.claude/skills/deleguj/scripts/env.mjs` (+ `env.test.mjs`), `…/SKILL.md`,
`<aibiz-plugin>/plugins/aibiz/skills/onboard/{SKILL.md, templates/skrzynka.css}`.

---

## Wnioski

1. **Testy kształtu komendy nie są testami kontraktu.** 21/21 i 952/952 zielonych przy updaterze,
   którego happy-path nie domykał się na ŻADNEJ platformie: mac nie zapisywał `data/version.json`
   (panel raportował sukces jako porażkę), Windows spawnował PowerShella z `cwd` = katalog,
   który sam musiał przenieść. Asertuj **efekt, po który feature powstał**, nie ciąg znaków komendy.
2. **Fail-fast w `migrate()` zabija też lekarstwo.** Rzucenie z migracji ubija całe połączenie,
   a `getInboxDb()` biegnie przy KAŻDEJ operacji — więc kolizja nazw kładła całą skrzynkę i blokowała
   instruowaną w komunikacie naprawę przez `revokeMember`. Guard ma być wąski jak operacja, którą chroni.
3. **`hidden` nie chowa elementu z regułą autora `display:flex`.** Feature diagnostyczny świecił
   fałszywym alarmem u każdego usera — projekt nie ma globalnego override'u `[hidden]`.
4. **Kod w trzech miejscach = większość błędów to rozjazdy kopii, nie wady logiki.** U5 zlikwidowało
   drugą kopię `close.mjs`; loader sekretu w vaulcie nadal jest poza zasięgiem `npm test` — świadomy dług.
5. **Marker parsowany substringiem na treści z niezaufanego źródła = zdalne kasowanie cudzych danych**
   (P1 fazy 3: wiadomość z linią `%% thread:<cudzy-uuid> %%` podmieniała obcy blok archiwum).
   Renderowana treść musi być escapowana, a marker matchowany równością całej linii.
6. **Fold wielkości liter w JS ≠ `COLLATE NOCASE`** (Unicode vs ASCII) — przy polskojęzycznym zespole
   „Michał"/"MICHAŁ" czyniłoby obie osoby trwale nieosiągalnymi (pozostawione jako P3).

---

## Stan otwarty przy archiwizacji (tryb autopilota)

- **0 × P1, 0 × P2** — wszystkie znaleziska blokujące i poważne z review faz 1–5 naprawione.
- **~30 × P3** (nice-to-have: brakujące indeksy, nadmiarowe eksporty, timeouty w instalatorach,
  luki testowe) — spisane w `naprawy-team-os-zadania.md`, do przeniesienia do `STATUS.md`.
- **Operator checklist niewykonany** — wymaga żywych maszyn i sieci: kopia `data/inbox.db` + migracja
  na kopii przed deployem VPS, restart daemonów, retesty T6/T8/T12/T13/T14, sprawdzenia M1–M3,
  pełna runda testowa wg szablonu, push `aibiz-plugin` (zablokowany wyjaśnieniem cudzych zmian w `hooks/`),
  przełączenie `THEME_FIX_COMMAND` na `/onboard --refresh-theme` po `/reload-plugins` u zespołu.
