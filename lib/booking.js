// Shared booking/pricing logic + Stripe key helpers.
// Used by both the local Express server (server.js) and the Vercel functions (api/*).
// The browser never sets the price — it's always recomputed here from saved settings.

// Defaults used when the database isn't configured yet (keeps the demo working standalone).
const DEFAULT_BAYS = [
  { id: 'B1', name: 'The Tee Time Tavern Bay', sim: 'Uneekor' },
  { id: 'B2', name: 'The Bunker Bistro Bay', sim: 'Uneekor' },
  { id: 'B3', name: 'The Bogey Barn Bay', sim: 'Uneekor' },
  { id: 'B4', name: 'The Mulligan Manor Bay', sim: 'TrackMan' },
  { id: 'B5', name: 'The Sunset Sipper Bay', sim: 'TrackMan' },
];

export const DEFAULT_SETTINGS = {
  bays: DEFAULT_BAYS,
  hours: { 0: [9, 21], 1: [11, 23], 2: [11, 23], 3: [11, 23], 4: [11, 23], 5: [11, 23], 6: [9, 23] },
  slotStep: 30,
  minMins: 60,
  maxParty: 4,
  peakStartHour: 17,
  rates: { weekdayOffPeak: 25, weekdayPeak: 32, weekendOffPeak: 30, weekendPeak: 36 },
  bayRates: {},   // { bayId: {weekdayOffPeak,weekdayPeak,weekendOffPeak,weekendPeak,peakStartHour} }
  weeklyStatus: {},   // { weekday: [ band, … ] } — recurring tee-sheet status pattern (see weeklyStatusAt)
  onlineStatusLabel: 'Booked',   // workflow status stamped on a customer's own online booking
  points: {},         // loyalty rates — see pointsConfig()
  currency: 'cad',
};

// Turn a raw `settings` DB row into the normalized shape used everywhere (and sent to the browser).
// The rates object is passed through as-stored so time-block bands survive; only defaults are backfilled.
export function normalizeSettings(row) {
  if (!row) return DEFAULT_SETTINGS;
  return {
    bays: Array.isArray(row.bays) ? row.bays : DEFAULT_SETTINGS.bays,
    hours: row.hours || DEFAULT_SETTINGS.hours,
    slotStep: row.slot_step ?? 30,
    minMins: row.min_mins ?? 60,
    maxParty: row.max_party ?? 4,
    peakStartHour: (row.rates && row.rates.peakStartHour) ?? 17,
    rates: (row.rates && typeof row.rates === 'object') ? row.rates : DEFAULT_SETTINGS.rates,
    bayRates: (row.bay_rates && typeof row.bay_rates === 'object') ? row.bay_rates : {},
    weeklyStatus: (row.weekly_status && typeof row.weekly_status === 'object') ? row.weekly_status : {},
    onlineStatusLabel: row.online_status_label || 'Booked',
    points: (row.points && typeof row.points === 'object') ? row.points : {},
    currency: 'cad',
  };
}

// ----- Loyalty points -----
// Rates with defaults: earn 5 pts per hour played; every 100 pts is worth $10 off.
export function pointsConfig(settings) {
  const p = (settings && settings.points) || {};
  const earnPerHour = Number(p.earnPerHour);
  const redeemPer100 = Number(p.redeemPer100);
  return {
    earnPerHour: (isFinite(earnPerHour) && earnPerHour >= 0) ? earnPerHour : 5,
    redeemPer100: (isFinite(redeemPer100) && redeemPer100 >= 0) ? redeemPer100 : 10,
  };
}
// Points earned for a session length (whole points, rounded down — 90 min @ 5/hr → 7).
export function pointsEarned(settings, minutes) {
  return Math.floor(pointsConfig(settings).earnPerHour * (Number(minutes) || 0) / 60);
}
// How a balance redeems against an amount. perPointCents = redeemPer100 ($ per 100 pts → ¢ per pt).
// Full cover: enough points to pay the whole amount (booked with no card). Partial: use as many
// points as possible while leaving ≥ 50¢ to charge (Stripe's minimum). partialOnly forces the
// partial shape even when the balance could fully cover — used by the card-payment path, where a
// charge must remain (a silent zero-discount here would overcharge the customer).
export function pointsRedemption(settings, balance, amountCents, { partialOnly = false } = {}) {
  const perPoint = pointsConfig(settings).redeemPer100;   // cents per point
  const bal = Math.max(0, Math.floor(Number(balance) || 0));
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  if (!(perPoint > 0) || !bal || !amount) return { pointsUsed: 0, discountCents: 0, fullCover: false };
  const toCover = Math.ceil(amount / perPoint);
  if (bal >= toCover && !partialOnly) return { pointsUsed: toCover, discountCents: amount, fullCover: true };
  const maxDiscount = Math.max(0, amount - 50);
  const pointsUsed = Math.min(bal, Math.floor(maxDiscount / perPoint));
  return { pointsUsed, discountCents: pointsUsed * perPoint, fullCover: false };
}

