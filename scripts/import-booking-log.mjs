// Replace the customers and bookings with the venue's GolfBooking history.
// Usage:  node scripts/import-booking-log.mjs --customers <export.csv> <log.csv> [<log.csv> …] [--add] [--dry]
//   --customers  the GolfBooking customer export (id, first_name, last_name, email_address, mobile_phone, …)
//   <log.csv>    one or more "Booking Logs" exports (Log Date, Description, User, Booking Confirmation, …)
//                A Payments export (Date Created, Customer, Amount, …, Description) may be passed with
//                the logs: its card holds name the bay a customer booked, which the log never says.
//   --add        TOP UP instead of replace: nothing is deleted. Pass every log, old and new — a booking
//                made before the last import may have been moved or cancelled since. New bookings are
//                added, changed ones updated in place, the rest left alone; new customers are added.
//   --sheet      with --add: read GolfBooking's PUBLIC booking sheet (yesterday → as far ahead as it
//                shows) and put every booking in that window in the bay the sheet has it reserved in.
//                The sheet shows which slots are taken per bay, never who took them, so bays are worked
//                out by elimination: each booking must sit on reserved slots, no two share a bay.
//   --dry        print the report and write nothing
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.
//
// ⚠ DESTRUCTIVE (without --add): without --dry this DELETES every customer and every booking first (and, by cascade,
// league memberships, hour cards and points tied to those customers), then imports.
//
// The CSVs hold real customers' names and contact details. Keep them out of this repo — it is public.
//
// A booking log is a list of EVENTS, not bookings. What it does and does not tell us:
//   - Booking Date / Start / End on every row are the booking's FINAL values, so time and date
//     changes need no replaying — only bay moves do, because the bay appears nowhere else.
//   - Most bookings never say which bay they were in. Those are put in the first bay that is free
//     at that time (Bay #1 → Private Room #2). The bay is a guess; the time is not.
//   - "Hold Cancelled" is the card hold being released at the counter — the booking stands.
//   - "Booking Cancelled - Payment Failure" is an abandoned checkout, never a booking. Skipped.
//   - The app's day ends at midnight, so a booking running past it becomes two rows, one per day.
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BAY_ORDER = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'];

