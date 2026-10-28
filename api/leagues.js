import { stripeStatus, stripeClient, normalizeSettings, winnipegTodayISO, winnipegDateOf } from '../lib/booking.js';
import { getSettings, admin, listPublicLeagues, leagueById, joinLeague, confirmLeagueCheckout, leaguesForCustomer,
         customerHoursByContact, isLeaguePlayer, normPhone, accountCustomerForRequest, staffContext,
         listTeamLeagues, teamLeagueById, leagueTeamById, createLeagueTeam, confirmLeagueTeamCheckout,
         createTeamInvite, teamInviteByToken, claimTeamInvite, teamsForCustomer, MIGRATION_0031,
         splitPaymentsReady, confirmLeagueSeatCheckout, teamMoneyFor,
         soloShareCents, joinLeagueSolo, confirmLeagueSoloCheckout, placeSolo, teamFromSolos, staffAddInvitee, withdrawTeamInvite,
         teamInviteForResend, notificationOutcome,
         teamMembershipFor, saveScorecard, listScorecards, removeScorecard, memberShareNotice, ownShareFor, submitHoleScores } from '../lib/db.js';
import { notifyTeamInvite, notifyLeaguePlaced, notifyLeagueAdded } from '../lib/notify.js';
// The seat maths (0036), shared with the manager portal. lib/db.js has already loaded it.
const L = globalThis.InvictusLeagues;