export function bayName(settings, id) {
  return (settings.bays.find((b) => b.id === id) || {}).name;
}

// Normalize any rate object into time bands: [{ start: hour, wd: weekday$, we: weekend$ }, …] sorted by start.
// A legacy 2-tier rate (off-peak / peak) becomes two bands so old data keeps working with no migration.
export function bandsOf(r) {
  if (r && Array.isArray(r.bands) && r.bands.length) {
    return r.bands
      .map((b) => ({ start: Math.max(0, Math.min(23, Math.round(Number(b.start) || 0))), wd: Number(b.wd) || 0, we: Number(b.we) || 0 }))
      .sort((a, b) => a.start - b.start);
  }
  const peak = r && r.peakStartHour != null ? Number(r.peakStartHour) : 17;
  return [
    { start: 0, wd: (r && r.weekdayOffPeak) ?? 25, we: (r && r.weekendOffPeak) ?? 30 },
    { start: peak, wd: (r && r.weekdayPeak) ?? 32, we: (r && r.weekendPeak) ?? 36 },
  ].sort((a, b) => a.start - b.start);
}

// The $/hr for an hour: the band with the greatest start ≤ hour (falls back to the first band).
export function rateFromBands(bands, weekend, hour) {
  let band = bands[0];
  for (const b of bands) { if (b.start <= hour) band = b; else break; }
  return weekend ? band.we : band.wd;
}

export function rateFor(settings, weekday, hour, bayId) {
  const weekend = weekday === 0 || weekday === 6;
  const r = (bayId && settings.bayRates && settings.bayRates[bayId]) || settings.rates;
  return rateFromBands(bandsOf(r), weekend, hour);
}

// Resolve a date's schedule overrides into (a) venue-wide hour changes and
// (b) per-bay blocked time ranges. bay_ids empty/null on an override = all bays.
export function overrideEffects(overrides, settings, dateISO) {
  let venueClosed = false, venueHours = null;   // resolved: a closure always wins over special hours
  const blocked = {};             // { bayId: [[startMin, endMin], …] }
  const realIds = settings.bays.filter((b) => !b.holding).map((b) => b.id);
  for (const o of overrides || []) {
    const bays = (o.bay_ids && o.bay_ids.length) ? o.bay_ids : null;
    if (o.start_min == null) {
      if (!bays) {
        if (o.is_closed) venueClosed = true;
        else venueHours = [o.open_hour ?? 0, o.close_hour ?? 0];   // latest special-hours row wins
      }
      else if (o.is_closed) for (const id of bays) (blocked[id] ||= []).push([0, 24 * 60]);
    } else {
      // An "Open" schedule status (Happy Hour, Open Prime Rate…) colours the tee sheet but must
      // never block online booking — skip it here so those slots stay bookable.
      if (o.status_open) continue;
      // A timed block applies to its time window on EVERY day in the range — "Jul 15–17,
      // 11 AM–7 PM" blocks 11–7 on each of the three days (how managers set up multi-day events).
      const s = Number(o.start_min);
      const e = Number(o.end_min);
      if (e > s) for (const id of (bays || realIds)) (blocked[id] ||= []).push([s, e]);
    }
  }
  const dateHours = venueClosed ? [0, 0] : venueHours;
  return { dateHours, blocked };
}

