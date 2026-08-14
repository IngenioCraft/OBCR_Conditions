/* ============================================================
   Coastal Conditions — data proxy Worker (Cloudflare)
   Hides API keys and returns clean JSON to the website.

   Routes:
     GET /pollen?lat=..&lon=..                  → Google Pollen API (compact summary)
     GET /wind?lat=..&lon=..&radius=6           → Synoptic Data, nearby stations averaged
     GET /wind?stations=STID1,STID2             → (optional) explicit Synoptic station IDs

   Set these (Worker → Settings → Variables and Secrets):
     GOOGLE_POLLEN_KEY  (secret)  a Google Cloud key with the Pollen API enabled
     SYNOPTIC_TOKEN     (secret)  a free Synoptic Data API token (synopticdata.com)
     ALLOW_ORIGIN       (var)     https://prey.tel

   Nothing here is stored; keys never leave the Worker.
   ============================================================ */

const FRESH_MIN = 35;      // a PWS reading older than this (minutes) is treated as stale
const POLLEN_TTL = 6 * 3600; // cache pollen 6h (it updates ~daily)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === "/wind")   return json(await getWind(url, env), 200, cors);
      if (url.pathname === "/pollen") return json(await getPollen(url, env, ctx), 200, cors);
      if (url.pathname === "/")       return json({ ok: true, routes: ["/wind", "/pollen"] }, 200, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
  },
};

/* ---------------- WIND ---------------- */
async function getWind(url, env) {
  // WeatherLink public embed feed (a single station's own public page — no key needed).
  const wl = url.searchParams.get("weatherlink");
  if (wl) return getWeatherLink(wl);
  // otherwise: Synoptic Data (nearby stations averaged) — needs a token.
  if (!env.SYNOPTIC_TOKEN) return { error: "Synoptic token not set" };
  const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
  const radius = url.searchParams.get("radius") || "6";
  const stid = url.searchParams.get("stations");
  let q;
  if (stid) q = `&stid=${encodeURIComponent(stid)}`;
  else if (lat && lon) q = `&radius=${lat},${lon},${radius}`;
  else return { error: "lat/lon (or stations) required" };

  const api = `https://api.synopticdata.com/v2/stations/latest?token=${env.SYNOPTIC_TOKEN}${q}`
    + `&within=${FRESH_MIN}&vars=wind_speed,wind_gust,wind_direction&units=english,speed|mph&status=active&limit=20`;
  const r = await fetch(api);
  if (!r.ok) { const t = await r.text().catch(() => ""); return { error: `synoptic ${r.status}`, detail: t.slice(0, 160) }; }
  const j = await r.json();
  const stns = j.STATION || [];
  const now = Date.now();
  const results = stns.map(s => {
    const o = s.OBSERVATIONS || {};
    const ws = o.wind_speed_value_1, wg = o.wind_gust_value_1, wd = o.wind_direction_value_1;
    if (!ws || ws.value == null) return null;
    const ageMin = ws.date_time ? (now - Date.parse(ws.date_time)) / 60000 : null;
    const slat = num(s.LATITUDE), slon = num(s.LONGITUDE);
    const mi = (lat && lon && slat != null && slon != null) ? haversineMi(+lat, +lon, slat, slon) : null;
    return { id: s.STID, name: s.NAME, mi, windMph: num(ws.value), gustMph: wg && wg.value != null ? num(wg.value) : null, dir: wd && wd.value != null ? num(wd.value) : null, ageMin };
  }).filter(Boolean);

  const fresh = results.filter(o => o && o.windMph != null && o.ageMin != null && o.ageMin <= FRESH_MIN);
  if (!fresh.length) return { fresh: false, checked: stns.length, note: "no live stations nearby" };

  // drop a single wind-speed outlier when we have 3+ (guards against a bad sensor)
  let used = fresh;
  if (fresh.length >= 3) {
    const med = median(fresh.map(o => o.windMph));
    const worst = fresh.reduce((a, b) => Math.abs(b.windMph - med) > Math.abs(a.windMph - med) ? b : a);
    if (Math.abs(worst.windMph - med) > 8) used = fresh.filter(o => o !== worst);
  }

  // distance-weight so the closest, best-sited station dominates (inverse distance).
  const haveDist = used.every(o => o.mi != null);
  const wts = haveDist ? used.map(o => 1 / (o.mi + 0.25)) : used.map(() => 1);
  const windMph = wmean(used.map(o => o.windMph), wts);
  const gi = used.map((o, i) => [o.gustMph, wts[i]]).filter(x => x[0] != null);
  const gustMph = gi.length ? wmean(gi.map(x => x[0]), gi.map(x => x[1])) : null;
  const di = used.map((o, i) => [o.dir, wts[i]]).filter(x => x[0] != null);
  const dir = di.length ? Math.round(circMean(di.map(x => x[0]), di.map(x => x[1]))) : null;
  const nearest = haveDist ? used.slice().sort((a, b) => a.mi - b.mi)[0] : null;

  return {
    fresh: true,
    windMph: round1(windMph),
    gustMph: gustMph != null ? round1(gustMph) : null,
    dir,
    stations: used.map(o => o.id),
    nearest: nearest ? { id: nearest.id, name: nearest.name, mi: round1(nearest.mi) } : null,
    ageMin: Math.round(Math.min(...used.map(o => o.ageMin))),
  };
}

