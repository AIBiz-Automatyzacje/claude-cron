const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mapStatus, mapTrigger } = require('./enum-map');

test('mapStatus(failed) → badge-err / Błąd', () => {
  assert.deepEqual(mapStatus('failed'), { cls: 'badge-err', label: 'Błąd' });
});

test('mapStatus(killed) → badge-stop', () => {
  assert.equal(mapStatus('killed').cls, 'badge-stop');
});

test('mapStatus(queued) → badge-run', () => {
  assert.equal(mapStatus('queued').cls, 'badge-run');
});

test('mapStatus(success) → badge-ok / Sukces', () => {
  assert.deepEqual(mapStatus('success'), { cls: 'badge-ok', label: 'Sukces' });
});

test('mapStatus(timeout) → badge-timeout / Timeout', () => {
  assert.deepEqual(mapStatus('timeout'), { cls: 'badge-timeout', label: 'Timeout' });
});

test('mapStatus(running) → badge-run / Działa', () => {
  assert.deepEqual(mapStatus('running'), { cls: 'badge-run', label: 'Działa' });
});

test('mapStatus(nieznane) → fallback z niepustym cls i label', () => {
  const result = mapStatus('cokolwiek-nieznane');
  assert.notEqual(result.cls, '', 'cls nie może być pusty (nie pusty badge)');
  assert.notEqual(result.label, '', 'label nie może być pusty');
  assert.ok(result.cls.startsWith('badge-'), 'fallback musi mieć klasę badge-*');
});

test('mapTrigger(scheduled) → Harmonogram', () => {
  assert.equal(mapTrigger('scheduled').label, 'Harmonogram');
});

test('mapTrigger(retry) → Harmonogram (fallback)', () => {
  assert.equal(mapTrigger('retry').label, 'Harmonogram');
});

test('mapTrigger(manual) → Ręcznie', () => {
  assert.equal(mapTrigger('manual').label, 'Ręcznie');
});

test('mapTrigger(webhook) → Webhook', () => {
  assert.equal(mapTrigger('webhook').label, 'Webhook');
});

test('mapTrigger(nieznane) → fallback Harmonogram z niepustą ikoną', () => {
  const result = mapTrigger('cokolwiek-nieznane');
  assert.equal(result.label, 'Harmonogram');
  assert.notEqual(result.ico, '', 'ico nie może być puste');
});
