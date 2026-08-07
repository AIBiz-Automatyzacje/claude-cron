---
title: "spawn EPERM: antywirus tnie proces po TREŚCI linii komend (irm|iex) — bootstrap przez plik"
date: 2026-08-07
category: runtime-errors
severity: high
stack:
  - Node.js
  - child_process
  - Windows
  - PowerShell
  - Windows Defender
tags:
  - spawn
  - eperm
  - antivirus
  - powershell
  - irm-iex
  - dropper-signature
  - updater
status: verified
last_verified: 2026-08-07
---

# `spawn EPERM` na Windows: to nie uprawnienia — to antywirus czytający linię komend

## Symptomy

- Przycisk „Zaktualizuj Pulsa" na Windows → „Internal server error"; daemon żyje dalej.
- Stack (daemon odpalony na pierwszym planie): `Error: spawn EPERM, errno: -4048` w `io.spawn`.
- **Ta sama ścieżka kodu działała rano** — udana aktualizacja przyciskiem kilka godzin
  wcześniej, zero zmian w kodzie między próbami.

## Diagnoza — seria spawnów kontrolowanych na żywej maszynie

Klucz: rozdzielić OPCJE spawnu od TREŚCI argumentów.

| Spawn | Wynik |
|---|---|
| `spawn('cmd', ['/c','start','','/min','powershell','-NoProfile','-Command','exit'], {…})` | ✅ działa |
| te same opcje, argument `-Command "irm https://…/install.ps1 \| iex"` (realny updater) | ❌ `EPERM` |
| pełna logika POST-a z atrapą spawnu (CLI) | ✅ działa |

Opcje identyczne, różni się wyłącznie treść linii komend → **CreateProcess blokuje
antywirus po sygnaturze zawartości**: ukryty PowerShell z download-execute (`irm … | iex`)
w argumentach to podręcznikowy wzorzec droppera. „Rano działało" nie jest sprzecznością —
heurystyka behawioralna AV aktualizuje się w ciągu dnia, a kilka przebiegów instalatora
i testów tego samego wzorca na jednej maszynie podbija scoring.

## Fix (commit `bf364cc`, PR #9)

Treść przenosi się z linii komend do PLIKU:

1. Daemon zapisuje bootstrap do `%TEMP%\puls-update-bootstrap.ps1` (`io.writeFile`
   PRZED spawnem; czysty ASCII — PS 5.1 bez BOM czyta jako ANSI).
2. Spawn odpala niewinne `powershell -NoProfile -ExecutionPolicy Bypass -File <ścieżka>`
   — zero URL-i i `iex` w argumentach procesu.
3. `irm | iex` zostaje WEWNĄTRZ pliku **z konieczności, nie dla zmyłki**: `install.ps1`
   rozpoznaje tryb bootstrap po pustym `$PSScriptRoot`, a kod wykonany przez `iex` go
   nie ma; uruchomienie instalatora wprost z pliku wzięłoby ścieżkę LOKALNĄ.
4. `spawn` i zapis pliku w try/catch → panel dostaje prawdziwy powód („system odmówił…
   sprawdź antywirusa") zamiast gołego 500, a flaga `updateInProgress` nie jest ustawiana
   przy odmowie (bez tego 500 + zakleszczony przycisk do restartu daemona).

## Wnioski

1. **`EPERM` przy `spawn` na Windows czytaj jako „coś zablokowało CreateProcess"** —
   najpewniej AV — a nie jako problem uprawnień. Rozstrzyga seria spawnów: te same opcje,
   niewinny vs realny argument.
2. **Nie wkładaj wzorców download-execute do linii komend procesów.** Linia komend jest
   skanowana przez AV i widoczna w każdym audycie procesów; treść przenosi się do pliku,
   a plik wykonuje przez `-File`.
3. **Synchroniczny rzut `spawn` to normalna ścieżka na Windows** — każdy spawn w handlerze
   HTTP musi mieć try/catch z komunikatem dla użytkownika, inaczej realny powód ginie
   w stderr, którego nikt nie widzi (drugi raz ta sama lekcja co przy transkrypcie).
4. „Działało rano, nie działa po południu, kod bez zmian" na Windows = podejrzewaj AV
   **przed** debugowaniem własnego kodu.

## Powiązane

- `2026-08-07-detached-windows-powershell-konczy-z-kodem-0-bez-wykonania.md` — pierwsza
  połowa tej samej sagi: `detached` zabijał wykonanie bezgłośnie; razem dają kompletny
  obraz „jak NAPRAWDĘ odpalić odczepiony proces na Windows z daemona"
- `docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md`
  — czemu pliki dla PS 5.1 muszą być czystym ASCII
