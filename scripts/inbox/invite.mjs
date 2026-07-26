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

// Prefiks kodu zaproszenia do skrzynki zespołowej — MUSI być identyczny z
// INVITE_CODE_PREFIX w server.js (huba). parseInviteCode to dokładny odwrotnik
// buildInviteCode: `${INVITE_CODE_PREFIX}${funnelUrl}#${token}`.
export const INVITE_CODE_PREFIX = 'puls-inbox:';

// === Pure helper: kod zaproszenia → { hubUrl, token } albo null (odwrotnik buildInviteCode) ===
// Format: `puls-inbox:<funnel-url>#<token>` (jeden string do wklejenia). Rozdzielamy po
// OSTATNIM `#` — token z natury nie zawiera `#`, więc to on jest segmentem po separatorze,
// a wszystko przed nim to URL (odporne na hipotetyczny `#` w URL-u). Zero I/O — walidacja
// formatu tu, osiągalność huba sprawdza osobny probe. null przy każdym złym formacie
// (zły prefiks / brak `#` / pusty URL lub token / URL nie-http) → caller warnuje i pomija.
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
  if (!hubUrl || !token) {
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
// na końcu. Wartość w podwójnych cudzysłowach (URL/token nie zawierają `"`).
export function upsertDotenvLine(envContent, key, value) {
  const content = typeof envContent === 'string' ? envContent : '';
  const line = `${key}="${value}"`;
  const lineRegex = new RegExp(`^${key}=.*$`, 'm');
  if (lineRegex.test(content)) {
    return content.replace(lineRegex, line);
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  return `${prefix}${line}\n`;
}

// === I/O shell: dopisz INBOX_HUB_URL/INBOX_TOKEN do .env workspace'u (format env-loader) ===
// Osobny mechanizm od persistEnvVar (shell RC / rejestr Windows), bo joby skrzynki czytają
// konfigurację z workspace .env przez env-loader — nie z env powłoki. Idempotentnie przez
// upsertDotenvLine (re-run podmienia, nie duplikuje).
export function writeInboxEnv(workspace, hubUrl, token) {
  const envFile = path.join(workspace, '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  content = upsertDotenvLine(content, 'INBOX_HUB_URL', hubUrl);
  content = upsertDotenvLine(content, 'INBOX_TOKEN', token);
  fs.writeFileSync(envFile, content, 'utf-8');
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

// === Pure helper: stan repo → decyzja o naprawie .gitignore ===
// Wejście: { isRepo, isIgnored, gitignoreContent }. Wyjście: rozłączny wariant + treść
// pliku do zapisania (null = nic nie zapisujemy). Rozdzielone od I/O, żeby dało się
// przetestować każdą gałąź bez zakładania repo.
//   not_a_repo → poza repo nie ma czego opublikować, guard przepuszcza
//   ok         → git już ignoruje sekret, zero zapisów
//   needs_fix  → dopisz wzorzec, potem ZAPYTAJ GITA PONOWNIE (dopiero druga odpowiedź rozstrzyga)
//   unfixable  → wzorzec już w pliku, a git nadal nie ignoruje (reguła negacji `!.env`,
//                plik śledzony w indeksie, wzorzec z katalogu nadrzędnego) — dopisywanie
//                drugiej kopii niczego nie zmieni, a duplikowałoby linię przy re-runie
export function planGitignoreFix(state) {
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

// === I/O shell: pytanie do gita o EFEKT reguł ignorowania (exit-code, nigdy stdout) ===
// Kontrakt `git check-ignore -q` jest udokumentowany: 0 = ścieżka ignorowana, 1 = nie,
// 128 = błąd fatalny (najczęściej: to nie repo). Treści `.gitignore` NIE parsujemy —
// odpowiedzi na pytanie „czy plik zostanie zacommitowany" nie ma w tym pliku (reguły
// negacji, wzorce z katalogów nadrzędnych, core.excludesFile, indeks). Świadomie BEZ
// `--no-index`: plik już śledzony ma być raportowany jako NIE-ignorowany, bo dopisanie
// wzorca go nie odśledzi (fail-closed). Brak binarki gita → traktujemy jak brak repo.
function queryGitignoreState(workspace) {
  let isIgnored = true;
  for (const probe of GITIGNORE_PROBE_PATHS) {
    const result = spawnSync('git', ['-C', workspace, 'check-ignore', '-q', '--', probe], {
      encoding: 'utf-8',
    });
    if (result.error || result.status === 128) {
      return { isRepo: false, isIgnored: false };
    }
    if (result.status !== 0) {
      isIgnored = false;
    }
  }
  return { isRepo: true, isIgnored };
}

// === I/O shell: guard — nie zapisuj tokenu do katalogu, który git opublikuje ===
// Zwraca rozłączny wariant (NIE boolean), bo wołający musi rozróżnić trzy różne reakcje:
// `ok`/`not_a_repo` → zapisuj po cichu, `fixed` → zapisz i zaloguj naprawę, `unfixable` →
// POMIŃ zapis sekretu i powiedz człowiekowi, co poprawić (fail-closed: guard, który nie
// potrafi potwierdzić bezpieczeństwa, odmawia operacji).
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
  return { status: after.isRepo && after.isIgnored ? 'fixed' : 'unfixable', gitignoreFile };
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
