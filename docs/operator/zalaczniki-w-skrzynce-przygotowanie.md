---
feature_slug: zalaczniki-w-skrzynce
origin: docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md
utworzono: 2026-09-03
dotyka_ui: false
status: gotowe
---

# Załączniki w Skrzynce Team OS — Operator checklist (przygotowanie przed implementacją)

**Etap:** Załączniki w Skrzynce Team OS · **Utworzono:** 2026-09-03 · **Zależy od:** —
Źródło: `docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md`

> Lista kroków, które robi **człowiek poza kodem**: decyzje, konfiguracja huba, weryfikacje środowiska, dystrybucja do zespołu.
> Kod (endpointy, migracje, render, testy) powstaje w implementacji — nie jest tutaj.
> Legenda: 🔓 publiczne (może iść do repo) · 🔒 sekret (nigdy do gita) · `[~]` świadomy dług · *(kod)* nie Twój krok.
> `/dev-plan` dopisze do tej listy pozycje wynikłe z Implementation Units i **zamieni**
> marker `[blokuje: planowanie]` na `[blokuje: faza N]` tam, gdzie zna numer blokowanej fazy.

**Uzupełnione przez /dev-plan 2026-09-03 — pozycje z Implementation Units oznaczone numerem blokowanej fazy.**
Wynik przejścia po IU: **żadna pozycja nie blokuje startu autopilota.** Wszystko, co było potrzebne przed
implementacją, jest odhaczone; pozycje otwarte są z natury po implementacji albo należą do smoke'u.
Plan: `docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md`.

Feature nie wymaga żadnego nowego konta zewnętrznego ani zakupu — cała infrastruktura (hub na VPS-ie,
Tailscale Funnel, tokeny członków) już stoi. **Decyzje blokujące planowanie są rozstrzygnięte, a weryfikacje środowiska wykonane (2026-09-03).
Wszystkie decyzje zapadły. Wykluczenie katalogu w Obsidian Sync wykonuje się dopiero w smoke'u — katalog
jeszcze nie istnieje, a wykluczyć można tylko istniejący.** Otwarte pozycje w sekcji 3 są z natury po implementacji: wydanie skilla
`deleguj` i snippetu `skrzynka.css` oraz aktualizacja pluginu u czterech osób.

**Trzy ustalenia, które `/dev-plan` musi wziąć wprost, bo odchodzą od dokumentu wymagań:**
1. **R12 (kwota per nadawca) unieważnione** — żadnego sufitu na hubie, ani per nadawca, ani globalnego.
2. **Retencja to jedyne sprzątanie:** 14 dni karencji po domknięciu wątku **oraz** twardy limit 90 dni od wysłania,
   niezależny od statusu wątku. Render musi więc obsłużyć „bajty skasowane, wątek nadal widoczny" jako ścieżkę normalną (R5).
3. **Vault ma DWA mechanizmy: Obsidian Sync (Mac ↔ VPS, na żywo) i `obsidian-git` (backup na GitHuba).**
   Katalog załączników ma być wykluczony z **obu** — `.gitignore` (wykonane) oraz lista wykluczeń Obsidian Sync
   (w smoke'u: katalog powstanie dopiero przy pierwszym pobraniu, a wykluczyć można tylko istniejący). Skutek: załączniki żyją wyłącznie na maszynie
   z rolą klienta, nie mają backupu i nie są widoczne na telefonie.

## 1. Decyzje (zero plików, ale blokują resztę)

- [x] **Próg 25 MB liczy się per plik czy per wiadomość?** — **[blokuje: planowanie]**
  - Opcje: A) per plik (R3 dosłownie; wiadomość z 10 plikami po 24 MB przechodzi = 240 MB jednym żądaniem)
    B) per plik **oraz** dodatkowy limit sumy wiadomości (np. 25 MB na wiadomość) C) limit wyłącznie na sumę wiadomości
  - Dlaczego blokuje: R1 dopuszcza wiele plików w jednej wiadomości, a R2 wymaga atomowości — bez tej liczby
    nie da się zaprojektować bramki odrzucającej „przed rozpoczęciem transferu" ani oszacować szczytowego zużycia dysku huba.
  - **Ustalono 2026-09-03: A — próg 25 MB mierzy wyłącznie pojedynczy plik, bez limitu sumy wiadomości.**
    Świadoma konsekwencja po unieważnieniu R12 (decyzja niżej): **jedna wiadomość nie ma żadnego sufitu łącznego**.
    Bramka mierzy wyłącznie pojedynczy plik, więc wiadomość z dwudziestoma plikami po 24 MB przechodzi jako ~480 MB
    w jednym żądaniu. Wniosek dla `/dev-plan`: R2 (atomowość — wiadomość powstaje tylko gdy wszystkie pliki dotarły)
    musi być zaprojektowane bez założenia, że transfer jest mały.

