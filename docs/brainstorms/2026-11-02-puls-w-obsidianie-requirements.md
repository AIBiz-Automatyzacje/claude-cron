# Puls w Obsidianie (Launcher + claude-cron)

Spec dla `claude-cron` i `obsidian-claude-launcher`. Plan zaakceptowany przez Kacpra 02.11.2026, powstał z analizy OpenBota (github.com/nightly-labs/openbot, v0.58.0). Kodu jeszcze nie ruszamy.

## Ustalenia (01.11)

1. Panel Pulsa = **własny ekran pluginu** w Obsidianie (nie osadzona strona `localhost`). Plugin rozmawia z Pulsem przez jego API (`/api/jobs`, `/api/runs/*`, `/api/settings/*`, `/api/status`).
2. Kod ekranów żyje w **Launcherze** (jedna instalacja przez BRAT).
3. Jedna ikona Pulsa w lewym pasku Obsidiana otwiera kartę. W karcie wąski pasek ikon **bez podpisów** (podpowiedź po najechaniu), jak w OpenBocie. Ikony Lucide, te same co w Obsidianie.
4. **Puls chodzi także przy zamkniętym Obsidianie** → autostart systemowy (launchd na Macu, Harmonogram zadań na Windowsie) zamiast obecnego hooka `UserPromptSubmit`.
5. Nazewnictwo w interfejsie: **„rutyna”** zamiast „job/zadanie”, **„serwer”** zamiast „VPS”.
6. Przełącznik serwerów w lewym górnym rogu karty: „Lokalny” / „Serwer”. Połączenie na razie przez Tailscale.
7. Wypadają: Zadania (jednorazowe zlecenia w tle, Kacper ma to w sesjach w tle Claude Code), Marketplace. Na sam koniec: Przepływy pracy.

## Ekrany

- **Rutyny**: lista + formularz wzorowany na OpenBocie: przełącznik Aktywna, Nazwa, „Kiedy uruchamiać” z zakładkami Harmonogram / Webhook, wybór klikami (Codziennie / w dni robocze / co tydzień + godzina) z opisem zdaniem („W dni robocze o 8:30”), cron jako opcja zaawansowana, Instrukcja, podpowiedź o cichej rutynie, „Gdy konto osiągnie limit” (zaczekaj do resetu / pomiń), „Gdy komputer był wyłączony w zaplanowanym czasie” (pomiń / uruchom po starcie).
- **Harmonogram**: kalendarz miesiąca z rutynami; przy każdym przebiegu jednolinijkowa notatka z wyniku („skrzynka pusta”). Pusty stan z przyciskiem „Utwórz rutynę”.
- **Użycie**: koszt dzienny, sumy, podział na rutynę / model / dzień. Dane już są w historii przebiegów.
- **Historia**: statusy jak w OpenBocie: Czeka, Pracuje, Wymaga uwagi, Udany, Nieudany, Przerwany, Anulowany oraz „Pominięto: komputer był wyłączony”, „Uruchomiono z opóźnieniem”.
- **Ustawienia**: powiadomienia, skrzynka zespołu, serwer.

## Zmiany w logice Pulsa (claude-cron)

- **Ciche rutyny**: odpowiedź `[[no-update]]` = przebieg bez powiadomienia, zwinięty w historii (w OpenBocie narzędzie `routine_no_update`).
- **Limit konta**: przy limicie subskrypcji rutyna czeka na reset zamiast padać.
- **Pominięte przebiegi**: polityka per rutyna + wpis w historii.
- **Notatka z wyniku**: jedno zdanie podsumowania z każdego przebiegu (do kalendarza).
- **Aktualizacja w przerwie**: restart po samoaktualizacji czeka, aż żadna rutyna nie chodzi.

## Instalacja z pluginu: czy się da

Tak. `setup.mjs` zadaje dziś 6 pytań i każde ma wartość, którą plugin zna, sensowną wartość domyślną albo może przejść do ekranu Ustawienia po instalacji.

