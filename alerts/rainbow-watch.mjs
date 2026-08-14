/* ============================================================
   Rainbow alert watcher.
   Runs on a schedule (GitHub Actions). For each subscriber it checks
   the live sky at their location and texts them when a rainbow is on.

   Safe by default: DRY_RUN=1 logs what it WOULD send and sends nothing.
   Flip to real sending only once Twilio secrets are in place.

   Env:
     DRY_RUN=1|0            (default 1 — no real texts)
     COOLDOWN_HOURS=2       don't text the same person more than once per N h
     QUIET_START=22         no texts at/after this local hour ...
     QUIET_END=6            ... and before this local hour
     ALERT_TZ=America/New_York
     TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
     TWILIO_FROM  (a Twilio number)  OR  TWILIO_MESSAGING_SERVICE_SID (MG...)
   ============================================================ */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rainbowStatus, formatAlert } from "./rainbow-logic.mjs";
import { dispatch, buildSenderCfg, contactOf } from "./senders.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBS_FILE  = join(HERE, "subscribers.json");
const STATE_FILE = join(HERE, "state.json");

const MM_PER_IN = 25.4;

/* ---------- helpers ---------- */
const num = (v, d) => (v==null || v==="" || isNaN(+v)) ? d : +v;
const locKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

function localHour(date, tz){
  return +new Intl.DateTimeFormat("en-US",{hour:"numeric",hour12:false,timeZone:tz}).format(date);
}
function inQuietHours(date, tz, start, end){
  const h = localHour(date, tz) % 24;
  return start <= end ? (h>=start && h<end) : (h>=start || h<end); // handles overnight window
}

