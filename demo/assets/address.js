/* Address autofill for an <input>: OpenStreetMap suggestions through api/account.js (lib/address.js).

     InvictusAddress.attach(input, { auth: () => ({ headers, body }) })
     InvictusAddress.houseNumber(input)   // what was typed in the house-number box, or ''

   Picking a suggestion fills the input and records the place on it (input.dataset.placeId);
   typing again forgets it. OpenStreetMap knows some streets without every house number, so
   picking a street opens a small house-number box under the input (input.dataset.needsNumber).
   Whoever saves the form sends the place id and the number, and the server looks the place up
   again — that, not anything here, is what verifies the address. */
(function () {
  const css = `
    .addr-wrap{position:relative}
    .addr-list{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;background:#fff;border:1px solid #D7DCE3;
      border-radius:11px;box-shadow:0 10px 30px rgba(20,22,26,.12);overflow:hidden;list-style:none;margin:0;padding:4px 0}
    .addr-list li{padding:10px 14px;cursor:pointer;font-size:14px;line-height:1.35}
    .addr-list li small{display:block;color:#858C99;font-size:12px}
    .addr-list li[aria-selected="true"],.addr-list li:hover{background:#F5F7FA}
    .addr-list .addr-note{cursor:default;color:#858C99;font-size:12.5px}
    .addr-list .addr-note:hover{background:none}
    .addr-foot{font-size:10.5px;color:#9AA1AD;text-align:right;padding:2px 10px 4px}
    .addr-foot a{color:inherit}
    .addr-num{margin-top:8px;display:flex;gap:8px;align-items:center}
    .addr-num label{font-size:12.5px;color:#555C68;white-space:nowrap}
    .addr-num input{max-width:150px}`;
  let n = 0;

  function attach(input, opts) {
    if (!document.getElementById('addr-css')) {
      const st = document.createElement('style'); st.id = 'addr-css'; st.textContent = css; document.head.appendChild(st);
    }
    const id = 'addr-list-' + (++n);
    const wrap = document.createElement('div'); wrap.className = 'addr-wrap';
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const list = document.createElement('ul'); list.className = 'addr-list'; list.id = id; list.setAttribute('role', 'listbox'); list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', id); input.setAttribute('aria-expanded', 'false');
    input.autocomplete = 'off';

    // House-number box, shown only after a street (not a full address) is picked.
    const num = document.createElement('div'); num.className = 'addr-num'; num.hidden = true;
    num.innerHTML = `<label for="${id}-num">House number</label><input class="input" id="${id}-num" inputmode="text" maxlength="14" placeholder="e.g. 51 or 12-340" />`;
    wrap.after(num);
    input._addrNum = num.querySelector('input');
    let items = [], active = -1, timer = null, seq = 0;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const note = (text) => { items = []; list.innerHTML = `<li class="addr-note" role="option" aria-disabled="true">${text}</li>`; list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function draw() {
      if (!items.length) { note('No matching address. Keep typing your street number and name.'); return; }
      list.innerHTML = items.map((s, i) => `<li role="option" id="${id}-${i}" aria-selected="${i === active}" data-i="${i}">${esc(s.main || s.text)}<small>${esc(s.secondary)}</small></li>`).join('')
        + '<li class="addr-foot">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</li>';
      list.hidden = false; input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`); else input.removeAttribute('aria-activedescendant');
    }
    function pick(i) {
      const s = items[i]; if (!s) return;
      input.value = s.text;
      input.dataset.placeId = s.placeId;
      if (s.needsNumber) { input.dataset.needsNumber = '1'; num.hidden = false; input._addrNum.value = ''; }
      else { delete input.dataset.needsNumber; num.hidden = true; }
      close();
      if (s.needsNumber) input._addrNum.focus();
      input.dispatchEvent(new CustomEvent('address-picked', { detail: s }));
    }
    async function lookup() {
      const q = input.value.trim(), mine = ++seq;
      if (q.length < 3) { close(); return; }
      const a = (opts && opts.auth && opts.auth()) || {};
      let r;
      try {
        r = await fetch('/api/account?action=address-suggest', { method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(a.headers || {}) },
          body: JSON.stringify({ input: q, ...(a.body || {}) }) });
        r = { status: r.status, ...(await r.json().catch(() => ({}))) };
      } catch (e) { r = { error: 'Could not reach the server.' }; }
      if (mine !== seq) return;   // a newer keystroke has its own answer coming
      if (!r.ok) { note(esc(r.error || 'Address lookup is not available right now.')); return; }
      items = r.suggestions || []; active = -1; draw();
    }
    input.addEventListener('input', () => {
      delete input.dataset.placeId; delete input.dataset.needsNumber; num.hidden = true;
      clearTimeout(timer); timer = setTimeout(lookup, 250);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; draw(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') { close(); }
    });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }
  const houseNumber = (input) => (input && input._addrNum ? input._addrNum.value.trim() : '');
  window.InvictusAddress = { attach, houseNumber };
})();
