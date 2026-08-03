<!--
  READ-ONLY — kontekst firmowy AIBIZ, wspólny dla całego zespołu.
  Źródło prawdy: repo aibiz-plugin → context/company-context.md (edytuje tylko admin: Kacper/Marcin).
  Dystrybucja: hook SessionStart kopiuje ten plik do <vault>/.claude/rules/aibiz-company-context.md
  TYLKO w vaultach Personal OS (te, które mają .claude/rules/) — projekty kodowe są pomijane.
  Claude Code ładuje go natywnie jak każdy plik w project-level rules/.
  NIE edytuj kopii lokalnie — przy najbliższym starcie sesji zostanie nadpisana ze źródła.
  Przy zmianie treści PODBIJ pole version poniżej (data) — hook zaloguje aktualizację.
  Limit: trzymaj < 150 linii (ładuje się przy każdej sesji każdej osoby).
-->
<!-- version: 2026-06-12 -->

# Kontekst firmowy AIBIZ

## Firma
- **AIBIZ Sp. z o.o.** (AIBIZ Spółka z ograniczoną odpowiedzialnością)
- Współzałożyciele: Kacper Trzepieciński, Marcin Gacek
- KRS 0001135235 · NIP 7292758893 · REGON 540024867
- Siedziba: Tuszyńska 29, 93-011 Łódź, Polska · rejestracja: 29.10.2024
- **Kontakt:** automatyzacja@aibiz.pl (Kacper) · kontakt@akademiaautomatyzacji.com (Akademia) · kontakt@kurscc.pl (kurs CC)

## Misja
Najpraktyczniejsza społeczność automatyzacji biznesowej w Polsce. Uczymy przedsiębiorców,
freelancerów i SMB budować realne automatyzacje — n8n, Make, Claude Code — narzędziami,
które sami testujemy i wdrażamy. Konkret i wdrożenie zamiast teorii i hype'u.

## Wartości (jak pracujemy)
- AI = **wzmacniacz umiejętności, nie zastępnik myślenia** ("don't outsource the thinking")
- **Open-source > vendor lock**, pragmatyzm > hype
- Dane i liczby > wrażenia; działanie > planowanie
- Praktyka > teoria — uczymy tego, co sami realnie wdrażamy

## Produkty
- **Akademia Automatyzacji** (flagowy, high ticket) — pełna platforma kursów + społeczność.
  **1100 płacących** członków na Skool, dożywotni dostęp.
- **kurscc.pl** (low ticket) — kurs Claude Code + budowa osobistego asystenta AI, wyciągnięty
  z Akademii. Wejście w lejek → upsell do Akademii.
- **kurs247.pl** (low ticket, 🆕 wkrótce start) — kurs n8n + Make, ten sam model co kurscc.pl
  (wyciągnięty z Akademii → upsell do Akademii).

## Priorytety (teraz)
- Uruchomienie **kurs247.pl** (n8n + Make, low ticket)
- Wdrożenie **Mateusza** w nową linię biznesową (rynek polski)
- **Opisanie stanowisk** — jasny zakres ról w rosnącym zespole
- Comiesięczny **live** + okołoeventowa sprzedaż (live lipiec 2026 — Personal/Team OS)
> Brak sztywnych celów kwartalnych — rytm firmy wyznacza miesięczny cykl live'ów.

## Projekty firmowe (aktywne)
- Akademia Automatyzacji — rozwój kursów + społeczność (1100 płacących)
- Kurs Claude Code od podstaw + live'y YT
- Linie kursowe: n8n, Make, Grafiki produktowe AI, Wideo AI, Aplikacje mobilne
- **Personal / Team OS** — wewnętrzny system pracy zespołu (Claude Code + Obsidian),
  w trakcie budowy: delegacja zadań, wspólny kontekst, automatyzacje agentowe

## Kto jest kim (zespół)
- **Kacper** — materiały, scenariusze, nagrania, live'y, mentoring, research narzędzi,
  frontman (posty osobiste LI/X), dev
- **Marcin** — marketing, strategia, reklamy, landing pages, CRM, mailing, kreacje
  graficzne, backend operacyjny
- **Filip Świniarski** — audyt obecnych materiałów Akademii (szukanie dziur i miejsc do
  poprawy), nagrywanie nowych lekcji oraz ponowne nagrywanie poprawionych scenariuszy
- **Mateusz Kotyło** — dochodzi w połowie czerwca 2026; wdrażany w nową linię biznesową
  (rynek polski / produkty low ticket)
> Stanowiska i zakresy ról są w trakcie formalnego opisywania (bieżący priorytet).

## Odbiorca / klient
- Przedsiębiorcy, freelancerzy, SMB — edukacja z automatyzacji biznesowej i no-code/low-code
- Skala społeczności: 30 000+ FB, 1100 płacących na Skool, 200+ lekcji wideo

## Platformy i kanały
- **Strona:** akademiaautomatyzacji.com
- **Produkty low ticket:** kurscc.pl · kurs247.pl
- **Skool:** Akademia Automatyzacji (płatna) `skool.com/akademia-automatyzacji` + Strefa AA
  (bezpłatna, lead magnet) `skool.com/strefa-akademii-automatyzacji-6594`
- **Facebook fanpage:** facebook.com/AkademiaAutomatyzacji
- **Grupy FB:** Akademia Automatyzacji (~34k) `groups/887930655685138` · n8n — Polska Społeczność
  `groups/1862334801191952` · Make.com — Polska Społeczność `groups/3171201116366781` ·
  Zbuduj Aplikacje z AI `groups/1693200344557850` · Claude Code — Polska Społeczność `groups/1768175597227732`
- **YouTube:** @AkademiaAutomatyzacji · @Strefa-Akademii-Automatyzacji · @kurs-cc · @kacper-trzepiecinski
- **LinkedIn:** Kacper `linkedin.com/in/kacper-trzepiecinski` · Marcin `linkedin.com/in/marcingacek-com`
- **X:** Kacper `@KacperTrzepiec1` · Akademia `@akademia_automa`
- **TikTok:** `tiktok.com/@akademiaautomatyzacji`
<!-- Pominięte celowo: Instagram (nieużywany) · aibiz.pl (strona chwilowo nie żyje, w przebudowie — dodać po reaktywacji) -->

## Model biznesowy
Lejek: content (YT/FB/LI/X) → low ticket (kurscc.pl / kurs247.pl) lub Strefa AA (bezpłatna)
→ live'y/webinary → **Akademia AA** (płatna, dożywotnia). Low ticket = wejście + upsell do Akademii.
**Rytm sprzedaży:** co miesiąc live → mocna sprzedaż eventowa w tygodniowym okienku.

## Stack
Claude Code, n8n, Make, Obsidian (Personal OS), claude-cron, PostgreSQL (Team OS inbox)
