const { execSync } = require('node:child_process');
const crypto = require('node:crypto');

const claudeSpawn = require('./claude-spawn');
const config = require('./config');
const db = require('./db');
const discord = require('./discord');
const telegram = require('./telegram');

// Nazwa joba-teczki asystenta głosowego — idempotencja po `name` (wzorzec starter-jobs.js).
const ASK_JOB_NAME = 'Asystent głosowy';

// Limity bramek (R3/R4). Rate limit liczymy per PRÓBA autoryzowana (standardowa semantyka
// rate-limitera — chroni też przed młóceniem zajętego locka), stały kubeł minutowy —
// prostszy z dwóch wariantów z planu, spełnia kryterium „11. zapytanie w minucie odpada".
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_BACKGROUND_SLOTS = 3;

// Teksty odmów „dla człowieka" — zawsze {status:200, text}, bo Shortcuts gubi body
// przy kodzie błędu (R2). Mapowanie na HTTP robi server.js (Unit 5).
const TEXT_RATE_LIMIT = '⏳ Za dużo pytań naraz — odczekaj chwilę i spytaj ponownie';
const TEXT_SYNC_BUSY = '⏳ Jeszcze myślę nad poprzednim pytaniem';
const TEXT_SLOTS_FULL = '⏳ Mam pełne ręce — poczekaj aż coś skończę';

// Stan współbieżności i rate limitu czysto in-memory (wzorzec currentProcess w executorze).
// ŚWIADOMIE zero agregatów SQL — node:sqlite zwraca COUNT/SUM jako BigInt na części buildów.
// Restart serwera zeruje stan — spójne z rzeczywistością (procesy giną z serwerem, reaper domyka runy).
const state = {
  rateWindow: { start: 0, count: 0 },
  isSyncBusy: false,
  backgroundSlots: 0,
};

// Porównanie sekretów w stałym czasie. Guard długości PRZED timingSafeEqual
// (rzuca przy buforach różnej długości). Pusty/brakujący `expected` = brak
// konfiguracji = zawsze odmowa — także dla „poprawnego" pustego sekretu.
function verifySecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') {
    return false;
  }
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Podwójna autoryzacja (R2): token z URL + sekret z nagłówka X-Secret.
// Oba porównania liczone ZAWSZE (bez short-circuit), żeby czas odpowiedzi
// nie zdradzał, czy token był trafiony.
function verifyAuth({ token, secret }, { askToken, askSecret }) {
  const isTokenValid = verifySecret(token, askToken);
  const isSecretValid = verifySecret(secret, askSecret);
  return isTokenValid && isSecretValid;
}

// Stały kubeł minutowy: okno startuje przy pierwszej próbie, po upływie okna licznik się odnawia.
function isRateLimited(now) {
  if (now - state.rateWindow.start >= RATE_LIMIT_WINDOW_MS) {
    state.rateWindow = { start: now, count: 0 };
  }
  if (state.rateWindow.count >= RATE_LIMIT_MAX) return true;
  state.rateWindow.count += 1;
  return false;
}

// Bramki wejścia w kolejności: auth → rate limit → lock sync → slot tła (konspekt B).
// Odmowa auth = {status:403} BEZ treści (kody błędów wyłącznie dla intruzów);
// odmowy „dla człowieka" = {status:200, text}. Przy przyjęciu rezerwuje OD RAZU
// lock sync ORAZ slot tła (pesymistycznie — każde zapytanie może się odczepić;
// decyzja usera 13.07), więc odmowa slotów pada PRZED spawnem.
// `now` wchodzi argumentem (testowalny zegar), config wstrzykiwalny dla testów.
function admitRequest(
  { token, secret, now = Date.now() },
  { askToken = config.ASK_TOKEN, askSecret = config.ASK_SECRET } = {}
) {
  if (!verifyAuth({ token, secret }, { askToken, askSecret })) {
    return { allowed: false, status: 403 };
  }
  if (isRateLimited(now)) {
    return { allowed: false, status: 200, text: TEXT_RATE_LIMIT };
  }
  if (state.isSyncBusy) {
    return { allowed: false, status: 200, text: TEXT_SYNC_BUSY };
  }
  if (state.backgroundSlots >= MAX_BACKGROUND_SLOTS) {
    return { allowed: false, status: 200, text: TEXT_SLOTS_FULL };
  }
  state.isSyncBusy = true;
  state.backgroundSlots += 1;
  return { allowed: true };
}

// Zwolnienie locka sync: po odpowiedzi sync ALBO w momencie odczepienia w tło
// (odczepione zapytanie przestaje blokować kolejne sync; slot tła trzyma dalej).
function releaseSyncLock() {
  state.isSyncBusy = false;
}

