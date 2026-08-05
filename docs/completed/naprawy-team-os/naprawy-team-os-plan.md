# Naprawy Team OS po testach end-to-end 04.08 — plan

**Branch:** `feature/naprawy-team-os`
**Ostatnia aktualizacja:** 2026-08-05

## Źródła

- Requirements doc: brak (`/dev-brainstorm` nie był użyty)
- Plan techniczny: [docs/plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md](../../plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md)
- Backlog źródłowy: `Zadania/projekty/personal-team-os/STATUS.md` (sekcja „🔥 NASTĘPNA SESJA", stan 05.08)
- Dziennik testów: `Zadania/projekty/personal-team-os/testy-team-os-2026-08-03.md`
- Szablon rund testowych: `Zadania/projekty/personal-team-os/szablon-testow-team-os.md`

---

## Podsumowanie wykonawcze

04.08 Team OS przeszedł pierwsze testy end-to-end **jako produkt, nie jako budowa**: 10 scenariuszy
(T1–T10), 9 zdanych, T6 oblany. Runda wyprodukowała 14 znalezisk; po przeglądzie 05.08 zostało 11,
a sesja roastu dołożyła pozycję 15 i zmieniła warianty rozwiązań w pięciu pozycjach.

Zadanie porządkuje to w **12 Implementation Units w 5 fazach**. Każde znalezisko ma udokumentowany
objaw z realnego użycia — to nie jest audyt kodu ani lista życzeń.

**Motyw przewodni:** system ma wzorzec **cichej awarii** — hub przyjmuje nieistniejącego adresata bez
błędu, `close` kasuje treść bez śladu, panel pokazuje konfigurację, której nie używa. Każdy unit ma
dokładać **widoczny sygnał porażki**, nie tylko poprawiać ścieżkę szczęśliwą.

---

## Analiza obecnego stanu

| Objaw | Gdzie | Skutek |
|---|---|---|
| Literówka w nicku przechodzi bez błędu | `lib/inbox-db.js` `sendMessage` | Dwie wiadomości zjedzone w jeden dzień; u nadawcy wyglądają jak czekające |
| `close` nie archiwizuje | `close.mjs` w vaulcie omija `appendToArchive` | Treść znika bezpowrotnie → obejście operacyjne „domykać wyłącznie checkboxami" |
| Odpowiedziane `query` zostaje w „Wysłanych" | `lib/inbox-db.js` `pullForUser` | **Oblany T6**; ten sam wątek w dwóch sekcjach, licznik zawyża |
| Brak `PULS_HOME` wywraca `/deleguj` | `setup.mjs` + loader w vaulcie | Dwie maszyny w dwa dni na tej samej minie; komunikat namawia do cofnięcia migracji bezpieczeństwa |
| Brak numeru wersji kodu | `server.js` `/api/status` | 04.08 CAVE testował starym kodem — część wyników do kosza |
| Panel pokazuje konfigurację, nie stan | `lib/config.js:28` czyta env raz | Godzina diagnozy 04.08 |
| Archiwum duplikuje wątki | `appendToArchive` = goły `fs.appendFile` | „Test łączności Team OS" dwa razy w `2026-08.md` |
| Zmiany szablonu nie docierają do istniejących plików | `inbox-pull.mjs` nie rusza frontmattera | CAVE bez `cssclasses` → wyglądało na zepsuty CSS |

**Kontekst utrudniający:** kod żyje w **trzech** miejscach (repo `claude-cron`, skill `deleguj`
w vaulcie, szablony CSS w `aibiz-plugin`). Większość błędów to rozjazdy między kopiami tej samej
rzeczy, nie wady logiki.

---

## Proponowany stan docelowy

1. Hub odrzuca nieznanego adresata z listą członków i sam prostuje wielkość liter.
2. Obie ścieżki domykania (checkbox i `close`) archiwizują nitkę — obejście operacyjne znika.
3. Odpowiedziane pytanie znika z „Wysłanych", ale **własne dopowiedzenie go nie zamyka**.
4. `/deleguj` działa po świeżej instalacji bez ani jednego ręcznego kroku.
5. Każda maszyna raportuje, jaki kod ma zainstalowany; aktualizacja idzie przyciskiem w panelu.
6. Rozjazd wersji i wyglądu jest **widoczny** — job wystawia zadanie z komendą naprawczą w treści.
7. Panel pokazuje adres w użyciu **obok** zapisanego i sygnalizuje różnicę.
8. Plugin zespołowy zaktualizowany raz, na końcu, po przetestowaniu całości.

---

## Fazy wdrożenia

### Faza 1 — Widoczność i hub *(≈ pół dnia)*
Unity 1–3. Kończy się **retestem T6**. Od tego momentu wiadomo, co która maszyna ma zainstalowane.

### Faza 2 — Granica repo ↔ vault *(≈ pół dnia)*
Unity 4–5. Kończy się **retestem T8** z warunkiem archiwum i zdjęciem ostrzeżenia o `close`.

### Faza 3 — Format Skrzynki i archiwum *(≈ pół dnia)*
Unity 6–8. Kończy się **testami T13 i T14**.

### Faza 4 — Konfiguracja VPS *(≈ 1,5 h)*
Unity 9–10. Kończy się **sprawdzeniami M1 i M3**.

### Faza 5 — Aktualizacja i dystrybucja *(≈ dzień + runda testowa)*
Unity 11–12. Kończy się **pełną rundą wg szablonu** i wypełnionym BILANSEM.

**Razem:** ~2 dni robocze na fazy 1–4 + dzień na fazę 5 + rundę testową.
Szacunki obejmują pisanie kodu i testy; deploy i retesty są w `Operator checklist`.

---

## Zadania z nakładem i zależnościami

| # | Unit | Faza | Nakład | Zależy od |
|---|---|---|---|---|
| U1 | Wersja instalacji w `/api/status` | 1 | M | — |
| U2 | Hub odrzuca nieznanego adresata | 1 | L | — |
| U3 | Odpowiedziane pytanie znika z Wysłanych | 1 | S | U2 |
| U4 | `PULS_HOME` ustawia instalator | 2 | L | — |
| U5 | `close` archiwizuje — jedna kopia kodu | 2 | L | **U4** |
| U6 | Merge frontmattera Skrzynki | 3 | M | — |
| U7 | Dedup archiwum + marker | 3 | M | U5 |
| U8 | Job „Puls — kontrola spójności" | 3 | L | U1, U6 |
| U9 | Panel: adres w użyciu vs zapisany | 4 | M | U1 |
| U10 | Instalator podpowiada zapisany adres | 4 | S | U9 |
| U11 | Aktualizacja przyciskiem | 5 | XL | U1 |
| U12 | Aktualizacja pluginu zespołowego | 5 | M | **wszystkie** |

**Twarda zależność U5 → U4:** wariant A przenosi `close.mjs` do repo, więc skill musi znać
`PULS_HOME`, żeby **znaleźć sam plik**. Odwrotna kolejność = `close` nie startuje na Macu i CAVE.

---

## Kryteria akceptacji

Numeracja `Rn` odpowiada pozycjom z `STATUS.md`.

- **R1** — wysyłka na `cave` trafia do `Cave`; wysyłka na `cav` wraca błędem z listą członków (T11)
- **R2** — po `close` wątek znika ze Skrzynki **i** pełna nitka jest w pliku archiwum (T8, warunek 3)
- **R3** — odpowiedziane `query` znika z „Wysłanych" bez akcji człowieka; własne dopowiedzenie **nie** zamyka (T6)
- **R4** — świeża instalacja w niedomyślnym katalogu: `/deleguj` działa bez ręcznych kroków (T12)
- **R7** — panel pokazuje obie wartości adresu i sygnalizuje rozjazd (M1)
- **R8** — każdy wątek w archiwum dokładnie raz, także przy domykaniu etapami (T10, warunek 2)
- **R10** — wersja widoczna na każdej maszynie, także na instalacji zipowej; aktualizacja przyciskiem (M2)
- **R11** — pusty Enter = „bez zmian: `<adres>`", nie „Tryb tylko lokalny" (M3)
- **R12** — brakujące klucze frontmattera wracają, istniejące nietknięte (T13)
- **R13** — jedno zadanie z komendą naprawczą i `termin:`; drugi przebieg nie duplikuje (T14)
- **R14** — identyczny wygląd Skrzynki na Macu, VPS i CAVE
- **R15** — „Obsidian zaktualizowany" jako krok onboardingu

**Bramka globalna:** `npm test` przechodzi w całości, baseline **155/155** nie spada.

---

## Ocena ryzyka i mitygacje

| Ryzyko | Waga | Mitygacja |
|---|---|---|
| Kod w trzech repozytoriach — poprawka zostawia dwie stare kopie | Wysoka | U5 likwiduje kopię `close.mjs`; pliki spoza repo oznaczone *(poza repo)* w każdym uncie |
| Migracja `members` na żywej bazie z tokenami zespołu | Wysoka | Kopia `data/inbox.db` przed deployem; fail-fast przy duplikacie zamiast cichego scalenia; test na kopii żywej bazy |
| U5 przed U4 → `close` przestaje startować | Wysoka | Twarda zależność + guard w skillu (czytelny komunikat zamiast `MODULE_NOT_FOUND`) |
| Restart daemona ubija bieżące joby | Średnia | Deploy świadomie; joby chodzą co minutę, okno krótkie ale nie zerowe |
| Niezacommitowane cudze zmiany w `aibiz-plugin` | Średnia | U12 blokuje push do czasu wyjaśnienia z autorem |
| Istniejące duplikaty w archiwum bez markera | Niska | Jednorazowe sprzątnięcie ręczne (Operator checklist U7) |
| Testy jednostkowe przechodzą przy złamanym zachowaniu systemowym | Wysoka | U3 ma jawny scenariusz regresji `reply.mjs`; U5 — scenariusz „close → archiwum", którego brak sprawił, że T8 zaliczył się przy kasowaniu treści |

---

## Mierniki sukcesu

1. **BILANS w szablonie testów** — wszystkie 12 pozycji z kolumną „zamknięta? = tak".
2. **Tabela regresji pusta** — nic, co działało wcześniej, nie przestało.
3. **T6 zielony** — jedyny oblany test rundy 04.08.
4. **`npm test` ≥ 155/155.**
5. **T12 przechodzi bez ani jednego ręcznego kroku** — jedyny miernik obietnicy złożonej kursantom.

---

## Wymagane zasoby i zależności

- **Maszyny:** Mac (dev + client), VPS (hub + agent, dostęp ssh), CAVE/Windows (**poligon testowy**, instalacja zipowa bez gita)
- **Repozytoria:** `claude-cron` (główne), vault `.claude/skills/deleguj/`, `aibiz-plugin`
- **Deploy:** VPS `git pull` + restart usługi · Mac restart daemona · CAVE `install.ps1`
- **Blokada zewnętrzna:** U12 wymaga kontaktu z autorem niezacommitowanych zmian w `aibiz-plugin`

---

## Granice scope'u

- **Pozycje 5, 6, 9 zamknięte decyzją 05.08** — nie wskrzeszać bez nowego argumentu
- **Nie przeładowujemy `CLAUDE_CRON_VPS_URL` w locie** — pokazywać, nie przeładowywać
- **Nie przepisujemy CSS bez `:has()`** — update Obsidiana na CAVE naprawił wygląd
- **Nie domykamy statusem odpowiedzianych `query`** — świadomy dług widok↔status
- **Nie budujemy synchronizacji maszyn** — CAVE to poligon, jeden deploy na koniec
- **Nie dotykamy hasła w historii gita vaulta** — osobny incydent
