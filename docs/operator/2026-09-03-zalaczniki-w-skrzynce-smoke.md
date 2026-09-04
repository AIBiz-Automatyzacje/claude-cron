# Smoke operatora — Załączniki w Skrzynce Team OS (R1–R14)

Branch: `feature/zalaczniki-w-skrzynce` · Utworzono: 2026-09-03
Status: **do przejścia** — odhaczaj `[ ]` → `[x]` w miarę przechodzenia.

Automat (pełna suita `node --test` — testy zielone wg walidacji końcowej; 0 scenariuszy E2E w przeglądarce, bo
zadanie nie ma warstwy UI w przeglądarce) jest zielony. Ta lista pokrywa **wyłącznie to, czego automat nie mógł
sprawdzić**: zachowanie realnego transferu binarnego przez publiczny Tailscale Funnel, właściciela i uprawnienia
katalogu magazynu na hubie VPS oraz przemiatanie retencji biegnące w czasie rzeczywistym w żywym daemonie.

Dlaczego to nie jest formalność: cały harness HTTP chodzi po loopbacku, więc nie dowodzi ani buforowania ciała
`PUT` przez proxy Funnela, ani jego limitu rozmiaru żądania, ani timeoutu na kilkunastosekundowym transferze —
Funnel może uciąć ciało powyżej pewnego progu i każdy większy załącznik skończy się zerwanym transferem, czego
loopback nigdy nie pokaże. Właściciel katalogu `data/inbox-blobs/` zależy od usera systemd na hubie, a nie od
kodu (`writeBlobFromStream` ustawia tylko `mode 0600`) — zły user daje ciche `EACCES` przy pierwszym realnym
załączniku. Progi retencji (14 dni po domknięciu wątku, 90 dni od wysłania, 24 h karencji sierot) i sam fakt,
że przemiatanie in-process rusza pod guardem `isInboxHub()`, są weryfikowalne wyłącznie z upływem realnego czasu.

## 0. Przygotowanie (5 min)
> ⚠️ Ten smoke wymaga **wdrożenia gałęzi na hub VPS** (maszyna z rolą `agent`, user daemona `claude`) oraz
> drugiej maszyny **spoza tailnetu** (np. telefon w LTE / laptop na obcym Wi-Fi) do testu przez publiczny Funnel.
- [ ] Gałąź `feature/zalaczniki-w-skrzynce` wdrożona na hub VPS, serwis Pulsa zrestartowany (`systemctl status <unit-pulsa>` → `active (running)`)
- [ ] Aplikacja wstaje: dashboard Pulsa odpowiada przez Tailscale, `/api/status` zwraca `version` (nie `unknown`)
- [ ] Publiczny URL Funnela huba pod ręką (`WEBHOOK_BASE_URL` na hubie — potrzebna sama wartość adresu, nie token)
- [ ] Token członka do testu binarnego wzięty z `data/inbox.env` na maszynie klienckiej (`INBOX_TOKEN` — **nigdy nie wklejaj wartości do tego pliku ani do logów/zgłoszeń**)

**Co będzie potrzebne w trakcie:** plik testowy ~25 MB, dostęp SSH do huba (`ls`, `journalctl`), maszyna spoza
tailnetu, `sha256sum`/`shasum -a 256` do policzenia hasha pliku testowego.

## 1. Transfer binarny przez publiczny Funnel (R2, R4)
Wejście: maszyna **spoza tailnetu**, `curl` na publiczny adres Funnela huba.
- [ ] **[fizyczne urządzenie]** Policz `sha256` pliku ~25 MB i wyślij go `PUT`-em na `https://<funnel-url>/inbox/v1/<INBOX_TOKEN>/blob/<sha256>` → odpowiedź **200**, transfer nie zostaje zerwany ani ucięty; zanotuj zmierzony czas
- [ ] Powtórz **dokładnie to samo żądanie** → odpowiedź 200 z `deduped:true` (bajty nie są zapisywane drugi raz — R4)
- [ ] Na hubie: `ls -la ~/claude-cron/data/inbox-blobs/tmp` → katalog pusty (żaden plik `.part` nie został po transferach)
- [ ] Wyślij przez skill `deleguj` wiadomość z tym plikiem jako `--attach` i sprawdź, że po syncu pojawia się w `Skrzynka.md` u odbiorcy jako wiersz z checkboxem `Pobierz` (nazwa + rozmiar, bez pobierania bajtów)

## 2. Magazyn blobów na hubie — właściciel i uprawnienia (R13)
Wejście: SSH na hub VPS, po wykonaniu sekcji 1 (magazyn powstaje dopiero przy pierwszym `PUT`).
- [ ] `ls -ld ~/claude-cron/data/inbox-blobs` → katalog istnieje, właściciel to user daemona (`claude`), nie `root`
- [ ] `ls -l ~/claude-cron/data/inbox-blobs/<dwa pierwsze znaki sha256>/` → plik blobu z prawami `0600` i tym samym właścicielem

## 3. Retencja i przemiatanie in-process na żywym hubie (R11)
Wejście: SSH na hub VPS, co najmniej godzina od startu serwisu.
- [ ] `journalctl -u <unit-pulsa> | grep '\[inbox-retention\]'` → są wpisy przemiatania i **ani jednego** „przemiatanie padło"
- [ ] Po godzinie od startu serwisu skrzynka nadal odpowiada na `pull` — job „Team OS — inbox sync" w panelu Pulsa świeci zielono, `Skrzynka.md` się aktualizuje (przemiatanie nie zablokowało bazy)

## Znane problemy (nie blokują, sprawdź czy nadal występują)
- Pierwsze przemiatanie retencji biegnie synchronicznie w linii startu serwera (przed `server.listen`) — [P3] świadomie
  pominięty w fazie 4. Objaw, gdyby wystąpił: kilkusekundowe opóźnienie pierwszej odpowiedzi huba po restarcie.

## Jak kontynuować w nowej sesji
Skopiuj jako pierwszą wiadomość:
```
Kontynuujemy smoke operatora zadania "zalaczniki-w-skrzynce" (branch feature/zalaczniki-w-skrzynce).
Checklista: docs/operator/2026-09-03-zalaczniki-w-skrzynce-smoke.md — prowadź mnie punkt po punkcie,
odhaczaj za mnie w pliku, a usterki naprawiaj od razu (z testem) zamiast odkładać.
```
