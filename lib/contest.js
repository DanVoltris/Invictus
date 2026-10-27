// Spin the Wheel (migration 0044). Everything a customer's browser asks of the contest comes
// through here, from api/account.js. The decisions themselves — the 24-hour limit, the block and
// its winning positions, the prize — are made inside public.contest_spin() in the database; this
// file asks for a spin, runs the skill-testing question, and shapes what the page may see.
//
// What never leaves this file: a block, a position, a winning position, a question's answer.
import crypto from 'node:crypto';
import { venueIdentity } from './notify.js';

export const QUESTION_SECONDS = 300;    // 5 minutes from the moment the question is shown
// Allowance for the answer's trip to the server, so a reply sent at 4:59 is not lost in transit.
const GRACE_SECONDS = 10;

const PERIOD_PUBLIC = 'id,name,starts_at,ends_at,wins_per_block,block_size,incomplete_mode,forfeit_mode';
const CLAIM_PUBLIC = 'id,source,prize_name,prize_description,prize_kind,prize_value_cents,prize_adults_only,status,question,question_expires_at,answered_at,returned_to_pool,redeemed_at,created_at';

// ---- the skill-testing question --------------------------------------------
// Three or four operations where order of operations matters, always a whole non-negative answer:
// every division is exact, and a draw that would go below zero is drawn again.
const rnd = (lo, hi) => crypto.randomInt(lo, hi + 1);
const FORMS = [
  () => { const a = rnd(3, 9), b = rnd(3, 9), d = rnd(2, 6), c = d * rnd(2, 9), e = rnd(1, 9);
          return { text: `(${a} × ${b}) + ${c} ÷ ${d} − ${e}`, answer: a * b + c / d - e }; },
  () => { const a = rnd(5, 30), b = rnd(2, 9), c = rnd(2, 9), d = rnd(1, 20);
          return { text: `${a} + ${b} × ${c} − ${d}`, answer: a + b * c - d }; },
  () => { const a = rnd(2, 9), b = rnd(2, 9), c = rnd(2, 6), e = rnd(2, 5), d = e * rnd(2, 9);
          return { text: `(${a} + ${b}) × ${c} − ${d} ÷ ${e}`, answer: (a + b) * c - d / e }; },
  () => { const a = rnd(4, 12), b = rnd(3, 9), d = rnd(2, 6), c = d * rnd(2, 9);
          return { text: `${a} × ${b} − ${c} ÷ ${d}`, answer: a * b - c / d }; },
  () => { const a = rnd(10, 40), b = rnd(2, 9), c = rnd(2, 9), e = rnd(2, 5), d = e * rnd(2, 9);
          return { text: `${a} − ${b} × ${c} + ${d} ÷ ${e}`, answer: a - b * c + d / e }; },
];
export function makeQuestion() {
  for (;;) {
    const q = FORMS[crypto.randomInt(0, FORMS.length)]();
    if (Number.isInteger(q.answer) && q.answer >= 0) return q;
  }
}
// What the person typed, as a whole number, or null if it is not one ("1,234" and " 42 " count).
export function parseAnswer(v) {
  const s = String(v == null ? '' : v).replace(/[\s,]/g, '');
  return /^-?\d{1,9}$/.test(s) ? Number(s) : null;
}

// ---- helpers -------------------------------------------------------------
const winnipegToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Winnipeg',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
// Under 18 today, Winnipeg time. Only decides the parent/guardian line; prizes are not filtered by age.
export function isMinor(dob, today = winnipegToday()) {
  if (!dob) return false;
  const [y, m, d] = String(dob).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const age = ty - y - ((tm < m || (tm === m && td < d)) ? 1 : 0);
  return age < 18;
}
const MISSING_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'address', 'career', 'date_of_birth'];
export function missingFields(c) {
  return MISSING_FIELDS.filter((k) => !(c && String(c[k] == null ? '' : c[k]).trim()));
}

// Questions whose five minutes ran out while nobody was looking: forfeited the moment anyone asks.
async function sweepTimeouts(db, customerId) {
  let q = db.from('contest_claims').select('id').eq('status', 'question')
    .lt('question_expires_at', new Date(Date.now() - GRACE_SECONDS * 1000).toISOString());
  if (customerId) q = q.eq('customer_id', customerId);
  const { data } = await q.limit(50);
  for (const r of data || []) {
    const { error } = await db.rpc('contest_forfeit_claim', { p_claim: r.id, p_status: 'timeout', p_given: null });
    if (error) console.error('contest timeout sweep:', error.message);
  }
}

