// Team OS — wspólny rdzeń kodu zaproszenia do skrzynki (parse → probe → zapis .env)
// + guard chroniący przed zapisem tokenu do repo gitowego.
//
// Jedno źródło prawdy dla WSZYSTKICH ścieżek onboardingu: setup.mjs (lokalny, interaktywny)
// i scripts/inbox/onboard.mjs (most bash → Node dla instalatora VPS). Ekstrakcja tym samym
// ruchem co env-loader.mjs — wspólny moduł zamiast dwóch kopii, które się rozjadą.
// Zależność idzie WYŁĄCZNIE w tę stronę: setup.mjs importuje ten moduł, nigdy odwrotnie
// (skrypt roboczy nie może ciągnąć interaktywnego instalatora z readline/os).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveInboxSecretFile } from './env-loader.mjs';

// Prefiks kodu zaproszenia do skrzynki zespołowej — MUSI być identyczny z
// INVITE_CODE_PREFIX w server.js (huba). parseInviteCode to dokładny odwrotnik
// buildInviteCode: `${INVITE_CODE_PREFIX}${funnelUrl}#${token}`.
export const INVITE_CODE_PREFIX = 'puls-inbox:';

// Znaki, których wartość trafiająca do `.env` NIE może zawierać (fail-closed).
// CR/LF rozrywają linię — `KEY="a<LF>NODE_OPTIONS=--require /tmp/evil.js"` to DWIE zmienne,
// a env-loader wpisze obie do `process.env` skryptów skrzynki, które przekazują env do
// spawnu `claude` (`buildCleanEnv` stripuje tylko `CLAUDE_CODE*`) → wykonanie dowolnego kodu.
// `"` domyka cudzysłów wartości, `\` ucieka spod niego. Pozostałe znaki sterujące i białe
// znaki są odrzucane, bo WHATWG `URL` usuwa TAB/CR/LF po CICHU przy parsowaniu — walidacja
// protokołu ich nie widzi, więc surowy string i tak dotarłby do pliku (dlatego sprawdzamy
// string SPRZED `new URL`).
const UNSAFE_ENV_VALUE = /[\s"\\\x00-\x1f\x7f-\x9f]/;

// Nazwa zmiennej w `.env` — dokładnie dziedzina, którą czyta env-loader (`^[A-Z_][A-Z0-9_]*=`).
// Sprawdzana też dlatego, że klucz idzie do `new RegExp` (metaznaki w kluczu = wstrzyknięcie wzorca).
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

// Dziedzina tokenu zaproszenia: hub emituje `randomBytes(32).toString('hex')`, ale token
// trafia do ŚCIEŻKI URL (`/inbox/v1/:token/*`), więc dopuszczamy pełny zestaw znaków
// „unreserved" z RFC 3986 zamiast twardego `^[0-9a-f]{64}$` — rotacja formatu po stronie
// huba nie zablokuje wtedy onboardingu, a wstrzyknięcie linii/ścieżki dalej jest niemożliwe.
const INVITE_TOKEN_CHARSET = /^[A-Za-z0-9._~-]+$/;

// Plik `.env` niesie token = całą tożsamość w hubie (`/inbox/v1/:token/*`), więc tylko
// właściciel może go czytać. Domyślne 0644 na współdzielonym VPS oddaje sekret każdemu
// kontu w systemie.
const SECRET_FILE_MODE = 0o600;

// === Pure helper: czy wartość wolno wstawić do `.env` jako `KEY="<wartość>"` ===
export function isSafeEnvValue(value) {
  return typeof value === 'string' && value.length > 0 && !UNSAFE_ENV_VALUE.test(value);
}

// === Pure helper: kod zaproszenia → { hubUrl, token } albo null (odwrotnik buildInviteCode) ===
// Format: `puls-inbox:<funnel-url>#<token>` (jeden string do wklejenia). Rozdzielamy po
// OSTATNIM `#` — token z natury nie zawiera `#`, więc to on jest segmentem po separatorze,
// a wszystko przed nim to URL (odporne na hipotetyczny `#` w URL-u). Zero I/O — walidacja
// formatu tu, osiągalność huba sprawdza osobny probe. null przy każdym złym formacie
// (zły prefiks / brak `#` / pusty URL lub token / URL nie-http / znak spoza dziedziny).
export function parseInviteCode(str) {
  const raw = typeof str === 'string' ? str.trim() : '';
  if (!raw.startsWith(INVITE_CODE_PREFIX)) {
    return null;
  }
  const body = raw.slice(INVITE_CODE_PREFIX.length);
  const sepIndex = body.lastIndexOf('#');
  if (sepIndex === -1) {
    return null;
  }
  const hubUrl = body.slice(0, sepIndex).trim();
  const token = body.slice(sepIndex + 1).trim();
  // Dziedzina SPRZED `new URL`: parser WHATWG po cichu wycina CR/LF/TAB, więc po nim
  // string wygląda niewinnie, a my zwracamy wartość SUROWĄ (kontrakt: dokładnie to, co
  // wkleił człowiek) — walidacja po parsowaniu przepuściłaby wstrzyknięcie linii do `.env`.
  // Oba wejścia idą wprost do pliku konfiguracyjnego, więc dziedzina jest wąska i zamknięta.
  if (!isSafeEnvValue(hubUrl) || !INVITE_TOKEN_CHARSET.test(token)) {
    return null;
  }
  // URL musi być parsowalny i http(s) — inaczej probe/fetch dostałby śmieć i rzucił
  // kryptycznie; łapiemy to jako błąd formatu tutaj (czysto, bez sieci).
  let parsedUrl;
  try {
    parsedUrl = new URL(hubUrl);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }
  return { hubUrl, token };
}

// === Pure helper: upsert `KEY=value` w treści workspace .env (format env-loader) ===
// Zwraca nową treść pliku. Format BEZ `export` (inaczej niż upsertEnvLine dla shell RC) —
// scripts/inbox/env-loader.mjs czyta `^KEY=...` i stripuje cudzysłowy. Gdy linia `KEY=...`
// już istnieje — podmienia ją (idempotentny re-run nie duplikuje INBOX_*); inaczej dopisuje
// na końcu. Wartość w podwójnych cudzysłowach.
// Fail-closed na granicy zapisu (druga warstwa po parseInviteCode): klucz spoza dziedziny
// env-loadera albo wartość z białym znakiem / cudzysłowem / znakiem sterującym = wstrzyknięcie
// dodatkowych zmiennych do `.env` → rzucamy zamiast zapisać. Komunikat NIGDY nie zawiera
// wartości — to bywa sekret, a błąd trafia do logu instalacji.
export function upsertDotenvLine(envContent, key, value) {
  if (typeof key !== 'string' || !ENV_KEY.test(key)) {
    throw new Error(`Niedozwolona nazwa zmiennej .env: ${JSON.stringify(key)}`);
  }
  if (!isSafeEnvValue(value)) {
    throw new Error(`Niedozwolona wartość zmiennej ${key} (biały znak, cudzysłów, backslash lub znak sterujący)`);
  }
  const content = typeof envContent === 'string' ? envContent : '';
  const line = `${key}="${value}"`;
  const lineRegex = new RegExp(`^${key}=.*$`, 'm');
  if (lineRegex.test(content)) {
    // Replacer funkcyjny, nie string — w stringu `$&`/`$1` z wartości rozwinęłyby się
    // do fragmentów dopasowania (String.replace), cicho przekłamując zapisany sekret.
    return content.replace(lineRegex, () => line);
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  return `${prefix}${line}\n`;
}

// Klucze skrzynki, które onboarding usuwa ze starego `<workspace>/.env` (patrz niżej).
const LEGACY_INBOX_KEYS = /^(INBOX_HUB_URL|INBOX_TOKEN)=/;

// === I/O shell: usuń sekret skrzynki ze STAREJ lokalizacji w vaultcie ===
// Do 07.2026 onboarding zapisywał INBOX_* do `<workspace>/.env`, czyli dokładnie tam, gdzie
// czyta job auto-reply (`claude -p` z `cwd` = vault, prompt = niezaufana treść cudzej
// wiadomości). Samo przeniesienie ZAPISU nie zamyka dziury na maszynie, która ten plik już
// ma, więc onboarding kasuje z niego dwie linie skrzynki. Pozostałe klucze usera zostają
// nietknięte, pliku nie usuwamy — nie jest nasz. Zwraca true, gdy coś faktycznie usunięto.
export function stripInboxSecretsFromLegacyEnv(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) return false;
  const legacyFile = path.join(workspace, '.env');
  if (!fs.existsSync(legacyFile)) return false;
  const before = fs.readFileSync(legacyFile, 'utf-8');
  const after = before.split('\n').filter((line) => !LEGACY_INBOX_KEYS.test(line)).join('\n');
  if (after === before) return false;
  fs.writeFileSync(legacyFile, after, 'utf-8');
  return true;
}

// === I/O shell: zapisz INBOX_HUB_URL/INBOX_TOKEN do pliku sekretu POZA vaultem ===
// Osobny mechanizm od persistEnvVar (shell RC / rejestr Windows), bo joby skrzynki czytają
// konfigurację przez env-loader — nie z env powłoki. Lokalizacja pochodzi z jednego źródła
// prawdy (`resolveInboxSecretFile`: `INBOX_ENV_FILE` albo `data/inbox.env` w katalogu
// instalacji) i CELOWO nie leży w workspace: agent auto-reply czyta vault narzędziem Read
// na polecenie obcej osoby, więc token w vaultcie to eksfiltracja tożsamości jednym pytaniem.
// Idempotentnie przez upsertDotenvLine (re-run podmienia, nie duplikuje).
export function writeInboxEnv(workspace, hubUrl, token) {
  const envFile = resolveInboxSecretFile();
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  // Walidacja (rzucająca) PRZED jakimkolwiek zapisem — wroga wartość nie może zostawić
  // pliku w półstanie ani skasować sekretu ze starej lokalizacji.
  content = upsertDotenvLine(content, 'INBOX_HUB_URL', hubUrl);
  content = upsertDotenvLine(content, 'INBOX_TOKEN', token);
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, content, { encoding: 'utf-8', mode: SECRET_FILE_MODE });
  // `mode` w writeFileSync działa TYLKO przy tworzeniu pliku — plik zostawiony przez
  // wcześniejszą instalację (albo inne narzędzie) zostałby przy 0644 z tokenem w środku,
  // więc uprawnienia domykamy zawsze. Idempotentne; na Windows no-op poza flagą read-only.
  fs.chmodSync(envFile, SECRET_FILE_MODE);
  stripInboxSecretsFromLegacyEnv(workspace);
  return envFile;
}

