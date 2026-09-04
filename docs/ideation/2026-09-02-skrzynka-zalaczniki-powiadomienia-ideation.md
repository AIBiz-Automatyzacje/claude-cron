---
date: 2026-09-02
topic: skrzynka-zalaczniki-powiadomienia
focus: wysyłanie plików przez Puls + powiadomienie o nowej wiadomości (Team OS / Skrzynka)
---

# Ideacja: Załączniki i powiadomienia w Skrzynce Team OS

## Kontekst codebase

**Architektura.** Hub-and-spoke: Puls na VPS admina jest jedynym procesem piszącym do `data/inbox.db`. Klienci robią `fetch` do `/inbox/v1/:token/:action` przez Tailscale Funnel. Tożsamość = token per członek; tabela `members` ma **zero pól kontaktowych**. Tabela `inbox`: `type(task|query|reply|close)`, `content TEXT`, `payload TEXT` (JSON — workhorse rozszerzeń, precedens `auto_reply_attempted` przez `json_set`).

**Twarde ograniczenia zweryfikowane w kodzie.**
- `readTextBody` (`server.js:745`) robi `req.setEncoding('utf8')` — binaria wracają z U+FFFD. Blokada dotyczy tej **funkcji**, nie tej ścieżki.
- `MAX_BODY_SIZE = 64 KB`, `MAX_CONTENT_LEN = 20 000` (`lib/inbox-api.js`).
- Rate limit 60/min jest **per token, wspólny dla wszystkich akcji** — upload chunkowany zjadałby budżet własnego syncu klienta.
- Guard XFF (`server.js:875`): wszystko poza `/webhook/*`, `/ask/*`, `/inbox/v1/*` daje 403 przez Funnel. `/api/*` jest niedostępne z zewnątrz.
- **Członek zespołu nie konfiguruje Tailscale** (`docs/CONCEPTS.md:46`) — dostaje wyłącznie kod zaproszenia.
- `resolveNotifyConfig` zwraca **jeden** webhook Discorda i **jeden** chat Telegrama na całą instancję. `sendPlain` czyta URL w środku — nie da się go zawołać „do kogoś".
- `pullForUser` (`lib/inbox-db.js:338`) robi `UPDATE status='delivered'` po odczycie — delta „co nowe" jest już darmowa serwerowo.
- `notifyRunOutcome` → `extractResult` parsuje stream-json Claude'a; job skryptowy zawsze daje fallback „Job completed".
- `revokeMember` kasuje wyłącznie wiersz `members`, bez kaskady.

**Stan.** `docs/active/` puste, zero TODO/FIXME w kodzie. Załączniki to zielone pole — zero planów i zero odrzuconych opcji w `docs/`. Powiadomienia istnieją, ale wyłącznie o wyniku runa joba, nigdy o wiadomości.

**Grounding zewnętrzny.** Obsidian mobile stoi na Capacitorze — plugin nie odpali się przy zamkniętej aplikacji na iOS/Androidzie. Brak API na badge pliku lub ikony. `obsidian://open?vault=X&file=Y` działa na obu systemach. Webhook Discorda fizycznie nie wyśle DM. `osascript` na macOS działa tylko z LaunchAgent w katalogu domowym, BurntToast tylko w aktywnej sesji.

## Pomysły w rankingu

### 1. Załącznik jako manifest — bajty nigdy nie wchodzą do vaulta
**Werdykt:** RECOMMENDED
**Opis:** Hub trzyma pliki w `data/inbox-blobs/<sha256>`, poza drzewem vaulta, dokładnie tak jak `data/inbox.env`. Wiadomość niesie wyłącznie `payload.attachments = [{sha256, name, size, mime}]` — bez zmian w tabeli `inbox` i bez zmian w kontrakcie markerów push↔pull. `inbox-pull.mjs` renderuje metadane i link, nigdy `![[plik]]`; materializacja to osobny, świadomy ruch człowieka. Na maszynie `inbox_role=agent` pobieranie blobów jest twardo wyłączone. Warunek wdrożenia: kwota per nadawca egzekwowana **przed** pierwszym bajtem oraz czyszczenie blobów i wiadomości przy `revokeMember`.
**Uzasadnienie:** `sha256` jako identyfikator daje naraz deduplikację, idempotencję retry (której `send` dziś nie ma) i weryfikację integralności. Kwarantanna poza vaultem broni granicy z incydentu z lipca: job auto-reply spawnuje `claude -p` z `cwd` równym vaultowi i `--allowedTools Read,Glob,Grep`, a promptem jest niezaufana treść cudzej wiadomości. Plik w vaulcie to plik w zasięgu czytnika sterowanego przez nadawcę.
**Wady:** Katalog blobów rośnie na VPS bez naturalnego końca. Bez kwoty jeden nadawca zapełnia dysk i kładzie cały scheduler, nie tylko skrzynkę. Załącznik nie jest widoczny natywnie w Obsidianie, tylko jako link.
**Confidence:** 90%
**Złożoność:** Medium
**Status:** Explored (brainstorm 2026-09-02)

