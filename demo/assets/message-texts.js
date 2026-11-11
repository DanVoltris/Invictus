/* ============================================================================
   Message texts — the wording of every text message the site sends, and the admin's own version.

   Plain script, no imports: the manager portal loads it with <script src="/assets/message-texts.js">
   (the Venue tab's editor and its preview), and lib/notify.js imports it for its side effect. Both
   read globalThis.InvictusTexts, so the preview staff see is filled in exactly as the real text is.

   HOW A CUSTOM TEXT WORKS
     · Each kind of text has a key ("booking.paid"), a default wording and the details it can use,
       written {name}. settings.message_texts holds the admin's own wording by key (migration 0054).
     · No custom wording for a key: the text goes out exactly as it always has (lib/notify.js's
       built-in templates, which these defaults copy word for word).
     · [square brackets] around part of a text: that part appears only when every {detail} inside
       it is known — "Yours[ until {expires}]." reads "Yours." when there is no deadline.
     · A text that needs something to work — a sign-in code, a link — cannot be saved without it,
       and is sent the built-in way if that detail is ever missing.
     · Opt-out: marketing texts (the waiting-list offer) get "Reply STOP to opt out" added after the
       text, always. It is the law (CASL), so it is not part of what can be edited.
   ========================================================================== */
(function (root) {
  const V = {
    venue: ['Venue name', 'Invictus Golf'],
    name: ['Their name', 'Sam'],
    bay: ['Bay', 'Bay #2'],
    when: ['Date and time', 'Friday, November 13, 7:00 PM–9:00 PM'],
    amount: ['Amount', '$78.40 CAD'],
    from: ['Who sent it', 'Alex'],
    code: ['Gift card code', 'GIFT-7KQ2-M4XD'],
    recipient: ['Who it is for', 'Jordan'],
    expires: ['Offer ends', '7:15 PM'],
    link: ['Link', 'https://invictusgolf.voltrisbooking.com/waitlist?t=…'],
    day: ['Day', 'Friday, November 13'],
    times: ['Times', '6:00 PM–10:00 PM'],
    minutes: ['Minutes until it expires', '10'],
    signinCode: ['Sign-in code', '482913'],
    invitedBy: ['Who added them', 'Morgan'],
    role: ['Their role', 'Employee'],
    team: ['Team', 'Aces'],
    league: ['League', 'Invictus Winter League'],
    share: ['Their share', '$285'],
    date: ['Date', 'Monday, Dec 14'],
    week: ['Week number', '6'],
  };
  const K = (key, group, label, when, vars, text, extra = {}) => ({ key, group, label, when, vars: ['venue', ...vars], text, ...extra });

  const KINDS = [
    K('booking.paid', 'Bookings', 'Booking confirmed — paid', 'Right after a customer pays for a booking online.',
      ['name', 'bay', 'when', 'amount'], "{venue}: you're booked — {bay}, {when}. Paid {amount}.", { fallback: { bay: 'your bay' } }),
    K('booking.held', 'Bookings', 'Booking confirmed — card held', 'Right after a booking whose card is held until check-in.',
      ['name', 'bay', 'when', 'amount'], "{venue}: you're booked — {bay}, {when}. {amount} held on your card, charged at check-in.", { fallback: { bay: 'your bay' } }),
    K('booking.saved', 'Bookings', 'Booking confirmed — card saved', 'Right after a far-ahead booking whose card is saved, with nothing charged yet.',
      ['name', 'bay', 'when', 'amount'], "{venue}: you're booked — {bay}, {when}. {amount} due at check-in, nothing charged yet.", { fallback: { bay: 'your bay' } }),

    K('waitlist.joined', 'Waiting list', 'Joined the waiting list', 'When a customer joins the waiting list for a day.',
      ['name', 'day', 'times'], "{venue}: you're on the waiting list for {day}[, {times}]. We'll message you if a bay frees up."),
    K('waitlist.offer', 'Waiting list', 'A bay opened up', 'When a bay they are waiting for comes free. "Reply STOP to opt out" is added after it.',
      ['name', 'bay', 'when', 'expires', 'link'], '{venue}: {bay} just opened — {when}. Yours[ until {expires}].[ {link}]', { fallback: { bay: 'a bay' }, commercial: true }),

    K('gift.from', 'Gift cards', 'Gift card received', 'To the person a gift card was bought for.',
      ['name', 'from', 'amount', 'code'], '{venue}: {from} sent you a {amount} gift card. Code: {code}. Never expires — use it at checkout.', { required: ['code'] }),
    K('gift.self', 'Gift cards', 'Gift card (bought for themselves)', 'When someone buys a gift card for themselves.',
      ['name', 'amount', 'code'], '{venue}: here is a {amount} gift card. Code: {code}. Never expires — use it at checkout.', { required: ['code'] }),
    K('gift.purchased', 'Gift cards', 'Gift card receipt', 'To the buyer, when the card goes to someone else (no code in it).',
      ['name', 'amount', 'recipient'], '{venue}: your {amount} gift card is paid for and on its way[ to {recipient}].'),

    K('league.invite', 'Leagues', 'Invite to a team', 'When a captain invites a player to their team.',
      ['name', 'invitedBy', 'team', 'league', 'link'], '{venue}: {invitedBy} has got you a spot on {team}[ in {league}] — nothing to pay to join.[ Join: {link}]', { fallback: { invitedBy: 'your captain' } }),
    K('league.invite.sub', 'Leagues', 'Invite to be a substitute', 'When a captain asks someone to be a substitute.',
      ['name', 'invitedBy', 'team', 'league', 'link'], '{venue}: {invitedBy} has asked you to be a substitute for {team}[ in {league}]. No league fee.[ Accept: {link}]', { fallback: { invitedBy: 'the captain' } }),
    K('league.added', 'Leagues', 'Added to a team — share to pay', 'When staff add a player who still has their share to pay.',
      ['name', 'team', 'league', 'share', 'link'], "{venue}: You're on {team}[ ({league})]. Pay your {share} share: {link}"),
    K('league.added.paid', 'Leagues', 'Added to a team — nothing to pay', 'When staff add a player whose seat is already paid.',
      ['name', 'team', 'league', 'link'], "{venue}: You're on {team}[ ({league})]. See your team: {link}"),
    K('league.placed', 'Leagues', 'Placed on a team', 'When staff put a solo sign-up on a team.',
      ['name', 'team', 'league'], "{venue}: you're on {team}[ in {league}]. Sign in to My Account to see your team and book your weekly round."),
    K('league.reminder.rosters', 'Leagues', 'Rosters lock soon', 'To each captain, a week before rosters lock.',
      ['name', 'team', 'league', 'date', 'week'], "{venue}: rosters for {league} lock after {date}[ (end of week {week})]. Add or change {team}'s players and substitutes on My Account before then. No changes after that."),
    K('league.reminder.playoffs', 'Leagues', 'Playoffs start soon', 'To each captain, a week before the playoffs.',
      ['name', 'team', 'league', 'date'], "{venue}: {league} playoffs start {date}. Substitutes can't play in the playoffs. Only {team}'s registered players can."),

    K('account.code', 'Accounts and staff', 'Sign-in code', 'When someone signs in or signs up with their phone number.',
      ['signinCode', 'minutes'], "{venue}: your code is {signinCode}. Expires in {minutes} min. If this wasn't you, ignore it.", { required: ['signinCode'] }),
    K('staff.invite', 'Accounts and staff', 'Staff portal invite', 'When an admin adds someone to the staff portal.',
      ['invitedBy', 'role', 'link'], '{venue}: {invitedBy} added you to the staff portal[ as {role}]. Set up your login (your email + a password): {link} — works once, within 7 days.', { required: ['link'], fallback: { invitedBy: 'An admin' } }),
    K('staff.reset', 'Accounts and staff', 'Staff password link', 'When an admin sends a staff member a new password link.',
      ['link'], '{venue}: choose a new staff portal password here — {link} (works once).', { required: ['link'] }),
  ];
  const BY_KEY = Object.fromEntries(KINDS.map((k) => [k.key, k]));

  // Which kind of text a queued message is: the template and what is in it.
  function kindOf(template, p) {
    p = p || {};
    const key = template === 'booking.confirmed' ? (p.paymentState === 'card_saved' ? 'booking.saved' : p.paymentState === 'held' ? 'booking.held' : 'booking.paid')
      : template === 'gift.issued' ? (p.fromName ? 'gift.from' : 'gift.self')
      : template === 'staff.invite' ? (p.kind === 'reset' ? 'staff.reset' : 'staff.invite')
      : template === 'league.invite' ? (p.role === 'sub' ? 'league.invite.sub' : 'league.invite')
      : template === 'league.added' ? (p.shareCents ? 'league.added' : 'league.added.paid')
      : template === 'league.reminder' ? (p.kind === 'playoffs' ? 'league.reminder.playoffs' : 'league.reminder.rosters')
      : template;
    return BY_KEY[key] || null;
  }

  const VAR_RE = /\{([a-zA-Z]+)\}/g;
  // Fill a wording in: optional [parts] first (kept only when every detail inside is known), then
  // the {details}. Extra spaces left by an empty detail are closed up.
  function fill(text, vars) {
    const has = (n) => vars[n] != null && String(vars[n]).trim() !== '';
    return String(text || '')
      .replace(/\[([^[\]]*)\]/g, (_, part) => { const names = [...part.matchAll(VAR_RE)].map((m) => m[1]); return names.every(has) ? part : ''; })
      .replace(VAR_RE, (m, n) => (n in vars ? String(vars[n] == null ? '' : vars[n]) : m))
      .replace(/[ \t]{2,}/g, ' ').trim();
  }

  // What is wrong with a wording, or '' when it can be saved.
  const MAX_LEN = 600;
  function problem(kind, text) {
    const t = String(text || '');
    if (!t.trim()) return 'The text is empty. Use "Back to the default" instead.';
    if (t.length > MAX_LEN) return `That is ${t.length} characters — keep it under ${MAX_LEN} (about 4 texts' worth).`;
    let depth = 0;
    for (const ch of t) { if (ch === '[') depth++; if (ch === ']') depth--; if (depth < 0 || depth > 1) return 'The [square brackets] don’t pair up (and can’t go inside each other).'; }
    if (depth) return 'A [square bracket] is never closed.';
    const unknown = [...t.matchAll(VAR_RE)].map((m) => m[1]).filter((n) => !kind.vars.includes(n));
    if (unknown.length) return `{${unknown[0]}} isn’t a detail this text has. Use the buttons under the box.`;
    const missing = (kind.required || []).filter((n) => !t.includes(`{${n}}`));
    if (missing.length) return `This text has to include {${missing[0]}} — it doesn’t work without it.`;
    if ((kind.required || []).some((n) => new RegExp(`\\[[^\\]]*\\{${n}\\}[^\\]]*\\]`).test(t))) return 'A required detail can’t be inside [square brackets].';
    return '';
  }

  // The preview: every detail filled with an example.
  const sampleVars = (kind) => Object.fromEntries(kind.vars.map((n) => [n, (V[n] || ['', ''])[1]]));

  // Characters a text can carry at 160 a segment (GSM-7). Anything else — an emoji, most accents —
  // makes the whole text 70 characters a segment.
  const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€';
  function segments(text) {
    const t = String(text || '');
    const gsm = [...t].every((c) => GSM.includes(c));
    const per = gsm ? 160 : 70, multi = gsm ? 153 : 67;
    const n = [...t].length;
    return { chars: n, gsm, count: n <= per ? 1 : Math.ceil(n / multi) };
  }

  // What the phone actually receives: the punctuation lib/notify.js gsm7() swaps for plain
  // characters (— to -, curly quotes to straight), so the preview and the count match the real text.
  const SWAPS = [[/[‒–—−]/g, '-'], [/[‘’‚′]/g, "'"], [/[“”„″]/g, '"'],
    [/[·•]/g, '-'], [/…/g, '...'], [/[   ]/g, ' ']];
  const plain = (text) => SWAPS.reduce((t, [re, to]) => t.replace(re, to), String(text));

  root.InvictusTexts = { KINDS, BY_KEY, VARS: V, kindOf, fill, problem, sampleVars, segments, plain, MAX_LEN };
})(typeof globalThis !== 'undefined' ? globalThis : this);
