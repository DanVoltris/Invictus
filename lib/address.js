// Address autofill and verification from OpenStreetMap — free, no account or key.
//
// Suggestions come from Photon (photon.komoot.io), an OpenStreetMap search built for
// search-as-you-type. When the person picks one, the server looks that OpenStreetMap object up
// again on Nominatim (nominatim.openstreetmap.org) and takes the province from its answer — not
// from anything the browser sends. That lookup is what makes an address "verified" (migration
// 0045), and Spin the Wheel needs a verified Manitoba one.
//
// OpenStreetMap knows many Manitoba streets without every house number on them. So a street can be
// picked too, and then the person types their house number: the province is still confirmed by the
// lookup; the number is theirs.
//
// Both services are free and ask for fair use: an identifying User-Agent, and no more than one
// Nominatim request a second (one per saved address is far below that). Neither promises uptime;
// when one is down the page says lookup is not answering and nothing is saved unverified.

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/lookup';
const UA = `InvictusGolf/1.0 (+${process.env.PUBLIC_BASE_URL || 'https://invictusgolfwpg.ca'})`;
const PROVINCES = { 'Alberta': 'AB', 'British Columbia': 'BC', 'Manitoba': 'MB', 'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL', 'Nova Scotia': 'NS', 'Northwest Territories': 'NT', 'Nunavut': 'NU',
  'Ontario': 'ON', 'Prince Edward Island': 'PE', 'Quebec': 'QC', 'Québec': 'QC', 'Saskatchewan': 'SK', 'Yukon': 'YT' };
const OSM_TYPE = { N: 'N', W: 'W', R: 'R', node: 'N', way: 'W', relation: 'R' };

export const addressLookupReady = () => true;
// "12", "12A", "200-1721" (unit-number) — what a person may type when OpenStreetMap has no number.
export const validHouseNumber = (v) => /^[0-9]{1,6}[A-Za-z]?(-[0-9]{1,6}[A-Za-z]?)?$/.test(String(v || '').trim());

const line = (p) => [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.street || p.name),
  p.city || p.town || p.village || p.county, [PROVINCES[p.state] || p.state, p.postcode].filter(Boolean).join(' ')]
  .filter(Boolean).join(', ');

// Canadian addresses and streets matching what has been typed, nearest Winnipeg first.
export async function suggestAddresses(input) {
  const text = String(input || '').trim().slice(0, 120);
  if (text.length < 3) return [];
  const q = new URLSearchParams({ q: text, limit: '10', lang: 'en', lat: '49.8951', lon: '-97.1384',
    bbox: '-141.1,41.6,-52.6,83.2' });
  q.append('layer', 'house'); q.append('layer', 'street');
  const r = await fetch(`${PHOTON}?${q}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`photon ${r.status}`);
  const j = await r.json();
  const seen = new Set(), out = [];
  for (const f of j.features || []) {
    const p = f.properties || {};
    if (p.countrycode !== 'CA' || !OSM_TYPE[p.osm_type] || !(p.street || p.name)) continue;
    const text = line(p);
    if (seen.has(text)) continue;   // one street is often several OpenStreetMap pieces
    seen.add(text);
    const street = !p.housenumber;
    out.push({ placeId: `${OSM_TYPE[p.osm_type]}${p.osm_id}`, text, needsNumber: street,
      main: street ? (p.street || p.name) : `${p.housenumber} ${p.street}`,
      secondary: [p.city || p.town || p.village, PROVINCES[p.state] || p.state, p.postcode].filter(Boolean).join(', ')
        + (street ? ' · add your house number' : '') });
    if (out.length === 5) break;
  }
  return out;
}

// The picked place, looked up again: its address and province. `houseNumber` is used only when the
// place is a street with no number of its own. Null if it is not a Canadian address or street.
export async function verifyAddress(placeId, houseNumber) {
  const m = /^([NWR])(\d{1,15})$/.exec(String(placeId || ''));
  if (!m) return null;
  const q = new URLSearchParams({ osm_ids: m[1] + m[2], format: 'jsonv2', addressdetails: '1', 'accept-language': 'en' });
  const r = await fetch(`${NOMINATIM}?${q}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`nominatim ${r.status}`);
  const [hit] = await r.json();
  const a = (hit && hit.address) || {};
  if (a.country_code !== 'ca' || !a.state || !a.road) return null;
  const number = a.house_number || (validHouseNumber(houseNumber) ? String(houseNumber).trim() : '');
  if (!number) return { needsNumber: true };
  const province = PROVINCES[a.state] || a.state;
  const city = a.city || a.town || a.village || a.municipality || a.county || '';
  return { placeId: m[1] + m[2], province,
    address: [`${number} ${a.road}`, city, [province, a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ') };
}
