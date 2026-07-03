---
title: "getUpdates świeżo utworzonego bota Telegram gubi pierwsze wiadomości — auto-detekcja chat ID pada mimo poprawnego tokena"
date: 2026-07-03
category: deployment-issues
severity: medium
stack:
  - Node.js
  - Telegram Bot API
tags:
  - telegram
  - getUpdates
  - bot-api
  - instalator
  - onboarding
  - auto-detekcja
status: verified
last_verified: 2026-07-03
---

# getUpdates świeżo utworzonego bota gubi pierwsze wiadomości (lag kolejki update'ów)

## Symptomy

- Auto-detekcja chat ID w setupie Pulsa: user pisze do bota (wiadomości dostarczone — podwójne fajki w Telegramie), a `getUpdates` zwraca `{"ok":true,"result":[]}`.
- `getWebhookInfo` → `url: ""`, `pending_update_count: 0` — webhook niepodpięty, kolejka „pusta", choć wiadomości fizycznie doszły do bota.
- Token poprawny (`getMe` zwraca właściwego bota), więc objaw wygląda jak zewnętrzny konsument update'ów albo bug parsera — oba tropy fałszywe.

## Root Cause

Bot został utworzony przez `/newbot` w @BotFather ~60 sekund przed wysłaniem wiadomości. Wiadomości wysłane w pierwszych minutach życia bota nie weszły do kolejki update'ów Bot API (lag inicjalizacji po stronie Telegrama) — przepadły bez śladu (`pending: 0`, brak w `result`). Wiadomość wysłana ~15 minut później normalnie weszła do kolejki i **wisiała w `getUpdates` przez wiele polli** (getUpdates bez `offset` nie konsumuje update'ów) — co wykluczyło hipotezę konkurencyjnego konsumenta.

## Rozwiązanie

Projektowe, nie kodowe — auto-detekcja MUSI mieć ręczny fallback i mieć go za ścieżkę pierwszej klasy, nie error case:

```js
// setup.mjs — auto-detekcja z fallbackiem (fragment działającego flow)
const detected = extractChatIdFromUpdates(await fetchTelegramUpdates(botToken));
if (detected) {
  // potwierdzenie u usera: `Wykryto chat ID: ${detected}. Użyć? [Y/n]`
} else {
  console.log('[info] Nie wykryto wiadomości do bota — podaj chat ID ręcznie.');
  // ręczne pole; w prywatnej rozmowie chat ID = Telegram user ID usera
}
```

Diagnoza przy podejrzeniu „ktoś kradnie update'y": wyślij świeżą wiadomość i polluj `getUpdates` kilka razy — update, którego nikt nie konsumuje, **zostaje** w odpowiedzi (konsumpcja wymaga jawnego `offset`). Znika między pollami = realny konkurencyjny konsument; wisi = wiadomości sprzed chwili po prostu nie weszły do kolejki.

## Komendy diagnostyczne

```bash
TOKEN="<bot-token>"
curl -s "https://api.telegram.org/bot$TOKEN/getMe"           # czy token = właściwy bot
curl -s "https://api.telegram.org/bot$TOKEN/getWebhookInfo"  # webhook kradnie update'y? pending?
# test na żywego konsumenta: wyślij wiadomość do bota, potem 3× w odstępach:
curl -s "https://api.telegram.org/bot$TOKEN/getUpdates"      # update wisi = brak konsumenta
```

## Zapobieganie

- Auto-detekcję stanu zewnętrznego API projektuj z ręcznym fallbackiem jako równorzędną ścieżką — instrukcja dla usera zamiast twardego faila.
- W instrukcjach onboardingu (README) każ najpierw napisać do bota, odczekać chwilę, a dopiero potem uruchamiać detekcję; przy padzie — spróbować ponownie za minutę.
- Nie diagnozuj „pustego getUpdates" jako błędnego tokena/konfiguracji — najpierw `getMe` + `getWebhookInfo` + test świeżą wiadomością.

## Powiązane

- `docs/solutions/deployment-issues/2026-07-03-guardy-instalatora-falszywe-sygnaly-statusow-cli.md` — pokrewny wzorzec: stan zewnętrznego narzędzia czytaj ze stanu faktycznego, nie z pojedynczego sygnału.

## Kontekst

Testy operatora feature'a Telegram w Pulsie (2026-07-03, checklista `docs/completed/telegram-powiadomienia-skill-taski/operator-checklist.md`, Test 1.3). Bot `@kacper_t_bot` utworzony o 16:34, wiadomości 16:35 przepadły; wiadomość z 16:48 weszła do kolejki normalnie i posłużyła do żywej weryfikacji `extractChatIdFromUpdates` (zwróciła poprawne ID). Fałszywy trop „zewnętrzny konsument" pochłonął większość czasu diagnozy — daemon pluginu Telegram Claude Code działał na maszynie, ale polluje własnego bota (inny token).