// Leagues, for customers. One function, dispatched on ?action=, to keep the serverless function
// count down (Vercel's limit is 12 and this project is already near it).
//
// SINCE MIGRATION 0031 A LEAGUE IS SOLD BY THE TEAM, and since 0036 it is PAID SEAT BY SEAT: the
// captain picks the team's size (between the league's team_min and team_size), the team price is
// shared across those seats, the captain pays one share and each friend pays one when they accept
// the invite. Seats nobody pays for are owed by the captain and collected by staff. The team plays
// once a week whenever it likes — booked and paid for on the ordinary booking page, with the
// team named at checkout (api/checkout.js).
//
// SINCE MIGRATION 0041 there are two more ways onto a roster. SOLO: somebody with no team pays one
// golfer's share and waits, team-less, for the manager to place them (place-solo / team-from-solos,
// staff only). SUBSTITUTE: a team's captain invites up to three people who fill in when a
// teammate is away — no seat, no fee, and none of a league member's perks.
//
//   POST ?action=list           (public)        leagues you can buy a team in
//   POST ?action=buy-team       (signed in)     { leagueId, teamName, seats } → Stripe Checkout, or a free team
//   POST ?action=join-solo      (signed in)     { leagueId } → Stripe Checkout for one golfer's share, or a free place
//   POST ?action=place-solo     (staff)         { memberId, teamId } → that player is on that team
//   POST ?action=team-from-solos (staff)        { leagueId, memberIds, name } → a new team of them
//   POST ?action=scorecard      (on the team)   { teamId, week, image } → the scoreboard photo for that week's round, saved
//                               (staff)         { teamId, week, image, asStaff: true } → the same, added from the portal
//   POST ?action=scorecards     (staff | team)  { leagueId } | { teamId } → the photos, each with a link good for an hour
//   POST ?action=scorecard-remove (staff)       { id } → that photo is deleted
//   POST ?action=invite         (captain/staff) { teamId, phone, name?, role? } → the link to send a friend (role 'sub' = substitute)
//   POST ?action=invite-info    (public)        { token } → whose team, is it still open, what joining costs
//   POST ?action=invite-claim   (signed in)     { token } → you're on the team, or Checkout for your seat
//   POST ?action=pay-seats      (captain)       { teamId, seats } → Checkout to cover seats for friends
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
function siteOrigin(req) {
  const env = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  const origin = env || (req.headers && req.headers.origin) || (() => {
    const h = req.headers || {};
    const host = h['x-forwarded-host'] || h.host;
    if (!host) return '';
    const proto = h['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
  })();
  return origin ? String(origin).replace(/\/+$/, '') : '';
}
function inviteLink(req, token) {
  const origin = siteOrigin(req);
  return origin ? `${origin}/leagues?invite=${encodeURIComponent(token)}` : null;
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  try {
    if (action === 'list' || (req.method === 'GET' && !action)) return await list(req, res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (action === 'info') return await info(req, res);
    if (action === 'buy-team') return await buyTeam(req, res);
    if (action === 'join-solo') return await joinSolo(req, res);
    if (action === 'place-solo') return await placeSoloAction(req, res);
    if (action === 'add-invitee') return await addInviteeAction(req, res);
    if (action === 'invite-withdraw') return await inviteWithdraw(req, res);
    if (action === 'invite-decline') return await inviteDecline(req, res);
    if (action === 'invite-resend') return await inviteResendAction(req, res);
    if (action === 'team-from-solos') return await teamFromSolosAction(req, res);
    if (action === 'scorecard') return await scorecardUpload(req, res);
    if (action === 'scorecards') return await scorecardList(req, res);
    if (action === 'scorecard-remove') return await scorecardRemove(req, res);
    if (action === 'invite') return await invite(req, res);
    if (action === 'invite-info') return await inviteInfo(req, res);
    if (action === 'invite-claim') return await inviteClaim(req, res);
    if (action === 'pay-seats') return await paySeats(req, res);
    if (action === 'pay-share') return await payShare(req, res);
    if (action === 'member-added') return await memberAdded(req, res);
    if (action === 'submit-holes') return await submitHoles(req, res);
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

// Public. One league's brochure: about, format, challenges, schedule, awards, grand prize
// (migration 0039). Any ACTIVE league, not only ones still selling teams — a team already in a
// league that has closed sign-up still needs to read its rules and schedule.
async function info(req, res) {
  const league = await teamLeagueById(String((req.body || {}).leagueId || (req.query || {}).leagueId || ''));
  if (!league || league.is_active === false) return res.status(404).json({ ok: false, error: 'That league is not on the site right now.' });
  return res.status(200).json({ ok: true, league: {
    id: league.id, name: league.name, description: league.description || null,
    fee_cents: league.fee_cents || 0, team_size: league.team_size ?? null, team_min: league.team_min ?? null,
    season_start: league.season_start, season_end: league.season_end,
    joinOnline: league.join_online !== false && L.isCurrent(league, winnipegTodayISO()),
    details: L.normalizeDetails(league.details),
  } });
}

// Buy a team. The captain is whoever is signed in — never a name or number in the body.
async function buyTeam(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to buy a team.' });
  const { leagueId, teamName, seats: askedSeats } = req.body || {};
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

  // How many golfers: the captain's pick, within the league's range. With min = max there is
  // nothing to pick. A league with no maximum has no seats — the captain pays the whole price.
  const range = L.seatRange(league);
  let seats = null;
  if (range) {
    seats = range.min === range.max ? range.max : Math.floor(Number(askedSeats));
    if (!(seats >= range.min && seats <= range.max)) {
      return res.status(400).json({ ok: false, error: `Pick how many golfers are on your team — ${range.min} to ${range.max}.` });
    }
  }

  // A free league: the team exists the moment they ask for it.
  if (!(league.fee_cents > 0)) {
    const r = await createLeagueTeam({ leagueId: league.id, name: nm, captainCustomerId: me.id, seats: seats && await splitPaymentsReady() ? seats : null, shareCents: 0 });
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
  // Seat by seat: the captain pays one share now. Without migration 0036 there is nowhere to record
  // seats, so the captain pays the whole price exactly as before.
  const split = !!seats && await splitPaymentsReady();
  const share = split ? L.shareOf(league.fee_cents, seats) : league.fee_cents;
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const size = seats ? `${seats} golfers` : (league.team_size ? `${league.team_size} players` : 'your team');
  // Dynamic payment methods: no payment_method_types, exactly as api/gift-cards.js does it.
  const session = await stripeClient(process.env).checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: settings.currency, unit_amount: share,
      product_data: { name: split ? `${league.name} — your share of the team` : `${league.name} — team entry`,
        description: split
          ? `Team of ${seats}: ${money(league.fee_cents)} shared ${seats} ways. Your teammates each pay their own share when they join.`
          : `One season for ${size}.${league.description ? ' ' + league.description : ''}` } } }],
    customer_email: validEmail(me.email) ? me.email : undefined,
    metadata: { kind: 'league-team', leagueId: league.id, teamName: nm, captainCustomerId: String(me.id),
      ...(split ? { seats: String(seats), shareCents: String(share) } : {}) },
    success_url: `${origin}/leagues?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/leagues?canceled=1`,
  });
  return res.status(200).json({ ok: true, url: session.url });
}