/* ---------------- WIND via WeatherLink public embed feed ---------------- */
async function getWeatherLink(token) {
  let j;
  try {
    const r = await fetch(`https://www.weatherlink.com/embeddablePage/getData/${encodeURIComponent(token)}`, { headers: { "User-Agent": "coastal-conditions" } });
    if (!r.ok) return { error: `weatherlink ${r.status}` };
    j = await r.json();
  } catch (e) { return { error: "weatherlink fetch failed" }; }
  if (j.wind == null) return { fresh: false, note: "no wind field" };
  const k = windToMph(j.windUnits);
  const windMph = num(j.wind) != null ? round1(num(j.wind) * k) : null;
  const gustMph = num(j.gust) != null ? round1(num(j.gust) * k) : null;
  const dir = num(j.windDirection);
  const ageMin = j.lastReceived ? Math.round((Date.now() - j.lastReceived) / 60000) : null;
  const fresh = windMph != null && ageMin != null && ageMin <= FRESH_MIN;
  const rain = num(j.rain); // accumulation today (inches) — real gauge observation
  return { fresh, windMph, gustMph, dir, stations: [j.systemLocation || "WeatherLink"], nearest: { name: j.systemLocation || "WeatherLink station" }, ageMin, source: "WeatherLink", rain, rainUnits: j.rainUnits || "in" };
}
function windToMph(units) {
  units = String(units || "").toLowerCase();
  if (units.includes("knot") || units === "kts" || units === "kt") return 1.15078;
  if (units.includes("km")) return 0.621371;
  if (units.includes("m/s") || units.includes("mps")) return 2.23694;
  return 1; // already mph
}

/* ---------------- POLLEN (Google Pollen API) ---------------- */
async function getPollen(url, env, ctx) {
  const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
  if (!lat || !lon) return { error: "lat/lon required" };
  if (!env.GOOGLE_POLLEN_KEY) return { error: "pollen key not set" };

  const cacheKey = new Request(`https://cache/pollen/${(+lat).toFixed(2)},${(+lon).toFixed(2)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return await hit.json();

  const api = `https://pollen.googleapis.com/v1/forecast:lookup?key=${env.GOOGLE_POLLEN_KEY}`
    + `&location.latitude=${lat}&location.longitude=${lon}&days=1&plantsDescription=false`;
  const r = await fetch(api);
  if (!r.ok) { const t = await r.text().catch(() => ""); return { error: `pollen ${r.status}`, detail: t.slice(0, 160) }; }
  const j = await r.json();
  const day = j.dailyInfo && j.dailyInfo[0];
  if (!day) return { error: "no pollen data (may be outside coverage)" };

  const types = (day.pollenTypeInfo || []).map(t => ({
    name: cap(t.displayName || t.code), inSeason: !!t.inSeason,
    value: t.indexInfo ? t.indexInfo.value : null,
    category: t.indexInfo ? t.indexInfo.category : (t.inSeason ? "None" : "Out of season"),
  }));
  const plants = (day.plantInfo || []).filter(p => p.inSeason && p.indexInfo && p.indexInfo.value > 0)
    .map(p => ({ name: p.displayName, category: p.indexInfo.category, value: p.indexInfo.value }))
    .sort((a, b) => b.value - a.value).slice(0, 6);
  const top = types.filter(t => t.value != null).sort((a, b) => b.value - a.value)[0] || null;

  const out = { ok: true, types, plants, overall: top ? { category: top.category, value: top.value } : null };
  const resp = json(out, 200, {});
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${POLLEN_TTL}` } })));
  return out;
}

/* ---------------- helpers ---------------- */
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}
const num = v => (v == null || v === "" || isNaN(+v)) ? null : +v;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const round1 = v => Math.round(v * 10) / 10;
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function wmean(vals, wts) { let s = 0, w = 0; for (let i = 0; i < vals.length; i++) { s += vals[i] * wts[i]; w += wts[i]; } return w ? s / w : mean(vals); }
function circMean(degs, wts) {
  let x = 0, y = 0; for (let i = 0; i < degs.length; i++) { const r = degs[i] * Math.PI / 180, w = wts ? wts[i] : 1; x += Math.cos(r) * w; y += Math.sin(r) * w; }
  let a = Math.atan2(y, x) * 180 / Math.PI; return (a + 360) % 360;
}
function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