| Pytanie w `setup.mjs` | Dziś | Z pluginu |
|---|---|---|
| Folder workspace (okno wyboru, l. 1407) | kursant wskazuje vault | plugin zna ścieżkę vaulta, podaje sam |
| Port (tylko gdy 7777 zajęty, l. 1431) | pytanie o inny port | plugin wybiera wolny port sam |
| Tailscale IP serwera (l. 1452) | puste = tylko lokalnie | domyślnie lokalnie; serwer dodaje się później w przełączniku serwerów |
| Kod zaproszenia do skrzynki (l. 1481) | puste = pomiń | domyślnie pomiń; pole w Ustawieniach |
| Powiadomienia Discord/Telegram (l. 1485) | token, chat ID | domyślnie powiadomienia systemowe/Obsidiana; Discord i Telegram w Ustawieniach |
| Autostart [T/n] (l. 1492) | hook w Claude Code | zawsze tak, ale autostart systemowy (nowy kod) |

Rutyny startowe (memory-update, reflect, skill-scout) już idą bez pytania.

Co trzeba dopisać w `claude-cron`:
1. Tryb bez pytań: flagi typu `--workspace <ścieżka> --port auto --yes` i pominięcie okna wyboru folderu. Częściowo działa już dziś, bo przy `curl|bash` readline dostaje EOF i bierze wartości domyślne, ale okno wyboru folderu i tak się pokaże.
2. Autostart systemowy zamiast hooka (launchd / Harmonogram zadań).
3. Plugin przekazuje ścieżkę do binarki `claude`, żeby ominąć problem PATH na Windowsie (główna przyczyna zgłoszeń „`claude` nie działa”).
4. Zmienne środowiskowe: dziś `setup.mjs` zapisuje je do pliku startowego powłoki (`CLAUDE_CRON_WORKSPACE`, `CLAUDE_CRON_PORT`) i każe otworzyć nowy terminal. Przy starcie z autostartu systemowego trzeba je podać wprost w definicji usługi.

## Jak OpenBot robi serwery (dla porównania)

- Własny serwer: jedna komenda instalacji na Ubuntu, logowanie kodem z maila, serwer sam pojawia się na liście w aplikacji (`docs/self-hosted-server.md`).
- Serwer kupiony u nich: każdy serwer to piaskownica w usłudze boat (boat.dev), z własnym planem w Stripe (Starter / Standard / Pro = rozmiar maszyny). Konta i zarządzanie serwerami chodzą na Cloudflare Workers + D1. Serwer usypia po 15 minutach bez użycia i budzi się przy otwarciu aplikacji, przed zaplanowaną rutyną albo przy wiadomości z Telegrama/Discorda/Slacka (`docs/hosted-servers.md`).
- U nas na razie Tailscale. Logowanie kodem z maila wymagałoby własnej usługi pośredniczącej, osobny projekt.

## Kolejność

1. `claude-cron`: tryb instalacji bez pytań + autostart systemowy.
2. Launcher: ikona Pulsa, karta z paskiem ikon, przełącznik Lokalny/Serwer, przycisk „Zainstaluj Pulsa”.
3. Launcher: ekran Rutyny.
4. Launcher: Harmonogram i Użycie.
5. `claude-cron`: ciche rutyny, limit, pominięte przebiegi, notatka z wyniku, aktualizacja w przerwie.
6. Na koniec: Przepływy pracy (pomysł: przepływ rysowany w Obsidian Canvas, Puls czyta plik `.canvas`).

## Otwarte

- Panel w przeglądarce zostaje jako zapas na serwerze; czy go dalej rozwijamy.
- Ekran pierwszego uruchomienia Launchera („Sprawdzam Twój komputer”: Claude Code, logowanie, plugin asystenta, Puls, przycisk „Napraw”) i „Kopiuj diagnostykę”: do wpięcia w plan.