// Zwolnienie slotu tła: na `close` procesu (sync-finished, detached-finished lub kill
// po ASK_MAX_MS). Floor na 0 — trzech potencjalnych „domykaczy" runu (close handler,
// reaper, kill) nie może zepchnąć licznika poniżej zera.
function releaseBackgroundSlot() {
  state.backgroundSlots = Math.max(0, state.backgroundSlots - 1);
}

// Reset stanu dla testów (izolacja między casami).
function resetAskState() {
  state.rateWindow = { start: 0, count: 0 };
  state.isSyncBusy = false;
  state.backgroundSlots = 0;
}

// Get-or-create joba-teczki. NIGDY nie nadpisuje istniejącego — flagi powiadomień
// zmienione przez usera są święte (lekcja backfill-clobber). Tworzona leniwie przy
// pierwszym zapytaniu, NIE w migrate(). Pusty cron_expr = scheduler ją pomija;
// run_on_wake=0, żeby missed-job detection nawet nie rozważała teczki.
function getOrCreateAskJob() {
  const existing = db.getAllJobs().find((job) => job.name === ASK_JOB_NAME);
  if (existing) return existing;
  return db.createJob({
    name: ASK_JOB_NAME,
    skill_name: '',
    cron_expr: '',
    run_on_wake: 0,
    routine: 1, // retencja 24 h dla udanych runów (R8)
    discord_notify: 0,
    telegram_notify: 0,
  });
}

// === Wykonanie zapytania: spawn, odczepienie, powiadomienia (Unit 4) ===

// Template asystencki: odpowiedź czytana na głos, bez klasyfikacji długie/krótkie
// (model sam decyduje formą — pytanie vs polecenie).
const ASK_PROMPT_TEMPLATE = [
  'Jesteś asystentem głosowym — Twoja odpowiedź zostanie odczytana na głos.',
  'Gdy dostajesz pytanie: odpowiedz w 2–4 zdaniach, bez markdownu, list i bloków kodu.',
  'Gdy dostajesz polecenie: wykonaj je, a potem potwierdź jednym zdaniem, co zrobiłeś.',
].join('\n');

const TEXT_DETACHED = '⏳ To zajmie chwilę — robię w tle, dam znać na komunikatorze';
const TEXT_SYNC_FAILED = '❌ Coś poszło nie tak — zajrzyj do historii w Pulsie';

// Skrót przyczyny pada w ❌: gdy brak error_msg bierzemy ogon stderr — ta sama
// semantyka co buildFailureMessage w lib/telegram.js.
const STDERR_TAIL_LEN = 1000;

// Karencja między 'exit' a 'close'. Streamy stdio flushują ogon stdout PO 'exit',
// więc normalnie cykl domyka 'close' (pełny output). Ale killProcessTree na Unix
// bije tylko bezpośrednie dziecko — wnuk CLI dziedziczący stdout/stderr trzyma pipe
// po śmierci rodzica i 'close' NIE nadejdzie nigdy. Bez domknięcia z 'exit' slot tła
// wyciekałby na zawsze (3 takie zdarzenia = permanentne „⏳ Mam pełne ręce" do
// restartu serwera). Po karencji settle domyka cykl z tym, co zdążyło spłynąć.
const EXIT_CLOSE_GRACE_MS = 2000;

function buildAskPrompt(question) {
  return `${ASK_PROMPT_TEMPLATE}\n\n${question}`;
}

function truncateTail(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(-max); // ogon — ostatnie linie mówią najwięcej (wzorzec executora)
}

// Kill drzewa procesów — wzorzec z executora: Windows taskkill /T /F (drzewo),
// Unix SIGTERM → SIGKILL po 5 s. Timer-bezpiecznik z unref(), żeby nie trzymał
// event loopu po zakończeniu (testy / shutdown serwera).
function killProcessTree(proc) {
  if (config.IS_WIN) {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch {}
    return;
  }
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000).unref();
}

