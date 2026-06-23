// Czyste helpery renderu (testowalne bez DOM).
// Dual-export: CommonJS (node:test) + global (root.RenderHelpers) dla <script>.
// Wzorzec jak enum-map.js — brak bundlera, więc to najprostszy sposób
// współdzielenia testowalnej logiki między Node a przeglądarką.
(function (root) {
  const SPARK_WINDOW = 7;
  const OK_STATUSES = new Set(['success']);

  // Podpis payloadu dla guardu poll().
  // KANON §decyzje: MUSI zawierać statusy (nie tylko length + id[0]),
  // inaczej zmiana statusu istniejącego runu nie wywoła re-renderu.
  function pollSignature(runs, status) {
    const list = Array.isArray(runs) ? runs : [];
    const runsSig = list.map((r) => `${r.id}:${r.status}`).join(',');
    const s = status || {};
    const statusSig = [
      s.enabled_jobs,
      s.total_jobs,
      s.queue_length,
      s.today_success,
      s.today_failed,
      s.next ? s.next.next_run : '',
      s.current_run ? s.current_run.id : '',
    ].join('|');
    return `${list.length}#${runsSig}#${statusSig}`;
  }

  // Podpis dla guardu renderJobs() — zmiana joba (enabled/next_run/nazwa/typ) re-renderuje.
  function jobsSignature(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    return list
      .map((j) => `${j.id}:${j.enabled ? 1 : 0}:${j.next_run || ''}:${j.cron_expr || ''}:${j.webhook_token ? 1 : 0}`)
      .join(',');
  }

  // Buduje dane sparkline (7 słupków) z listy recent runs danego joba.
  // Wejście: runy posortowane najnowszy-pierwszy (jak /api/runs/recent: id DESC per job).
  // Wyjście: tablica do SPARK_WINDOW elementów { ok } w porządku chronologicznym
  // (najstarszy → najnowszy), bo sparkline rysuje się od lewej.
  function buildSparkData(jobRuns) {
    const list = Array.isArray(jobRuns) ? jobRuns : [];
    const window = list.slice(0, SPARK_WINDOW);
    return window
      .map((r) => ({ ok: OK_STATUSES.has(r.status) }))
      .reverse();
  }

  // Grupuje płaską listę recent runs po job_id, zachowując kolejność (id DESC).
  function groupRecentByJob(recentRuns) {
    const list = Array.isArray(recentRuns) ? recentRuns : [];
    const map = {};
    for (const r of list) {
      if (!map[r.job_id]) map[r.job_id] = [];
      map[r.job_id].push(r);
    }
    return map;
  }

  const api = { pollSignature, jobsSignature, buildSparkData, groupRecentByJob, SPARK_WINDOW };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RenderHelpers = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