- [x] **Kwota miejsca na hubie per nadawca (R12)** — **[blokuje: planowanie]**
  - Opcje: A) 250 MB B) 500 MB C) 1 GB D) jeden globalny cap na cały katalog E) bez żadnego sufitu
  - Dlaczego blokuje: kwota jest egzekwowana „przed zapisem pierwszego bajtu", więc jest wejściem do logiki
    zapisu, a nie ustawieniem do dostrojenia później.
  - **Ustalono 2026-09-03: E — żadnego sufitu na hubie.** Ani kwoty per nadawca, ani globalnego capa.
    Podstawa: dysk huba (`Kacper`) ma 332 GB wolnego przy 93 MB obecnego `data/`, a zespół to cztery zaufane osoby.
  - ⚠️ **R12 z dokumentu wymagań zostaje tym samym unieważnione** — `/dev-plan` NIE buduje licznika bajtów per członek
    ani odmowy „wyczerpana kwota". Sprzeczność zamierzona i świadoma; źródłem prawdy jest ten wpis, nie R12.
  - ⚠️ **Skutek uboczny:** retencja (R11) staje się **jedynym** mechanizmem zwalniającym miejsce, więc twardy limit
    czasu życia załącznika z decyzji niżej przestaje być opcjonalny. Ryzyko przyjęte świadomie: zapętlony nadawca
    albo wyciekły token mogą zapełnić dysk huba (limit 60 żądań/min × 25 MB ≈ 90 GB/h), a zapełniony dysk zatrzymuje
    zapisy SQLite całego Pulsa, nie tylko skrzynki.

- [x] **Okres karencji między domknięciem wątku a skasowaniem bajtów (R11)** — **[blokuje: planowanie]**
  - Opcje: A) 7 dni B) 14 dni C) 30 dni
  - Dlaczego blokuje: to jedyna gwarancja, którą składamy odbiorcy — po niej plik znika z huba bezpowrotnie,
    a u odbiorcy zostaje tylko wtedy, gdy zdążył go pobrać.
  - **Ustalono 2026-09-03: B — 14 dni od domknięcia wątku.** Zapas na urlop albo tydzień bez zaglądania
    do Skrzynki, bez zamieniania huba w archiwum spraw już załatwionych.

