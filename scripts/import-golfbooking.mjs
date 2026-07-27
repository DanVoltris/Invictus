// One-off import of the GolfBooking exports (customers / members / waivers) into Supabase.
// Usage:  node scripts/import-golfbooking.mjs <csv-dir> [--dry] [--force]
//   <csv-dir> must contain customers.csv, members.csv, waivers.csv
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env. --dry prints the report without writing.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const DIR = process.argv[2] || '.';
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

// ---------- CSV parsing (quoted fields, CRLF, double-encoded UTF-8 repair) ----------
function repairMojibake(s) {
  // The export double-encoded UTF-8 (e.g. "CÃ´tÃ©" for "Côté", "Â " for nbsp).
  if (!/[ÃÂ]/.test(s)) return s;
  try { const fixed = Buffer.from(s, 'latin1').toString('utf8'); return /�/.test(fixed) ? s : fixed; }
  catch { return s; }
}
function parseCSV(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
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
  const header = rows.shift();
  return rows.map(r => Object.fromEntries(header.map((h, i) =>
    [h.trim(), repairMojibake((r[i] || '').replace(/ /g, ' ').trim())])));
}

// ---------- Email cleaning ----------
const EMAIL_FIXES = {
  'finley.frost@exmaple.com': 'finley.frost@example.com',
  'casey.calder@exmaple.com': 'casey.calder@example.com',
  'harper.halex@example.com': 'harper.hale@example.com',
  'zane.ashbyx@example.com': 'zane.ashby@example.com',
  'zane.ashbyx2@example.com': 'zane.ashby@example.com',
  'oakley.oakesx@example.com': 'oakley.oakes@example.com',
  'reese.ridley@exmaple.com': 'reese.ridley@example.com',
  'bailey.brooksx@example.com': 'bailey.brooks@example.com',
  'devon.dunnex@example.com': 'devon.dunne@example.com',
  'eden.fennx@example.com': 'eden.fenn@example.com',
  'brook.carrowx@example.com': 'brook.carrow@example.com',
  'tatum.thornex@example.com': 'tatum.thorne@example.com',
  'orion.pell@exmaple.com': 'orion.pell@example.com',
  'wren.whitbyx@example.com': 'wren.whitby@example.com',
  'finley.frost2@exmaple.com': 'finley.frost@example.com',
  'xen.yarrow@exmaple.com': 'xen.yarrow@example.com',
  'kit.lindenx@example.com': 'kit.linden@example.com',
};
let emailFixCount = 0;
function cleanEmail(e) {
  let x = (e || '').trim().toLowerCase();
  if (!x) return null;
  const before = x;
  x = x.replace(/\.con$/, '.com').replace(/\.clm$/, '.com').replace(/\.coom$/, '.com')
       .replace(/@gmail\.co$/, '@gmail.com').replace(/@gmail$/, '@gmail.com').replace(/@gmaii\.com$/, '@gmail.com');
  if (EMAIL_FIXES[x]) x = EMAIL_FIXES[x];
  if (x !== before) emailFixCount++;
  return x;
}

// ---------- Phone cleaning ----------
const PHONE_FIXES = { '1168467297': '4168467297', '20427922231': '2047922231', '20479362615': '2047932615' };
let phoneFixCount = 0;
function cleanPhone(p) {
  let d = (p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  while (d.length > 10 && (d[0] === '0' || d[0] === '1')) d = d.slice(1);
  if (PHONE_FIXES[d]) { d = PHONE_FIXES[d]; phoneFixCount++; }
  return '+' + (d.length === 10 ? '1' + d : d);
}

// ---------- Name matching ----------
const NICKS = [['mike','michael'],['chris','christopher'],['matt','matthew'],['dan','daniel'],['danny','daniel'],
  ['dave','david'],['ben','benjamin'],['sam','samuel'],['joe','joseph'],['josh','joshua'],['tom','thomas'],
  ['jim','james'],['jimmie','james'],['rob','robert'],['bob','robert'],['tony','anthony'],['steve','steven'],
  ['jeff','jeffrey'],['nick','nicholas'],['nate','nathaniel'],['nate','nathan'],['greg','gregory'],['ted','edward'],
  ['andy','andrew'],['tim','timothy'],['ken','kenneth'],['ron','ronald'],['don','donald'],['will','william']];
const lev = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return m[a.length][b.length];
};
const tokens = n => (n || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/[\s'-]+/).filter(t => t.length > 1);
function firstOk(a, b) {
  if (!a || !b) return false;
  if (a === b || (a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b))) return true;
  if (NICKS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))) return true;
  return lev(a, b) <= 1;
}
function lastOk(a, b) {
  if (!a || !b) return true;
  return a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b)) || lev(a, b) <= 2;
}
function nameCompatible(nA, nB, bothKeys) {
  const tA = tokens(nA), tB = tokens(nB);
  if (!tA.length || !tB.length) return false;
  if (tA.join(' ').includes('walk') || tB.join(' ').includes('walk')) return false;
  if (tA.slice().sort().join('|') === tB.slice().sort().join('|')) return true;   // reversed name order
  const fOk = firstOk(tA[0], tB[0]);
  const lOk = lastOk(tA.length > 1 ? tA[tA.length - 1] : null, tB.length > 1 ? tB[tB.length - 1] : null);
  return fOk && (lOk || bothKeys);
}

