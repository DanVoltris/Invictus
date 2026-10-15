// The booking sheet attaches a customer to the booking and then spends THEIR prepaid hours and
// signs THEIR waiver from it. It used to take the first customer, alphabetically, matching the
// email OR the phone OR the name — so a name shared with someone earlier in the list beat an exact
// phone match. 18 names are shared by two or more of the venue's customers. Names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../demo/admin.html', import.meta.url), 'utf8');
const src = /function matchCustomer\(b, list=CUSTOMERS\)\{[\s\S]*?\n\}/.exec(html);
assert.ok(src, 'matchCustomer is on the portal');
const matchCustomer = new Function('CUSTOMERS', `${src[0]}; return matchCustomer;`)([]);

const A1 = { id: 'a1', name: 'Alex Lee', phone: '(204) 555-0101', email: 'alex.one@example.com' };
const A2 = { id: 'a2', name: 'Alex Lee', phone: '2045550202', email: 'alex.two@example.com' };
const B  = { id: 'b',  name: 'Bo Park',  phone: null, email: 'bo@example.com' };
const list = [A1, A2, B];

test('the phone wins over a shared name, however the number is written', () => {
  assert.equal(matchCustomer({ customer_name: 'Alex Lee', customer_phone: '+1 204-555-0202' }, list).id, 'a2');
});
test('email when there is no phone match', () => {
  assert.equal(matchCustomer({ customer_name: 'Someone', customer_email: ' BO@example.com ' }, list).id, 'b');
});
test('a name shared by two customers matches nobody', () => {
  assert.equal(matchCustomer({ customer_name: 'alex  lee' }, list), undefined);
});
test('a unique name matches only when the booking has no contact at all', () => {
  assert.equal(matchCustomer({ customer_name: 'Bo Park' }, list).id, 'b');
  assert.equal(matchCustomer({ customer_name: 'Bo Park', customer_phone: '2045559999' }, list), undefined,
    'a phone that matches nobody is a different person, not a reason to guess by name');
});
