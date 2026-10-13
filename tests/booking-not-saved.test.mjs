// The booking page used to show "You're all set!" whatever confirm-booking answered. When the slot
// was lost during payment the server said so (409, ok:false) and the customer was still handed a
// confirmation code for a bay sold to someone else. These tests pin the page's reading of the
// server's answer, and that both payment paths consult it before confirming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
const src = /function notSavedMessage\(conf\)\{[\s\S]*?\n\}/.exec(html);
assert.ok(src, 'notSavedMessage is defined on the booking page');
const notSavedMessage = new Function(`${src[0]}; return notSavedMessage;`)();

test('a saved booking confirms', () => {
  assert.equal(notSavedMessage({ ok: true, id: 'x' }), null);
  assert.equal(notSavedMessage({ ok: true, already: true }), null);
});

test('no answer at all still confirms — the payment went through and the webhook writes the booking', () => {
  assert.equal(notSavedMessage(null), null);
});

test('"not saved" stops the confirmation and repeats what the server said about the card', () => {
  const said = 'That slot is no longer available — please contact the shop. Your card was only held, not charged, and the hold has been released.';
  assert.equal(notSavedMessage({ ok: false, error: said }), said);
  assert.match(notSavedMessage({ ok: false }), /could not save your booking/);
});

test('every path that confirms a booking checks the answer before saying it is booked', () => {
  const calls = [...html.matchAll(/fetch\('\/api\/confirm-booking'/g)].map(m => m.index);
  assert.equal(calls.length, 4, 'card payment, saved card, and the two returns from a bank redirect');
  for (const at of calls) {
    const next = Math.min(...['showConfirmation(', 'showStripeConfirmation(', "$('#conf-overlay').classList.add('show')"]
      .map(s => html.indexOf(s, at)).filter(i => i > 0));
    assert.match(html.slice(at, next), /notSavedMessage\(/, `checked before confirming (call at offset ${at})`);
  }
});