// Wzorzec naprawczy dopisywany do `<workspace>/.gitignore`. `.env*` (nie samo `.env`),
// bo token trafia też do wariantów z sufiksem — kopii zapasowych edytora (`.env.bak`,
// `.env.save`) i lokalnych wariantów (`.env.local`) — a każdy z nich niesie ten sam sekret.
export const GITIGNORE_PATTERN = '.env*';

// Ścieżki, o które pytamy gita. Samo `.env` NIE wystarcza jako dowód bezpieczeństwa:
// repo z gołym wpisem `.env` przepuści `.env.bak` z tym samym tokenem. Druga sonda to
// syntetyczna nazwa wariantu — pytamy o EFEKT wzorca `.env*`, nie o istnienie pliku
// (check-ignore nie wymaga, żeby plik istniał).
const GITIGNORE_PROBE_PATHS = ['.env', '.env.bak.x'];

// Jedyna fraza, którą git raportuje dla „katalog nie jest repozytorium". Kod 128 to
// GENERYCZNY błąd fatalny (brak repo, ale też nieistniejący katalog, EACCES na `.git`,
// uszkodzony obiekt), więc sam kod nie odróżnia „poza repo" od „nie wiem" — rozstrzyga
// dokładna fraza przy wymuszonej angielskiej lokalizacji (learned pattern 2026-07-03).
const NOT_A_REPO_STDERR = /not a git repository/i;