export function parseCSV(text) {
  const raw = text.replace(/^﻿/, '').replace(/\r/g, '');
  const rows = []; let field = '', row = [], inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQ) {
      if (c === '"') { if (raw[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; if (row.some(f => f !== '')) rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(f => f !== '')) rows.push(row); }
  const header = rows.shift().map(h => h.trim());
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

// "8:00 PM" → 1200
export function clockToMin(s) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s.trim());
  if (!m) throw new Error(`Unreadable time "${s}"`);
  return (Number(m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
}

// Log dates are Winnipeg wall-clock time ("2026-09-23 18:48:00…"). Convert to a UTC instant,
// trying CDT then CST and keeping whichever formats back to the same wall-clock.
const wpgFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function winnipegToISO(local) {
  const wall = local.slice(0, 19);
  for (const off of [5, 6]) {
    const d = new Date(wall.replace(' ', 'T') + 'Z'); d.setUTCHours(d.getUTCHours() + off);
    if (wpgFmt.format(d) === wall) return d.toISOString();
  }
  throw new Error(`Unreadable log date "${local}"`);
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

// GolfBooking's bay names, as its log spells them, to this app's bay ids. Holding Bay is
// GolfBooking's parking spot while staff shuffle bookings — not a real bay.
export function bayIdFor(name) {
  const n = name.toLowerCase();
  if (n.includes('holding')) return null;
  if (n.includes('assiniboine')) return 'B1';
  if (n.includes('birchwood')) return 'B2';
  if (n.includes('manitopia')) return 'B3';
  if (/public bay\s*4/.test(n)) return 'B4';
  if (n.includes('mcnaught')) return 'B5';
  if (/private room\s*2/.test(n)) return 'B6';
  throw new Error(`Unknown bay "${name}"`);
}

const cents = d => Math.round(Number((/\(\$([\d.,]+)\)/.exec(d) || [])[1]?.replace(/,/g, '') || 0) * 100);
const cleanName = s => s.replace(/\s+/g, ' ').trim();

// Events → one record per confirmation code (not yet split at midnight or given a bay).
export function rebuildBookings(events) {
  const seen = new Set(), byCode = new Map();
  for (const e of events) {
    const code = e['Booking Confirmation'];
    const key = `${e['Log Date']}|${e.Description}|${code}`;       // the exports overlap; drop repeats
    if (!code || seen.has(key)) continue;
    seen.add(key);
    (byCode.get(code) || byCode.set(code, []).get(code)).push({ ...e, at: winnipegToISO(e['Log Date']) });
  }
  const out = [], skipped = { paymentFailure: 0, zeroLength: 0 };
  for (const [code, evs] of byCode) {
    evs.sort((a, b) => a.at.localeCompare(b.at));
    const desc = evs.map(e => e.Description);
    if (desc.some(d => d.startsWith('Booking Cancelled - Payment Failure'))) { skipped.paymentFailure++; continue; }
    const last = evs.at(-1);
    const name = cleanName(last['Booking Name']);
    const maintenance = /^maintenance$/i.test(name);
    const date = last['Booking Date'].slice(0, 10);
    const start = clockToMin(last['Booking Start']);
    let end = clockToMin(last['Booking End']);
    if (end === start) { if (!maintenance) { skipped.zeroLength++; continue; } end = start + 1440; }
    else if (end < start) end += 1440;

    let bay = null;
    for (const d of desc) {
      const m = /^Moved from Bay (.+?) to Bay (.+?)(?: (?:Start|Date) changed.*)?$/.exec(d);
      if (m) bay = bayIdFor(m[2]);
    }
    const created = evs.find(e => /^(Group )?Booking Created$/.test(e.Description)) || evs[0];
    const cancel = evs.find(e => e.Description === 'Booking Cancelled');
    const paid = evs.filter(e => /^(Hold Captured|Balance Collected)/.test(e.Description)).reduce((s, e) => s + cents(e.Description), 0);
    const refunded = evs.filter(e => e.Description.startsWith('Refund Issued')).reduce((s, e) => s + cents(e.Description), 0);
    out.push({
      code, date, start, end, bay,
      name: maintenance ? null : name,
      status: cancel ? 'cancelled' : maintenance ? 'blocked' : 'confirmed',
      status_label: desc.includes('Booking Updated - No Show') ? 'No Show' : null,
      source: created.User === 'Customer' ? 'online' : 'manager',
      created_at: created.at,
      cancelled_at: cancel ? cancel.at : null,
      amount_cents: paid || null,
      refunded_cents: refunded || 0,
      group: desc.some(d => d.startsWith('Group Booking')),
      moved: desc.some(d => d.startsWith('Moved from')),
      maintenance,
    });
  }
  return { bookings: out, skipped, events: seen.size };
}

// Split at midnight, then give every live row a bay without two live rows overlapping in one bay
// (the database's bookings_no_overlap constraint). Known bays are placed first; a known bay that
// collides falls back to the first free one, like the rest.
export function placeInBays(bookings) {
  const rows = [];
  for (const b of bookings) {
    const parts = b.end > 1440
      ? [[b.date, b.start, 1440, 1], [addDays(b.date, 1), 0, b.end - 1440, 2]]
      : [[b.date, b.start, b.end, 0]];
    for (const [date, s, e, part] of parts) rows.push({ ...b, date, start: s, end: e, part });
  }
  const taken = new Map();                                        // "date|bay" → [row, …]
  const clashes = (date, bay, s, e) => (taken.get(`${date}|${bay}`) || []).filter(o => s < o.end && e > o.start);
  const free = (date, bay, s, e) => !clashes(date, bay, s, e).length;
  const take = r => (taken.get(`${r.date}|${r.bay}`) || taken.set(`${r.date}|${r.bay}`, []).get(`${r.date}|${r.bay}`)).push(r);
  const live = rows.filter(r => r.status !== 'cancelled');
  const order = (a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.code.localeCompare(b.code);
  const stats = { knownBay: 0, knownBayMoved: 0, autoBay: 0, noRoom: [] };
  for (const r of live.filter(r => r.bay).sort(order)) {
    if (free(r.date, r.bay, r.start, r.end)) { take(r); r.fromLog = true; stats.knownBay++; }
    else { r.bay = null; stats.knownBayMoved++; }
  }
  // Fill the rest in time order — that packs the bays tightest.
  const unplaced = [];
  for (const r of live.filter(r => !r.bay).sort(order)) {
    r.bay = BAY_ORDER.find(bay => free(r.date, bay, r.start, r.end)) || null;
    if (r.bay) { take(r); stats.autoBay++; } else unplaced.push(r);
  }
  // GolfBooking let a slot be sold more times than there are bays. When a booking is left without
  // one, and a bay at that time is held only by likely phantoms — a no-show, or the same person
  // booking the same slot twice — the booking takes the bay and the phantom is the one left out.
  const firstOfSlot = new Set();
  for (const r of live.slice().sort(order)) {
    const slot = `${(r.name || '').toLowerCase()}|${r.date}|${r.start}|${r.end}`;
    r.weak = r.status_label === 'No Show' || (!!r.name && firstOfSlot.has(slot));
    firstOfSlot.add(slot);
  }
  const noRoom = [];
  for (const r of unplaced) {
    const bay = r.weak ? null : BAY_ORDER.find(b => clashes(r.date, b, r.start, r.end).every(o => o.weak));
    if (!bay) { noRoom.push(r); continue; }
    const list = taken.get(`${r.date}|${bay}`), evicted = clashes(r.date, bay, r.start, r.end);
    taken.set(`${r.date}|${bay}`, list.filter(o => !evicted.includes(o)));
    evicted.forEach(o => { o.bay = null; noRoom.push(o); stats[o.fromLog ? 'knownBay' : 'autoBay']--; });
    r.bay = bay; take(r); stats.autoBay++;
  }
  stats.noRoom = noRoom.map(r => `${r.code} ${r.date} ${r.start}-${r.end}${r.weak ? ' (no-show/duplicate)' : ''}`);
  for (const r of rows) if (r.status === 'cancelled' && !r.bay) r.bay = BAY_ORDER[0];
  return { rows: rows.filter(r => r.bay), stats };
}

// ----- Top-up (--add) -----------------------------------------------------------------------------
// Compares the rebuilt bookings with what the live table already holds (rows whose note carries
// "Imported from GolfBooking #CODE"). Since migration 0038 a booking can run past midnight in ONE row,
// so nothing new is split; older imports split in two ("part 1 of 2") are read back as one booking.
const CODE_RE = /Imported from GolfBooking #([A-Za-z0-9]+)(?: · overnight, part (\d) of 2)?/;
const dayNo = (iso) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
const FIELDS = ['date', 'start', 'end', 'status', 'status_label', 'amount_cents', 'refunded_cents'];
const KEEP_UNLESS_SET = ['status_label', 'amount_cents', 'refunded_cents'];

export function liveByCode(liveRows) {
  const byCode = new Map();
  for (const r of liveRows) {
    const m = CODE_RE.exec(r.note || ''); if (!m) continue;
    const e = byCode.get(m[1]) || byCode.set(m[1], { ids: [], extra: [] }).get(m[1]);
    if (/· extra bay/.test(r.note)) { e.extra.push({ id: r.id, bay: r.bay_id }); continue; }   // a group's other bays — never dropped
    e.ids.push(r.id);
    if (m[2] === '2') { e.end2 = r.end_min; e.part2 = r; continue; }
    Object.assign(e, { id: r.id, bay: r.bay_id, date: r.booking_date, start: r.start_min, end: r.end_min, status: r.status,
      status_label: r.status_label ?? null, amount_cents: r.amount_cents ?? null, refunded_cents: r.refunded_cents || 0, split: m[2] === '1' });
  }
  for (const e of byCode.values()) {
    if (e.split && e.end2 != null) e.end = 1440 + e.end2;
    // Only the after-midnight half made it in last time (the evening had no free bay).
    if (!e.id && e.part2) Object.assign(e, { id: e.part2.id, bay: e.part2.bay_id, halfOnly: true });
  }
  return byCode;
}

// `before` is the log rebuilt only from events up to the last import (code → booking) — used to tell
// a booking the last import left out. `changedSince` is the set of codes with ANY log event after the
// last import. A field that differs from the live row is applied when GolfBooking touched that booking
// since; otherwise the live value is an edit made in this portal, and it is kept (and reported).
// (Comparing against `before`'s values does not work: every row of a newer export carries the
// booking's CURRENT times, so an old event read from it already looks changed.)
// A bay from GolfBooking's sheet is GolfBooking's word on where the booking is now, so it applies.
export function planAdd(bookings, liveRows, before = new Map(), changedSince = null) {
  const live = liveByCode(liveRows);
  const adds = [], updates = [], noRoom = [], keptEdits = [], groupsToCheck = [], groupMoves = [];
  let unchanged = 0;
  const touched = new Set();
  for (const log of bookings) {
    const b = { ...log }, cur = live.get(b.code), was = before.get(b.code);
    if (!cur) { adds.push({ ...b, leftOutBefore: !!was }); touched.add(b.code); continue; }
    if (cur.halfOnly) {   // try again to fit the whole session in one row; if it will not fit, the half stays
      updates.push({ ...b, bay: b.bay || cur.bay, id: cur.id, dropIds: [], diff: ['whole session in one row'], was: cur, leftOutBefore: true });
      touched.add(b.code); continue;
    }
    // The log can add a no-show, a payment or a refund, but its silence never erases one that staff
    // recorded in this portal since the last import.
    const keep = (f) => KEEP_UNLESS_SET.includes(f) && !b[f];
    const differs = FIELDS.filter((f) => !keep(f) && (b[f] ?? null) !== (cur[f] ?? null));
    if (b.bay && b.bay !== cur.bay && b.status !== 'cancelled') differs.push('bay');
    const byGolfBooking = (f) => !changedSince || changedSince.has(b.code) || (f === 'bay' && !!b.sheetBays);
    const diff = differs.filter(byGolfBooking), kept = differs.filter((f) => !byGolfBooking(f));
    if (kept.length) keptEdits.push({ code: b.code, name: b.name, kept, cur, log });
    // A group whose bays GolfBooking's sheet shows: its rows are re-bayed together, as a set.
    if (b.sheetBays && (cur.extra.length || b.sheetBays.length > 1)) {
      const rows = [{ id: cur.id, bay: cur.bay }, ...cur.extra];
      const other = diff.filter((f) => f !== 'bay'), same = rows.map((r) => r.bay).sort().join() === [...b.sheetBays].sort().join();
      if (!other.length && same) { unchanged++; continue; }
      if (other.length || rows.length !== b.sheetBays.length) {
        groupsToCheck.push({ ...b, diff: [...other, ...(same ? [] : [`bays ${rows.map((r) => r.bay).join('+')} here, ${b.sheetBays.join('+')} on GolfBooking's sheet`])] });
        unchanged++; continue;
      }
      const left = b.sheetBays.filter((x) => !rows.some((r) => r.bay === x));
      groupMoves.push({ ...b, moves: rows.map((r) => ({ id: r.id, from: r.bay, to: b.sheetBays.includes(r.bay) ? r.bay : left.shift() })) });
      touched.add(b.code); continue;
    }
    if (!diff.length) { unchanged++; continue; }
    // A group across several bays: rewriting one row would split it from its other bays. Staff decide.
    if (cur.extra.length) { groupsToCheck.push({ ...b, diff }); unchanged++; continue; }
    for (const f of KEEP_UNLESS_SET) if (keep(f)) b[f] = cur[f];
    for (const f of kept) if (f !== 'bay') b[f] = cur[f];
    updates.push({ ...b, bay: diff.includes('bay') ? b.bay : cur.bay, id: cur.id, dropIds: cur.ids.filter((i) => i !== cur.id), diff, was: cur });
    touched.add(b.code);
  }
  // Who already has each bay, in minutes from a fixed day so a session past midnight overlaps
  // the next morning. The rows being rewritten are left out — they are about to move.
  const busy = new Map();
  const hold = (bay, s, e, code) => (busy.get(bay) || busy.set(bay, []).get(bay)).push([s, e, code]);
  for (const r of liveRows) {
    const m = CODE_RE.exec(r.note || '');
    if (r.status === 'cancelled' || (m && touched.has(m[1]))) continue;
    const d = dayNo(r.booking_date) * 1440; hold(r.bay_id, d + r.start_min, d + r.end_min, m ? m[1] : r.id);
  }
  // The sheet's groups are placed first: GolfBooking says these bays are theirs.
  for (const g of groupMoves) { const d = dayNo(g.date) * 1440; g.moves.forEach((m) => hold(m.to, d + g.start, d + g.end, g.code)); }
  const yielded = [];   // the log's bay was taken (usually by a guessed bay from an earlier import)
  const free = (bay, s, e) => !(busy.get(bay) || []).some(([a, z]) => s < z && e > a);
  const order = (a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.code.localeCompare(b.code);
  // Bookings whose bay is known go first, like placeInBays — otherwise an earlier booking with no
  // known bay can take the bay that the log says a later one was moved into.
  const all = [...updates, ...adds].sort((a, b) => (!a.bay - !b.bay) || order(a, b));
  for (const r of all) {
    if (r.status === 'cancelled') { r.bay = r.bay || BAY_ORDER[0]; continue; }
    const d = dayNo(r.date) * 1440, s = d + r.start, e = d + r.end;
    const bay = [r.bay, ...BAY_ORDER].find((x) => x && free(x, s, e));
    if (!bay) { noRoom.push(r); continue; }
    if (r.bay && bay !== r.bay && r.moved) yielded.push({ code: r.code, name: r.name, wanted: r.bay, got: bay });
    if (r.bay && bay !== r.bay && r.diff) r.diff.push('bay');
    r.bay = bay; hold(bay, s, e, r.code);
    // A new group's other bays, as the sheet shows them.
    r.extraBays = (r.sheetBays || []).filter((x) => x !== bay && free(x, s, e));
    r.extraBays.forEach((x) => hold(x, s, e, r.code));
  }
  const placed = (r) => !noRoom.includes(r);
  return { adds: adds.filter(placed), updates: updates.filter(placed), unchanged, noRoom, keptEdits, groupsToCheck, yielded, groupMoves };
}

// Customers in the export that the live table does not know by email or phone.
export function newCustomers(customers, liveCustomers) {
  const emails = new Set(liveCustomers.map((c) => (c.email || '').toLowerCase()).filter(Boolean));
  const phones = new Set(liveCustomers.map((c) => cleanPhone(c.phone)).filter(Boolean));
  return customers.filter((c) => !(c.email && emails.has(c.email)) && !(c.phone && phones.has(c.phone)));
}

// "Kade Test - Sun Sep 27 2026, 12:00 AM -  Birchwood  Bay #2  (credit card hold)" → the bay a customer
// booked. Matched on name + date + start (a payment row carries no confirmation code) and used only
// for a booking the log never moved — a move is later, so it wins.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
export function baysFromPayments(paymentRows) {
  const out = new Map();
  for (const p of paymentRows) {
    const m = /^(.+?) - \w{3} (\w{3}) (\d{1,2}) (\d{4}), (\d{1,2}:\d{2} [AP]M) - (.+?)\s*\(credit card hold\)\s*$/.exec(p.Description || '');
    if (!m || !MONTHS[m[2]]) continue;
    let bay; try { bay = bayIdFor(m[6]); } catch { continue; }
    if (!bay) continue;
    const date = `${m[4]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    out.set(`${nameKey(m[1])}|${date}|${clockToMin(m[5])}`, bay);
  }
  return out;
}
export function applyPaymentBays(bookings, bays) {
  let n = 0;
  for (const b of bookings) {
    if (b.moved || b.bay) continue;
    const bay = bays.get(`${nameKey(b.name)}|${b.date}|${b.start}`);
    if (bay) { b.bay = bay; n++; }
  }
  return n;
}

// ----- GolfBooking's public booking sheet (--sheet) ---------------------------------------------------
// bookingsheet.php?date=D draws D's day 4:00 AM → 3:30 AM. A taken slot is a "Reserved" cell whose
// waitlist button names its time and bay; slots before 4 AM belong to the next date. On today's
// sheet the slots already gone are not drawn at all, so they are "unknown", not free.
const SHEET_URL = 'https://invictusgolf.golfbook.in/bookingsheet.php';
const sheetMin = (t) => { const m = clockToMin(t); return m < 240 ? m + 1440 : m; };
export function parseSheet(html, date) {
  if (!/openWaitlistModal|\/ hour/.test(html)) return null;   // "Reservations for this day are currently unavailable"
  const reserved = [];
  for (const [, t, bay] of html.matchAll(/<b>Reserved<\/b>[\s\S]*?openWaitlistModal\('(\d{1,2}:\d{2} [AP]M)', \d+, \d+, '([^']*)'/g)) {
    const m = sheetMin(t);
    reserved.push(m >= 1440 ? [addDays(date, 1), bayIdFor(bay), m - 1440] : [date, bayIdFor(bay), m]);
  }
  // Every drawn cell ends in "…Bay name , 11:30 AM" or carries its time in the waitlist button.
  const times = [...html.matchAll(/(?:, |openWaitlistModal\(')(\d{1,2}:\d{2} [AP]M)/g)].map(([, t]) => sheetMin(t));
  return { date, reserved, from: Math.min(...times) };
}
export async function fetchSheets(fromDate, maxDays = 60) {
  const sheets = [];
  for (let i = 0, d = fromDate; i < maxDays; i++, d = addDays(d, 1)) {
    const res = await fetch(`${SHEET_URL}?date=${d}&lang=en`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`GolfBooking sheet ${d}: HTTP ${res.status}`);
    const sheet = parseSheet(await res.text(), d);
    if (!sheet) { if (i > 0) break; continue; }   // the first date past its booking window
    sheets.push(sheet);
    await new Promise((r) => setTimeout(r, 700));   // a person's pace, not a crawler's
  }
  return sheets;
}

// Bays for every live booking inside the sheets' window. `groupSize(code)` says how many bays a
// group already has here (1 when unknown). Returns code → [bay, …] plus what could not be explained.
export function solveSheetBays(bookings, sheets, groupSize = () => 1) {
  const taken = new Set(), visible = new Map();
  for (const sh of sheets) {
    visible.set(sh.date, sh.from);
    for (const [d, bay, m] of sh.reserved) taken.add(`${d}|${bay}|${m}`);
  }
  const first = sheets[0]?.date, last = sheets.at(-1)?.date;
  if (!first) return { bays: new Map(), unexplained: [], unplaced: [] };
  // A slot is judged against the sheet that draws it: its own date's before 4 AM belongs to the day before.
  const sheetOf = (d, m) => (m < 240 ? [addDays(d, -1), m + 1440] : [d, m]);
  const hidden = (d, m) => { const [sd, sm] = sheetOf(d, m); return !visible.has(sd) || sm < visible.get(sd); };
  const slots = (b) => { const o = []; for (let m = b.start; m < b.end; m += 30) o.push(m < 1440 ? [b.date, m] : [addDays(b.date, 1), m - 1440]); return o; };
  const inWindow = (b) => { const [sd] = sheetOf(b.date, b.start); return sd >= first && sd <= last; };
  const units = [];
  for (const b of bookings) {
    if (b.status === 'cancelled' || !inWindow(b)) continue;
    const sl = slots(b), seen = sl.filter(([d, m]) => !hidden(d, m));
    if (!seen.length) continue;                                        // entirely in the part of today already gone
    const cand = BAY_ORDER.filter((bay) => seen.every(([d, m]) => taken.has(`${d}|${bay}|${m}`)));
    const k = Math.max(1, groupSize(b.code));
    for (let i = 0; i < k; i++) units.push({ b, sl, seen, cand: b.bay && i === 0 && cand.includes(b.bay) ? [b.bay] : cand, abs: [dayNo(b.date) * 1440 + b.start, dayNo(b.date) * 1440 + b.end] });
  }
  const unplaced = units.filter((u) => !u.cand.length);
  const todo = units.filter((u) => u.cand.length).sort((a, c) => a.cand.length - c.cand.length || a.abs[0] - c.abs[0]);
  const at = new Map();   // bay → [[s, e]]
  const fits = (bay, [s, e]) => !(at.get(bay) || []).some(([a, z]) => s < z && e > a);
  const put = (bay, r) => (at.get(bay) || at.set(bay, []).get(bay)).push(r);
  const drop = (bay, r) => { const l = at.get(bay); l.splice(l.indexOf(r), 1); };
  let steps = 0;
  const dfs = (i) => {
    if (i === todo.length) return true;
    if (++steps > 200000) return false;
    const u = todo[i];
    const mine = u.b.liveBays || [];   // among equally good answers, the bays it already has here
    const order = [...u.cand.filter((x) => mine.includes(x)), ...u.cand.filter((x) => !mine.includes(x))];
    for (const bay of order) {
      if (!fits(bay, u.abs)) continue;
      u.bay = bay; put(bay, u.abs);
      if (dfs(i + 1)) return true;
      drop(bay, u.abs); u.bay = null;
    }
    return false;
  };
  const solved = dfs(0);
  if (!solved) return { bays: new Map(), unexplained: [], unplaced, failed: true };
  const bays = new Map();
  for (const u of todo) (bays.get(u.b.code) || bays.set(u.b.code, []).get(u.b.code)).push(u.bay);
  // Reserved slots nobody explains. A NEW group booking takes the ones that match its time exactly
  // in other bays — the log says "Group Booking Created" but never how many bays.
  const covered = new Set();
  for (const u of todo) for (const [d, m] of u.sl) covered.add(`${d}|${u.bay}|${m}`);
  for (const b of bookings) {
    if (!b.group || groupSize(b.code) > 1 || !bays.has(b.code)) continue;
    for (const bay of BAY_ORDER) {
      if (bays.get(b.code).includes(bay)) continue;
      const sl = slots(b);
      if (sl.every(([d, m]) => hidden(d, m) || (taken.has(`${d}|${bay}|${m}`) && !covered.has(`${d}|${bay}|${m}`)))) {
        bays.get(b.code).push(bay); sl.forEach(([d, m]) => covered.add(`${d}|${bay}|${m}`));
      }
    }
  }
  const unexplained = [...taken].filter((k) => !covered.has(k));
  return { bays, unexplained, unplaced };
}

export function cleanPhone(p) {
  let d = (p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return '+' + (d.length === 10 ? '1' + d : d);
}

// Everyone in the export with a name and at least one way to reach them.
export function customersFrom(exportRows) {
  const out = [];
  for (const r of exportRows) {
    const name = cleanName(`${r.first_name || ''} ${r.last_name || ''}`);
    const email = (r.email_address || '').trim().toLowerCase() || null;
    const phone = cleanPhone(r.mobile_phone);
    if (!name || (!email && !phone)) continue;
    const added = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(r.added || '') ? winnipegToISO(r.added) : null;
    out.push({ name, email, phone, notes: (r.note || '').trim() || null, ...(added && { created_at: added }) });
  }
  return out;
}

// A booking only carries a name. Copy the contact details across when exactly one customer has
// that name, so the Customers tab can count the booking against them; never guess between two.
const nameKey = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
export function linkContacts(rows, customers) {
  const byName = new Map();
  for (const c of customers) (byName.get(nameKey(c.name)) || byName.set(nameKey(c.name), []).get(nameKey(c.name))).push(c);
  let linked = 0;
  for (const r of rows) {
    const hits = r.name ? byName.get(nameKey(r.name)) || [] : [];
    if (hits.length === 1) { r.email = hits[0].email; r.phone = hits[0].phone; linked++; }
  }
  return linked;
}

export function toBookingRow(r) {
  const tag = r.part ? ` · overnight, part ${r.part} of 2` : '';
  return {
    bay_id: r.bay, booking_date: r.date, start_min: r.start, end_min: r.end,
    status: r.status, status_label: r.status_label,
    customer_name: r.name, customer_email: r.email || null, customer_phone: r.phone || null,
    amount_cents: r.part === 2 ? null : r.amount_cents,
    refunded_cents: r.part === 2 ? 0 : r.refunded_cents,
    source: r.source, created_at: r.created_at, cancelled_at: r.cancelled_at,
    note: `${r.maintenance ? 'Maintenance · ' : ''}${r.group ? 'Group booking · ' : ''}Imported from GolfBooking #${r.code}${tag}`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const DRY = args.includes('--dry'), ADD = args.includes('--add');
  const ci = args.indexOf('--customers');
  const customerFile = ci >= 0 ? args[ci + 1] : null;
  const logFiles = args.filter((a, i) => !a.startsWith('--') && i !== ci + 1);
  if (!customerFile || !logFiles.length) {
    console.error('Usage: node scripts/import-booking-log.mjs --customers <export.csv> <log.csv> [<log.csv> …] [--dry]');
    process.exit(1);
  }

  const customers = customersFrom(parseCSV(fs.readFileSync(customerFile, 'utf8')));
  // Every row carries the booking's date and times as they were when THAT file was exported, and a
  // repeated event keeps the first copy read — so read the newest export first.
  const files = logFiles.map(f => parseCSV(fs.readFileSync(f, 'utf8')));
  const payments = files.filter(rows => rows.length && 'Date Created' in rows[0]).flat();
  const logs = files.filter(rows => rows.length && 'Log Date' in rows[0])
    .sort((a, b) => Math.max(...b.map(e => Date.parse(winnipegToISO(e['Log Date'])))) - Math.max(...a.map(e => Date.parse(winnipegToISO(e['Log Date'])))));
  const events = logs.flat();
  const { bookings, skipped, events: uniqueEvents } = rebuildBookings(events);
  const paidBays = applyPaymentBays(bookings, baysFromPayments(payments));
  if (payments.length) console.log(`Bays taken from ${payments.length} card holds in the Payments export: ${paidBays}`);
  if (ADD) return topUp({ customers, bookings, skipped, events, DRY, SHEET: args.includes('--sheet') });
  const { rows, stats } = placeInBays(bookings);
  const linked = linkContacts(rows, customers);
  const bookingRows = rows.map(toBookingRow);

  const dates = bookingRows.map(r => r.booking_date).sort();
  console.log(JSON.stringify({
    customers: customers.length,
    logEvents: events.length, uniqueEvents,
    bookingsRebuilt: bookings.length,
    skippedPaymentFailures: skipped.paymentFailure, skippedZeroLength: skipped.zeroLength,
    rowsAfterMidnightSplit: bookingRows.length,
    confirmed: bookingRows.filter(r => r.status === 'confirmed').length,
    cancelled: bookingRows.filter(r => r.status === 'cancelled').length,
    blocked: bookingRows.filter(r => r.status === 'blocked').length,
    noShows: bookingRows.filter(r => r.status_label === 'No Show').length,
    bayFromLog: stats.knownBay, bayFromLogButClashed: stats.knownBayMoved, bayAutoAssigned: stats.autoBay,
    droppedNoFreeBay: stats.noRoom,
    bookingsLinkedToCustomer: linked,
    dateRange: `${dates[0]} → ${dates.at(-1)}`,
  }, null, 2));
  if (DRY) return;

  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const must = (what, { error }) => { if (error) { console.error(`${what} failed: ${error.message}`); process.exit(1); } };

  must('delete bookings', await db.from('bookings').delete().not('id', 'is', null));
  must('delete customers', await db.from('customers').delete().not('id', 'is', null));
  console.log('deleted existing customers and bookings');

  for (let i = 0; i < customers.length; i += 200) must(`customers at ${i}`, await db.from('customers').insert(customers.slice(i, i + 200)));
  console.log(`inserted ${customers.length} customers`);
  for (let i = 0; i < bookingRows.length; i += 200) must(`bookings at ${i}`, await db.from('bookings').insert(bookingRows.slice(i, i + 200)));
  console.log(`inserted ${bookingRows.length} bookings`);
}

export async function topUp({ customers, bookings, skipped, events, DRY, SHEET }) {
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const must = (what, { data, error }) => { if (error) { console.error(`${what} failed: ${error.message}`); process.exit(1); } return data; };
  // One row per booking past midnight needs migration 0038 (bookings.span); refuse without it.
  if ((await db.from('bookings').select('span').limit(1)).error) {
    console.error('Run supabase/migrations/0038_bookings_past_midnight.sql first — this adds late sessions as one row each.');
    process.exit(1);
  }
  const readAll = async (table, cols) => {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const page = must(`read ${table}`, await db.from(table).select(cols).range(from, from + 999));
      out.push(...page); if (page.length < 1000) return out;
    }
  };
  const liveRows = await readAll('bookings', 'id,bay_id,booking_date,start_min,end_min,status,status_label,amount_cents,refunded_cents,note,created_at');
  const liveCustomers = await readAll('customers', 'email,phone');
  // The last import saw every event up to the newest booking it created.
  const cutoff = liveRows.filter(r => CODE_RE.test(r.note || '')).map(r => new Date(r.created_at).toISOString()).sort().at(-1) || '';
  const before = new Map(rebuildBookings(events.filter(e => winnipegToISO(e['Log Date']) <= cutoff)).bookings.map(b => [b.code, b]));
  if (SHEET) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Winnipeg' }).format(new Date(Date.now()));
    const sheets = await fetchSheets(addDays(today, -1));
    const live = liveByCode(liveRows);
    for (const b of bookings) if (live.has(b.code)) { const l = live.get(b.code); b.liveBays = [l.bay, ...l.extra.map(x => x.bay)]; }   // among equal answers, move nothing
    const sol = solveSheetBays(bookings, sheets, code => (live.has(code) ? 1 + live.get(code).extra.length : 1));
    if (sol.failed) { console.error("GolfBooking's sheet and the log do not fit together — nothing matched to it."); }
    for (const b of bookings) {
      const bays = sol.bays.get(b.code); if (!bays) continue;
      b.bay = bays[0]; b.sheetBays = bays; b.moved = true;
    }
    console.log(`GolfBooking's public sheet ${sheets[0]?.date} → ${sheets.at(-1)?.date}: ${sheets.reduce((n, sh) => n + sh.reserved.length, 0)} reserved slots, `
      + `${sol.bays.size} bookings placed by it; slots nobody explains: ${sol.unexplained.length}${sol.unexplained.length ? ' (' + sol.unexplained.join(' ') + ')' : ''}; `
      + `bookings not on the sheet: ${sol.unplaced.length}${sol.unplaced.length ? ' (' + sol.unplaced.map(u => u.b.code).join(' ') + ')' : ''}`);
  }
  const changedSince = new Set(events.filter(e => winnipegToISO(e['Log Date']) > cutoff).map(e => e['Booking Confirmation']));
  const { adds, updates, unchanged, noRoom, keptEdits, groupsToCheck, yielded, groupMoves } = planAdd(bookings, liveRows, before, changedSince);
  const addCustomers = newCustomers(customers, liveCustomers);
  linkContacts(adds, customers);

  const t = (r) => `${r.date} ${fmt(r.start)}–${fmt(r.end)}`;
  const fmt = (m) => { const x = m % 1440, h = Math.floor(x / 60); return `${h % 12 || 12}:${String(x % 60).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
  console.log(`Rebuilt ${bookings.length} bookings from the logs (skipped ${skipped.paymentFailure} abandoned checkouts). Last import saw events up to ${cutoff}.`);
  console.log(`  already live and unchanged: ${unchanged}`);
  console.log(`  NEW customers to add: ${addCustomers.length}`);
  console.log(`  NEW bookings to add: ${adds.length}`);
  for (const r of adds) console.log(`    + ${r.code.padEnd(9)} ${t(r).padEnd(28)} ${[r.bay, ...(r.extraBays || [])].join('+').padEnd(8)} ${r.status.padEnd(9)} ${r.name || '(block)'}`);
  console.log(`  CHANGED bookings to update: ${updates.length}`);
  for (const r of updates) console.log(`    ~ ${r.code.padEnd(9)} ${t(r).padEnd(28)} ${r.bay} ${r.status.padEnd(9)} ${r.name || '(block)'} — ${r.diff.join(', ')}${r.was.split ? ' (two overnight rows become one)' : ''}`);
  if (groupMoves.length) {
    console.log(`  GROUP BOOKINGS put in the bays GolfBooking's sheet shows: ${groupMoves.length}`);
    for (const g of groupMoves) console.log(`    ~ ${g.code.padEnd(9)} ${t(g).padEnd(28)} ${g.name || ''}: ${g.moves.filter(m => m.from !== m.to).map(m => `${m.from}→${m.to}`).join(', ')}`);
  }
  if (keptEdits.length) {
    console.log(`  KEPT — changed in this portal, not in GolfBooking: ${keptEdits.length}`);
    const show = (f, v) => (f === 'start' || f === 'end' ? fmt(v) : v);
    for (const r of keptEdits) console.log(`    = ${r.code.padEnd(9)} ${r.name || '(block)'}: ${r.kept.map(f => `${f} ${show(f, r.cur[f])} here (GolfBooking: ${show(f, r.log[f])})`).join(', ')}`);
  }
  if (groupsToCheck.length) {
    console.log(`  GROUP BOOKINGS changed in GolfBooking — not touched, check by hand: ${groupsToCheck.length}`);
    for (const r of groupsToCheck) console.log(`    ? ${r.code.padEnd(9)} ${t(r)} ${r.name || ''} — ${r.diff.join(', ')}`);
  }
  if (yielded.length) {
    console.log(`  in another bay — the one GolfBooking moved them to was already taken here: ${yielded.length}`);
    for (const r of yielded) console.log(`    ↷ ${r.code.padEnd(9)} ${r.name || ''}: ${r.wanted} taken → ${r.got}`);
  }
  const again = noRoom.filter(r => r.leftOutBefore), fresh = noRoom.filter(r => !r.leftOutBefore);
  if (again.length) console.log(`  still left out (oversold in GolfBooking, also left out last import): ${again.length}`);
  if (fresh.length) {
    console.log(`  LEFT OUT, no free bay at that time: ${fresh.length}`);
    for (const r of fresh) console.log(`    ! ${r.code.padEnd(9)} ${t(r)} ${r.name || ''}`);
  }
  if (DRY) { console.log('Dry run — nothing written.'); return; }

  if (addCustomers.length) must('add customers', await db.from('customers').insert(addCustomers));
  // Moving bookings between bays can be a swap (A takes B's bay while B takes A's), and a booking
  // that gets shorter or moves in time frees minutes a new booking is about to take — and the
  // database refuses two bookings in one bay even for a moment. So EVERY row being rewritten first
  // steps into a parking bay of its own, then the new bookings go in, then each takes its final place.
  const rewrite = [
    ...updates.map(r => ({ id: r.id, from: r.was.bay, to: r.bay, r })),
    ...groupMoves.flatMap(g => g.moves.filter(m => m.from !== m.to).map(m => ({ id: m.id, from: m.from, to: m.to }))),
  ];
  const parked = rewrite;
  const undo = async (why) => {
    console.error(`${why} — putting moved bookings back in their bays.`);
    for (const w of parked) {
      const { error } = await db.from('bookings').update({ bay_id: w.from }).eq('id', w.id);
      if (error) console.error(`  could not put booking ${w.id} back in ${w.from}: ${error.message} — fix it on the tee sheet`);
    }
    process.exit(1);
  };
  const step = async (what, q) => { const { error } = await q; if (error) await undo(`${what} failed: ${error.message}`); };
  for (const w of parked) await step(`park ${w.id}`, db.from('bookings').update({ bay_id: `PARK-${w.id.slice(0, 8)}` }).eq('id', w.id));
  for (const r of updates) if (r.dropIds.length) await step(`merge ${r.code}`, db.from('bookings').delete().in('id', r.dropIds));
  const addRows = adds.flatMap(r => { const row = toBookingRow(r); return [row, ...(r.extraBays || []).map(bay => ({ ...row, bay_id: bay, amount_cents: null, note: `${row.note} · extra bay` }))]; });
  for (let i = 0; i < addRows.length; i += 200) await step(`add bookings at ${i}`, db.from('bookings').insert(addRows.slice(i, i + 200)));
  for (const w of rewrite) {
    if (!w.r) { await step(`move ${w.id}`, db.from('bookings').update({ bay_id: w.to }).eq('id', w.id)); continue; }
    const row = toBookingRow(w.r);
    await step(`update ${w.r.code}`, db.from('bookings').update({
      bay_id: row.bay_id, booking_date: row.booking_date, start_min: row.start_min, end_min: row.end_min,
      status: row.status, status_label: row.status_label, amount_cents: row.amount_cents, refunded_cents: row.refunded_cents,
      cancelled_at: row.cancelled_at, note: row.note,
    }).eq('id', w.id));
  }
  console.log(`Done: added ${addCustomers.length} customers and ${addRows.length} booking rows, updated ${updates.length}, re-bayed ${groupMoves.length} group bookings.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
