import { stripeStatus, stripeClient, normalizeSettings, winnipegTodayISO } from '../lib/booking.js';
import { getSettings, admin, listPublicLeagues, leagueById, joinLeague, confirmLeagueCheckout, leaguesForCustomer,
         customerHoursByContact, isLeaguePlayer, normPhone, accountCustomerForRequest, staffContext,
         listTeamLeagues, teamLeagueById, leagueTeamById, createLeagueTeam, confirmLeagueTeamCheckout,
         createTeamInvite, teamInviteByToken, claimTeamInvite, teamsForCustomer, MIGRATION_0031 } from '../lib/db.js';
import { notifyTeamInvite } from '../lib/notify.js';

// Leagues, for customers. One function, dispatched on ?action=, to keep the serverless function
// count down (Vercel's limit is 12 and this project is already near it).
//
// SINCE MIGRATION 0031 A LEAGUE IS SOLD BY THE TEAM. One captain pays one price for the whole
// team, invites friends by phone number, and the team plays once a week whenever it likes — a free
// booking made from the ordinary booking page (api/booking.js ?action=league-round).
//
//   POST ?action=list           (public)        leagues you can buy a team in
//   POST ?action=buy-team       (signed in)     { leagueId, teamName } → Stripe Checkout, or a free team
//   POST ?action=invite         (captain/staff) { teamId, phone, name? } → the link to send a friend
//   POST ?action=invite-info    (public)        { token } → whose team, and is it still open
//   POST ?action=invite-claim   (signed in)     { token } → you're on the team
//   POST ?action=my-teams       (signed in)     the teams you play for: roster, weeks, standings
//   POST ?action=confirm        { sessionId }   the success page; the Stripe webhook does the same
//   POST ?action=window         (optional auth) how far ahead this visitor may book
//
// The 0028 per-player sign-up (?action=join, ?action=mine) is still here for leagues created under
// the old model; new leagues are bought a team at a time through buy-team.
//
// IDENTITY. Everything below that speaks for a customer starts from accountCustomerForRequest():
// a My Account session token, or the localhost dev account the dev server sets itself. A phone
// number in the body says who to text, never who is asking.
//
// Staff manage leagues in the portal directly against the database (RLS, booking.write).
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());
const isUuid = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(s || ''));