async function activeAndNextPeriods(db) {
  const now = new Date().toISOString();
  const { data: active } = await db.from('contest_periods').select(PERIOD_PUBLIC)
    .lte('starts_at', now).gt('ends_at', now).limit(1);
  const { data: next } = await db.from('contest_periods').select(PERIOD_PUBLIC)
    .gt('starts_at', now).order('starts_at').limit(1);
  return { period: (active && active[0]) || null, nextPeriod: (next && next[0]) || null };
}

// ---- the actions ------------------------------------------------------------
// The rules page and the wheel's fine print: no sign-in needed, nothing about anybody.
export async function contestRules(db, settings) {
  const { period, nextPeriod } = await activeAndNextPeriods(db);
  const { data: prizes } = await db.from('contest_prizes')
    .select('name,description,kind,value_cents,adults_only,weight').eq('active', true).gt('weight', 0)
    .order('sort').order('created_at');
  const total = (prizes || []).reduce((s, p) => s + p.weight, 0);
  return {
    ok: true, period, nextPeriod,
    prizes: (prizes || []).map(({ weight, ...p }) => ({ ...p, share: total ? weight / total : 0 })),
    sponsor: venueIdentity(settings),
    questionSeconds: QUESTION_SECONDS,
  };
}

// The wheel page on load: may this person spin, and if not, why and until when.
export async function contestStatus(db, cust, settings) {
  const rules = await contestRules(db, settings);
  if (!cust) return { ...rules, signedIn: false };
  await sweepTimeouts(db, cust.id);
  const { data: last } = await db.from('contest_spins').select('created_at')
    .eq('customer_id', cust.id).order('created_at', { ascending: false }).limit(1);
  const lastAt = last && last[0] ? Date.parse(last[0].created_at) : 0;
  const nextSpinAt = lastAt && lastAt + 86400000 > Date.now() ? new Date(lastAt + 86400000).toISOString() : null;
  // A win still waiting for its question (closed the tab, or drawn at the end of a period).
  const { data: open } = await db.from('contest_claims').select(CLAIM_PUBLIC)
    .eq('customer_id', cust.id).in('status', ['pending', 'question']).order('created_at').limit(5);
  return { ...rules, signedIn: true, missing: missingFields(cust), nextSpinAt,
    openClaims: (open || []).map(publicClaim), minor: isMinor(cust.date_of_birth) };
}

export async function contestSpin(db, cust, req) {
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '');
  const { data, error } = await db.rpc('contest_spin', {
    p_customer: cust.id, p_ip: ip || null, p_ua: String(req.headers['user-agent'] || '').slice(0, 300) || null });
  if (error) { console.error('contest_spin:', error.message); return { status: 500, body: { error: 'The wheel could not spin. Please try again.' } }; }
  const r = data || {};
  if (!r.ok) {
    const say = {
      profile: 'Finish your account details first.',
      wait: 'You have already spun in the last 24 hours.',
      closed: 'The contest is not running right now.',
      no_account: 'Sign in to spin.',
    };
    return { status: 409, body: { error: say[r.reason] || 'You cannot spin right now.', reason: r.reason,
      missing: r.missing || undefined, nextSpinAt: r.next_at || undefined } };
  }
  // Only these keys: whatever else contest_spin returns stays here.
  return { status: 200, body: { ok: true, won: !!r.won, claimId: r.claim_id || null, nextSpinAt: r.next_at,
    prize: r.won && r.prize ? r.prize : null, minor: isMinor(cust.date_of_birth) } };
}

async function ownClaim(db, cust, claimId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(claimId || ''))) return null;
  const { data } = await db.from('contest_claims').select('*').eq('id', claimId).eq('customer_id', cust.id).maybeSingle();
  return data || null;
}
function publicClaim(c) {
  return { id: c.id, source: c.source, status: c.status, prize: { name: c.prize_name, description: c.prize_description,
    kind: c.prize_kind, value_cents: c.prize_value_cents, adults_only: c.prize_adults_only },
    question: c.status === 'question' ? c.question : undefined,
    expiresAt: c.status === 'question' ? c.question_expires_at : undefined,
    returnedToPool: c.returned_to_pool, redeemedAt: c.redeemed_at, wonAt: c.created_at, answeredAt: c.answered_at };
}

