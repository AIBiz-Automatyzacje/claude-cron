// === State ===
let allJobs = [];
let allSkills = [];
let allMembers = []; // członkowie skrzynki z /api/inbox/members (tokeny ZAWSZE zamaskowane)
let allRuns = []; // historia z /api/runs (może być filtrowana przez hide_routine)
let calendarRuns = []; // runy do kropek kalendarza — NIGDY filtrowane przez hide_routine (osobne od historii)
let jobsMap = {}; // id -> job
let recentByJob = {}; // job_id -> [recent runs] z /api/runs/recent (sparkline + ostatni run)
let expandedRuns = new Set(); // track expanded run details
// Logi runów dociągane leniwie z /api/runs/:id (lista wozi same metadane). id -> pełny run.
let runLogCache = new Map();
let currentEnv = 'local'; // 'local' or 'vps'
let vpsConfigured = false;
let webhookBaseUrl = ''; // public URL for webhook links (from VPS env)
// Czy DANA instancja jest hubem skrzynki (`is_inbox_hub` z /api/env) — osobno dla lokalnej
// i dla VPS-a, bo zakładkę Zespół pokazujemy dla tej, na którą patrzy przełącznik.
// Świadomie NIE `webhookBaseUrl`: hub musi mieć Funnel, ale członek z własnymi webhookami
// też go ma — kierunek `INBOX_HUB_URL` rozstrzyga to jednoznacznie (patrz lib/inbox-hub.js).
let localIsInboxHub = false;
let vpsIsInboxHub = false;
let maintenanceWindow = null; // { startHour, startMin, endHour, endMin } z /api/env — okno restartu VPS (R5)

// Guard poll() — tanie podpisy payloadu, pomijamy innerHTML gdy bez zmian.
let lastRunsSig = null;
let lastJobsSig = null;
let lastMembersSig = null;
let lastKillBarSig = null; // podpis SZKIELETU kill-bara (id + nazwa runu, bez czasu trwania)
let lastStatus = {}; // ostatni payload /api/status (część podpisu poll historii)

const { mapStatus, mapTrigger } = EnumMap;
const { pollSignature, jobsSignature, buildSparkData, groupRecentByJob } = RenderHelpers;
const { computeWeekOccurrences, startOfWeek } = RenderHelpers;
const { overlapsMaintenanceWindow } = RenderHelpers;
const { validateMemberName, memberRowData } = RenderHelpers;
const { runningRunsFrom, activeRunRows, activeRunsSignature } = RenderHelpers;

let zadaniaView = 'lista'; // 'lista' | 'kalendarz'

// UI pokazuje timeouty w minutach (czytelniej niż ms), baza/executor trzymają ms.
const MS_PER_MIN = 60000;
const msToMin = (ms) => Math.max(1, Math.round(ms / MS_PER_MIN));
const minToMs = (min) => Math.max(1, parseInt(min, 10) || 0) * MS_PER_MIN;

// === API ===
function apiBase() {
  return currentEnv === 'vps' ? '/api/vps' : '/api';
}

