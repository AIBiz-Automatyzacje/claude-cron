---
title: "Załączniki w Skrzynce: treść nadawcy stawała się akcją, uprawnieniem i kodem"
date: 2026-09-03
category: auth-issues
severity: critical
stack:
  - Node.js
  - node:sqlite
  - Obsidian (markdown)
  - HTTP (node:http)
tags:
  - markdown-injection
  - autoryzacja
  - content-type
  - xss
  - team-os
  - skrzynka
status: verified
last_verified: 2026-09-03
klasa: "bramka-czarna-lista"
regula: "Plik będący zarazem UI z niezaufanej treści i kanałem poleceń właściciela neutralizuj w renderze oraz kotwicz parser na dokładny kształt renderu, a pól nadawcy (`mime`, `filename`, `sha256`) nie awansuj do roli sterującej. Uprawnienie wyprowadzaj ze śladu nie do sfabrykowania (kto wgrał bajty), nie ze znajomości identyfikatora."
paths:
  - "scripts/inbox/**"
  - "lib/**"
  - "server.js"
waga: "wysoka"
szczebel: "regula"
szczebel_powod: "konwersja learned-patterns: regula tekstowa sprzed P10, bez bramki mechanicznej"
zrodlo: "learned-patterns (konwersja 2026-11-02)"
ucieczki: 0
---

# Załączniki w Skrzynce: treść nadawcy stawała się akcją, uprawnieniem i kodem

## Symptomy

Cztery niezależne findingi z review faz 1–3 zadania `zalaczniki-w-skrzynce`, wszystkie z tego
samego korzenia — **dane od nadawcy trafiały do warstwy, która interpretuje je jako intencję**:

1. **Wymuszone pobranie pliku bez akcji człowieka.** Wiadomość, której treść zawiera odhaczony
   wiersz `Pobierz` z markerem `att:<uuid>`, renderowała się w `Skrzynka.md` jako zwykła linia
   kontynuacji `>   …`, a `parseRequestedDownloads` (`scripts/inbox/inbox-push.mjs`) czytał ją
   jako checkbox odhaczony przez człowieka. Zweryfikowane na żywym renderze: wynik parsera to
   `[{attachment_id:'dddddddd-…'}]`. Zdalny nadawca ściągał do cudzego vaulta plik do 25 MB,
   rozsiewany dalej przez Obsidian Sync. Łamie R6 („pobranie wyłącznie przez odhaczenie przez
   człowieka").
2. **Wyjście z wikilinku i wstrzyknięcie HTML przez nazwę pliku.** `filename` o wartości
   `x]] ![[Sekretny-dziennik` renderowało się jako podwójne osadzenie — nadawca umieszczał
   w Skrzynce ofiary dowolną notatkę z JEJ vaultu, wybraną przez siebie. Nazwa
   `<img src=x onerror=…>.png` wychodziła surowo do wnętrza `<span class="os-att">` (obcy
   `src` = beacon informujący nadawcę, że odbiorca otworzył Skrzynkę). Hub przepuszczał
   `<`, `>`, `"`, `[`, `]`, bo `isUnsafeFilename` sprawdzał tylko separatory ścieżek.
3. **XSS na originie huba z tokenem ofiary w URL-u.** `GET /inbox/v1/:token/blob/:sha256`
   ustawiał `Content-Type` wprost z `attachment.mime` (walidacja: długość ≤255), bez
   `X-Content-Type-Options` i bez `Content-Disposition`. Endpoint jest publiczny (stoi przed
   guardem XFF, chodzi przez Funnel) i ma `Access-Control-Allow-Origin: *`, więc plik podany
   jako `text/html` i otwarty przez adresata wykonywał skrypt na originie huba — a token ofiary
   siedzi w tym samym URL-u (`location.href`). Ten sam skrypt mógł same-origin odpytać
   `/inbox/v1/<token>/pull` i wypompować całą skrzynkę.
4. **Hash jako uprawnienie.** `findAttachmentForUser` autoryzowało regułą „jesteś stroną
   JAKIEJKOLWIEK wiadomości wskazującej ten sha256". Obcy członek, który zna hash (a hash
   wycieka do renderu, archiwum i logów), robił `send` **do samego siebie** z tym `sha256`,
   stawał się `from_user` wiersza i pobierał cudzy poufny plik.

## Root Cause

