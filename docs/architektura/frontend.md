# Frontend

> Przeniesione z `CLAUDE.md` bez zmian treści (higiena kontekstu, 2026-11-02). W `CLAUDE.md` zostało jednolinijkowe odesłanie.

## Frontend (`public/`)

Vanilla JS, zero frameworka i buildu. `app.js` (duży, stanowy) + wydzielone czyste helpery `enum-map.js` i `render-helpers.js` (jedyne z testami — logika kalendarza, sparkline, podpisy poll). Polling co 3 s z guardem: liczy tani podpis payloadu i pomija `innerHTML`, gdy nic się nie zmieniło. Timeouty w UI są w minutach, w bazie/executorze w ms (`msToMin`/`minToMs`).