// Where an invite link points. Same order as api/waitlist.js and api/staff.js: an explicit
// setting, then PUBLIC_BASE_URL, then the request's own origin — so a local run links to
// localhost and production links to production with nothing to configure.
function inviteLink(req, token) {
  const env = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  const origin = env || (req.headers && req.headers.origin) || (() => {
    const h = req.headers || {};
    const host = h['x-forwarded-host'] || h.host;
    if (!host) return '';
    const proto = h['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
  })();
  return origin ? `${String(origin).replace(/\/+$/, '')}/leagues?invite=${encodeURIComponent(token)}` : null;
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  try {
    if (action === 'list' || (req.method === 'GET' && !action)) return await list(req, res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (action === 'buy-team') return await buyTeam(req, res);
    if (action === 'invite') return await invite(req, res);
    if (action === 'invite-info') return await inviteInfo(req, res);
    if (action === 'invite-claim') return await inviteClaim(req, res);
    if (action === 'my-teams') return await myTeams(req, res);
    if (action === 'join') return await join(req, res);
    if (action === 'confirm') return await confirm(req, res);
    if (action === 'mine' || action === 'window') return await signedIn(req, res, action);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`leagues?action=${action}:`, err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again, or call the shop.' });
  }
}

// ----- The team model (migration 0031) -------------------------------------------------

// Public. A signed-in visitor also gets myTeamId, so the page can say "your team" instead of
// offering to sell them a second one.
async function list(req, res) {
  const me = await accountCustomerForRequest(req);
  const r = await listTeamLeagues({ customerId: me ? me.id : null });
  if (r.error) return res.status(r.code || 503).json({ ok: false, error: r.error, leagues: [] });
  return res.status(200).json({ ok: true, leagues: r.leagues });
}

// Buy a team. The captain is whoever is signed in — never a name or number in the body.
async function buyTeam(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to buy a team.' });
  const { leagueId, teamName } = req.body || {};
  const nm = String(teamName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!nm) return res.status(400).json({ ok: false, error: 'Give your team a name — everyone sees it on the standings.' });
  if (!admin()) return res.status(503).json({ ok: false, error: 'Leagues aren’t available right now — please call the shop.' });

  const league = await teamLeagueById(leagueId);
  if (!league || league.is_active === false || league.join_online === false) {
    return res.status(404).json({ ok: false, error: 'That league isn’t taking teams online. Please call the shop.' });
  }
  if (league.season_end && league.season_end < winnipegTodayISO()) {
    return res.status(400).json({ ok: false, error: 'That league’s season is over.' });
  }

  // Already playing in it? Say so before taking any money.
  const already = (await teamsForCustomer(me.id)).teams.find((t) => t.league.id === league.id);
  if (already) {
    return res.status(409).json({ ok: false, error: `You’re already on ${already.team.name} in this league.`, teamId: already.team.id });
  }

  // A free league: the team exists the moment they ask for it.
  if (!(league.fee_cents > 0)) {
    const r = await createLeagueTeam({ leagueId: league.id, name: nm, captainCustomerId: me.id });
    return r.error ? res.status(r.code || 400).json({ ok: false, error: r.error })
                   : res.status(200).json({ ok: true, teamId: r.teamId, free: true });
  }

  // A paid league: refuse a name that is already taken BEFORE Checkout, so nobody pays for a name
  // they cannot have. 0031's unique index is still the real guard against two captains racing.
  const clash = await teamNameTaken(league.id, nm);
  if (clash) return res.status(409).json({ ok: false, error: clash });

  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Online payment isn’t available right now — please call the shop to buy your team.' });
  const settings = normalizeSettings(await getSettings());
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const size = league.team_size ? `${league.team_size} players` : 'your team';
  // Dynamic payment methods: no payment_method_types, exactly as api/gift-cards.js does it.
  const session = await stripeClient(process.env).checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: settings.currency, unit_amount: league.fee_cents,
      product_data: { name: `${league.name} — team entry`,
        description: `One season for ${size}.${league.description ? ' ' + league.description : ''}` } } }],
    customer_email: validEmail(me.email) ? me.email : undefined,
    metadata: { kind: 'league-team', leagueId: league.id, teamName: nm, captainCustomerId: String(me.id) },
    success_url: `${origin}/leagues?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/leagues?canceled=1`,
  });
  return res.status(200).json({ ok: true, url: session.url });
}

// "Is that name free?" — asked before Checkout only. Returns the sentence to show, or null.
async function teamNameTaken(leagueId, nm) {
  const db = admin();
  if (!db) return null;
  const { data, error } = await db.from('league_teams').select('id,name').eq('league_id', leagueId);
  if (error) return null;   // createLeagueTeam re-checks against the real index when it settles
  return (data || []).some((t) => String(t.name || '').trim().toLowerCase() === nm.toLowerCase())
    ? `There’s already a team called “${nm}” in this league. Pick another name.` : null;
}