// === Pure helper: stan repo → decyzja o naprawie .gitignore ===
// Wejście: { isRepo, isIgnored, gitignoreContent }, gdzie isRepo = true | false | 'unknown'.
// Wyjście: rozłączny wariant + treść pliku do zapisania (null = nic nie zapisujemy).
// Rozdzielone od I/O, żeby dało się przetestować każdą gałąź bez zakładania repo.
//   unknown    → git nie odpowiedział wiarygodnie; NIE wiemy, czy katalog jest repo →
//                fail-closed, wołający ma pominąć zapis sekretu (brak gita na maszynie nie
//                znaczy „to nie repo": vault bywa commitowany z DRUGIEJ maszyny)
//   not_a_repo → poza repo nie ma czego opublikować, guard przepuszcza
//   ok         → git już ignoruje sekret, zero zapisów
//   needs_fix  → dopisz wzorzec, potem ZAPYTAJ GITA PONOWNIE (dopiero druga odpowiedź rozstrzyga)
//   unfixable  → wzorzec już w pliku, a git nadal nie ignoruje (reguła negacji `!.env`,
//                plik śledzony w indeksie, wzorzec z katalogu nadrzędnego) — dopisywanie
//                drugiej kopii niczego nie zmieni, a duplikowałoby linię przy re-runie
export function planGitignoreFix(state) {
  if (state?.isRepo === 'unknown') {
    return { status: 'unknown', nextContent: null };
  }
  if (state?.isRepo !== true) {
    return { status: 'not_a_repo', nextContent: null };
  }
  if (state?.isIgnored === true) {
    return { status: 'ok', nextContent: null };
  }
  const content = typeof state?.gitignoreContent === 'string' ? state.gitignoreContent : '';
  if (hasGitignorePattern(content)) {
    return { status: 'unfixable', nextContent: null };
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  return {
    status: 'needs_fix',
    nextContent: `${prefix}# Sekrety Puls / Team OS — nigdy do repo (dopisane przez instalator)\n${GITIGNORE_PATTERN}\n`,
  };
}

function hasGitignorePattern(content) {
  return content.split('\n').some((line) => line.trim() === GITIGNORE_PATTERN);
}

// Angielska lokalizacja wymuszona, bo o „poza repo" rozstrzygamy frazą ze stderr —
// przetłumaczony komunikat gita (git z NLS + polskie locale) zamieniłby jednoznaczne
// „to nie repo" w nierozstrzygalne „unknown". env budowany per wywołanie, nie przy
// require: testy i instalator zmieniają process.env (GIT_CONFIG_GLOBAL, PATH) w locie.
function runGit(workspace, args) {
  return spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
}

// === I/O shell: pytanie do gita o EFEKT reguł ignorowania (exit-code, nigdy stdout) ===
// Kontrakt `git check-ignore -q` jest udokumentowany: 0 = ścieżka ignorowana, 1 = nie,
// cokolwiek innego = błąd. Treści `.gitignore` NIE parsujemy — odpowiedzi na pytanie „czy
// plik zostanie zacommitowany" nie ma w tym pliku (reguły negacji, wzorce z katalogów
// nadrzędnych, core.excludesFile, indeks). Świadomie BEZ `--no-index`: plik już śledzony ma
// być raportowany jako NIE-ignorowany, bo dopisanie wzorca go nie odśledzi (fail-closed).
// Najpierw `rev-parse --git-dir`, żeby rozdzielić trzy różne światy: brak gita / błąd
// (isRepo 'unknown'), katalog poza repo (false), repo (true). Bez tego rozdziału każdy błąd
// narzędzia wyglądał jak „poza repo" i guard po cichu przepuszczał zapis tokenu.
function queryGitignoreState(workspace) {
  const inside = runGit(workspace, ['rev-parse', '--git-dir']);
  if (inside.error) {
    return { isRepo: 'unknown', isIgnored: false };
  }
  if (inside.status !== 0) {
    return NOT_A_REPO_STDERR.test(inside.stderr || '')
      ? { isRepo: false, isIgnored: false }
      : { isRepo: 'unknown', isIgnored: false };
  }
  let isIgnored = true;
  for (const probe of GITIGNORE_PROBE_PATHS) {
    const result = runGit(workspace, ['check-ignore', '-q', '--', probe]);
    // Jesteśmy w repo (potwierdzone wyżej), więc git ma tu do powiedzenia wyłącznie 0 albo 1.
    // Każda inna odpowiedź to awaria narzędzia — czytanie jej jako „nie ignorowany" byłoby
    // fail-open (guard „naprawiłby" .gitignore i uznał sekret za bezpieczny).
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return { isRepo: 'unknown', isIgnored: false };
    }
    if (result.status === 1) {
      isIgnored = false;
    }
  }
  return { isRepo: true, isIgnored };
}

