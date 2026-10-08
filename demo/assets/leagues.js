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
  function breakRanges(league) {
    const rows = league && league.details && Array.isArray(league.details.schedule) ? league.details.schedule : [];
    return rows.filter((r) => r && r.optional && r.from).map((r) => ({ from: String(r.from), to: String(r.to || r.from) }));
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
      out.push({ start: w, end, number: i + 1, ...(breaks.some((b) => w >= b.from && end <= b.to) ? { off: true } : {}) });
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
      .forEach((r) => { const k = r.booking_date ? weekIn(league, r.booking_date) : r.league_week; if (k && !byWeek.has(k)) byWeek.set(k, r); });
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
    const booked = new Set(rounds.filter((r) => r && r.status !== 'cancelled'
      && (r.booking_date ? weekIn(league, r.booking_date) : r.league_week) === week.start)
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
    const players = members.filter((m) => m.team_id === team.id && m.status === 'active').length;
    const openInvites = invites.filter((i) => i.team_id === team.id && !i.claimed_at && !i.revoked_at).length;
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
  const INFO_LIMITS = { about: 2000, prize: 2000, notice: 800, items: 60, item: 200, weeks: 60, note: 240 };
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
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(`${v}T00:00:00Z`)) ? String(v) : null);
    const schedule = (Array.isArray(d.schedule) ? d.schedule : []).map((w) => {
      const x = w && typeof w === 'object' ? w : {};
      let from = date(x.from), to = date(x.to);
      if (from && to && to < from) to = from;
      return { from, to, phase: line(x.phase, 60), event: line(x.event, 80), course: line(x.course, 120), location: line(x.location, 120),
        note: line(x.note, INFO_LIMITS.note), ...(x.optional === true || x.optional === 'true' ? { optional: true } : {}) };
    }).filter((w) => w.from || w.event || w.course || w.note).slice(0, INFO_LIMITS.weeks);
    return { about: para(d.about, INFO_LIMITS.about), perks: list(d.perks), eligibility: list(d.eligibility), format: list(d.format), settings,
      challenges: list(d.challenges), schedule, notice: para(d.notice, INFO_LIMITS.notice),
      awards: list(d.awards), prize: para(d.prize, INFO_LIMITS.prize) };
  }
  function hasDetails(raw) {
    const d = normalizeDetails(raw);
    return !!(d.about || d.prize || d.notice || d.perks.length || d.eligibility.length || d.format.length || d.settings.length
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

  root.InvictusLeagues = { DAY_NAMES, timeLabel, scheduleLabel, weekOf, weeks, currentWeek, progress,
    teamWeeks, teamsWithoutRound, missedWeeks, ordinal, isCurrent, standings, publicName,
    seatRange, shareOf, teamMoney, normalizeDetails, hasDetails, dateRangeLabel, schedulePhases,
    weekIn, weekStartOf };
})(typeof window !== 'undefined' ? window : globalThis);