// Sign up without a team. Whoever is signed in pays one golfer's share and is in the league with
// no team; the manager places them. A league with no team size has no share to charge, so it has
// no solo sign-up.
async function joinSolo(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to join as a solo player.' });
  if (!admin()) return res.status(503).json({ ok: false, error: 'Leagues aren’t available right now — please call the shop.' });
  const league = await teamLeagueById((req.body || {}).leagueId);
  if (!league || league.is_active === false || league.join_online === false) {
    return res.status(404).json({ ok: false, error: 'That league isn’t taking sign-ups online. Please call the shop.' });
  }
  if (league.season_end && league.season_end < winnipegTodayISO()) {
    return res.status(400).json({ ok: false, error: 'That league’s season is over.' });
  }
  const share = soloShareCents(league);
  if (share == null) return res.status(400).json({ ok: false, error: 'This league is joined by the team. Start a team, or call the shop.' });

  // Already in it — on a team, or already waiting to be placed? Say so before taking any money.
  const mine = await teamsForCustomer(me.id);
  const onTeam = (mine.teams || []).find((t) => t.league.id === league.id);
  if (onTeam) return res.status(409).json({ ok: false, error: `You’re already on ${onTeam.team.name} in this league.`, teamId: onTeam.team.id });
  if ((mine.solos || []).some((x) => x.league.id === league.id)) {
    return res.status(409).json({ ok: false, error: 'You’re already signed up as a solo player. We’ll text you when you’re placed on a team.' });
  }

  if (!(share > 0)) {
    const r = await joinLeagueSolo({ leagueId: league.id, customerId: me.id });
    return r.error ? res.status(r.code || 400).json({ ok: false, error: r.error })
                   : res.status(200).json({ ok: true, solo: true, free: true, leagueName: league.name });
  }
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Online payment isn’t available right now — please call the shop to join.' });
  const settings = normalizeSettings(await getSettings());
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const session = await stripeClient(process.env).checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: settings.currency, unit_amount: share,
      product_data: { name: `${league.name} — solo player`,
        description: 'One golfer’s place for the season. We place you with a team and text you when it’s done.' } } }],
    customer_email: validEmail(me.email) ? me.email : undefined,
    metadata: { kind: 'league-solo', leagueId: league.id, customerId: String(me.id) },
    success_url: `${origin}/leagues?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/leagues?canceled=1`,
  });
  return res.status(200).json({ ok: true, url: session.url, amountCents: share });
}

// Staff only (Bookings permission): put a team-less player on a team, and text them which one.
async function placeSoloAction(req, res) {
  const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
  if (ctx.error) return res.status(403).json({ ok: false, error: 'Only staff with the Bookings permission can place players on teams.' });
  const { memberId, teamId } = req.body || {};
  if (!memberId || !teamId) return res.status(400).json({ ok: false, error: 'Which player, and which team?' });
  const r = await placeSolo({ memberId, teamId });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  if (!r.already && r.customer) {
    await notifyLeaguePlaced({ memberId: r.memberId, teamId: r.team.id, phone: r.customer.phone, name: r.customer.name,
      teamName: r.team.name, leagueName: r.league && r.league.name, customerId: r.customer.id });
  }
  return res.status(200).json({ ok: true, teamId: r.team.id, teamName: r.team.name, grew: !!r.grew, already: !!r.already });
}

// The captain takes back an invitation nobody has used yet.   POST ?action=invite-withdraw { inviteId }
async function inviteWithdraw(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in again to manage your team.' });
  const id = (req.body || {}).inviteId;
  if (!id || String(id).length > 64) return res.status(400).json({ ok: false, error: 'Which invitation?' });
  const r = await withdrawTeamInvite({ inviteId: id, customerId: me.id });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.status(200).json({ ok: true, already: !!r.already });
}

// The person invited says no, from their own link.   POST ?action=invite-decline { token }
async function inviteDecline(req, res) {
  const token = (req.body || {}).token;
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'That invitation link isn’t valid.' });
  const r = await withdrawTeamInvite({ token });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.status(200).json({ ok: true, already: !!r.already });
}

