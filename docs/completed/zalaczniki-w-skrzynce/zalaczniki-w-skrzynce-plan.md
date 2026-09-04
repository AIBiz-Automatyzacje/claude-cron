Branch: `feature/zalaczniki-w-skrzynce`
Ostatnia aktualizacja: 2026-09-03

# Załączniki w Skrzynce Team OS — mapa zadania

## Źródła

- **Plan techniczny:** `docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md`
- **Requirements doc:** `docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md`
- **Przygotowanie dla operatora:** `docs/operator/zalaczniki-w-skrzynce-przygotowanie.md`

## Cel

Skrzynka Team OS przenosi dziś wyłącznie tekst, więc plik trzeba wysłać osobnym kanałem, a wątek nie wie
o jego istnieniu. Zadanie dokłada załączniki: nadawca podaje ścieżki w komendzie skilla, hub przechowuje
bajty adresowane treścią, a odbiorca ściąga je świadomym odhaczeniem checkboxa „Pobierz" w Skrzynce.
Pobranie jest akcją lokalną — niczego nie zgłasza hubowi i nie domyka wątku.

## Zakres

- **R1.** Załączniki w nowej wiadomości i w odpowiedzi; wiele plików w jednej wiadomości.
- **R2.** Wiadomość powstaje tylko gdy wszystkie jej pliki dotarły na hub.
- **R3.** Plik > 25 MB odrzucany przed transferem; próg mierzy wyłącznie pojedynczy plik.
- **R4.** Powtórzone wysłanie tego samego pliku nie duplikuje bajtów na hubie.
- **R5.** Skrzynka pokazuje nazwę, rozmiar i typ bez pobierania; sync zostaje tekstowy.
- **R6.** Pobranie przez odhaczenie checkboxa, wykonywane przy najbliższym syncu.
- **R7.** Pobrany plik ląduje w `Zasoby/inbox-zalaczniki/RRRR-MM/`, ma natywny podgląd i wchodzi do archiwum.
- **R8.** Po pobraniu render pokazuje osadzony plik zamiast checkboxa; regeneracja niczego nie cofa.
- **R9.** Odhaczenie pobrania jest akcją lokalną — nie zgłasza nic hubowi.
- **R10.** Maszyna w roli agenta nie pobiera nigdy.
- **R11.** Bajty kasowane 14 dni po domknięciu wątku oraz twardo 90 dni od wysłania.
- **R13.** Odwołanie dostępu usuwa załączniki i wiadomości członka, bez osieroconych bajtów.
- **R14.** Nazwa pliku od nadawcy to niezaufane wejście — nie wyznacza miejsca zapisu.

**R12 (kwota miejsca per nadawca) zostało wycofane** decyzją operatora 2026-09-03 — nie ma żadnych kwot
ani sufitów; nie implementuj licznika bajtów per członek.

### Granice scope'u

- Powiadomienia o nowej wiadomości — poza zakresem.
- Integracja z Dyskiem Google — poza zakresem; przy pliku ponad próg tylko odmowa z komunikatem.
- Podgląd (miniatura) przed pobraniem — poza zakresem; Skrzynka pokazuje metadane.
- Edycja i wersjonowanie załączników — poza zakresem; plik jest niezmienny.
- Panel załączników w dashboardzie webowym — poza zakresem.
- Kwoty i sufity miejsca na hubie — poza zakresem (R12 wycofane).

## Fazy

| Faza | Nazwa | IU | Zależy od | Delegaci |
|---|---|---|---|---|
| 1 | Magazyn bajtów na hubie | IU-1, IU-2, IU-3 | Brak | feature-builder-data |
| 2 | Wysyłka z załącznikami | IU-4, IU-5 | Faza 1 | feature-builder-data |
| 3 | Odbiór: render, odhaczenie, zapis do vaulta | IU-6, IU-7, IU-8 | Faza 2 | feature-builder-data |
| 4 | Retencja, sprzątanie i rewokacja | IU-9, IU-10 | Faza 3 | feature-builder-data |

## Kryteria akceptacji całości

- Przekazanie dokumentu do walidacji odbywa się w całości w Skrzynce, bez Discorda ani Dysku.
- Zrzut ekranu od innej osoby jest widoczny w Obsidianie po jednym odhaczeniu — **na maszynie z rolą
  klienta** (zawężenie 2026-09-03: katalog załączników jest wykluczony z Obsidian Sync).
- Archiwum domkniętego wątku zawiera pobrane załączniki.
- Odbiorca nigdy nie znajduje w vaulcie pliku, którego świadomie nie pobrał.
- Sync trwa tyle co dziś, gdy nikt niczego nie pobiera.
- Każda faza: typecheck 0 błędów, testy PASS, review bez otwartych P1; każdy `[E2E]` uruchomiony
  (nie odhaczony ręcznie) — w tym zadaniu scenariuszy `[E2E]` nie ma, weryfikacja idzie przez `node:test`.

## Ryzyka

Zob. sekcja „Ryzyka i zależności" w planie technicznym
`docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md` — w szczególności kruchość kontraktu
render↔parser, brak lokalnych wzorców strumieniowych oraz ryzyko rezydualne dostępu zadań Claude
do vaulta.