// ---------- Load files ----------
const custRows = parseCSV(path.join(DIR, 'customers.csv'));
const memberRows = parseCSV(path.join(DIR, 'members.csv'));
let waiverRows = parseCSV(path.join(DIR, 'waivers.csv'));

// Requested deletions
const beforeDel = waiverRows.length;
waiverRows = waiverRows.filter(w => !(w['First Name'] === '222' && w['Last Name'] === '222'))
                       .filter(w => !((w['Email Address'] || '').toLowerCase() === 'marlow.norwood@example.com'));
const deletedRows = beforeDel - waiverRows.length;

// Normalize the three datasets
const customers = custRows.map(r => ({
  name: r['Full Name'].replace(/\s+/g, ' ').trim(),
  email: cleanEmail(r['Email Address']), phone: cleanPhone(r['Phone Number']),
  bookings: +r['Bookings'] || 0, cancelled: +r['Cancelled'] || 0,
  noShow: +r['No Show'] || 0, attendee: +r['Attendee Only'] || 0,
}));
const waivers = waiverRows.map(r => ({
  name: `${r['First Name']} ${r['Last Name']}`.replace(/\s+/g, ' ').trim(),
  email: cleanEmail(r['Email Address']), phone: cleanPhone(r['Phone Number']),
  code: r['Waiver Confirmation'], date: r['Date Submitted'],
}));
const members = memberRows.map(r => ({
  name: `${r['First Name']} ${r['Last Name']}`.replace(/\s+/g, ' ').trim(),
  email: cleanEmail(r['Email Address']), phone: cleanPhone(r['Phone Number']),
  plan: (r['Tags'] || '').replace(/\s*\[Manage\]\s*$/, '').trim(),
}));

// ---------- Placeholder keys (shared staff-entered values must never merge people) ----------
const keyFirsts = new Map();
for (const p of [...customers, ...waivers, ...members]) {
  const f = tokens(p.name)[0] || '';
  for (const k of [p.email && 'e:' + p.email, p.phone && 'p:' + p.phone]) {
    if (!k) continue;
    if (!keyFirsts.has(k)) keyFirsts.set(k, new Set());
    keyFirsts.get(k).add(f);
  }
}
const PLACEHOLDER = new Set(['e:gale.harlow@example.com', 'e:fern.grange@example.com', 'e:haven.ives@example.com', 'e:pace.quarry@example.com',
  'e:gray.garland@example.com', 'e:logan.lark@example.com', 'e:dale.everly@example.com', 'e:jamie.joyner@example.com',
  'e:nova.orrin@example.com', 'e:alex.archer@example.com', 'p:+12048154142']);
for (const [k, firsts] of keyFirsts) if (firsts.size >= 3) PLACEHOLDER.add(k);
const emailKey = p => (p.email && !PLACEHOLDER.has('e:' + p.email)) ? 'e:' + p.email : null;
const phoneKey = p => (p.phone && !PLACEHOLDER.has('p:' + p.phone)) ? 'p:' + p.phone : null;

// ---------- Dedupe customers (union-find over shared real keys + compatible names) ----------
const parent = customers.map((_, i) => i);
const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
const union = (a, b) => { parent[find(a)] = find(b); };
const byKey = new Map();
customers.forEach((c, i) => for_each_key(c, k => { (byKey.get(k) || byKey.set(k, []).get(k)).push(i); }));
function for_each_key(p, fn) { const e = emailKey(p), ph = phoneKey(p); if (e) fn(e); if (ph) fn(ph); }
for (const idxs of byKey.values()) {
  for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) {
    const A = customers[idxs[a]], B = customers[idxs[b]];
    const bothKeys = emailKey(A) && emailKey(A) === emailKey(B) && phoneKey(A) && phoneKey(A) === phoneKey(B);
    if (nameCompatible(A.name, B.name, !!bothKeys)) union(idxs[a], idxs[b]);
  }
}
const clusters = new Map();
customers.forEach((c, i) => { const r = find(i); (clusters.get(r) || clusters.set(r, []).get(r)).push(c); });