// True when a requested slot collides with an override (used to refuse payment for blocked time).
export function overrideConflicts(effects, settings, dateISO, bayId, startMin, endMin) {
  if (effects.dateHours) {
    const [o, c] = effects.dateHours;
    if (!(c > o) || startMin < o * 60 || endMin > c * 60) return true;
  }
  return (effects.blocked[bayId] || []).some(([s, e]) => startMin < e && endMin > s);
}

// ---- Weekly tee-sheet status pattern --------------------------------------
// settings.weeklyStatus is keyed by weekday (0=Sun … 6=Sat). Each value is an ordered
// list of bands that "paint" the tee sheet for every day of that weekday. A band with
// `full:true` covers the whole day + all bays (the weekday's default); other bands carry
// start/end minutes (and an optional bays[]) so a manager can vary within a day. Later
// bands win over earlier ones, so a Happy-Hour band layered after the default "Open" base
// takes effect for its window. Each band denormalises the status it points at:
//   { statusId, label, color, open, full?, start?, end?, bays? }
// `open:false` means the slot is closed (unbookable, no price on the sheet).
export function weeklyBandsForWeekday(settings, weekday) {
  const ws = settings.weeklyStatus || {};
  const bands = ws[weekday] ?? ws[String(weekday)] ?? [];
  return Array.isArray(bands) ? bands : [];
}

// Effective weekly status for a bay at a given minute — or null when nothing applies
// (the implicit default: Open, bookable, priced).
export function weeklyStatusAt(settings, weekday, bayId, minute) {
  let hit = null;
  for (const b of weeklyBandsForWeekday(settings, weekday)) {
    const bays = Array.isArray(b.bays) && b.bays.length ? b.bays : null;
    if (bays && !bays.includes(bayId)) continue;
    const s = b.full ? 0 : Number(b.start);
    const e = b.full ? 24 * 60 : Number(b.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (minute >= s && minute < e) hit = b;      // last matching band wins
  }
  if (!hit) return null;
  return { label: hit.label || '', color: hit.color || null, open: hit.open !== false };
}

// Does a date-specific "Open" status override (status_open=true) cover this cell?
// Such an override re-opens a slot the weekly pattern would otherwise close ("may vary").
function dateOpenStatusCovers(overrides, dateISO, bayId, minute) {
  for (const o of overrides || []) {
    if (!o.status_open) continue;
    const bays = (o.bay_ids && o.bay_ids.length) ? o.bay_ids : null;
    if (bays && !bays.includes(bayId)) continue;
    if (o.start_min == null) return true;
    const first = dateISO === o.override_date;
    const last = dateISO === (o.end_date || o.override_date);
    const s = first ? Number(o.start_min) : 0;
    const e = last ? Number(o.end_min) : 24 * 60;
    if (minute >= s && minute < e) return true;
  }
  return false;
}

// Per-bay blocked [start,end] ranges coming from Closed weekly-pattern bands, for a date.
// A cell re-opened by a date-specific Open status override is left bookable.
export function weeklyStatusBlocked(settings, overrides, dateISO) {
  const date = new Date(dateISO + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return {};
  const weekday = date.getDay();
  const step = settings.slotStep || 30;
  const realIds = settings.bays.filter((b) => !b.holding).map((b) => b.id);
  const [open, close] = settings.hours[weekday] || [0, 0];
  const blocked = {};
  if (!(close > open)) return blocked;
  for (const id of realIds) {
    let runStart = null;
    for (let m = open * 60; m < close * 60; m += step) {
      const st = weeklyStatusAt(settings, weekday, id, m);
      const closed = st && !st.open && !dateOpenStatusCovers(overrides, dateISO, id, m);
      if (closed && runStart == null) runStart = m;
      if (!closed && runStart != null) { (blocked[id] ||= []).push([runStart, m]); runStart = null; }
    }
    if (runStart != null) (blocked[id] ||= []).push([runStart, close * 60]);
  }
  return blocked;
}

// True when [startMin,endMin) collides with a Closed weekly band (used to refuse payment).
export function weeklyStatusConflicts(settings, overrides, dateISO, bayId, startMin, endMin) {
  const ranges = weeklyStatusBlocked(settings, overrides, dateISO)[bayId] || [];
  return ranges.some(([s, e]) => startMin < e && endMin > s);
}

// Wall-clock hours from now (America/Winnipeg) until a booking's start time.
// Used for the customer cancellation policy (must cancel ≥ 24h before tee time).
export function hoursUntilBooking(dateISO, startMin) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const nowMs = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute);
  const [y, mo, d] = dateISO.split('-').map(Number);
  const startMs = Date.UTC(y, mo - 1, d, Math.floor(startMin / 60), startMin % 60);
  return (startMs - nowMs) / 3600000;
}

