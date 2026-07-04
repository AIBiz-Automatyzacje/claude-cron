require('./lib/runtime-guard'); // MUSI być pierwszy: fail-fast na złym Node PRZED require node:sqlite
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PORT, PUBLIC_DIR, VPS_API_URL, WEBHOOK_ENABLED, WEBHOOK_BASE_URL, MAINTENANCE_WINDOW } = require('./lib/config');
const db = require('./lib/db');
const computeNextRun = require('./lib/next-run');
const scheduler = require('./lib/scheduler');
const executor = require('./lib/executor');
const skills = require('./lib/skills');
const platform = require('./lib/platform');
const keepAwake = require('./lib/keep-awake');
const { matchWebhookToken } = require('./lib/webhook');
const { resolveNotifyConfig, buildMaskedNotifySettings, sanitizeNotifySettings } = require('./lib/notify-config');
const { pushNotifySettings, buildPushPayload } = require('./lib/notify-push');

// === MIME types ===
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// === Helpers ===

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function error(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// Duże, stałe assety (logo/favicon) cache'owane 1h. Kod UI (css/js) i HTML: no-cache
// (rewalidacja przez ETag → 304) — dashboard zawsze serwuje świeży front po deployu.
const STATIC_MAX_AGE_S = 3600;
const LONG_CACHE_EXTS = new Set(['.png', '.svg', '.ico']);

function buildEtag(stats) {
  return `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
}

function serveStatic(res, urlPath, reqHeaders = {}) {
  urlPath = urlPath.split('?')[0]; // odetnij query string — inaczej np. style.css?v=1 nie matchuje pliku i leci w SPA fallback
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  filePath = path.normalize(filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    error(res, 'Forbidden', 403);
    return;
  }

  if (!fs.existsSync(filePath)) {
    // SPA fallback
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    error(res, 'Not found', 404);
    return;
  }

  const etag = buildEtag(stats);
  const lastModified = stats.mtime.toUTCString();
  const headers = {
    'Content-Type': mime,
    'Last-Modified': lastModified,
    ETag: etag,
  };
  if (LONG_CACHE_EXTS.has(ext)) {
    headers['Cache-Control'] = `public, max-age=${STATIC_MAX_AGE_S}`;
  } else {
    headers['Cache-Control'] = 'no-cache';
  }

  // Conditional request — odpowiedz 304 bez ponownego wysyłania bajtów.
  if (reqHeaders['if-none-match'] === etag || reqHeaders['if-modified-since'] === lastModified) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  // Asynchroniczny odczyt — nie blokuje event-loopa (ważne dla 1.2 MB logo).
  fs.readFile(filePath, (err, content) => {
    if (err) {
      error(res, 'Not found', 404);
      return;
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}

// === Router ===

function matchRoute(method, url) {
  const [pathPart, queryString] = url.split('?');
  const params = new URLSearchParams(queryString || '');
  const segments = pathPart.split('/').filter(Boolean);

  // Parse path params
  // /api/jobs/:id -> segments = ['api', 'jobs', '123']
  return { method, path: pathPart, segments, params };
}

// === VPS Proxy ===
function proxyToVps(req, res, targetPath) {
  if (!VPS_API_URL) {
    return error(res, 'VPS not configured (set CLAUDE_CRON_VPS_URL)', 503);
  }

  const url = new URL(targetPath, VPS_API_URL);
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  };

  const proxy = http.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    });
  });

  let responded = false;
  proxy.on('error', (err) => {
    if (responded) return;
    responded = true;
    error(res, `VPS unreachable: ${err.message}`, 502);
  });

  proxy.on('timeout', () => {
    if (responded) return;
    responded = true;
    proxy.destroy();
    error(res, 'VPS timeout', 504);
  });

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    let reqBody = '';
    req.on('data', chunk => reqBody += chunk);
    req.on('end', () => proxy.end(reqBody));
  } else {
    proxy.end();
  }
}

async function handleApi(req, res) {
  const { method, path: urlPath, segments, params } = matchRoute(req.method, req.url);

  // GET /api/env — environment info
  if (method === 'GET' && urlPath === '/api/env') {
    return json(res, { vps_configured: !!VPS_API_URL, webhook_base_url: WEBHOOK_BASE_URL, maintenance_window: MAINTENANCE_WINDOW });
  }

  // Proxy /api/vps/* -> VPS instance /api/*
  if (urlPath.startsWith('/api/vps/')) {
    const targetPath = '/api/' + urlPath.slice('/api/vps/'.length);
    const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    return proxyToVps(req, res, targetPath + qs);
  }

  // GET /api/skills
  if (method === 'GET' && urlPath === '/api/skills') {
    return json(res, skills.getAllSkills());
  }

  // POST /api/settings/notifications/push-to-vps — push server-side (R10): serwer czyta
  // PEŁNE wartości z własnego state/env i PUT-uje na VPS; sekrety nie przechodzą przez
  // przeglądarkę, a przycisk w modalu działa też przy pustych polach (GET zwraca maski).
  if (method === 'POST' && urlPath === '/api/settings/notifications/push-to-vps') {
    const config = resolveNotifyConfig(db.getState, process.env);
    const result = await pushNotifySettings({ vpsUrl: VPS_API_URL, settings: buildPushPayload(config) });
    if (result.ok) return json(res, result);
    // Statusy spójne z proxyToVps: brak VPS = 503; reszta padów pusha = 502 (bad gateway)
    const status = result.reason === 'vps_not_configured' ? 503
      : result.reason === 'nothing_to_push' ? 400 : 502;
    return json(res, result, status);
  }

  // GET/PUT /api/settings/notifications — konfiguracja powiadomień w state (env = fallback).
  // Endpoint objęty guardem 403 XFF jak cały dashboard; na VPS dostępny przez proxy /api/vps/*.
  if (urlPath === '/api/settings/notifications') {
    // GET — wyłącznie zamaskowany stan (configured + ostatnie 4 znaki), sekrety nigdy w pełni
    if (method === 'GET') {
      const config = resolveNotifyConfig(db.getState, process.env);
      return json(res, buildMaskedNotifySettings(config));
    }

    // PUT — whitelist trzech kluczy, tylko stringi; pusty string czyści klucz w state
    // (fallback env wraca do gry — czyszczenie nie nadpisuje env pustą wartością)
    if (method === 'PUT') {
      const body = await parseBody(req);
      const check = sanitizeNotifySettings(body);
      if (!check.ok) return error(res, check.error);
      for (const [key, value] of Object.entries(check.updates)) {
        db.setState(key, value);
      }
      const config = resolveNotifyConfig(db.getState, process.env);
      return json(res, buildMaskedNotifySettings(config));
    }
  }

  // GET /api/status
  if (method === 'GET' && urlPath === '/api/status') {
    const currentRun = db.getCurrentRun();
    const queued = db.getQueuedRuns();
    const allJobs = db.getAllJobs();
    const autostart = platform.getStatus();
    const todayStats = db.getTodayRunStats();
    // Statbar pomija joby rutynowe (np. inbox sync co minutę) — nie zdominują "Następne".
    const next = computeNextRun(allJobs.filter(j => !j.routine), scheduler.getNextRun);

    return json(res, {
      uptime: process.uptime(),
      current_run: currentRun,
      queue_length: queued.length,
      total_jobs: allJobs.length,
      enabled_jobs: allJobs.filter(j => j.enabled).length,
      today_success: todayStats.success,
      today_failed: todayStats.failed,
      next,
      autostart,
    });
  }

  // GET /api/jobs
  if (method === 'GET' && urlPath === '/api/jobs') {
    const jobs = db.getAllJobs();
    // Enrich with next_run
    const enriched = jobs.map(j => ({
      ...j,
      next_run: scheduler.getNextRun(j.id),
    }));
    return json(res, enriched);
  }

  // POST /api/jobs
  if (method === 'POST' && urlPath === '/api/jobs') {
    const body = await parseBody(req);
    if (!body.name) {
      return error(res, 'name is required');
    }
    const jobType = body.job_type || 'claude';
    if (jobType === 'script') {
      if (!body.command) return error(res, 'command is required for script jobs');
    } else if (!body.skill_name && !body.arguments) {
      return error(res, 'skill_name or arguments (prompt) is required');
    }
    const job = db.createJob(body);
    scheduler.scheduleJob(job);
    // next_run jak w GET/PUT — bez tego klient musiałby dopytać drugim zapytaniem.
    return json(res, { ...job, next_run: scheduler.getNextRun(job.id) }, 201);
  }

  // Routes with :id — /api/jobs/:id
  if (segments[0] === 'api' && segments[1] === 'jobs' && segments[2]) {
    const id = parseInt(segments[2], 10);
    if (isNaN(id)) return error(res, 'Invalid job ID');

    // POST /api/jobs/:id/trigger
    if (method === 'POST' && segments[3] === 'trigger') {
      const job = db.getJob(id);
      if (!job) return error(res, 'Job not found', 404);
      const run = scheduler.enqueueJob(id, 'manual');
      return json(res, run);
    }

    // POST /api/jobs/:id/webhook — generate/regenerate webhook token
    if (method === 'POST' && segments[3] === 'webhook') {
      const job = db.getJob(id);
      if (!job) return error(res, 'Job not found', 404);
      const token = randomUUID();
      const updated = db.setWebhookToken(id, token);
      return json(res, updated);
    }

    // DELETE /api/jobs/:id/webhook — remove webhook token
    if (method === 'DELETE' && segments[3] === 'webhook') {
      const job = db.getJob(id);
      if (!job) return error(res, 'Job not found', 404);
      const updated = db.clearWebhookToken(id);
      return json(res, updated);
    }

    // POST /api/jobs/:id/toggle
    if (method === 'POST' && segments[3] === 'toggle') {
      const job = db.toggleJob(id);
      if (!job) return error(res, 'Job not found', 404);
      scheduler.scheduleJob(job);
      return json(res, { ...job, next_run: scheduler.getNextRun(job.id) });
    }

    // GET /api/jobs/:id
    if (method === 'GET' && !segments[3]) {
      const job = db.getJob(id);
      if (!job) return error(res, 'Job not found', 404);
      return json(res, { ...job, next_run: scheduler.getNextRun(job.id) });
    }

    // PUT /api/jobs/:id
    if (method === 'PUT' && !segments[3]) {
      const body = await parseBody(req);
      const job = db.updateJob(id, body);
      if (!job) return error(res, 'Job not found', 404);
      scheduler.scheduleJob(job);
      return json(res, { ...job, next_run: scheduler.getNextRun(job.id) });
    }

    // DELETE /api/jobs/:id
    if (method === 'DELETE' && !segments[3]) {
      scheduler.unscheduleJob(id);
      db.deleteJob(id);
      return json(res, { ok: true });
    }
  }

  // GET /api/runs
  if (method === 'GET' && urlPath === '/api/runs') {
    const limit = parseInt(params.get('limit') || '50', 10);
    const offset = parseInt(params.get('offset') || '0', 10);
    const job_id = params.get('job_id') ? parseInt(params.get('job_id'), 10) : undefined;
    const hideRoutine = params.get('hide_routine') === '1';
    return json(res, db.getRuns({ limit, offset, job_id, hideRoutine }));
  }

  // GET /api/runs/current
  if (method === 'GET' && urlPath === '/api/runs/current') {
    return json(res, db.getCurrentRun());
  }

  // POST /api/runs/current/kill
  if (method === 'POST' && urlPath === '/api/runs/current/kill') {
    const killed = executor.killCurrent();
    return json(res, { killed });
  }

  // GET /api/runs/recent?per_job=N — N ostatnich runów per job (sparkline + ostatni run).
  // MUSI być przed ogólnym matcherem segments[1]==='runs' poniżej, inaczej zostanie złapany.
  if (method === 'GET' && urlPath === '/api/runs/recent') {
    const perJob = params.get('per_job');
    return json(res, db.getRecentRunsPerJob(perJob));
  }

  // /api/runs with query params
  if (method === 'GET' && segments[0] === 'api' && segments[1] === 'runs') {
    const limit = parseInt(params.get('limit') || '50', 10);
    const offset = parseInt(params.get('offset') || '0', 10);
    const job_id = params.get('job_id') ? parseInt(params.get('job_id'), 10) : undefined;
    const hideRoutine = params.get('hide_routine') === '1';
    return json(res, db.getRuns({ limit, offset, job_id, hideRoutine }));
  }

  error(res, 'Not found', 404);
}

// === Webhook handler ===

async function handleWebhook(req, res, token) {
  if (!WEBHOOK_ENABLED) {
    return error(res, 'Webhooks disabled', 403);
  }

  if (req.method !== 'POST') {
    return error(res, 'Method not allowed', 405);
  }

  const job = db.getJobByWebhookToken(token);
  if (!job) {
    return error(res, 'Invalid webhook token', 404);
  }

  const body = await parseBody(req);
  const payload = JSON.stringify(body);

  const run = db.createRun({
    job_id: job.id,
    trigger_type: 'webhook',
    webhook_payload: payload,
  });

  scheduler.processQueue();

  console.log(`[webhook] Job "${job.name}" triggered via webhook (run #${run.id})`);
  return json(res, { ok: true, run_id: run.id, job_name: job.name });
}

// === Server ===

const server = http.createServer(async (req, res) => {
  // CORS for dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // Webhook endpoint: /webhook/:token — public, accessible from internet
    const webhookToken = matchWebhookToken(req.url);
    if (webhookToken) {
      return await handleWebhook(req, res, webhookToken);
    }

    // Block non-webhook requests from external sources (Tailscale Funnel)
    // Funnel proxies via 127.0.0.1 but sets X-Forwarded-For header
    // If X-Forwarded-For is present, request came through Funnel = external = block dashboard
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      return error(res, 'Dashboard only accessible via Tailscale', 403);
    }

    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
    } else {
      serveStatic(res, req.url, req.headers);
    }
  } catch (err) {
    console.error('[server] Error:', err);
    error(res, 'Internal server error', 500);
  }
});

// === Start ===

// Init DB (migrate() wykonuje się wewnątrz getDb())
const conn = db.getDb();

// Smoke-test typów: fail-fast gdy node:sqlite zwraca agregaty jako nie-number (R4)
db.assertDbReturnsNumbers(conn);

// Reaper: osierocone runy 'running' z przerwanego procesu → 'killed' (gasi wiszący kill-bar)
const reaped = db.reapOrphanedRuns();
if (reaped > 0) console.log(`[reaper] Oznaczono ${reaped} przerwany(ch) run(ów) jako zatrzymane`);

// Start scheduler
scheduler.start();

server.listen(PORT, () => {
  console.log(`\n🫀  Puls running at http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop\n`);
});

// Prevent Windows sleep (no-op on Mac/Linux)
keepAwake.start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Stopping...');
  keepAwake.stop();
  scheduler.stop();
  db.close();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  keepAwake.stop();
  scheduler.stop();
  db.close();
  server.close(() => process.exit(0));
});
