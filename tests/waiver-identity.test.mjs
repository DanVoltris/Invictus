// /api/sign-waiver has no login. It used to answer anyone who typed a phone number with that
// customer's name, write a typed phone onto a record found by somebody else's email (after which
// proving that phone on My Account handed over the record), and let a typed phone or email
// re-sign a waiver already on file. What a caller may learn and change now depends on HOW they
// were identified: by a link (a customer or booking uuid) or by a typed contact. Names are invented.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
const S = { customers: [], bookings: [], writes: [] };
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// The slice of supabase-js the waiver code uses, over two arrays.
function fakeDb() {
  return { from(table) {
    const rows = S[table]; let op = 'select', payload = null, id = null;
    const run = () => {
      if (op === 'insert') { const r = { id: 'new-' + (rows.length + 1), ...payload }; rows.push(r); S.writes.push({ table, op, payload }); return { data: r, error: null }; }
      const row = rows.find((r) => r.id === id) || null;
      if (op === 'update' && row) { Object.assign(row, payload); S.writes.push({ table, op, id, payload }); }
      return { data: row, error: null };
    };
    const q = {
      select: () => q, eq: (_c, v) => { id = v; return q; },
      update: (p) => { op = 'update'; payload = p; return q; },
      insert: (p) => { op = 'insert'; payload = p; return q; },
      maybeSingle: async () => run(), single: async () => run(),
      then: (ok, bad) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  } };
}
mock.module(ROOT + 'lib/db.js', { namedExports: {
  admin: () => fakeDb(),
  normPhone: digits,
  getSettings: async () => ({}), saveBookingFeedback: async () => ({}),
  // phone first, email fallback — as lib/db.js does
  customerHoursByContact: async ({ email, phone }) =>
    (digits(phone) && S.customers.find((c) => digits(c.phone) === digits(phone)))
    || (email && S.customers.find((c) => (c.email || '').toLowerCase() === email.toLowerCase())) || null,
} });
mock.module(ROOT + 'lib/notify.js', { namedExports: { enqueue: async () => ({}), sendOne: async () => ({}), venueIdentity: () => ({}) } });
const { waiver } = await import(ROOT + 'api/account.js');

const call = async (method, data) => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await waiver({ method, query: method === 'GET' ? data : {}, body: method === 'POST' ? data : {} }, res);
  return res;
};
const SIGNED = '2026-03-01T18:00:00.000Z';
const seed = () => {
  S.writes = [];
  S.customers = [
    { id: 'c-ana', name: 'Ana Signed', email: 'ana@example.com', phone: '(204) 555-0101', waiver_signed_at: SIGNED, waiver_name: 'Ana Signed' },
    { id: 'c-ben', name: 'Ben Emailonly', email: 'ben@example.com', phone: null, waiver_signed_at: null },
  ];
  S.bookings = [{ id: 'b0000000-0000-4000-8000-000000000001', customer_email: 'ana@example.com', customer_phone: '2045550101', customer_name: 'Ana Signed' }];
};

test('a typed phone or email is answered yes or no — never with a name or a date', async () => {
  seed();
  for (const q of [{ p: '204-555-0101' }, { e: 'ana@example.com' }, { c: 'not-a-customer', p: '2045550101' }, { b: 'ffffffff-0000-4000-8000-000000000000', e: 'ana@example.com' }]) {
    const r = await call('GET', q);
    assert.deepEqual(r.body, { ok: true, signed: true }, JSON.stringify(q));
  }
  assert.deepEqual((await call('GET', { p: '2045559999' })).body, { ok: true, signed: false });
});

test('a customer link or a booking link still shows whose waiver it is', async () => {
  seed();
  for (const q of [{ c: 'c-ana' }, { b: 'b0000000-0000-4000-8000-000000000001' }]) {
    const r = await call('GET', q);
    assert.equal(r.body.name, 'Ana Signed'); assert.equal(r.body.signedAt, SIGNED);
  }
});

test('a booking link identifies by the booking, not by an email typed beside it', async () => {
  seed();
  const r = await call('POST', { name: 'Ben Emailonly', bookingId: 'b0000000-0000-4000-8000-000000000001', email: 'ben@example.com', phone: '2045550777' });
  assert.equal(r.body.ok, true);
  assert.equal(S.customers[1].waiver_signed_at, null, "Ben's record is not the one signed");
  assert.equal(S.customers[1].phone, null);
});

test('signing by typed email does not put the typed phone on that record', async () => {
  seed();
  const r = await call('POST', { name: 'Someone Else', email: 'ben@example.com', phone: '204-555-0666' });
  assert.equal(r.body.ok, true, 'an unsigned waiver can still be signed');
  assert.ok(S.customers[1].waiver_signed_at);
  assert.equal(S.customers[1].phone, null, 'the phone that would later claim the account was not written');
});

test('a typed contact cannot replace a waiver already on file; staff and link holders can', async () => {
  seed();
  const r = await call('POST', { name: 'Not Ana', phone: '2045550101', email: 'x@example.com' });
  assert.deepEqual(r.body, { ok: true, signedAt: SIGNED, already: true });
  assert.equal(S.customers[0].waiver_name, 'Ana Signed');
  assert.equal(S.writes.length, 0, 'nothing was written');
  const again = await call('POST', { name: 'Ana Signed', customerId: 'c-ana' });   // the portal's "Mark signed in person"
  assert.equal(again.body.ok, true);
  assert.notEqual(S.customers[0].waiver_signed_at, SIGNED);
});

test('a customer link may add the email they type; a brand-new signer still gets a profile', async () => {
  seed();
  S.customers.push({ id: 'c-cy', name: 'Cy Phoneonly', email: null, phone: '2045550303', waiver_signed_at: null });
  await call('POST', { name: 'Cy Phoneonly', customerId: 'c-cy', email: 'cy@example.com' });
  assert.equal(S.customers[2].email, 'cy@example.com');
  const r = await call('POST', { name: 'Dee New', email: 'dee@example.com', phone: '2045550404' });
  assert.equal(r.body.ok, true);
  const dee = S.customers.find((c) => c.email === 'dee@example.com');
  assert.equal(dee.phone, '2045550404'); assert.ok(dee.waiver_signed_at);
});
