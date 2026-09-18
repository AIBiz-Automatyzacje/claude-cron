---
title: "Nowy element w renderze przełącza selektor :has() piętro wyżej, a prezentacja i dokumentacja funkcji zostają w drugim repo"
date: 2026-09-05
category: ui-bugs
severity: high
stack:
  - CSS
  - Obsidian
  - Node.js
tags:
  - css-has
  - selektor-poddrzewa
  - granica-repozytoriow
  - team-os
  - skrzynka
  - regresja-wizualna
status: verified
last_verified: 2026-09-05
---

# Nowy element renderu przełącza `:has()` piętro wyżej — i luka między repo

Zadanie „załączniki w Skrzynce" przeszło pełny automat (1305 testów), review CodeRabbit i merge.
Mimo to funkcja dotarła do zespołu **niekompletna w trzech miejscach naraz**, a jedno z nich było
regresją psującą wygląd wiadomości bez załączników w tym samym wątku.

## Symptomy

1. **Awatar nadawcy nachodzi na nick** (`F` zasłania „Filip"), a w skrajnym przypadku ląduje
   w lewym górnym rogu okna. Objaw **wyłącznie w wątkach z załącznikiem**.
2. Wiersz `- [ ] Pobierz — 📎 nazwa` renderuje się bez stylów; „Pobierz —" łamie się na dwie linie.
3. Agent poproszony „wyślij X plik do Y" wysyła samą wiadomość — **nie używa `--attach`**,
   mimo że skrypt tę flagę ma i działa.

## Root Cause

Trzy objawy, dwie przyczyny — obie tego samego rodzaju: **coś, co należało do funkcji, zostało
po drugiej stronie granicy**.

### (a) `:has()` bez kombinatora dziecka ma zasięg całego poddrzewa

Awatar to `position: absolute`, więc kotwiczy się na najbliższym pozycjonowanym przodku.
Pozycjonowanie nitki dawała reguła:

```css
.skrzynka .callout .callout-content ul:not(:has(.task-list-item)) { position: relative; }
```

czyli „lista, która **nie** zawiera checkboxów". Przed załącznikami checkboxy istniały wyłącznie
w stopce — w osobnej liście-rodzeństwie — więc nitka warunek spełniała.

Wiersz „Pobierz" jest `task-list-item` i siedzi **wewnątrz** nitki. `:has()` przeszukuje cały
poddrzewo, więc nadrzędny `ul` zaczął pasować do `:has(.task-list-item)`, wypadł spod `:not(...)`,
stracił `position: relative`, a awatary zakotwiczyły się na `<body>`.

Zmiana była w renderze (nowy wiersz listy), a zepsuło się **pozycjonowanie dwa poziomy wyżej**,
w elemencie, którego nikt nie dotykał.

### (b) Funkcja rozłożona na dwa repozytoria

Kod renderu żyje w repo Pulsa (`claude-cron`), a **prezentacja i dokumentacja w repo pluginu
firmowego** (`aibiz-plugin`). Fazy zadania dotknęły wyłącznie pierwszego:

| Artefakt | Repo | Stan po merge'u |
|---|---|---|
| `inbox-pull.mjs` — render klas `os-att` | claude-cron | ✅ |
| `send.mjs` / `reply.mjs` — flaga `--attach` | claude-cron | ✅ |
| `skrzynka.css` — style `os-att`, `os-att-gone` | aibiz-plugin | ❌ brak |
| `SKILL.md` skilla `deleguj` — opis `--attach` | aibiz-plugin | ❌ brak |

Skutek praktyczny: **flaga istniała, ale agent o niej nie wiedział**, więc dla użytkownika
funkcji po prostu nie było.

### Dlaczego nie złapała tego kontrola spójności

Job „Puls — kontrola spójności" porównuje snippet w vaulcie z szablonem w pluginie. Obie kopie
były **identyczne i obie stare** — rozjazdu nie ma, więc alarmu nie ma. Mechanizm pilnuje
synchronizacji dwóch kopii, a nie tego, czy szablon nadąża za kodem.

## Rozwiązanie

### 1. Zawęź `:has()` do bezpośrednich dzieci

```css
/* ŹLE — łapie task-list-item gdziekolwiek w poddrzewie */
ul:not(:has(.task-list-item)) { position: relative; }

/* DOBRZE — tylko lista, której WŁASNE dzieci są checkboxami (stopka) */
ul:not(:has(> li.task-list-item)) { position: relative; }
```

Sześć wystąpień tego samego wzorca (szyna nitki, `::before`, `::after`, stopka). Stopka ma
checkboxy jako dzieci wprost i nadal jest rozpoznawana; nitka z zagnieżdżonym wierszem
załącznika — już nie.

### 2. Dopisz style dla nowych klas

```css
.skrzynka .os-att {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--sk-pill); border-radius: 999px; padding: 2px 10px;
  max-width: 100%;
  overflow-wrap: anywhere;  /* nazwa pliku pochodzi od nadawcy */
}
.skrzynka .callout .callout-content li:has(.os-att) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
}
```

### 3. Uzupełnij dokumentację skilla

Skill to jedyne źródło wiedzy agenta o dostępnych flagach. Nowy argument CLI bez wpisu
w `SKILL.md` jest funkcją martwą.

## Komendy diagnostyczne

```bash
# Które klasy produkuje render, a których nie zna CSS
grep -ohE 'class="[^"]*"' scripts/inbox/inbox-pull.mjs \
  | grep -oE 'os-[a-z-]+' | sort -u \
  | while read k; do
      grep -q "\.$k" "$SNIPPET" || echo "BRAK stylu: $k"
    done

# Czy snippet w vaulcie nadąża za szablonem
diff "$VAULT/.obsidian/snippets/skrzynka.css" "$PLUGIN/skills/onboard/templates/skrzynka.css"

# Weryfikacja pozycjonowania na żywym DOM (przeglądarka)
# av.offsetParent — oczekiwane LI, nie BODY
# av.getBoundingClientRect().right < who.getBoundingClientRect().x
```

Odtworzenie DOM w przeglądarce (mały serwer + strona z tą samą strukturą co render) było jedyną
metodą, która dała **liczby zamiast wrażeń** — `offsetParent`, współrzędne, jawny test nachodzenia.

## Zapobieganie

- **Kombinator dziecka w `:has()` domyślnie.** `:has(.klasa)` pisz tylko wtedy, gdy świadomie chcesz
  przeszukać całe poddrzewo. Reguła strukturalna („czy to jest lista typu X") prawie zawsze chce
  `:has(> element)`.
- **Przy każdej nowej klasie w renderze pytaj o dwie rzeczy**: czy ma styl, i czy jej obecność
  nie zmienia warunku w regule wyżej (`:has`, `:not`, `:only-child`, `+`, `~`).
- **Funkcja dotykająca dwóch repo ma checklistę dostawy**, nie tylko definicję ukończenia w repo kodu:
  render → style → dokumentacja skilla → instrukcja aktualizacji dla zespołu.
- **Kontrola spójności powinna porównywać szablon z kodem, nie tylko kopię z kopią** — np. grep klas
  `os-*` z renderu przeciw szablonowi CSS. Dwie identyczne, jednakowo przestarzałe kopie to
  dla dzisiejszego mechanizmu stan zdrowy.

## Powiązane

- [Treść nadawcy jako akcja, uprawnienie i kod w Skrzynce](../auth-issues/2026-09-03-tresc-nadawcy-jako-akcja-uprawnienie-i-kod-w-skrzynce.md)
- [Nowa gałąź renderu omija neutralizację](../auth-issues/2026-09-04-nowa-galaz-renderu-omija-neutralizacje-i-deklaracja-nadawcy-w-metadanych.md) —
  bliźniacza klasa: nowy kształt w renderze omija regułę, która „jest"
- PR: [AIBiz-Automatyzacje/claude-cron#15](https://github.com/AIBiz-Automatyzacje/claude-cron/pull/15)
- Commity pluginu: `7380899` (skill), `cf14d90` (style załącznika), `c99534b` (poprawka `:has`)

## Kontekst

Wykryte podczas smoke'a operatora na żywym systemie (hub VPS + dwie maszyny klienckie), już po
zielonym automacie i merge'u. Transfer, render, pobranie i niezmienniki checkboxów działały
poprawnie — zawiodła wyłącznie warstwa prezentacji i dostawy do zespołu.

Objaw był mylący: użytkownik zgłosił „rozjeżdża się stylowanie", co brzmi jak drobiazg kosmetyczny,
a okazało się regresją pozycjonowania wywołaną przez element dodany gdzie indziej. Wersja Obsidiana
była fałszywym tropem — dokumentacja skilla ostrzega, że brak wsparcia `:has()` daje identyczny
objaw (awatary na tekście), więc łatwo było zatrzymać się na „zaktualizuj Obsidiana".