/* ---------- fetch live conditions for one point ---------- */
export async function fetchCond(lat, lon, fetchImpl=fetch){
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${lat}&longitude=${lon}`
    + "&current=is_day,weather_code,precipitation,cloud_cover"
    + "&hourly=precipitation&past_hours=2&forecast_hours=1"
    + "&timezone=auto";
  const r = await fetchImpl(url);
  if(!r.ok) throw new Error("Open-Meteo HTTP "+r.status);
  const j = await r.json();
  const cur = j.current || {};
  const hp = (j.hourly && j.hourly.precipitation) || [];
  const recentMm = hp.reduce((a,b)=>a+(+b||0), 0);
  return {
    isDay: cur.is_day === 1,
    code: cur.weather_code,
    recentRainIn: recentMm / MM_PER_IN,
    cloudCover: cur.cloud_cover != null ? +cur.cloud_cover : null
  };
}

/* ---------- PURE decision core (unit-tested) ----------
   subs: [{id, phone, label, lat, lon, includeMaybe, active}]
   condByLoc: Map(locKey -> cond)
   state: { lastAlert: { [id]: ISOstring } }
   returns { toSend:[{sub, rb, text}], skipped:[{id, reason}] }        */
export function selectAlerts(subs, condByLoc, state, now, opts){
  const cooldownMs = opts.cooldownHours * 3600*1000;
  const toSend = [], skipped = [];
  const quiet = inQuietHours(now, opts.tz, opts.quietStart, opts.quietEnd);

  for(const s of subs){
    if(s.active === false){ skipped.push({id:s.id, reason:"inactive"}); continue; }
    const cond = condByLoc.get(locKey(s.lat, s.lon));
    if(!cond){ skipped.push({id:s.id, reason:"no weather"}); continue; }

    const rb = rainbowStatus(now, s.lat, s.lon, cond);
    const wants = rb.lv==="good" || (rb.lv==="fair" && s.includeMaybe);
    if(!wants){ skipped.push({id:s.id, reason:`rb=${rb.lv}`}); continue; }

    if(quiet){ skipped.push({id:s.id, reason:"quiet hours"}); continue; }

    const last = state.lastAlert && state.lastAlert[s.id];
    if(last && (now - new Date(last)) < cooldownMs){ skipped.push({id:s.id, reason:"cooldown"}); continue; }

    toSend.push({ sub:s, rb });
  }
  return { toSend, skipped };
}

/* ---------- main ---------- */
async function main(){
  const DRY = num(process.env.DRY_RUN, 1) !== 0;
  const opts = {
    cooldownHours: num(process.env.COOLDOWN_HOURS, 2),
    quietStart: num(process.env.QUIET_START, 22),
    quietEnd: num(process.env.QUIET_END, 6),
    tz: process.env.ALERT_TZ || "America/New_York"
  };
  const now = new Date();

  const senderCfg = buildSenderCfg(process.env);

  // --- one-off delivery test. Set exactly one of these to send a single real alert and exit,
  //     ignoring the weather and DRY_RUN:
  //       TEST_TO=+1...            → SMS
  //       TEST_EMAIL=a@b.com       → email
  //       TEST_TELEGRAM=123456789  → telegram chat id
  //     (web push can't be tested this way — it needs a real browser subscription.) ---
  const testSub =
      (process.env.TEST_TO       && process.env.TEST_TO.trim())       ? { channel:"sms",      phone: process.env.TEST_TO.trim() }
    : (process.env.TEST_EMAIL    && process.env.TEST_EMAIL.trim())    ? { channel:"email",    email: process.env.TEST_EMAIL.trim() }
    : (process.env.TEST_TELEGRAM && process.env.TEST_TELEGRAM.trim()) ? { channel:"telegram", telegram: process.env.TEST_TELEGRAM.trim() }
    : null;
  if (testSub) {
    testSub.label = "your spot";
    const rb = { lv:"good", label:"Likely", look:"the east" };
    const parts = formatAlert(testSub.label, rb, testSub.channel);
    parts.subject = "🌈 Rainbow Alerts test";
    parts.body = "🌈 Rainbow Alerts test — if you got this, alerts work! " + (testSub.channel==="sms"?"Reply STOP to opt out.":testSub.channel==="telegram"?"Send /stop to opt out.":"");
    console.log(`[rainbow-watch] TEST ${testSub.channel} send`);
    try {
      const res = await dispatch(testSub, parts, senderCfg);
      console.log(`  test sent OK (${res})`);
    } catch (e) { console.error(`  test FAILED: ${e.message}`); process.exit(1); }
    return;
  }

  const subs = JSON.parse(await readFile(SUBS_FILE, "utf8"));
  let state = { lastAlert:{} };
  try { state = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { /* first run */ }
  if(!state.lastAlert) state.lastAlert = {};

  const active = subs.filter(s => s.active !== false);
  console.log(`[rainbow-watch] ${now.toISOString()} — ${active.length} active subscriber(s), DRY_RUN=${DRY?1:0}`);

  // one weather fetch per unique location
  const locs = new Map();
  for(const s of active) locs.set(locKey(s.lat,s.lon), {lat:s.lat, lon:s.lon});
  const condByLoc = new Map();
  for(const [key,{lat,lon}] of locs){
    try { condByLoc.set(key, await fetchCond(lat,lon)); }
    catch(e){ console.warn(`  weather fetch failed for ${key}: ${e.message}`); }
  }

  const { toSend, skipped } = selectAlerts(subs, condByLoc, state, now, opts);
  console.log(`  ${toSend.length} to alert, ${skipped.length} skipped`);

  for(const { sub, rb } of toSend){
    const ch = sub.channel || "sms";
    const parts = formatAlert(sub.label, rb, ch);
    if(DRY){
      console.log(`  [DRY] would ${ch} ${contactOf(sub)}: ${parts.body.replace(/\n+/g," ")}`);
    } else {
      try {
        const res = await dispatch(sub, parts, senderCfg);
        console.log(`  sent ${ch} to ${contactOf(sub)} (${res})`);
      } catch(e){ console.error(`  FAILED ${ch} ${contactOf(sub)}: ${e.message}`); continue; }
    }
    state.lastAlert[sub.id] = now.toISOString();
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  console.log("  state saved.");
}

// run only when executed directly (not when imported by tests)
if(process.argv[1] && process.argv[1].endsWith("rainbow-watch.mjs")){
  main().catch(e => { console.error(e); process.exit(1); });
}
