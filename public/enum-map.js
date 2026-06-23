// Moduł mapowania enumów (kanon §4.0).
// Dual-export: CommonJS (module.exports) dla node:test + global (root.EnumMap)
// dla <script> w przeglądarce. Brak bundlera — to najprostszy sposób
// współdzielenia testowalnego kodu między Node a browserem.
//
// UWAGA: pill „Rutynowe" to flaga joba (jobsMap[run.job_id].routine), NIE trigger.
// Ten moduł celowo NIE mapuje routine — render dokłada pill osobno.
(function (root) {
  const STATUS_MAP = {
    success: { cls: 'badge-ok', label: 'Sukces' },
    failed: { cls: 'badge-err', label: 'Błąd' },
    timeout: { cls: 'badge-timeout', label: 'Timeout' },
    killed: { cls: 'badge-stop', label: 'Zatrzymany' },
    running: { cls: 'badge-run', label: 'Działa' },
    queued: { cls: 'badge-run', label: 'W kolejce' },
  };

  const STATUS_FALLBACK = { cls: 'badge-err', label: 'Nieznany' };

  const TRIGGER_MAP = {
    scheduled: { ico: '◷', label: 'Harmonogram' },
    manual: { ico: '⚇', label: 'Ręcznie' },
    webhook: { ico: '⬡', label: 'Webhook' },
    retry: { ico: '◷', label: 'Harmonogram' },
  };

  const TRIGGER_FALLBACK = { ico: '◷', label: 'Harmonogram' };

  function mapStatus(status) {
    return STATUS_MAP[status] || STATUS_FALLBACK;
  }

  function mapTrigger(trigger) {
    return TRIGGER_MAP[trigger] || TRIGGER_FALLBACK;
  }

  const api = { mapStatus, mapTrigger };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.EnumMap = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
