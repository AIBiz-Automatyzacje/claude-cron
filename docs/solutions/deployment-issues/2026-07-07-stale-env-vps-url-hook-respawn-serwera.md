---
title: "Proxy /api/vps/* pada (504/502) mimo poprawnego User-env — hook wskrzesza serwer ze starym CLAUDE_CRON_VPS_URL"
date: 2026-07-07
category: deployment-issues
severity: medium
stack:
  - Node.js
  - Windows
  - PowerShell
  - Tailscale
tags:
  - env-propagation
  - claude-code-hooks
  - vps-proxy
  - reinstall
  - stale-process-env
status: verified
last_verified: 2026-07-07
---

# Proxy /api/vps/* pada mimo poprawnego User-env po re-installie

## Symptomy

- Dashboard lokalny działa, ale widok VPS się nie łączy.
- `GET /api/vps/status` przez lokalny serwer zwraca `504` (VPS timeout) lub `502` (VPS unreachable) — mimo że VPS **żyje**.
- Bezpośredni `Invoke-WebRequest http://<VPS-tailscale-ip>:7777/api/status` → **200 OK** (VPS osiągalny, sieć/Tailscale sprawne).
- `[Environment]::GetEnvironmentVariable('CLAUDE_CRON_VPS_URL','User')` → **poprawny** adres.
- `$env:CLAUDE_CRON_VPS_URL` w otwartym terminalu → **inny, stary** adres (np. IP, którego nie ma nawet na liście `tailscale status`).

## Root Cause

`lib/config.js` czyta `VPS_API_URL = process.env.CLAUDE_CRON_VPS_URL || ''` **raz, przy starcie procesu**. Hook autostartu (`UserPromptSubmit`) wskrzesza `server.js` dziedzicząc **środowisko sesji Claude Code**, a ta dziedziczy z terminala, z którego ją odpalono. Po re-installie setup zapisuje nowy adres do **User-scope** env, ale terminale/sesje otwarte **wcześniej** wciąż trzymają starą wartość w pamięci procesu. Serwer wskrzeszony z takiej sesji proxuje do martwego adresu → nieistniejący IP Tailscale nie odrzuca połączenia (brak RST), pakiety lecą w próżnię → timeout **504** (lub 502, gdy adres daje natychmiastowy błąd połączenia). User-env jest poprawny — winny jest **żywy proces uruchomiony ze starego env**.

## Rozwiązanie

Zrestartuj serwer z **nowo otwartego** terminala (świeży terminal czyta aktualny User-scope env). Diagnostycznie najpewniej odpalić ręcznie na pierwszym planie, żeby widzieć, z jakim adresem startuje:

```powershell
# 1. Zabij serwer trzymający stary env
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*claude-cron*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. OTWÓRZ NOWY terminal, potwierdź adres, odpal serwer ręcznie
cd C:\Users\<user>\claude-cron
"Serwer wystartuje z VPS = $env:CLAUDE_CRON_VPS_URL"   # MUSI być aktualny adres
& ".\.node\node-v22.17.0-win-x64\node.exe" server.js
```

Twarda gwarancja, że żaden proces nie trzyma starego env: **wylogowanie/restart Windows** — po nim każda sesja Claude Code i każdy serwer spawnowany przez hook czytają aktualny User-scope.

## Komendy diagnostyczne

```powershell
# Który kod zwraca proxy? (503 brak env / 502 unreachable / 504 timeout)
try { (Invoke-WebRequest http://localhost:7777/api/vps/status -UseBasicParsing -TimeoutSec 12).Content }
catch { "STATUS: " + $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }

# Porównaj źródło prawdy (User-scope) z env żywego terminala
[Environment]::GetEnvironmentVariable('CLAUDE_CRON_VPS_URL','User')   # zapisany przez setup
$env:CLAUDE_CRON_VPS_URL                                              # env tego terminala (może być stary)

# Czy VPS w ogóle odpowiada (z pominięciem lokalnego proxy)
Invoke-WebRequest http://<VPS-ip>:7777/api/status -UseBasicParsing -TimeoutSec 5

# Czy sam portable node dosięga VPS (izoluje warstwę sieciową procesu node od proxy)
& ".\.node\node-v22.17.0-win-x64\node.exe" -e "require('http').get('http://<VPS-ip>:7777/api/status',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('OK',r.statusCode))}).on('error',e=>console.log('ERR',e.message))"
```

Mapowanie kodów proxy (`server.js` → `proxyToVps`): **503** = serwer nie ma env (`!VPS_API_URL`); **502** = `proxy.on('error')` (unreachable/RST); **504** = `proxy.on('timeout')` po 10 s (adres blackhole/wisi).

## Zapobieganie

- Po zmianie dowolnej zmiennej `CLAUDE_CRON_*` (setup/re-install) traktuj **wszystkie otwarte terminale i sesje Claude Code jako skażone** — restart serwera musi iść z NOWO otwartego terminala, nie z tego, w którym siedziałeś podczas instalacji.
- Diagnozę stanu env procesu prowadź **trzema źródłami naraz**: User-scope (`GetEnvironmentVariable(...,'User')`) vs env terminala (`$env:`) vs faktyczne zachowanie serwera (kod proxy). Sama poprawność User-scope niczego nie dowodzi o żywym procesie.
- Rozróżniaj warstwy po kodzie HTTP proxy: 503 = konfiguracja (env), 502/504 = sieć/adres. Nie myl „lokalnie działa" z „proxy działa" — to dwa różne procesy i dwa różne środowiska.

## Powiązane

- `docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md` — persystencja env per platforma (Windows `SetEnvironmentVariable(...,'User')`); tu jest druga strona medalu: zapis do User-scope nie propaguje się do już żyjących procesów.
- `docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md` — ten sam wzorzec „stale-in-memory vs źródło prawdy", tam obiekt JS vs DB, tu env procesu vs User-scope.

## Kontekst

Ujawnione podczas testowej reinstalacji na Windows (świeży Puls po starym pre-Puls claude-cron). Stary adres `100.114.17.66` pochodził z wcześniejszej instalacji, nowy `100.89.141.94` (`srv1808203`) zapisał się do User-scope, ale serwer wskrzeszony przez hook z sesji sprzed re-installu proxował do martwego IP. `settings.json` hooka był czysty (nowa wersja) — stara wersja NIE była przyczyną, mimo początkowego podejrzenia. Health-warning Tailscale o przechwyconym DERP relay (`derp22c`, cert D-Link C=RU) był myłącym pobocznym tropem — połączenie bezpośrednie do VPS działało, więc nie blokował.
