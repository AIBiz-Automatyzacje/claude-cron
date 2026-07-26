---
title: "ACAO:* + guard XFF nie chroni endpointu zwracającego sekret — CSRF wykrada token"
date: 2026-07-24
category: auth-issues
severity: high
stack:
  - Node.js
  - node:http
tags:
  - cors
  - csrf
  - token-exposure
  - same-origin
  - tailscale
status: verified
last_verified: 2026-07-24
---

# ACAO:* + guard XFF nie chroni endpointu zwracającego sekret — CSRF wykrada token

## Symptomy

- Nowy endpoint `POST /api/inbox/members` (Team OS hub) zwraca w odpowiedzi 201 pełny `token` i `invite_code` w plaintext.
- Endpoint stoi ZA guardem XFF (`X-Forwarded-For` → 403), więc wygląda na „prywatny, tylko przez Tailscale".
- Mimo to dowolna strona (evil.com) odwiedzona przez admina z działającym lokalnym Pulsem może po cichu utworzyć członka i **odczytać** jego token — trwałe mintowanie dostępu do skrzynki.

## Root Cause

Dwie założone bariery nie chronią przed CSRF z przeglądarki:

1. **Guard XFF nie łapie ataku CSRF**: `fetch` z evil.com do `http://localhost:7777` NIE ustawia nagłówka `X-Forwarded-For` (dokłada go dopiero Tailscale Funnel). Żądanie z obcej domeny przechodzi guard tak samo jak same-origin dashboard.
2. **Globalne `Access-Control-Allow-Origin: *`** (pre-existing dla całego dashboardu) + `Allow-Methods GET/POST/DELETE` + preflight `OPTIONS→204` pozwalają obcej stronie ODCZYTAĆ ciało odpowiedzi 201 — w tym sekret. Dopóki endpointy tylko czytały zamaskowane dane, `ACAO:*` był niegroźny; nowy endpoint zwraca SEKRET, więc `ACAO:*` staje się kanałem eksfiltracji.

Guard sieciowy (XFF/Tailscale) i guard CORS to ortogonalne warstwy — pierwszy filtruje po ścieżce sieciowej, drugi po pochodzeniu żądania w przeglądarce. Endpoint mutujący zwracający sekret potrzebuje OBU.

## Rozwiązanie

Odrzucaj żądania cross-origin na endpointach obsługujących sekrety, PRZED dotknięciem DB. Legalny dashboard jest same-origin (`Origin` pusty lub `== Host`); atak z obcej domeny niesie `Origin` tej domeny.

```javascript
// CSRF guard dla endpointów zwracających/obsługujących SEKRETY (token, invite_code).
// Zwraca true, gdy żądanie jest cross-origin (Origin ≠ Host).
function isCrossOriginRequest(req) {
  const origin = req.headers['origin'];
  if (!origin) return false; // brak Origin = nawigacja same-origin / klient nie-przeglądarkowy
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // nieparsowalny Origin = traktuj jak obcy
  }
  return originHost !== req.headers['host'];
}

// W handleApi, PRZED odczytem/zapisem DB:
if (segments[0] === 'api' && segments[1] === 'inbox' && segments[2] === 'members') {
  if (isCrossOriginRequest(req)) {
    return error(res, 'Cross-origin request rejected', 403);
  }
}
```

Kluczowe decyzje:
- **Brak `Origin` = przepuść** — nawigacje same-origin i klienci nie-przeglądarkowi (curl, skrypty) nie wysyłają `Origin`; to legalny ruch. CSRF z przeglądarki ZAWSZE ma `Origin`.
- **Nieparsowalny `Origin` = traktuj jak obcy** (fail-closed).
- Guard stoi **przed** dotknięciem DB (żaden SELECT/INSERT dla odrzuconego żądania).

## Komendy diagnostyczne

```bash
# Znajdź globalne ACAO:* i sprawdź, czy jakiś mutujący endpoint zwraca sekret w body
grep -rn "Access-Control-Allow-Origin" server.js
grep -rn "token\|invite_code\|secret" server.js | grep -i "res\|write\|JSON.stringify"

# Symulacja CSRF: żądanie z obcym Origin, bez XFF (jak fetch z evil.com)
curl -i -X POST http://localhost:7777/api/inbox/members \
  -H 'Origin: https://evil.com' -H 'Content-Type: application/json' \
  -d '{"name":"x"}'   # oczekiwane: 403 Cross-origin request rejected
```

## Zapobieganie

- Każdy endpoint mutujący, który ZWRACA sekret (token/klucz/kod), wymaga guardu CSRF opartego na `Origin` — nawet jeśli jest „za" innym guardem sieciowym.
- Nie zakładaj, że guard po nagłówku dokładanym przez proxy (XFF, Tailscale Funnel) chroni przed żądaniem z przeglądarki do localhost — atak CSRF omija ścieżkę proxy w całości.
- Trzymaj `ACAO:*` z dala od endpointów zwracających sekrety; jeśli musi być globalny, dołóż warstwę same-origin dla wrażliwych ścieżek.

## Powiązane

- `docs/completed/team-os-hub-api/review-faza-1.md` (finding P2 · KOD, `server.js:611` — numeracja z czasu review; dziś `isCrossOriginRequest` w `server.js`, użycie na `/api/inbox/members`)
- Wzorzec bramek `/ask` i guardu XFF w `server.js` — patrz CLAUDE.md, sekcja „server.js — HTTP i granice bezpieczeństwa".
- `docs/solutions/auth-issues/2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-eksfiltracja-prompt-injection.md` —
  ten sam kształt defektu na innym kanale (guard `.gitignore` broni przed gitem, nie przed agentem czytającym `cwd`).
  Wspólny wniosek: **guardy są ortogonalne, sekret potrzebuje jednego na każdy kanał**.

## Kontekst

Team OS hub-API, Faza 1 (commit fix `38d304c`). Endpoint `/api/inbox/members` powstał jako część centralizacji skrzynki (przejście z Postgresa per-VPS na wspólny hub HTTP). Test regresji: `server.inbox.http.test.js` (obcy `Origin` → 403 przed DB). Blast radius wg planu ograniczony do skrzynki, ale token = trwały dostęp, więc severity high.
