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

  // The Monday of that date's week. Matches Postgres date_trunc('week'), which generates
  // bookings.league_week — the column the "one round per team per week" rule is built on, so these
  // two must agree exactly.
  function weekOf(dateISO) {
    const d = dateOf(dateISO);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // Sunday(0) goes back 6, Monday(1) back 0
    return isoOf(d);
  }

  const weekEnd = (weekISO) => { const d = dateOf(weekISO); d.setUTCDate(d.getUTCDate() + 6); return isoOf(d); };

  // Every week of the season: { start, end, number }. A season that runs Wed–Wed counts the part
  // weeks at each end, because a team can play in them.
  function weeks(league) {
    if (!league || !league.season_start || !league.season_end) return [];
    const out = [], last = weekOf(league.season_end);
    let w = weekOf(league.season_start);
    for (let i = 0; w <= last && i < MAX_WEEKS; i++) {
      out.push({ start: w, end: weekEnd(w), number: i + 1 });
      const d = dateOf(w); d.setUTCDate(d.getUTCDate() + 7); w = isoOf(d);
    }
    return out;
  }

  // The week todayISO falls in, or null when the season has not started or is over.
  function currentWeek(league, todayISO) {
    return weeks(league).find((w) => w.start === weekOf(todayISO)) || null;
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
    const thisWeek = weekOf(todayISO);
    const byWeek = new Map();
    rounds.filter((r) => r && r.status !== 'cancelled')
      .forEach((r) => { const k = r.league_week || weekOf(r.booking_date); if (k && !byWeek.has(k)) byWeek.set(k, r); });
    return weeks(league).map((w) => {
      const round = byWeek.get(w.start) || null;
      const past = w.end < todayISO;
      return { ...w, current: w.start === thisWeek, past, round, missed: past && !round };
    });
  }

  // Who has not booked their round for the week todayISO is in. Staff use this to chase teams;
  // it only lists weeks the season is actually running.
  //   teams   [{ id, name }]
  //   rounds  every league booking in the league: [{ league_team_id, league_week, status }]
  function teamsWithoutRound({ league, todayISO, teams = [], rounds = [] }) {
    const week = currentWeek(league, todayISO);
    if (!week) return [];
    const booked = new Set(rounds.filter((r) => r && r.status !== 'cancelled' && r.league_week === week.start)
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

  root.InvictusLeagues = { DAY_NAMES, timeLabel, scheduleLabel, weekOf, weeks, currentWeek, progress,
    teamWeeks, teamsWithoutRound, missedWeeks, ordinal, isCurrent, standings, publicName };
})(typeof window !== 'undefined' ? window : globalThis);
