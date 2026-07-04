# Połączony instalator VPS (Obsidian + Puls) — flow instalacji

> Status: **pre-plan / spec przebiegu — po sesji roast 2026-07-02**. Podstawa pod plan techniczny (Implementation Units).
> Data: 2026-07-01, zaktualizowano 2026-07-02 (audyt `/zroastuj-mnie` — decyzje wpisane niżej). Kontekst: SEKCJA 10 `docs/plans/archive/MIGRACJA-PULS.md` (kurs „Osobisty Asystent AI", B1 — Asystent w chmurze).
> Cel: `scripts/install-vps.sh` wchłania kroki Obsidian z `obsidian-vps-installer` → **jedna komenda** stawia całość. Po merge `obsidian-vps-installer` do wycofania.

## Decyzja produktowa (ustalona)

- **UX = monolit**: default = wszystko (Obsidian Sync + Puls), jednym zamachem, **bez pytania „co chcesz zainstalować"**. W kontekście kursu nie ma scenariusza „VPS bez Pulsa". Lekcja B1 instaluje CAŁOŚĆ; późniejsze lekcje (praca z telefonu, Puls, webhooki) tylko UŻYWAJĄ tego, co już stoi.
- **Struktura kodu = komponenty**: funkcje per komponent + GUARD-y idempotencji. Nie po to, by pytać, tylko dla: (1) idempotentnego re-runu po częściowym padzie, (2) wykrycia istniejącego Obsidiana i dołożenia tylko Pulsa, (3) furtki flagą (`--only-puls` / `--no-obsidian`) dla forków/skryptów — bez flagi = wszystko.
- **Dwie osobne usługi systemd** (`obsidian-sync` + `claude-cron`) — merge dotyczy instalatora, nie runtime.
- **Instalacja Claude Code ujednolicona na NATYWNĄ** (`curl claude.ai/install.sh | bash` → `~/.local/bin/claude`), spójnie z PATH w systemd Pulsa. Login Claude **raz** (dziś dublowany między dwoma instalatorami).
- **GitHub PAT WYCIĘTY → `gh auth login` (device flow)** — PAT to 8-krokowa wyprawa po github.com, najostrzejszy punkt tarcia dla nietechnicznego kursanta. Device flow = „wklej kod na 1 stronie, kliknij Authorize" — ten sam gest co login Claude. Po loginie `gh auth setup-git` ustawia credential helper dla usera `claude` → sparse checkout prywatnego repo ORAZ nocny cron `git pull` działają z czystym URL-em `https://github.com/user/repo.git` (zero tokenu w remote). Koszt: `apt install gh` + czwarta pauza w bloku loginów.

## Dostarczenie (ustalone)

- **One-liner `curl -fsSL <URL> | sudo bash`** — user wkleja JEDNĄ komendę. Rekomendowany obraz VPS: **Ubuntu** (curl preinstalowany w cloud image; w README wariant `wget -qO-` jako zapas dla Debiana minimal).
- ⚠️ **KAŻDE pytanie (`read`) i KAŻDY handoff do interaktywnego procesu (`claude`/`gh`/`ob`/`tailscale`) MUSI czytać z `/dev/tty`** — nie tylko loginy, CAŁA Faza 1 też. W `curl|bash` stdin to pipe z treścią skryptu → goły `read` dostaje EOF i pytania przelatują puste. Landmine udokumentowany: `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md`. Fallback, gdy `/dev/tty` niedostępne.
- **Test WYŁĄCZNIE przez prawdziwy pipe** (`curl … | sudo bash` z env-override źródła) — lokalne `bash install-vps.sh` ukrywa buga.

## Prerequisites (przed komendą — checklist w wideo + potwierdzenie w preflight)

Kursant przychodzi z (sekcja przygotowawcza kursu):
- ☐ świeży VPS (Ubuntu) + dostęp root SSH
- ☐ konto Obsidian + vault lokalny + **remote vault** (Obsidian Sync)
- ☐ **hasło szyfrowania (end-to-end) remote vaulta** — osobny sekret od hasła konta; bez niego pauza `ob sync-setup` = ściana bez obejścia
- ☐ prywatne repo GitHub z katalogiem `.claude` (backup; Obsidian Sync nie synchronizuje dotfolderów → `.claude` idzie przez git + symlink)
- ☐ konto GitHub (do device-flow logowania `gh`)
- ☐ konto Tailscale (samo konto; Tailscale na laptopie dochodzi dopiero w lekcji o Pulsie)

Instalator zaczyna od wyświetlenia tej listy → „Masz wszystko? [Enter = kontynuuj]".

## Zasada przebiegu

**Jeden blok pytań na początku (4 pytania) → jeden blok logowań (5 pauz pod rząd) → reszta leci sama → nagroda na telefonie.** Rozdzielamy „config typowany" (upfront) od „haseł" (muszą paść przy swoim narzędziu, po jego instalacji). Jedyny świadomy wyjątek: opcjonalne pytanie o Funnel na SAMYM końcu (patrz Faza 6) — bo jego koszt (dodatkowa pauza w przeglądarce) ma paść PO tym, jak wszystko działa.

Legenda: 🔍 CHECK (automat) · ❓ PYTANIE (prompt z defaultem) · ⏸ PAUZA (login/hasło) · ⚙ AKCJA (bez usera) · ↩ GUARD (idempotencja)

---

## FAZA 0 — Preflight + detekcja

```
🔍 root? (EUID=0)          🔍 OS = Debian/Ubuntu?      🔍 internet? (api.github.com)
❓ Checklist prerequisites → [Enter = mam wszystko]
🔍 DETEKCJA STANU (baza idempotencji):
     • user 'claude'?          • Node w zakresie 22.13–<25?
     • Claude zalogowany?      • gh zalogowany? (gh auth status)
     • ob zalogowany?          • vault sync skonfigurowany? (dwa OSOBNE checki!)
     • service obsidian-sync?  • repo puls + service claude-cron?
     • tailscale połączony? (tailscale ip)
```
Wynik ustawia GUARD-y niżej. Czysty VPS → pełny przebieg. VPS z samym Obsidianem → pomija kroki Obsidian, wchodzi od Pulsa. **Guard Obsidiana rozbity na dwa checki** (login osobno, sync-setup osobno) — zgrubny pojedynczy check mógłby pominąć niedokończony sync-setup i zostawić usera w half-configured stanie.

## FAZA 1 — Cały config naraz (4 pytania)

```
❓ Email do konta Obsidian                (niepuste; → ob login --email w Fazie 3)
❓ Nazwa vault'a w Obsidian Sync          (niepuste)
❓ Repo z .claude (user/repo lub URL)     (normalizacja + walid FORMATU; walidacja
                                           DOSTĘPU dopiero po gh login — Faza 3)
❓ Powiadomienia o jobach — Discord webhook (puste = pomiń)
  → PODSUMOWANIE → ❓ Kontynuujemy? [T/n]
```

**Wycięte z pytań (auto/default/flaga):**
- Device name → auto `vps-$(hostname)` (unikalność to jedyne, czego Sync potrzebuje); override flagą `--device-name`
- Port → zawsze 7777; flaga `--port`
- Timezone → autodetekcja (`timedatectl`), fallback `Europe/Warsaw`; flaga `--tz`
- Auto-update → zawsze ON (cron 02:00); opt-out flagą `--no-auto-update`
- Funnel → przeniesiony na koniec (Faza 6)
- Workspace → przy „oba" zawsze `~/vault`; pytanie wraca tylko w `--only-puls`

## FAZA 2 — Fundament: narzędzia (automat)

```
⚙ apt: git curl ca-certificates cron gh
↩ GUARD Node w zakresie? → pomiń   ⚙ Node.js 22 (nodesource setup_22.x)
↩ GUARD user 'claude'? → pomiń     ⚙ useradd -m claude
↩ GUARD claude w PATH? → pomiń     ⚙ Claude Code NATYWNIE (~/.local/bin/claude)
⚙ ob — npm i -g obsidian-headless
↩ GUARD tailscale? → pomiń         ⚙ install Tailscale, czekaj na daemon
```
WSZYSTKIE narzędzia (Claude + gh + ob + tailscale) instalowane **zanim ktokolwiek się loguje** → wszystkie loginy w jednym bloku (Faza 3), Faza 5 w pełni automatyczna.

## FAZA 3 — BLOK LOGOWANIA (jedyna strefa interaktywna: 5 pauz pod rząd)

```
↩ GUARD Claude zalogowany? → pomiń
⏸ PAUZA 1 — login Claude (OAuth): su - claude -c "claude" (inline /dev/tty; /exit)  → 🔍 weryfikacja
↩ GUARD gh zalogowany? → pomiń
⏸ PAUZA 2 — gh auth login (device flow: kod wklejany na laptopie)  → 🔍 gh auth status
     ⚙ gh auth setup-git (credential helper dla checkoutu i nocnego crona)
     🔍 WALIDACJA repo: gh repo view <REPO> → 404 = zapytaj o repo PONOWNIE (retry-in-place)
↩ GUARD ob zalogowany? → pomiń
⏸ PAUZA 3 — ob login --email "<EMAIL>" (samo hasło + ew. 2FA; inline /dev/tty)
↩ GUARD vault sync skonfigurowany? → pomiń
⏸ PAUZA 4 — ob sync-setup (hasło e2e):
     su - claude -c 'ob sync-setup --vault "<VAULT>" --path ~/vault --device-name "<DEVICE>"'  → 🔍 sync-status
↩ GUARD tailscale połączony? → pomiń
⏸ PAUZA 5 — tailscale up (link autoryzacyjny — klik na laptopie)  → 🔍 tailscale ip
```

**Semantyka błędów loginów (ustalona):**
- Każdy login: wykonaj → zweryfikuj OD RAZU → fail = „Spróbuj ponownie? [T/n]", **max 3 próby retry-in-place**.
- **Loginy NIGDY nie triggerują rollbacku.** Po 3 failach / świadomym „n" → **czyste zatrzymanie (leave-partial)** z komunikatem: „⏸ Instalacja wstrzymana na kroku X. Ogarnij hasło i wklej TĘ SAMĄ komendę ponownie — instalator pominie wszystko, co już zrobione, i dokończy od tego kroku." Rollback wyrzucałby do kosza udane loginy (żyją w /home/claude) i kasował 10 min pracy przez literówkę w 2FA.
- Ten sam mechanizm ratuje pad sesji SSH w środku instalacji: re-run tej samej komendy = resume przez GUARD-y.

Ulepszenie vs oba dzisiejsze instalatory: WSZYSTKIE loginy (Claude + gh + Obsidian ×2 + Tailscale) **w jednym ciągu, w tym samym oknie**, każdy weryfikowany natychmiast, i **raz**.

## FAZA 4 — Reszta bez udziału usera

```
⚙ ob sync-config --path ~/vault --file-types image,audio,video,pdf,unsupported
     ('unsupported' = „All other file types" z GUI — bez tego raporty HTML/JSON
      ze skilli zostają na VPS; przewodnik headless-vps-guide sekcja 3)
  🔍 weryfikacja: ob sync-status → linia "File types:" zawiera 'unsupported'
  ⚠️ KOLEJNOŚĆ TWARDA: sync-config PRZED startem service (config czytany przy starcie)
⚙ sparse checkout .claude z <REPO> → ~/vault-git (auth: credential helper gh, czysty URL)
⚙ symlink ~/vault/.claude → ~/vault-git/.claude
⚙ systemd: obsidian-sync (ob sync --continuous, Restart=always, lock cleanup)
↩ GUARD repo puls? → git pull, inaczej clone
⚙ clone claude-cron → ~/claude-cron, npm install --production, mkdir data/
⚙ systemd: claude-cron (WORKSPACE=~/vault, PORT=7777, TZ, [DISCORD])
```

## FAZA 5 — Sieć (w pełni automatyczna — zero interakcji)

```
⚙ UFW: allow 22, deny 7777 (dashboard tylko przez Tailscale)
⚙ odczyt TS_IP (tailscale ip -4 — login już zrobiony w Fazie 3)
```

## FAZA 6 — Auto-update + weryfikacja + dowód + podsumowanie

```
⚙ auto-update (zawsze): sudoers NOPASSWD restart + cron 02:00
     (pull vault-git [auth z gh credential helper] + pull puls + node-guard → restart;
      pad pulla logowany — odwołanie autoryzacji gh na GitHubie = cichy fail crona, log wystarczy)
🔍 weryfikacja: obsidian-sync active? claude-cron active? (do 90s na pierwszy sync)
⚙ PLIK-DOWÓD: echo "# 🎉 Twój asystent w chmurze działa! ..." > ~/vault/Witaj-z-VPS.md
  → komunikat: „Otwórz Obsidiana na telefonie — za chwilę pojawi się notatka
     «Witaj z VPS». Jeśli ją widzisz — wszystko działa."
     (test PRAWDZIWEGO end-to-end: zapis na VPS → ob sync → serwer → telefon;
      nagroda na urządzeniu kursanta, nie w terminalu — dashboard w B1 nieosiągalny)
❓ (opcjonalnie, NA KOŃCU) Tailscale Funnel dla webhooków? [t/N]
     T → tailscale funnel 7777 (+ jednorazowe zatwierdzenie node-attribute linkiem
          w admin console) → WEBHOOK_BASE_URL do systemd + restart
     N → nic; wraca w lekcji o webhookach jedną komendą / re-runem
  → PODSUMOWANIE: „Dashboard otworzysz po zainstalowaniu Tailscale na komputerze —
     pokażemy w lekcji o Pulsie" (neutralnie, bez straszenia), webhooki, komendy, security
```

---

## Właściwości przekrojowe

- **Rollback-on-error (`trap ERR`) TYLKO dla kroków automatycznych** (apt, useradd, clone, systemd) — tam pad = zepsuty stan, cofnięcie ma sens. **Blok loginów jest POZA zasięgiem trapu** (retry-in-place + leave-partial, patrz Faza 3).
- **Idempotencja** — GUARD-y: re-run dokłada tylko brakujące. To jest mechanizm RESUME po leave-partial — user nie musi wiedzieć, gdzie kontynuować; wkleja tę samą komendę.
- **Tryb `--reset`** — osobna ścieżka: usuwa services, usera, vault, vault-git. Daje brakujący VPS-uninstall. **Z potwierdzeniem przed kasowaniem** (reguła projektu: żaden `rm -rf` bez confirm; guard `${var:?}`).
- **Flagi** — `--only-puls` / `--no-obsidian` (bez flagi = wszystko), `--port`, `--tz`, `--device-name`, `--no-auto-update`, `--reset`, `--help`.
- **Sekcja powiadomień jako osobna funkcja** w kodzie instalatora — pod przyszłą wstawkę Telegrama (osobne zadanie) bez przebudowy.

## Bilans dla kursanta

**4 pytania tekstowe na starcie (jeden blok) + 5 logowań pod rząd (jeden blok) + reszta sama + nagroda na telefonie** („Witaj z VPS" w Obsidianie). Zero decyzji „co instalować", zero pytań o rzeczy, których kursant nie rozumie (port, timezone, device name, cron). Było (dwa instalatory): ~10+ pytań, loginy w dwóch strefach przedzielonych czekaniem, dublowany login Claude, ręczny PAT, suchy „service active" na końcu.

---

## Decyzje ustalone

- **Kolejność loginów**: Claude → gh (+walidacja repo) → ob login → ob sync-setup → tailscale up, w JEDNYM bloku (Faza 3). Wszystkie „linkowe" (Claude/gh/tailscale) to ten sam gest — user robi je seryjnie bez zaskoczenia. Loginy weryfikowane pojedynczo natychmiast po wykonaniu.
- **PAT → gh device flow** (2026-07-02): repo `.claude` MUSI być prywatne (może nieść sekrety), więc publiczne repo odpada; gh device flow eliminuje 8-krokową wyprawę po token. `gh auth setup-git` daje auth checkoutowi i cronowi.
- **Loginy: 3 próby retry-in-place, leave-partial zamiast rollbacku** (2026-07-02): rollback kasowałby udane loginy i całą instalację przez literówkę w haśle; idempotentny resume (ta sama komenda) jest tańszy w implementacji i lepszy dla usera. Rollback zostaje wyłącznie dla automatów.
- **Tailscale install → Faza 2, `tailscale up` → Faza 3** (2026-07-02): eliminacja „niespodziewanego 5. loginu" po strefie automatów — zasada przebiegu („jeden blok logowania") staje się prawdziwa.
- **Redukcja pytań 10 → 4** (2026-07-02): pytania tylko o to, czego nie da się wyznaczyć (email, vault, repo, Discord). Reszta auto/default/flagi. Filozofia jak przy workspace: „opcja dla świadomych" zamiast „pytanie dla każdego".
- **Funnel = opcjonalne pytanie NA KOŃCU** (2026-07-02): token webhooka to `randomUUID()` (122 bity — zweryfikowane w `server.js:264`), brute-force nierealny, więc rate-limit nie blokuje; ale pierwsze `tailscale funnel` wymaga jednorazowego zatwierdzenia w admin console (dodatkowa pauza) i w B1 webhooki są bezużyteczne (brak jobów webhookowych przed właściwą lekcją). Pytanie na końcu: kto nie wie — klika N i kończy; kto wróci z lekcji webhooków — włączy.
- **`--file-types image,audio,video,pdf,unsupported`** (2026-07-02): domknięte z przewodnikiem (`Zasoby/Archiwum/Tech/obsidian-headless-vps-guide.md` sekcja 3, zweryfikowany 27.06). Weryfikacja przez `ob sync-status`, sync-config PRZED startem service.
- **`ob login --email` istnieje** (2026-07-02, zweryfikowane w README pakietu `obsidian-headless@0.0.12`): email zbierany w Fazie 1, pauza 3 = samo hasło + 2FA.
- **Plik-dowód „Witaj-z-VPS.md"** (2026-07-02): finał instalatora = prawdziwy test end-to-end sync + moment „wow" na telefonie kursanta. Prosty `echo` (nie job Claude — test Pulsa wydarzy się naturalnie w lekcji o Pulsie).
- **Telegram = osobne zadanie** (2026-07-02): wymaga backendu (`lib/telegram.js` + abstrakcja powiadomień), nie jest krokiem instalatora. Ten plan nie rośnie.

## Otwarte (do domknięcia przed/w trakcie planu)

- **Hardening bezpieczeństwa** (osobny wątek od merge instalatora) — patrz sekcja niżej. Po decyzji „Funnel opt-in na końcu" bez zmian priorytetów.

---

## Ocena zabezpieczenia Pulsa przez Tailscale (margines, 2026-07-01)

Fakty z kodu: `server.js:399-405` — request z nagłówkiem `X-Forwarded-For` (czyli przez Funnel) dostaje 403 na wszystkim poza `/webhook/*`; UFW `deny <PORT>`; dashboard **bez auth aplikacyjnej** (`handleWebhook` sprawdzany PRZED blokiem XFF); webhook gated tokenem z DB (`getJobByWebhookToken`), **token generowany przez `randomUUID()` — 122 bity entropii** (`server.js:264`); `CORS Access-Control-Allow-Origin: *`.

**Werdykt: dla modelu zagrożeń (osobiste/kursowe narzędzie, jeden operator) Tailscale to dobra, pragmatyczna decyzja** — WireGuard (nowoczesna, audytowana krypto), zero publicznej powierzchni ataku dla dashboardu. Lepsze niż hasło na dashboardzie wystawionym publicznie. Design (UFW deny + XFF 403 + Funnel tylko dla `/webhook`) jest spójny i przemyślany.

**Gapy do świadomości (ranking):**
1. **Dashboard = 0 auth aplikacyjnej → pełne RCE dla każdego w tailnecie.** Dashboard tworzy/odpala joby = wykonanie kodu jako user `claude` (executor `claude`, oraz `job_type:script` = `node <command>`). Blast radius dostępu do tailnetu = RCE. OK dla solo tailnetu; ryzyko rośnie gdy tailnet współdzielony / urządzenie skompromitowane. Mitygacja: Tailscale ACL na port 7777 do konkretnych urządzeń, ewentualnie lekki token na dashboard (defense-in-depth).
2. **CORS `*` + brak auth + osiągalność w tailnecie** — złośliwa/skompromitowana strona otwarta w przeglądarce na urządzeniu z tailnetu może `fetch()` do `http://<tailnet-ip>:7777/api/...` (CSRF-style, bez cookie/CSRF-tokenu) → utworzyć i odpalić job → RCE. Mitygacja: zawęzić CORS, dodać token/CSRF, sprawdzać `Host`/`Origin`.
3. **Webhook publiczny bez rate-limitingu** — reguła projektu wymaga „rate limiting na KAŻDYM public endpoint", `handleWebhook` go nie ma. Token w ścieżce URL (logowany w proxy/access logach), brak throttlingu. Ryzyko brute-force zredukowane przez entropię tokenu (`randomUUID()` = 122 bity — zgadywanie nierealne); decyzja: rate-limit NIE blokuje merge'a instalatora, zostaje w backlogu hardeningu. Trafiony/wyciekły token = RCE (webhook odpala job) — traktować webhook-triggered joby jako najwyższe ryzyko.
4. **Cała ochrona wisi na UFW+XFF razem** — jeśli którekolwiek się rozjedzie (np. Funnel bez XFF, źle skonfigurowany UFW), dashboard wycieka. Brak defense-in-depth (jedna warstwa: sieć). Mitygacja: automatyczny check spójności UFW+Funnel.
5. **Zależność od Tailscale (firma)** — coordination server / SSO w łańcuchu zaufania; kompromitacja konta Tailscale = dostęp do tailnetu. Dla kursu akceptowalny trade; data-plane WireGuard i tak E2E.

**Rekomendacja:** zostawić Tailscale jako podstawę (słuszne), ale potraktować powyższe jako osobny backlog hardeningu — priorytet: #2 (CORS/CSRF) i #4 (check spójności), potem #3 (rate limit — zdeprioryteryzowany po weryfikacji entropii tokenu).