// Staff only: put an invited person on their team — after taking their share on the POS
// (paidAtCounter, needs Money), or when their seat is already paid (needs Bookings).
//   POST ?action=add-invitee   { inviteId, paidAtCounter? }
async function addInviteeAction(req, res) {
  const b = req.body || {};
  const ctx = await staffContext(req.headers && req.headers.authorization, b.paidAtCounter ? 'money.write' : 'booking.write');
  if (ctx.error) return res.status(403).json({ ok: false, error: b.paidAtCounter
    ? 'Recording a payment needs a staff login with the Money permission.'
    : 'Only staff with the Bookings permission can add players to teams.' });
  if (!b.inviteId || String(b.inviteId).length > 64) return res.status(400).json({ ok: false, error: 'Which invite?' });
  const by = (ctx.user && ctx.user.email) || (ctx.staff && ctx.staff.email) || 'staff';
  const r = await staffAddInvitee({ inviteId: b.inviteId, paidAtCounter: !!b.paidAtCounter, by });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.status(200).json({ ok: true, already: !!r.already, teamName: r.team.name, paidCents: r.paidCents || 0 });
}

// Staff only: text an unused invitation again — the first text never arrived (Twilio was down
// Oct 20–21, 2026), or the person lost it. Same message, same link.
//   POST ?action=invite-resend   { inviteId }
async function inviteResendAction(req, res) {
  const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
  if (ctx.error) return res.status(403).json({ ok: false, error: 'Only staff with the Bookings permission can resend invitations.' });
  const id = (req.body || {}).inviteId;
  if (!id || String(id).length > 64) return res.status(400).json({ ok: false, error: 'Which invite?' });
  const r = await teamInviteForResend(id);
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });

  const out = await notifyTeamInvite({
    inviteId: r.invite.id, phone: r.invite.phone, name: r.invite.name, link: inviteLink(req, r.invite.token),
    teamName: r.team.name, leagueName: r.league && r.league.name, invitedBy: r.invitedByName,
    weeklyMins: r.league && r.league.weekly_min_mins, role: r.invite.role === 'sub' ? 'sub' : 'player', again: true,
  });
  if (out.sms && out.sms.already) {
    return res.status(429).json({ ok: false, error: 'It was resent less than 2 minutes ago. Give it a moment to arrive before sending another.' });
  }
  if (!out.sms || !out.sms.row) {
    return res.status(503).json({ ok: false, error: `The text could not be queued${out.sms && out.sms.error ? `: ${out.sms.error}` : ''}.` });
  }
  if (out.sent[0] === 'sent') return res.status(200).json({ ok: true, sent: true, phone: r.invite.phone });
  // Not delivered: say why in the provider's own words (e.g. Twilio's "account is not active").
  const row = await notificationOutcome(out.sms.row.id);
  const why = (row && row.last_error) || 'the text service did not accept it';
  return res.status(502).json({ ok: false, error: `The text did not go out — ${why}. ${out.sent[0] === 'retry' ? 'It will be retried automatically.' : 'Send them the link another way, or try again later.'}` });
}

// Staff only: a new team made of players who have none.
async function teamFromSolosAction(req, res) {
  const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
  if (ctx.error) return res.status(403).json({ ok: false, error: 'Only staff with the Bookings permission can make teams.' });
  const { leagueId, memberIds, name } = req.body || {};
  if (!leagueId || !Array.isArray(memberIds) || !memberIds.length || memberIds.length > 20) {
    return res.status(400).json({ ok: false, error: 'Pick the players to put on the team.' });
  }
  const r = await teamFromSolos({ leagueId, memberIds, name });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  for (const c of r.placed) {
    await notifyLeaguePlaced({ memberId: c.memberId, teamId: r.team.id, phone: c.phone, name: c.name,
      teamName: r.team.name, leagueName: r.league.name, customerId: c.id });
  }
  return res.status(200).json({ ok: true, teamId: r.team.id, teamName: r.team.name, placed: r.placed.length });
}

