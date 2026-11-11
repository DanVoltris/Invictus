// Editable text messages (migration 0054): the default wording in demo/assets/message-texts.js is
// word for word what lib/notify.js has always sent, and a saved custom wording is what goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, renderNotification, customSms } from '../lib/notify.js';

const T = globalThis.InvictusTexts;
const venue = { name: 'Invictus Golf', address: '1 Main St', phone: '204-555-0100', email: 'a@x.test', website: 'invictusgolf.test', unsubscribeUrl: '', texts: {} };

// One real-looking message per kind of text, including the ones with optional parts left out.
const CASES = [
  ['booking.confirmed', { name: 'Sam', bayName: 'Bay #2', dateISO: '2026-11-13', startMin: 1140, endMin: 1260, amountCents: 7840 }],
  ['booking.confirmed', { bayName: 'Bay #2', dateISO: '2026-11-13', startMin: 1380, endMin: 1500, amountCents: 7840, paymentState: 'held' }],
  ['booking.confirmed', { dateISO: '2026-12-01', startMin: 600, endMin: 720, amountCents: 6720, paymentState: 'card_saved' }],
  ['waitlist.joined', { dateISO: '2026-11-13', windowText: '6:00 PM–10:00 PM' }],
  ['waitlist.joined', { dateISO: '2026-11-13' }],
  ['waitlist.offer', { bayName: 'Bay #3', dateISO: '2026-11-13', startMin: 1140, endMin: 1200, expiresText: '7:15 PM', claimUrl: 'https://x.test/w?t=1' }],
  ['waitlist.offer', { dateISO: '2026-11-13', startMin: 1140, endMin: 1200 }],
  ['gift.issued', { fromName: 'Alex', amountCents: 5000, code: 'GIFT-1' }],
  ['gift.issued', { amountCents: 5000, code: 'GIFT-1' }],
  ['gift.purchased', { amountCents: 5000, recipientName: 'Jordan' }],
  ['gift.purchased', { amountCents: 5000 }],
  ['league.invite', { invitedBy: 'Morgan', teamName: 'Aces', leagueName: 'Winter', link: 'https://x.test/j' }],
  ['league.invite', { invitedBy: 'Morgan', teamName: 'Aces', role: 'sub', link: 'https://x.test/j' }],
  ['league.invite', { teamName: 'Aces', role: 'sub' }],
  ['league.added', { teamName: 'Aces', leagueName: 'Winter', shareCents: 28500, link: 'https://x.test/account' }],
  ['league.added', { teamName: 'Aces', shareCents: 28550, link: 'https://x.test/account' }],
  ['league.added', { teamName: 'Aces', leagueName: 'Winter', shareCents: 0, link: 'https://x.test/account' }],
  ['league.placed', { teamName: 'Aces', leagueName: 'Winter' }],
  ['league.placed', { teamName: 'Aces' }],
  ['league.reminder', { kind: 'rosters', leagueName: 'Winter', teamName: 'Aces', on: '2026-12-14', week: 6 }],
  ['league.reminder', { kind: 'rosters', leagueName: 'Winter', teamName: 'Aces', on: '2026-12-14' }],
  ['league.reminder', { kind: 'playoffs', leagueName: 'Winter', teamName: 'Aces', on: '2027-02-01' }],
  ['account.code', { code: '482913', minutes: 10 }],
  ['staff.invite', { invitedBy: 'Morgan', roleLabel: 'Employee', link: 'https://x.test/s' }],
  ['staff.invite', { invitedBy: 'Morgan', link: 'https://x.test/s' }],
  ['staff.invite', { kind: 'reset', link: 'https://x.test/s' }],
];

test('every default wording is exactly the text sent today', () => {
  for (const [template, p] of CASES) {
    const kind = T.kindOf(template, p);
    assert.ok(kind, `${template} has a kind`);
    const own = customSms(template, p, { ...venue, texts: { [kind.key]: kind.text } });
    assert.equal(own, TEMPLATES[template].sms(p, venue), `${kind.key} ${JSON.stringify(p)}`);
  }
});