### 2. Transport binarny: `readBinaryBody` na istniejącej ścieżce inbox
**Werdykt:** RECOMMENDED
**Opis:** Nowa funkcja obok `readTextBody`, akumulująca `Buffer`, obsługująca akcje `blob` (zapis) i `blob-get` (odczyt) pod `/inbox/v1/:token/`. Ten sam matcher, ten sam token, to samo porównanie `timingSafeEqual`, własny większy cap i **własny licznik rate-limitu**. Ścieżki `/ask` i `/webhook` pozostają nietknięte.
**Uzasadnienie:** Trzy warianty transportu przegrały z tym jednym. Chunkowanie base64 przez istniejący JSON dławi się na współdzielonym buckecie 60/min — plik pięciomegabajtowy to ponad sto żądań, w trakcie których własny sync nadawcy dostaje 429, a upload rwie się bez protokołu wznowienia. Osobny publiczny prefiks dokłada drugą implementację autoryzacji przy zerowym zysku. Pobieranie **musi** iść tą samą trasą, bo `/api/*` jest za guardem XFF, a członek zespołu nie ma Tailscale.
**Wady:** Nowy kształt żądania w module, który dotąd był wyłącznie JSON-owy. Wymaga własnego licznika, inaczej dziedziczy patologię chunkowania.
**Confidence:** 85%
**Złożoność:** Medium
**Status:** Explored (brainstorm 2026-09-02)

### 3. Powiadomienie wychodzi z huba przy `send`, adresowane per członek
**Werdykt:** RECOMMENDED
**Opis:** Osobna tabela `member_notify(member_id, kind, target, ...)` z kaskadą przy `revokeMember` — nie kolumna w `members`, żeby odwołanie kanału nie wymagało rotacji tożsamości. Wysyłka odpalana w handlerze `send` po commicie INSERT, fire-and-forget z `.catch`, bliźniaczo do `notifyRunOutcome`, nigdy nie zmieniając kształtu odpowiedzi `{v:1,...}`. Wymaga nowej funkcji `sendPlainTo(target, text)`, bo dzisiejsze `sendPlain` czyta adres z konfiguracji globalnej w środku.
**Uzasadnienie:** Hub to jedyny proces działający dobę na dobę i jedyny, który wie o wiadomości natychmiast. Wariant „powiadamia klient z delty pulla" przegrywa trzykrotnie: laptop śpi dokładnie wtedy, gdy powiadomienie jest najbardziej potrzebne; na macOS Puls startuje z hooka Claude Code, więc nie istnieje przy zamkniętej maszynie; a konfiguracja kanału musiałaby powstać na każdej maszynie osobno. Trzymanie obu wariantów naraz daje dublety, bo nie ma wspólnego stanu „już powiadomiono".
**Wady:** To pierwsze dane kontaktowe w bazie, której projekt świadomie unikał. Jeśli wysyłka padnie, wiadomość jest już oznaczona jako `delivered` i nigdy się nie przypomni — potrzebny jest ślad nieudanej próby.
**Confidence:** 85%
**Złożoność:** Medium
**Status:** Unexplored