// Powiadomienie o wyniku ODCZEPIONEGO zadania — plain text przez sendPlain (smartSplit
// w kanale, resolveNotifyConfig w czasie wysyłki), Z POMINIĘCIEM extractResult (ask to
// --output-format text, nie stream-json) i notifyRunOutcome (kontrakt R9 schedulera —
// retry/„killed milczy" — nietknięty). Fire-and-forget: pad kanału tylko do logu.
// Oba kanały wyłączone = jedyny dopuszczalny „cichy" przypadek — jawnie zalogowany.
function notifyAskOutcome(job, status, { stdout, stderr, errorMsg }) {
  if (!job.discord_notify && !job.telegram_notify) {
    console.warn(
      `[ask] wynik zadania w tle bez kanału powiadomień — włącz Discord/Telegram na jobie "${job.name}", inaczej odpowiedzi z tła przepadają`
    );
    return;
  }
  const detail = (errorMsg && errorMsg.trim()) || (stderr || '').trim().slice(-STDERR_TAIL_LEN);
  const text = status === 'success'
    ? `✅ ${job.name}\n${(stdout || '').trim() || '(pusta odpowiedź)'}`
    : `❌ ${job.name} padł (${status})${detail ? `\n${detail}` : ''}`;
  const logNotifyError = (err) => console.error('[ask][notify]', err.message);
  if (job.discord_notify) discord.sendPlain(text).catch(logNotifyError);
  if (job.telegram_notify) telegram.sendPlain(text).catch(logNotifyError);
}

// JEDYNA funkcja domykająca run ask — wołana z close, z bezpiecznika ASK_MAX_MS
// i z proc.on('error'). Idempotentna przez ŚWIEŻY odczyt DB: run w stanie innym niż
// 'running' był już domknięty (wcześniejszy call, reaper Unit 6 albo kill usera) →
// no-op bez nadpisania statusu i bez drugiego powiadomienia (lekcja stale-obiekt-vs-DB).
// Zwraca true, gdy to TO wywołanie domknęło run.
function finalizeAskRun({ runId, jobId, status, code = null, stdout, stderr, errorMsg, shouldNotify }) {
  const fresh = db.getRunWithPayload(runId);
  if (!fresh || fresh.status !== 'running') return false;
  db.updateRun(runId, {
    status,
    finished_at: new Date().toISOString(),
    exit_code: code,
    stdout: truncateTail(stdout, config.MAX_LOG_SIZE),
    stderr: truncateTail(stderr, config.MAX_LOG_SIZE),
    error_msg: errorMsg || '',
  });
  if (shouldNotify) {
    // Flagi kanałów ze świeżego odczytu joba — zadanie tła żyje do ASK_MAX_MS,
    // user mógł w tym czasie przełączyć powiadomienia w dashboardzie.
    const freshJob = db.getJob(jobId);
    if (freshJob) notifyAskOutcome(freshJob, status, { stdout, stderr, errorMsg });
  }
  return true;
}