function mergeCluster(rows) {
  const best = rows.slice().sort((a, b) => (b.bookings - a.bookings) || (tokens(b.name).length - tokens(a.name).length))[0];
  const email = rows.map(r => r.email).find(e => e && !PLACEHOLDER.has('e:' + e)) || best.email || null;
  const phone = rows.map(r => r.phone).find(p => p && !PLACEHOLDER.has('p:' + p)) || best.phone || null;
  return {
    name: best.name, email, phone,
    legacy_bookings: rows.reduce((s, r) => s + r.bookings, 0),
    legacy_cancelled: rows.reduce((s, r) => s + r.cancelled, 0),
    legacy_no_show: rows.reduce((s, r) => s + r.noShow, 0),
    legacy_attendee: rows.reduce((s, r) => s + r.attendee, 0),
    waiver_code: null, waiver_signed_at: null,
    membership_plan: null, membership_expires: null, membership_flag: null,
    _names: rows.map(r => r.name),
  };
}
const finalCustomers = [...clusters.values()].map(mergeCluster);
const mergedAway = customers.length - finalCustomers.length;

// ---------- Attach waivers ----------
const custByEmail = new Map(), custByPhone = new Map(), custByNameSet = new Map();
for (const c of finalCustomers) {
  if (emailKey(c)) (custByEmail.get(c.email) || custByEmail.set(c.email, []).get(c.email)).push(c);
  if (phoneKey(c)) (custByPhone.get(c.phone) || custByPhone.set(c.phone, []).get(c.phone)).push(c);
  for (const n of c._names) {
    const key = tokens(n).sort().join('|');
    (custByNameSet.get(key) || custByNameSet.set(key, []).get(key)).push(c);
  }
}
function findCustomer(p) {
  for (const c of (custByEmail.get(p.email) || [])) {
    const both = !!(phoneKey(p) && c.phone === p.phone);   // email+phone both match → same account, name spelling may drift
    if (nameCompatible(p.name, c.name, both) || c._names.some(n => nameCompatible(p.name, n, both))) return c;
  }
  for (const c of (custByPhone.get(p.phone) || [])) if (nameCompatible(p.name, c.name, false) || c._names.some(n => nameCompatible(p.name, n, false))) return c;
  const nm = custByNameSet.get(tokens(p.name).sort().join('|')) || [];
  if (nm.length && new Set(nm).size === 1) return nm[0];
  return null;
}

// newest waiver first, so the first attach per person wins
waivers.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
let waiverMatched = 0, waiverNew = 0, waiverRepeats = 0;
const newFromWaivers = [];
for (const w of waivers) {
  if (!w.code) continue;
  let c = findCustomer(w);
  if (!c) {
    c = newFromWaivers.find(n => {
      const e = emailKey(w) && n.email === w.email, ph = phoneKey(w) && n.phone === w.phone;
      return (e || ph) && nameCompatible(w.name, n.name, false);
    });
    if (!c && tokens(w.name).length) {
      c = newFromWaivers.find(n => tokens(n.name).sort().join('|') === tokens(w.name).sort().join('|'));
    }
    if (!c) {
      c = { name: w.name, email: w.email, phone: w.phone, legacy_bookings: 0, legacy_cancelled: 0,
        legacy_no_show: 0, legacy_attendee: 0, waiver_code: null, waiver_signed_at: null,
        membership_plan: null, membership_expires: null, membership_flag: null, _names: [w.name] };
      newFromWaivers.push(c); waiverNew++;
      if (emailKey(c)) (custByEmail.get(c.email) || custByEmail.set(c.email, []).get(c.email)).push(c);
      if (phoneKey(c)) (custByPhone.get(c.phone) || custByPhone.set(c.phone, []).get(c.phone)).push(c);
    }
  }
  if (c.waiver_code) { waiverRepeats++; continue; }         // already has a newer waiver
  c.waiver_code = w.code;
  c.waiver_signed_at = w.date ? new Date(w.date.replace(' ', 'T') + 'Z').toISOString() : null;
  if (!newFromWaivers.includes(c)) waiverMatched++;
  // A waiver's self-typed real email can upgrade a placeholder-only record
  if (!c.email && w.email) c.email = w.email;
  if (!c.phone && w.phone) c.phone = w.phone;
}
finalCustomers.push(...newFromWaivers);