// === I/O shell: guard — nie zapisuj tokenu do katalogu, który git opublikuje ===
// Zwraca rozłączny wariant (NIE boolean), bo wołający musi rozróżnić różne reakcje:
// `ok`/`not_a_repo` → zapisuj po cichu, `fixed` → zapisz i zaloguj naprawę,
// `unfixable`/`unknown` → POMIŃ zapis sekretu i powiedz człowiekowi, co poprawić
// (fail-closed: guard, który nie potrafi potwierdzić bezpieczeństwa, odmawia operacji).
export function ensureEnvIgnored(workspace) {
  const gitignoreFile = path.join(workspace, '.gitignore');
  const content = fs.existsSync(gitignoreFile) ? fs.readFileSync(gitignoreFile, 'utf-8') : '';
  const plan = planGitignoreFix({ ...queryGitignoreState(workspace), gitignoreContent: content });
  if (plan.status !== 'needs_fix') {
    return { status: plan.status, gitignoreFile };
  }
  fs.writeFileSync(gitignoreFile, plan.nextContent, 'utf-8');
  // Ponowna weryfikacja: dopisany wzorzec to dopiero HIPOTEZA naprawy — o skutku
  // rozstrzyga git, nie my (reguła negacji poniżej wzorca wygrywa mimo dopisania).
  const after = queryGitignoreState(workspace);
  if (after.isRepo === 'unknown') {
    return { status: 'unknown', gitignoreFile };
  }
  return { status: after.isRepo === true && after.isIgnored ? 'fixed' : 'unfixable', gitignoreFile };
}

