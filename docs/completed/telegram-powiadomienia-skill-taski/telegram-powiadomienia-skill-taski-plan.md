# Plan: Telegram, konfiguracja powiadomień raz-lokalnie, skill puls, podstawowe taski

Branch: `feature/telegram-powiadomienia-skill-taski`
Ostatnia aktualizacja: 2026-07-03

## Podsumowanie wykonawcze

Domknięcie Pulsa do wersji finalnej (produkt dla kursantów): powiadomienia Telegram obok Discorda (sukcesy + faile), konfiguracja powiadomień podawana RAZ przy instalacji lokalnej i wypychana na VPS server-side, skill `puls` uczący agenta Claude Code pracy z API, zestaw podstawowych tasków seedowany jednym pytaniem w setupie.

Plan techniczny przeszedł roast (/zroastuj-mnie 2026-07-03) — 5 decyzji wprowadzonych do wymagań (R9, R10, przycisk „Wyczyść", auto-detect chat ID, seed bez powiadomień).

## Cele i zakres

### Wymagania (R1–R10)

- R1. Powiadomienia Telegram: własny bot + chat ID; per-job flaga `telegram_notify`; wysyłka po sukcesie oraz po ostatecznym failu (R9); chunking do 4096 znaków.
- R2. Konfiguracja powiadomień podawana RAZ w setupie lokalnym; VPS dostaje ją przez push po Tailscale; instalator VPS przestaje pytać o Discord.
- R3. Env vary (`DISCORD_WEBHOOK_URL`, `TELEGRAM_*`) jako fallback — istniejące instalacje działają bez zmian.
- R4. Konfigurację można zmienić z dashboardu (zapis lokalny + push na VPS + przycisk „Wyczyść" per kanał).
- R5. Skill `puls` w repo, instalowany globalnie do `~/.claude/skills` przez setup; samowystarczalna specyfikacja API.
- R6. Podstawowe taski seedowane jednym pytaniem `[T/n]`; `enabled=1`; flagi powiadomień wyłączone; pomijanie przy braku skilla; idempotencja po `name`.
- R7. Bez seedu tasków na VPS; task „Aktualizacja .env" poza zestawem.
- R8. Wszystkie testy zielone: `npm test`, `node --test setup.test.mjs`, `bash scripts/install-vps.test.sh`, `bash install.test.sh`.
- R9. Powiadomienia o failach: ta sama flaga per job, `fail`/`timeout` po wyczerpaniu retry, „❌ <job> padł" + skrót `error_msg`; `killed` bez powiadomienia; oba kanały symetrycznie.
- R10. Push konfiguracji na VPS server-side: `POST /api/settings/notifications/push-to-vps` — serwer czyta pełne wartości z własnego state; dashboard nie operuje pełnymi sekretami.

### Poza zakresem

- Seed tasków na VPS; task „Aktualizacja .env".
- Szyfrowanie sekretów w DB (poziom zaufania jak shell RC; API za guardem 403 XFF).
- Zmiany identyfikatorów technicznych `claude-cron`.
- Powiadomienia przy `killed` i per próba retry.

## Fazy wdrożenia

### Faza 1 — fundament powiadomień (M)

1. **Unit 1: `lib/notify-format.js`** — wydzielenie `extractResult`/`smartSplit` z `lib/discord.js` (2 konsumentów po dodaniu Telegrama). Nakład: S. Zależności: brak.
2. **Unit 2: konfiguracja w `state` + endpointy** — `lib/notify-config.js` (resolve state>env + maskowanie), `lib/notify-push.js` (współdzielony push na VPS z potwierdzeniem GET), route'y `GET/PUT /api/settings/notifications` + `POST /api/settings/notifications/push-to-vps`. Nakład: M. Zależności: Unit 1.

### Faza 2 — Telegram (M)

3. **Unit 3: kanał Telegram end-to-end** — `lib/telegram.js` (sendMessage, plain text, limit 4096), kolumna `telegram_notify` w DB (migracja `PRAGMA table_info`), wywołania w executorze (sukces + ostateczny fail dla OBU kanałów, R9). Nakład: M. Zależności: Unit 1, 2.
4. **Unit 4: checkbox Telegram per job w dashboardzie** — lustrzane odbicie `form-discord` (3 punkty dotknięcia w app.js). Nakład: S. Zależności: Unit 3.

### Faza 3 — konfiguracja raz-lokalnie (M)

5. **Unit 5: modal ustawień powiadomień** — GET (maski), PUT (zapis), „Wyślij na VPS" przez push-to-vps (server-side, R10), „Wyczyść" per kanał. Nakład: M. Zależności: Unit 2.
6. **Unit 6: setup lokalny** — pytania o Discord/Telegram do state, auto-detekcja chat ID przez `getUpdates` (fallback ręczny), test-send z weryfikacją `ok:true`, push na VPS przez `lib/notify-push.js` (warn przy padzie). Nakład: M. Zależności: Unit 2, 3.
7. **Unit 7: instalator VPS przestaje pytać o Discord** — czysta subtrakcja + aktualizacja testów (test 21 usunięty — usuwana funkcjonalność). Nakład: S. Zależności: Unit 6.

### Faza 4 — onboarding: taski i skill (M)

8. **Unit 8: starter-taski** — `templates/starter-jobs.json` (wartości 1:1 z produkcyjnej instancji usera, notify=0), `lib/starter-jobs.js` (czysta `computeStarterJobsToSeed`), seed w setupie (NIE w migrate — learned pattern). Nakład: M. Zależności: Unit 3.
9. **Unit 9: skill `puls`** — `skills/puls/SKILL.md` (samowystarczalna spec API z push-to-vps), kopiowanie do `~/.claude/skills/puls` w setupie (kopia, nie symlink — Windows). Nakład: M. Zależności: Unit 2, 8.

### Faza 5 — dokumentacja (S)

10. **Unit 10: README, CLAUDE.md, szablon e2e-env** — sekcja Telegram (BotFather), priorytet state>env, nota o re-runie VPS usuwającym env Discorda, starter-taski, skill puls. Nakład: S. Zależności: Unity 1–9.

## Kryteria akceptacji (całość)

- Wszystkie komendy testowe z R8 zielone.
- Powiadomienie Telegram dochodzi po udanym runie i po ostatecznym failu joba z flagą (operator, żywy bot).
- Setup lokalny: konfiguracja podana raz trafia do state, test-send dochodzi, push widoczny na VPS (`GET /api/vps/settings/notifications` → `configured:true`).
- `grep -c DISCORD scripts/install-vps.sh` → 0 (lub wyłącznie komentarz historyczny).
- Seed: 4 joby po odpowiedzi „T", 0 duplikatów przy re-runie, pominięcia z powodem przy braku skilla.
- Skill `puls` widoczny w skanerze (`lib/skills.js`) i działa w żywej sesji Claude Code (utworzenie + diagnoza joba).

## Ryzyka i mitygacje

- **Sekrety w DB plaintext** — świadoma decyzja; maskowanie w GET, guard XFF, ostrzeżenie w README.
- **Stary VPS bez endpointu settings** — push zwróci 404 → warn z instrukcją (auto-update cron 02:00); nigdy fail setupu.
- **State nadpisuje env** — GET pokazuje aktywne źródło; README wyjaśnia priorytet.
- **Re-run instalatora VPS usuwa env Discorda** — powiadomienia wymagają wcześniejszego pusha; komunikat w podsumowaniu instalatora + README.
- **Brak skilli kursanta przy seedzie** — pominięcie z czytelnym powodem, nie fail.
- **Wysyłka powiadomień nigdy nie wpływa na status runu** — kontrakt fire-and-forget `.catch(() => {})`.

## Mierniki sukcesu

- Kursant konfiguruje powiadomienia dokładnie raz (lokalnie) — zero pytań o Discord na VPS.
- Zero regresji: istniejące instalacje z env działają bez zmian (R3).
- Agent Claude Code tworzy poprawny job przez rozmowę bez ręcznego promptowania (skill puls).

## Szacunek

5 faz, 10 Units — łącznie ~M/L. Fazy 1–2 to rdzeń (fundament + kanał), 3–4 równoległe po fundamencie, 5 na koniec.

## Źródła

- Requirements doc: brak (decyzje z sesji 2026-07-03 przez AskUserQuestion + roast /zroastuj-mnie)
- Plan techniczny: `docs/plans/2026-07-03-001-feat-telegram-powiadomienia-skill-taski-plan.md`