// ---------- Memberships ----------
const PLANS = [
  { name: 'Summer Membership (Monthly)', period: 'month', color: '#f0973d', sort: 0 },
  { name: 'Summer Membership (Entirely)', period: 'once', color: '#c7402e', sort: 1 },
  { name: 'Anytime Member 30days', period: 'once', color: '#4aa3ff', sort: 2 },
  { name: 'Daytime pass member 30days', period: 'once', color: '#4ec06a', sort: 3 },
  { name: 'Seasonal Member 90days', period: 'once', color: '#c4e538', sort: 4 },
];
const FLAG_2027 = y => `Imported note said "${y}" — the year may be a typo for 2026. Confirm and save the expiry date to clear this flag.`;
const EXPIRY = {
  'brook.carrow@example.com': ['2026-07-12', null],
  'quinn.quill@example.com': ['2026-07-17', null],
  '+12045550199': ['2026-07-13', null],                       // Jordan Vega (placeholder email — matched by phone)
  'cedar.dane@example.com': ['2027-10-31', FLAG_2027('until October 2027')],
  'lane.mabry@example.com': ['2026-10-31', 'Imported note had no expiry date — defaulted to Oct 31, 2026 (end of summer season). Confirm and save to clear this flag.'],
  'urban.upton@example.com': ['2026-02-15', null],
  'parker.pryor@example.com': ['2026-02-28', null],
  'indigo.ingram@example.com': ['2026-07-07', null],
  'emery.ellery@example.com': ['2026-02-13', null],
  'morgan.mercer@example.com': ['2027-10-31', FLAG_2027('until oct 2027')],
  'juno.kelso@example.com': ['2026-07-20', null],
  'vale.vance@example.com': ['2026-04-15', null],
  'ari.blythe@example.com': ['2026-02-13', null],
  'noel.nash@example.com': ['2026-07-05', null],
  'kai.keane@example.com': ['2026-07-17', null],
  'iris.jarrow@example.com': ['2026-07-17', null],
  'sage.sable@example.com': ['2026-07-20', null],
  'yuki.zeller@example.com': ['2026-07-23', null],
  'eden.fenn@example.com': ['2027-07-13', FLAG_2027('until July 13th 2027')],
};
let membersAssigned = 0; const memberMisses = [];
for (const m of members) {
  const c = findCustomer(m);
  if (!c) { memberMisses.push(m.name); continue; }
  const [exp, flag] = EXPIRY[m.email] || EXPIRY[m.phone] || [null, null];
  c.membership_plan = m.plan; c.membership_expires = exp; c.membership_flag = flag;
  if (!c.email && m.email) c.email = m.email;
  membersAssigned++;
}

// ---------- Report ----------
const report = {
  customersRaw: customers.length, mergedAway, customersAfterDedupe: finalCustomers.length - newFromWaivers.length,
  waiverRowsRaw: beforeDel, waiverRowsDeleted: deletedRows, waiverRepeatsSkipped: waiverRepeats,
  waiversAttachedToExisting: waiverMatched, newCustomersFromWaivers: waiverNew,
  totalCustomersToImport: finalCustomers.length,
  membersAssigned, memberMisses, emailsFixed: emailFixCount, phonesFixed: phoneFixCount,
  flagged: finalCustomers.filter(c => c.membership_flag).map(c => c.name),
};
console.log(JSON.stringify(report, null, 2));
if (DRY) process.exit(0);

// ---------- Write to Supabase ----------
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { count: already } = await db.from('customers').select('id', { count: 'exact', head: true }).gt('legacy_bookings', 0);
if (already > 0 && !FORCE) { console.error(`ABORT: ${already} imported customers already exist. Re-run with --force to import anyway.`); process.exit(1); }

// Plans: replace the placeholder seeds with the five real ones
await db.from('memberships').delete().in('name', ['Bronze', 'Silver', 'Gold']);
const planIds = {};
for (const p of PLANS) {
  const { data: existing } = await db.from('memberships').select('id').eq('name', p.name).maybeSingle();
  if (existing) { planIds[p.name] = existing.id; continue; }
  const { data, error } = await db.from('memberships')
    .insert({ name: p.name, price_cents: 0, period: p.period, discount_pct: 0, color: p.color, sort: p.sort })
    .select('id').single();
  if (error) { console.error('plan insert failed:', p.name, error.message); process.exit(1); }
  planIds[p.name] = data.id;
}

// Customers in batches
let inserted = 0;
for (let i = 0; i < finalCustomers.length; i += 100) {
  const batch = finalCustomers.slice(i, i + 100).map(c => ({
    name: c.name, email: c.email, phone: c.phone,
    membership_id: c.membership_plan ? planIds[c.membership_plan] || null : null,
    membership_expires: c.membership_expires, membership_flag: c.membership_flag,
    waiver_code: c.waiver_code, waiver_signed_at: c.waiver_signed_at,
    legacy_bookings: c.legacy_bookings, legacy_cancelled: c.legacy_cancelled,
    legacy_no_show: c.legacy_no_show, legacy_attendee: c.legacy_attendee,
  }));
  const { error } = await db.from('customers').insert(batch);
  if (error) { console.error(`batch at ${i} failed:`, error.message); process.exit(1); }
  inserted += batch.length;
  console.log(`inserted ${inserted}/${finalCustomers.length}`);
}
console.log('DONE');