// ----- Scorecard photos (rule 5; migration 0042) -----
// The photo arrives as a data URL the page has already shrunk. Nothing about it is trusted: the
// type is read from the bytes themselves, not from what the browser says it is.
const MAX_PHOTO_BYTES = 3.5 * 1024 * 1024;
function photoFrom(dataUrl) {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'That file is not a photo we can read. Take the picture again, or choose a JPEG or PNG.' };
  const bytes = Buffer.from(m[1], 'base64');
  if (!bytes.length) return { error: 'That photo is empty. Take the picture again.' };
  if (bytes.length > MAX_PHOTO_BYTES) return { error: 'That photo is too large. Take it again a little further back, or choose a smaller one.' };
  const type = (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) ? 'image/jpeg'
    : (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') ? 'image/png'
    : (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') ? 'image/webp' : null;
  if (!type) return { error: 'That file is not a photo we can read. Take the picture again, or choose a JPEG or PNG.' };
  return { bytes, type };
}

// Anybody on the team's roster — a player or a substitute who filled in — may add the photo. So may
// staff with the Bookings permission, from the portal, for a team that handed in a paper card.
async function scorecardUpload(req, res) {
  if ((req.body || {}).asStaff) {
    const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
    if (ctx.error) return res.status(403).json({ ok: false, error: 'Only staff with the Bookings permission can add a scorecard photo.' });
    const { teamId, week, image } = req.body;
    const photo = photoFrom(image);
    if (photo.error) return res.status(400).json({ ok: false, error: photo.error });
    const r = await saveScorecard({ teamId: String(teamId || ''), weekISO: week, bytes: photo.bytes, contentType: photo.type });
    if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
    return res.status(200).json({ ok: true, id: r.id, week: r.week });
  }
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to add your scoreboard photo.' });
  const { teamId, week, image } = req.body || {};
  const m = await teamMembershipFor({ teamId: String(teamId || ''), customerId: me.id });
  if (!m || !m.team) return res.status(404).json({ ok: false, error: 'That team no longer exists.' });
  if (!m.member && !m.sub) return res.status(403).json({ ok: false, error: 'Only people on the team can add its scoreboard photo.' });
  const photo = photoFrom(image);
  if (photo.error) return res.status(400).json({ ok: false, error: photo.error });
  const r = await saveScorecard({ teamId: m.team.id, weekISO: week, bytes: photo.bytes, contentType: photo.type, customerId: me.id });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.status(200).json({ ok: true, id: r.id, week: r.week });
}

// Staff see every team's photos for a league; a customer sees their own team's.
async function scorecardList(req, res) {
  const { leagueId, teamId } = req.body || {};
  if (leagueId) {
    const ctx = await staffContext(req.headers && req.headers.authorization);
    if (ctx.error) return res.status(403).json({ ok: false, error: 'Only staff can see every team’s scorecards.' });
    const r = await listScorecards({ leagueId: String(leagueId) });
    return res.status(r.error ? 500 : 200).json({ ok: !r.error, cards: r.cards, ...(r.unsupported ? { unsupported: true } : {}), ...(r.error ? { error: r.error } : {}) });
  }
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to see your team’s scorecards.', cards: [] });
  const m = await teamMembershipFor({ teamId: String(teamId || ''), customerId: me.id });
  if (!m || !m.team || (!m.member && !m.sub)) return res.status(403).json({ ok: false, error: 'Only people on the team can see its scorecards.', cards: [] });
  const r = await listScorecards({ teamId: m.team.id });
  return res.status(r.error ? 500 : 200).json({ ok: !r.error, cards: r.cards, ...(r.unsupported ? { unsupported: true } : {}), ...(r.error ? { error: r.error } : {}) });
}

async function scorecardRemove(req, res) {
  const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
  if (ctx.error) return res.status(403).json({ ok: false, error: 'Only staff with the Bookings permission can remove a scorecard photo.' });
  const r = await removeScorecard((req.body || {}).id);
  return r.error ? res.status(r.code || 400).json({ ok: false, error: r.error }) : res.status(200).json({ ok: true });
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
  const { teamId, phone, name, role } = req.body || {};
  const asSub = role === 'sub';   // a designated substitute (0041), not a player
  if (!teamId) return res.status(400).json({ ok: false, error: 'Which team?' });
  if (!normPhone(phone)) return res.status(400).json({ ok: false, error: 'Enter your friend’s mobile number, including area code.' });

  const team = await leagueTeamById(teamId);
  if (!team) return res.status(404).json({ ok: false, error: 'That team no longer exists.' });

  // Only the captain may add to their own team — or staff with the Bookings permission, who add
  // players over the counter. A signed-in stranger is refused.
  const me = await accountCustomerForRequest(req);
  const byCaptain = !!me && team.captain_customer_id === me.id;
  if (!byCaptain) {
    const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
    if (ctx.error) {
      return res.status(me ? 403 : 401).json({ ok: false,
        error: me ? 'Only the team’s captain can invite players. Ask them to send the link.' : 'Sign in to invite players.' });
    }
  }

  // ROSTER LOCK (the league's own rule, set on the league form): after the lock week a captain can
  // change nothing online. Staff still can — a correction is theirs to make.
  if (byCaptain) {
    const lg = await teamLeagueById(team.league_id);
    const k = L.leagueDates(lg);
    if (L.rosterLocked(lg, winnipegTodayISO())) {
      return res.status(403).json({ ok: false, code: 'roster_locked',
        error: `Rosters for ${(lg && lg.name) || 'this league'} locked after week ${k.rosterLockWeek} (${k.rosterLockOn}), so no more players or substitutes can be added. Call the shop if something needs correcting.` });
    }
  }
  const r = await createTeamInvite({ teamId: team.id, phone, name, invitedBy: me ? me.id : null, role: asSub ? 'sub' : 'player' });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  if (r.alreadyOnTeam) return res.status(200).json({ ok: true, alreadyOnTeam: true, link: null });

  const link = inviteLink(req, r.invite.token);
  // Text it if Twilio is configured; the captain gets the link back either way, so an invite is
  // never lost because a message could not go out. CASL is decided inside lib/notify.js.
  await notifyTeamInvite({
    inviteId: r.invite.id, phone: r.invite.phone, name: r.invite.name, link,
    teamName: team.name, leagueName: r.league && r.league.name,
    invitedBy: me ? me.name : null, weeklyMins: r.league && r.league.weekly_min_mins,
    role: r.invite.role === 'sub' ? 'sub' : 'player',
    // The same number invited again: text it again, rather than let the first text's dedupe key
    // swallow it while the captain is told it was resent.
    again: !!r.already,
  });
  return res.status(200).json({ ok: true, link, resent: !!r.already, role: r.invite.role === 'sub' ? 'sub' : 'player' });
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
  // Full = every seat has a player (the team's own size since 0036, else the league's maximum).
  // payToJoin: no paid seat is waiting for them, so joining costs one share.
  const found2 = await teamMoneyFor(team.id);
  const money = found2 && found2.money;
  const size = Number(team.seats) || Number(league && league.team_size) || 0;
  const asSub = inv.role === 'sub';   // a substitute takes no seat and pays nothing
  const teamFull = !asSub && !!(size && money && money.players >= size);
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
    seats: size || null,
    role: asSub ? 'sub' : 'player',
    payToJoin: !asSub && !!(money && money.split && money.freeSeats < 1),
    shareCents: !asSub && money && money.split ? money.shareCents : 0,
  });
}