- [x] **Czy wątek, który nigdy nie zostanie domknięty, ma twardy limit czasu życia załącznika?** — **[blokuje: planowanie]**
  - Opcje: A) nie — kwota z R12 jest jedynym bezpiecznikiem (nadawca sam robi miejsce, kasując swoje stare wątki)
    B) tak, twardy sufit (np. 90 / 180 dni od wysłania), niezależny od statusu wątku
  - Dlaczego blokuje: to otwarte pytanie oznaczone w wymaganiach jako „wymaga researchu" (dotyczy R11).
    Po unieważnieniu R12 (decyzja wyżej) przestało to być opcjonalne: bez sufitu i bez limitu czasu **nic**
    nigdy nie zwalniałoby miejsca zajętego przez wątki, których nikt nie domyka.
  - **Ustalono 2026-09-03: B — twardy limit 90 dni od wysłania**, niezależny od statusu wątku.
    Metadane załącznika (nazwa, rozmiar, typ) zostają w wątku — znikają wyłącznie bajty, więc wątek pozostaje czytelny.
  - ⚠️ Świadome napięcie z uzasadnieniem R11 („plik z długo ciągnącej się sprawy nie może zniknąć, zanim ktoś go
    pobierze"): po kwartale może. Przyjęte, bo kto pliku potrzebował, miał kwartał na jedno odhaczenie, a pobrana
    kopia leży w jego vaulcie na stałe.
  - ➜ Domyka to odroczone pytanie techniczne z R5: render **musi** obsłużyć stan „bajty skasowane, wątek nadal widoczny" —
    to teraz ścieżka normalna, nie skrajny przypadek.

- [x] **Gdzie w vaulcie lądują pobrane załączniki (R7)** — **[blokuje: planowanie]**
  - Opcje: A) `Zasoby/inbox-zalaczniki/RRRR-MM/` (obok istniejącego `Zasoby/inbox-archive/RRRR-MM.md`)
    B) katalog per wątek, np. `Zasoby/inbox-zalaczniki/<thread>/` C) domyślny katalog załączników Obsidiana z konfiguracji vaulta
  - Dlaczego blokuje: R7 wymaga natywnego podglądu w Obsidianie **oraz** widoczności w archiwum wątku, a R8 —
    żeby regeneracja Skrzynki nie kasowała plików. To konwencja układu vaulta, więc rozstrzyga ją człowiek;
    **schemat nazywania plików** (kolizje między nadawcami) zostaje do `/dev-plan`.
  - **Ustalono 2026-09-03: A — `Zasoby/inbox-zalaczniki/RRRR-MM/`**, w tej samej konwencji miesięcznej co istniejące
    `Zasoby/inbox-archive/RRRR-MM.md`. Jeden katalog do wykluczenia z syncu albo objęcia backupem.
  - Fakt z vaulta (sprawdzone 2026-09-03): `.obsidian/app.json` **nie ma** `attachmentFolderPath`, więc domyślny
    katalog załączników Obsidiana to korzeń vaulta — wariant „zostawmy to Obsidianowi" odrzucony.
    `newLinkFormat: absolute`, więc osadzenie po pełnej ścieżce działa z dowolnej notatki.

- [x] **Czy katalog załączników trafia do gita vaulta?**
  - **Sprostowanie sprostowania (2026-09-03).** W trakcie sesji zapisałem tu, że vault „nie chodzi na Obsidian Sync" —
    to było **błędne**, wywnioskowane z braku `.obsidian/sync.json` (Obsidian Sync trzyma konfigurację poza vaultem).
    Stan faktyczny: vault ma **dwa niezależne mechanizmy naraz**:
    1. **Obsidian Sync** — `ob sync --path /home/claude/vault --continuous` żyje na VPS-ie, znaczniki heartbeatu
       (`Zasoby/_sync/mac.md`, `vps.md`) odświeżone w tej samej minucie. To ścieżka Mac ↔ VPS, na żywo.
       Pilnuje jej job „Sync — kontrola synchronizacji vaulta" (`scripts/sync-heartbeat.mjs`).
    2. **`obsidian-git`** — auto-commit co 5 min, push do prywatnego `AIBiz-Automatyzacje/obsidian-vault-kacper`.
       To warstwa **backupu**, nie synchronizacji. `.git` waży 5,3 GB.
  - **Ustalono 2026-09-03: `Zasoby/inbox-zalaczniki/` trafia do `.gitignore` vaulta** (wykonane, sekcja 2).
    Powód niezmieniony: blob w historii gita jest nieodwracalny, a bajty od nadawcy — w modelu zagrożenia obejmującym
    wyciekły token — nie mają być pushowane do firmowego repo na GitHubie. `.gitignore` vaulta już wyklucza
    `*.mp4 *.mov *.avi *.mkv *.zip *.rar`, więc wpis obejmuje resztę (PNG, PDF, DOCX).
  - ⚠️ **Korekta wcześniej zapisanego kosztu:** napisałem, że pobrany plik „nie pojawi się na pozostałych maszynach".
    **Nieprawda** — `.gitignore` nie dotyczy Obsidian Sync, więc plik normalnie dojedzie na VPS.
    Realny koszt jest inny i węższy: załączniki **nie mają backupu w historii gita**, więc po wygaśnięciu retencji
    na hubie istnieją wyłącznie w żywych vaultach.

