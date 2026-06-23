// Wybiera najbliższy zaplanowany run spośród enabled jobów.
// Czysta logika: przyjmuje getNextRun(jobId) jako zależność (scheduler/croner liczy per job),
// więc jest testowalna ze stubem bez wstawania schedulera.
// Porównanie next_run przez '<' działa na ISO-8601 UTC (toISOString, sufiks 'Z'):
// porządek leksykograficzny = chronologiczny dla stałoznakowego UTC.
function computeNextRun(allJobs, getNextRun) {
  let best = null;
  for (const job of allJobs) {
    if (!job.enabled) continue;
    const nextRun = getNextRun(job.id);
    if (!nextRun) continue;
    if (best === null || nextRun < best.next_run) {
      best = { job_name: job.name, next_run: nextRun };
    }
  }
  return best;
}

module.exports = computeNextRun;
