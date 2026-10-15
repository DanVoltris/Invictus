// The portal's promptSheet runs every "type an amount, press OK" form — capture, release, adjust a
// hold, mark league money collected. A double-click or Enter pressed twice ran the save twice; for
// league money that recorded two payments for one. The real function runs here against a tiny fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../demo/admin.html', import.meta.url), 'utf8');
const src = /function promptSheet\(\{[\s\S]*?\n\}/.exec(html)[0];

function sheet() {
  const els = {};
  const mk = (id) => (els[id] ||= { id, value: '1', disabled: false, isConnected: true, textContent: '',
    classList: { add() {}, remove() {} }, addEventListener() {}, focus() {}, select() {} });
  const $ = (sel) => mk(sel.replace('#', ''));
  els['confirm-overlay'] = { classList: { add() {}, remove() {} } };
  els['confirm-sheet'] = { set innerHTML(v) { if (v === '') Object.values(els).forEach((e) => { e.isConnected = false; }); }, querySelectorAll: () => [] };
  return { els, promptSheet: new Function('$', 'esc', `${src}; return promptSheet;`)($, String) };
}

test('pressing OK again while the first save is still running does not save twice', async () => {
  const { els, promptSheet } = sheet();
  let saves = 0;
  promptSheet({ title: 'Mark money collected', fields: [{ id: 'n', label: 'Seats' }],
    onOk: async () => { saves++; await new Promise((r) => setTimeout(r, 30)); } });
  await Promise.all([els['pf-yes'].onclick(), els['pf-yes'].onclick(), els['pf-yes'].onclick()]);
  assert.equal(saves, 1);
});

test('a problem keeps the form open and OK can be pressed again', async () => {
  const { els, promptSheet } = sheet();
  let tries = 0;
  promptSheet({ title: 'Charge', fields: [{ id: 'amt', label: 'Amount' }], onOk: async () => (++tries === 1 ? 'Enter an amount.' : null) });
  await els['pf-yes'].onclick();
  assert.equal(els['pf-err'].textContent, 'Enter an amount.');
  assert.equal(els['pf-yes'].disabled, false, 'usable again');
  await els['pf-yes'].onclick();
  assert.equal(tries, 2);
});