// Signed in: take the spot. Single use — see lib/db.js claimTeamInvite.
async function inviteClaim(req, res) {
  const token = (req.body || {}).token;
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'That invite link isn’t valid.' });
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in (or make an account) first, then open your invite link again.' });
  // Roster lock: an invite sent before the lock and not accepted in time has lapsed. One made
  // after it can only have come from staff, and stands.
  const pending = await teamInviteByToken(token);
  if (pending && pending.league && pending.invite && !pending.invite.claimed_at) {
    const k = L.leagueDates(pending.league);
    // The day the invite was made, in Winnipeg: one sent at 8 PM on lock day is stamped tomorrow in
    // UTC, and read that way it looked like a staff invite from after the lock and never lapsed.
    const made = pending.invite.created_at ? winnipegDateOf(pending.invite.created_at) : '';
    if (L.rosterLocked(pending.league, winnipegTodayISO()) && made <= k.rosterLockOn) {
      return res.status(409).json({ ok: false, code: 'roster_locked',
        error: `Rosters for ${pending.league.name} locked after week ${k.rosterLockWeek} (${k.rosterLockOn}), so this invitation can no longer be used. Call the shop if something needs correcting.` });
    }
  }
  const r = await claimTeamInvite({ token, customerId: me.id });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  // No paid seat is waiting for them: their share first, through Checkout. The invite is spent and
  // they join the team when the payment settles (confirm, or the Stripe webhook).
  if (r.payRequired) {
    const { enabled } = stripeStatus(process.env);
    if (!enabled) return res.status(503).json({ ok: false, error: 'Online payment isn’t available right now — please call the shop to join the team.' });
    const settings = normalizeSettings(await getSettings());
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripeClient(process.env).checkout.sessions.create({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: settings.currency, unit_amount: r.shareCents,
        product_data: { name: `${(r.league && r.league.name) || 'League'} — your seat on ${r.team.name}`,
          description: `Your share of the team price (a team of ${r.team.seats}).` } } }],
      customer_email: validEmail(me.email) ? me.email : undefined,
      metadata: { kind: 'league-seat', teamId: r.team.id, inviteId: r.invite.id, customerId: String(me.id) },
      success_url: `${origin}/leagues?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/leagues?invite=${encodeURIComponent(token)}`,
    });
    return res.status(200).json({ ok: true, payRequired: true, url: session.url, shareCents: r.shareCents });
  }
  return res.status(200).json({ ok: true, teamId: r.teamId, leagueId: r.leagueId, already: !!r.already, ...(r.sub ? { sub: true } : {}) });
}

