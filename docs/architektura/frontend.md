# Frontend

> Przeniesione z `CLAUDE.md` bez zmian treści (higiena kontekstu, 2026-11-02); potem poprawione zdanie o plikach z testami. W `CLAUDE.md` zostało jednolinijkowe odesłanie.

## Frontend (`public/`)

Vanilla JS, zero frameworka i buildu. `app.js` (duży, stanowy) + wydzielone czyste helpery `enum-map.js` i `render-helpers.js` (testowane — logika kalendarza, sparkline, podpisy poll). `app.js` ma test statyczny `public/app.attrs.test.js`: skan źródła pod wklejanie wartości stringowych do inline'owych handlerów zdarzeń (`onclick="fn('${x}')"`) — bezpieczny wzorzec to `data-*` + delegacja zdarzenia. Polling co 3 s z guardem: liczy tani podpis payloadu i pomija `innerHTML`, gdy nic się nie zmieniło. Timeouty w UI są w minutach, w bazie/executorze w ms (`msToMin`/`minToMs`).
