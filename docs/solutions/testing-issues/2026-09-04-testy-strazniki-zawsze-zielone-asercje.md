---
title: "Testy udające strażników niezmiennika: asercja o artefakcie, który nigdy nie powstaje, throws bez predykatu, beton na środowisku"
date: 2026-09-04
category: testing-issues
severity: high
stack:
  - Node.js
  - node:test
tags:
  - jakosc-testow
  - falszywa-zielen
  - review-bota
  - windows
status: verified
last_verified: 2026-09-04
---

# Cztery testy, które przechodziły także przy złamanym zachowaniu

Materiał: klaster uwag bota PR `zalaczniki-w-skrzynce` (tury 1–2). Każdy z tych testów był
w checkliście fazy jako dowód niezmiennika i każdy przechodził **niezależnie od zachowania**.

## Symptomy

- `scripts/inbox/attachments.test.mjs` — dwa testy bezpieczeństwa („przerwane pobranie",
  „hub oddał inne bajty") asertowały **nieobecność `raport.pdf`**, nazwy, która nigdy nie
  powstaje: pliki zapisuje `attachmentFileName` jako `stem (sha8).ext`. Asercja zawsze prawdziwa,
  także gdy ucięty plik ZOSTAJE w vaultcie.
- `lib/inbox-db.test.js:657` — `assert.throws` **bez predykatu** w jedynym teście pilnującym
  klucza obcego `inbox_attachments.message_id`. Zaliczyłby go TypeError, literówka w nazwie
  funkcji albo wyłączone `PRAGMA foreign_keys`.
- `lib/inbox-blobs.test.js:185` — asercja `getBlobsDir().includes('/data/')` betonowała
  **domyślny układ ścieżki**, który `config.js` świadomie pozwala nadpisać przez
  `CLAUDE_CRON_INBOX_BLOBS_DIR`: test czerwony u operatora, który ustawił override do smoke'u.
  Mierzył środowisko uruchomienia, nie kontrakt.
- `scripts/inbox/inbox-client.test.mjs:527` — test niezapisywalnego katalogu opiera się na
  `chmod 0o500`, co na Windowsie nie blokuje `mkdir`, i nie miał skip-guardu. Projekt realnie
  wspiera Windows, a suita na macOS nie powie o nim NIC.

## Root Cause

Asercja została napisana z **wyobrażenia** o produkcie (nazwa pliku, kształt ścieżki, „rzuci
błędem"), a nie z faktycznego artefaktu, który produkcja wytwarza. Tak napisany test mierzy
zgodność z wyobrażeniem autora, więc jest zielony zarówno gdy kod działa, jak i gdy nie działa.

## Rozwiązanie

```js
// 1. asercja „nic nie zostało" patrzy na FAKTYCZNĄ zawartość katalogu, nie na zgadniętą nazwę
function listMonth(dir) { const d = path.join(dir, MONTH);
  return fs.existsSync(d) ? fs.readdirSync(d) : []; }
assert.equal(fs.existsSync(path.join(dir, MONTH, attachmentFileName('raport.pdf', att.sha256))), false);
assert.deepEqual(listMonth(dir), [], 'po przerwanym transferze nie zostaje żaden plik');

// 2. predykat jest istotą testu na constraint bazy
assert.throws(
  () => inboxDb.addAttachments(db, 'nie-ma-takiej-wiadomosci', [attachment()]),
  (err) => err.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY constraint failed/.test(err.message)
);

// 3. kontrakt = zgodność ze źródłem konfiguracji, nie z jej domyślną wartością
assert.strictEqual(getBlobsDir(), INBOX_BLOBS_DIR);

// 4. mechanizm zależny od uprawnień POSIX = jawny skip-guard poza POSIX
```

## Komendy diagnostyczne

```bash
# throws/rejects bez predykatu
grep -rn "assert.throws(\s*()" --include=*.test.* . | grep -v "(err)"
grep -rn "assert.rejects(" --include=*.test.* . | grep -v "=>"

# asercje na nieobecność literału nazwy pliku, gdy nazwę produkuje funkcja
grep -rn "existsSync(path.join(.*'.*\..*')" --include=*.test.* .

# testy zależne od chmod bez guardu platformy
grep -rln "chmod\|0o500" --include=*.test.* . | xargs grep -Ln "process.platform"
```

## Zapobieganie

- **Test negatywny musi mieć wersję czerwoną.** Przed zaliczeniem checkboxa `Test:` zepsuj
  implementację w jednej linii i sprawdź, że test faktycznie pada. Asercja o nieobecności
  literału to najczęstsza asercja zawsze prawdziwa.
- Nazwę/ścieżkę artefaktu w asercji buduj **tą samą funkcją co produkcja**
  (`attachmentFileName`, `INBOX_BLOBS_DIR`) — nigdy ręcznym literałem; inaczej test mierzy
  zgodność z wyobrażeniem, nie z kodem.
- `assert.throws`/`assert.rejects` **zawsze z predykatem** (kod błędu lub regexp komunikatu),
  zwłaszcza gdy pilnują constraintu bazy albo bramki bezpieczeństwa.
- Test opierający się o mechanizm systemu (uprawnienia POSIX, symlinki, blokady plików) dostaje
  skip-guard po `process.platform` — brak guardu to nie „przenośny test", tylko cicha luka
  w pokryciu drugiej platformy.

## Powiązane

- `.claude/rules/coding-rules.md` §2 (zero assertion-free testów, testuj zachowanie)
- `docs/solutions/deployment-issues/2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md`
  — ta sama pułapka „suita na macOS nie powie nic o Windowsie".

## Kontekst

Cztery uwagi z jednego PR, wszystkie PO naszym multi-agent review fazy. Nasze review sprawdza,
czy test **istnieje** dla wymaganego zachowania; nie sprawdzało, czy potrafi być czerwony.
