# Historia bez ciężkich logów — lazy-load stdout (01.08.2026)

> Zlecenie dla asystenta kodującego w tym repo. Kontekst zdiagnozowany w sesji
> workspace Obsidian 01.08.2026 — nie zaczynaj kodować bez przeczytania sekcji
> „Kontrakty, których nie wolno naruszyć".

## Problem (zmierzony)

Zakładka Historia w panelu pobiera `GET /api/runs?limit=100&hide_routine=1`, a ten
endpoint zwraca **pełne wiersze z `stdout`/`stderr`** każdego runa. Dla instancji VPS
payload to dziś **2,15 MB JSON** (stdout jobów claude to stream-json, ~20 KB+ na run).
Zmierzone czasy przez proxy Mac→VPS (5 prób pod rząd, Tailscale direct):
1,4 s / 1,7 s / 2,8 s / 3,7 s / **7,0 s** — rozrzut duży, przy zajętym VPS-ie
(trwający run Claude CLI) zapytanie przebijało limit proxy 10 s → panel dostawał
`504 {"error":"VPS timeout"}` → `loadRuns()` robi `.map()` na obiekcie błędu →
toast „Błąd ładowania historii".

Plaster już nałożony (01.08, poza tym planem): `timeout` w `proxyToVps` podniesiony
10 s → 30 s w `server.js`. To leczy objaw; ten plan usuwa przyczynę — historia nie
powinna wozić megabajtów logów, których user w 95% przypadków nie rozwija.

## Cel

Lista historii = same metadane. Log konkretnego runa dociągany dopiero przy
rozwinięciu wiersza. Payload listy spada z ~2 MB do kilkudziesięciu KB — koniec
timeoutów niezależnie od łącza i obciążenia VPS.

## Zakres

### ① Backend: tryb lekki dla listy + endpoint pojedynczego runa

1. `GET /api/runs` — nowy parametr `fields=meta` (opt-in, żeby nie łamać
   istniejących konsumentów): zwraca wiersze **bez** `stdout`, `stderr`,
   `webhook_payload`; zamiast nich `stdout_bytes` i `stderr_bytes` (długości),
   żeby UI mógł pokazać rozmiar loga przed pobraniem. Bez parametru — zachowanie
   jak dziś, bajt w bajt.
2. Nowy `GET /api/runs/:id` — pełny wiersz jednego runa (z logami). 404 gdy brak.
   Uwaga na kolizję routingu z istniejącym `GET /api/runs/current` i
   `GET /api/runs/recent` — literały mają pierwszeństwo przed `:id`.
3. Oba działają automatycznie przez proxy `/api/vps/*` — proxy przepuszcza
   ścieżkę i query bez zmian, zero roboty po stronie proxy.

### ② Frontend (`public/app.js`)

1. `loadRuns()` i poll historii (dwa miejsca z `API.get('/api/runs?limit=100…')`)
   → doklejają `&fields=meta`.
2. `renderRuns()` — logbox rozwiniętego wiersza dostaje stan „ładowanie…";
   `toggleRunDetail(id)` przy pierwszym rozwinięciu robi
   `API.get('/api/runs/'+id)` i wypełnia `logBodyHtml(r)`. Cache w pamięci
   (mapa `id → run`), żeby zwijanie/rozwijanie nie pobierało ponownie.
   Inwalidacja cache dla runów `status: running` (log rośnie).
3. Kropki kalendarza (`loadCalendarRuns`) też na `fields=meta` — używają tylko
   statusów i dat.
4. Obrona w `loadRuns()`: gdy odpowiedź nie jest tablicą (`{error:…}`), pokaż
   treść błędu w toaście zamiast gołego „Błąd ładowania historii" — to skróci
   następną taką diagnozę z godziny do minuty.

### ③ Rollout

Zmiana musi trafić na **obie instancje** (Mac + VPS). Kolejność: najpierw deploy
na VPS (backend kompatybilny wstecz), potem Mac. Stary frontend ↔ nowy backend
działa (parametr opt-in); nowy frontend ↔ stary backend VPS **nie** (brak
`fields=meta` → dalej 2 MB, brak `/api/runs/:id` → 404 przy rozwinięciu) — stąd
kolejność. Pamiętaj o znanym blokerze: cron VPS potrafi stać na starym kodzie,
deploy = commit+push+pull na VPS, nie tylko lokalny edit.

## Kontrakty, których nie wolno naruszyć

- `GET /api/runs` **bez** `fields=meta` zwraca dokładnie to co dziś (pełne
  stdout/stderr) — konsumenci: skill `/puls` (diagnoza faili czyta `stdout`
  z listy), ewentualne skrypty użytkownika.
- `GET /api/runs/current` i `/api/runs/recent` bez zmian.
- `hide_routine=1`, `job_id`, `limit`, `offset` działają w obu trybach.
- Zero migracji schematu SQLite — to tylko projekcja kolumn w SELECT.

## Testy akceptacyjne

1. `curl '/api/runs?limit=100&fields=meta'` na VPS przez proxy < 100 KB i < 1 s.
2. `curl '/api/runs?limit=5'` (bez parametru) — odpowiedź identyczna jak przed zmianą.
3. Panel: Historia VPS ładuje się bez toastu; rozwinięcie wiersza pokazuje log;
   ponowne rozwinięcie nie strzela drugim requestem (sprawdź w devtools).
4. Rozwinięcie runa `running` odświeża log przy każdym otwarciu.
5. Skill `/puls`: diagnoza „dlaczego job padł" (czyta `stdout` z `/api/runs?job_id=…`)
   działa bez zmian.

## Szacunek

Backend ~30 min, frontend ~45 min, testy na obu instancjach ~30 min.
