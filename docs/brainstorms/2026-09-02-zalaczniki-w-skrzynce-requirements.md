---
date: 2026-09-02
topic: zalaczniki-w-skrzynce
---

# Załączniki w Skrzynce Team OS

## Problem

Członek zespołu, który chce przekazać komuś plik, robi to dziś poza Pulsem: wrzuca go na Discorda albo na Dysk, a osobno pisze wiadomość w Skrzynce. Kontekst rozjeżdża się na dwa kanały. Wątek w Skrzynce nie wie, że plik istnieje, archiwum wątku go nie zawiera, a odbiorca musi skojarzyć dwie rzeczy z dwóch miejsc.

Dotyczy wszystkich członków zespołu (dziś cztery osoby), w obie strony. Najczęstsze przypadki to dokument do walidacji, zrzut ekranu z błędem, kreacja graficzna i wycinek techniczny.

Ziarno: `docs/ideation/2026-09-02-skrzynka-zalaczniki-powiadomienia-ideation.md`, pomysły 1 i 2.

## Wymagania

### Wysyłanie
- **R1.** Nadawca dołącza plik do nowej wiadomości oraz do odpowiedzi w wątku, podając ścieżkę w komendzie skilla delegowania. Jedna wiadomość może nieść wiele plików.
- **R2.** Wiadomość powstaje tylko wtedy, gdy wszystkie jej pliki dotarły na hub. Częściowa wysyłka nie tworzy wiadomości z brakującym załącznikiem.
- **R3.** Plik większy niż dwadzieścia pięć megabajtów jest odrzucany przed rozpoczęciem transferu, komunikatem który mówi człowiekowi wprost, żeby wrzucił rzecz na Dysk i wysłał link w treści wiadomości.
  **DOPRECYZOWANIE 2026-09-03:** próg mierzy **wyłącznie pojedynczy plik**, bez limitu sumy wiadomości. Po wycofaniu R12
  znaczy to, że jedna wiadomość nie ma żadnego sufitu łącznego — R2 musi być zaprojektowane bez założenia, że transfer jest mały.
- **R4.** Powtórzone wysłanie tego samego pliku nie duplikuje bajtów po stronie huba.

### Odbiór
- **R5.** Skrzynka pokazuje przy wiadomości nazwę pliku, jego rozmiar i typ, bez pobierania czegokolwiek. Sync pozostaje operacją czysto tekstową.
- **R6.** Odbiorca pobiera załącznik odhaczając checkbox w Skrzynce, tak samo jak dziś odhacza „Zrobione" i „Zapoznane". Pobranie następuje przy najbliższym syncu.
- **R7.** Pobrany plik ląduje w vaulcie odbiorcy i od tego momentu ma natywny podgląd w Obsidianie oraz jest widoczny w archiwum wątku.
  **DOPRECYZOWANIE 2026-09-03:** miejsce zapisu to `Zasoby/inbox-zalaczniki/RRRR-MM/`; katalog wykluczony z gita vaulta
  (`obsidian-git` commituje i pushuje na GitHuba, a blob w historii jest nieodwracalny). Schemat nazywania plików — do `/dev-plan`.
- **R8.** Po pobraniu Skrzynka pokazuje osadzony plik zamiast checkboxa. Regeneracja Skrzynki przez sync nie kasuje pobranych plików ani nie cofa stanu pobrania.
- **R9.** Odhaczenie pobrania jest akcją lokalną. Nie zgłasza wykonania zadania ani zapoznania się do huba i nie domyka wątku.
- **R10.** Maszyna pracująca w roli agenta nie pobiera załączników nigdy, niezależnie od stanu checkboxów.

### Pojemność i bezpieczeństwo
- **R11.** Hub przechowuje bajty załącznika dopóki wątek jest otwarty, i kasuje je po domknięciu wątku plus okres karencji. Kopia pobrana przez odbiorcę zostaje u niego na stałe.
  **DOPRECYZOWANIE 2026-09-03:** karencja = **14 dni** od domknięcia wątku. Dodatkowo **twardy limit 90 dni od wysłania**,
  niezależny od statusu wątku — po wycofaniu R12 retencja jest jedynym mechanizmem zwalniającym miejsce, więc wątek
  nigdy niedomknięty nie może rosnąć bez końca. Znikają wyłącznie bajty; metadane zostają, żeby wątek pozostał czytelny.
  Świadome napięcie z uzasadnieniem tego wymagania: po kwartale plik z długo ciągnącej się sprawy jednak zniknie.