// The captain covers seats for friends who have not joined (or will not pay) — so those friends
// join for nothing, or so the venue is not left chasing the captain for them later.
async function paySeats(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to pay for your team.' });
  const { teamId, seats } = req.body || {};
  const found = await teamMoneyFor(teamId);
  if (!found) return res.status(404).json({ ok: false, error: 'That team no longer exists.' });
  const { team, league, money } = found;
  if (team.captain_customer_id !== me.id) return res.status(403).json({ ok: false, error: 'Only the team’s captain can pay for other seats.' });
  if (!money.split) return res.status(409).json({ ok: false, error: 'Your team was paid for in full — there are no seats to cover.' });
  if (!money.unpaidSeats) return res.status(409).json({ ok: false, error: 'Every seat on your team is already paid for.' });
  const n = Math.floor(Number(seats));
  if (!(n >= 1 && n <= money.unpaidSeats)) {
    return res.status(400).json({ ok: false, error: `You can pay for 1 to ${money.unpaidSeats} seat${money.unpaidSeats === 1 ? '' : 's'}.` });
  }
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Online payment isn’t available right now — you can pay at the counter.' });
  const settings = normalizeSettings(await getSettings());
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const session = await stripeClient(process.env).checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: n, price_data: { currency: settings.currency, unit_amount: money.shareCents,
      product_data: { name: `${(league && league.name) || 'League'} — seat on ${team.name}`,
        description: 'Paid by the captain. A friend who joins one of these seats pays nothing.' } } }],
    customer_email: validEmail(me.email) ? me.email : undefined,
    metadata: { kind: 'league-seat', teamId: team.id, seats: String(n), payerCustomerId: String(me.id) },
    success_url: `${origin}/leagues?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/leagues?canceled=1`,
  });
  return res.status(200).json({ ok: true, url: session.url, amountCents: n * money.shareCents });
}

// A player staff put on a team paying their own share, from My Account.
//   POST ?action=pay-share   { teamId }  (signed in)
async function payShare(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to pay your share.' });
  const r = await ownShareFor({ teamId: (req.body || {}).teamId, customerId: me.id });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Online payment isn’t available right now — you can pay at the counter.' });
  const settings = normalizeSettings(await getSettings());
  const origin = siteOrigin(req) || `https://${req.headers.host}`;
  const session = await stripeClient(process.env).checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: settings.currency, unit_amount: r.owedCents,
      product_data: { name: `${(r.league && r.league.name) || 'League'} — your seat on ${r.team.name}`,
        description: `Your share of the team price (a team of ${r.team.seats}).` } } }],
    customer_email: validEmail(me.email) ? me.email : undefined,
    metadata: { kind: 'league-seat', teamId: r.team.id, ownShare: '1', customerId: String(me.id) },
    success_url: `${origin}/leagues?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/account`,
  });
  return res.status(200).json({ ok: true, url: session.url, amountCents: r.owedCents });
}