test('every kind of text the site sends can be edited', () => {
  const covered = new Set(CASES.map(([t, p]) => T.kindOf(t, p).key));
  assert.deepEqual([...covered].sort(), T.KINDS.map((k) => k.key).sort());
  for (const t of Object.keys(TEMPLATES)) assert.ok(CASES.some(([x]) => x === t), `${t} is covered`);
});

test('nothing saved: the built-in text, unchanged', () => {
  const p = CASES[0][1];
  const r = renderNotification({ template: 'booking.confirmed', channel: 'sms', payload: p }, venue);
  assert.match(r.body, /^Invictus Golf: you're booked - Bay #2, .* Paid \$78\.40 CAD\.$/);
});

test('a saved wording is what goes out; optional parts drop out cleanly', () => {
  const texts = { 'booking.paid': 'Thanks {name}! {bay} on {when} is yours. Total {amount}.[ Questions? {nope}]',
    'waitlist.offer': 'Hey[ {name}], {bay} is free {when}. Grab it[ by {expires}]: {link}' };
  const v = { ...venue, texts: { ...texts, 'booking.paid': texts['booking.paid'].replace('[ Questions? {nope}]', '') } };
  const r = renderNotification({ template: 'booking.confirmed', channel: 'sms', payload: CASES[0][1] }, v);
  assert.equal(r.body, "Thanks Sam! Bay #2 on Friday, November 13, 7:00 PM-9:00 PM is yours. Total $78.40 CAD.");

  // The opt-out line still follows a marketing text.
  const o = renderNotification({ template: 'waitlist.offer', channel: 'sms', payload: { ...CASES[5][1] } }, v);
  assert.equal(o.body.split('\n')[0], 'Hey, Bay #3 is free Friday, November 13, 7:00 PM-8:00 PM. Grab it by 7:15 PM: https://x.test/w?t=1');
  assert.match(o.body.split('\n')[1], /Reply STOP to opt out\.$/);
});

test('a wording that cannot work is never sent: unknown details, a missing code', () => {
  const kind = T.BY_KEY['account.code'];
  assert.match(T.problem(kind, 'Your code is ready.'), /has to include \{signinCode\}/);
  assert.match(T.problem(kind, 'Code {signinCode} for {team}'), /\{team\} isn’t a detail/);
  assert.match(T.problem(kind, 'Code [{signinCode}]'), /can’t be inside/);
  assert.match(T.problem(kind, 'Code {signinCode} [oops'), /never closed/);
  assert.equal(T.problem(kind, 'Your Invictus code: {signinCode}'), '');
  // Saved anyway (by hand in the database): the built-in text goes out instead.
  const v = { ...venue, texts: { 'account.code': 'Your code is ready.' } };
  assert.equal(renderNotification({ template: 'account.code', channel: 'sms', payload: { code: '1', minutes: 10 } }, v).body,
    "Invictus Golf: your code is 1. Expires in 10 min. If this wasn't you, ignore it.");
  // A gift card whose code was already scrubbed from the row: built-in wording, never "Code: ."
  const g = { ...venue, texts: { 'gift.self': 'Gift: {amount}, code {code}' } };
  assert.equal(customSms('gift.issued', { amountCents: 500 }, g), null);
});

test('the preview counts texts the way the phone company does', () => {
  assert.deepEqual(T.segments('a'.repeat(160)), { chars: 160, gsm: true, count: 1 });
  assert.equal(T.segments('a'.repeat(161)).count, 2);
  assert.equal(T.segments('Hi 🎉').gsm, false);
  assert.equal(T.segments('😀'.repeat(71)).count, 2);
});

test('the preview’s plain characters are the ones lib/notify.js sends', async () => {
  const { gsm7 } = await import('../lib/notify.js');
  const s = 'Bay — “hi” it’s 7:00 PM–9:00 PM · ok… done';
  assert.equal(T.plain(s), gsm7(s));
});