- ~~**R12.** Każdy nadawca ma kwotę miejsca na hubie, egzekwowaną przed zapisem pierwszego bajtu. Wyczerpanie kwoty daje odmowę z czytelnym komunikatem, nigdy zapełnienie dysku.~~
  **SPROSTOWANIE 2026-09-03 — wymaganie wycofane.** Żadnego sufitu na hubie: ani kwoty per nadawca, ani globalnego capa.
  Podstawa: dysk huba ma 332 GB wolnego przy 93 MB obecnego `data/`, a zespół to cztery zaufane osoby, więc kwota
  kosztowałaby licznik bajtów per członek i jego utrzymanie przy kasowaniu wątków oraz przy R13 — bez realnej ochrony.
  Ryzyko przyjęte świadomie: zapętlony nadawca albo wyciekły token mogą zapełnić dysk, a to zatrzymuje zapisy SQLite
  całego Pulsa, nie tylko skrzynki. Szczegóły i skutki: `docs/operator/zalaczniki-w-skrzynce-przygotowanie.md`.
- **R13.** Odwołanie dostępu członkowi usuwa również jego załączniki i wiadomości, nie zostawiając osieroconych bajtów.
- **R14.** Nazwa pliku pochodzi od nadawcy i jest traktowana jako niezaufane wejście. Nie może wyznaczać miejsca zapisu ani wyprowadzić zapisu poza przeznaczony katalog.

## Kryteria sukcesu

- Przekazanie komuś dokumentu do walidacji odbywa się w całości w Skrzynce, bez sięgania po Discorda ani Dysk.
- Zrzut ekranu przysłany przez inną osobę jest widoczny w Obsidianie po jednym odhaczeniu, bez opuszczania aplikacji.
  **ZAWĘŻENIE 2026-09-03:** obowiązuje **na maszynie z rolą klienta**, nie na telefonie. Katalog załączników jest
  wykluczony z Obsidian Sync (decyzja o niewpuszczaniu cudzych bajtów do `cwd` agenta auto-reply na VPS-ie),
  więc plik istnieje tylko tam, gdzie został pobrany.
- Archiwum domkniętego wątku zawiera pobrane załączniki, więc wątek pozostaje czytelny po miesiącach.
- Odbiorca nigdy nie znajduje w swoim vaulcie pliku, którego świadomie nie pobrał.
- Sync trwa tyle co dziś, gdy nikt niczego nie pobiera.

## Granice scope'u

- **Powiadomienia o nowej wiadomości są poza zakresem.** Odłożone świadomie; ocalałe pomysły czekają w dokumencie ideacji.
- **Materiały produkcyjne nie przechodzą przez Skrzynkę.** Nagrania, surówki i duże archiwa przekraczają próg i mają iść Dyskiem. Puls niesie wtedy wyłącznie link w treści.
- **Puls nie integruje się z Dyskiem Google.** Nie wrzuca plików w imieniu człowieka i nie zarządza uprawnieniami do udostępniania.
- **Brak podglądu załącznika przed pobraniem.** Skrzynka pokazuje metadane, nie miniaturę.
- **Brak edycji i wersjonowania załączników.** Plik jest niezmienny; poprawiona wersja to nowa wiadomość.
- **Brak panelu do przeglądania załączników** w dashboardzie webowym.

## Kluczowe decyzje

- **Pobranie na żądanie, nie automatycznie**: vault jest katalogiem roboczym agenta auto-reply, który jako polecenie dostaje niezaufaną treść cudzej wiadomości i ma prawo czytać pliki. Automatyczne ściąganie oddawałoby nadawcy możliwość umieszczenia dowolnego pliku w zasięgu tego agenta. Świadome odhaczenie przenosi tę decyzję na człowieka. Model zagrożenia to posiadacz ważnego tokenu, czyli osoba zaproszona przez admina lub ktoś, komu token wyciekł.
- **Checkbox jako mechanizm pobrania**: para render w Skrzynce plus wykrywanie odhaczenia przez sync już istnieje i obsługuje dwie akcje. Trzecia akcja reużywa ten sam kontrakt. Działa na telefonie, nie wymaga pluginu do Obsidiana ani dostępu do sieci wewnętrznej, którego członkowie zespołu nie mają.
- **Obecność pliku na dysku jako stan pobrania**: nie powstaje nowe pole ani nowa tabela, a regeneracja Skrzynki pozostaje bezstanowa.
- **Próg dwadzieścia pięć megabajtów**: mieści krótkie nagrania ekranu i cięższe paczki graficzne, jak limit załącznika w poczcie. Odcina to, co i tak lepiej idzie Dyskiem.
- **Retencja związana z domknięciem wątku, nie ze stałą liczbą dni**: plik z otwartej, długo ciągnącej się sprawy nie może zniknąć, zanim ktoś go pobierze.
- **Odmowa zamiast automatycznego przejścia na Dysk**: hub nie musi trzymać poświadczeń Dysku ani rozumieć jego uprawnień. Ciężar dużych plików zostaje tam, gdzie jest dzisiaj.

