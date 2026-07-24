// Testy renderingu Skrzynki (redesign 07.2026) + roundtrip z parserem inbox-push:
// wyrenderowany callout po odhaczeniu MUSI być parsowalny (kontrakt id/thread/checkbox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderThreadCallout, renderDelegatedCallout } from './inbox-pull.mjs';
import { parseCheckedCallouts } from './inbox-push.mjs';

const T0 = '2026-07-24T07:12:00.000Z';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function msg(over = {}) {
  return {
    id: ID_A, thread_id: THREAD, from_user: 'marcin', to_user: 'kacper',
    type: 'task', title: 'Baner na live sierpniowy',
    content: 'Potrzebuję baner 1920x1080.', status: 'pending',
    created_at: T0, payload: null, ...over,
  };
}

test('task: awatar, pille, checkbox Zrobione z hintem, marker', () => {
  const m = msg();
  const out = renderThreadCallout([m], m, 'kacper');
  assert.match(out, /^> \[!todo\|fresh\]- Baner na live sierpniowy/);
  assert.ok(out.includes('<span class="os-tag t-new">🆕 nowe</span>'));
  assert.ok(out.includes('<span class="os-tag t-task">📝 zadanie</span>'));
  assert.ok(out.includes('od @marcin'));
  assert.ok(out.includes('<span class="os-av u-marcin">M</span>'));
  assert.match(out, /^> - \[ \] Zrobione /m);
  assert.ok(out.includes(`%% id:${ID_A} thread:${THREAD} %%`));
});

test('delivered (nie-pending): bez badge nowe i bez |fresh', () => {
  const m = msg({ status: 'delivered' });
  const out = renderThreadCallout([m], m, 'kacper');
  assert.match(out, /^> \[!todo\]- /);
  assert.ok(!out.includes('t-new'));
});

test('query ode mnie: kierunek "Ty →", checkbox Zapoznane', () => {
  const q = msg({ type: 'query', from_user: 'kacper', to_user: 'marcin', status: 'delivered' });
  const reply = msg({ id: ID_B, type: 'reply', from_user: 'marcin', to_user: 'kacper', content: 'Realnie piątek.', status: 'delivered' });
  const out = renderThreadCallout([q, reply], reply, 'kacper');
  assert.ok(out.includes('Ty → @marcin'));
  assert.match(out, /^> - \[ \] Zapoznane /m);
  assert.ok(out.includes('/deleguj reply'));
});

test('auto-reply: awatar bota, badge AUTO, prefix zdjęty, źródło jako pill', () => {
  const q = msg({ type: 'query', from_user: 'kacper', to_user: 'marcin', status: 'delivered' });
  const bot = msg({
    id: ID_B, type: 'reply', from_user: 'marcin', to_user: 'kacper', status: 'delivered',
    payload: { auto_reply: true },
    content: '🤖 auto-odpowiedź asystenta:\n\nZasady ustalone 15.06.\n\nŹródło: `Zasoby/Playbooki/moderacja-grup-fb.md`',
  });
  const out = renderThreadCallout([q, bot], bot, 'kacper');
  assert.ok(out.includes('<span class="os-av u-bot">🤖</span>'));
  assert.ok(out.includes('Asystent @marcin'));
  assert.ok(out.includes('<span class="os-auto">AUTO</span>'));
  assert.ok(!out.includes('auto-odpowiedź asystenta'));
  assert.ok(out.includes('<span class="os-src">📄 `Zasoby/Playbooki/moderacja-grup-fb.md`</span>'));
});

test('roundtrip: wyrenderowany i odhaczony callout parsuje się w inbox-push', () => {
  const m = msg();
  const rendered = renderThreadCallout([m], m, 'kacper').replace('> - [ ] Zrobione', '> - [x] Zrobione');
  const parsed = parseCheckedCallouts(rendered);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { id: ID_A, thread_id: THREAD, action: 'Zrobione' });
});

test('delegowane: jeden callout, pill czasu, stale ⚠️, marker thread per wiersz', () => {
  const fresh = msg({ created_at: new Date(Date.now() - 2 * 3600000).toISOString() });
  const stale = msg({ id: ID_B, thread_id: null, to_user: 'filip', created_at: new Date(Date.now() - 72 * 3600000).toISOString() });
  const out = renderDelegatedCallout([fresh, stale]);
  assert.match(out, /^> \[!delegated\]- /);
  assert.ok(out.includes('⏳ czeka 2h'));
  assert.ok(out.includes('os-wait stale'));
  assert.ok(out.includes('⚠️ czeka 3d'));
  assert.ok(out.includes(`%% thread:${THREAD} %%`));
  assert.ok(out.includes(`%% thread:${ID_B} %%`)); // fallback na id gdy brak thread_id
  assert.ok(out.includes('<span class="os-av s u-filip">F</span>'));
});