### 4. Discord: jeden kanał zespołu z pingiem, nie prywatne kanały i nie ntfy
**Werdykt:** RECOMMENDED
**Opis:** Jeden kanał `#skrzynka` na serwerze zespołu, jeden webhook, a adresowanie przez `<@discord_user_id>` w treści — natywny ping trafia do konkretnej osoby. `member_notify` trzyma identyfikator użytkownika, nie osobny webhook per osoba. Treść powiadomienia to tytuł, nadawca, typ i deep-link `obsidian://open?vault=X&file=Zadania/Skrzynka.md`, który działa na iOS i Androidzie.
**Uzasadnienie:** Zespół już siedzi na Discordzie z zainstalowaną aplikacją mobilną, więc onboarding kosztuje zero kroków dla Filipa i Mateusza. ntfy wymaga obcej aplikacji, subskrypcji topicu i tłumaczenia na każdym live czym to jest. Cztery prywatne kanały z osobnymi webhookami to cztery artefakty do utrzymania zamiast jednej kolumny. Webhook Discorda nie wyśle DM, a bot potyka się o błąd 50007 przy zablokowanych wiadomościach prywatnych — ping w kanale omija oba problemy. Widoczność treści dla czterech osób w jednej firmie to cecha, nie wyciek.
**Wady:** Wszyscy widzą wszystkie powiadomienia. Przy większym zespole albo wrażliwej treści trzeba będzie wrócić do kanałów prywatnych. Webhook ma limit 2000 znaków i pięć żądań na dwie sekundy.
**Confidence:** 80%
**Złożoność:** Low
**Status:** Unexplored

### 5. `type` wiadomości jako gotowy klucz routingu
**Werdykt:** RECOMMENDED
**Opis:** `query` blokuje nadawcę, więc idzie natychmiast; `task` budzi w godzinach pracy; `reply` i `close` nie pingują wcale albo trafiają do zbiorczego podsumowania. Sygnał ważności już siedzi w schemacie tabeli i nikt go dotąd nie użył. Precedens tłumienia w kodzie: `routine=1` wycisza sukcesy jobów.
**Uzasadnienie:** Dwie linie warunku dają cały zysk, dla którego rozważano osobną warstwę polityki z debounce, oknami ciszy i digestem. Ta warstwa przegrała: przy czterech osobach i kilku wiadomościach dziennie nie ma ruchu do routowania, a jej kluczowa reguła jest w tym systemie po prostu zepsuta — sync leci co minutę, więc znacznik ostatniego pulla jest zawsze świeży i „człowiek właśnie czyta, nie przeszkadzaj" wyciszyłoby sto procent powiadomień.
**Wady:** Rozróżnienie jest zgrubne. Pilny `task` i błahy `task` dostaną to samo traktowanie.
**Confidence:** 85%
**Złożoność:** Low
**Status:** Unexplored

