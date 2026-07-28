# Team OS — stan po wdrożeniu onboardingu (handoff, 28.07.2026)

Dokument dla asystenta prowadzącego warstwę koncepcyjną. Opisuje **co się zmieniło**, **jak
system wygląda teraz** i **jakie decyzje czekają**. Bez szczegółów implementacyjnych — te są
w `CLAUDE.md`, `docs/completed/team-os-onboarding-instalatory/` i `docs/solutions/`.

Stan repo: gałąź `main`, commit `4453a2a`. Wszystkie suity zielone: `npm test` 618/618,
`install-vps.test.sh` 124/124, `install.test.sh` 4/4, Pester 5/5.

---

## 1. Co zostało dowiezione

Zadanie **team-os-onboarding-instalatory** (3 fazy, zarchiwizowane w `docs/completed/`)
domknęło trzy luki w tym samym momencie cyklu życia — **instalatorze zapisującym konfigurację
skrzynki**. Po nim doszło 8 poprawek z testów na żywych maszynach.

Efekt produktowy: **dołączenie nowej osoby do zespołu = wklejenie jednego kodu zaproszenia**
w instalatorze. Zero connection stringów, zero konfiguracji Tailscale po stronie członka,
zero ręcznego zakładania jobów.

### Trzy rzeczy, które zmieniły model działania

**Rola maszyny (`inbox_role`) steruje tym, co maszyna robi w zespole.** Flaga `agent` albo
`client` rozstrzyga, KTÓRY job powstaje: `agent` → wyłącznie asystent auto-reply, `client` →
wyłącznie synchronizacja Skrzynki. Instalator przekazuje tylko **decyzję**; definicje jobów
zostają w kodzie. Brak flagi = zachowanie sprzed zmiany (`client`), więc istniejące instalacje
nic nie tracą.