// Today's date (YYYY-MM-DD) in America/Winnipeg — TZ-safe even on UTC servers.
export function winnipegTodayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Expiry date (YYYY-MM-DD) for a one-time membership purchase: 'month' → +1 month, 'year' → +1 year,
// 'once' → null (no expiry / lifetime). Date-only + UTC math so it's timezone-stable.
export function membershipExpiryISO(period, fromISO) {
  const base = fromISO || winnipegTodayISO();
  const [y, m, d] = base.split('-').map(Number);
  const at = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  if (period === 'year') return at(y + 1, m, d);
  if (period === 'month') return at(y, m + 1, d);   // Date rolls Dec→Jan of next year
  return null;   // 'once'
}

// Validate the requested slot against saved settings and return the price in cents. Throws if invalid.
// dateHours (optional) is the effective open/close for the date from a venue-wide override — when
// present it replaces the weekly template so special-hours slots are priceable.
export function priceForBooking({ settings = DEFAULT_SETTINGS, dateISO, bayId, startMin, endMin, dateHours }) {
  if (!bayName(settings, bayId)) throw new Error('Unknown bay');
  const date = new Date(dateISO + 'T00:00:00');
  if (Number.isNaN(date.getTime())) throw new Error('Bad date');
  if (dateISO < winnipegTodayISO()) throw new Error('Date in the past');

  const weekday = date.getDay();
  const [open, close] = dateHours || settings.hours[weekday] || [0, 0];
  startMin = Number(startMin); endMin = Number(endMin);
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) throw new Error('Bad times');
  if (startMin % settings.slotStep || endMin % settings.slotStep) throw new Error('Times must align to 30 min');
  if (startMin < open * 60 || endMin > close * 60 || endMin <= startMin) throw new Error('Outside hours');
  if (endMin - startMin < settings.minMins) throw new Error(`Minimum ${settings.minMins / 60}-hour booking`);

  let cents = 0;
  for (let m = startMin; m < endMin; m += settings.slotStep) {
    cents += Math.round(rateFor(settings, weekday, Math.floor(m / 60), bayId) * 100 / (60 / settings.slotStep));
  }
  return cents;
}

export const fmtMin = (m) => {
  if (m >= 1440) return 'Midnight';
  const h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? 'AM' : 'PM', hh = h % 12 || 12;
  return `${hh}:${String(mm).padStart(2, '0')} ${ap}`;
};

export function summaryFor({ dateISO, startMin, endMin, players }) {
  const dateLabel = new Date(dateISO + 'T00:00:00')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return `${dateLabel} · ${fmtMin(Number(startMin))}–${fmtMin(Number(endMin))} · ${players} ${players > 1 ? 'players' : 'player'}`;
}

// Stripe key gating. This is a prototype — LIVE keys are refused so it can never charge real cards.
const isLiveKey = (k) => !!k && k.includes('_live_');
const looksTestKey = (k, prefixes) =>
  !!k && !k.includes('xxx') && k.includes('test') && prefixes.some((p) => k.startsWith(p));

export function stripeStatus(env) {
  const secretKey = env.STRIPE_SECRET_KEY;
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY;
  const hasLive = isLiveKey(secretKey) || isLiveKey(publishableKey);
  const enabled = !hasLive && looksTestKey(secretKey, ['rk_', 'sk_']) && looksTestKey(publishableKey, ['pk_']);
  return { enabled, hasLive, secretKey, publishableKey };
}
