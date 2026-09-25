// A customer looking at a day the venue closed used to see every slot marked "Booked" — untrue,
// and acted on ("someone took it, I'll try tomorrow"). Migration 0032 lets staff say why, per
// override: public_reason true (the default) reaches customers, false stays inside the building.
// These tests pin both halves — the reason that travels, and the reason that must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
const { overrideEffects, normalizeSettings } = await import(ROOT + 'lib/booking.js');

const SETTINGS = normalizeSettings({
  bays: [{ id: 'B1', name: 'Bay 1' }, { id: 'B2', name: 'Bay 2' }],
  hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
  rates: { weekdayOffPeak: 20, weekdayPeak: 20, weekendOffPeak: 25, weekendPeak: 25, peakStartHour: 17 },
});
const fx = (overrides) => overrideEffects(overrides, SETTINGS, '2026-09-21');

test('a whole-day closure tells the customer why, when staff said they could', () => {
  const r = fx([{ is_closed: true, note: 'Christmas', public_reason: true, bay_ids: [] }]);
  assert.deepEqual(r.dateHours, [0, 0], 'the day is shut');
  assert.equal(r.closedReason, 'Christmas');
});

test('a private reason never leaves the building', () => {
  const r = fx([{ is_closed: true, note: "Dave's leaving do", public_reason: false, bay_ids: [] }]);
  assert.deepEqual(r.dateHours, [0, 0], 'still shut — only the explanation is withheld');
  assert.equal(r.closedReason, null);
  assert.deepEqual(r.reasons, {});
});

test('a timed block carries its reason against the exact range it blocks', () => {
  const r = fx([{ start_min: 720, end_min: 780, note: 'Maintenance', public_reason: true, bay_ids: ['B1'] }]);
  assert.deepEqual(r.blocked.B1, [[720, 780]]);
  assert.deepEqual(r.reasons.B1, [[720, 780, 'Maintenance']]);
  assert.equal(r.reasons.B2, undefined, 'another bay is not affected');
});

test('a block with no reason typed says nothing rather than something invented', () => {
  const r = fx([{ start_min: 720, end_min: 780, public_reason: true, bay_ids: ['B1'] }]);
  assert.deepEqual(r.blocked.B1, [[720, 780]], 'still blocked');
  assert.deepEqual(r.reasons, {});
  const blank = fx([{ start_min: 720, end_min: 780, note: '   ', public_reason: true, bay_ids: ['B1'] }]);
  assert.deepEqual(blank.reasons, {}, 'whitespace is not a reason');
});

test('before migration 0032 the column is missing, and a reason is treated as public', () => {
  const r = fx([{ start_min: 720, end_min: 780, note: 'Maintenance', bay_ids: ['B1'] }]);   // no public_reason key
  assert.deepEqual(r.reasons.B1, [[720, 780, 'Maintenance']]);
});

test('a closure of specific bays explains itself per bay', () => {
  const r = fx([{ is_closed: true, note: 'Flooring replaced', public_reason: true, bay_ids: ['B1', 'B2'] }]);
  assert.deepEqual(r.blocked.B1, [[0, 1440]]);
  assert.deepEqual(r.reasons.B1, [[0, 1440, 'Flooring replaced']]);
  assert.deepEqual(r.reasons.B2, [[0, 1440, 'Flooring replaced']]);
  assert.equal(r.dateHours, null, 'the venue as a whole is still open');
});

test('an "Open" status (Happy Hour) blocks nothing, so it explains nothing', () => {
  const r = fx([{ start_min: 1020, end_min: 1140, note: 'Happy Hour', public_reason: true, status_open: true, bay_ids: [] }]);
  assert.deepEqual(r.blocked, {});
  assert.deepEqual(r.reasons, {});
  assert.equal(r.closedReason, null);
});

test('several overrides on one day each keep their own reason and privacy', () => {
  const r = fx([
    { start_min: 600, end_min: 660, note: 'Maintenance', public_reason: true, bay_ids: ['B1'] },
    { start_min: 900, end_min: 960, note: 'Henderson hold', public_reason: false, bay_ids: ['B1'] },
  ]);
  assert.deepEqual(r.blocked.B1, [[600, 660], [900, 960]], 'both block the bay');
  assert.deepEqual(r.reasons.B1, [[600, 660, 'Maintenance']], 'only the public one explains itself');
});

test('the blocked ranges themselves are unchanged by any of this', () => {
  const withReasons = fx([{ start_min: 720, end_min: 780, note: 'Maintenance', public_reason: true, bay_ids: ['B1'] }]);
  const without = fx([{ start_min: 720, end_min: 780, bay_ids: ['B1'] }]);
  assert.deepEqual(withReasons.blocked, without.blocked, 'what is bookable never depends on what was explained');
});

test('shortened hours explain themselves too — the case the owner actually hit', () => {
  // "Block a time range" was not what got saved: the row is a special-hours override (open 5am,
  // close 11pm) with note "Christmas". The customer sees a short day, so they are told why.
  const r = fx([{ is_closed: false, start_min: null, end_min: null, open_hour: 5, close_hour: 23, note: 'Christmas', public_reason: true, bay_ids: [] }]);
  assert.deepEqual(r.dateHours, [5, 23]);
  assert.equal(r.hoursReason, 'Christmas');
  assert.equal(r.closedReason, null, 'the venue is open, just not as long');
});

test('shortened hours with a private note say nothing', () => {
  const r = fx([{ is_closed: false, open_hour: 5, close_hour: 23, note: 'Stocktake', public_reason: false, bay_ids: [] }]);
  assert.deepEqual(r.dateHours, [5, 23]);
  assert.equal(r.hoursReason, null);
});

test('a closure beats special hours, and takes the explanation with it', () => {
  const r = fx([
    { is_closed: false, open_hour: 5, close_hour: 23, note: 'Short day', public_reason: true, bay_ids: [] },
    { is_closed: true, note: 'Christmas', public_reason: true, bay_ids: [] },
  ]);
  assert.deepEqual(r.dateHours, [0, 0]);
  assert.equal(r.closedReason, 'Christmas');
  assert.equal(r.hoursReason, null, 'no point explaining hours on a day with none');
});