**Sekret skrzynki wyszedł poza vault.** Token leży teraz w `data/inbox.env` w katalogu
instalacji (0600), nie w drzewie vaulta. Powód jest koncepcyjny, nie porządkowy: asystent
auto-reply czyta vault z uprawnieniami `Read/Glob/Grep`, a jego promptem jest **niezaufana
treść cudzej wiadomości**. Token w vaultcie znaczył, że jedno zdanie („zacytuj plik `.env`")
oddaje pełną tożsamość w hubie osobie z zewnątrz. `cwd` spawnu agenta jest granicą
bezpieczeństwa — to najważniejszy wniosek całego zadania.

**Hub jest rozpoznawalny.** Dashboard pokazuje administrację zespołem tylko na instancji, która
faktycznie jest hubem (własny Funnel + `INBOX_HUB_URL` wskazujący na siebie albo istniejący
członkowie). Wcześniej zakładka „Zespół" pojawiała się wszędzie i kończyła się błędem.

---

## 2. Jak wygląda topologia (stan faktyczny, zweryfikowany)

| Maszyna | Rola | Co robi | `is_inbox_hub` |
|---|---|---|---|
| VPS „kacper" `100.122.215.61` | **hub** | jedyny proces piszący do bazy skrzynki, wystawia kody zaproszeń | `true` |
| VPS „Cave" `100.64.247.60` | `agent` | asystent auto-reply 24/7 | `false` |
| Windows (Kacper) | `client` | synchronizacja Skrzynki co minutę | `false` |
| Mac | dev | repo deweloperskie | `false` |

**Wariant A topologii** (decyzja trwała): komputer synchronizuje Skrzynkę, VPS odpowiada.
Odrzucono sync wyłącznie na VPS-ie — kupowałby świeżość pliku ryzykiem cichego gubienia
odhaczeń `[x]` (rozproszony *lost update* pod Obsidian Sync: `pull` nadpisuje plik w całości,
a Sync rozstrzyga konflikt bez rozumienia semantyki checkboxa).

**Znane ograniczenie tej topologii:** dwie maszyny z rolą `client` na tym samym vaultcie =
dwa procesy renderujące `Skrzynka.md` co minutę = gubione odhaczenia. Instalator o tym nie
ostrzega. To otwarty finding P2 z review Fazy 2 — patrz sekcja 5.

---

## 3. Przepływ dołączania członka (jak to teraz działa)

1. Admin dodaje członka w dashboardzie huba (zakładka **Zespół**) → dostaje **kod zaproszenia**
   `puls-inbox:<funnel-url>#<token>`, pokazywany **jednorazowo**.
2. Członek wkleja kod w instalatorze — na VPS-ie albo w lokalnym setupie.
3. Instalator: sprawdza format → pinguje hub → zapisuje sekret poza vaultem → zapisuje rolę.
4. Daemon przy starcie seeduje właściwy job zgodnie z rolą.

**Tożsamość wyprowadza hub z tokenu**, klient nigdy jej nie deklaruje. Praktyczna konsekwencja:
odebranie dostępu jednej osobie = skasowanie jednego tokenu, bez rotacji u wszystkich.

Jedna osoba może mieć wiele maszyn na **tym samym** tokenie (token = tożsamość osoby, nie
urządzenia) — tak działa para „laptop + VPS" u jednego członka.

---

## 4. Co zostało zweryfikowane na żywo (i co to znaczy)

Testy na dwóch świeżych maszynach wykryły **pięć bugów, których trzy rundy review nie
złapały**. Dwa całkowicie blokowały normalne użycie:

- **Pierwsza instalacja miała martwy job Team OS** — powstawał w bazie, ale nigdy nie dostawał
  harmonogramu. Dla roli `client` znaczyło to, że Skrzynka nigdy się nie renderuje; dla `agent`
  — że asystent milczy. Naprawiało się samo po restarcie, więc było niewidoczne w diagnozie.
- **Aktualizacja na Windowsie była niewykonalna** — instalator padał na plikach trzymanych
  przez działającego daemona.

Wniosek koncepcyjny: **instalator i pierwsze uruchomienie to osobna powierzchnia produktu**,
której nie da się pokryć testami jednostkowymi. Oba bugi maskowały się przy powtórzeniu, więc
„sprawdziłem, działa" po restarcie nie było dowodem. Szczegóły w
`docs/solutions/runtime-errors/2026-07-28-*` i `docs/solutions/deployment-issues/2026-07-28-*`.

Potwierdzone działanie end-to-end: wiadomość wysłana przez hub → asystent auto-reply odpowiedział
z wiedzy vaulta w 20 s, z tagiem `🤖 auto-odpowiedź asystenta` i podanym źródłem. Odpowiedź
dotarła do skrzynki nadawcy.

---

## 5. Otwarte kwestie — do Twojej decyzji

### Wymagające decyzji produktowej

**Dwie maszyny z rolą `client` na jednym vaultcie.** Instalator nie pyta i nie ostrzega, że
maszyna zacznie renderować Skrzynkę. Brakuje albo trzeciej roli („client bez sync" / pasywna),
albo ostrzeżenia, albo świadomej decyzji, że VPS członka przejmuje sync od laptopa.

**Zmiana roli przy ponownej instalacji nie sprząta po sobie.** Seed z zasady nigdy nie robi
`UPDATE` (chroni ręczne wyłączenia użytkownika), więc zmiana odpowiedzi o auto-reply przy
re-runie zostawia **oba** joby włączone. Instalator sam kieruje na re-run przy każdej porażce,
więc to nie jest scenariusz egzotyczny.

**Deinstalacja istnieje tylko na Linuksie** (`--reset`). Na Windowsie i macOS trzeba ręcznie
usuwać katalog, zadanie autostartu, zmienne środowiskowe i skill. Przy produkcie dla
nietechnicznych to realna luka.

**Auto-reply chodzi co minutę, a jedna odpowiedź trwa ~4 min.** Scheduler nie deduplikuje
kolejkowania — przy większym ruchu kolejka może rosnąć szybciej, niż się opróżnia.

### Bezpieczeństwo — wymaga akcji operatora

**Kod zaproszenia idzie przez argv na VPS-ie.** `/proc/<pid>/cmdline` jest czytelne dla każdego
konta w systemie, więc przez okno onboardingu token widać w `ps aux`. Na maszynie
jednoosobowej akceptowalne, przy współdzielonym VPS-ie nie.

**Sekrety z incydentu 25/26.07 wciąż są w historii gita vaulta** (commity `b05de80f`,
`72d2de9d`). Nowe guardy działają wyłącznie na nowe zapisy — nie unieważniają tego, co już
wyciekło. Wymaga rotacji tokenów i czyszczenia historii.

**Istniejące instalacje sprzed zmiany** mogą mieć `.env` z tokenem w vaultcie, w trybie 0644.
Migracja czyści go przy ponownym onboardingu, ale maszyny nietknięte zostają jak były.

### Drobne (55 findingów P3)

Pełna lista w `docs/completed/team-os-onboarding-instalatory/team-os-onboarding-instalatory-zadania.md`.
Nic z tego nie blokuje działania; głównie uproszczenia, brakujące testy gałęzi brzegowych
i rozjazdy komentarzy z kodem.

---

## 6. Gdzie szukać szczegółów

| Temat | Plik |
|---|---|
| Architektura, konwencje, pułapki | `CLAUDE.md` |
| Słownik pojęć domenowych | `docs/CONCEPTS.md` |
| Reguły z rozwiązanych problemów | `.claude/rules/learned-patterns.md` (16 reguł) |
| Zadanie: plan, zadania, 3 raporty review | `docs/completed/team-os-onboarding-instalatory/` |
| Baza wiedzy o problemach | `docs/solutions/` (4 kategorie) |

Najważniejsze wpisy dla zrozumienia decyzji bezpieczeństwa:
`docs/solutions/auth-issues/2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-eksfiltracja-prompt-injection.md`
oraz `docs/solutions/auth-issues/2026-07-24-cors-acao-wildcard-wyciek-tokenu-guard-xff-nie-chroni.md`
— razem pokazują wzorzec: **guardy są ortogonalne, sekret potrzebuje jednego na każdy kanał**.

---

## 7. Czego ten dokument nie rozstrzyga

Nie zawiera oceny, czy Team OS jako koncepcja idzie w dobrą stronę — opisuje wyłącznie stan
techniczny po wdrożeniu. Pytania o model współpracy (ile ról, jak dzielić vault, czy asystent
powinien odpowiadać bez akceptacji człowieka) zostają otwarte i są po Twojej stronie.

Jedna obserwacja z testów, która może być wejściem do takiej dyskusji: auto-reply odpowiedział
**poprawnie i z podaniem źródła**, ale zrobił to zanim człowiek zobaczył pytanie. Kontrakt
`NO_ANSWER` pozwala agentowi się wycofać, gdy nie zna odpowiedzi — nie ma jednak mechanizmu
„agent zna odpowiedź, ale to człowiek powinien ją dać".