### 6. Ekstrakcja tekstu po stronie nadawcy jako faza zerowa
**Werdykt:** WORTH_EXPLORING
**Opis:** Flaga `--attach plik.pdf` w skillu delegowania wyciąga tekst lokalnie i wkleja go do `content` w ramach istniejącego limitu 20 000 znaków, a metadane oryginału ląduje w `payload`. Zero nowych tabel, zero transportu binarnego, zero retencji i kwot. Precedens argumentu plikowego już istnieje w kodzie po naprawie z sierpnia.
**Uzasadnienie:** Pokrywa najczęstszy przypadek („zobacz ten dokument") przy koszcie jednego popołudnia i nie koliduje z pomysłem pierwszym — można to mieć teraz i dołożyć bajty później.
**Wady:** To nie jest to, o co pytanie było zadane wprost. Samodzielnie brzmi jak wymówka, zwłaszcza przy demonstracji na kursie. Nie działa dla grafiki ani archiwum. Trzyma się tylko jako etap w drodze do pomysłu pierwszego, nigdy jako odpowiedź końcowa.
**Confidence:** 60%
**Złożoność:** Low
**Status:** Unexplored

### 7. Kod QR z zaproszeniem w panelu
**Werdykt:** DEFER
**Opis:** Modal w zakładce „Zespół" pokazuje kod zaproszenia także jako QR, żeby onboarding telefonu nie wymagał przepisywania sześćdziesięciu czterech znaków szesnastkowych. Kodowanie zaproszenia już istnieje w module zapraszania.
**Uzasadnienie:** Tani i dobrze wygląda w demonstracji na żywo. Dotyczy jednak onboardingu, nie żadnej z dwóch funkcji, o które chodziło.
**Wady:** Nie rozwiązuje ani załączników, ani powiadomień. Dokłada zależność albo ręczną implementację generatora.
**Confidence:** 70%
**Złożoność:** Low
**Status:** Unexplored

## Podsumowanie odrzuceń

| # | Pomysł | Powód odrzucenia |
|---|--------|------------------|
| 1 | Upload base64 w chunkach przez istniejący JSON | Współdzielony bucket 60/min dławi własny sync nadawcy i rwie transfer bez protokołu wznowienia |
| 2 | Osobny publiczny prefiks `/files/v1/:token/put` | Podzbiór transportu na ścieżce inbox, z drugą implementacją autoryzacji i nową powierzchnią publiczną |
| 3 | Dwufazowy send jako osobna decyzja | Sposób działania blob store'u, nie temat do przegłosowania; oblewa meeting-test |
| 4 | Materializacja na jawne żądanie jako osobny pomysł | Mechanizm kwarantanny, nie alternatywa dla niej |
| 5 | Skrzynka jako Maildir — katalog załączników w vaultcie | Obsidian Sync i tak dostarczy pliki na maszynę z auto-reply, gdzie czytnik jest sterowany treścią nadawcy; do tego binaria co minutę w vaultcie to ta sama rana co konflikty na `Skrzynka.md` |
| 6 | Cap 64 KB jako cecha — „załącznik to wycinek" | Trzydzieści kilobajtów to nie jest plik; screenshot ma dwieście razy tyle, a `content` i tak mieści 20 000 znaków |
| 7 | Jeden endpoint na pobieranie i banner webowy naraz | Członek zespołu nie ma Tailscale, więc link z Obsidiana daje mu 403; działałby wyłącznie adminowi, który pliku nie potrzebuje |
| 8 | Powiadomienie z klienta z delty pulla | Powiadamia dokładnie wtedy, gdy człowiek i tak patrzy w Obsidiana, a z wariantem hubowym daje dublety |
| 9 | ntfy jako kanał domyślny | Trzeci krok onboardingu i pytanie „co to jest" na każdym live |
| 10 | Powiadomienie bez treści jako osobny pomysł | Na prywatnym serwerze zespołu argument o treści u obcych jest pusty; zostaje jako format |
| 11 | Wiązanie Telegrama przez `/start <nonce>` | Nowa publiczna powierzchnia i drugi bot po to, żeby nie wkleić identyfikatora czatu cztery razy |
| 12 | Warstwa polityki z debounce, oknami ciszy i digestem | Polityka bez ruchu do routowania, a jej kluczowa reguła wyciszyłaby wszystko przy syncu co minutę |
| 13 | Powiadomienie jako zwykły job Pulsa | Iluzja: ekstrakcja wyniku parsuje stream-json Claude'a, więc job skryptowy daje „Job completed", a `routine=1` i tak tłumi sukcesy |
| 14 | Banner skrzynki w panelu webowym plus licznik w tytule karty | Nikt nie trzyma otwartej karty panelu; sensowne jako drobiazg UI, nie jako powiadomienie |
| 15 | Fanout z eskalacją i tabelą logu powiadomień | Ceremonia przy jednym kanale i czterech osobach |
| 16 | Agent robi triage zamiast człowieka | Promptem triażu byłaby niezaufana treść nadawcy, który może wprost poprosić o oznaczenie „niepilne"; przy kilku wiadomościach dziennie droższe niż przeczytanie ich |
| 17 | `last_pull_at` jako wspólny sygnał obecności | Wszyscy trzej konsumenci zabici, a `delivered` plus `updated_at` już to daje |

## Log sesji
- 2026-09-02: Początkowa ideacja — 34 surowe pomysły z czterech agentów (architektura i bezpieczeństwo, UX, produkt i routing, analogie cross-domain plus odwracanie założeń), 22 po deduplikacji i syntezie cross-cutting, 7 ocalałych po dwuwarstwowej krytyce adversarialnej.
- 2026-09-02: Zawężenie zakresu decyzją użytkownika — powiadomienia (pomysły 3, 4, 5) odłożone, praca skupiona wyłącznie na załącznikach. Brainstorm pomysłów 1 i 2 jako jednego kierunku.
