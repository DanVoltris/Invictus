// "Show / Hide" button inside every password box, so people can check what they typed.
// Used by the staff portal (admin.html) and My Account (account.html). Both pages build some of
// their password boxes later from JavaScript, so this watches the page and adds the button to
// any password box that appears, instead of each form having to remember to.
(function(){
  const css = `
    .pw-wrap{position:relative;display:block;width:100%}
    .pw-wrap > input{padding-right:64px}
    .pw-toggle{position:absolute;top:50%;right:8px;transform:translateY(-50%);border:none;background:none;
      padding:6px 8px;border-radius:7px;color:var(--muted,#555C68);font:inherit;font-size:12.5px;font-weight:700;
      cursor:pointer;line-height:1}
    .pw-toggle:hover{color:var(--white,#14161A);background:var(--surface-2,#EDEFF3)}
    .pw-toggle:focus-visible{outline:2px solid var(--orange,#F0523D);outline-offset:1px}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function enhance(input){
    if(input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    // The box's own spacing moves to the wrapper, or the button centres on box + gap, not the box.
    const cs = getComputedStyle(input);
    wrap.style.marginTop = cs.marginTop; wrap.style.marginBottom = cs.marginBottom;
    input.style.marginTop = '0'; input.style.marginBottom = '0';
    const btn = document.createElement('button');
    btn.type = 'button';                       // never submits the form it sits in
    btn.className = 'pw-toggle';
    const set = shown => {
      input.type = shown ? 'text' : 'password';
      btn.textContent = shown ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(shown));
      btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    };
    btn.addEventListener('click', () => { set(input.type === 'password'); input.focus(); });
    set(false);
    wrap.appendChild(btn);
  }
  function scan(root){
    if(root.matches && root.matches('input[type="password"]')) enhance(root);
    if(root.querySelectorAll) root.querySelectorAll('input[type="password"]').forEach(enhance);
  }
  function start(){
    scan(document.body);
    new MutationObserver(muts => {
      for(const m of muts) for(const n of m.addedNodes) if(n.nodeType === 1) scan(n);
    }).observe(document.body, { childList:true, subtree:true });
  }
  if(document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
