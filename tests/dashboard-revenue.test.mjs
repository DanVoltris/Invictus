// Dashboard revenue is money the venue KEPT. It used to ignore refunds, drop every cancelled
// booking (even one whose money was kept), and halve a session running past midnight because only
// the part before midnight fell inside the day — while the volume chart beside it counted the
// whole amount, so the two disagreed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;   // the file publishes itself as window.InvictusAnalytics, as in the portal
await import(new URL('../demo/assets/analytics.js', import.meta.url).href);
const A = globalThis.InvictusAnalytics;
const settings = { bays: [{ id: 'B1', name: 'Bay 1' }, { id: 'B2', name: 'Bay 2' }],
  hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] } };
const day = '2026-10-14';
const metrics = (bookings) => A.computeMetrics({
  facts: A.factsFrom(bookings, []), settings, from: day, to: day, todayISO: '2026-10-20',
  prime: { startHour: 17, endHour: 22 },
});
const late   = { id: 'a', bay_id: 'B1', booking_date: day, start_min: 1380, end_min: 1500, status: 'confirmed', amount_cents: 10000 };
const halved = { id: 'b', bay_id: 'B2', booking_date: day, start_min: 1080, end_min: 1200, status: 'confirmed', amount_cents: 10000, refunded_cents: 5000 };
const kept   = { id: 'c', bay_id: 'B1', booking_date: day, start_min: 600,  end_min: 720,  status: 'cancelled', amount_cents: 6000 };

test('revenue is what was kept: refunds out, a kept cancellation in, a past-midnight session whole', () => {
  const m = metrics([late, halved, kept]);
  const headline = m.utilisation ? m.utilisation.allDay.revenueCents : m.volume.totals.revenueCents;
  assert.equal(headline, 21000, '$100 + ($100 − $50) + $60');
  const chart = m.volume.series ? m.volume.series : m.volume;
  const sum = (Array.isArray(chart) ? chart : chart.rows || []).reduce((s, r) => s + r.revenueCents, 0);
  assert.equal(sum, 21000, 'the chart agrees with the headline');
});

test('a kept cancellation is revenue, not a session', () => {
  const m = metrics([kept]);
  assert.equal(m.utilisation.allDay.bookings, 0);
  assert.equal(m.utilisation.allDay.bookedMin, 0);
  assert.equal(m.utilisation.allDay.revenueCents, 6000);
});

test('prime-time revenue is still the slice inside prime time', () => {
  // 6–8 PM with prime 5–10 PM: all of it is prime. 11 PM–1 AM: none of it.
  const m = metrics([late, { ...halved, refunded_cents: 0 }]);
  assert.equal(m.utilisation.prime.revenueCents, 10000);
  assert.equal(m.utilisation.allDay.revenueCents, 20000);
});