## Zależności i założenia

- Odbiorca ma działający sync Skrzynki, czyli rolę klienta. Bez syncu nie ma ani checkboxów, ani pobierania.
- Członkowie zespołu nie mają dostępu do sieci wewnętrznej huba, więc każda ścieżka odbioru musi działać przez publiczne wejście skrzynki, uwierzytelnione tokenem członka.
- ~~Vault jest synchronizowany między maszynami tej samej osoby, więc pobrany plik pojawi się na wszystkich jej urządzeniach…~~
  **SPROSTOWANIE 2026-09-03:** założenie nieaktualne dla załączników. Katalog `Zasoby/inbox-zalaczniki/` ma być
  wykluczony z OBU warstw: z `obsidian-git` (`.gitignore` — już zrobione) i z Obsidian Sync (lista wykluczeń —
  do wykonania w smoke'u, bo wyklucza się tylko katalog już istniejący). Pobrany plik zostaje **wyłącznie
  na maszynie, która go pobrała** — nie dociera na maszynę-agenta ani na telefon i nie ma kopii zapasowej.
  R10 pozostaje w mocy, ale przestaje być jedyną barierą.
- Zakłada się, że przy czterech osobach i tym progu przyrost danych na dysku huba pozostaje pomijalny. Założenie do zweryfikowania po pierwszych miesiącach.

## Otwarte pytania

### Do rozwiązania przed planowaniem
Brak.

### Odroczone do planowania
- ~~[Dotyczy R1, R6][Techniczne] Limit czasu żądania w kliencie skrzynki wynosi dziś piętnaście sekund…~~
  **ZMIERZONE 2026-09-03:** przesłanie 25 MB przez Tailscale Funnel zajęło **17,4 s** (pobranie 12,4–13,4 s), na dobrym
  łączu stacjonarnym. Funnel nie ma własnego limitu rozmiaru ani timeoutu — ogranicza łącze. Wniosek: operacje binarne
  wymagają osobnego, znacznie wyższego limitu, dobranego od najgorszego realnego łącza (przy 300 kB/s to ~87 s),
  a **zerwany transfer jest scenariuszem normalnym**, nie skrajnym.
- [Dotyczy R6, R9][Techniczne] Rozdzielenie akcji lokalnej od akcji zgłaszanej hubowi w kodzie wykrywającym odhaczone checkboxy, bez naruszenia testu przejścia w obie strony między renderem a parserem.
- [Dotyczy R4, R12][Techniczne] Współdzielony licznik żądań na token obejmuje dziś wszystkie operacje skrzynki, więc transfer pliku może wygłodzić własny sync nadawcy. Do rozstrzygnięcia osobny budżet dla operacji binarnych.
- ~~[Dotyczy R11][Wymaga researchu] Zachowanie przy wątku, który nigdy nie zostanie domknięty…~~ **ROZSTRZYGNIĘTE 2026-09-03:** kwoty nie ma (R12 wycofane), więc bezpiecznikiem jest twardy limit 90 dni od wysłania.
- [Dotyczy R7][Techniczne] Miejsce zapisu w vaulcie i sposób nazywania plików, tak aby uniknąć kolizji nazw między nadawcami i zachować czytelność w archiwum.
- [Dotyczy R5][Techniczne] Zachowanie renderu, gdy bajty zostały już usunięte z huba, a wątek jest jeszcze widoczny u odbiorcy. **UWAGA 2026-09-03:** po wprowadzeniu twardego limitu 90 dni to ścieżka NORMALNA, nie skrajny przypadek.

## Sprostowania i doprecyzowania

Naniesione 2026-09-03 w toku `/dev-prep`, zaznaczone w tekście przy odpowiednich wymaganiach.
Źródłem prawdy dla tych punktów jest `docs/operator/zalaczniki-w-skrzynce-przygotowanie.md`, nie pierwotne brzmienie:
**R12 wycofane** · **R11** karencja 14 dni + twardy limit 90 dni · **R3** próg per plik, bez limitu sumy ·
**R7** `Zasoby/inbox-zalaczniki/RRRR-MM/`, poza gitem vaulta · odroczone pytanie o limit czasu — zmierzone.

## Następne kroki

→ `/dev-plan` do planowania technicznego implementacji
