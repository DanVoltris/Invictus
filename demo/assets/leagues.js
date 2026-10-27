/* ============================================================================
   Leagues — the weekly schedule and standings maths, in one place.

   A league is sold by the team and has no fixed night (migration 0031): each team plays once a
   week, whenever suits them, and books it themselves. So the unit here is the WEEK, and a week is
   Monday-to-Sunday to match Postgres date_trunc('week'), which the database uses to stop a team
   booking two rounds in one week.

   Plain script, no imports: the manager portal loads it with <script src="/assets/leagues.js">,
   and api/leagues.js imports it for its side effect. Both then read globalThis.InvictusLeagues, so
   the table a player sees on My Account and the one the shop sees can never disagree.
   ========================================================================== */
(function (root) {
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MAX_WEEKS = 400;   // a guard, not a rule: a season this long is a typo somewhere

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const dateOf = (iso) => new Date(`${iso}T00:00:00Z`);

  function timeLabel(min) {
    if (min == null) return '';
    const h = Math.floor(min / 60) % 24, m = min % 60, ap = h < 12 ? 'AM' : 'PM';
    return `${((h + 11) % 12) + 1}:${pad(m)} ${ap}`;
  }

  // A league has no night any more: each team plays once a week, whenever suits them (0031).
  // "Once a week · 3 hours recommended"
  function scheduleLabel(league) {
    const mins = league && league.weekly_min_mins;
    const hrs = mins ? Math.round((mins / 60) * 10) / 10 : null;
    return ['Once a week, your own time', hrs ? `${hrs} hour${hrs === 1 ? '' : 's'} recommended` : ''].filter(Boolean).join(' · ');
  }

  // The first day of that date's week, for a week starting on weekStart (0 = Sunday … 6 = Saturday;
  // Monday unless told otherwise). Matches public.league_week_of() in migration 0040, which fills
  // bookings.league_week — the column the "one round per team per week" rule is built on, so these
  // two must agree exactly. tests/league-week-db.test.mjs checks them day by day.
  const validStart = (n) => (Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1);
  function weekOf(dateISO, weekStart = 1) {
    const d = dateOf(dateISO);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - validStart(weekStart) + 7) % 7));
    return isoOf(d);
  }
  // The day a league's week starts (leagues.week_start, migration 0040). Monday when the league
  // does not say — which is every league before 0040, and what the database assumed all along.
  const weekStartOf = (league) => (league && league.week_start != null ? validStart(Number(league.week_start)) : 1);
  // The week dateISO falls in FOR THIS LEAGUE. Anything about a league's weeks goes through here.
  const weekIn = (league, dateISO) => weekOf(dateISO, weekStartOf(league));

  const weekEnd = (weekISO) => { const d = dateOf(weekISO); d.setUTCDate(d.getUTCDate() + 6); return isoOf(d); };

  // Breaks: schedule rows marked "no league play required" (leagues.details.schedule[].optional —
  // a holiday fortnight, say). A league week that falls wholly inside one is `off`: a team may
  // still play it, but not playing is never a missed week and nobody is chased for it.
  // Catch-up weeks (schedule[].catchup): a break with no course of its own. A round played in one
  // only ever counts for an earlier week the team missed; a team that is up to date plays nothing.
  function breakRanges(league) {
    const rows = league && league.details && Array.isArray(league.details.schedule) ? league.details.schedule : [];
    return rows.filter((r) => r && (r.optional || r.catchup) && r.from)
      .map((r) => ({ from: String(r.from), to: String(r.to || r.from), catchup: !!r.catchup }));
  }

  // Every week of the season: { start, end, number } (+ off: true on a break). A season that runs Wed–Wed counts the
  // part weeks at each end, because a team can play in them.
  function weeks(league) {
    if (!league || !league.season_start || !league.season_end) return [];
    const out = [], last = weekIn(league, league.season_end), breaks = breakRanges(league);
    let w = weekIn(league, league.season_start);
    for (let i = 0; w <= last && i < MAX_WEEKS; i++) {
      const end = weekEnd(w);
      // `off` is only present on a break week, so a league with no breaks reads exactly as before.
      const br = breaks.find((b) => w >= b.from && end <= b.to);
      out.push({ start: w, end, number: i + 1, ...(br ? { off: true } : {}), ...(br && br.catchup ? { catchup: true } : {}) });
      const d = dateOf(w); d.setUTCDate(d.getUTCDate() + 7); w = isoOf(d);
    }
    return out;
  }

  // The week todayISO falls in, or null when the season has not started or is over.
  function currentWeek(league, todayISO) {
    return weeks(league).find((w) => w.start === weekIn(league, todayISO)) || null;
  }

  // "Week 3 of 22": weeks gone, weeks in the season, weeks still to come. The current week counts
  // as still to come until it ends — the team can still play it.
  function progress(league, todayISO) {
    const all = weeks(league);
    const played = all.filter((w) => w.end < todayISO).length;
    return { played, total: all.length, left: all.length - played };
  }

  // The league week a round COUNTS for. Normally the week it is played in; a make-up round
  // (bookings.league_for_week, migration 0042) says which earlier week it stands in for.
  function roundWeek(league, r) {
    if (!r) return null;
    if (r.league_for_week) return weekIn(league, r.league_for_week);
    return r.booking_date ? weekIn(league, r.booking_date) : (r.league_week || null);
  }

  /* ----- The league's key dates and switches (leagues.details.dates) -----
     Set by the manager on the league form; every one is optional, and a league that sets none
     behaves exactly as it always has.
       regularEnd      last day a regular-season round may be played (the deadline)
       playoffsStart   first day of the playoffs — substitutes may not play from here on
       rosterLockWeek  rosters lock at the end of this week of the season (4 = after week 4)
       feesFirst       a team must have paid in full before it books a league round
       qualifiersEnd   last day a round may be played for any week that ends on or before it — after
                       it, those weeks are closed for good (the managers split the divisions then)
       playoffMakeups  rounds missed before the playoffs may still be made up during them, up to
                       the end of the season (without it, the playoffs play only playoff weeks)
     rosterLockOn is worked out: the last day of week `rosterLockWeek`. */
  const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(`${v}T00:00:00Z`)) ? String(v) : null);
  function leagueDates(league) {
    const d = league && league.details && league.details.dates && typeof league.details.dates === 'object' ? league.details.dates : {};
    const all = weeks(league), n = Math.floor(Number(d.rosterLockWeek));
    const lock = n >= 1 && n <= all.length ? all[n - 1] : null;
    return { regularEnd: isoDay(d.regularEnd), playoffsStart: isoDay(d.playoffsStart),
      rosterLockWeek: lock ? n : null, rosterLockOn: lock ? lock.end : null, feesFirst: d.feesFirst === true,
      qualifiersEnd: isoDay(d.qualifiersEnd), playoffMakeups: d.playoffMakeups === true };
  }
  // Are rosters locked on todayISO? (No lock week set = never.)
  const rosterLocked = (league, todayISO) => { const k = leagueDates(league); return !!(k.rosterLockOn && todayISO > k.rosterLockOn); };
  // Is dateISO in the playoffs? (No playoff date set = no.)
  const inPlayoffs = (league, dateISO) => { const k = leagueDates(league); return !!(k.playoffsStart && dateISO >= k.playoffsStart); };

  // WHICH WEEK WOULD A LEAGUE ROUND ON dateISO COUNT FOR? Rounds are played in order: the earliest
  // week the team has not played, up to the week of the date itself — so a team that missed week 5
  // plays week 5 next, then week 6, and a team that is up to date plays this week's and no more.
  //   weeks   that team's season from teamWeeks() (each week with its `round`, if it has one)
  // → { ok:true, week, makeup }                       makeup: it counts for an EARLIER week
  //   { ok:false, code:'round_booked', existing, week, playedIn }   nothing left to play: here is this
  //                                                   week's round (playedIn: the later week it is
  //                                                   booked in, when it is not in this one)
  //   { ok:false, code:'after_deadline', regularEnd, playoffsStart }
  //   { ok:false, code:'catchup_only' }          a catch-up week, and nothing is owed to catch up
  //   { ok:false, code:'outside_season' }
  // A break week is never owed, so it is never a make-up — but a team may still play it in that
  // week; a catch-up week has no round of its own at all. Past the regular-season deadline no
  // regular-season week can be played any more, and past qualifiersEnd no week ending by it.
  //
  // `pick` (staff only): the week start the round should count for, instead of the earliest one
  // owed — how staff book a team into a week AHEAD of time (a team away that week plays it early).
  function roundTarget({ league, weeks: list = [], dateISO, pick = null }) {
    const wk = weekIn(league, dateISO);
    if (!list.some((w) => w.start === wk)) return { ok: false, code: 'outside_season' };
    const k = leagueDates(league);
    const late = !!k.regularEnd && dateISO > k.regularEnd;
    if (late && k.playoffsStart && dateISO < k.playoffsStart) {
      return { ok: false, code: 'after_deadline', regularEnd: k.regularEnd, playoffsStart: k.playoffsStart };
    }
    // Weeks closed for good on this date: past the regular deadline, or the qualifiers' cut-off.
    const closed = (w) => (late && w.end <= k.regularEnd) || (!!k.qualifiersEnd && dateISO > k.qualifiersEnd && w.end <= k.qualifiersEnd);
    if (pick) {
      const w = list.find((x) => x.start === pick);
      if (!w) return { ok: false, code: 'outside_season' };
      if (w.catchup) return { ok: false, code: 'catchup_only' };
      if (closed(w)) return { ok: false, code: 'after_deadline', regularEnd: k.regularEnd || k.qualifiersEnd, playoffsStart: k.playoffsStart };
      if (w.round) return { ok: false, code: 'round_booked', existing: w.round, week: w, playedIn: null };
      return { ok: true, week: w, makeup: w.start !== wk, ...(w.start > wk ? { early: true } : {}) };
    }
    // In the playoffs only playoff weeks are played (nothing from before them is made up), unless
    // the league lets missed rounds be caught up into the playoffs (playoffMakeups).
    const poWeek = k.playoffsStart && dateISO >= k.playoffsStart && !k.playoffMakeups ? weekIn(league, k.playoffsStart) : null;
    const open = list.filter((w) => w.start <= wk && !w.round && (!w.off || (w.start === wk && !w.catchup))
      && !closed(w) && !(poWeek && w.start < poWeek));
    if (open.length) return { ok: true, week: open[0], makeup: open[0].start !== wk };
    const here = list.find((w) => w.start === wk);
    if (here.catchup) return { ok: false, code: 'catchup_only' };
    if (late && !here.round) return { ok: false, code: 'after_deadline', regularEnd: k.regularEnd, playoffsStart: k.playoffsStart };
    // This week's round may be a booking on a LATER date standing in for it (booked ahead, so it
    // took the earliest unplayed week). playedIn says which week that booking is really in, so the
    // team can be told to move it if they want to play this week's round this week.
    const r = here.round || null;
    const at = r && r.booking_date ? list.find((w) => w.start === weekIn(league, r.booking_date)) : null;
    return { ok: false, code: 'round_booked', existing: r, week: here, playedIn: at && at.start !== here.start ? at : null };
  }

  // One team's season: every week, and what they did with it.
  //   { start, end, number, current, past, round, missed }
  // `rounds` are that team's league bookings: [{ league_week, booking_date, start_min, end_min,
  // bay_id, status }]. A week in the past with no round is `missed` — the list staff chase.
  function teamWeeks({ league, todayISO, rounds = [] }) {
    const thisWeek = weekIn(league, todayISO);
    const byWeek = new Map();
    // Filed by the day it was played, not by a stored league_week: the stored one only catches up
    // with a changed start day once migration 0040's trigger has re-stamped it.
    rounds.filter((r) => r && r.status !== 'cancelled')
      .forEach((r) => { const k = roundWeek(league, r); if (k && !byWeek.has(k)) byWeek.set(k, r); });
    return weeks(league).map((w) => {
      const round = byWeek.get(w.start) || null;
      const past = w.end < todayISO;
      return { ...w, current: w.start === thisWeek, past, round, missed: past && !round && !w.off };
    });
  }

  // Who has not booked their round for the week todayISO is in. Staff use this to chase teams;
  // it only lists weeks the season is actually running.
  //   teams   [{ id, name }]
  //   rounds  every league booking in the league: [{ league_team_id, league_week, status }]
  function teamsWithoutRound({ league, todayISO, teams = [], rounds = [] }) {
    const week = currentWeek(league, todayISO);
    if (!week || week.off) return [];                       // a break: nobody is behind
    const booked = new Set(rounds.filter((r) => r && r.status !== 'cancelled' && roundWeek(league, r) === week.start)
      .map((r) => r.league_team_id));
    return teams.filter((t) => !booked.has(t.id));
  }

  // How many weeks a team has missed so far — past weeks of the season with no round.
  function missedWeeks({ league, todayISO, rounds = [] }) {
    return teamWeeks({ league, todayISO, rounds }).filter((w) => w.missed).length;
  }

  // 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st
  function ordinal(n) {
    const v = n % 100, s = ['th', 'st', 'nd', 'rd'];
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Is the season still running (or yet to start) on todayISO? An active league with no end date
  // counts as running.
  function isCurrent(league, todayISO) {
    if (!league || league.is_active === false) return false;
    return !league.season_end || league.season_end >= todayISO;
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  // Standings. Team leagues rank teams, individual leagues rank players.
  //   points  — most total points wins.
  //   strokes — lowest AVERAGE wins, because a player who misses a night should not win by it.
  // Anyone who has not played yet sits below everyone who has. Equal scores share a rank.
  //
  //   league   { team_mode, scoring }
  //   teams    [{ id, name }]
  //   members  [{ customer_id, name, team_id, status }]
  //   results  [{ team_id, customer_id, score, played_on }]
  function standings({ league, teams = [], members = [], results = [] }) {
    const teamMode = !!league.team_mode, lowWins = league.scoring === 'strokes';
    const rows = new Map();
    const add = (key, name) => { if (key && !rows.has(key)) rows.set(key, { key, name: name || '—', played: 0, total: 0, best: null }); };
    if (teamMode) teams.forEach((t) => add(t.id, t.name));
    else members.filter((m) => m.status !== 'left').forEach((m) => add(m.customer_id, m.name));

    for (const r of results) {
      const key = teamMode ? r.team_id : r.customer_id;
      if (!key) continue;
      if (!rows.has(key)) {   // a team since deleted, or a player who left: their results still count
        const who = teamMode ? teams.find((t) => t.id === key) : members.find((m) => m.customer_id === key);
        add(key, who && who.name);
      }
      const row = rows.get(key), s = Number(r.score);
      if (!Number.isFinite(s)) continue;
      row.played += 1;
      row.total += s;
      row.best = row.best == null ? s : (lowWins ? Math.min(row.best, s) : Math.max(row.best, s));
    }

    const list = [...rows.values()].map((r) => ({
      ...r, total: round2(r.total), average: r.played ? round2(r.total / r.played) : null,
    }));
    const metric = (r) => (lowWins ? r.average : r.total);
    list.sort((a, b) =>
      (b.played > 0) - (a.played > 0)
      || (a.played && b.played ? (lowWins ? metric(a) - metric(b) : metric(b) - metric(a)) : 0)
      || String(a.name).localeCompare(String(b.name)));

    let prev = null;
    list.forEach((r, i) => {
      r.rank = (prev && r.played && prev.played && metric(r) === metric(prev)) ? prev.rank : i + 1;
      prev = r;
    });
    return list;
  }

  // "Murad C." — how a player appears to other players. Staff see full names in the portal.
  function publicName(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'Player';
    return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  }

  // ----- Paying seat by seat (migration 0036) -----
  //
  // The team price is shared across the team's SEATS — the size the captain picked, between the
  // league's team_min and team_size. One seat costs the price ÷ seats, rounded UP to the cent, so
  // the venue never collects less than the team price. Seats nobody pays for are owed by the captain.

  // The team sizes a captain may pick, or null for a league with no maximum (the captain then pays
  // the whole price, as before 0036).
  function seatRange(league) {
    const max = Math.floor(Number(league && league.team_size)) || 0;
    if (!(max > 0)) return null;
    const min = Math.min(max, Math.max(1, Math.floor(Number(league.team_min)) || max));
    return { min, max };
  }

  function shareOf(feeCents, seats) {
    const fee = Math.max(0, Math.round(Number(feeCents) || 0)), n = Math.floor(Number(seats)) || 0;
    return fee > 0 && n > 0 ? Math.ceil(fee / n) : 0;
  }

  // Where one team stands on money. `payments` are league_seat_payments rows, `members` the
  // league_members rows, `invites` the league_team_invites rows — any of the league's, filtered here.
  //   paidSeats    seats somebody has paid for (never more than the team has)
  //   freeSeats    paid seats nobody sits in yet — the next friend to join takes one for nothing
  //   unpaidSeats  seats nobody has paid for; owedCents is what the captain owes for them
  //   due          owed AND the season has started: this is when staff are told to collect
  function teamMoney({ league, team, payments = [], members = [], invites = [], todayISO }) {
    const seats = Math.floor(Number(team && team.seats)) || 0;
    const share = Math.max(0, Math.round(Number(team && team.share_cents) || 0));
    const split = seats > 0 && share > 0;
    const paid = payments.filter((p) => p.team_id === team.id).reduce((s, p) => s + (Math.floor(Number(p.seats)) || 0), 0);
    const paidSeats = split ? Math.min(seats, paid) : 0;
    // Substitutes (role 'sub', migration 0041) take no seat, and neither do invites to be one.
    const players = members.filter((m) => m.team_id === team.id && m.status === 'active' && m.role !== 'sub').length;
    const openInvites = invites.filter((i) => i.team_id === team.id && i.role !== 'sub' && !i.claimed_at && !i.revoked_at).length;
    const unpaidSeats = split ? Math.max(0, seats - paidSeats) : 0;
    const owedCents = unpaidSeats * share;
    const started = !league || !league.season_start || !todayISO || league.season_start <= todayISO;
    return {
      split, seats, shareCents: share, paidSeats, players, openInvites,
      freeSeats: split ? Math.max(0, paidSeats - players) : 0,
      emptySeats: seats ? Math.max(0, seats - players - openInvites) : 0,
      unpaidSeats, owedCents, due: owedCents > 0 && started,
    };
  }

  /* ----- League info: what the printed brochure says (migration 0039, leagues.details) -----
     About, member perks, who can play, format & rules, the league settings table, featured challenges, the
     week-by-week schedule with a note per week, a notice under it, team awards and the grand prize. One shape and one clean-up, used by the manager's form, the customer page and the
     server — so nothing oversized or malformed is ever saved or shown. Lists come in as arrays or
     as text with one item per line; a leading bullet is dropped, so a pasted brochure line works. */
  const INFO_LIMITS = { about: 2000, prize: 2000, notice: 800, items: 60, item: 200, weeks: 60, note: 240,
    ruleSections: 30, ruleLines: 30, rule: 600 };
  function normalizeDetails(raw) {
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const line = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
    const para = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
    const list = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split('\n'))
      .map((x) => line(String(x == null ? '' : x).replace(/^\s*[•·\-*–—]+\s*/, ''), INFO_LIMITS.item)).filter(Boolean).slice(0, INFO_LIMITS.items);
    // "Setting: value" rows — the league settings table. Given as [{ label, value }] or as text,
    // one per line, split at the first colon. A line with no colon is a row with a label only.
    const settings = (Array.isArray(d.settings) ? d.settings : String(d.settings == null ? '' : d.settings).split('\n')).map((x) => {
      if (x && typeof x === 'object') return { label: line(x.label, 60), value: line(x.value, INFO_LIMITS.item) };
      const t = String(x == null ? '' : x).replace(/^\s*[•·\-*–—]+\s*/, ''), i = t.indexOf(':');
      return i < 0 ? { label: line(t, 60), value: '' } : { label: line(t.slice(0, i), 60), value: line(t.slice(i + 1), INFO_LIMITS.item) };
    }).filter((r) => r.label).slice(0, INFO_LIMITS.items);
    // The official rules: numbered sections, each a heading and its rules. Given as
    // [{ title, lines }] or as text the manager types or pastes — a line that starts with a number
    // and a dot ("3. Team Rosters") or with # is a heading, every other line is a rule under the
    // heading above it. Lines before the first heading are the introduction (a section with no title).
    const rules = [];
    if (Array.isArray(d.rules)) {
      d.rules.forEach((x) => {
        const o = x && typeof x === 'object' ? x : {};
        rules.push({ title: line(o.title, 120), lines: (Array.isArray(o.lines) ? o.lines : []).map((l) => line(l, INFO_LIMITS.rule)).filter(Boolean).slice(0, INFO_LIMITS.ruleLines) });
      });
    } else {
      String(d.rules == null ? '' : d.rules).split('\n').forEach((raw) => {
        const t = line(raw, INFO_LIMITS.rule);
        if (!t) return;
        const head = /^(?:#+\s*|\d{1,2}[.)]\s+)(.+)$/.exec(t);
        if (head) rules.push({ title: line(head[1], 120), lines: [] });
        else {
          if (!rules.length) rules.push({ title: '', lines: [] });
          const cur = rules[rules.length - 1];
          if (cur.lines.length < INFO_LIMITS.ruleLines) cur.lines.push(t.replace(/^\s*[•·\-*–—]+\s*/, ''));
        }
      });
    }
    const ruleSections = rules.filter((r) => r.title || r.lines.length).slice(0, INFO_LIMITS.ruleSections);
    // Key dates and switches (see leagueDates). Only what was actually set is kept, so a league
    // with none of them has no `dates` at all and reads exactly as before.
    const kd = d.dates && typeof d.dates === 'object' && !Array.isArray(d.dates) ? d.dates : {};
    const lockN = Math.floor(Number(kd.rosterLockWeek));
    const dates = { ...(isoDay(kd.regularEnd) ? { regularEnd: isoDay(kd.regularEnd) } : {}),
      ...(isoDay(kd.playoffsStart) ? { playoffsStart: isoDay(kd.playoffsStart) } : {}),
      ...(lockN >= 1 && lockN <= MAX_WEEKS ? { rosterLockWeek: lockN } : {}),
      ...(kd.feesFirst === true || kd.feesFirst === 'true' ? { feesFirst: true } : {}),
      ...(isoDay(kd.qualifiersEnd) ? { qualifiersEnd: isoDay(kd.qualifiersEnd) } : {}),
      ...(kd.playoffMakeups === true || kd.playoffMakeups === 'true' ? { playoffMakeups: true } : {}) };
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(`${v}T00:00:00Z`)) ? String(v) : null);
    const schedule = (Array.isArray(d.schedule) ? d.schedule : []).map((w) => {
      const x = w && typeof w === 'object' ? w : {};
      let from = date(x.from), to = date(x.to);
      if (from && to && to < from) to = from;
      return { from, to, phase: line(x.phase, 60), event: line(x.event, 80), course: line(x.course, 120), location: line(x.location, 120),
        note: line(x.note, INFO_LIMITS.note), ...(x.optional === true || x.optional === 'true' ? { optional: true } : {}),
        ...(x.catchup === true || x.catchup === 'true' ? { catchup: true } : {}) };
    }).filter((w) => w.from || w.event || w.course || w.note).slice(0, INFO_LIMITS.weeks);
    return { about: para(d.about, INFO_LIMITS.about), perks: list(d.perks), eligibility: list(d.eligibility), format: list(d.format), rules: ruleSections, settings,
      challenges: list(d.challenges), schedule, notice: para(d.notice, INFO_LIMITS.notice),
      awards: list(d.awards), prize: para(d.prize, INFO_LIMITS.prize),
      ...(Object.keys(dates).length ? { dates } : {}),
      ...(normalizeStages(d.stages) ? { stages: normalizeStages(d.stages) } : {}) };
  }
  // The rules back as the text the manager edits: "1. Heading", its rules one per line, a blank
  // line between sections. normalizeDetails({ rules: rulesText(x) }) gives x back.
  function rulesText(rules) {
    let n = 0;
    return (rules || []).map((r) => [r.title ? `${++n}. ${r.title}` : null, ...(r.lines || [])].filter((x) => x != null).join('\n')).join('\n\n');
  }
  function hasDetails(raw) {
    const d = normalizeDetails(raw);
    return !!(d.about || d.prize || d.notice || d.perks.length || d.eligibility.length || d.format.length || d.rules.length || d.settings.length
      || d.challenges.length || d.schedule.length || d.awards.length);
  }
  // "Nov 1 – 7", "Nov 29 – Dec 5", "Dec 27 – Jan 2". Dates are plain calendar days, never shifted
  // by a time zone.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateRangeLabel(from, to) {
    const p = (iso) => { const [, m, d] = String(iso).split('-').map(Number); return { m, d }; };
    if (!from) return '';
    const a = p(from);
    if (!to || to === from) return `${MON[a.m - 1]} ${a.d}`;
    const b = p(to);
    return a.m === b.m ? `${MON[a.m - 1]} ${a.d} – ${b.d}` : `${MON[a.m - 1]} ${a.d} – ${MON[b.m - 1]} ${b.d}`;
  }
  // The schedule as the brochure prints it: consecutive weeks under the same phase heading.
  function schedulePhases(schedule) {
    const out = [];
    (schedule || []).forEach((w) => {
      const last = out[out.length - 1];
      if (last && last.phase === (w.phase || '')) last.weeks.push(w);
      else out.push({ phase: w.phase || '', weeks: [w] });
    });
    return out;
  }

  /* ----- A staged season (leagues.details.stages) — the 2026-27 Winter League's format -----
       qualifiers  [from, to]  weeks scored by placing: each week, lowest strokes first, points by place
       ranking     [from, to]  weeks whose average strokes seed the playoffs (bragging rights)
       playoffs    [from, to]  weeks whose average strokes, averaged with the ranking one, decide it
       points      [[upToPlace, points], …]  1st 100, 2nd 98 … 61st–100th 50
     After the qualifiers the managers put each team in a division (league_teams.division); from then
     each division is a league of its own. A league without `stages` is scored by standings(). */
  const QUAL_POINTS = [[1, 100], [2, 98], [3, 96], [4, 94], [5, 92], [10, 90], [15, 85], [20, 80], [25, 75],
    [30, 70], [40, 65], [50, 60], [60, 55], [100, 50]];
  function normalizeStages(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const span = (v) => { const a = Math.floor(Number(v && v[0])), b = Math.floor(Number(v && v[1]));
      return a >= 1 && b >= a && b <= MAX_WEEKS ? [a, b] : null; };
    const qualifiers = span(raw.qualifiers), ranking = span(raw.ranking), playoffs = span(raw.playoffs);
    if (!qualifiers || !ranking || !playoffs) return null;
    const pts = (Array.isArray(raw.points) ? raw.points : QUAL_POINTS)
      .map((r) => [Math.floor(Number(r && r[0])), Number(r && r[1])])
      .filter(([u, p]) => u >= 1 && Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
    return { qualifiers, ranking, playoffs, points: pts.length ? pts : QUAL_POINTS };
  }
  const pointsFor = (st, place) => { for (const [upTo, pts] of st.points) if (place <= upTo) return pts; return 0; };
  // Competition ranking (1, 2, 2, 4) over a list already in order; `same(a, b)` says two share a place.
  const placeRows = (list, same) => { let place = 0; return list.map((r, i) => {
    if (i === 0 || !same(list[i - 1], r)) place = i + 1; return { ...r, rank: place }; }); };
  const avgOf = (vals) => (vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null);

  //   teams    [{ id, name, division?, tiebreak_strokes? }]
  //   results  league_results rows [{ team_id, score, played_on }] — filed under the week they count for
  // → null when the league has no stages, else
  //   { phase: 'qualifiers' | 'divisions', qualifiers: { weeks, closed, rows }, divisions: [{ division,
  //     seeding, standings, dnf }], undivided, seasonOver }
  function stagedStandings({ league, teams = [], results = [], todayISO }) {
    const st = normalizeStages(league && league.details && league.details.stages);
    if (!st) return null;
    const all = weeks(league), numOf = new Map(all.map((w) => [w.start, w.number]));
    const k = leagueDates(league);
    const qualClosed = !!k.qualifiersEnd && !!todayISO && todayISO > k.qualifiersEnd;
    const seasonOver = !!league.season_end && !!todayISO && todayISO > league.season_end;
    const inSpan = (n, [a, b]) => n >= a && n <= b;
    const playable = (span) => all.filter((w) => inSpan(w.number, span) && !w.off).map((w) => w.number);
    const qWeeks = playable(st.qualifiers), rWeeks = playable(st.ranking), pWeeks = playable(st.playoffs);

    // strokes[teamId] → Map(week number → strokes); one score a team a week.
    const strokes = new Map(teams.map((t) => [t.id, new Map()]));
    for (const r of results) {
      const m = r && strokes.get(r.team_id), n = r && numOf.get(weekIn(league, r.played_on)), s = Number(r && r.score);
      if (m && n && Number.isFinite(s) && !m.has(n)) m.set(n, s);
    }

    // Qualifiers: each week placed by strokes, points by place. A team with no round that week has
    // nothing yet while the week can still be caught up; once the qualifiers close it takes the place
    // after everyone who did play — last-place points.
    const weekly = new Map(qWeeks.map((n) => {
      const played = teams.filter((t) => strokes.get(t.id).has(n)).map((t) => ({ id: t.id, s: strokes.get(t.id).get(n) }))
        .sort((a, b) => a.s - b.s);
      const m = new Map(placeRows(played, (a, b) => a.s === b.s).map((p) => [p.id, { strokes: p.s, place: p.rank, points: pointsFor(st, p.rank) }]));
      // Nobody at all has a result for the week: the scores were never entered — not a week every
      // team missed — so nobody is given last place for it.
      if (qualClosed && played.length) {
        const last = played.length + 1;
        teams.forEach((t) => { if (!m.has(t.id)) m.set(t.id, { strokes: null, place: last, points: pointsFor(st, last), missed: true }); });
      }
      return [n, m];
    }));
    const qualRows = placeRows(teams.map((t) => {
      const wk = qWeeks.map((n) => ({ week: n, ...(weekly.get(n).get(t.id) || { pending: true }) }));
      return { key: t.id, name: t.name, division: t.division || null, weeks: wk,
        played: wk.filter((x) => x.strokes != null).length, total: wk.reduce((sum, x) => sum + (x.points || 0), 0) };
    }).sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name))), (a, b) => a.total === b.total);

    // Divisions: a league of their own from the ranking weeks on.
    const divisionNos = [...new Set(teams.map((t) => t.division).filter((d) => d))].sort((a, b) => a - b);
    const divisions = divisionNos.map((d) => {
      const rows = teams.filter((t) => t.division === d).map((t) => {
        const m = strokes.get(t.id), r = rWeeks.filter((n) => m.has(n)), p = pWeeks.filter((n) => m.has(n));
        const rankingAvg = avgOf(r.map((n) => m.get(n))), playoffAvg = avgOf(p.map((n) => m.get(n)));
        const tb = Number(t.tiebreak_strokes);
        return { key: t.id, name: t.name, rankingAvg, rankingPlayed: r.length, playoffAvg, playoffPlayed: p.length,
          final: rankingAvg != null && playoffAvg != null ? round2((rankingAvg + playoffAvg) / 2) : null,
          complete: r.length === rWeeks.length && p.length === pWeeks.length,
          ...(t.tiebreak_strokes != null && Number.isFinite(tb) ? { tiebreak: tb } : {}) };
      });
      const byNull = (x) => (x == null ? Infinity : x);
      const seeding = placeRows([...rows].sort((a, b) => byNull(a.rankingAvg) - byNull(b.rankingAvg) || String(a.name).localeCompare(String(b.name))),
        (a, b) => a.rankingAvg != null && a.rankingAvg === b.rankingAvg);
      // Once the season is over a team that missed any week from the ranking weeks on did not finish.
      const finishers = seasonOver ? rows.filter((r) => r.complete) : rows;
      const dnf = seasonOver ? rows.filter((r) => !r.complete).sort((a, b) => String(a.name).localeCompare(String(b.name))) : [];
      // Lowest final wins. Equal finals: for a top-three place the teams play it off (tiebreak strokes,
      // lowest first; until entered they are flagged); below that the better playoff average wins.
      const sorted = [...finishers].sort((a, b) => byNull(a.final) - byNull(b.final) || String(a.name).localeCompare(String(b.name)));
      const out = []; let i = 0;
      while (i < sorted.length) {
        let j = i; while (j + 1 < sorted.length && sorted[j + 1].final != null && sorted[j + 1].final === sorted[i].final) j++;
        const group = sorted.slice(i, j + 1), place = i + 1;
        if (group.length > 1 && place <= 3) {
          const settled = group.every((g) => g.tiebreak != null) && new Set(group.map((g) => g.tiebreak)).size === group.length;
          if (settled) group.sort((a, b) => a.tiebreak - b.tiebreak).forEach((g, x) => out.push({ ...g, rank: place + x, wonTiebreak: true }));
          else group.forEach((g) => out.push({ ...g, rank: place, tie: 'playoff' }));
        } else if (group.length > 1) {
          placeRows(group.sort((a, b) => byNull(a.playoffAvg) - byNull(b.playoffAvg)), (a, b) => a.playoffAvg === b.playoffAvg)
            .forEach((g) => out.push({ ...g, rank: place + g.rank - 1, ...(group.filter((h) => h.playoffAvg === g.playoffAvg).length > 1 ? { tie: 'shared' } : {}) }));
        } else out.push({ ...group[0], rank: place });
        i = j + 1;
      }
      return { division: d, seeding, standings: out, dnf };
    });
    return {
      phase: divisions.length ? 'divisions' : 'qualifiers',
      qualifiers: { weeks: qWeeks, closed: qualClosed, rows: qualRows },
      divisions,
      undivided: divisions.length ? teams.filter((t) => !t.division).map((t) => ({ key: t.id, name: t.name })) : [],
      seasonOver, weeksOf: { ranking: rWeeks, playoffs: pWeeks },
    };
  }

  root.InvictusLeagues = { DAY_NAMES, timeLabel, scheduleLabel, weekOf, weeks, currentWeek, progress,
    teamWeeks, teamsWithoutRound, missedWeeks, ordinal, isCurrent, standings, publicName,
    seatRange, shareOf, teamMoney, normalizeDetails, hasDetails, dateRangeLabel, schedulePhases,
    weekIn, weekStartOf, rulesText, roundWeek, leagueDates, rosterLocked, inPlayoffs, roundTarget,
    normalizeStages, stagedStandings, QUAL_POINTS };
})(typeof window !== 'undefined' ? window : globalThis);