- [x] **Czy katalog załączników wyłączyć również z Obsidian Sync?**
  - Dlaczego to osobne pytanie: Obsidian Sync **nie czyta `.gitignore`** — ma własną listę wykluczeń w ustawieniach.
  - **Ustalono 2026-09-03: B — `Zasoby/inbox-zalaczniki/` wykluczone także z Obsidian Sync.**
    Bajty zostają wyłącznie na maszynie, która świadomie je pobrała. Nic z załączników nie trafia do
    `/home/claude/vault` na VPS-ie, czyli poza zasięg agenta auto-reply — bariera przestaje być wyłącznie
    proceduralna (świadome odhaczenie + R10) i staje się fizyczna.
  - ⚠️ **Trzy skutki do przyjęcia:**
    1. **Kryterium sukcesu „zrzut ekranu widoczny w Obsidianie po jednym odhaczeniu" przestaje działać na telefonie.**
       Pobiera Mac (rola klienta); telefon i VPS zobaczą osadzenie wskazujące na nieistniejący plik. Załączniki
       ogląda się tam, gdzie stoi maszyna z rolą klienta.
    2. **Załączniki nie mają ŻADNEJ kopii zapasowej** — ani w historii gita (`.gitignore`), ani w Obsidian Sync.
       Po wygaśnięciu retencji na hubie (14 dni po domknięciu / 90 dni twardo) jedyny egzemplarz leży na dysku
       jednej maszyny. Backup tej maszyny (Time Machine albo równoważny) staje się jedyną siatką bezpieczeństwa.
    3. Renderowanie i wykrywanie stanu pobrania („obecność pliku na dysku") pozostaje spójne, bo `Skrzynka.md`
       generuje wyłącznie maszyna z rolą klienta — ale ta spójność opiera się teraz na utrzymaniu rozdziału ról.
  - ➜ **Wykonanie przeniesione do smoke'u operatora (ustalone 2026-09-03).** Powód: wykluczenia w Obsidian Sync
    wybiera się z listy **istniejących** katalogów, a `Zasoby/inbox-zalaczniki/` powstanie dopiero przy pierwszym
    pobraniu. Dziś nie ma czego wskazać. Szczegóły w pozycji na końcu tego dokumentu.

## 2. Konta, konsole, sekrety

Nowych kont, tokenów ani zmiennych środowiskowych **nie ma** — hub, Funnel i tokeny członków działają.
Cała sekcja wykonana 2026-09-03.

- [x] 🔓 **`Zasoby/inbox-zalaczniki/` dopisane do `.gitignore` vaulta** — wykonane 2026-09-03, PRZED pierwszym pobraniem
  - Po co: `obsidian-git` commituje co 5 minut i pushuje na GitHuba. Pierwszy pobrany załącznik wejdzie do historii
    w ciągu pięciu minut, a bloba z historii nie da się później po prostu usunąć. Kolejność jest tu treścią decyzji,
    nie porządkiem — spóźniony wpis nie naprawia tego, co już poszło.
  - Jak: dopisz linię `Zasoby/inbox-zalaczniki/` do `<vault>/.gitignore` (obok istniejących wzorców `*.mp4`, `*.zip`).
  - Dowód (2026-09-03): `git check-ignore` potwierdza ignorowanie zarówno `Zasoby/inbox-zalaczniki/test.png`,
    jak i ścieżki zagnieżdżonej `Zasoby/inbox-zalaczniki/2026-09/zrzut.png`. Wpis opatrzony komentarzem
    wyjaśniającym, dlaczego kolejność (przed pierwszym pobraniem) jest treścią, nie porządkiem.

- [x] 🔓 **Tailscale Funnel przepuszcza 25 MB w obie strony** — zmierzone 2026-09-03
  - Metoda: tymczasowy odbiornik na hubie (`127.0.0.1:7788`, tylko licznik bajtów) wystawiony przez
    `tailscale funnel --https=10000` na czas pomiaru, zwinięty zaraz po. Pomiar z MacBooka, ale
    **z wymuszeniem publicznego ingressu** (`curl --resolve host:10000:185.40.234.198`) — bez tego MagicDNS
    rozwiązuje nazwę na `100.122.215.61` i ruch omija Funnel, dając fałszywy wynik.
    Dowód, że ścieżka jest zewnętrzna: `GET /api/status` przez ingress zwraca **403** (guard `X-Forwarded-For`),
    a po tailnecie 200.
  - Wynik — **wysyłka**: 26 214 400 B, HTTP 200, **17,4 s** (~1,5 MB/s). **Pobieranie**: 26 214 400 B, HTTP 200,
    **12,4 s i 13,4 s** w dwóch próbach (~2,0 MB/s). Rozgrzewka 1 MB: 1,2 s.
  - Wniosek: **Funnel nie ma limitu rozmiaru ciała ani timeoutu, który by nam przeszkadzał** przy 25 MB.
    Ograniczeniem jest łącze, nie tunel.
  - ⚠️ **Rozstrzyga odroczone pytanie techniczne o limit czasu (dotyczy R1, R6):** dzisiejszy timeout klienta
    to **15 s**, a sam transfer trwał 17,4 s na dobrym łączu stacjonarnym. Operacje binarne **muszą** dostać
    osobny, znacznie wyższy limit — przy uploadzie 300 kB/s (hotel, LTE w ruchu) 25 MB to ~87 s.
    Wartość progu dobierz w `/dev-plan` od najgorszego realnego łącza, nie od tego pomiaru.
  - ⚠️ Drugi wniosek dla `/dev-plan`: przy takich czasach **zerwany transfer to scenariusz normalny**, nie skrajny —
    R2 (wiadomość powstaje tylko gdy wszystkie pliki dotarły) potrzebuje jawnej ścieżki wznowienia albo
    czystego porzucenia niedokończonej wysyłki, nie tylko happy path.

- [x] 🔓 **Wolne miejsce na dysku VPS-a huba** — sprawdzone 2026-09-03
  - Wynik: `Kacper` (alias ssh `vps`), `/` = 387 G, wolne **332 G** (15% zajęte), całe `data/` = 93 MB.
    Baza skrzynki żyje w `inbox.db-wal` (3,8 MB) — główny plik `inbox.db` ma 4 KB i datę z lipca, co jest normalne
    przy WAL, nie oznaką martwej instalacji. **Uwaga przy backupie huba: pominięcie `-wal` znaczy backup bez danych.**
  - Wniosek: dysk nie jest ograniczeniem — to ta liczba stoi za rezygnacją z kwot (decyzja 2).

## 3. Assety i treści

Trzy pierwsze pozycje są **zablokowane na implementacji** — tekst skilla i style powstają w kodzie,
a krokiem człowieka jest dopiero ich wydanie i rozesłanie. Trzymamy je tu, bo bez nich feature działa
tylko u autora i wygląda na zepsuty u reszty zespołu.

- [ ] 🔓 **Wydaj zaktualizowany skill `deleguj` w pluginie zespołowym** *(po implementacji)* — dostarcza: Kacper — ląduje w: repo `aibiz-plugin`
  - `deleguj` mieszka poza tym repo, więc commit i podbicie wersji pluginu to osobny krok. Bez niego nikt
    w zespole nie ma komendy z argumentem ścieżki pliku (R1). Sam tekst skilla pisze implementacja *(kod)*.
  - **Konkret z IU-5 (/dev-plan 2026-09-03):** skill musi udokumentować **powtarzalne `--attach <ścieżka>`**
    (jedna flaga na plik). Świadomie nie lista rozdzielana separatorem — ścieżki zawierają spacje, a lekcja
    z `--content` mówi, że wszystko przechodzące przez parser linii poleceń PowerShella potrafi się cicho rozpaść.

- [ ] 🔓 **Poproś zespół (4 osoby) o aktualizację pluginu** *(po wydaniu wyżej)* — dostarcza: Kacper
  - Bez tego nadawcy zostają na starej komendzie, a odbiorcy i tak zobaczą checkbox pobrania — feature zadziała
    w jedną stronę i będzie wyglądał na zepsuty.

- [ ] 🔓 **Wydaj `skrzynka.css` razem ze skillem, jeśli render dołoży nowe klasy** *(po implementacji)* — dostarcza: Kacper — ląduje w: szablon w repo pluginu **oraz** `<vault>/.obsidian/snippets/skrzynka.css`
  - **Ustalenie 2026-09-03:** jeśli wiersz załącznika (nazwa · rozmiar · typ + checkbox pobrania) dołoży klasy `os-*`,
    szablon w pluginie i snippet w vaultcie idą **jednym wydaniem**. Rozjazd między nimi jest wykrywany automatycznie
    przez job „Puls — kontrola spójności", więc wydanie połowiczne skończy się zadaniem w vaulcie przy każdym runie.
    Sam CSS pisze implementacja *(kod)*.

- [x] 🔓 **Pliki testowe** — przygotowane 2026-09-03
  - `test-25mb.bin` (dokładnie 26 214 400 B) i `test-1mb.bin` w katalogu roboczym sesji, poza repo.
    Użyte do pomiaru Funnela; przydadzą się ponownie do smoke'u po implementacji.
    Do sprawdzenia progu z R3 dorób jeszcze plik minimalnie **powyżej** 25 MB — odmowa jest tu zachowaniem,
    które trzeba zobaczyć, nie tylko założyć.

## 4. Makiety

Etap nie dotyka UI — brak makiet do przygotowania. Warstwa widoczna dla człowieka to `Skrzynka.md` w vaulcie
(callouty Obsidiana renderowane przez `inbox-pull.mjs`), a panel załączników w dashboardzie webowym jest
jawnie poza zakresem. Wzorcem renderu pozostaje istniejący `mockup-skrzynka.html`.

## Do smoke'u operatora (po implementacji, przed pierwszym użyciem w zespole)

Pozycje niewykonalne przed implementacją, bo zależą od artefaktów, które dopiero powstaną.
`dev-docs-complete` generuje osobny dokument smoke'u — **przepisz je tam**.

- [ ] 🔓 **Wyklucz `Zasoby/inbox-zalaczniki/` z Obsidian Sync — na Macu (maszyna z rolą klienta)**
  - **Kolejność jest treścią, nie porządkiem.** Pierwsze pobranie tworzy katalog i plik jednocześnie, a sync jest
    ciągły — powstaje okno, w którym plik pojedzie na VPS, zanim cokolwiek wykluczysz. Dlatego:
    1. utwórz sam katalog z placeholderem (`Zasoby/inbox-zalaczniki/README.md` z jednym zdaniem, co to za miejsce);
    2. ustawienia Obsidian Sync → wykluczone katalogi → dodaj `Zasoby/inbox-zalaczniki/`;
    3. dopiero teraz pierwsze prawdziwe pobranie.
  - Ustawiasz **na Macu**, nie na VPS-ie: Mac pobiera i Mac wysyła do Sync — jeśli nigdy nie wyśle, VPS nie ma
    czego pobrać. Po stronie VPS-a nie ma nic do zrobienia.
  - Ryzyko okna w praktyce małe (pierwsze pliki będą Twoje własne, testowe), ale przy **pierwszym załączniku
    od innej osoby** wykluczenie musi już działać — to cała treść decyzji o barierze fizycznej zamiast proceduralnej.
  - Dowód: pobierz załącznik, sprawdź `ssh vps 'ls /home/claude/vault/Zasoby/inbox-zalaczniki/ 2>&1'` — ma nie istnieć
    albo być puste.

- [ ] 🔓 **Sprawdź limit rozmiaru pojedynczego pliku w planie Obsidian Sync**
  - Po wykluczeniu katalogu limit przestaje dotyczyć załączników, więc to pozycja porządkowa — ale warto wiedzieć,
    zanim ktoś zaproponuje cofnięcie wykluczenia.

- [ ] 🔓 **Zobacz odmowę przy pliku powyżej progu**
  - Dorób plik minimalnie większy niż 26 214 400 B i sprawdź, że wysyłka jest odrzucona **przed** transferem,
    komunikatem kierującym na Dysk (R3). Odmowa to zachowanie do zobaczenia, nie do założenia.

## Gdzie to ląduje

- 🔓 Karencja (14 dni), twardy limit (90 dni), próg 25 MB per plik i ścieżka `Zasoby/inbox-zalaczniki/RRRR-MM/`
  → konfiguracja huba i klientów w repo (konkretne miejsce ustali `/dev-plan`). Kwot ani capów nie ma.
- 🔓 Wpis `Zasoby/inbox-zalaczniki/` → `.gitignore` **vaulta**, nie tego repo.
- 🔒 Brak nowych sekretów. Token członka i `INBOX_HUB_URL` już żyją w `data/inbox.env` (0600, **poza drzewem vaulta**) —
  ta lokalizacja jest granicą bezpieczeństwa, nie preferencją; nie przenoś jej przy okazji tego feature'a.
- 🔓 Skill `deleguj` i szablon `skrzynka.css` → repo pluginu zespołowego, nie to repo.

---
Gdy **[blokuje: planowanie]** są odhaczone: `/dev-plan docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md`