// The captain (or staff) invites a friend by phone number.
async function invite(req, res) {
  const { teamId, phone, name } = req.body || {};
  if (!teamId) return res.status(400).json({ ok: false, error: 'Which team?' });
  if (!normPhone(phone)) return res.status(400).json({ ok: false, error: 'Enter your friend’s mobile number, including area code.' });

  const team = await leagueTeamById(teamId);
  if (!team) return res.status(404).json({ ok: false, error: 'That team no longer exists.' });

  // Only the captain may add to their own team — or staff with the Bookings permission, who add
  // players over the counter. A signed-in stranger is refused.
  const me = await accountCustomerForRequest(req);
  if (!me || team.captain_customer_id !== me.id) {
    const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
    if (ctx.error) {
      return res.status(me ? 403 : 401).json({ ok: false,
        error: me ? 'Only the team’s captain can invite players. Ask them to send the link.' : 'Sign in to invite players.' });
    }
  }

  const r = await createTeamInvite({ teamId: team.id, phone, name, invitedBy: me ? me.id : null });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  if (r.alreadyOnTeam) return res.status(200).json({ ok: true, alreadyOnTeam: true, link: null });

  const link = inviteLink(req, r.invite.token);
  // Text it if Twilio is configured; the captain gets the link back either way, so an invite is
  // never lost because a message could not go out. CASL is decided inside lib/notify.js.
  await notifyTeamInvite({
    inviteId: r.invite.id, phone: r.invite.phone, name: r.invite.name, link,
    teamName: team.name, leagueName: r.league && r.league.name,
    invitedBy: me ? me.name : null, weeklyMins: r.league && r.league.weekly_min_mins,
  });
  return res.status(200).json({ ok: true, link, resent: !!r.already });
}

// Public: what the person who tapped the link is being offered. No phone numbers, no roster.
async function inviteInfo(req, res) {
  const token = (req.body || {}).token;
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'That invite link isn’t valid.' });
  const found = await teamInviteByToken(token);
  if (found && found.unsupported) return res.status(503).json({ ok: false, error: MIGRATION_0031 });
  if (!found || !found.team) return res.status(404).json({ ok: false, error: 'That invite link isn’t valid. Ask your captain to send it again.' });
  const { invite: inv, team, league } = found;

  const db = admin();
  let teamFull = false;
  if (db && league && league.team_size) {
    const { data } = await db.from('league_members').select('id').eq('team_id', team.id).eq('status', 'active');
    teamFull = (data || []).length >= Number(league.team_size);
  }
  let invitedBy = null;
  if (db && inv.invited_by) {
    const { data } = await db.from('customers').select('name').eq('id', inv.invited_by).maybeSingle();
    invitedBy = (data && data.name) || null;
  }
  return res.status(200).json({
    ok: true,
    leagueName: (league && league.name) || null,
    teamName: team.name,
    invitedBy,
    teamFull,
    claimed: !!inv.claimed_at,
    revoked: !!inv.revoked_at,
    weeklyMins: (league && league.weekly_min_mins) || null,
  });
}

// Signed in: take the spot. Single use — see lib/db.js claimTeamInvite.
async function inviteClaim(req, res) {
  const token = (req.body || {}).token;
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'That invite link isn’t valid.' });
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in (or make an account) first, then open your invite link again.' });
  const r = await claimTeamInvite({ token, customerId: me.id });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.status(200).json({ ok: true, teamId: r.teamId, leagueId: r.leagueId, already: !!r.already });
}

// The teams this player is on: roster, the season week by week, and the standings.
async function myTeams(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Your session has ended. Sign in again.' });
  const r = await teamsForCustomer(me.id);
  if (r.error) return res.status(r.code || 500).json({ ok: false, error: r.error, teams: [] });
  return res.status(200).json({ ok: true, teams: r.teams });
}

// ----- The 0028 per-player sign-up, unchanged ------------------------------------------

