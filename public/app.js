// === State ===
let allJobs = [];
let allSkills = [];
let jobsMap = {}; // id -> job
let expandedRuns = new Set(); // track expanded run details
let currentEnv = 'local'; // 'local' or 'vps'
let vpsConfigured = false;
let webhookBaseUrl = ''; // public URL for webhook links (from VPS env)

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
function switchEnv(env) {
  currentEnv = env;
  document.querySelectorAll('.env-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.env === env);
  });
  document.body.dataset.env = env;
  expandedRuns.clear();
  loadSkills();
  loadJobs();
  loadStatus();
  loadRuns();
}

// === Tabs ===
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

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

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

  if (freq === 'hours') {
    intervalSel.innerHTML = [1,2,3,4,6,8,12].map(n => `<option value="${n}">Co ${n} godz.</option>`).join('');
  } else if (freq === 'minutes') {
    intervalSel.innerHTML = [5,10,15,20,30,45].map(n => `<option value="${n}">Co ${n} min</option>`).join('');
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
    return;
  }
  preview.textContent = cronToHuman(cron);
  preview.style.color = 'var(--cyan)';
}

// === Load data ===
async function loadStatus() {
  try {
    const status = await API.get('/api/status');
    document.getElementById('stat-jobs').textContent = `${status.enabled_jobs}/${status.total_jobs}`;
    document.getElementById('stat-queue').textContent = status.queue_length;
    document.getElementById('stat-uptime').textContent = formatUptime(status.uptime);

    // Kill bar
    const killBar = document.getElementById('kill-bar');
    if (status.current_run) {
      killBar.classList.add('show');
      const job = jobsMap[status.current_run.job_id];
      document.getElementById('kill-job-name').textContent = job ? job.name : `Job #${status.current_run.job_id}`;
    } else {
      killBar.classList.remove('show');
    }
  } catch { /* silent */ }
}

async function loadJobs() {
  try {
    allJobs = await API.get('/api/jobs');
    jobsMap = {};
    allJobs.forEach(j => jobsMap[j.id] = j);
    renderJobs();
  } catch (e) {
    toast('Błąd ładowania jobów', true);
  }
}

