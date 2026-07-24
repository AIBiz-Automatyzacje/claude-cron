# Review Fazy 3 — Onboarding (Team OS Hub-API)

Data: 2026-07-24
Zakres: IU-3.1 (install-vps.sh — komponent „Team OS hub"), IU-3.2 (setup.mjs — kod zaproszenia), IU-3.3 (Dashboard — widok „Zespół")
Metoda: multi-agent review + adversarial verify (P1×3 sceptyków, P2×1).

## Severity gate: ⚠️ ZASTRZEŻENIA

- P1 (blocking): 0
- P2 (important, KOD/TEST/E2E): 2
- P3 (nit, KOD/TEST/E2E): 10
- OPERATOR (niewykonalne headless, poza gate'em fix): 2

Zero P1 → nie blokuje. Dwa P2 (oba KOD) do naprawy przed domknięciem fazy.

## Statystyki

| Kategoria | Liczba |
|---|---|
| P1 KOD/TEST/E2E | 0 |
| P2 KOD/TEST/E2E | 2 |
| P3 KOD/TEST/E2E | 10 |
| OPERATOR | 2 |
| **Razem findingów** | **14** |

Testy automatyczne:
- `npm test` → 492 pass / 0 fail (exit 0)
- `scripts/install-vps.test.sh` → 110 PASS / 110 total (exit 0)

## Findingi (P1 → P2 → P3 → OPERATOR)

### P2 — important

#### P2-1 · KOD · `public/app.js:1135` — Attribute-context XSS w aria-label wiersza członka
`esc()` (app.js:1258, textContent→innerHTML) NIE escapuje cudzysłowów, a `renderMembers` wstawia `esc(row.name)` do `aria-label="Unieważnij dostęp ${esc(row.name)}"`. Nazwa członka nie jest walidowana znakowo: backend `addMember` (lib/inbox-db.js:271) sprawdza tylko `!name`, a `validateMemberName` (render-helpers.js) tylko długość ≤80. Członek o nazwie np. `x" onmouseover="alert(document.cookie)` łamie atrybut i wstrzykuje handler → wykonanie JS w dashboardzie. W trybie VPS lista pobierana jest ze zdalnego huba przez proxy `/api/vps/*`, więc nie jest to wyłącznie self-XSS. Fix: escapuj też `"` i `'` (dedykowany `escAttr` / rozszerz `esc`) albo nie umieszczaj nazwy w atrybucie.

#### P2-2 · KOD · `scripts/install-vps.sh:1436` — `is_valid_member_name` odrzuca polskie diakrytyki
Whitelist ASCII `^[A-Za-z0-9 ._-]+$` odrzuca `ł, ą, ć, ę, ó, ś, ż, ź, ń`. Zweryfikowane w bashu: „Michał" → ODRZUCONO, „Kacper" → OK. Skutek: admin o polskim imieniu wpisuje je w prompt „Imię administratora zespołu", `ask_valid` warnuje i ponawia; po `ASK_MAX_ATTEMPTS` woła `fail` → `exit 1`, co PRZERYWA w pełni skonfigurowaną instalację tuż przed `print_summary` — jednorazowy kod zaproszenia (`TEAM_OS_INVITE_CODE`) przepada bezpowrotnie. Projekt i UI są po polsku, więc to realny scenariusz grupy docelowej. Niespójne z pozostałymi warstwami fazy: `validateMemberName` (render-helpers.js) akceptuje dowolne znaki ≤80, a `server.js` POST `/api/inbox/members` nie waliduje znaków wcale — ta sama encja, trzy różne kontrakty. Uzasadnienie JSON-safety (`printf '{"name":"%s"}'`) wymaga tylko wykluczenia `"` `\` i znaków sterujących, nie whitelisty ASCII. Fix: rozszerzyć klasę o polskie diakrytyki / Unicode, wykluczając jedynie cudzysłów, backslash i control chars.

### P3 — nit

#### P3-1 · KOD · `public/app.js:1135` — `row.id` interpolowane bez koercji do onclick
Defense-in-depth: `row.id` w `onclick="revokeMember(${row.id})"` (memberRowData zwraca `m.id ?? null`, bez `Number()`). Dziś id to integer z SQLite (bezpieczne), ale narusza „nie ufaj granicy API" — w trybie VPS dane huba są zdalne. Fix: `Number(row.id)` przy renderze lub data-atrybut + delegacja zdarzeń.

#### P3-2 · KOD · `public/app.js:1436` — poll() re-fetchuje pełną listę członków co 3 s
Gdy aktywna zakładka Zespół, `poll()` co 3 s robi round-trip do huba (na VPS: do wspólnego Postgresa), choć komentarz przyznaje, że roster „zmienia się rzadko". Render guardowany podpisem, ale żądanie sieciowe leci bezwarunkowo. Manualny „↻ Odśwież" + reload po mutacji (submitAddMember/revokeMember już wołają loadMembers) pokrywają aktualizację. Rekomendacja: usunąć odświeżanie z poll() dla team albo wydłużyć interwał. Dodatkowo transient `{error}` z huba przełącza widok na empty-state i z powrotem (flicker).

#### P3-3 · KOD · `public/app.js:1155-1180` — niespójne nazewnictwo modala dodawania członka
`openAddMemberModal`/`submitAddMember` (prefix `AddMember`) vs `hideTeamAddModal`/`closeTeamAddModal`/`showTeamAddError`/`clearTeamAddError` (prefix `TeamAdd`). Dwa prefiksy dla tego samego widoku łamią 5-sekundową regułę spójności. Ujednolicić.

#### P3-4 · KOD · `public/app.js:80` — switchEnv woła loadMembers() eager wbrew lazy-load
`switchEnv` woła `loadMembers()` w `Promise.allSettled` niezależnie od aktywnej zakładki, co przeczy komentarzowi lazy-load (linia 94). Ładowanie Zespołu pokryte tab-click (95) i poll (1436). Albo usunąć z allSettled, albo zaktualizować komentarz.

#### P3-5 · KOD · `setup.mjs` — probeInviteCode zakłada Error w catch
`catch (error) { return { ok:false, reason: error.message } }` — przy rzucie nie-Error `reason` byłby `undefined` → komunikat „(undefined)". Użyć `error?.message ?? String(error)`.

#### P3-6 · KOD · `public/app.js` — membersSig pomija `name` w podpisie guardu
`membersSig` buduje podpis z `id:token_masked` + długości, pomijając `name`. Dziś nie ma ścieżki rename (tylko add/revoke) — gap latentny. Komentarz „wiersz jest niemutowalny" to założenie o kontrakcie backendu, nie gwarancja.

#### P3-7 · KOD · `docs/active/team-os-hub-api/team-os-hub-api-kontekst.md` — under-implementacja instrukcji planu IU-3.2
Plan mówił: „Pliki vaulta: NIE tworzymy w setupie — self-heal ensureSkrzynkaFile w pull załatwia to przy pierwszym runie (dopisać do kontekstu, że to celowe)". Diff kontekst.md dokumentuje odchylenia builderów, ale nie zawiera wzmianki o celowym niedotworzeniu plików Skrzynki. Drobna luka dokumentacyjna, nie wpływa na kod.

#### P3-8 · KOD · `public/render-helpers.js:222` — defensive fallbacki + rozjechana logika braku danych
`memberRowData` ma fallbacki `'—'` dla `name`/`token_masked`, które kontrakt backendu gwarantuje jako zawsze obecne (regula #10 anti-patternów AI). Dodatkowo fallback `createdAt` zdublowany: helper zwraca `createdAt=null`, a `renderMembers` (app.js:1131) ponownie stosuje `row.createdAt ? formatDateTime(...) : '—'`. Uprościć: pełne fallbacki w helperze albo surowe pola + jeden fallback w renderze.

#### P3-9 · TEST · `public/app.js:1093` — membersSig() bez testu
`membersSig()` to czysta funkcja guardu re-renderu, bliźniak testowanych `pollSignature`/`jobsSignature` — ale te żyją w render-helpers.js z testami, a membersSig siedzi w app.js bez testu. Nietestowane brzegowe: unieważnienie członka (zmiana zbioru id) vs brak zmian. Konwencja projektu = czyste helpery guardu → render-helpers + test.

#### P3-10 · TEST · `scripts/install-vps.test.sh:1938` — nietestowane gałęzie błędu setup_team_os_hub
Pokryte: N-default, 201-happy, 503-Funnel, idempotencja, sekwencja, print_summary. Nietestowane error-case: (a) serwer nie odpowiada w probe → warn+skip (install-vps.sh:1518), (b) HTTP != 201/503 → warn+skip (:1538), (c) HTTP 201 bez pola invite_code → warn (:1546).

### OPERATOR — niewykonalne headless (poza fix, do Operator checklist)

#### OP-1 · `docs/active/team-os-hub-api/team-os-hub-api-zadania.md:123`
Jedyny niezaznaczony checkbox Fazy 3 (IU-3.3): ręczna weryfikacja dodania/unieważnienia członka z LOKALNEGO dashboardu w widoku VPS (przez proxy `/api/vps/*`). Niewykonalne headless — wymaga żywego dashboardu + działającego huba na VPS ze skonfigurowanym Funnelem + realnego POST/DELETE `/api/inbox/members`. Reszta akceptacji (npm test 492/492, install-vps.test.sh 110/110) potwierdzona automatycznie.

#### OP-2 · `scripts/install-vps.sh:1494`
Ścieżka onboardingu huba (`setup_team_os_hub` → realny POST `/api/inbox/members` → 503 przy braku Funnela → jednorazowy invite_code z `WEBHOOK_BASE_URL`) oraz `setup.mjs` `askInboxInvite`/`probeInviteCode` (client.ping do żywego huba) weryfikowalne wyłącznie na realnym VPS z Tailscale Funnel. Testy jednostkowe pokrywają czyste helpery; pełny e2e wymaga smoke-testu operatora.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 0 (jedyny checkbox jest compound CLI+Manual — patrz niżej)
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

Faza 3 miała jeden niezaznaczony checkbox `Weryfikacja:` (linia 123), compound:

- Część CLI: „pełna suita + testy instalatorów zielone" → **PASS**
  - `npm test` → exit 0, 492 pass / 0 fail
  - `scripts/install-vps.test.sh` → exit 0, 110 PASS / 110
- Część Manual: „ręcznie — dodanie/unieważnienie członka z lokalnego dashboardu w widoku vps" → **wymaga operatora** (niewykonalne headless → Operator checklist, OP-1)

Ponieważ część manualna pozostaje otwarta, checkbox zostaje `- [ ]` z adnotacją; przeniesiony do Operator checklist faza 3. Część CLI potwierdzona — nie generuje P2.

Nowe P2/P3 z bookkeepingu: 0. Severity gate bez zmian: ⚠️ ZASTRZEŻENIA.