// "Show me the question": starts the five minutes. Asking again shows the same question with the
// clock still running — a reload does not buy a new question or more time.
export async function contestQuestion(db, cust, body) {
  const c = await ownClaim(db, cust, body.claimId);
  if (!c) return { status: 404, body: { error: 'That prize was not found.' } };
  if (c.status === 'question') {
    if (Date.parse(c.question_expires_at) + GRACE_SECONDS * 1000 < Date.now()) {
      await db.rpc('contest_forfeit_claim', { p_claim: c.id, p_status: 'timeout', p_given: null });
      return { status: 409, body: { error: 'Time ran out on this question, so the prize was forfeited.', status: 'timeout' } };
    }
    return { status: 200, body: { ok: true, question: c.question, expiresAt: c.question_expires_at } };
  }
  if (c.status !== 'pending') return { status: 409, body: { error: 'This prize has already been settled.', status: c.status } };
  const q = makeQuestion();
  const now = Date.now();
  const { data, error } = await db.from('contest_claims').update({
    status: 'question', question: q.text, answer: q.answer,
    question_issued_at: new Date(now).toISOString(),
    question_expires_at: new Date(now + QUESTION_SECONDS * 1000).toISOString(),
  }).eq('id', c.id).eq('status', 'pending').select('question,question_expires_at');
  if (error) { console.error('contest question:', error.message); return { status: 500, body: { error: 'Could not show the question. Please try again.' } }; }
  if (!data || !data.length) return contestQuestion(db, cust, body);   // two tabs raced: show the one that won
  return { status: 200, body: { ok: true, question: data[0].question, expiresAt: data[0].question_expires_at } };
}

// One attempt. Right: the prize is theirs. Wrong or late: forfeited, and back in the pool if the
// period says so.
export async function contestAnswer(db, cust, body) {
  const c = await ownClaim(db, cust, body.claimId);
  if (!c) return { status: 404, body: { error: 'That prize was not found.' } };
  if (c.status !== 'question') return { status: 409, body: { error: 'This question is no longer open.', status: c.status } };
  const given = String(body.answer == null ? '' : body.answer).slice(0, 40);
  if (Date.parse(c.question_expires_at) + GRACE_SECONDS * 1000 < Date.now()) {
    const { data } = await db.rpc('contest_forfeit_claim', { p_claim: c.id, p_status: 'timeout', p_given: given || null });
    return { status: 200, body: { ok: true, correct: false, status: 'timeout', returnedToPool: !!(data && data.returned_to_pool) } };
  }
  const n = parseAnswer(given);
  if (n !== null && n === c.answer) {
    const { data, error } = await db.from('contest_claims')
      .update({ status: 'won', given_answer: given, answered_at: new Date().toISOString() })
      .eq('id', c.id).eq('status', 'question').select('id');
    if (error) { console.error('contest answer:', error.message); return { status: 500, body: { error: 'Could not record your answer. Please try again.' } }; }
    if (!data || !data.length) return { status: 409, body: { error: 'This question was already answered.' } };
    return { status: 200, body: { ok: true, correct: true, status: 'won', minor: isMinor(cust.date_of_birth) } };
  }
  const { data, error } = await db.rpc('contest_forfeit_claim', { p_claim: c.id, p_status: 'wrong', p_given: given || null });
  if (error) { console.error('contest forfeit:', error.message); return { status: 500, body: { error: 'Could not record your answer. Please try again.' } }; }
  if (!data || !data.ok) return { status: 409, body: { error: 'This question was already answered.' } };
  return { status: 200, body: { ok: true, correct: false, status: 'wrong', returnedToPool: !!data.returned_to_pool } };
}

// My Account → Rewards: every prize this person has won, with where each one stands.
export async function contestRewards(db, cust) {
  await sweepTimeouts(db, cust.id);
  const { data, error } = await db.from('contest_claims').select(CLAIM_PUBLIC)
    .eq('customer_id', cust.id).order('created_at', { ascending: false }).limit(100);
  if (error) {
    if (/contest_claims/.test(error.message)) return { ok: true, rewards: [], minor: false };   // 0044 not run
    throw error;
  }
  return { ok: true, rewards: (data || []).map(publicClaim), minor: isMinor(cust.date_of_birth) };
}
