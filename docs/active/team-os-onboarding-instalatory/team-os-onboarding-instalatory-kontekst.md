# Team OS — onboarding członka w instalatorach — kontekst

Branch: `feature/team-os-onboarding-instalatory` (odbity z `main` po `024653f`)
Ostatnia aktualizacja: 2026-07-26

## Skąd to zadanie

Faza 3 zadania `team-os-hub-api` dostarczyła onboarding **admina** (instalator VPS stawia hub i drukuje kod zaproszenia) oraz onboarding **członka na laptopie** (`setup.mjs` pyta o kod zaproszenia). Przy pierwszym realnym wdrożeniu drugiej osoby (maszyna „Cave") wyszło, że ta ścieżka ma dziurę: **członek z własnym VPS-em nie ma jak skonfigurować skrzynki inaczej niż ręczną edycją `.env`**.

Operator wykonał to dziś ręcznie na produkcyjnym VPS-ie (dopisanie `INBOX_HUB_URL` + `INBOX_TOKEN` do `/home/claude/vault/.env`, restart, włączenie auto-reply z dashboardu). Zadanie polega na tym, żeby tego kroku **nigdy więcej nie musiał robić człowiek** — bo docelowy użytkownik jest nietechniczny i ma wkleić jedną komendę.

Drugi wątek: podczas tej samej sesji doszło do **realnego wycieku sekretów** do prywatnego repo vaulta (szczegóły niżej). Instalator zapisuje token do `.env` w katalogu, który u operatora jest repozytorium gitowym z automatycznym commitem — i nikt tego nie sprawdzał. To domyka się w tym samym zadaniu, bo dotyczy tego samego momentu (zapis sekretu przez instalator).

## Stan obecny

### Co działa dobrze (nie ruszać)

- **`setup.mjs` → `askInboxInvite`** (linia ~904): pyta „Masz kod zaproszenia do skrzynki zespołowej? (puste = pomiń)", parsuje czystą funkcją `parseInviteCode`, **waliduje probe'em na żywym hubie zanim cokolwiek zapisze**, zapisuje przez `writeInboxEnv` (upsert — nie nadpisuje innych kluczy). Każda porażka → warn i pominięcie, nigdy fail setupu. Ten łańcuch jest wzorcowy i zostaje.
- **`parseInviteCode`** — czysta funkcja z pełnymi testami w `setup.test.mjs` (happy path, trim, złe formaty). Format `puls-inbox:<url>#<token>`, rozdzielanie po OSTATNIM `#`.
- **`inbox-seed.js` nigdy nie robi `UPDATE`** — tworzy joby tylko gdy ich brak (`if (!existing.some(...)) db.createJob(...)`). Dzięki temu ręczne wyłączenia jobów przeżywają restart daemona. Ta właściwość jest krytyczna i musi zostać.

### Trzy luki

**Luka 1 — `install-vps.sh` nie ma ścieżki członka.**
Funkcja `setup_team_os_hub` (~1497) obsługuje **wyłącznie tryb admina**: pyta „Postawić hub skrzynki Team OS na tym serwerze? (tylko admin zespołu) [t/N]" (domyślnie N), a przy odpowiedzi N robi `return 0` i temat skrzynki się kończy. Nie ma gdzie wkleić kodu zaproszenia. Konsekwencje:
- członek z VPS-em musi ręcznie edytować `.env` (obecny stan — nieakceptowalny),
- co gorsza: intuicyjna odpowiedź „t" na pytanie o hub postawiłaby **drugi, niezależny hub** — dwie skrzynki, które nigdy się nie zobaczą.

Dodatkowo: nawet **admin** po utworzeniu członka-admina nie ma swojej maszyny skonfigurowanej jako klient — instalator drukuje kod zaproszenia i na tym kończy, mimo że trzyma ten kod w zmiennej i mógłby od razu skonfigurować lokalny `.env`.

**Luka 2 — auto-reply seeduje się wyłączony na każdej maszynie.**
`assistantJobDef` ma `enabled: 0` z komentarzem „Seedowany WYŁĄCZONY — włączenie asystenta to świadoma decyzja per maszyna (panel Pulsa), nie skutek instalacji". W praktyce daje to półprodukt: użytkownik przeszedł instalację, a funkcja nie działa, dopóki nie znajdzie właściwego przełącznika w dashboardzie. Jednocześnie **na laptopie ten wyłączony job tylko myli** — nie powinno go tam być w ogóle.

Sedno problemu technicznego: **joby tworzy daemon (`inbox-seed` przy starcie), a intencję użytkownika zna instalator**, który już dawno się zakończył. `inbox-seed` widzi wyłącznie „skrzynka skonfigurowana" i nie ma pojęcia, czy stoi na VPS-ie, czy na laptopie.

**Luka 3 — żaden instalator nie sprawdza, czy `.env` nie trafi do repo.**
Zdarzenie z 2026-07-25/26 (udokumentowane): vault operatora jest repo gitowym z automatycznym jobem „vault backup" commitującym wszystko nieignorowane. `.gitignore` zawierał wpis `.env`, który dopasowuje **wyłącznie dokładną nazwę pliku**. Kopie `.env.bak.<timestamp>` (z kompletem 35 sekretów: klucze API, hasło Postgresa, token skrzynki) **nie były ignorowane** → zostały zacommitowane i wypchnięte na prywatne repo GitHub (commity `b05de80f`, `72d2de9d`). Naprawione doraźnie (`git rm`, wzorzec `.env*`), ale historia gita nadal je zawiera.

Wniosek systemowy: **instalator zapisuje sekret do katalogu użytkownika i nie weryfikuje, czy ten katalog go nie opublikuje.** Wzorzec `.env` jest niewystarczający — musi być `.env*`. Weryfikacja musi iść przez `git check-ignore` (stan faktyczny), nie przez czytanie treści `.gitignore` — bo reguły negacji, `.gitignore` w katalogach nadrzędnych i globalny `core.excludesFile` sprawiają, że treść pliku nie jest odpowiedzią na pytanie „czy ten plik zostanie zacommitowany".

## Docelowa topologia (wariant A — zatwierdzona przez operatora)

| Maszyna | Sync | Auto-reply |
|---|---|---|
| Laptop (Obsidian, człowiek) | ✅ włączony | ❌ nie seedowany w ogóle |
| VPS (24/7) | ❌ nie włączany | ✅ włączony po pytaniu |

**Uzasadnienie sync na laptopie:** `Skrzynka.md` nie jest tylko wyświetlana — użytkownik ją **edytuje** (odhacza `[x] Zrobione`), a `pull` nadpisuje ją w całości. Gdy zapisuje maszyna A, a edytuje człowiek na maszynie B (vaulty spięte Obsidian Sync), powstaje rozproszony *lost update*: VPS czyta plik sprzed propagacji ptaszka, regeneruje go ze stanu huba, a Obsidian Sync rozstrzyga konflikt na poziomie pliku (nie rozumie semantyki checkboxa) → **odhaczenie znika bez żadnego sygnału**. Projekt rozwiązał już ten wyścig lokalnie (`inbox-sync.mjs` robi push→pull w jednym procesie); Obsidian Sync przywraca go w wersji rozproszonej, której jednoprocesowość nie załatwia.

**Uzasadnienie auto-reply na VPS:** 24/7 jest potrzebne dla **zobowiązań wobec innych** (ktoś pyta w nocy — agent odpowiada). Auto-reply czyta pytania **prosto z huba** (`claimQuery`), nie z `Skrzynka.md`, więc nie zależy od syncu. Renderowanie własnej skrzynki 24/7 nie daje nic, bo przy zamkniętym laptopie nikt jej nie czyta, a wiadomości i tak czekają na hubie (to on jest źródłem prawdy).

## Świadomie odrzucone (nie wracamy)

- **Sync na obu maszynach** — dwa niezależne procesy nadpisujące co minutę ten sam plik pod Obsidian Sync = fabryka plików konfliktowych.
- **Sync wyłącznie na VPS** — kusi (Skrzynka zawsze aktualna, Obsidian Sync dostarcza ją natychmiast, działa też na telefonie), ale kupuje to ryzykiem cichego gubienia `[x] Zrobione`. Awaria przez nieaktualność jest widoczna i samonaprawialna; awaria przez cofnięcie akcji użytkownika podkopuje zaufanie do narzędzia. Wariant do ewentualnego powrotu **dopiero po** uszczelnieniu `pull` (scalanie zamiast nadpisywania) — poza zakresem.
- **Wykrywanie roli maszyny po platformie** (Linux = VPS) — zgadywanie; myli system operacyjny z rolą. Ktoś na linuksowym desktopie dostałby auto-reply, którego nie chciał.
- **Reimplementacja parsowania kodu zaproszenia w bashu** — drift dwóch źródeł prawdy. Projekt już raz za to zapłacił (stąd powstał wspólny `env-loader.mjs`).
- **Tworzenie joba auto-reply przez instalator bezpośrednio przez API** — zduplikowałoby definicję joba (ścieżka, cron, timeouty, flagi) w bashu. Definicje zostają w `inbox-seed.js` jako jedyne źródło prawdy; instalator przekazuje wyłącznie **decyzję**.

## Założenia

- **VPS członka ma kopię vaulta** (u operatora: Obsidian Sync; instalator VPS ma też ścieżkę vault-git). Nie wpływa na mechanikę instalatora — zmienia wyłącznie jakość odpowiedzi auto-reply, bo agent czerpie wiedzę z plików vaulta. Bez vaulta auto-reply będzie zwracał `NO_ANSWER` z braku wiedzy.
- Repo jest już rozpakowane w momencie, gdy instalator VPS dochodzi do fazy Team OS (po `setup_funnel`) — więc może wołać helper Node z repo.
- Node w wersji ≥22.13 jest dostępny (portable Node z instalacji) — helper korzysta z tego samego runtime'u co reszta.

## Poza zakresem

Rotacja tokenu `kacper`, czyszczenie historii gita repo vaulta, decommission Postgresa w Coolify, coalescing rutynowych jobów (kolejka blokowana przez długie joby), uszczelnienie `pull` (scalanie zamiast nadpisywania).

## Powiązane pliki

| Plik | Rola w zadaniu | Weryfikacja stanu 2026-07-26 |
|---|---|---|
| `setup.mjs` | `INVITE_CODE_PREFIX`:215, `parseInviteCode`:223, `upsertDotenvLine`:257, `writeInboxEnv`:866, `probeInviteCode`:881, `askInboxInvite`:904 — źródło ekstrakcji (IU-1.1) i miejsce guardu lokalnego (IU-2.3) | potwierdzone gremem |
| `setup.test.mjs` | 44 dopasowania na `parseInviteCode`/`upsertDotenvLine`/`askInboxInvite` — siatka bezpieczeństwa ekstrakcji | potwierdzone |
| `scripts/inbox/invite.mjs` | **nowy** — wspólny rdzeń kodu zaproszenia + guard `.gitignore` (IU-1.1) | do utworzenia |
| `scripts/inbox/onboard.mjs` | **nowy** — cienkie CLI, most bash → Node (IU-2.1) | do utworzenia |
| `scripts/inbox/env-loader.mjs` | wzorzec wspólnego modułu wyciągniętego, by zabić drift między skryptami | istnieje |
| `lib/inbox-seed.js` | `inboxSyncJobDef`:12, `assistantJobDef`:28 (`enabled: 0`:39), `createJob` bez `UPDATE`:71-74 — rola maszyny steruje seedem (IU-1.2) | potwierdzone gremem |
| `lib/inbox-seed.test.js` | testy seeda do rozszerzenia o role | istnieje |
| `lib/db.js` | `getState`:369, `setState`:374 — nośnik flagi `inbox_role` | potwierdzone |
| `lib/notify-push.js` | wzorzec kontraktu `{ok, reason}` — nigdy nie wywraca wołającego | istnieje |
| `scripts/install-vps.sh` | `ask_tty`:189, `ask_valid`:228, `is_valid_member_name`:1437, `setup_team_os_hub`:1497, `TEAM_OS_INVITE_CODE`:1558 — ścieżka członka obok istniejącej ścieżki admina (IU-2.2) | potwierdzone gremem |
| `scripts/install-vps.test.sh` | harness lib-only (`CLAUDE_CRON_LIB_ONLY=1`), sandbox `mktemp`, rejestrator wywołań | istnieje |
| `CLAUDE.md` | sprostowanie zapisu o auto-reply + opis roli maszyny (IU-3.1) | do aktualizacji |

## Decyzje techniczne i zależności

Pełne uzasadnienia siedzą w `-plan.md`; tu skrót, żeby ten plik był samowystarczalny po resecie kontekstu:

- **Jedna flaga roli `inbox_role` (`client` | `agent`)** w tabeli `state`, nie dwie flagi boolean. Brak flagi = zachowanie dzisiejsze (`client`), więc istniejące instalacje nie zmieniają stanu.
- **Rdzeń w `scripts/inbox/invite.mjs`, CLI w `scripts/inbox/onboard.mjs`** — bash nie dostaje ani linii logiki domenowej; `setup.mjs` re-eksportuje `parseInviteCode`/`upsertDotenvLine` dla zgodności z testami.
- **Guard `.gitignore` przez `git check-ignore`** (exit-code, nie treść pliku), z ponowną weryfikacją po dopisaniu `.env*`; przy `unfixable` **fail-closed** — pomijamy zapis tokenu, nie przerywamy instalacji.
- **Kolejność na VPS:** zapis `.env` + `setState('inbox_role', …)` **przed** restartem daemona (`inbox-seed` czyta flagę dopiero przy starcie; env nie propaguje się do żyjących procesów).
- **Kolejność wewnątrz onboardingu:** parse → probe → guard → zapis → rola. Probe waliduje kod zanim dotkniemy plików, guard tuż przed zapisem, rola tylko po udanym zapisie.
- **Zależności między IU:** IU-1.1 i IU-1.2 są równoległe; IU-2.1 wymaga obu; IU-2.2 wymaga IU-2.1; IU-2.3 wymaga IU-1.1 + IU-1.2; IU-3.1 na końcu.
- **Zależności zewnętrzne:** zero nowych paczek npm. Jedyny nowy element zewnętrzny to `git check-ignore` (stabilna semantyka exit-code); brak gita traktujemy jak „nie repo" → guard przepuszcza.

## Źródła

- Requirements doc: brak — zakres ustalony w sesji operacyjnej (wdrożenie maszyny „Cave" + incydent wycieku sekretów 2026-07-25/26), ustalenia produktowe zapisane w tym pliku.
- Plan techniczny: brak osobnego pliku w `docs/plans/` — Implementation Units żyją w `team-os-onboarding-instalatory-plan.md` i `team-os-onboarding-instalatory-zadania.md`.
- Poprzednie zadanie (wzorzec i geneza): `docs/completed/team-os-hub-api/`