// A team member enters the team's 18 hole scores for a week (pending until staff confirm).
//   POST ?action=submit-holes   { teamId, week, holes: [18 numbers] }   (signed in)
async function submitHoles(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to enter your scores.' });
  const b = req.body || {};
  const r = await submitHoleScores({ customerId: me.id, teamId: b.teamId, week: b.week, holes: b.holes });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.status(200).json(r);
}

// Staff only: text a player they have just put on a team — which team, and their share to pay.
//   POST ?action=member-added   { leagueId, customerId, again? }
// `again` is the Teams tab's "Resend text": a reminder to pay, so it is sent only while they still
// owe their share, and no more than once every two minutes.
async function memberAdded(req, res) {
  const ctx = await staffContext(req.headers && req.headers.authorization, 'booking.write');
  if (ctx.error) return res.status(403).json({ ok: false, error: 'Only staff with the Bookings permission can do this.' });
  const b = req.body || {};
  if (!isUuid(b.leagueId) || !isUuid(b.customerId)) return res.status(400).json({ ok: false, error: 'Which player?' });
  const r = await memberShareNotice({ leagueId: b.leagueId, customerId: b.customerId });
  if (r.error) return res.status(r.code || 400).json({ ok: false, error: r.error });
  if (r.sub) return res.status(200).json({ ok: true, texted: false, reason: 'Substitutes pay nothing, so no text was sent.' });
  if (b.again && !r.owedCents) return res.status(200).json({ ok: true, texted: false, reason: 'Their seat is already paid for, so no reminder was sent.' });
  const phone = r.customer && r.customer.phone;
  if (!phone) return res.status(200).json({ ok: true, texted: false, reason: 'They have no mobile number on file, so no text was sent.' });
  const out = await notifyLeagueAdded({
    memberId: r.member.id, teamId: r.team.id, phone, customerId: r.customer.id,
    name: r.customer.first_name || (r.customer.name || '').split(' ')[0] || null,
    teamName: r.team.name, leagueName: r.league.name, shareCents: r.owedCents,
    link: `${siteOrigin(req)}/account`, again: !!b.again,
  });
  if (out.sms && out.sms.already) return res.status(200).json({ ok: true, texted: false, reason: b.again
    ? 'A reminder went out less than 2 minutes ago. Give it a moment to arrive.' : 'They were already sent this text.' });
  if (!out.sms || !out.sms.row) return res.status(200).json({ ok: true, texted: false, reason: 'The text could not be queued.' });
  if (out.sent[0] === 'sent') return res.status(200).json({ ok: true, texted: true, owedCents: r.owedCents });
  // Not delivered: say why in the provider's own words, as invite-resend does.
  const row = await notificationOutcome(out.sms.row.id);
  return res.status(200).json({ ok: true, texted: false, owedCents: r.owedCents,
    reason: `The text did not go out — ${(row && row.last_error) || 'the text service did not accept it'}.${out.sent[0] === 'retry' ? ' It will be retried automatically.' : ''}` });
}

// The teams this player is on: roster, the season week by week, and the standings.
async function myTeams(req, res) {
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Your session has ended. Sign in again.' });
  const r = await teamsForCustomer(me.id);
  if (r.error) return res.status(r.code || 500).json({ ok: false, error: r.error, teams: [] });
  return res.status(200).json({ ok: true, teams: r.teams, solos: r.solos || [] });
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
  const seat = await confirmLeagueSeatCheckout(stripe, sessionId);
  if (seat.ok) return res.status(200).json({ ok: true, teamId: seat.teamId, leagueName: seat.league && seat.league.name, seat: true });
  if (!/not a league seat/.test(seat.error || '')) return res.status(seat.code || 400).json({ ok: false, error: seat.error, refunded: !!seat.refunded });
  const solo = await confirmLeagueSoloCheckout(stripe, sessionId);
  if (solo.ok) return res.status(200).json({ ok: true, solo: true, leagueName: solo.league && solo.league.name });
  if (!/not a league solo/.test(solo.error || '')) return res.status(solo.code || 400).json({ ok: false, error: solo.error });
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
