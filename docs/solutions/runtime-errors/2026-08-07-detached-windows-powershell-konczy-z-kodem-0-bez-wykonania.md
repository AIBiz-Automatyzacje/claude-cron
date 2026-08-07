---
title: "spawn z detached na Windowsie: powershell kończy z kodem 0 nie wykonawszy nic → zakleszczona flaga updatera"
date: 2026-08-07
category: runtime-errors
severity: high
stack:
  - Node.js
  - child_process
  - Windows
  - PowerShell
tags:
  - spawn
  - detached
  - windows
  - powershell
  - silent-failure
  - exit-code
  - updater
status: verified
last_verified: 2026-08-07
---

# `detached:true` na Windowsie: dziecko melduje sukces (kod 0), nie wykonawszy ani jednej instrukcji

## Symptomy

- Przycisk „Zaktualizuj Pulsa" na Windowsie nie robi nic: żadnego procesu instalatora,
  żadnego zipa w `%TEMP%`, żadnego wpisu o porażce w logu serwera.
- Log ma TYLKO `[updater] Start aktualizacji (windows) → <sha>` i ciszę.
- Drugi klik (także po odświeżeniu panelu) dostaje 409 „Aktualizacja już trwa" —
  i tak już zostaje do restartu daemona.
- Serwer żyje, `uptime` rośnie — instalator nie doszedł nawet do ubijania procesów.

## Root Cause

`spawn('powershell', [...,'-Command', script], { detached: true, stdio: 'ignore',
windowsHide: true })`. Na Windowsie `detached:true` tłumaczy się na flagę procesu
odbierającą dziecku konsolę — a `powershell.exe`/`cmd.exe` to aplikacje konsolowe,
które **bez konsoli kończą natychmiast z kodem 0, nie wykonawszy skryptu**.

Pomiar na żywej maszynie (skrypt `Start-Sleep -Seconds 2; Set-Content ...`):

| Opcje spawnu | Kod | Czas | Plik-marker |
|---|---|---|---|
| `detached` + `windowsHide` + `ignore` (jak w updaterze) | 0 | **146 ms** | ❌ |
| samo `stdio:'ignore'` | 0 | 2354 ms | ✅ |
| `windowsHide` bez `detached` | 0 | 2270 ms | ✅ |
| `detached` bez `windowsHide` | 0 | 209 ms | ❌ |

Winowajcą jest samo `detached` (`windowsHide` jest niewinne). Kod 0 sprawiał, że
`settle()` w updaterze uznawał spawn za sukces i **celowo zostawiał flagę
`updateInProgress`** (żeby drugi klik nie odpalił drugiego instalatora w trakcie
podmiany plików) — flaga zakleszczona do restartu daemona.

Druga połowa pułapki: **usunięcie `detached` też nie działa.** Zwykłe dziecko ginie
razem z rodzicem (`Stop-Process -Force` na daemonie — a to instalator ubija daemona,
żeby odblokować pliki). Zweryfikowane: rodzic zabity po 0,5 s → dziecko bez `detached`
nie dożyło zapisu pliku po 6 s.

Na Uniksie ta sama linijka jest poprawna: `detached` znaczy tam tylko „nowa grupa
procesów" — konsola nieistotna, skrypt przeżywa `kill` daemona i wykonuje się normalnie.
Dlatego bug nie wychodzi w żadnym teście na macOS/Linux.

## Fix

Pośrednik **`cmd /c start`** zamiast `detached` (commit `8fec258`, PR #6):

```js
// lib/updater.js — buildWindowsUpdateCommand
return {
  command: 'cmd',
  args: [
    '/c', 'start', '', '/min',          // '' = tytuł okna; bez niego start bierze
    'powershell', '-NoProfile', ...,    //   pierwszy cytowany argument za tytuł
  ],
};
```

`start` tworzy proces w **osobnej sesji konsolowej**: przeżywa śmierć rodzica I realnie
wykonuje skrypt (oba warunki naraz — żaden prosty wariant spawnu nie daje obu).
`detached` jest teraz polem PLANU per platforma (`darwin: true`, `win32: false`),
nie stałą opcją spawnu.

Do tego dwie osłony na przyszłą cichą śmierć:

- **transkrypt** instalatora do `%TEMP%\puls-update.log` (`try/catch` — pad transkryptu
  nie może ubić aktualizacji); diagnoza tej awarii trwała godzinę, bo nie było CZEGO czytać;
- **watchdog 10 min**: skoro daemon po limicie wciąż żyje, podmiana kodu NA PEWNO się
  nie dokonała → zwalniamy flagę, panel pozwala spróbować ponownie bez restartu.

## Wnioski

1. **`detached:true` + aplikacja konsolowa na Windowsie = cicha śmierć z kodem 0.**
   Jeśli dziecko ma przeżyć rodzica na Windowsie, użyj pośrednika `cmd /c start`
   (albo zadania jednorazowego schtasks) — nie flagi `detached`.
2. **Kod wyjścia 0 procesu-pośrednika nie dowodzi wykonania pracy.** Sukces rozpoznawaj
   po SKUTKU (plik wersji, żywy nowy proces), a przy braku możliwości weryfikacji dołóż
   watchdog na flagę stanu — inaczej blokada współbieżności zakleszcza się na zawsze.
3. **Proces odpalany bez konsoli i bez człowieka MUSI zostawiać ślad** (transkrypt/log
   do stałej ścieżki) — inaczej jego śmierć jest niewidzialna i nieodróżnialna od
   „jeszcze trwa".
4. Diagnoza tej klasy bugów: seria spawnu z plikiem-markerem i pomiarem czasu
   (`Start-Sleep N` + porównanie `czas_ms` z N) rozstrzyga w minutę, czy skrypt
   w ogóle ruszył — zanim zaczniesz podejrzewać sieć, TLS czy antywirus.

## Powiązane

- `docs/solutions/deployment-issues/2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md`
  — dlaczego instalator musi ubić daemona (zablokowane pliki) i skąd `cwd: os.tmpdir()`
- `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`
  — bliźniacza klasa: zdarzenia procesu potomnego kłamią, zwolnienie zasobu wisi na złym sygnale