// Pełny cykl życia zapytania. Wołający (server.js, Unit 5) rezerwuje wcześniej lock sync
// + slot tła przez admitRequest; executeAsk je zwalnia (lock przy sync-finished/odczepieniu,
// slot przy domknięciu procesu). Promise NIGDY nie odrzuca — zawsze {detached, status, text, runId}.
// Timeouty wstrzykiwalne dla testów; onSettled to hak testowy wołany po PEŁNYM domknięciu cyklu.
function executeAsk(question, {
  askTimeoutMs = config.ASK_TIMEOUT_MS,
  askMaxMs = config.ASK_MAX_MS,
  askModel = config.ASK_MODEL,
  exitCloseGraceMs = EXIT_CLOSE_GRACE_MS,
  onSettled = null,
} = {}) {
  const job = getOrCreateAskJob();
  // Jedna kopia komunikatu ASK_MAX_MS dla wszystkich ścieżek domknięcia (bezpiecznik,
  // close, exit) — drift kopii rozjechałby treść error_msg/❌ zależnie od zwycięzcy wyścigu.
  const maxMsErrorMsg = `Przekroczony limit ${askMaxMs}ms (ASK_MAX_MS)`;
  const run = db.createRun({ job_id: job.id, trigger_type: 'ask', webhook_payload: question });
  // ask omija kolejkę schedulera — run od razu 'running', żeby UI nie widziało wiszącego 'queued'
  db.updateRun(run.id, { status: 'running', started_at: new Date().toISOString() });
  console.log(`[ask] run #${run.id}: start (${question.length} znaków)`);

  return new Promise((resolve) => {
    let proc;
    try {
      proc = claudeSpawn.spawnClaude([
        '--dangerously-skip-permissions',
        '--output-format', 'text',
        '--model', askModel,
        '-p', buildAskPrompt(question),
      ]);
    } catch (err) {
      // resolveClaudeBin (Windows: brak `claude` w PATH) pada PRZED spawnem —
      // domknij run i oddaj OBIE rezerwacje z admitRequest.
      finalizeAskRun({ runId: run.id, jobId: job.id, status: 'failed', stdout: '', stderr: '', errorMsg: err.message, shouldNotify: false });
      releaseSyncLock();
      releaseBackgroundSlot();
      console.error(`[ask] run #${run.id}: spawn padł — ${err.message}`);
      return resolve({ detached: false, status: 'failed', text: TEXT_SYNC_FAILED, runId: run.id });
    }

    let stdout = '';
    let stderr = '';
    let detached = false;
    let timedOut = false;
    let settled = false; // 'close'/'error'/'exit' mogą przyjść w dowolnej kombinacji — wspólna ścieżka domyka raz
    let exitGraceTimerId = null;

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    // Odczepienie LOGICZNE: proces żyje dalej (bez killa), handler dostaje „robię w tle",
    // lock sync puszczony (kolejne pytania mogą wejść), slot tła trzymany do close.
    const syncTimerId = setTimeout(() => {
      detached = true;
      releaseSyncLock();
      console.log(`[ask] run #${run.id}: odczepiony w tło po ${askTimeoutMs}ms`);
      resolve({ detached: true, status: 'running', text: TEXT_DETACHED, runId: run.id });
    }, askTimeoutMs);

    // Bezpiecznik ASK_MAX_MS liczony OD SPAWNU (prostszy z dwóch wariantów odroczonych
    // w planie — jeden punkt startu zegara, pokryty testem). Finalize już TUTAJ, nie
    // dopiero na close: kill drzewa może zostawić zombie bez zdarzenia close, a status
    // 'timeout' i ❌ muszą wyjść niezależnie od tego („nigdy cisza").
    const maxTimerId = setTimeout(() => {
      timedOut = true;
      console.error(`[ask] run #${run.id}: przekroczony ASK_MAX_MS (${askMaxMs}ms) — ubijam proces`);
      finalizeAskRun({
        runId: run.id,
        jobId: job.id,
        status: 'timeout',
        stdout,
        stderr,
        errorMsg: maxMsErrorMsg,
        shouldNotify: detached,
      });
      killProcessTree(proc);
    }, askMaxMs);

    // Wspólne domknięcie dla close/error: finalize (no-op gdy już domknięty w DB),
    // zwolnienie slotu tła RAZ, odpowiedź sync jeśli jeszcze nie odczepiono.
    const settle = ({ status, code, errorMsg }) => {
      if (settled) return;
      settled = true;
      clearTimeout(syncTimerId);
      clearTimeout(maxTimerId);
      clearTimeout(exitGraceTimerId);
      const wrote = finalizeAskRun({ runId: run.id, jobId: job.id, status, code, stdout, stderr, errorMsg, shouldNotify: detached });
      releaseBackgroundSlot();
      console.log(`[ask] run #${run.id}: koniec (${wrote ? status : 'już domknięty w DB'})`);
      if (!detached) {
        releaseSyncLock();
        const text = status === 'success' ? (stdout.trim() || '(pusta odpowiedź)') : TEXT_SYNC_FAILED;
        resolve({ detached: false, status, text, runId: run.id });
      }
      if (onSettled) onSettled();
    };

    proc.on('close', (code) => {
      const status = timedOut ? 'timeout' : code === 0 ? 'success' : 'failed';
      settle({ status, code, errorMsg: timedOut ? maxMsErrorMsg : '' });
    });

    // Siatka bezpieczeństwa na wypadek, gdy 'close' nie nadejdzie (wnuk trzyma pipe —
    // patrz EXIT_CLOSE_GRACE_MS). 'exit' przychodzi ZAWSZE przy śmierci procesu;
    // karencja daje 'close' pierwszeństwo (pełny stdout), guard `settled` czyni
    // ten timer no-opem w normalnej ścieżce.
    proc.on('exit', (code) => {
      if (settled) return;
      exitGraceTimerId = setTimeout(() => {
        const status = timedOut ? 'timeout' : code === 0 ? 'success' : 'failed';
        settle({ status, code, errorMsg: timedOut ? maxMsErrorMsg : '' });
      }, exitCloseGraceMs);
      exitGraceTimerId.unref();
    });

    proc.on('error', (err) => {
      settle({ status: 'failed', code: null, errorMsg: err.message });
    });
  });
}

module.exports = {
  ASK_JOB_NAME,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  MAX_BACKGROUND_SLOTS,
  TEXT_RATE_LIMIT,
  TEXT_SYNC_BUSY,
  TEXT_SLOTS_FULL,
  verifySecret,
  admitRequest,
  releaseSyncLock,
  releaseBackgroundSlot,
  resetAskState,
  getOrCreateAskJob,
  TEXT_DETACHED,
  TEXT_SYNC_FAILED,
  executeAsk,
};