// === I/O shell: probe kodu zaproszenia — ping huba przez inbox-client, weryfikacja v:1 ===
// Reużywa client.ping() (własny retry + weryfikacja v:1) zamiast dublować logikę. Klient
// czyta INBOX_HUB_URL/INBOX_TOKEN z process.env w momencie wywołania, więc ustawiamy je
// TYLKO na czas probe i przywracamy poprzedni stan w finally (probe nie mutuje trwale env —
// zapis do .env robi osobny krok dopiero PO sukcesie). NIGDY nie rzuca (wzorzec notify-push):
// pad (timeout / zły kod / zła wersja) → { ok:false, reason }.
export async function probeInviteCode(hubUrl, token) {
  const prevUrl = process.env.INBOX_HUB_URL;
  const prevToken = process.env.INBOX_TOKEN;
  process.env.INBOX_HUB_URL = hubUrl;
  process.env.INBOX_TOKEN = token;
  try {
    const client = await import('./inbox-client.mjs');
    const data = await client.ping();
    return { ok: true, user: data?.user };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    if (prevUrl === undefined) delete process.env.INBOX_HUB_URL;
    else process.env.INBOX_HUB_URL = prevUrl;
    if (prevToken === undefined) delete process.env.INBOX_TOKEN;
    else process.env.INBOX_TOKEN = prevToken;
  }
}