async function join(req, res) {
  const { leagueId, name, email, phone, teamName } = req.body || {};
  const nm = String(name || '').trim().slice(0, 120);
  if (!nm) return res.status(400).json({ error: 'Enter your name.' });
  if (!normPhone(phone)) return res.status(400).json({ error: 'Enter your mobile number, including area code — it links the league to your bookings.' });
  if (email && !validEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
  if (!admin()) return res.status(503).json({ error: 'League sign-up isn’t available right now — please call the shop.' });

  const league = await leagueById(leagueId);
  if (!league || !league.is_active || !league.join_online) return res.status(404).json({ error: 'That league isn’t taking sign-ups online. Please call the shop.' });
  if (league.season_end && league.season_end < winnipegTodayISO()) return res.status(400).json({ error: 'That league’s season is over.' });

  // Already playing: say so before taking any money.
  const cust = await customerHoursByContact({ email, phone });
  if (cust) {
    const mine = await leaguesForCustomer(cust.id);
    if (mine.some((m) => m.league.id === league.id)) return res.status(409).json({ error: 'You’re already in this league.' });
  }
  const open0028 = await listPublicLeagues();
  const open = (open0028.leagues || []).find((l) => l.id === league.id);
  if (open && open.spotsLeft === 0) return res.status(409).json({ error: 'That league is full.' });

  if (!(league.fee_cents > 0)) {
    const r = await joinLeague({ leagueId: league.id, name: nm, email, phone, teamName, source: 'online' });
    return r.error ? res.status(r.code || 400).json({ error: r.error }) : res.status(200).json({ ok: true, joined: true, leagueName: league.name });
  }

  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ error: 'Online payment isn’t available right now — please call the shop to join.' });
  const settings = normalizeSettings(await getSettings());
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const session = await stripeClient(process.env).checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: settings.currency, unit_amount: league.fee_cents,
      product_data: { name: `${league.name} — league fee`, description: league.description || undefined } } }],
    customer_email: validEmail(email) ? email.trim() : undefined,
    metadata: { kind: 'league', leagueId: league.id, name: nm, email: String(email || '').trim(),
      phone: String(phone || '').trim(), teamName: String(teamName || '').trim().slice(0, 60) },
    success_url: `${origin}/leagues?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/leagues?canceled=1`,
  });
  return res.status(200).json({ url: session.url });
}

// The success page, for either kind of league payment. Which one it was is read from the Stripe
// session itself, never from anything the browser sent.
async function confirm(req, res) {
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });
  const stripe = stripeClient(process.env);
  const sessionId = (req.body || {}).sessionId;
  const team = await confirmLeagueTeamCheckout(stripe, sessionId);
  if (team.ok) return res.status(200).json({ ok: true, teamId: team.teamId, leagueName: team.league && team.league.name });
  // "not a league team" is the one answer that means "try the other kind"; everything else is the
  // real reason this payment could not be settled.
  if (!/not a league team/.test(team.error || '')) return res.status(team.code || 400).json({ ok: false, error: team.error });
  const r = await confirmLeagueCheckout(stripe, sessionId);
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.status(200).json({ ok: true, leagueName: r.league && r.league.name, email: r.email });
}

// The signed-in customer is whoever the session token belongs to.
async function signedIn(req, res, action) {
  const db = admin();
  if (!db) return res.status(503).json({ error: 'Not configured.' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const who = token ? await db.auth.getUser(token).catch(() => null) : null;
  const user = who && !who.error && who.data && who.data.user;
  const { data: c } = user ? await db.from('customers').select('id,email,phone').eq('user_id', user.id).maybeSingle() : { data: null };

  // The booking page asks this for every visitor: signed out (or a stale session) simply gets the
  // regular window, never an error — the page must still let them book.
  if (action === 'window') {
    const settings = normalizeSettings(await getSettings());
    const league = !!(c && await isLeaguePlayer({ email: c.email, phone: c.phone }));
    return res.status(200).json({ ok: true, league, signedIn: !!user,
      days: league ? settings.bookingWindow.leagueDays : settings.bookingWindow.regularDays,
      regularDays: settings.bookingWindow.regularDays, leagueDays: settings.bookingWindow.leagueDays });
  }
  if (!user) return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
  const settings = normalizeSettings(await getSettings());
  const bays = Object.fromEntries((settings.bays || []).map((b) => [b.id, b.name]));   // My Account names bays, not ids
  return res.status(200).json({ ok: true, leagues: c ? await leaguesForCustomer(c.id) : [], bays });
}
