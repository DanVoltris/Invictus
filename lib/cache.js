// CDN caching for answers that are the same for every visitor.
//
// Vercel's CDN keeps a copy of a function's GET response when it carries s-maxage, and answers
// repeat requests from that copy without starting the function at all — the cache key is the full
// URL, query string included. Only for a plain GET or HEAD with no Authorization header (every
// session on this site is a Bearer token; nothing uses cookies), and only where the caller sets it:
// on a real answer, never an error or anything that depends on who is asking.
export const CACHE = {
  config: 'public, s-maxage=3600, stale-while-revalidate=86400',   // env only; a deploy clears it
  settings: 'public, s-maxage=60, stale-while-revalidate=300',     // bays, hours, rates, leagues
};

export function cacheable(req, res, value) {
  const m = String((req && req.method) || 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  if (req && req.headers && req.headers.authorization) return false;
  if (req && req.devAccountPhone) return false;                    // server.js's no-login dev account
  if (!res || typeof res.setHeader !== 'function') return false;
  res.setHeader('Cache-Control', value);
  return true;
}