`Skrzynka.md` jest jednocześnie **dokumentem czytanym przez człowieka** i **kanałem poleceń**:
pull renderuje do niego treść od nadawcy, push parsuje z niego intencję właściciela vaulta.
Render i parser mówią tym samym alfabetem (`- [x] …`, marker w komentarzu Obsidiana), więc każda
linia treści nadawcy jest potencjalnym poleceniem. Analogicznie po stronie huba: `mime` i
`sha256` były traktowane jako pola opisowe, choć pierwsze steruje wykonaniem w przeglądarce,
a drugie — dostępem do bajtów. Wspólny błąd: **pole opisowe od strony zewnętrznej awansowało do
roli sterującej, a bramka została przy starej roli.**

Testy tego nie łapały, bo każdy rozjazd siedzi na SZWIE: testy renderu wstrzykiwały
`isDownloaded`, testy parsera dostawały ręcznie sklejony tekst, a atrapy huba fabrykowały pola,
których prawdziwy hub nie produkował (ten sam wzorzec, co „założenie międzymodułowe = test szwu").

## Rozwiązanie

**1. Neutralizacja przy renderze + kotwica przy parserze — obie strony naraz.**

```js
// scripts/inbox/inbox-pull.mjs — linia treści nigdy nie może być poleceniem
function neutralizeContentLine(line) {
  const zeroWidth = String.fromCharCode(0x200b); // budowany z kodu, nie wklejony do źródła
  return line
    .replace(/^(\s*)-(\s*\[)/, `$1-${zeroWidth}$2`) // rozbija wzorzec checkboxa
    .replaceAll('%%', `%${zeroWidth}%`);            // rozbija wzorzec markera
}
```

```js
// scripts/inbox/inbox-push.mjs — kotwica na DOKŁADNYM kształcie renderu, nie luźne \s*
if (!/^> {1,3}- \[x\] Pobierz — /.test(line)) continue;
```

Sama kotwica nie wystarcza (linie kontynuacji treści mają dokładnie to samo wcięcie co wiersz
załącznika) i sama neutralizacja też nie — kontrakt trzymają obie strony razem, co komentarze
w obu plikach mówią wprost. Dla człowieka linia z zerowej szerokości spacją wygląda identycznie.

**2. Jedna funkcja czyszcząca nazwę, wycinająca wektory OBU kontekstów naraz** (wikilink + HTML),
bo ta sama nazwa trafia do wikilinku i do wnętrza spana:

```js
export function safeAttachmentName(raw) {
  const base = path.basename(String(raw ?? '')).replace(/[/\\:%<>"'[\]\x00-\x1f]/g, '').trim();
  return base === '' || base === '.' || base === '..' ? 'zalacznik' : base;
}
```

**3. Allowlista mime + `nosniff` + `Content-Disposition: attachment` na odpowiedzi z bajtami:**

```js
const SAFE_DOWNLOAD_MIME = new Set([
  'application/octet-stream', 'application/pdf',
  'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'text/plain',
]); // allowlista, nie blocklista — nowy niebezpieczny typ ma domyślnie NIE przechodzić
//    text/html i image/svg+xml oba wykonują skrypt po otwarciu w przeglądarce
res.writeHead(200, {
  'Content-Type': SAFE_DOWNLOAD_MIME.has(mime) ? mime : 'application/octet-stream',
  'Content-Length': size,               // z fs.statSync, nie z deklaracji nadawcy
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'attachment',  // bez nazwy pliku — klient zna ją z metadanych
});
```

Nagłówki liczone PRZED `openBlobRead`: odwrotna kolejność zostawiała otwarty deskryptor za
każdym razem, gdy `writeHead` rzuciło (mime z CR/LF daje `ERR_INVALID_CHAR`), a powtarzany GET
w granicach limitu 30/min wyczerpywał deskryptory huba (EMFILE).

**4. Ślad wgrania jako źródło uprawnienia** — tabela `inbox_blob_uploads(sha256, uploaded_by,
created_at)` zapisywana przez skorupę HTTP po ZWERYFIKOWANYM transferze (suma policzona przez
huba, nigdy z deklaracji w URL-u), a autoryzacja odczytu wymaga, żeby nadawca wiersza realnie te
bajty wgrał:

```sql
SELECT a.* FROM inbox_attachments a
  JOIN inbox i ON i.id = a.message_id
  JOIN inbox_blob_uploads u ON u.sha256 = a.sha256 AND u.uploaded_by = i.from_user
 WHERE a.sha256 = ? AND (i.from_user = ? OR i.to_user = ?)
```

Sam hash przestał być uprawnieniem: `send` do samego siebie z cudzym `sha256` nie ma pasującego
wiersza w `inbox_blob_uploads` i dostaje 404.

**5. Tożsamość załącznika, nie nazwa, rozstrzyga „czy to mój plik".** Stan „pobrany" liczony po
nazwie pliku dawał ten sam werdykt dla dwóch plików `raport.pdf` od różnych osób w tym samym
miesiącu — druga wiadomość renderowała się jako „pobrana", osadzała CUDZY plik pod własnym
podpisem i nie emitowała checkboxa, więc właściwego załącznika nie dało się już pobrać z UI.
Nazwa na dysku niesie skrót sha256 w sufiksie, dzięki czemu render kosztuje jedno `stat` na
załącznik i nigdy nie czyta zawartości.

## Komendy diagnostyczne

```bash
# Czy render neutralizuje polecenie wstrzyknięte w treść (parser musi dać pustą listę)
node --test scripts/inbox/inbox-push.test.mjs scripts/inbox/inbox-pull.test.mjs

# Czy hash bez śladu wgrania nadal autoryzuje (musi dać 404)
node --test lib/inbox-db.test.js server.inbox.http.test.js

# Nagłówki odpowiedzi z bajtami — ręcznie, na żywym hubie
curl -sI "$HUB/inbox/v1/$TOKEN/blob/$SHA" | grep -iE 'content-type|nosniff|disposition'

# Czy jakikolwiek renderer wypuszcza surową nazwę pliku do wikilinku/HTML
grep -rn 'filename' scripts/inbox/inbox-pull.mjs | grep -v safeAttachmentName
```

## Zapobieganie

- Zanim dane od strony zewnętrznej trafią do dokumentu, który sam jest kanałem poleceń, zapytaj:
  **czy parser tego dokumentu odróżni moją treść od intencji właściciela?** Jeśli jedyną
  odpowiedzią jest „bo ma inne wcięcie" — nie odróżni.
- Broń po OBU stronach roundtripu (neutralizacja w renderze + kotwica na dokładnym kształcie
  renderu w parserze) i wiąż je komentarzem, bo żadna z nich sama nie wystarcza.
- Pole opisowe od nadawcy (`mime`, `filename`, `sha256`, `size_bytes`) traktuj jako sterujące
  w momencie, gdy trafia do nagłówka HTTP, ścieżki na dysku, wikilinku albo warunku autoryzacji.
  Allowlista, nie blocklista.
- Uprawnienie do bajtów wyprowadzaj ze śladu, którego atakujący nie sfabrykuje własnym
  `INSERT`-em (kto wgrał), nie z faktu, że zna identyfikator treści.
- Test odmowy **per wektor**, na PRAWDZIWEJ ścieżce (`handleInboxRequest`, render → parser),
  nie na ręcznie sklejonym obiekcie: atrapa fabrykująca pole, którego produkcja nie produkuje,
  daje zielone testy przy złamanym systemie.

## Powiązane

- `docs/solutions/auth-issues/2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-eksfiltracja-prompt-injection.md`
  — ta sama klasa (niezaufana treść + zdolność odczytu = eksfiltracja tożsamości w hubie)
- `docs/solutions/auth-issues/2026-07-24-cors-acao-wildcard-wyciek-tokenu-guard-xff-nie-chroni.md`
  — globalne `ACAO:*` na hubie jest wzmacniaczem punktu 3
- `docs/solutions/runtime-errors/2026-07-28-async-seed-vs-sync-scheduler-job-bez-harmonogramu.md`
  — wzorzec „testy obu stron zielone, szew złamany"
- `docs/active/zalaczniki-w-skrzynce/review-faza-1.md`, `review-faza-3.md` — pełne raporty review

## Kontekst

Zadanie `zalaczniki-w-skrzynce`, branch `feature/zalaczniki-w-skrzynce`, fazy 1–4 pipeline'u
dev-autopilot. Hub = Puls na VPS-ie admina, jedyny proces piszący do `data/inbox.db`; klienci to
script-joby (`scripts/inbox/`) odpalane co minutę na maszynie człowieka. Bajty załączników leżą
poza bazą, w magazynie adresowanym po `sha256` (`lib/inbox-blobs.js`), metadane w
`inbox_attachments`. Naprawy weszły w commitach `3413b2d`, `1635a86`, `17e96ed` wraz z testami
odmowy per wektor.