const API = {
  async get(url) {
    const res = await fetch(url.replace('/api/', apiBase() + '/'));
    return res.json();
  },
  async post(url, body) {
    const res = await fetch(url.replace('/api/', apiBase() + '/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },
  async put(url, body) {
    const res = await fetch(url.replace('/api/', apiBase() + '/'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },
  async del(url) {
    const res = await fetch(url.replace('/api/', apiBase() + '/'), { method: 'DELETE' });
    return res.json();
  },
};

// === Environment switching ===
async function switchEnv(env) {
  if (env === currentEnv) return; // bez zbędnego reloadu po kliknięciu aktywnego
  currentEnv = env;
  document.querySelectorAll('.env-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.env === env);
  });
  document.body.dataset.env = env;
  applyTabVisibility(); // Zespół istnieje tylko po stronie huba — przed pobraniem danych
  document.body.classList.add('env-loading'); // dim + spinner; stare dane zostają do nadejścia nowych
  expandedRuns.clear();
  runLogCache.clear(); // te same id runów po drugiej stronie = inne logi
  lastJobsSig = null; // wymuś re-render po zmianie env (te same ID, inne dane)
  lastRunsSig = null;
  lastMembersSig = null;
  lastKillBarSig = null; // te same id runów po drugiej stronie znaczą inne zadania
  try {
    await Promise.allSettled([loadSkills(), loadJobs(), loadStatus(), loadRuns(), loadMembers()]);
  } finally {
    document.body.classList.remove('env-loading');
  }
}

// === Tabs ===
// data-tab: jobs|history|skills|team → sekcje .view#view-${tab} (demo CSS).
function activateTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  const view = document.getElementById(`view-${name}`);
  if (!btn || !view) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  btn.classList.add('active');
  view.classList.add('active');
  // Zespół ładuje się leniwie — dopiero przy pierwszym wejściu w zakładkę (nie w init).
  if (name === 'team') loadMembers();
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

// Widoczność zakładek zależy od tego, czy OGLĄDANA instancja jest hubem skrzynki,
// a nie od pozycji przełącznika — dashboard otwarty wprost na hubie przez Tailscale
// działa w trybie `local` i musi pokazywać Zespół. Wołane po każdej zmianie źródła
// danych: init i switchEnv.
function applyTabVisibility() {
  const hubConfigured = currentEnv === 'vps' ? vpsIsInboxHub : localIsInboxHub;
  document.querySelectorAll('.tab').forEach(btn => {
    btn.hidden = !RenderHelpers.isTabAvailable(btn.dataset.tab, { hubConfigured });
  });
  const active = document.querySelector('.tab.active');
  const next = RenderHelpers.resolveVisibleTab(active ? active.dataset.tab : null, { hubConfigured });
  if (!active || active.dataset.tab !== next) activateTab(next);
}

// === Modal: segment typu zadania (Skill/Skrypt) ===
document.querySelectorAll('#job-type-seg .seg-opt').forEach(btn => {
  btn.addEventListener('click', () => selectJobType(btn.dataset.jobType));
});

// === Modal: accordion "Opcje zaawansowane" ===
const accordionBtn = document.getElementById('accordion');
if (accordionBtn) {
  accordionBtn.addEventListener('click', () => {
    accordionBtn.classList.toggle('open');
    document.getElementById('accordion-body').classList.toggle('hidden');
  });
}

// === Toast ===
function toast(msg, isError = false) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// === Format helpers ===
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start, end) {
  if (!start || !end) return '-';
  const ms = new Date(end + (end.endsWith('Z') ? '' : 'Z')) - new Date(start + (start.endsWith('Z') ? '' : 'Z'));
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatCountdown(isoStr) {
  if (!isoStr) return '';
  const diff = new Date(isoStr) - new Date();
  if (diff <= 0) return 'now';
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

const DAY_NAMES = { '0': 'niedziela', '1': 'poniedziałek', '2': 'wtorek', '3': 'środa', '4': 'czwartek', '5': 'piątek', '6': 'sobota' };

function cronToHuman(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

  if (dom === '*' && mon === '*' && dow === '*' && !min.startsWith('*/') && !hour.startsWith('*/')) {
    return `Codziennie o ${time}`;
  }
  if (dom === '*' && mon === '*' && dow === '1-5') {
    return `Dni robocze o ${time}`;
  }
  if (dom === '*' && mon === '*' && dow !== '*' && !dow.includes('-') && !dow.includes(',')) {
    return `${(DAY_NAMES[dow] || dow).charAt(0).toUpperCase() + (DAY_NAMES[dow] || dow).slice(1)} o ${time}`;
  }
  if (hour.startsWith('*/')) return `Co ${hour.slice(2)} godz.`;
  if (min.startsWith('*/')) return `Co ${min.slice(2)} min`;
  return expr;
}

// === Schedule builder ===

function onFreqChange() {
  const freq = document.getElementById('form-freq').value;
  const timeGroup = document.getElementById('time-group');
  const dayGroup = document.getElementById('day-group');
  const intervalGroup = document.getElementById('interval-group');
  const intervalSel = document.getElementById('form-interval');

  const isWebhookOnly = freq === 'webhook_only';
  timeGroup.style.display = (freq === 'hours' || freq === 'minutes' || isWebhookOnly) ? 'none' : 'block';
  dayGroup.style.display = freq === 'weekly' ? 'block' : 'none';
  intervalGroup.style.display = (freq === 'hours' || freq === 'minutes') ? 'block' : 'none';

  const intervalLabel = document.getElementById('interval-label');
  if (freq === 'hours') {
    intervalLabel.textContent = 'CO ILE GODZIN';
    intervalSel.max = 23;
    if (!intervalSel.value || intervalSel.value < 1) intervalSel.value = 1;
  } else if (freq === 'minutes') {
    intervalLabel.textContent = 'CO ILE MINUT';
    intervalSel.max = 59;
    if (!intervalSel.value || intervalSel.value < 1) intervalSel.value = 1;
  }
  updateSchedulePreview();
}

function buildCronFromForm() {
  const freq = document.getElementById('form-freq').value;
  const time = document.getElementById('form-time').value || '09:00';
  const [hh, mm] = time.split(':').map(Number);
  const day = document.getElementById('form-day').value;
  const interval = document.getElementById('form-interval').value;

  switch (freq) {
    case 'daily':    return `${mm} ${hh} * * *`;
    case 'weekdays': return `${mm} ${hh} * * 1-5`;
    case 'weekly':   return `${mm} ${hh} * * ${day}`;
    case 'hours':    return `0 */${interval} * * *`;
    case 'minutes':  return `*/${interval} * * * *`;
    case 'webhook_only': return '';
    default:         return `${mm} ${hh} * * *`;
  }
}

function parseCronToForm(expr) {
  if (!expr || !expr.trim()) {
    document.getElementById('form-freq').value = 'webhook_only';
    onFreqChange();
    return;
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return;
  const [min, hour, , , dow] = parts;

  const freqEl = document.getElementById('form-freq');
  const timeEl = document.getElementById('form-time');
  const dayEl = document.getElementById('form-day');
  const intervalEl = document.getElementById('form-interval');

  if (min.startsWith('*/')) {
    freqEl.value = 'minutes';
    onFreqChange();
    intervalEl.value = min.slice(2);
  } else if (hour.startsWith('*/')) {
    freqEl.value = 'hours';
    onFreqChange();
    intervalEl.value = hour.slice(2);
  } else if (dow === '1-5') {
    freqEl.value = 'weekdays';
    timeEl.value = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    onFreqChange();
  } else if (dow !== '*') {
    freqEl.value = 'weekly';
    timeEl.value = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    onFreqChange();
    dayEl.value = dow;
  } else {
    freqEl.value = 'daily';
    timeEl.value = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    onFreqChange();
  }
  updateSchedulePreview();
}

function updateSchedulePreview() {
  const cron = buildCronFromForm();
  const preview = document.getElementById('schedule-preview');
  if (!cron) {
    preview.textContent = 'Tylko webhook (bez harmonogramu)';
    preview.style.color = 'var(--cyan)';
    updateMaintenanceWarning(cron);
    return;
  }
  preview.textContent = cronToHuman(cron);
  preview.style.color = 'var(--cyan)';
  updateMaintenanceWarning(cron);
}

// Pokaż/ukryj ostrzeżenie o pokryciu z oknem restartu VPS (R5).
function updateMaintenanceWarning(cron) {
  const warning = document.getElementById('maintenance-warning');
  if (!warning) return;
  warning.hidden = !overlapsMaintenanceWindow(cron, maintenanceWindow);
}

// === Load data ===
async function loadStatus() {
  try {
    const status = await API.get('/api/status');
    lastStatus = status;
    renderStatbar(status);
    renderKillBar(status);
  } catch { /* silent — statbar degraduje cicho */ }
}

// Kill-bar: WSZYSTKIE biegnące runy, po jednym wierszu z własnym „Zatrzymaj" (R2/R6).
// Dwa tempa aktualizacji, świadomie rozdzielone: szkielet wierszy (innerHTML) tylko gdy
// zmieni się zbiór runów — guard podpisu; czas trwania (tyka co sekundę) dopisujemy przez
// textContent na istniejących węzłach. Bez tego rozdziału pasek przebudowywałby się co 3 s
// i migotał, a bez drugiej ścieżki czas stałby w miejscu do końca runu.
function renderKillBar(status) {
  const bar = document.getElementById('kill-bar');
  if (!bar) return;
  const rows = activeRunRows(runningRunsFrom(status), jobsMap, Date.now());
  const sig = activeRunsSignature(rows);

  if (sig !== lastKillBarSig) {
    lastKillBarSig = sig;
    bar.classList.toggle('show', rows.length > 0);
    document.getElementById('kill-count').textContent = `${rows.length} ${plJobs(rows.length)}`;
    document.getElementById('kill-rows').innerHTML = rows.map(r => `
      <div class="kill-row">
        <span class="job-name">${esc(r.name)}</span>
        <span class="kill-dur" id="kill-dur-${r.id}">${esc(r.elapsed)}</span>
        <button class="kill-btn" onclick="killRun(${r.id})" aria-label="Zatrzymaj ${escAttr(r.name)}">■ Zatrzymaj</button>
      </div>`).join('');
    return; // czas trwania jest już w świeżo wstawionym HTML
  }

  for (const r of rows) {
    const durEl = document.getElementById(`kill-dur-${r.id}`);
    if (durEl) durEl.textContent = r.elapsed;
  }
}

// Statbar: Następne / Aktywne / Dziś+health / Kolejka / Uptime.
// Nowe pola muszą tolerować brak danych (fallback next:null, success/failed:0).
function renderStatbar(status) {
  const next = status.next || null;
  const nextName = document.getElementById('stat-next-name');
  const nextEta = document.getElementById('stat-next-eta');
  if (next && next.job_name) {
    nextName.textContent = next.job_name;
    nextEta.textContent = next.next_run ? formatCountdown(next.next_run) : '';
  } else {
    nextName.textContent = '—';
    nextEta.textContent = '';
  }

  document.getElementById('stat-jobs').textContent = `${status.enabled_jobs ?? 0}/${status.total_jobs ?? 0}`;
  document.getElementById('stat-queue').textContent = status.queue_length ?? 0;
  document.getElementById('stat-uptime').textContent = formatUptime(status.uptime || 0);

  const ok = status.today_success ?? 0;
  const failed = status.today_failed ?? 0;
  document.getElementById('stat-today-ok').textContent = ok;
  const errEl = document.getElementById('stat-today-err');
  errEl.textContent = failed;
  errEl.classList.toggle('zero', failed === 0);

  // Health bar — proporcja sukcesów do błędów (flex). Brak runów → pełna zieleń.
  const health = document.getElementById('stat-health');
  const total = ok + failed;
  const okFlex = total === 0 ? 1 : ok;
  const errFlex = total === 0 ? 0 : failed;
  health.innerHTML =
    `<i style="flex:${okFlex};background:var(--green)"></i>` +
    `<i style="flex:${errFlex};background:var(--red)"></i>`;
}

async function loadJobs() {
  try {
    allJobs = await API.get('/api/jobs');
    jobsMap = {};
    allJobs.forEach(j => jobsMap[j.id] = j);
    await loadRecentRuns();
    renderJobs();
  } catch (e) {
    toast('Błąd ładowania jobów', true);
  }
}

// Sparkline + "ostatni run" — preferuj jeden fetch /api/runs/recent?per_job=7.
// Fallback: pusta mapa (render pokazuje '—'), reszta UI działa dalej.
async function loadRecentRuns() {
  try {
    const recent = await API.get('/api/runs/recent?per_job=7');
    recentByJob = groupRecentByJob(recent);
  } catch {
    recentByJob = {};
  }
}

async function loadRuns() {
  try {
    const hideRoutine = document.getElementById('runs-hide-routine')?.checked ? '&hide_routine=1' : '';
    const runs = await API.get(`/api/runs?limit=100${hideRoutine}&fields=meta`);
    // Odpowiedź błędu ({error:…} z proxy/serwera) nie jest tablicą — pokaż JEJ treść.
    // Gołe „Błąd ładowania historii" po TypeError z .map() kosztowało godzinę diagnozy.
    if (!Array.isArray(runs)) throw new Error(runs?.error || 'nieoczekiwana odpowiedź API');
    allRuns = runs;
    lastRunsSig = pollSignature(allRuns, lastStatus); // sync guard po jawnym odświeżeniu
    renderRuns(allRuns);
  } catch (e) {
    toast(`Błąd ładowania historii: ${e.message}`, true);
  }
}

// Runy do kropek kalendarza — osobne źródło od historii.
// NIE doklejamy hide_routine: kalendarz musi widzieć status WSZYSTKICH enabled jobów
// (w tym rutynowych), niezależnie od filtra historii. Degraduje cicho do pustej listy.
async function loadCalendarRuns() {
  try {
    // fields=meta: kropki potrzebują tylko statusów i dat.
    const runs = await API.get('/api/runs?limit=100&fields=meta');
    calendarRuns = Array.isArray(runs) ? runs : [];
  } catch {
    calendarRuns = [];
  }
}

async function loadSkills() {
  try {
    allSkills = await API.get('/api/skills');
    renderSkills();
  } catch (e) {
    toast('Błąd ładowania skilli', true);
  }
}

// === Render ===
// Pill typu: /skill → tag-skill (mono, akcent); skrypt/prompt → tag-type (uppercase).
function jobTypePill(j) {
  if (j.job_type === 'script') return '<span class="task-tag tag-type">skrypt</span>';
  if (j.skill_name) return `<span class="task-tag tag-skill">/${esc(j.skill_name)}</span>`;
  return '<span class="task-tag tag-type">prompt</span>';
}

// Sparkline 7 RUN z recentByJob (chronologicznie, kolor wg statusu).
function sparklineHtml(jobId) {
  const spark = buildSparkData(recentByJob[jobId]);
  if (spark.length === 0) return '<span class="cell-mute">—</span>';
  return `<div class="spark">${spark.map(s =>
    `<i style="height:${s.ok ? 16 : 11}px;background:${s.ok ? 'var(--green)' : 'var(--red)'}"></i>`
  ).join('')}</div>`;
}

function renderJobs() {
  // Podpis = joby (enabled/next/cron/webhook) + recent runs (sparkline/ostatni run).
  // Bez recent w podpisie zakończony run nie odświeżyłby sparkline/kropki.
  const recentSig = Object.keys(recentByJob)
    .map(id => `${id}:${(recentByJob[id][0] || {}).id || ''}:${(recentByJob[id][0] || {}).status || ''}`)
    .join(',');
  const sig = jobsSignature(allJobs) + '||' + recentSig;
  if (sig === lastJobsSig) return; // guard — pomiń re-render gdy bez zmian
  lastJobsSig = sig;

  const body = document.getElementById('jobs-body');
  const empty = document.getElementById('jobs-empty');

  if (allJobs.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  body.innerHTML = allJobs.map(j => {
    const ico = j.job_type === 'script' ? '›_' : '◷';
    const sched = j.cron_expr ? esc(cronToHuman(j.cron_expr)) : '<span class="cell-mute">tylko webhook</span>';
    return `
    <div class="trow grid-zadania ${j.enabled ? '' : 'disabled'}">
      <div class="task-cell">
        <span class="task-ico">${ico}</span>
        <span><span class="task-name">${esc(j.name)}</span>${jobTypePill(j)}</span>
      </div>
      <div class="cell-dim">${sched}</div>
      <div>${sparklineHtml(j.id)}</div>
      <div>
        <label class="switch">
          <input type="checkbox" ${j.enabled ? 'checked' : ''} onchange="toggleJob(${j.id})" aria-label="Przełącz ${esc(j.name)}" />
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
      <div class="actions">
        <button class="act-btn run" onclick="triggerJob(${j.id})" title="Uruchom" aria-label="Uruchom ${esc(j.name)}">▶</button>
        <button class="act-btn" onclick="toggleJob(${j.id})" title="${j.enabled ? 'Wyłącz' : 'Włącz'}" aria-label="${j.enabled ? 'Wyłącz' : 'Włącz'} ${esc(j.name)}">⏻</button>
        <button class="act-btn" onclick="openEditModal(${j.id})" title="Edytuj" aria-label="Edytuj ${esc(j.name)}">✎</button>
        <button class="act-btn danger" onclick="deleteJob(${j.id})" title="Usuń" aria-label="Usuń ${esc(j.name)}">✕</button>
      </div>
    </div>
  `}).join('');

  // Kalendarz dzieli źródło danych z listą — odśwież gdy aktywny.
  if (zadaniaView === 'kalendarz') renderKalendarz();
}

// === Kalendarz (widok tygodnia, occurrences w JS — R10) ===
const CAL_DOW_LABELS = ['Niedz', 'Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob'];
const CAL_MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

// Kropka 3-stanowa eventu kalendarza: ok=zielony, err=czerwony, idle=szary.
function calDotFor(status) {
  const cls = status === 'ok' ? 'dot-green' : status === 'err' ? 'dot-red' : 'dot-grey';
  return `<span class="dot ${cls}"></span>`;
}

// Zakres tygodnia: "15 – 21 czerwca 2026" (miesiąc/rok z dnia ostatniego — wystarczające dla MVP).
function calRangeLabel(days) {
  const first = days[0].date;
  const last = days[6].date;
  return `${first.getDate()} – ${last.getDate()} ${CAL_MONTHS[last.getMonth()]} ${last.getFullYear()}`;
}

// Widok kalendarza: occurrences enabled jobów w bieżącym tygodniu (occurrences liczone w JS).
// Źródło runów do kropek: calendarRuns (osobne od historii — bez filtra hide_routine).
// Wyłączone i wysokoczęstotliwe joby pominięte w helperze.
function renderKalendarz() {
  const container = document.getElementById('zadania-kalendarz');
  if (!container) return;

  const now = new Date();
  const weekStart = startOfWeek(now);
  const days = computeWeekOccurrences(allJobs, calendarRuns, weekStart, now);

  const nav = `<div class="cal-nav">
    <div class="cal-nav-left">
      <span class="cal-range">${esc(calRangeLabel(days))}</span>
    </div>
  </div>`;

  const week = `<div class="cal-week">${days.map(d => `
    <div class="cal-day ${d.isToday ? 'today' : ''} ${(d.dow === 0 || d.dow === 6) ? 'weekend' : ''}">
      <div class="cal-day-head">
        <span><span class="cal-day-num">${d.num}</span><span class="cal-day-dow">${CAL_DOW_LABELS[d.dow]}</span></span>
        ${d.isToday ? '<span class="cal-today-badge">dziś</span>' : ''}
      </div>
      <div class="cal-events">${d.events.map(e => `
        <div class="cal-event ${e.status === 'ok' ? 'done' : ''}">
          <div class="cal-event-time">${calDotFor(e.status)}${esc(e.time)}</div>
          <div class="cal-event-name">${esc(e.name)}</div>
        </div>`).join('')}</div>
    </div>`).join('')}</div>`;

  container.innerHTML = nav + week;
}

// Przełącznik widoku Zadania: Lista ↔ Kalendarz.
function switchZadaniaView(view) {
  zadaniaView = view;
  const isLista = view === 'lista';
  document.querySelectorAll('#zadania-views .seg-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.zview === view);
  });
  document.getElementById('zadania-lista').classList.toggle('hidden', !isLista);
  document.getElementById('zadania-kalendarz').classList.toggle('hidden', isLista);
  if (!isLista) {
    renderKalendarz(); // render natychmiast z tym co mamy
    loadCalendarRuns().then(renderKalendarz); // dociągnij świeże, niefiltrowane runy i przerysuj kropki
  }
}

// Heurystyka: linia wygląda na błąd? (do podświetlenia w log viewerze)
function isErrorLine(line) {
  return /(?:^|\s)(error|err|exception|failed|fatal|✕|✗)\b/i.test(line) ||
    /\bat\s+\S+\(.*:\d+\)/.test(line); // stack trace frame
}

// Body log viewera: error_msg + sformatowany stdout + stderr, z heurystyką błędu per linia.
function logBodyHtml(r) {
  const blocks = [];
  if (r.error_msg) {
    blocks.push(`<div class="log-line error"><span class="log-ts"></span><span class="log-msg">${esc(r.error_msg)}</span></div>`);
  }
  const out = r.stdout ? formatClaudeOutput(r.stdout) : '';
  if (out) {
    blocks.push(out.split('\n').map(line =>
      `<div class="log-line ${isErrorLine(line) ? 'error' : ''}"><span class="log-ts"></span><span class="log-msg">${esc(line)}</span></div>`
    ).join(''));
  }
  if (r.stderr) {
    blocks.push(r.stderr.split('\n').map(line =>
      `<div class="log-line error"><span class="log-ts"></span><span class="log-msg">${esc(line)}</span></div>`
    ).join(''));
  }
  if (blocks.length === 0) {
    blocks.push('<div class="log-line"><span class="log-ts"></span><span class="log-msg cell-mute">Brak outputu</span></div>');
  }
  return blocks.join('');
}

// Stan logboxa zanim log dojedzie z /api/runs/:id — z rozmiarem z metadanych listy.
function logPlaceholderHtml(r) {
  const bytes = (r.stdout_bytes || 0) + (r.stderr_bytes || 0);
  const size = bytes > 0 ? ` (${(bytes / 1024).toFixed(1)} KB)` : '';
  return `<div class="log-line"><span class="log-ts"></span><span class="log-msg cell-mute">Ładowanie logu…${size}</span></div>`;
}

function renderRuns(runs) {
  const body = document.getElementById('runs-body');
  const empty = document.getElementById('runs-empty');

  if (runs.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  body.innerHTML = runs.map(r => {
    const job = jobsMap[r.job_id];
    const st = mapStatus(r.status);
    const tr = mapTrigger(r.trigger_type);
    const isRoutine = job && job.routine;
    const isExpanded = expandedRuns.has(r.id);
    const name = job ? esc(job.name) : `Job #${r.job_id}`;
    const dur = formatDuration(r.started_at, r.finished_at);
    return `
      <div class="hrow grid-historia err${isExpanded ? ' open' : ''}" onclick="toggleRunDetail(${r.id})">
        <div class="h-name">
          <span class="h-caret" aria-hidden="true">›</span>
          <span class="h-body"><span class="h-title">${name}</span>${isRoutine ? '<span class="task-tag tag-type">Rutynowe</span>' : ''}</span>
        </div>
        <div><span class="badge ${st.cls}">${st.label}</span></div>
        <div class="cell-dim">${formatDateTime(r.started_at)}</div>
        <div class="cell-dim">${dur}</div>
      </div>
      <div class="run-detail${isExpanded ? ' show' : ''}" id="run-detail-${r.id}">
        <div class="run-detail-cell">
          <div class="logbox${isExpanded ? '' : ' hidden'}">
            <div class="log-head">
              <span class="log-title"><span class="log-id">#${r.id}</span> · ${name} · <span class="${r.status === 'success' ? '' : 'exit-bad'}">${esc(st.label)}</span> · <span class="log-dur">${dur}</span> · <span class="log-trigger">${tr.ico} ${tr.label}</span></span>
              <span class="log-actions">
                <button class="log-act" data-act="copy" onclick="logAction(event, ${r.id}, 'copy')">Kopiuj</button>
                <button class="log-act" data-act="wrap" onclick="logAction(event, ${r.id}, 'wrap')">Zawijaj</button>
                <button class="log-act" data-act="full" onclick="logAction(event, ${r.id}, 'full')">Pełny ekran</button>
              </span>
            </div>
            <div class="log-body" id="log-body-${r.id}">${runLogCache.has(r.id) ? logBodyHtml(runLogCache.get(r.id)) : logPlaceholderHtml(r)}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Re-render (poll co 3 s) odtwarza logbox z cache — dociągnij log dla otwartych wierszy:
  // dla zakończonych to no-op z cache, dla biegnących odświeża rosnący output.
  runs.filter(r => expandedRuns.has(r.id)).forEach(r => loadRunLog(r.id));
}

// Akcje log viewera (Kopiuj / Zawijaj / Pełny ekran). Nie propaguje na toggle wiersza.
function logAction(e, runId, act) {
  e.stopPropagation();
  const btn = e.currentTarget;
  const box = btn.closest('.logbox');
  if (!box) return;
  if (act === 'wrap') {
    box.querySelectorAll('.log-line').forEach(l => l.classList.toggle('nowrap'));
  } else if (act === 'full') {
    box.classList.toggle('logbox-full');
  } else if (act === 'copy') {
    const text = box.querySelector('.log-body')?.innerText || '';
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
    btn.textContent = 'Skopiowano ✓';
    setTimeout(() => { btn.textContent = 'Kopiuj'; }, 1200);
  }
}

let currentSkillFilter = 'all';

// Mapowanie source (API) → klasa/label type-badge (CSS demo: type-projekt/user/plugin).
const SKILL_TYPE_META = {
  project: { cls: 'type-projekt', label: 'PROJEKT' },
  user: { cls: 'type-user', label: 'USER' },
  plugin: { cls: 'type-plugin', label: 'PLUGIN' },
};

// Polska odmiana "zadanie/zadania/zadań".
function plJobs(n) {
  if (n === 1) return 'zadanie';
  if (n >= 2 && n <= 4) return 'zadania';
  return 'zadań';
}

// Liczba jobów używających danego skilla (skill_name === dir_name).
function countJobsForSkill(dirName) {
  return allJobs.filter(j => j.skill_name === dirName).length;
}

// Meta pojedynczego skilla: badge typu + label źródła (z fallbackiem dla nieznanego source).
function skillTypeMeta(s) {
  return SKILL_TYPE_META[s.source] || { cls: 'type-plugin', label: esc(s.source).toUpperCase() };
}

function renderSkills() {
  const kafelki = document.getElementById('skille-kafelki');
  const lista = document.getElementById('skille-lista');
  const empty = document.getElementById('skills-empty');

  // Update counts
  const counts = { all: allSkills.length, project: 0, user: 0, plugin: 0 };
  allSkills.forEach(s => { if (counts[s.source] !== undefined) counts[s.source]++; });
  document.getElementById('count-all').textContent = counts.all;
  document.getElementById('count-project').textContent = counts.project;
  document.getElementById('count-user').textContent = counts.user;
  document.getElementById('count-plugin').textContent = counts.plugin;

  const filtered = currentSkillFilter === 'all'
    ? allSkills
    : allSkills.filter(s => s.source === currentSkillFilter);

  if (filtered.length === 0) {
    kafelki.innerHTML = '';
    lista.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  kafelki.innerHTML = renderSkillsKafelki(filtered);
  lista.innerHTML = renderSkillsLista(filtered);
}

// Widok Kafelki: karta na skill (nazwa, badge typu, opis, stopka z liczbą zadań).
// Note: all values are escaped via esc() before insertion — safe from XSS
function renderSkillsKafelki(skills) {
  const cards = skills.map(s => {
    const meta = skillTypeMeta(s);
    const n = countJobsForSkill(s.dir_name);
    const foot = n > 0
      ? `<div class="skill-foot"><span class="dot dot-amber"></span>${n} ${plJobs(n)}</div>`
      : '<div class="skill-foot unused"><span class="dot dot-grey"></span>nieużywany</div>';
    return `
    <div class="skill-card">
      <div class="skill-card-head">
        <span class="skill-name">/${esc(s.dir_name)}</span>
        <span class="type-badge ${meta.cls}">${meta.label}${s.plugin ? ' · ' + esc(s.plugin) : ''}</span>
      </div>
      <div class="skill-desc">${esc(s.description)}</div>
      ${foot}
    </div>
  `;
  }).join('');
  return `<div class="skille-grid">${cards}</div>`;
}

// Widok Lista: tabela skilli (kolumny SKILL / TYP / ZADANIA).
// Note: all values are escaped via esc() before insertion — safe from XSS
function renderSkillsLista(skills) {
  const head = '<div class="thead grid-skille-lista"><div>SKILL</div><div>TYP</div><div>ZADANIA</div></div>';
  const rows = skills.map(s => {
    const meta = skillTypeMeta(s);
    const n = countJobsForSkill(s.dir_name);
    const tasks = n > 0
      ? `<div class="s-tasks"><span class="dot dot-amber"></span>${n} ${plJobs(n)}</div>`
      : '<div class="s-tasks unused"><span class="dot dot-grey"></span>nieużywany</div>';
    return `<div class="srow grid-skille-lista">
      <div><div class="s-name">/${esc(s.dir_name)}</div><div class="s-desc">${esc(s.description)}</div></div>
      <div><span class="type-badge ${meta.cls}">${meta.label}${s.plugin ? ' · ' + esc(s.plugin) : ''}</span></div>
      <div>${tasks}</div>
    </div>`;
  }).join('');
  return `<div class="table">${head}${rows}</div>`;
}

function filterSkills(filter) {
  currentSkillFilter = filter;
  document.querySelectorAll('.skill-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderSkills();
}

// Przełącznik widoku skilli: Kafelki ↔ Lista.
function switchSkillView(view) {
  const isKafelki = view === 'kafelki';
  document.querySelectorAll('#skille-views .seg-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sview === view);
  });
  document.getElementById('skille-kafelki').classList.toggle('hidden', !isKafelki);
  document.getElementById('skille-lista').classList.toggle('hidden', isKafelki);
}

function toggleRunDetail(id) {
  const el = document.getElementById(`run-detail-${id}`);
  if (!el) return;
  el.classList.toggle('show');
  const box = el.querySelector('.logbox');
  const isShown = el.classList.contains('show');
  if (box) box.classList.toggle('hidden', !isShown);
  // Strzałka rozwijania siedzi w wierszu (poprzednim rodzeństwie), nie w szczególe
  const row = el.previousElementSibling;
  if (row && row.classList.contains('hrow')) row.classList.toggle('open', isShown);
  if (isShown) {
    expandedRuns.add(id);
    loadRunLog(id);
  } else {
    expandedRuns.delete(id);
  }
}

// Log konkretnego runu — jedyne miejsce, które ciągnie ciężki payload.
// Cache w pamięci: ponowne rozwinięcie zakończonego runu nie strzela drugim requestem.
// Run w toku omija cache (log rośnie), a jego wynik i tak nadpisuje wpis.
async function loadRunLog(id) {
  const meta = allRuns.find(r => r.id === id);
  const isLive = !meta || meta.status === 'running' || meta.status === 'queued';
  if (runLogCache.has(id) && !isLive) return;
  try {
    const run = await API.get(`/api/runs/${id}`);
    if (!run || run.error) throw new Error(run?.error || 'brak danych');
    runLogCache.set(id, run);
    const body = document.getElementById(`log-body-${id}`);
    if (body) body.innerHTML = logBodyHtml(run);
  } catch (e) {
    const body = document.getElementById(`log-body-${id}`);
    if (body) body.innerHTML = `<div class="log-line error"><span class="log-ts"></span><span class="log-msg">Błąd pobierania logu: ${esc(e.message)}</span></div>`;
  }
}

// === Actions ===
async function triggerJob(id) {
  try {
    await API.post(`/api/jobs/${id}/trigger`);
    toast('Job uruchomiony!');
    loadStatus();
    loadRuns();
  } catch {
    toast('Błąd uruchamiania joba', true);
  }
}

async function toggleJob(id) {
  try {
    const result = await API.post(`/api/jobs/${id}/toggle`);
    toast(result.enabled ? 'Job włączony' : 'Job wyłączony');
    loadJobs();
  } catch {
    toast('Błąd przełączania joba', true);
  }
}

async function deleteJob(id) {
  if (!confirm('Usunąć ten job?')) return;
  try {
    await API.del(`/api/jobs/${id}`);
    toast('Job usunięty');
    loadJobs();
  } catch {
    toast('Błąd usuwania joba', true);
  }
}

// Kill KONKRETNEGO runu (R6) — nigdy „bieżącego", bo przy równoległości nie ma jednego
// bieżącego. Po odpowiedzi NIE zgadujemy stanu lokalnie: świeży /api/status rozstrzyga,
// które runy jeszcze biegną (learned pattern: decyduj na świeżym odczycie).
async function killRun(runId) {
  try {
    const res = await API.post(`/api/runs/${runId}/kill`);
    toast(res && res.killed ? 'Sygnał zatrzymania wysłany' : 'Ten run już nie biegnie');
    loadStatus();
  } catch {
    toast('Błąd zatrzymywania', true);
  }
}

// === Modal ===
function openCreateModal() {
  document.getElementById('modal-title').textContent = 'NOWY JOB';
  document.getElementById('form-id').value = '';
  document.getElementById('form-name').value = '';
  document.getElementById('form-skill').value = '';
  document.getElementById('form-freq').value = 'daily';
  document.getElementById('form-time').value = '09:00';
  document.getElementById('form-args').value = '';
  document.getElementById('form-timeout').value = '10';
  document.getElementById('form-idle-timeout').value = '5';
  document.getElementById('form-retries').value = '1';
  document.getElementById('form-lock-group').value = '';
  document.getElementById('form-wake').checked = true;
  document.getElementById('form-discord').checked = false;
  document.getElementById('form-telegram').checked = false;
  document.getElementById('form-routine').checked = false;
  document.getElementById('form-job-type').value = 'claude';
  document.getElementById('form-command').value = '';
  onJobTypeChange();
  updateWebhookUI(null);
  document.getElementById('webhook-section').style.display = 'none'; // hide for new jobs
  onFreqChange();
  populateSkillSelect();
  showModal();
}

function onJobTypeChange() {
  const type = document.getElementById('form-job-type').value;
  const isScript = type === 'script';
  document.getElementById('skill-group').style.display = isScript ? 'none' : '';
  document.getElementById('args-group').style.display = isScript ? 'none' : '';
  document.getElementById('command-group').style.display = isScript ? '' : 'none';
  syncJobTypeSegment(type);
}

// Segment binarny Skill/Skrypt → zapisuje do #form-job-type i odświeża pola warunkowe.
function syncJobTypeSegment(type) {
  document.querySelectorAll('#job-type-seg .seg-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.jobType === type);
  });
}

function selectJobType(type) {
  document.getElementById('form-job-type').value = type;
  onJobTypeChange();
}

function openEditModal(id) {
  const job = jobsMap[id];
  if (!job) return;
  document.getElementById('modal-title').textContent = 'EDYTUJ JOB';
  document.getElementById('form-id').value = job.id;
  document.getElementById('form-name').value = job.name;
  document.getElementById('form-args').value = job.arguments || '';
  document.getElementById('form-timeout').value = msToMin(job.timeout_ms);
  document.getElementById('form-idle-timeout').value = msToMin(job.idle_timeout_ms ?? 300000);
  document.getElementById('form-retries').value = job.max_retries;
  document.getElementById('form-lock-group').value = job.lock_group || '';
  document.getElementById('form-wake').checked = !!job.run_on_wake;
  document.getElementById('form-discord').checked = !!job.discord_notify;
  document.getElementById('form-telegram').checked = !!job.telegram_notify;
  document.getElementById('form-routine').checked = !!job.routine;
  document.getElementById('form-job-type').value = job.job_type || 'claude';
  document.getElementById('form-command').value = job.command || '';
  onJobTypeChange();
  document.getElementById('webhook-section').style.display = 'block';
  updateWebhookUI(job.webhook_token);
  populateSkillSelect(job.skill_name);
  parseCronToForm(job.cron_expr);
  showModal();
}

function populateSkillSelect(selected) {
  const sel = document.getElementById('form-skill');
  const groups = { project: [], user: [], plugin: [] };
  allSkills.forEach(s => { if (groups[s.source]) groups[s.source].push(s); });

  const groupLabels = { project: '📁 Project', user: '👤 User', plugin: '🔌 Plugin' };
  let html = '<option value="">-- wybierz skill --</option>';
  for (const [source, skills] of Object.entries(groups)) {
    if (skills.length === 0) continue;
    html += `<optgroup label="${groupLabels[source] || source}">`;
    html += skills.map(s => `<option value="${esc(s.dir_name)}" ${s.dir_name === selected ? 'selected' : ''}>${esc(s.dir_name)}</option>`).join('');
    html += '</optgroup>';
  }
  sel.innerHTML = html;
}

function showModal() {
  document.getElementById('modal-overlay').hidden = false;
}

function hideModal() {
  document.getElementById('modal-overlay').hidden = true;
}

function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay')) hideModal();
}

async function saveJob(e) {
  e.preventDefault();
  const id = document.getElementById('form-id').value;
  const jobType = document.getElementById('form-job-type').value;
  // Pusta grupa = null (brak wyłączności), nie pusty string — `''` byłoby kolejną
  // wartością znaczącą to samo w kolumnie, a przy edycji musi CZYŚCIĆ starą grupę.
  const lockGroup = document.getElementById('form-lock-group').value.trim();
  const body = {
    name: document.getElementById('form-name').value,
    job_type: jobType,
    skill_name: jobType === 'script' ? '' : document.getElementById('form-skill').value,
    command: jobType === 'script' ? document.getElementById('form-command').value : null,
    cron_expr: buildCronFromForm(),
    arguments: jobType === 'script' ? '' : document.getElementById('form-args').value,
    timeout_ms: minToMs(document.getElementById('form-timeout').value),
    idle_timeout_ms: minToMs(document.getElementById('form-idle-timeout').value),
    max_retries: parseInt(document.getElementById('form-retries').value, 10),
    run_on_wake: document.getElementById('form-wake').checked,
    discord_notify: document.getElementById('form-discord').checked,
    telegram_notify: document.getElementById('form-telegram').checked,
    routine: document.getElementById('form-routine').checked,
    lock_group: lockGroup || null,
  };

  try {
    if (id) {
      await API.put(`/api/jobs/${id}`, body);
      toast('Job zaktualizowany');
    } else {
      await API.post('/api/jobs', body);
      toast('Job utworzony!');
    }
    hideModal();
    loadJobs();
  } catch {
    toast('Błąd zapisu joba', true);
  }
}

// === Modal: Ustawienia powiadomień ===
// Celowo goły fetch zamiast API.get/put: modal konfiguruje ZAWSZE lokalny state,
// niezależnie od przełącznika LOKALNY/VPS — na VPS konfiguracja trafia wyłącznie
// server-side pushem (R10: pełne sekrety nigdy nie przechodzą przez przeglądarkę).

const NOTIFY_FIELD_IDS = {
  discord_webhook_url: 'notify-discord-url',
  telegram_bot_token: 'notify-telegram-token',
  telegram_chat_id: 'notify-telegram-chat',
};

const NOTIFY_CHANNEL_KEYS = {
  discord: ['discord_webhook_url'],
  telegram: ['telegram_bot_token', 'telegram_chat_id'],
};

// Mapowanie reason z {ok:false, reason} (lib/notify-push.js) → czytelny komunikat.
const PUSH_REASON_MESSAGES = {
  vps_not_configured: 'VPS nie jest skonfigurowany (brak CLAUDE_CRON_VPS_URL)',
  nothing_to_push: 'Brak konfiguracji do wysłania — najpierw zapisz ustawienia',
  invalid_vps_url: 'Nieprawidłowy adres VPS w konfiguracji',
  endpoint_missing: 'VPS ma starszą wersję Puls — zaktualizuje się nocą (02:00), spróbuj potem',
  timeout: 'VPS nie odpowiada (timeout)',
  confirm_mismatch: 'VPS nie potwierdził zapisu — spróbuj ponownie',
};

function pushReasonMessage(reason) {
  return PUSH_REASON_MESSAGES[reason] || `Wysyłka na VPS nie powiodła się (${reason || 'nieznany błąd'})`;
}

// Placeholder pokazuje zamaskowany stan (GET nigdy nie zwraca pełnych sekretów),
// pola startują puste — puste pole przy zapisie = nie nadpisuj.
function notifyPlaceholder(maskedValue) {
  return maskedValue ? `skonfigurowano (${maskedValue})` : 'nie skonfigurowano';
}

async function refreshNotifyModal() {
  const res = await fetch('/api/settings/notifications');
  if (!res.ok) throw new Error(`GET settings ${res.status}`);
  const s = await res.json();
  const placeholders = {
    'notify-discord-url': notifyPlaceholder(s.discord.masked),
    'notify-telegram-token': notifyPlaceholder(s.telegram.masked_token),
    'notify-telegram-chat': notifyPlaceholder(s.telegram.chat_id),
  };
  for (const [id, text] of Object.entries(placeholders)) {
    const input = document.getElementById(id);
    input.placeholder = text;
    input.value = '';
  }
}

async function openNotifyModal() {
  try {
    await refreshNotifyModal();
  } catch {
    toast('Błąd pobierania ustawień powiadomień', true);
    return;
  }
  document.getElementById('notify-push-vps').style.display = vpsConfigured ? '' : 'none';
  document.getElementById('notify-modal-overlay').hidden = false;
}

function hideNotifyModal() {
  document.getElementById('notify-modal-overlay').hidden = true;
}

function closeNotifyModal(e) {
  if (e.target === document.getElementById('notify-modal-overlay')) hideNotifyModal();
}

async function putNotifySettings(body) {
  const res = await fetch('/api/settings/notifications', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT settings ${res.status}`);
}

async function saveNotifySettings(e) {
  e.preventDefault();
  // Tylko wypełnione pola trafiają do PUT — puste = zostaw obecną wartość.
  const updates = {};
  for (const [key, id] of Object.entries(NOTIFY_FIELD_IDS)) {
    const value = document.getElementById(id).value.trim();
    if (value !== '') updates[key] = value;
  }
  if (Object.keys(updates).length === 0) {
    toast('Nic do zapisania — wszystkie pola puste');
    return;
  }
  try {
    await putNotifySettings(updates);
    toast('Ustawienia powiadomień zapisane');
    hideNotifyModal();
  } catch {
    toast('Błąd zapisu ustawień powiadomień', true);
  }
}

async function clearNotifyChannel(channel) {
  // Pusty string czyści klucz w state (fallback env wraca do gry) — semantyka PUT z Unit 2.
  const body = {};
  for (const key of NOTIFY_CHANNEL_KEYS[channel]) body[key] = '';
  try {
    await putNotifySettings(body);
    toast(channel === 'discord' ? 'Wyczyszczono konfigurację Discord' : 'Wyczyszczono konfigurację Telegram');
    await refreshNotifyModal(); // modal zostaje otwarty, placeholdery od razu odzwierciedlają stan
  } catch {
    toast('Błąd czyszczenia konfiguracji', true);
  }
}

async function pushNotifyToVps() {
  const btn = document.getElementById('notify-push-vps');
  btn.disabled = true;
  try {
    const res = await fetch('/api/settings/notifications/push-to-vps', { method: 'POST' });
    // Stary/obcy serwer może zwrócić nie-JSON (np. HTML 404) — nie wywalaj UI.
    let result;
    try {
      result = await res.json();
    } catch {
      result = { ok: false, reason: `http_${res.status}` };
    }
    if (result.ok) {
      toast('Konfiguracja powiadomień wysłana na VPS');
    } else {
      toast(pushReasonMessage(result.reason), true);
    }
  } catch {
    toast('Błąd sieci przy wysyłce na VPS', true);
  } finally {
    btn.disabled = false;
  }
}

// === Modal: Ile zadań naraz (limit równoległości) ===
// Świadomie przez API.get/API.put (apiBase), inaczej niż modal powiadomień: limit jest
// własnością MASZYNY, która odpala agentów, więc konfiguruje się tę instancję, na którą
// patrzy przełącznik LOKALNY/VPS. Zero sekretów w tym endpoincie — sama liczba.

async function openConcurrencyModal() {
  try {
    const settings = await API.get('/api/settings/concurrency');
    document.getElementById('concurrency-max').value = settings.max_concurrent ?? '';
  } catch {
    toast('Błąd pobierania limitu równoległości', true);
    return;
  }
  clearConcurrencyError();
  document.getElementById('concurrency-modal-overlay').hidden = false;
}

function hideConcurrencyModal() {
  document.getElementById('concurrency-modal-overlay').hidden = true;
}

function closeConcurrencyModal(e) {
  if (e.target === document.getElementById('concurrency-modal-overlay')) hideConcurrencyModal();
}

function showConcurrencyError(msg) {
  const el = document.getElementById('concurrency-error');
  el.textContent = msg;
  el.hidden = false;
}

function clearConcurrencyError() {
  const el = document.getElementById('concurrency-error');
  el.textContent = '';
  el.hidden = true;
}

async function saveConcurrency(e) {
  e.preventDefault();
  const value = document.getElementById('concurrency-max').value.trim();
  try {
    // Walidację zakresu robi serwer (sanitizeMaxConcurrent) — druga kopia progu w UI
    // rozjechałaby się z nim przy pierwszej zmianie sufitu.
    const res = await API.put('/api/settings/concurrency', { max_concurrent: value });
    if (res && res.error) { showConcurrencyError(res.error); return; }
    clearConcurrencyError();
    toast(`Limit zapisany: ${res.max_concurrent} ${plJobs(res.max_concurrent)} naraz`);
    hideConcurrencyModal();
  } catch {
    showConcurrencyError('Błąd zapisu limitu — spróbuj ponownie.');
  }
}

// === Zespół (Team OS Hub) — członkowie skrzynki ===
// Widok operuje na /api/inbox/members huba przez apiBase() (respektuje przełącznik
// LOKALNY/VPS — na VPS idzie przez proxy /api/vps/*). Tokeny na liście ZAWSZE
// zamaskowane (token_masked z GET); pełny token + kod zaproszenia żyją WYŁĄCZNIE
// w polu modala kodu, czyszczonym przy zamknięciu — zero w długożyjącym stanie.

// Podpis listy członków dla guardu re-renderu. Wiersz jest niemutowalny (imię/token/data),
// więc zmieni się tylko przy dodaniu/unieważnieniu — wystarczy zbiór id + maska + długość.
function membersSig(members) {
  const list = Array.isArray(members) ? members : [];
  return list.map((m) => `${m.id}:${m.token_masked}`).join(',') + '#' + list.length;
}

async function loadMembers() {
  try {
    const members = await API.get('/api/inbox/members');
    allMembers = Array.isArray(members) ? members : []; // {error} → pusta lista, empty state
    renderMembers();
  } catch {
    toast('Błąd ładowania członków zespołu', true);
  }
}

function renderMembers() {
  const sig = membersSig(allMembers);
  if (sig === lastMembersSig) return; // guard — pomiń re-render gdy bez zmian
  lastMembersSig = sig;

  const body = document.getElementById('members-body');
  const empty = document.getElementById('members-empty');

  if (allMembers.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  body.innerHTML = allMembers.map((m) => {
    const row = memberRowData(m);
    return `
    <div class="trow grid-zespol">
      <div class="task-cell">
        <span class="task-ico">@</span>
        <span><span class="task-name">${esc(row.name)}</span></span>
      </div>
      <div><span class="token-mask">${esc(row.tokenMasked)}</span></div>
      <div class="cell-dim">${row.createdAt ? formatDateTime(row.createdAt) : '—'}</div>
      <div class="actions">
        <button class="act-btn danger" onclick="revokeMember(${row.id})" title="Unieważnij dostęp" aria-label="Unieważnij dostęp ${escAttr(row.name)}">✕</button>
      </div>
    </div>
  `;
  }).join('');
}

// Status-aware POST — API.post gubi kod odpowiedzi, a tu MUSIMY rozróżnić 201/409/503.
// Respektuje przełącznik LOKALNY/VPS przez apiBase() (jak reszta widoków).
async function postMember(name) {
  const res = await fetch(`${apiBase()}/inbox/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function openAddMemberModal() {
  document.getElementById('team-name').value = '';
  clearTeamAddError();
  document.getElementById('team-add-modal-overlay').hidden = false;
  setTimeout(() => document.getElementById('team-name').focus(), 0);
}

function hideTeamAddModal() {
  document.getElementById('team-add-modal-overlay').hidden = true;
}

function closeTeamAddModal(e) {
  if (e.target === document.getElementById('team-add-modal-overlay')) hideTeamAddModal();
}

function showTeamAddError(msg) {
  const err = document.getElementById('team-add-error');
  err.textContent = msg;
  err.hidden = false;
}

function clearTeamAddError() {
  const err = document.getElementById('team-add-error');
  err.textContent = '';
  err.hidden = true;
}

async function submitAddMember(e) {
  e.preventDefault();
  const check = validateMemberName(document.getElementById('team-name').value);
  if (!check.valid) { showTeamAddError(check.error); return; }
  clearTeamAddError();
  try {
    const resp = await postMember(check.value);
    if (resp.status === 201) {
      hideTeamAddModal();
      showInviteModal(resp.data);
      loadMembers();
      return;
    }
    if (resp.status === 503) {
      showTeamAddError('Hub nie ma skonfigurowanego Funnela — skonfiguruj Funnel na hubie (VPS), aby generować kody zaproszeń.');
      return;
    }
    if (resp.status === 409) {
      showTeamAddError('Członek o tym imieniu już istnieje — wybierz inne imię.');
      return;
    }
    showTeamAddError(resp.data && resp.data.error ? resp.data.error : 'Nie udało się dodać członka.');
  } catch {
    showTeamAddError('Błąd sieci przy dodawaniu członka.');
  }
}

// Modal kodu zaproszenia — JEDNORAZOWY. Pełny kod (z tokenem) trzymamy TYLKO w polu
// inputu, czyszczonym przy zamknięciu; obiekt odpowiedzi jest lokalny i nie trafia do stanu.
function showInviteModal(data) {
  const forEl = document.getElementById('invite-for');
  forEl.textContent = data && data.name ? `Dla: ${data.name}` : '';
  document.getElementById('invite-code').value = (data && data.invite_code) ? data.invite_code : '';
  document.getElementById('invite-modal-overlay').hidden = false;
}

function hideInviteModal() {
  // Zero pełnych tokenów w długożyjącym stanie — wymaż pole kodu przy zamknięciu.
  document.getElementById('invite-code').value = '';
  document.getElementById('invite-for').textContent = '';
  document.getElementById('invite-modal-overlay').hidden = true;
}

function closeInviteModal(e) {
  if (e.target === document.getElementById('invite-modal-overlay')) hideInviteModal();
}

function copyInviteCode() {
  const code = document.getElementById('invite-code').value;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    toast('Kod zaproszenia skopiowany!');
  }).catch(() => {
    // Fallback dla nie-HTTPS/braku Clipboard API
    const el = document.getElementById('invite-code');
    el.select();
    document.execCommand('copy');
    toast('Kod zaproszenia skopiowany!');
  });
}

async function revokeMember(id) {
  const m = allMembers.find((x) => x.id === id);
  const label = m ? m.name : `#${id}`;
  if (!confirm(`Unieważnić dostęp dla „${label}"? Token przestanie działać natychmiast — tej operacji nie można cofnąć.`)) return;
  try {
    const res = await API.del(`/api/inbox/members/${id}`);
    if (res && res.error) { toast('Nie udało się unieważnić: ' + res.error, true); return; }
    toast('Dostęp unieważniony');
    loadMembers();
  } catch {
    toast('Błąd unieważniania dostępu', true);
  }
}

// === Escape HTML ===
function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = String(str);
  return el.innerHTML;
}

// === Escape HTML attribute (kontekst atrybutu) ===
// esc() (textContent→innerHTML) NIE escapuje cudzysłowów, więc wstawienie
// jego wyniku do atrybutu w podwójnych cudzysłowach pozwala nazwie typu
// `x" onmouseover="…` złamać atrybut i wstrzyknąć handler. W kontekście
// atrybutu dodatkowo escapujemy " i ' (dane mogą przyjść z proxy /api/vps/*).
function escAttr(str) {
  return esc(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// === Truncate ===
function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + '…';
}

// === Prompt popup ===
function showPromptPopup(text) {
  const existing = document.getElementById('prompt-popup-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'prompt-popup-overlay';
  overlay.className = 'prompt-popup-overlay';
  overlay.onclick = () => overlay.remove();

  const box = document.createElement('div');
  box.className = 'prompt-popup';
  box.onclick = (e) => e.stopPropagation();
  box.textContent = text;

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// === Parse Claude stream-json output into readable text ===
function formatToolUse(block) {
  const name = block.name || 'tool';
  const input = block.input || {};
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read':
      return `⚙️ ${name}: ${input.file_path || ''}`;
    case 'Bash':
      return `⚙️ ${(input.description || input.command || name).slice(0, 80)}`;
    case 'Skill':
      return `⚙️ Skill: /${input.skill || ''} ${input.args || ''}`.trim();
    case 'Agent':
      return `⚙️ Agent: ${(input.description || '').slice(0, 80)}`;
    case 'Grep':
    case 'Glob':
      return `⚙️ ${name}: ${input.pattern || ''}`;
    default:
      return `⚙️ ${name}`;
  }
}

function formatClaudeOutput(raw) {
  if (!raw || !raw.trim()) return '';

  const lines = raw.trim().split('\n');
  const parts = [];
  let hasJsonLine = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip non-JSON lines
    }

    hasJsonLine = true;

    if (entry.type === 'assistant' && entry.message?.content) {
      for (const block of entry.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          parts.push(block.text.trim());
        }
        if (block.type === 'tool_use') {
          parts.push(formatToolUse(block));
        }
      }
    }

    if (entry.type === 'result') {
      parts.push('─'.repeat(40));
      const dur = entry.duration_ms ? Math.round(entry.duration_ms / 1000) + 's' : '';
      const cost = entry.cost_usd ? '$' + entry.cost_usd.toFixed(2) : '';
      const tokens = entry.input_tokens && entry.output_tokens
        ? `${entry.input_tokens}→${entry.output_tokens} tokens` : '';
      const meta = [dur, cost, tokens].filter(Boolean).join(' | ');
      parts.push(`✅ DONE${meta ? ' (' + meta + ')' : ''}`);
      if (entry.result) parts.push(entry.result);
    }
  }

  // Fallback: if no JSON lines parsed, return raw text (backward compat)
  if (!hasJsonLine) return raw;

  return parts.length > 0 ? parts.join('\n\n') : raw;
}

// === Webhook ===
function updateWebhookUI(token) {
  const emptyEl = document.getElementById('webhook-empty');
  const activeEl = document.getElementById('webhook-active');
  const urlEl = document.getElementById('webhook-url');

  if (token) {
    emptyEl.style.display = 'none';
    activeEl.style.display = 'block';
    // Use VPS webhook_base_url when in VPS mode, otherwise try local env, fallback to location.origin
    const base = (currentEnv === 'vps' && webhookBaseUrl) ? webhookBaseUrl : (webhookBaseUrl || location.origin);
    urlEl.value = `${base}/webhook/${token}`;
  } else {
    emptyEl.style.display = 'block';
    activeEl.style.display = 'none';
    urlEl.value = '';
  }
}

async function generateWebhook() {
  const id = document.getElementById('form-id').value;
  if (!id) return;
  try {
    const job = await API.post(`/api/jobs/${id}/webhook`);
    updateWebhookUI(job.webhook_token);
    jobsMap[id] = job;
    toast('Webhook wygenerowany!');
    loadJobs();
  } catch {
    toast('Błąd generowania webhooka', true);
  }
}

async function removeWebhook() {
  const id = document.getElementById('form-id').value;
  if (!id) return;
  try {
    const job = await API.del(`/api/jobs/${id}/webhook`);
    updateWebhookUI(null);
    jobsMap[id] = job;
    toast('Webhook usunięty');
    loadJobs();
  } catch {
    toast('Błąd usuwania webhooka', true);
  }
}

function copyWebhookUrl() {
  const url = document.getElementById('webhook-url').value;
  navigator.clipboard.writeText(url).then(() => {
    toast('URL skopiowano!');
  }).catch(() => {
    // Fallback for non-HTTPS
    document.getElementById('webhook-url').select();
    document.execCommand('copy');
    toast('URL skopiowano!');
  });
}

// === Polling ===
// Statbar (loadStatus) odświeża się na KAŻDEJ zakładce co 3s.
// Dane aktywnej zakładki odświeżają się z guardem podpisu (pomiń innerHTML bez zmian),
// expandedRuns przeżywa re-render (renderRuns ponownie nakłada .show z setu).
async function poll() {
  await loadStatus();
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab === 'jobs') {
    loadJobs();
    // Kalendarz ma własne, niefiltrowane źródło runów — odśwież kropki na żywo.
    if (zadaniaView === 'kalendarz') loadCalendarRuns().then(renderKalendarz);
  }
  if (activeTab === 'history') pollRuns();
  // Zespół zmienia się rzadko, ale odświeżamy dla spójności — guard podpisu pomija
  // re-render gdy lista bez zmian (jak reszta zakładek).
  if (activeTab === 'team') loadMembers();
}

// Guard historii: pomiń re-render gdy podpis (length + id + statusy) bez zmian.
async function pollRuns() {
  try {
    const hideRoutine = document.getElementById('runs-hide-routine')?.checked ? '&hide_routine=1' : '';
    const runs = await API.get(`/api/runs?limit=100${hideRoutine}&fields=meta`);
    if (!Array.isArray(runs)) return; // błąd API — poll degraduje cicho, zostają stare dane
    const sig = pollSignature(runs, lastStatus);
    if (sig === lastRunsSig) return;
    lastRunsSig = sig;
    allRuns = runs;
    renderRuns(allRuns);
  } catch { /* silent — historia degraduje cicho */ }
}

// === Init ===
async function init() {
  // Check if VPS is configured
  try {
    const env = await fetch('/api/env').then(r => r.json());
    vpsConfigured = env.vps_configured;
    localIsInboxHub = env.is_inbox_hub === true;
    webhookBaseUrl = env.webhook_base_url || '';
    maintenanceWindow = env.maintenance_window || null;
    if (vpsConfigured) {
      document.getElementById('env-toggle').style.display = '';
      // Fetch VPS webhook_base_url
      try {
        const vpsEnv = await fetch('/api/vps/env').then(r => r.json());
        vpsIsInboxHub = vpsEnv.is_inbox_hub === true;
        if (vpsEnv.webhook_base_url) webhookBaseUrl = vpsEnv.webhook_base_url;
      } catch { /* VPS nieosiągalny — zostaje false, czyli „nie hub" (fail-closed) */ }
    }
  } catch { /* local only */ }
  applyTabVisibility();

  await loadSkills();
  await loadJobs();
  loadStatus();
  loadRuns();

  // Schedule preview updates
  document.getElementById('form-time').addEventListener('change', updateSchedulePreview);
  document.getElementById('form-day').addEventListener('change', updateSchedulePreview);
  document.getElementById('form-interval').addEventListener('change', updateSchedulePreview);

  // Poll every 3s
  setInterval(poll, 3000);
}

init();
