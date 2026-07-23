// Testy czystych helperów auto-reply (MVP autonomii):
// kontrakt NO_ANSWER, prompt, format odpowiedzi i linii historii.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPrompt, formatHistoryLine, formatReplyContent, parseAnswer } from './auto-reply.mjs';

test('parseAnswer: normalna odpowiedź przechodzi (happy path)', () => {
  assert.equal(parseAnswer('Faza 2 done, zostaje copywriting.\n'), 'Faza 2 done, zostaje copywriting.');
});

test('parseAnswer: NO_ANSWER, prefiks NO_ANSWER i pusto → null (error case)', () => {
  assert.equal(parseAnswer('NO_ANSWER'), null);
  assert.equal(parseAnswer('  NO_ANSWER\n'), null);
  assert.equal(parseAnswer('NO_ANSWER — nie znalazłem nic w vaultcie'), null);
  assert.equal(parseAnswer(''), null);
  assert.equal(parseAnswer(undefined), null);
});

test('buildPrompt: zawiera pytanie, kontrakt NO_ANSWER i ogranicza do vaulta', () => {
  const p = buildPrompt({ fromUser: 'kacper', toUser: 'marcin', title: 'Status LP?', content: 'Landing gotowy?' });
  assert.ok(p.includes('Status LP?'));
  assert.ok(p.includes('Landing gotowy?'));
  assert.ok(p.includes('NO_ANSWER'));
  assert.ok(p.includes('WYŁĄCZNIE na podstawie treści plików'));
});

test('buildPrompt: bez content nie zostawia pustej linii Treść (error case)', () => {
  const p = buildPrompt({ fromUser: 'kacper', toUser: 'marcin', title: 'Status LP?', content: null });
  assert.ok(!p.includes('Treść:'));
});

test('formatReplyContent: taguje odpowiedź jako auto-odpowiedź asystenta', () => {
  const c = formatReplyContent('Odpowiedź.');
  assert.ok(c.startsWith('🤖 auto-odpowiedź asystenta:'));
  assert.ok(c.endsWith('Odpowiedź.'));
});

test('formatHistoryLine: odpowiedź spłaszczona i ucięta do 160 znaków', () => {
  const line = formatHistoryLine({ date: new Date('2026-07-23T14:05:00'), toUser: 'kacper', title: 'Status LP?', answer: 'a\nb '.repeat(100) });
  assert.ok(line.includes('do @kacper'));
  assert.ok(line.includes('**Status LP?**'));
  assert.ok(!line.includes('\n'));
  assert.ok(line.includes('…'));
});

test('formatHistoryLine: NO_ANSWER logowane jako pozostawione człowiekowi (error case)', () => {
  const line = formatHistoryLine({ date: new Date('2026-07-23T14:05:00'), toUser: 'kacper', title: 'Status LP?', answer: null });
  assert.ok(line.includes('NO_ANSWER, zostaje dla człowieka'));
});
