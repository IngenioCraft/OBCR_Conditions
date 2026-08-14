/* ============================================================
   Rainbow logic — shared by the website engine and the alert watcher.
   Pure functions, no DOM, no network. Keep this in lock-step with
   the rainbowStatus() logic in assets/conditions.js so a text and the
   website never disagree.
   ============================================================ */

const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
export const compass = d => (d==null||isNaN(d)) ? "" : COMPASS[Math.round(d/22.5)%16];

/* Sun altitude (degrees above horizon) & azimuth (deg from N, clockwise).
   Identical math to sunPos() in conditions.js. */
export function sunPos(date, lat, lon){
  const rad=Math.PI/180, d=date.getTime()/86400000+2440587.5-2451545.0;
  const g=(357.529+0.98560028*d)%360, q=(280.459+0.98564736*d)%360;
  const L=(q+1.915*Math.sin(g*rad)+0.020*Math.sin(2*g*rad))%360, e=23.439-0.00000036*d;
  const dec=Math.asin(Math.sin(e*rad)*Math.sin(L*rad))/rad;
  let RA=Math.atan2(Math.cos(e*rad)*Math.sin(L*rad),Math.cos(L*rad))/rad; RA=(RA+360)%360;
  let GMST=(18.697374558+24.06570982441908*d)%24; if(GMST<0)GMST+=24;
  let LST=(GMST*15+lon)%360; if(LST<0)LST+=360;
  let HA=LST-RA; HA=((HA+540)%360)-180;
  const latR=lat*rad,decR=dec*rad,HAr=HA*rad;
  const alt=Math.asin(Math.sin(latR)*Math.sin(decR)+Math.cos(latR)*Math.cos(decR)*Math.cos(HAr))/rad;
  let az=Math.atan2(Math.sin(HAr),Math.cos(HAr)*Math.sin(latR)-Math.tan(decR)*Math.cos(latR))/rad; az=(az+180)%360;
  return {alt,az};
}

/* Weather codes that mean "showers about" (same set as conditions.js). */
export const SHOWERY = [51,53,55,61,63,65,80,81,82,95,96,99];

/* Sun must be below this altitude for a rainbow to be geometrically possible. */
export const SUN_MAX_ALT = 42;

/* Cloud-cover gates (percent). A rainbow needs the sun's disk actually shining on the rain.
   Above SUN_OVERCAST the sky is solid grey (a downpour) — no direct sun, so no bow.
   At/below SUN_CLEARISH there's enough blue that the sun is confidently out. */
export const SUN_OVERCAST = 85;
export const SUN_CLEARISH = 62;

/* Decide rainbow status from a point's sun position + weather.
   cond = { isDay:bool, code:int (WMO), recentRainIn:number|null, cloudCover:number|null (0-100%) }
   Returns { lv:"good"|"fair"|"none", label, look, alt, why }.
     good  = "Likely"  (fire on this)
     fair  = "Maybe"   (fire only if the subscriber opted into maybes)
     none  = don't alert
*/
export function rainbowStatus(date, lat, lon, cond){
  const sp = sunPos(date, lat, lon);
  const look = compass((sp.az+180)%360);
  const out = { lv:"none", label:"Unlikely", look, alt:sp.alt, why:"" };

  if(!cond.isDay || sp.alt < 0){ out.why="sun isn't up"; return out; }
  if(sp.alt > SUN_MAX_ALT){ out.why=`sun too high (${Math.round(sp.alt)}°)`; return out; }

  const showery = SHOWERY.includes(cond.code);
  const recent  = cond.recentRainIn != null && cond.recentRainIn > 0.02;
  const cloud   = (cond.cloudCover==null || isNaN(+cond.cloudCover)) ? null : +cond.cloudCover;

  // Rainbow needs the sun actually shining ON the rain. Solid overcast (it's pouring, grey out)
  // means the sun is blocked — don't alert, even though it's raining.
  if(cloud != null && cloud > SUN_OVERCAST){
    out.why = `overcast (${Math.round(cloud)}% cloud) — sun blocked, no rainbow`;
    return out;
  }
  const sunClear = cloud == null ? true : cloud <= SUN_CLEARISH;   // confident the sun is out

  if(showery){
    if(sunClear){ out.lv="good"; out.label="Likely"; out.why=`sun low (${Math.round(sp.alt)}°) + showers, sky breaking — look ${look}`; }
    else        { out.lv="fair"; out.label="Maybe";  out.why=`showers + sun low (${Math.round(sp.alt)}°) but ${Math.round(cloud)}% cloud — needs a sunny break — watch ${look}`; }
    return out;
  }
  if(recent){
    if(sunClear){ out.lv="fair"; out.label="Maybe"; out.why=`rained recently, sun low (${Math.round(sp.alt)}°) — watch ${look}`; }
    else         { out.why=`rained recently but ${Math.round(cloud)}% cloud — sun blocked`; }
    return out;
  }
  out.why=`sun low (${Math.round(sp.alt)}°) but no rain about`;
  return out;
}

/* The SMS body. Kept short — one segment where possible. */
export function alertText(label, rb){
  return `\u{1F308} Rainbow ${rb.label.toLowerCase()==="likely"?"likely":"possible"} at ${label} right now — `
    + `sun's low with ${rb.lv==="good"?"showers around":"recent rain"}. Look ${rb.look} (away from the sun), next ~30 min. `
    + `Reply STOP to end.`;
}

/* Channel-aware alert copy. Returns { subject, title, body } tailored to how each
   channel delivers — the decision logic is identical; only the wording/opt-out differs.
   channel: "sms" | "telegram" | "email" | "push"  (defaults to sms). */
export function formatAlert(label, rb, channel){
  const strength = rb.label.toLowerCase()==="likely" ? "likely" : "possible";
  const why  = rb.lv==="good" ? "showers around" : "recent rain";
  const core = `Rainbow ${strength} at ${label} right now — sun's low with ${why}. `
             + `Look ${rb.look} (away from the sun), next ~30 min.`;
  const RB = "\u{1F308}";
  switch(channel){
    case "email":
      return {
        subject: `${RB} Rainbow ${strength} at ${label} right now`,
        title:   `Rainbow ${strength} — ${label}`,
        body:    `${RB} ${core}\n\nYou're getting this because you signed up for Rainbow Alerts. `
               + `To stop, reply to this email with "unsubscribe".`,
      };
    case "push":
      return {
        subject: `${RB} Rainbow ${strength} — ${label}`,
        title:   `${RB} Rainbow ${strength} — ${label}`,
        body:    core,
      };
    case "telegram":
      return {
        subject: `${RB} Rainbow ${strength} — ${label}`,
        title:   `Rainbow ${strength} — ${label}`,
        body:    `${RB} ${core}\n\nSend /stop to turn these off.`,
      };
    case "sms":
    default:
      return {
        subject: `${RB} Rainbow ${strength} — ${label}`,
        title:   `Rainbow ${strength} — ${label}`,
        body:    `${RB} ${core} Reply STOP to end.`,
      };
  }
}