async function loadRuns() {
  try {
    const runs = await API.get('/api/runs?limit=100');
    renderRuns(runs);
  } catch (e) {
    toast('Błąd ładowania historii', true);
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
function renderJobs() {
  const body = document.getElementById('jobs-body');
  const empty = document.getElementById('jobs-empty');

  if (allJobs.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  body.innerHTML = allJobs.map(j => {
    const hasCron = !!j.cron_expr;
    const hasWebhook = !!j.webhook_token;
    const triggerIcons = (hasCron ? '⏰' : '') + (hasWebhook ? '🔗' : '');
    return `
    <tr>
      <td><strong>${triggerIcons ? triggerIcons + ' ' : ''}${esc(j.name)}</strong></td>
      <td>${j.skill_name
        ? `<code>/${esc(j.skill_name)}</code>`
        : j.arguments && j.arguments.length > 60
          ? `<code class="prompt-truncated" onclick="showPromptPopup(jobsMap[${j.id}].arguments)">${esc(truncate(j.arguments, 60))}</code>`
          : `<code>${esc(j.arguments || 'prompt')}</code>`
      }</td>
      <td>${j.cron_expr ? esc(cronToHuman(j.cron_expr)) : '<span style="color:var(--cyan)">tylko webhook</span>'}</td>
      <td>
        ${j.enabled && j.next_run
          ? `<span class="next-run">${formatDateTime(j.next_run)}</span><br><span class="countdown">${formatCountdown(j.next_run)}</span>`
          : '<span style="color:var(--text-dim)">—</span>'}
      </td>
      <td>
        <span class="badge ${j.enabled ? 'badge-enabled' : 'badge-disabled'}">
          ${j.enabled ? 'WŁ.' : 'WYŁ.'}
        </span>
      </td>
      <td>
        <div class="btn-group">
          <button class="btn btn-small btn-primary" onclick="triggerJob(${j.id})" title="Run now">▶</button>
          <button class="btn btn-small ${j.enabled ? 'btn-toggle-on' : 'btn-toggle-off'}" onclick="toggleJob(${j.id})" title="${j.enabled ? 'Disable' : 'Enable'}">${j.enabled ? '⏻' : '⏻'}</button>
          <button class="btn btn-small" onclick="openEditModal(${j.id})" title="Edit">✎</button>
          <button class="btn btn-small btn-danger" onclick="deleteJob(${j.id})" title="Delete">✕</button>
        </div>
      </td>
    </tr>
  `}).join('');
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
    const badgeClass = `badge-${r.status}`;
    const isExpanded = expandedRuns.has(r.id);
    return `
      <tr class="clickable" onclick="toggleRunDetail(${r.id})">
        <td>#${r.id}</td>
        <td>${job ? esc(job.name) : `Job #${r.job_id}`}</td>
        <td><span class="badge ${badgeClass}">${r.status.toUpperCase()}</span></td>
        <td><span class="badge ${r.trigger_type === 'webhook' ? 'badge-webhook' : ''}">${esc(r.trigger_type.toUpperCase())}</span></td>
        <td>${formatDateTime(r.started_at)}</td>
        <td>${formatDuration(r.started_at, r.finished_at)}</td>
      </tr>
      <tr class="run-detail${isExpanded ? ' show' : ''}" id="run-detail-${r.id}">
        <td colspan="6">
          ${r.error_msg ? `<div class="log-label">ERROR</div><div class="log-box" style="color:var(--red)">${esc(r.error_msg)}</div>` : ''}
          ${r.stdout ? `<div class="log-label">OUTPUT</div><div class="log-box">${esc(formatClaudeOutput(r.stdout))}</div>` : ''}
          ${r.stderr ? `<div class="log-label">STDERR</div><div class="log-box" style="color:var(--red)">${esc(r.stderr)}</div>` : ''}
          ${!r.stdout && !r.stderr && !r.error_msg ? '<div style="color:var(--text-dim);font-size:11px">Brak outputu</div>' : ''}
        </td>
      </tr>
    `;
  }).join('');
}

let currentSkillFilter = 'all';

function renderSkills() {
  const grid = document.getElementById('skills-grid');
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
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  // Note: all values are escaped via esc() before insertion — safe from XSS
  const sourceLabels = { project: '📁 PROJECT', user: '👤 USER', plugin: '🔌 PLUGIN' };
  grid.innerHTML = filtered.map(s => `
    <div class="skill-card">
      <div class="source-badge source-${esc(s.source)}">${sourceLabels[s.source] || esc(s.source)}${s.plugin ? ' · ' + esc(s.plugin) : ''}</div>
      <div class="name">/${esc(s.dir_name)}</div>
      <div class="desc">${esc(s.description)}</div>
    </div>
  `).join('');
}

function filterSkills(filter) {
  currentSkillFilter = filter;
  document.querySelectorAll('.skill-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderSkills();
}

function toggleRunDetail(id) {
  const el = document.getElementById(`run-detail-${id}`);
  if (el) {
    el.classList.toggle('show');
    if (el.classList.contains('show')) {
      expandedRuns.add(id);
    } else {
      expandedRuns.delete(id);
    }
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

async function killCurrent() {
  try {
    await API.post('/api/runs/current/kill');
    toast('Sygnał zatrzymania wysłany');
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
  document.getElementById('form-timeout').value = '600000';
  document.getElementById('form-retries').value = '1';
  document.getElementById('form-wake').checked = false;
  document.getElementById('form-discord').checked = false;
  updateWebhookUI(null);
  document.getElementById('webhook-section').style.display = 'none'; // hide for new jobs
  onFreqChange();
  populateSkillSelect();
  showModal();
}

function openEditModal(id) {
  const job = jobsMap[id];
  if (!job) return;
  document.getElementById('modal-title').textContent = 'EDYTUJ JOB';
  document.getElementById('form-id').value = job.id;
  document.getElementById('form-name').value = job.name;
  document.getElementById('form-args').value = job.arguments || '';
  document.getElementById('form-timeout').value = job.timeout_ms;
  document.getElementById('form-retries').value = job.max_retries;
  document.getElementById('form-wake').checked = !!job.run_on_wake;
  document.getElementById('form-discord').checked = !!job.discord_notify;
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
  document.getElementById('modal-overlay').classList.add('show');
}

function hideModal() {
  document.getElementById('modal-overlay').classList.remove('show');
}

function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay')) hideModal();
}

async function saveJob(e) {
  e.preventDefault();
  const id = document.getElementById('form-id').value;
  const body = {
    name: document.getElementById('form-name').value,
    skill_name: document.getElementById('form-skill').value,
    cron_expr: buildCronFromForm(),
    arguments: document.getElementById('form-args').value,
    timeout_ms: parseInt(document.getElementById('form-timeout').value, 10),
    max_retries: parseInt(document.getElementById('form-retries').value, 10),
    run_on_wake: document.getElementById('form-wake').checked,
    discord_notify: document.getElementById('form-discord').checked,
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

// === Escape HTML ===
function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = String(str);
  return el.innerHTML;
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
function poll() {
  loadStatus();
  // Refresh active tab data
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab === 'jobs') loadJobs();
  if (activeTab === 'history') loadRuns();
}

// === Init ===
async function init() {
  // Check if VPS is configured
  try {
    const env = await fetch('/api/env').then(r => r.json());
    vpsConfigured = env.vps_configured;
    webhookBaseUrl = env.webhook_base_url || '';
    if (vpsConfigured) {
      document.getElementById('env-toggle').style.display = '';
      // Fetch VPS webhook_base_url
      try {
        const vpsEnv = await fetch('/api/vps/env').then(r => r.json());
        if (vpsEnv.webhook_base_url) webhookBaseUrl = vpsEnv.webhook_base_url;
      } catch { /* VPS may be unreachable */ }
    }
  } catch { /* local only */ }

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
