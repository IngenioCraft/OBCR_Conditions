/* ============================================================
   Coastal Conditions — shared engine
   Reads window.SPOT_CONFIG (set inline in each page) and renders
   a full conditions + activities dashboard. No dependencies, no keys.
   ============================================================ */
(function(){
"use strict";
const CFG = window.SPOT_CONFIG || {};
const TZ = CFG.tz || "America/New_York";
const REFRESH_MS = 10*60*1000;
const PROXY_BASE = CFG.proxyBase || ""; // set only if NOAA is CORS-blocked once hosted

/* Tunable thresholds (mph unless noted). Edit to taste. */
const T = {
  paddleWindGood:10, paddleGustGood:15, paddleWindPoor:16, paddleGustPoor:22,   // SUP
  kayakWindGood:12, kayakGustGood:18, kayakWindPoor:19, kayakGustPoor:26,
  sailWindMin:5, sailWindGood:9, sailWindHigh:20, sailWindPoor:24,
  kiteWindMin:7, kiteWindGood:10, kiteWindHigh:22, kiteWindPoor:26,
  swimWarm:70, swimOK:62, swimCold:56, swimWavePoor:4, swimWaveFair:2,
  surfMin:1.5, surfGoodLo:3, surfGoodHi:7, surfBig:10, surfPeriodGood:7,
  rainRecentAdvise:0.75, rainRecentWatch:0.3,  // inches in last 24h -> bacteria risk
  uvHigh:6, uvVery:8, uvExtreme:11
};

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const el=(t,c,h)=>{const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e;};
const fails=[];
async function getJSON(url){
  try{const r=await fetch(url); if(!r.ok)throw new Error("HTTP "+r.status); return await r.json();}
  catch(e){ if(PROXY_BASE){const r=await fetch(PROXY_BASE+encodeURIComponent(url)); return await r.json();} throw e; }
}
const round=(v,n=0)=>v==null||isNaN(v)?null:Number(v).toFixed(n);
const compass=d=>d==null||isNaN(d)?"":["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(d/22.5)%16];
const fmtTime=d=>d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:TZ});
const fmtHour=d=>d.toLocaleTimeString("en-US",{hour:"numeric",timeZone:TZ});
const fmtHM=d=>d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:TZ});
const isStorm=c=>[95,96,99].includes(c);
const WMO={0:"Clear",1:"Mostly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Fog",51:"Light drizzle",53:"Drizzle",
  55:"Heavy drizzle",61:"Light rain",63:"Rain",65:"Heavy rain",71:"Light snow",73:"Snow",75:"Heavy snow",
  80:"Showers",81:"Showers",82:"Heavy showers",95:"T-storm",96:"T-storm",99:"T-storm"};
const RANK={good:0,fair:1,poor:2,storm:3};
function uvCat(u){ if(u==null)return""; if(u<3)return"Low"; if(u<6)return"Moderate"; if(u<8)return"High"; if(u<11)return"Very high"; return"Extreme"; }
function uvProtect(u){ if(u==null)return""; if(u<3)return"Low — sunscreen optional"; if(u<6)return"Hat, SPF 30, sunglasses"; if(u<8)return"SPF 30+, hat, sunglasses — reapply every 2h"; if(u<11)return"SPF 50, hat, shade/umbrella — cover up, avoid 10–4"; return"SPF 50+, umbrella, cover up — stay out of midday sun"; }
function uvBurn(u){ if(u==null||u<1)return null; return Math.max(5,Math.round(80/u)); } // ~min to burn, unprotected fair skin
function aqiCat(a){ if(a==null)return""; if(a<=50)return"Good"; if(a<=100)return"Moderate"; if(a<=150)return"Unhealthy (sensitive)"; if(a<=200)return"Unhealthy"; if(a<=300)return"Very unhealthy"; return"Hazardous"; }
/* crew helpers */
function coldWater(f){ if(f==null)return null;
  if(f<50)return{lv:"poor",msg:"Cold water ("+round(f)+"°F) — flip = hypothermia risk. Follow cold-water rules: PFDs, hug the shore, short pieces, launch on the water."};
  if(f<60)return{lv:"fair",msg:"Cool water ("+round(f)+"°F) — dress for immersion; extra caution with novice crews."};
  return{lv:"good",msg:"Water "+round(f)+"°F — normal precautions."}; }
function fogStatus(mi){ if(mi==null)return null;
  if(mi<0.5)return{lv:"poor",msg:"Dense fog (~"+mi.toFixed(1)+" mi vis) — high collision risk with powerboats. Not advisable."};
  if(mi<1)return{lv:"fair",msg:"Reduced visibility (~"+mi.toFixed(1)+" mi) — fog risk, stay near shore and alert."};
  return{lv:"good",msg:"Good visibility."}; }

/* ============================================================
   Activity scoring — each returns {lv, why}
   ============================================================ */
function lvFromRank(r){return ["good","fair","poor","storm"][Math.min(r,3)];}
const ACTS=[
 {key:"swim",label:"Swim",ico:"🏊",needs:s=>true,score:(c,spot)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — out of the water."};
    if(c.wq&&c.wq.lv==="poor")return{lv:"poor",why:"Water-quality caution after recent rain (see below)."};
    let r=0, w=[];
    if(c.waterF!=null){ if(c.waterF<T.swimCold){r=Math.max(r,2);w.push("cold water "+round(c.waterF)+"°");}
      else if(c.waterF<T.swimOK){r=Math.max(r,1);w.push("brisk "+round(c.waterF)+"°");}
      else w.push("water "+round(c.waterF)+"°");}
    if(c.waveFt!=null){ if(c.waveFt>T.swimWavePoor){r=Math.max(r,2);w.push("big surf "+round(c.waveFt,1)+"ft");}
      else if(c.waveFt>T.swimWaveFair){r=Math.max(r,1);w.push("chop "+round(c.waveFt,1)+"ft");}}
    if(c.wq&&c.wq.lv==="fair"){r=Math.max(r,1);w.push("some runoff risk");}
    if(c.uv!=null&&c.uv>=T.uvHigh)w.push("UV "+round(c.uv)+" — cover up / reef-safe SPF");
    if(spot&&spot.lifeguard){ const lg=lifeguardStatus(spot);
      if(lg.onDuty) w.push("🛟 lifeguards on duty till "+lg.closeStr);
      else { r=Math.max(r,1); w.push(lg.inSeason?"no lifeguard on duty now — swim with care":"no lifeguards (off season) — swim with care"); } }
    return{lv:lvFromRank(r),why:w.join(", ")||"Looks swimmable."};}},

 {key:"surf",label:"Surf",ico:"🏄",needs:s=>s.surf,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — no."};
    if(c.waveFt==null)return{lv:"fair",why:"No live swell data for this spot."};
    if(c.waveFt<T.surfMin)return{lv:"poor",why:"Flat — only "+round(c.waveFt,1)+" ft."};
    if(c.waveFt>T.surfBig)return{lv:"poor",why:"Huge/heavy — "+round(c.waveFt,1)+" ft, experts only."};
    let r=0,w=["~"+round(c.waveFt,1)+" ft"];
    if(c.wavePeriod!=null){w.push(round(c.wavePeriod)+"s period"); if(c.wavePeriod<T.surfPeriodGood){r=Math.max(r,1);}}
    if(c.waveFt<T.surfGoodLo||c.waveFt>T.surfGoodHi)r=Math.max(r,1);
    if(c.windMph>18){r=Math.max(r,1);w.push("windy/blown out");}
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"row",label:"Rowing",ico:"🚣",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — off the water."};
    let r=0,w=[];
    if(c.windMph>16||c.gustMph>23){r=2;w.push("too rough for shells "+round(c.windMph)+" g"+round(c.gustMph));}
    else if(c.windMph>10||c.gustMph>17){r=1;w.push("choppy "+round(c.windMph)+" g"+round(c.gustMph));}
    else w.push("calm water "+round(c.windMph)+" mph");
    if(c.waveFt!=null&&c.waveFt>1.5){r=Math.max(r,1);w.push("wakes/chop");}
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"kayak",label:"Kayak",ico:"🛶",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — stay ashore."};
    let r=0,w=[];
    if(c.windMph>T.kayakWindPoor||c.gustMph>T.kayakGustPoor){r=2;w.push("too windy "+round(c.windMph)+" g"+round(c.gustMph));}
    else if(c.windMph>T.kayakWindGood||c.gustMph>T.kayakGustGood){r=1;w.push("breezy "+round(c.windMph)+" g"+round(c.gustMph));}
    else w.push("light wind "+round(c.windMph)+" mph");
    if(c.waveFt!=null&&c.waveFt>2.5){r=Math.max(r,1);w.push("chop "+round(c.waveFt,1)+"ft");}
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"sup",label:"SUP",ico:"🏄‍♀️",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — no."};
    let r=0,w=[];
    if(c.windMph>T.paddleWindPoor||c.gustMph>T.paddleGustPoor){r=2;w.push("too windy for SUP "+round(c.windMph)+" g"+round(c.gustMph));}
    else if(c.windMph>T.paddleWindGood||c.gustMph>T.paddleGustGood){r=1;w.push("getting breezy "+round(c.windMph)+" mph");}
    else w.push("calm & glassy "+round(c.windMph)+" mph");
    if(c.waveFt!=null&&c.waveFt>2){r=Math.max(r,1);w.push("bumpy "+round(c.waveFt,1)+"ft");}
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"efoil",label:"eFoil",ico:"⚡",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — off the water."};
    let r=0,w=[];
    if(c.windMph>20||c.gustMph>28||(c.waveFt!=null&&c.waveFt>4)){r=2;w.push("too rough "+round(c.windMph)+" g"+round(c.gustMph));}
    else if(c.windMph>14||(c.waveFt!=null&&c.waveFt>3)){r=1;w.push("choppy "+round(c.windMph)+" mph — doable");}
    else w.push("glassy — great foiling "+round(c.windMph)+" mph");
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"sail",label:"Sailing",ico:"⛵",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — no."};
    let r=0,w=[];
    if(c.windMph<T.sailWindMin){r=2;w.push("too little wind "+round(c.windMph)+" mph");}
    else if(c.windMph>T.sailWindPoor||c.gustMph>30){r=2;w.push("small-craft strong "+round(c.windMph)+" g"+round(c.gustMph));}
    else if(c.windMph<T.sailWindGood||c.windMph>T.sailWindHigh){r=1;w.push(round(c.windMph)+" mph "+compass(c.windDir));}
    else w.push("nice breeze "+round(c.windMph)+" mph "+compass(c.windDir));
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"boat",label:"Boating",ico:"🚤",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — stay in port."};
    let r=0,w=[];
    if(c.windMph>28||c.gustMph>38||(c.waveFt!=null&&c.waveFt>6)){r=2;w.push("small-craft dangerous "+round(c.windMph)+" g"+round(c.gustMph));}
    else if(c.windMph>21||c.gustMph>30||(c.waveFt!=null&&c.waveFt>4)){r=1;w.push("choppy — small-craft caution "+round(c.windMph)+" mph");}
    else w.push("good boating "+round(c.windMph)+" mph"+(c.waveFt!=null?", seas ~"+round(c.waveFt,1)+"ft":""));
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"fish",label:"Fishing",ico:"🎣",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Lightning risk — wait it out."};
    let r=0,w=[];
    if(c.windMph>28){r=2;w.push("too rough "+round(c.windMph)+" mph");}
    else if(c.windMph>20){r=1;w.push("windy "+round(c.windMph)+" mph");}
    if(c.tide&&c.tide.state){w.push("tide "+c.tide.state+(c.tide.state!=="slack"?" — moving water":""));}
    return{lv:lvFromRank(r),why:w.join(", ")||"Fair conditions."};}},

 {key:"beachwalk",label:"Beach walk",ico:"🚶",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"poor",why:"Thunderstorms around."};
    let r=0,w=[];
    if(c.precipProb!=null&&c.precipProb>70){r=2;w.push("rain likely "+round(c.precipProb)+"%");}
    else if(c.precipProb!=null&&c.precipProb>40){r=1;w.push("might get wet "+round(c.precipProb)+"%");}
    if(c.airF!=null&&c.airF<38){r=Math.max(r,1);w.push("cold "+round(c.airF)+"°");}
    if(c.windMph>28){r=Math.max(r,1);w.push("very windy");}
    return{lv:lvFromRank(r),why:w.join(", ")||"Pleasant for a walk."};}},

 {key:"beachday",label:"Beach day",ico:"🏖️",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms."};
    let r=0,w=[];
    if(c.precipProb!=null&&c.precipProb>50){r=2;w.push("rain "+round(c.precipProb)+"%");}
    else if(c.precipProb!=null&&c.precipProb>30){r=1;w.push("some clouds/rain risk");}
    if(c.airF!=null){ if(c.airF<58){r=Math.max(r,2);w.push("cool "+round(c.airF)+"°");}
      else if(c.airF<70){r=Math.max(r,1);w.push(round(c.airF)+"°");} else w.push("warm "+round(c.airF)+"°");}
    if(c.uv!=null&&c.uv>=T.uvHigh){const b=uvBurn(c.uv);w.push("high UV "+round(c.uv)+(b?", burns in ~"+b+" min":"")+" — "+uvProtect(c.uv));}
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"kite",label:"Fly a kite",ico:"🪁",needs:s=>true,score:(c,spot)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — no kites."};
    if(spot&&spot.lifeguard){ const lg=lifeguardStatus(spot);
      if(lg.onDuty) return{lv:"poor",why:"not while lifeguards are on duty — the beach is busy till "+lg.closeStr+". Fly a kite after that."}; }
    let r=0,w=[];
    if(c.windMph<T.kiteWindMin){r=2;w.push("too calm "+round(c.windMph)+" mph");}
    else if(c.windMph>T.kiteWindPoor){r=2;w.push("too strong "+round(c.windMph)+" mph");}
    else if(c.windMph<T.kiteWindGood||c.windMph>T.kiteWindHigh){r=1;w.push(round(c.windMph)+" mph");}
    else w.push("perfect breeze "+round(c.windMph)+" mph");
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"sandcastle",label:"Sandcastles",ico:"🏰",needs:s=>true,score:(c)=>{
    let r=0,w=[];
    if(c.precipProb!=null&&c.precipProb>60){r=2;w.push("too wet");}
    if(c.windMph>22){r=Math.max(r,2);w.push("blowing sand");}
    else if(c.windMph>15){r=Math.max(r,1);w.push("breezy");}
    if(c.tide&&c.tide.nextLow)w.push("best near low tide "+fmtHour(c.tide.nextLow));
    return{lv:lvFromRank(r),why:w.join(", ")||"Great sand-building weather."};}},

 {key:"dolphin",label:"Dolphin / wildlife",ico:"🐬",needs:s=>true,score:(c)=>{
    let r=0,w=[];
    if(!c.isDay){r=1;w.push("better in daylight");}
    if(c.waveFt!=null&&c.waveFt>2.5){r=Math.max(r,1);w.push("choppy — harder to spot");}
    else w.push("calm seas — good visibility");
    if(c.windMph>18){r=Math.max(r,1);}
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"party",label:"Backyard party",ico:"🎉",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — move it indoors."};
    let r=0,w=[];
    if(c.precipProb!=null&&c.precipProb>55){r=2;w.push("rain likely "+round(c.precipProb)+"%");}
    else if(c.precipProb!=null&&c.precipProb>30){r=1;w.push("keep an eye on rain "+round(c.precipProb)+"%");}
    if(c.airF!=null){ if(c.airF>90){r=Math.max(r,1);w.push("hot "+round(c.airF)+"°");}
      else if(c.airF<52){r=Math.max(r,2);w.push("chilly "+round(c.airF)+"°");}}
    if(c.gustMph>25){r=Math.max(r,1);w.push("gusty");}
    if(c.sunset)w.push("sunset "+fmtHour(c.sunset));
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"bike",label:"Bike ride",ico:"🚴",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — off the road."};
    let r=0,w=[];
    if(c.precipProb!=null&&c.precipProb>60){r=2;w.push("wet roads likely "+round(c.precipProb)+"%");}
    else if(c.precipProb!=null&&c.precipProb>35){r=1;w.push("watch for showers "+round(c.precipProb)+"%");}
    if(c.airF!=null){ if(c.airF>92){r=Math.max(r,1);w.push("hot "+round(c.airF)+"°");} else if(c.airF<38){r=Math.max(r,1);w.push("cold "+round(c.airF)+"°");}}
    if(c.gustMph>26){r=Math.max(r,1);w.push("strong headwinds "+round(c.windMph)+" mph");}
    return{lv:lvFromRank(r),why:w.join(", ")||"great for a ride"};}},

 {key:"gamenight",label:"Family game night",ico:"🎲",needs:s=>true,score:(c)=>{
    const rainy=(c.precipProb!=null&&c.precipProb>50)||[61,63,65,80,81,82].includes(c.code);
    if(isStorm(c.code)||rainy)return{lv:"good",why:"wet out — perfect night to stay in 🎲"};
    if(c.airF!=null&&c.airF<45)return{lv:"good",why:"chilly out — cozy games in"};
    return{lv:"fair",why:"gorgeous out — save it for after dark"};}},

 {key:"beachbike",label:"Beach biking",ico:"🚲",needs:s=>!!s.surf,score:(c)=>beachFirmSand(c)},
 {key:"beachjog",label:"Beach jogging",ico:"🏃",needs:s=>!!s.surf,score:(c)=>beachFirmSand(c)}
];
/* Firm wet sand at the waterline is only rideable/runnable near low tide (roughly 2h either
   side). Best in good weather; the window tracks the nearest low tide. */
function fmtMins(m){ m=Math.round(Math.abs(m)); if(m<60)return m+" min"; const h=Math.floor(m/60),mm=m%60; return h+"h"+(mm?" "+mm+"m":""); }
function beachFirmSand(c){
  if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — off the beach."};
  let r=0,w=[];
  if(c.precipProb!=null&&c.precipProb>60){r=2;w.push("rain likely "+round(c.precipProb)+"%");}
  else if(c.precipProb!=null&&c.precipProb>35){r=1;w.push("showers possible "+round(c.precipProb)+"%");}
  if(c.airF!=null){ if(c.airF>92){r=Math.max(r,1);w.push("hot "+round(c.airF)+"°");} else if(c.airF<38){r=Math.max(r,1);w.push("cold "+round(c.airF)+"°");}}
  if(c.gustMph>28){r=Math.max(r,1);w.push("strong wind "+round(c.windMph)+" mph");}
  if(c.minsToLow==null){ w.push("tide data unavailable — firm sand tracks low tide"); }
  else if(c.nearLowTide){
    const m=c.minsToLow;
    w.push(Math.abs(m)<=20?"low tide now — firm, fast sand":(m>0?"firm sand — low tide in "+fmtMins(m):"firm sand — "+fmtMins(m)+" past low"));
  } else {
    r=Math.max(r,2);
    const m=c.minsToLow, nl=(c.tide&&c.tide.nextLow)?fmtHour(c.tide.nextLow):null;
    if(m>0) w.push("sand's soft — window opens ~"+fmtMins(m-120)+(nl?" (low tide "+nl+")":""));
    else w.push("sand's soft now — catch the next low"+(nl?" ("+nl+")":""));
  }
  return{lv:lvFromRank(r),why:w.join(", ")};
}

/* ============================================================
   Fetching + deriving conditions for one spot
   ============================================================ */
async function fetchSpot(spot){
  const {lat,lon}=spot;
  const wxU="https://api.open-meteo.com/v1/forecast?latitude="+lat+"&longitude="+lon+
    "&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,uv_index,cloud_cover"+
    "&minutely_15=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code"+
    "&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,uv_index,visibility,cloud_cover"+
    "&daily=sunrise,sunset,uv_index_max,precipitation_sum&timeformat=unixtime&past_days=1&forecast_days=7"+
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone="+encodeURIComponent(TZ)+
    // Sheltered harbors are smaller than the model grid cell; forcing the nearest LAND cell avoids
    // reading the windier open-water value. Set spot.sheltered:true for tucked-in bays/harbors.
    (spot.sheltered?"&cell_selection=land":"");
  const aqU="https://air-quality-api.open-meteo.com/v1/air-quality?latitude="+lat+"&longitude="+lon+
    "&current=us_aqi&timezone="+encodeURIComponent(TZ);
  const marU=spot.marine?("https://marine-api.open-meteo.com/v1/marine?latitude="+lat+"&longitude="+lon+
    "&current=wave_height,wave_period,sea_surface_temperature&hourly=wave_height&length_unit=imperial&temperature_unit=fahrenheit&timeformat=unixtime&timezone="+encodeURIComponent(TZ)):null;

  const windU=spot.windProxy||null;  // optional live-wind proxy (Worker) — averaged PWS
  const [wx,aq,mar,windLive]=await Promise.all([
    getJSON(wxU).catch(e=>{fails.push("Weather: "+e.message);return null;}),
    getJSON(aqU).catch(e=>{fails.push("Air quality: "+e.message);return null;}),
    marU?getJSON(marU).catch(e=>{fails.push("Marine: "+e.message);return null;}):Promise.resolve(null),
    windU?getJSON(windU).catch(e=>{fails.push("Live wind: "+e.message);return null;}):Promise.resolve(null)
  ]);
  // water temp: NOAA live if station, else marine SST
  let waterF=null, waterSrc=null, waterEst=false;
  if(spot.waterTempStation){
    try{const d=await getJSON("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station="+spot.waterTempStation+
      "&product=water_temperature&units=english&time_zone=lst_ldt&format=json&application=coastal-conditions");
      if(d&&d.data&&d.data.length){waterF=+d.data[0].v; waterSrc="Live · station "+spot.waterTempStation;}
    }catch(e){}
  }
  if(waterF==null&&mar&&mar.current&&mar.current.sea_surface_temperature!=null){
    waterF=mar.current.sea_surface_temperature; waterSrc="Modeled estimate"; waterEst=true;
  }
  // tides
  let tide=null, tideEvents=[];
  if(spot.tideStation){
    try{
      const beg=ymdET();
      const d=await getJSON("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date="+beg+"&range=48&station="+
        spot.tideStation+"&product=predictions&datum=MLLW&interval=hilo&units=english&time_zone=gmt&format=json&application=coastal-conditions");
      if(d&&d.predictions&&d.predictions.length){
        const now=new Date();
        tideEvents=d.predictions.map(p=>({t:new Date(p.t.replace(" ","T")+"Z"),v:+p.v,type:p.type}));
        const next=tideEvents.find(e=>e.t>now)||tideEvents[tideEvents.length-1];
        const nextLow=tideEvents.find(e=>e.t>now&&e.type==="L");
        tide={state:next?(next.type==="H"?"rising":"falling"):null,next:next,nextLow:nextLow?nextLow.t:null};
      }
    }catch(e){fails.push("Tides: "+e.message);}
  }
  return {wx,aq,mar,waterF,waterSrc,waterEst,tide,tideEvents,windLive};
}

function deriveNow(data,spot){
  const wx=data.wx; if(!wx)return null;
  const c=wx.current, h=wx.hourly;
  let hi=h?h.time.findIndex(t=>t*1000>Date.now()):-1; hi=hi<=0?0:hi-1;
  // recent rain (last 24h) from hourly precipitation incl past_days
  let recentRain=null;
  if(h&&h.precipitation){ recentRain=0; for(let i=Math.max(0,hi-24);i<=hi&&i<h.precipitation.length;i++){recentRain+=h.precipitation[i]||0;} }
  const sunrise=wx.daily?new Date(wx.daily.sunrise[wx.daily.sunrise.length>1?1:0]*1000):null;
  // pick today's sunrise/sunset (past_days=1 -> index 1 is today)
  const di=wx.daily&&wx.daily.time?wx.daily.time.findIndex(t=>{const d=new Date(t*1000);const n=new Date();
    return new Intl.DateTimeFormat("en-CA",{timeZone:TZ}).format(d)===new Intl.DateTimeFormat("en-CA",{timeZone:TZ}).format(n);}):-1;
  const dIdx=di>=0?di:(wx.daily&&wx.daily.time?wx.daily.time.length-2:0);
  const sr=wx.daily?new Date(wx.daily.sunrise[dIdx]*1000):null;
  const ss=wx.daily?new Date(wx.daily.sunset[dIdx]*1000):null;
  const now=new Date();
  const cond={
    airF:c.temperature_2m, feelsF:c.apparent_temperature, code:c.weather_code,
    windMph:c.wind_speed_10m, gustMph:c.wind_gusts_10m, windDir:c.wind_direction_10m,
    uv:c.uv_index!=null?c.uv_index:(h&&h.uv_index?h.uv_index[hi]:null),
    uvMax:wx.daily?wx.daily.uv_index_max[dIdx]:null,
    aqi:data.aq&&data.aq.current?data.aq.current.us_aqi:null,
    waterF:data.waterF, waveFt:data.mar&&data.mar.current?data.mar.current.wave_height:null,
    wavePeriod:data.mar&&data.mar.current?data.mar.current.wave_period:null,
    precipProb:h&&h.precipitation_probability?h.precipitation_probability[hi]:null,
    recentRainIn:recentRain, sunrise:sr, sunset:ss,
    visMi:(h&&h.visibility&&h.visibility[hi]!=null)?h.visibility[hi]/1609.34:null,
    isDay:sr&&ss?(now>=sr&&now<=ss):true, tide:data.tide
  };
  // nearest low tide (past or future), for firm-sand activities at the waterline
  let minsToLow=null;
  if(data.tideEvents&&data.tideEvents.length){
    for(const e of data.tideEvents){ if(e.type!=="L")continue; const dm=(e.t-now)/60000;
      if(minsToLow===null||Math.abs(dm)<Math.abs(minsToLow))minsToLow=dm; }
  }
  cond.minsToLow=minsToLow;                                   // signed: <0 = low was |x| min ago, >0 = in x min
  cond.nearLowTide=minsToLow!=null&&Math.abs(minsToLow)<=120; // within the ~2h-either-side firm-sand window
  // live wind: a fresh averaged PWS reading beats the model for a sheltered harbor
  cond.windSource="model";
  const wl=data.windLive;
  if(wl&&wl.fresh&&wl.windMph!=null){
    cond.windMph=wl.windMph;
    if(wl.gustMph!=null)cond.gustMph=wl.gustMph;
    if(wl.dir!=null)cond.windDir=wl.dir;
    cond.windSource="live"; cond.windStations=wl.stations||[]; cond.windAgeMin=wl.ageMin;
  }
  // directional shelter (tucked-in harbors): trim MODEL wind blowing off the land, keep it when
  // it's blowing down the open water. Conservative — gusts trimmed only half as much, floored at spot.shelter.min.
  if(spot.shelter&&cond.windSource==="model"&&cond.windMph!=null&&cond.windDir!=null){
    const f=shelterFactor(cond.windDir,spot.shelter.open,spot.shelter.min);
    if(f<0.995){ cond.windRaw=cond.windMph; cond.gustRaw=cond.gustMph;
      cond.windMph=cond.windMph*f;
      if(cond.gustMph!=null)cond.gustMph=cond.gustMph*(1-(1-f)*0.5);
      cond.windSheltered=true; cond.windFactor=f; }
  }
  // water-quality assessment (rain runoff based)
  cond.wq=assessWQ(cond,spot);
  return cond;
}
/* Shelter factor: 1.0 when wind blows FROM the open-water bearing (long fetch, keep the model),
   down to minF when it blows from the opposite side (off the land). Smooth cosine falloff. */
function shelterFactor(fromDir,openBearing,minF){
  minF=(minF==null)?0.6:minF; if(openBearing==null)return 1;
  let diff=Math.abs(fromDir-openBearing); if(diff>180)diff=360-diff;
  const t=(1+Math.cos(diff*Math.PI/180))/2;   // 1 aligned with open water, 0 straight off the land
  return minF+(1-minF)*t;
}

function assessWQ(cond,spot){
  const r=cond.recentRainIn;
  if(r==null)return{lv:"fair",label:"Unknown",detail:"No recent-rainfall data available."};
  if(r>=T.rainRecentAdvise)return{lv:"poor",label:"Caution — recent heavy rain",
    detail:round(r,2)+'" of rain in the last 24h. Stormwater runoff can raise bacteria levels; many health departments advise waiting ~24h after heavy rain before swimming.'};
  if(r>=T.rainRecentWatch)return{lv:"fair",label:"Watch — some recent rain",
    detail:round(r,2)+'" of rain in the last 24h. Minor runoff possible; usually fine but check official advisories if sensitive.'};
  return{lv:"good",label:"No recent-rain concern",detail:"Little to no rain in the last 24h — low runoff risk. Always defer to posted advisories."};
}

/* ============================================================
   Rendering
   ============================================================ */
function skeleton(){
  const app=$("#app");
  app.innerHTML="";
  const w=el("div","wrap");
  if(CFG.homeLink!==false) w.appendChild(el("a","homelink","← All locations")).setAttribute("href","index.html");
  const hd=el("header","hd");
  hd.appendChild(el("h1",null,CFG.pageTitle||"Conditions"));
  const up=el("div","updated"); up.id="updated"; hd.appendChild(up);
  w.appendChild(hd);
  w.appendChild(el("div","tagline",CFG.tagline||""));
  const navEl=el("nav","secnav"); navEl.id="secnav"; navEl.setAttribute("aria-label","Jump to section"); w.appendChild(navEl);
  const nav=[];
  function section(id,heading,label){ const h=el("h2",null,heading); h.id=id; nav.push({id,label:label||heading}); return h; }
  if(CFG.spots&&CFG.spots.length>1){ const st=el("div","spottabs"); st.id="spottabs"; w.appendChild(st); }
  w.appendChild(el("div","spotnote")).id="spotnote";
  w.appendChild(el("div","summary lv-good")).id="summary";
  w.appendChild(el("div","diag")).id="diag";
  w.appendChild(section("sec-now",CFG.crew?"Crew go / no-go check":"Good for right now","Now"));
  w.appendChild(el("div","acts")).id="acts";
  w.appendChild(section("sec-numbers","The numbers","Numbers"));
  w.appendChild(el("div","grid")).id="grid";
  w.appendChild(section("sec-forecast","Through the day","Forecast"));
  w.appendChild(el("p","h2note","Timeline shows the trend — hover (or tap) for exact numbers; it highlights the matching card. Band = overall rating (wind &amp; gusts); bottom lane = rain chance; shaded = night."));
  const tg=el("div","toggle"); tg.id="toggle";
  tg.innerHTML='<button data-mode="q15">Next 3 hrs · 15→30 min</button><button data-mode="hourly" class="on">Next 12 hrs · hourly</button><button data-mode="h48">Next 48 hrs · 3-hourly</button>';
  w.appendChild(tg);
  const cw=el("div","chartwrap"); cw.id="chartwrap"; cw.innerHTML='<svg id="chart"></svg><div class="tip" id="tip"></div>'; w.appendChild(cw);
  w.appendChild(el("div","sparkkey",'<span><i style="background:#0b4f6c"></i>wind</span><span><i class="dash"></i>gusts</span><span><i style="background:var(--good)"></i>good</span><span><i style="background:var(--fair)"></i>fair</span><span><i style="background:var(--poor)"></i>rough</span><span><i style="background:#5fa8d3"></i>rain&nbsp;%</span><span>· tint = now→+3h</span>'));
  const stripEl=el("div","strip"); stripEl.id="strip"; stripEl.tabIndex=0;
  stripEl.setAttribute("role","group"); stripEl.setAttribute("aria-label","Forecast cards — scroll horizontally; hover a card to highlight it on the chart"); w.appendChild(stripEl);
  if(CFG.windyWidget||CFG.sailflow){
    w.appendChild(section("sec-windfc","Wind forecast — Windy &amp; SailFlow","Wind fc"));
    w.appendChild(el("p","h2note","Detailed wind forecast tables for this spot (third-party widgets). Live wind above comes from the harbor station; these look further ahead."));
    if(CFG.windyWidget){ const wy=CFG.windyWidget;
      const d=el("div","windywidget"); d.setAttribute("data-windywidget","forecast"); d.setAttribute("data-spotid",wy.spotid); d.setAttribute("data-appid",wy.appid); w.appendChild(d);
      const s=document.createElement("script"); s.async=true; s.src="https://windy.app/widget/windy_forecast_async.js"; w.appendChild(s);
    }
    if(CFG.sailflow){ const sf=CFG.sailflow;
      const box=el("div","sailflow");
      box.innerHTML=`<iframe src="https://widgets.sailflow.com/widgets/web/modelTable?spot_id=${sf.spotid}&units_wind=mph&units_temp=F" title="SailFlow wind forecast" loading="lazy"></iframe>`;
      w.appendChild(box);
    }
  }
  if(CFG.ferry){ w.appendChild(section("sec-ferry","Ferries to Bay Shore","Ferries")); const fe=el("div"); fe.id="ferry"; w.appendChild(fe); }
  w.appendChild(section("sec-wq","Water quality","Water quality"));
  w.appendChild(el("div","wq")).id="wq";
  if(CFG.fishing){ w.appendChild(section("sec-fishing","What's biting now — seasonal fishing","Fishing")); const f=el("div","wq"); f.id="fishing"; w.appendChild(f); }
  if(CFG.shellfish){ w.appendChild(section("sec-shellfish","Shellfish safety","Shellfish")); const sh=el("div","wq"); sh.id="shellfish"; w.appendChild(sh); }
  if(CFG.liveCam){ const lc=CFG.liveCam;
    w.appendChild(section("sec-cam","Live camera","Live cam"));
    if(lc.note) w.appendChild(el("p","h2note",lc.note));
    const box=el("div","livecam"), src=lc.credit?" · "+lc.credit:"";
    if(lc.embed){
      box.innerHTML=`<div class="camframe"><iframe src="${lc.embed}" title="${lc.label||'Live camera'}" loading="lazy" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe></div>`+
        `<div class="cap">${lc.label||'Live camera'}${src} · <a href="${lc.link||lc.embed}" target="_blank" rel="noopener">open full cam ↗</a></div>`;
    } else if(lc.link){
      // host doesn't allow embedding — offer a clean link-out card
      box.innerHTML=`<a class="camlink" href="${lc.link}" target="_blank" rel="noopener">`+
        `<span class="ic">📹</span><span class="lt"><b>${lc.label||'Live camera'}</b>${lc.credit?`<span class="src">${lc.credit}</span>`:''}</span>`+
        `<span class="go">Open live cam ↗</span></a>`;
    }
    if(lc.flag) box.innerHTML+=`<div class="flagguide"><b>🚩 Read the flag for a quick wind check:</b> limp ≈ calm · rippling ≈ 5–10 · half out ≈ 10–15 · straight &amp; snapping ≈ 15+ mph.</div>`;
    w.appendChild(box);
  }
  w.appendChild(section("sec-radar","Doppler radar","Radar"));
  w.appendChild(el("p","h2note","NWS "+(CFG.radarStation||"KOKX")+" loop — your area is near the center."));
  const rad=el("div","radar"); rad.innerHTML='<img id="radar" alt="radar loop"><div class="cap" id="radarcap">Loading radar…</div>';
  w.appendChild(rad);
  w.appendChild(section("sec-tides","Tides","Tides"));
  w.appendChild(el("div","tides")).id="tides";
  if(CFG.astro){ w.appendChild(section("sec-sky","Sky · moon, meteors &amp; rainbows","Sky")); w.appendChild(el("div","wq")).id="astro"; }
  if(CFG.pollen){ w.appendChild(section("sec-pollen","Pollen &amp; allergies","Pollen")); w.appendChild(el("div","wq")).id="pollen"; }
  w.appendChild(section("sec-nature","Nature &amp; sky notes","Nature")); w.appendChild(el("div","wq")).id="nature";
  w.appendChild(el("div","note",(CFG.footNote||"")+
    "<br><br>Activity ratings are automated guidance from weather &amp; marine models to help you plan — not a substitute for lifeguards, posted flags, official advisories, or your own judgment on the day."));
  w.appendChild(el("footer",null,sourcesHtml()));
  app.appendChild(w);
  // build jump-nav
  if(nav.length>1) navEl.innerHTML=nav.map(n=>'<a href="#'+n.id+'">'+n.label+'</a>').join(""); else navEl.style.display="none";
  // toggle handler
  $("#toggle").addEventListener("click",e=>{const b=e.target.closest("button"); if(!b)return;
    [...$("#toggle").children].forEach(x=>x.classList.remove("on")); b.classList.add("on"); renderForecast(b.dataset.mode);});
  attachChartHover();
  // spot tabs
  if(CFG.spots&&CFG.spots.length>1){
    const st=$("#spottabs");
    CFG.spots.forEach((s,i)=>{const b=el("button",i===0?"on":null,s.name); b.addEventListener("click",()=>selectSpot(i)); st.appendChild(b);});
  }
}
function sourcesHtml(){
  return 'Auto-refreshes every 10 min · times in US Eastern.<br>Sources: weather, waves, UV, air quality &amp; sun — '+
    '<a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>; tides &amp; water temp — '+
    '<a href="https://tidesandcurrents.noaa.gov" target="_blank" rel="noopener">NOAA Tides &amp; Currents</a>; radar — '+
    '<a href="https://radar.weather.gov" target="_blank" rel="noopener">NWS/NOAA</a>.'+
    (CFG.waterQualityLink?'<br>Official beach advisories: <a href="'+CFG.waterQualityLink+'" target="_blank" rel="noopener">'+(CFG.waterQualityLabel||"local health department")+' ↗</a>.':"");
}

let ACTIVE=0, DATA=null, COND=null;
function selectSpot(i){
  ACTIVE=i;
  if($("#spottabs")) [...$("#spottabs").children].forEach((b,j)=>b.classList.toggle("on",j===i));
  const spot=CFG.spots[i];
  $("#spotnote").textContent=spot.note||"";
  loadActive();
}
async function loadActive(){
  fails.length=0;
  const spot=CFG.spots[ACTIVE];
  $("#summary").innerHTML='<div class="pill">Loading…</div><div class="headline">Checking conditions…</div>';
  const now=Date.now();
  const willFetch=!spot._data||now-spot._ts>REFRESH_MS;
  if(willFetch){ const ph="<span class='err' style='padding:8px'>Updating…</span>";
    if($("#acts"))$("#acts").innerHTML=ph; if($("#grid"))$("#grid").innerHTML=ph;
    spot._data=await fetchSpot(spot); spot._ts=now; }
  DATA=spot._data; COND=deriveNow(DATA,spot);
  renderSummary(); renderCards(); renderActs(); renderForecast(currentMode()); renderWQ();
  if(CFG.ferry)renderFerry();
  if(CFG.fishing)renderFishing(); if(CFG.shellfish)renderShellfish();
  renderTides(); if(CFG.astro)renderAstro(); renderNature(); if(CFG.pollen)renderPollen(); loadRadar();
  const diag=$("#diag");
  if(fails.length){diag.style.display="block";
    diag.innerHTML="<b>Some live data didn't load.</b> If you're viewing this in a preview pane, that's expected — external data is blocked there and it works once hosted or opened directly in a browser. Details: "+[...new Set(fails)].join("; ")+".";}
  else diag.style.display="none";
  $("#updated").innerHTML='<span class="dot"></span>Updated '+fmtTime(new Date());
  if(CFG.astro&&!_splashed){ const rb=rainbowStatus(CFG.spots[ACTIVE]); if(rb.lv==="good"){ _splashed=true; setTimeout(rainbowSplash,250); } }
}
function currentMode(){const on=$("#toggle")&&$("#toggle").querySelector(".on");return on?on.dataset.mode:"hourly";}

/* how each activity behaves after dark: 'ok' = unaffected, 'caution' = cap at Fair, default = No after dark */
const NIGHT={fish:"ok",beachwalk:"ok",party:"ok",gamenight:"ok",boat:"caution",sail:"caution",bike:"caution"};
function scoreAct(act,c,spot){
  let r=act.score(c,spot);
  if(!c.isDay && r.lv!=="storm"){
    const nb=NIGHT[act.key]||"no";
    if(nb==="no") r={lv:"poor",why:"after dark — wait for daylight"};
    else if(nb==="caution" && RANK[r.lv]<1) r={lv:"fair",why:"after dark — lights &amp; extra caution"};
  }
  return r;
}
function activeActs(spot){
  return (CFG.activities&&CFG.activities.length?ACTS.filter(x=>CFG.activities.includes(x.key)):ACTS).filter(x=>x.needs(spot));
}
function renderSummary(){
  const s=$("#summary");
  if(!COND){s.className="summary lv-poor";s.innerHTML='<div class="headline">Conditions unavailable right now.</div>';return;}
  const spot=CFG.spots[ACTIVE];
  if(CFG.crew){ renderCrewSummary(s,spot); return; }
  const acts=activeActs(spot).map(a=>scoreAct(a,COND,spot));
  const good=acts.filter(a=>a.lv==="good").length, poor=acts.filter(a=>a.lv==="poor"||a.lv==="storm").length;
  let lv,head;
  if(isStorm(COND.code)){lv="storm";head="Thunderstorms around — stay out of the water";}
  else if(good>=acts.length*0.6){lv="good";head="Great day to be out";}
  else if(poor>=acts.length*0.5){lv="poor";head="Tough day out there";}
  else{lv="fair";head="A mixed bag today";}
  s.className="summary lv-"+lv;
  const dir=compass(COND.windDir);
  const rain=COND.precipProb;
  const rainTxt=rain==null?"":rain>50?` Rain likely (${round(rain)}%).`:rain>20?` Slight rain chance.`:` No rain expected.`;
  const trend=windTrend();
  s.innerHTML=`<div class="pill">${good} of ${acts.length} activities good right now</div>`+
    `<div class="headline">${head}</div>`+
    `<div class="line">Right now: <b>${round(COND.airF)}°F air</b>, <b>${COND.waterF!=null?round(COND.waterF)+"° water":"water n/a"}</b>, wind <b>${round(COND.windMph)} ${dir}</b> gusting ${round(COND.gustMph)}.${rainTxt}${COND.uv!=null?` UV ${round(COND.uv)} (${uvCat(COND.uv)}).`:""}</div>`+
    (trend?`<div class="line">${trend}</div>`:"");
}
function windTrend(){
  const h=DATA&&DATA.wx?DATA.wx.hourly:null; if(!h)return"";
  let s=h.time.findIndex(t=>t*1000>=Date.now()); if(s<0)return"";
  let peakG=COND.gustMph,peakW=COND.windMph,pt=null,worse=false,minW=COND.windMph,mt=null,better=false;
  for(let i=s;i<s+6&&i<h.time.length;i++){const w=h.wind_speed_10m[i],g=h.wind_gusts_10m[i];
    if(g>peakG+4){worse=true;peakG=g;peakW=w;pt=new Date(h.time[i]*1000);}
    if(w<minW-4){better=true;minW=w;mt=new Date(h.time[i]*1000);}}
  if(worse)return`<b>↗ Building</b> — wind rising toward ~${round(peakW)} mph, gusting ${round(peakG)}${pt?" by "+fmtHour(pt):""}.`;
  if(better&&mt)return`<b>↘ Easing</b> — calming toward ~${round(minW)} mph by ${fmtHour(mt)}.`;
  return`<b>→ Holding steady</b> for the next few hours.`;
}

function crewItems(c){
  const items=[]; const add=(key,lv,label,ico,why)=>items.push({key,lv,label,ico,why});
  if(c.windMph>16)add("wind","poor","Wind","💨",round(c.windMph)+" mph "+compass(c.windDir)+" — too rough for shells");
  else if(c.windMph>10)add("wind","fair","Wind","💨",round(c.windMph)+" mph "+compass(c.windDir)+" — chop building");
  else add("wind","good","Wind","💨",round(c.windMph)+" mph "+compass(c.windDir)+" — light");
  if(c.gustMph>23)add("gusts","poor","Gusts","🌬️",round(c.gustMph)+" mph — dangerous puffs");
  else if(c.gustMph>17)add("gusts","fair","Gusts","🌬️",round(c.gustMph)+" mph — watch the puffs");
  else add("gusts","good","Gusts","🌬️",round(c.gustMph)+" mph");
  if(c.windMph>16)add("water","poor","Water surface","🌊","Whitecaps / rough water");
  else if(c.windMph>11)add("water","fair","Water surface","🌊","Chop building");
  else add("water","good","Water surface","🌊","Calm — good set");
  const cw=coldWater(c.waterF); if(cw)add("coldwater",cw.lv,"Cold water","🥶",cw.msg);
  const fg=fogStatus(c.visMi); if(fg)add("visibility",fg.lv,"Visibility","🌫️",fg.msg);
  if(isStorm(c.code))add("lightning","storm","Lightning","⛈️","Thunderstorms — off the water now");
  else add("lightning","good","Lightning","⛈️","No storms nearby");
  if(!c.isDay)add("daylight","poor","Daylight","🌅","Dark — outside sunrise–sunset");
  else { const toSet=c.sunset?(c.sunset-new Date())/60000:999;
    if(toSet<30&&toSet>=0)add("daylight","fair","Daylight","🌅","Sunset ~"+fmtHour(c.sunset)+" — little light left");
    else add("daylight","good","Daylight","🌅","Light until "+(c.sunset?fmtHour(c.sunset):"—")); }
  return items;
}
function renderCrewSummary(s,spot){
  const items=crewItems(COND);
  const worst=items.reduce((m,it)=>Math.max(m,RANK[it.lv]),0);
  const lv=["good","fair","poor","storm"][Math.min(worst,3)];
  let head;
  if(items.some(i=>i.lv==="storm")) head="Off the water — thunderstorms";
  else if(lv==="poor"){
    const prio=["daylight","visibility","wind","water","gusts","coldwater"];
    const drv=prio.map(k=>items.find(i=>i.key===k&&i.lv==="poor")).find(Boolean);
    const k=drv?drv.key:"";
    head = k==="daylight" ? "Wait for daylight — too dark now"
         : k==="visibility" ? "Not advisable — fog / low visibility"
         : k==="coldwater" ? "Cold water — take cold-water precautions"
         : "Not advisable — too rough";
  } else if(lv==="fair") head="Row with caution";
  else head="Good to row";
  s.className="summary lv-"+lv;
  const dir=compass(COND.windDir), flags=[];
  const cw=coldWater(COND.waterF), fg=fogStatus(COND.visMi);
  if(cw&&cw.lv!=="good")flags.push(cw.lv==="poor"?"cold water "+round(COND.waterF)+"°":"cool water "+round(COND.waterF)+"°");
  if(fg&&fg.lv!=="good")flags.push(fg.lv==="poor"?"dense fog":"fog risk");
  if(!COND.isDay)flags.push("dark now");
  const trend=windTrend();
  s.innerHTML=`<div class="pill">OBCR crew conditions</div>`+
    `<div class="headline">${head}</div>`+
    `<div class="line">Wind <b>${round(COND.windMph)} mph ${dir}</b>, gusting <b>${round(COND.gustMph)}</b> · water <b>${COND.waterF!=null?round(COND.waterF)+"°F":"n/a"}</b> · air ${round(COND.airF)}°F.${flags.length?` <b>Watch:</b> ${flags.join(", ")}.`:""}</div>`+
    (trend?`<div class="line">${trend}</div>`:"");
}
function renderCrew(a){
  const items=crewItems(COND), lab={good:"OK",fair:"Caution",poor:"No-go",storm:"Stop"};
  let h=items.map(it=>`<div class="act ${it.lv}"><div class="top"><div class="name"><span class="ico">${it.ico}</span>${it.label}</div>`+
    `<div class="rate">${lab[it.lv]}</div></div><div class="why">${it.why}</div></div>`).join("");
  if(CFG.astro) h+=rainbowPillHTML();
  a.innerHTML=h;
}
function renderCards(){
  const g=$("#grid"); if(!COND){g.innerHTML="<span class='err'>Unavailable.</span>";return;}
  const cards=[];
  const card=(lbl,val,meta,est)=>`<div class="card">${est?'<span class="est">'+est+'</span>':''}<div class="lbl">${lbl}</div><div class="val">${val}</div>${meta?'<div class="meta">'+meta+'</div>':''}</div>`;
  let waterMeta=DATA.waterSrc||"";
  if(CFG.crew){ const cw=coldWater(COND.waterF); if(cw&&cw.lv==="poor")waterMeta="⚠ cold — flip = hypothermia risk"; else if(cw&&cw.lv==="fair")waterMeta="cool — dress for immersion"; }
  cards.push(card("Water temp",COND.waterF!=null?round(COND.waterF)+"<small>°F</small>":"—",waterMeta,DATA.waterEst?"est":""));
  cards.push(card("Air temp",round(COND.airF)+"<small>°F</small>","Feels "+round(COND.feelsF)+"° · "+(WMO[COND.code]||"")));
  const dir=compass(COND.windDir);
  cards.push(card("Wind",round(COND.windMph)+"<small> mph "+dir+"</small>","Gusts "+round(COND.gustMph)+" mph"+
    (COND.windSource==="live"?" · live from "+(COND.windStations?COND.windStations.length:1)+" nearby station"+((COND.windStations&&COND.windStations.length>1)?"s":""):"")+
    (COND.windSheltered?" · harbor-adjusted (model reads "+round(COND.windRaw)+")":""),
    COND.windSource==="live"?"live":(COND.windSheltered?"adj":"")));
  if(CFG.crew)cards.push(card("Visibility",COND.visMi!=null?(COND.visMi>=6?"Clear":COND.visMi.toFixed(1)+"<small> mi</small>"):"—",COND.visMi!=null&&COND.visMi<1?"⚠ fog — low visibility":"Fog/haze check"));
  if(COND.waveFt!=null)cards.push(card("Waves",round(COND.waveFt,1)+"<small> ft</small>",(COND.wavePeriod!=null?round(COND.wavePeriod)+"s swell":"")||"open-water est","est"));
  const uvB=uvBurn(COND.uv);
  const uvMeta=COND.uv!=null?((uvB?"Burns in ~"+uvB+" min · ":"")+uvProtect(COND.uv)):"";
  cards.push(card("UV index",COND.uv!=null?round(COND.uv)+"<small> "+uvCat(COND.uv)+"</small>":"—",uvMeta));
  cards.push(card("Air quality",COND.aqi!=null?round(COND.aqi)+"<small> AQI</small>":"—",COND.aqi!=null?aqiCat(COND.aqi):""));
  cards.push(card("Chance of rain",COND.precipProb!=null?round(COND.precipProb)+"<small>%</small>":"—","Next hour"));
  if(COND.tide&&COND.tide.next){const rising=COND.tide.state==="rising";
    cards.push(card("Tide",rising?'<span style="color:var(--brand-2)">Rising ▲</span>':'<span style="color:var(--muted)">Falling ▼</span>',(rising?"Next high ":"Next low ")+fmtTime(COND.tide.next.t)));}
  cards.push(card("Sunrise",COND.sunrise?fmtTime(COND.sunrise):"—",""));
  cards.push(card("Sunset",COND.sunset?fmtTime(COND.sunset):"—",""));
  g.innerHTML=cards.join("");
}

function renderActs(){
  const a=$("#acts"); if(!COND){a.innerHTML="<span class='err'>Unavailable.</span>";return;}
  if(CFG.crew){ renderCrew(a); return; }
  const spot=CFG.spots[ACTIVE];
  const list=activeActs(spot);
  let h=list.map(act=>{const r=scoreAct(act,COND,spot);const lab={good:"Good",fair:"Fair",poor:"Poor",storm:"No"}[r.lv];
    return `<div class="act ${r.lv}"><div class="top"><div class="name"><span class="ico">${act.ico}</span>${act.label}</div>`+
      `<div class="rate">${lab}</div></div><div class="why">${r.why}</div></div>`;}).join("");
  if(spot.lifeguard) h+=lifeguardPillHTML(spot);
  if(CFG.funPills) h+=CFG.funPills.map(p=>`<div class="act ${p.lv||'good'}"><div class="top"><div class="name"><span class="ico">${p.ico}</span>${p.label}</div>`+
    `<div class="rate">${p.rate}</div></div><div class="why">${p.why||''}</div></div>`).join("");
  if(CFG.venues) h+=CFG.venues.map(venuePillHTML).join("");
  if(CFG.astro) h+=rainbowPillHTML();
  a.innerHTML=h;
}

function stripLv(w,g,code){ if(isStorm(code))return"storm"; if(w>16||g>23)return"poor"; if(w>10||g>17)return"fair"; return"good"; }
const LVHEX={good:"#1f7a49",fair:"#9a6410",poor:"#c0392b",storm:"#7b241c"};
const LVLAB={good:"Good",fair:"Fair",poor:"Rough",storm:"Storms"};
let FPTS=[], FGEO=null, _rz=null;
function idxBefore(times,ms){let s=0;for(let i=0;i<times.length;i++){if(times[i]*1000<=ms)s=i;else break;}return s;}
function popAtH(H,tms){if(!H||!H.precipitation_probability)return null;let idx=0;for(let i=0;i<H.time.length;i++){if(H.time[i]*1000<=tms)idx=i;else break;}return H.precipitation_probability[idx];}
function nightAt(tms){const dy=DATA&&DATA.wx&&DATA.wx.daily; if(!dy||!dy.sunrise)return false;
  for(let i=0;i<dy.time.length;i++){if(tms>=dy.sunrise[i]*1000&&tms<=dy.sunset[i]*1000)return false;} return true;}
/* one shared point set for both the chart and the cards (keeps hover linkage 1:1) */
function forecastPoints(mode){
  const wx=DATA&&DATA.wx; if(!wx)return[];
  const now=Date.now(), H=wx.hourly; let src,offs=[];
  if(mode==="q15"){src=wx.minutely_15||wx.hourly; offs=[0,1,2,3,4,5,6,8,10,12];}   // 15-min to 90m, then 30-min
  else if(mode==="h48"){src=wx.hourly; for(let k=0;k<=48;k+=3)offs.push(k);}         // 3-hourly × 48h
  else {src=wx.hourly; for(let k=0;k<=12;k++)offs.push(k);}                          // hourly × 12h
  const s=idxBefore(src.time,now), pts=[];
  offs.forEach(k=>{const i=s+k; if(i>=src.time.length)return; const tms=src.time[i]*1000,w=src.wind_speed_10m[i],g=src.wind_gusts_10m[i],code=src.weather_code?src.weather_code[i]:0;
    pts.push({tms,date:new Date(tms),wind:w,gust:g,temp:src.temperature_2m[i],dir:src.wind_direction_10m?src.wind_direction_10m[i]:null,precip:popAtH(H,tms),code,rating:stripLv(w,g,code)});});
  return pts;
}
function renderForecast(mode){ FPTS=forecastPoints(mode); drawChart(mode); drawCards(mode); }
function drawCards(mode){
  const strip=$("#strip"); if(!strip)return;
  if(!FPTS.length){strip.innerHTML="<div class='err' style='padding:8px'>Forecast unavailable.</div>";return;}
  const fine=mode==="q15", wkday=d=>new Intl.DateTimeFormat("en-US",{timeZone:TZ,weekday:"short"}).format(d);
  let html="",lastDay=null;
  FPTS.forEach((p,i)=>{const day=wkday(p.date);
    if(!fine&&lastDay!==null&&day!==lastDay)html+=`<div class="daybreak"><span>${day}</span></div>`;
    lastDay=day; const isNow=i===0;
    html+=`<div class="hour ${p.rating}${isNow?' now':''}" data-i="${i}">`+
      (isNow?`<div class="nowtag">NOW</div>`:``)+
      `<div class="t">${fine?fmtHM(p.date):fmtHour(p.date)}</div>`+
      `<div class="temp">${round(p.temp)}°</div>`+
      `<div class="wind">${round(p.wind)} <span style="color:var(--muted);font-weight:400">${compass(p.dir)}</span></div>`+
      `<div class="gust">gust ${round(p.gust)}</div>`+
      (p.precip!=null&&!isNaN(p.precip)?`<div class="rain">☔ ${round(p.precip)}%</div>`:``)+`</div>`;
  });
  strip.innerHTML=html;
  strip.querySelectorAll(".hour").forEach(c=>{const i=+c.dataset.i;
    c.addEventListener("pointerenter",()=>highlightPoint(i,false)); c.addEventListener("pointerleave",clearHi);});
}
function drawChart(mode){
  const svg=$("#chart"), wrap=$("#chartwrap"); if(!svg)return;
  const pts=FPTS; if(pts.length<2){svg.innerHTML="";return;}
  const W=Math.max(320,Math.round((wrap&&wrap.clientWidth)||820)), H=214;
  const padL=40,padR=14,padTop=14,lineBot=116,bandY=122,bandH=13,rainY=140,rainH=17,xLabY=176, botY=rainY+rainH;
  const t0=pts[0].tms, tEnd=pts[pts.length-1].tms;
  const X=tms=>padL+(W-padL-padR)*(tms-t0)/((tEnd-t0)||1);
  const maxG=Math.max(15,...pts.map(p=>p.gust||0));
  const niceMax=maxG<=15?15:maxG<=20?20:maxG<=30?30:Math.ceil(maxG/10)*10, yStep=niceMax<=15?5:niceMax<=30?10:15;
  const Y=v=>lineBot-(lineBot-padTop)*(v/niceMax);
  FGEO={W,X,Y};
  let shade=""; for(let ms=t0;ms<tEnd;ms+=900000){if(nightAt(ms)){const x0=X(ms),x1=X(Math.min(ms+900000,tEnd));shade+=`<rect x="${x0.toFixed(1)}" y="${padTop}" width="${Math.max(0.5,x1-x0).toFixed(1)}" height="${botY-padTop}" fill="#e7edf1"/>`;}}
  let hi=""; if(mode!=="q15"){const x0=X(t0),x1=X(Math.min(t0+3*3600000,tEnd)); hi=`<rect x="${x0.toFixed(1)}" y="${padTop}" width="${(x1-x0).toFixed(1)}" height="${botY-padTop}" fill="#1b98c9" opacity="0.08"/>`;}
  let yg=""; for(let v=0;v<=niceMax;v+=yStep){const y=Y(v).toFixed(1); yg+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#eef2f5" stroke-width="1"/><text x="${padL-6}" y="${(+y+3).toFixed(1)}" font-size="10" fill="#8397a3" text-anchor="end">${v}</text>`;}
  yg+=`<text x="6" y="${padTop+4}" font-size="9.5" fill="#8397a3">mph</text>`;
  const wkday=d=>new Intl.DateTimeFormat("en-US",{timeZone:TZ,weekday:"short"}).format(d), labelEvery=pts.length>13?2:1;
  let vg="",band="",rain="",dayd="",xl="",lastDay=wkday(pts[0].date);
  pts.forEach((p,i)=>{const x=X(p.tms);
    vg+=`<line x1="${x.toFixed(1)}" y1="${padTop}" x2="${x.toFixed(1)}" y2="${bandY}" stroke="#f0f4f7" stroke-width="1"/>`;
    if(i<pts.length-1){const x1=X(pts[i+1].tms);band+=`<rect x="${x.toFixed(1)}" y="${bandY}" width="${Math.max(0.6,x1-x).toFixed(1)}" height="${bandH}" fill="${LVHEX[p.rating]}"/>`;}
    if(p.precip!=null&&p.precip>0){const segW=(i<pts.length-1?X(pts[i+1].tms)-x:(i>0?x-X(pts[i-1].tms):12)),bw=Math.min(9,Math.max(3,segW*0.55)),bh=rainH*p.precip/100;
      rain+=`<rect x="${(x-bw/2).toFixed(1)}" y="${(rainY+rainH-bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="#5fa8d3" opacity="0.9"/>`;}
    const dy=wkday(p.date);
    if(i>0&&dy!==lastDay)dayd+=`<line x1="${x.toFixed(1)}" y1="${padTop-6}" x2="${x.toFixed(1)}" y2="${botY}" stroke="#9db4c0" stroke-width="1" stroke-dasharray="3 3"/><text x="${(x+4).toFixed(1)}" y="${padTop}" font-size="11" font-weight="700" fill="#1b98c9">${dy}</text>`;
    lastDay=dy;
    if(i%labelEvery===0)xl+=`<text x="${x.toFixed(1)}" y="${xLabY}" font-size="10" fill="#5d7280" text-anchor="middle">${mode==="q15"?fmtHM(p.date):fmtHour(p.date)}</text>`;
  });
  const wPath="M"+pts.map(p=>X(p.tms).toFixed(1)+","+Y(p.wind).toFixed(1)).join(" L");
  const gPath="M"+pts.map(p=>X(p.tms).toFixed(1)+","+Y(p.gust).toFixed(1)).join(" L");
  const dots=pts.map(p=>`<circle cx="${X(p.tms).toFixed(1)}" cy="${Y(p.wind).toFixed(1)}" r="2.4" fill="#0b4f6c"/>`).join("");
  const nx=X(t0);
  const nowM=`<line x1="${nx.toFixed(1)}" y1="${padTop-6}" x2="${nx.toFixed(1)}" y2="${botY}" stroke="#0b4f6c" stroke-width="1.5"/><text x="${(nx+3).toFixed(1)}" y="${(botY-4).toFixed(1)}" font-size="9" font-weight="800" fill="#0b4f6c">now</text>`;
  svg.setAttribute("viewBox",`0 0 ${W} ${H}`); svg.setAttribute("height",H); svg.setAttribute("role","img");
  svg.setAttribute("aria-label","Timeline of wind, gusts, rain chance and overall conditions");
  svg.innerHTML=shade+hi+yg+vg+band+rain+`<text x="6" y="${(botY-3).toFixed(1)}" font-size="9" fill="#5fa8d3">☔%</text>`+
    `<path d="${gPath}" fill="none" stroke="#9bb7c4" stroke-width="1.6" stroke-dasharray="4 3"/>`+
    `<path d="${wPath}" fill="none" stroke="#0b4f6c" stroke-width="2.2"/>`+
    dots+dayd+xl+nowM+
    `<line id="cross" x1="0" y1="${padTop}" x2="0" y2="${botY}" stroke="#0b4f6c" stroke-width="1" opacity="0"/>`+
    `<circle id="cdot" r="4.5" fill="#1b98c9" stroke="#fff" stroke-width="1.5" opacity="0"/>`;
}
function highlightPoint(i,fromChart){
  const p=FPTS[i]; if(!p||!FGEO)return; const cross=$("#cross"),dot=$("#cdot"),tip=$("#tip"),svg=$("#chart");
  const x=FGEO.X(p.tms),y=FGEO.Y(p.wind);
  if(cross){cross.setAttribute("x1",x);cross.setAttribute("x2",x);cross.setAttribute("opacity",".5");}
  if(dot){dot.setAttribute("cx",x);dot.setAttribute("cy",y);dot.setAttribute("opacity","1");}
  if(tip&&svg){const rect=svg.getBoundingClientRect(),sc=rect.width?rect.width/FGEO.W:1;tip.style.left=(x*sc)+"px";tip.style.top=(y*sc)+"px";
    tip.innerHTML=`<b>${fmtHM(p.date)}</b> · ${new Intl.DateTimeFormat("en-US",{timeZone:TZ,weekday:"short"}).format(p.date)}<br>wind <b>${round(p.wind)}</b> mph · gust <b>${round(p.gust)}</b>`+
      (p.precip!=null?`<br>☔ rain <b>${round(p.precip)}%</b>`:``)+`<br><span class="r" style="background:${LVHEX[p.rating]}"></span>${LVLAB[p.rating]}`;
    tip.style.opacity="1";}
  const strip=$("#strip"); if(strip)strip.querySelectorAll(".hour").forEach(c=>c.classList.toggle("hl",+c.dataset.i===i));
  if(fromChart){const card=document.querySelector('#strip .hour[data-i="'+i+'"]'); if(card&&card.scrollIntoView)card.scrollIntoView({inline:"nearest",block:"nearest"});}
}
function clearHi(){const cross=$("#cross"),dot=$("#cdot"),tip=$("#tip");if(cross)cross.setAttribute("opacity","0");if(dot)dot.setAttribute("opacity","0");if(tip)tip.style.opacity="0";
  const s=$("#strip");if(s)s.querySelectorAll(".hour").forEach(c=>c.classList.remove("hl"));}
function nearestPoint(mx){let best=0,bd=1e9;FPTS.forEach((p,i)=>{const d=Math.abs(FGEO.X(p.tms)-mx);if(d<bd){bd=d;best=i;}});return best;}
function attachChartHover(){
  const svg=$("#chart"); if(!svg)return;
  svg.addEventListener("pointermove",e=>{if(!FGEO)return;const rect=svg.getBoundingClientRect();const mx=(e.clientX-rect.left)*(FGEO.W/(rect.width||FGEO.W));highlightPoint(nearestPoint(mx),true);});
  svg.addEventListener("pointerleave",clearHi);
  window.addEventListener("resize",()=>{clearTimeout(_rz);_rz=setTimeout(()=>{if(FPTS.length)renderForecast(currentMode());},160);});
}

function renderWQ(){
  const wq=$("#wq"); const w=COND&&COND.wq;
  if(!w){wq.innerHTML="<span class='err'>Unavailable.</span>";return;}
  wq.innerHTML=`<div class="status ${w.lv}">${w.label}</div><div class="detail">${w.detail}`+
    (CFG.waterQualityLink?` <a href="${CFG.waterQualityLink}" target="_blank" rel="noopener">Check official advisories ↗</a>.`:"")+`</div>`;
}

/* NY marine-district recreational seasons — DEC 2026 rules; verify yearly at the DEC link. */
const NY_SEASONS={
  bass:{name:"Striped bass",ranges:[["04-15","12-15"]],lim:'28–31" slot, 1'},
  fluke:{name:"Fluke (summer flounder)",ranges:[["05-04","10-15"]],lim:'19–19.5", 3'},
  seabass:{name:"Black sea bass",ranges:[["05-16","12-31"]],lim:'16", 3–6'},
  scup:{name:"Porgy (scup)",ranges:[["05-01","12-31"]],lim:'9.5–11", 30'},
  tautog:{name:"Blackfish (tautog)",ranges:[["04-01","04-30"],["10-15","12-22"]],lim:'16", 2–4'},
  bluefish:{name:"Bluefish",allyear:true,lim:'no min, 5'},
  weakfish:{name:"Weakfish",allyear:true,lim:'16", 1'},
  scallop:{name:"Bay scallops (Peconic)",ranges:[["11-02","03-31"]],lim:'permit · 1 bu/wk'}
};
const RUN_WINDOWS={
  albie:{name:"False albacore",months:[9,10,11]},
  tuna:{name:"Tuna — offshore (HMS permit)",months:[6,7,8,9,10]},
  shark:{name:"Sharks — offshore (HMS)",months:[6,7,8,9]},
  cod:{name:"Cod — offshore",months:[1,2,3,12]},
  snapper:{name:"Snapper blues",months:[8,9]},
  crab:{name:"Blue-claw crabs",months:[6,7,8,9,10]}
};
const MON=["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtMD(md){const p=md.split("-");return MON[+p[0]]+" "+(+p[1]);}
function todayMD(){return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,month:"2-digit",day:"2-digit"}).format(new Date());}
/* ---- ferries ---- */
function pad2(n){return (n<10?"0":"")+n;}
function nowMinET(){const p=new Intl.DateTimeFormat("en-GB",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date());
  return (+p.find(x=>x.type==="hour").value)*60+(+p.find(x=>x.type==="minute").value);}
function dowET(){const wd=new Intl.DateTimeFormat("en-US",{timeZone:TZ,weekday:"short"}).format(new Date());
  return {Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[wd];}
function toMin(t){const p=t.split(":");return (+p[0])*60+(+p[1]);}
function fmt12(t){let p=t.split(":"),h=+p[0],m=+p[1];const ap=h>=12?"PM":"AM";h=h%12||12;return h+":"+pad2(m)+" "+ap;}
/* ---- lifeguards (config-driven schedule, tied to swim + kite) ---- */
function lifeguardStatus(spot){
  const lg=spot&&spot.lifeguard; if(!lg)return{has:false};
  const t=todayMD(), dow=dowET(), nm=nowMinET();
  let period=null; (lg.periods||[]).forEach(p=>{ if(inRange(t,p.from,p.to)) period=p; });
  const out={has:true, station:lg.station||"", source:lg.source||"", inSeason:!!period, onDuty:false, todayHrs:null, pre:false, after:false};
  if(period){ const hrs=period.hours&&period.hours[dow];
    if(hrs){ out.todayHrs=hrs; const o=toMin(hrs[0]),c=toMin(hrs[1]);
      out.openStr=fmt12(hrs[0]); out.closeStr=fmt12(hrs[1]);
      if(nm>=o&&nm<c) out.onDuty=true; else if(nm<o) out.pre=true; else out.after=true; } }
  return out;
}
function lifeguardPillHTML(spot){
  const lg=lifeguardStatus(spot); if(!lg.has)return"";
  let lv="none",rate="Off duty",why;
  if(lg.onDuty){ lv="good"; rate="On duty"; why=`on the beach till ${lg.closeStr}${lg.station?" · "+lg.station:""} 🛟`; }
  else if(lg.pre){ why=`on duty ${lg.openStr}–${lg.closeStr} today`; }
  else if(lg.after){ why=`done for today — back tomorrow`; }
  else if(lg.inSeason){ why=`no guards scheduled today`; }
  else { rate="Off season"; why=`beach guards return Memorial Day weekend`; }
  const src=lg.source?` <a href="${lg.source}" target="_blank" rel="noopener" style="color:var(--muted);font-size:.9em">schedule ↗</a>`:"";
  return `<div class="act ${lv}"><div class="top"><div class="name"><span class="ico">🛟</span>Lifeguard</div>`+
    `<div class="rate">${rate}</div></div><div class="why">${why}${src}</div></div>`;
}
function nextDeps(list,now,k){
  const mins=(list||[]).map(t=>({t,m:toMin(t)})).sort((a,b)=>a.m-b.m);
  let up=mins.filter(x=>x.m>=now).slice(0,k), wrapped=false;
  if(!up.length){up=mins.slice(0,k);wrapped=true;}
  return {up,wrapped};
}
function depLine(nd){
  if(!nd.up.length)return "—";
  const first=`<span class="next">${fmt12(nd.up[0].t)}</span>`+(nd.wrapped?" (tomorrow, first boat)":"");
  const rest=nd.up.slice(1).map(x=>fmt12(x.t)).join(", ");
  return first+(rest?` · then ${rest}`:"");
}
function pickSchedule(F,t){
  const list=F.schedules||[];
  for(const s of list){ if(inRange(t,s.from,s.to))return{s,stale:false}; }
  let best=null; list.forEach(s=>{ if(s.from<=t&&(!best||s.from>best.from))best=s; });
  return {s:best||list[0],stale:true};
}
function renderFerry(){
  const box=$("#ferry"); if(!box)return; const F=CFG.ferry||{};
  if(!F.schedules||!F.schedules.length){box.innerHTML="";return;}
  const t=todayMD(), now=nowMinET(), weekend=[5,6,0].includes(dowET());
  const pick=pickSchedule(F,t), s=pick.s;
  const cards=(s.routes||[]).map(r=>{
    const set=weekend?r.weekend:r.weekday; if(!set)return "";
    const toBay=nextDeps(set.toBay,now,3), toIsl=nextDeps(set.toIsland,now,3);
    return `<div class="ferry"><h4>⛴️ ${r.name}</h4>`+
      `<div class="dir"><b>→ To Bay Shore:</b><br>${depLine(toBay)}</div>`+
      `<div class="dir"><b>← From Bay Shore:</b><br>${depLine(toIsl)}</div>`+
      (r.link?`<a href="${r.link}" target="_blank" rel="noopener">full schedule ↗</a>`:"")+`</div>`;
  }).join("");
  const warn=pick.stale?`<div class="status poor" style="font-size:.94rem;margin-bottom:6px">⚠ Showing the ${s.label} schedule, but today is outside its dates (${fmtMD(s.from)}–${fmtMD(s.to)}). Fire Island Ferries likely changed seasons — please verify times.</div>`:"";
  box.innerHTML=warn+`<div class="detail" style="margin-bottom:8px"><b>${s.label}</b> (${fmtMD(s.from)}–${fmtMD(s.to)}) · showing the <b>${weekend?"Fri–Sun":"Mon–Thu"}</b> schedule. ${F.note||""} `+
    (F.link?`<a href="${F.link}" target="_blank" rel="noopener">all Fire Island Ferries schedules ↗</a>`:"")+`</div>`+
    `<div class="ferries">${cards}</div>`;
}
function curMonth(){return +new Intl.DateTimeFormat("en-US",{timeZone:TZ,month:"numeric"}).format(new Date());}
function inRange(t,s,e){return s<=e?(t>=s&&t<=e):(t>=s||t<=e);}
function seasonStatus(sp,t){
  if(sp.allyear)return{open:true};
  for(const rg of sp.ranges){ if(inRange(t,rg[0],rg[1]))return{open:true,close:rg[1]}; }
  const starts=sp.ranges.map(r=>r[0]);
  const future=starts.filter(s=>s>t).sort();
  return{open:false,next:(future[0]||starts.slice().sort()[0])};
}
function renderFishing(){
  const box=$("#fishing"); if(!box)return; const F=CFG.fishing||{};
  const t=todayMD(), m=curMonth();
  const openNow=[],closed=[];
  (F.season||[]).forEach(k=>{const sp=NY_SEASONS[k]; if(!sp)return; const st=seasonStatus(sp,t);
    if(st.open)openNow.push(`<span class="tide-item">🎣 ${sp.name} <span style="color:var(--muted);font-weight:400">${sp.lim||""}</span></span>`);
    else closed.push(`${sp.name} — opens ${fmtMD(st.next)}`);});
  const runNow=(F.run||[]).map(k=>RUN_WINDOWS[k]).filter(x=>x&&x.months.includes(m)).map(x=>`<span class="tide-item">🎣 ${x.name}</span>`);
  let html=`<div class="status good">Fishing seasons — as of ${fmtMD(t)}</div>`;
  html+=`<div class="detail" style="font-weight:700;margin-top:8px;color:var(--ink)">Open &amp; in season now</div>`+
    `<div class="tides" style="margin:6px 0">${openNow.length?openNow.join(" "):"<span class='detail'>Nothing with an open legal season today — see below.</span>"}</div>`;
  if(runNow.length)html+=`<div class="detail" style="font-weight:700;margin-top:8px;color:var(--ink)">Also running now (when they show up)</div><div class="tides" style="margin:6px 0">${runNow.join(" ")}</div>`;
  if(closed.length)html+=`<div class="detail" style="font-weight:700;margin-top:8px;color:var(--ink)">Currently closed</div><div class="detail">${closed.join(" · ")}</div>`;
  if(F.note)html+=`<div class="detail" style="margin-top:8px">${F.note}</div>`;
  html+=`<div class="detail" style="margin-top:6px;font-style:italic">Dates follow NY DEC 2026 marine-district rules and can change mid-season — ${F.link?`<a href="${F.link}" target="_blank" rel="noopener">confirm current sizes, seasons &amp; limits ↗</a>`:"confirm with NY DEC"} before keeping anything.</div>`;
  box.innerHTML=html;
}

function renderShellfish(){
  const box=$("#shellfish"); if(!box)return; const S=CFG.shellfish||{}; const sp=CFG.spots[ACTIVE];
  const r=COND?COND.recentRainIn:null; const thr=S.rainThresholdIn||0.65;
  let lv,label,detail;
  if(r==null){lv="fair";label="rainfall data unavailable";detail="Confirm the area is certified open before harvesting.";}
  else if(r>=thr){lv="poor";label="likely rain closure in effect";detail=round(r,2)+'" of rain in the last 24h. Many bay beds here are conditionally certified and close automatically after about '+thr+'" of rain — assume closed until DEC reopens.';}
  else if(r>=thr*0.5){lv="fair";label="watch — recent rain";detail=round(r,2)+'" in the last 24h, approaching the closure trigger. Check DEC before you dig.';}
  else{lv="good";label="no rain-closure trigger";detail="Little recent rain ("+round(r,2)+'" in 24h). Still only harvest from certified-open, in-season areas with a permit.';}
  const links=`<div class="detail" style="margin-top:6px">`+
    (S.link?`<a href="${S.link}" target="_blank" rel="noopener">DEC temporary closures ↗</a>`:"")+
    (S.rainLink?` · <a href="${S.rainLink}" target="_blank" rel="noopener">rainfall-closure rules ↗</a>`:"")+`</div>`;
  const mapHtml=S.mapEmbed?`<div class="detail" style="margin-top:10px">Live DEC closure map (may take a few seconds to load):</div><iframe title="DEC shellfish closures map" loading="lazy" src="${S.mapEmbed}${S.mapEmbed.indexOf('?')>=0?'&':'?'}center=${sp.lon},${sp.lat}&level=13" style="width:100%;height:430px;border:1px solid var(--line);border-radius:12px;margin-top:6px;background:#eef3f6"></iframe>`:"";
  box.innerHTML=
    `<div class="status ${lv}">Rain runoff: ${label}</div><div class="detail">${detail}</div>`+
    `<div id="closurestatus" class="detail" style="margin-top:10px">`+(S.closureItemId?`Checking this spot against DEC's live closure map…`:``)+`</div>`+
    (S.note?`<div class="detail" style="margin-top:8px">${S.note}</div>`:"")+
    links+mapHtml+
    `<div class="detail" style="margin-top:6px;font-style:italic">Planning guidance only — not harvest authorization. A permit and certified-open, in-season waters are required.</div>`;
  if(S.closureItemId) queryClosure(sp,S.closureItemId);
}
async function queryClosure(spot,itemId){
  const target=$("#closurestatus"); if(!target)return; const myId=spot.id;
  try{
    const meta=await getJSON("https://www.arcgis.com/sharing/rest/content/items/"+itemId+"?f=json");
    const base=(meta.url||"").replace(/\/+$/,""); if(!base)throw new Error("no service url");
    let layers=[0];
    try{const svc=await getJSON(base+"?f=json"); if(svc.layers&&svc.layers.length)layers=svc.layers.map(l=>l.id);}catch(e){}
    const geom=encodeURIComponent(JSON.stringify({x:spot.lon,y:spot.lat,spatialReference:{wkid:4326}}));
    const hits=[];
    for(const id of layers){
      const q=base+"/"+id+"/query?f=json&geometry="+geom+"&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false";
      const rr=await getJSON(q).catch(()=>null);
      if(rr&&rr.features&&rr.features.length)rr.features.forEach(f=>hits.push(f.attributes));
    }
    if(ACTIVE<0||!CFG.spots[ACTIVE]||CFG.spots[ACTIVE].id!==myId)return; // spot switched
    if(hits.length){
      target.innerHTML=`<span class="status poor" style="font-size:1.02rem">⚠ This spot falls inside a DEC closure / uncertified area</span><br>${pickAttrs(hits[0])}`;
    }else{
      target.innerHTML=`<span class="status good" style="font-size:1.02rem">✓ Not inside a mapped DEC closure</span> — still confirm the area is certified and in season before harvesting.`;
    }
  }catch(e){
    target.innerHTML=`Live per-area status couldn't load — use the DEC map below to check this exact spot.`;
  }
}
function pickAttrs(a){
  const want=/(name|area|status|class|type|reason|closure|descr|remark|comment)/i;
  const show=Object.keys(a||{}).filter(k=>want.test(k)).slice(0,4)
    .map(k=>{const v=a[k]; return (v!=null&&String(v).trim()&&String(v).toLowerCase()!=="null")?`<b>${k}:</b> ${v}`:null;})
    .filter(Boolean);
  return show.length?show.join(" · "):"See the DEC map below for closure details.";
}

/* ============================================================
   Astronomy — moon phase, meteor showers, rainbow watch (all computed locally)
   ============================================================ */
function moonPhase(date){
  const syn=29.530588853, ref=Date.UTC(2000,0,6,18,14)/86400000, nowd=date.getTime()/86400000;
  let age=(nowd-ref)%syn; if(age<0)age+=syn; const frac=age/syn, illum=Math.round((1-Math.cos(2*Math.PI*frac))/2*100);
  let name,emoji;
  if(frac<0.03||frac>0.97){name="New moon";emoji="🌑";}
  else if(frac<0.22){name="Waxing crescent";emoji="🌒";}
  else if(frac<0.28){name="First quarter";emoji="🌓";}
  else if(frac<0.47){name="Waxing gibbous";emoji="🌔";}
  else if(frac<0.53){name="Full moon";emoji="🌕";}
  else if(frac<0.72){name="Waning gibbous";emoji="🌖";}
  else if(frac<0.78){name="Last quarter";emoji="🌗";}
  else {name="Waning crescent";emoji="🌘";}
  const dFull=((0.5-frac+1)%1)*syn, dNew=((1-frac)%1)*syn;
  return {name,emoji,illum,nextFull:new Date(date.getTime()+dFull*86400000),nextNew:new Date(date.getTime()+dNew*86400000)};
}
function sunPos(date,lat,lon){
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
const METEORS=[
  {name:"Quadrantids",from:"12-28",to:"01-12",peak:"01-03",zhr:110,dir:"NE"},
  {name:"Lyrids",from:"04-16",to:"04-25",peak:"04-22",zhr:18,dir:"E"},
  {name:"Eta Aquariids",from:"04-19",to:"05-28",peak:"05-06",zhr:50,dir:"E"},
  {name:"Delta Aquariids",from:"07-12",to:"08-23",peak:"07-30",zhr:25,dir:"S"},
  {name:"Perseids",from:"07-17",to:"08-24",peak:"08-12",zhr:100,dir:"NE"},
  {name:"Orionids",from:"10-02",to:"11-07",peak:"10-21",zhr:20,dir:"SE"},
  {name:"Leonids",from:"11-06",to:"11-30",peak:"11-17",zhr:15,dir:"E"},
  {name:"Geminids",from:"12-04",to:"12-17",peak:"12-14",zhr:130,dir:"E"},
  {name:"Ursids",from:"12-17",to:"12-26",peak:"12-22",zhr:10,dir:"N"}
];
function meteorNow(date,illum){
  const t=todayMD();
  const active=METEORS.filter(m=>inRange(t,m.from,m.to)).sort((a,b)=>b.zhr-a.zhr);
  if(active.length){const m=active[0];
    const moon=illum>60?` A bright moon (${illum}% lit) will wash out fainter ones.`:` Skies are fairly moon-dark — good for faint meteors.`;
    return `<b>${m.name}</b> active — ${t===m.peak?"<b>peaking tonight</b>":"peak "+fmtMD(m.peak)} (up to ~${m.zhr}/hr at peak). Best after midnight; look toward the ${m.dir}.${moon}`;
  }
  const y=date.getFullYear(); let best=null,bd=1e9;
  METEORS.forEach(m=>{const p=m.peak.split("-"); let dt=new Date(y,+p[0]-1,+p[1]); if(dt<date)dt=new Date(y+1,+p[0]-1,+p[1]); const dd=(dt-date)/86400000; if(dd<bd){bd=dd;best=m;}});
  return best&&bd<40?`No shower active now. Next: <b>${best.name}</b>, peak ${fmtMD(best.peak)}.`:"No major meteor shower active right now.";
}
function rainbowStatus(spot){
  const out={lv:"none",label:"Unlikely",why:"—",full:"—"};
  if(!COND)return out;
  const sp=sunPos(new Date(),spot.lat,spot.lon), look=compass((sp.az+180)%360);
  if(!COND.isDay||sp.alt<0){out.why="sun isn't up";out.full="Unlikely — the sun isn't up. Rainbows need sunlight low in the sky.";return out;}
  if(sp.alt>42){out.why="sun too high ("+round(sp.alt)+"°)";out.full=`Unlikely right now — the sun is high (${round(sp.alt)}° up). Best odds are within ~2 hrs of sunrise or sunset, when the sun drops below 42°.`;return out;}
  const code=COND.code, showery=[51,53,55,61,63,65,80,81,82,95,96,99].includes(code), recent=COND.recentRainIn!=null&&COND.recentRainIn>0.02;
  if(showery){out.lv="good";out.label="Likely";out.why="sun low + showers — look "+look;out.full=`<b>Good chance</b> — the sun is low (${round(sp.alt)}°) with showers around. Look toward the <b>${look}</b> (opposite the sun).`;return out;}
  if(recent){out.lv="fair";out.label="Maybe";out.why="rained recently — watch "+look;out.full=`<b>Possible</b> — it rained recently and the sun is low (${round(sp.alt)}°). If the sun breaks through, look toward the <b>${look}</b>.`;return out;}
  out.why="no rain about; sun low ("+round(sp.alt)+"°)";out.full=`Low — the sun is nicely low (${round(sp.alt)}°) but there's no rain about. If a shower passes while the sun stays out, look toward the <b>${look}</b>.`;
  return out;
}
function rainbowPillHTML(){
  const rb=rainbowStatus(CFG.spots[ACTIVE]);
  const url=CFG.rainbowSignup===false?null:(CFG.rainbowSignup||"signup.html");
  // plain pill if signup is turned off
  if(!url){
    return `<div class="act ${rb.lv}"><div class="top"><div class="name"><span class="ico">🌈</span>Rainbow</div>`+
      `<div class="rate">${rb.label}</div></div><div class="why">${rb.why}</div></div>`;
  }
  // combined bar: live status on the left, "text me" signup on the right
  const pitch=rb.lv==="good"?"Get a text when a rainbow's likely"
    :rb.lv==="fair"?"Get a heads-up when one's possible"
    :"Be first to know next time";
  return `<div class="act rainbar">`+
    `<div class="rb-status"><div class="rb-top"><span class="ico">🌈</span>`+
      `<span class="name">Rainbow</span><span class="rate lv-${rb.lv}">${rb.label}</span></div>`+
      `<div class="why">${rb.why}</div></div>`+
    `<div class="rb-sep"></div>`+
    `<div class="rb-ask"><div class="rb-pitch"><b>${pitch}</b> — free, reply STOP anytime</div>`+
      `<a class="rb-btn" href="${url}">Sign up →</a></div>`+
    `</div>`;
}
let _splashed=false;
function rainbowSplash(){
  if(typeof document==="undefined")return;
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches){glowPill();return;}
  document.querySelectorAll(".rb-splash").forEach(n=>n.remove());
  const RB=["#e74c3c","#e67e22","#f1c40f","#2ecc71","#3498db","#3f51b5","#8e44ad"], cx=600,baseY=352,r0=336,step=18;
  const paths=RB.map((c,i)=>{const r=r0-i*step;return `<path d="M ${cx-r} ${baseY} A ${r} ${r} 0 0 1 ${cx+r} ${baseY}" fill="none" stroke="${c}" stroke-width="15" stroke-linecap="round" style="animation-delay:${i*70}ms"/>`;}).join("");
  const o=document.createElement("div"); o.className="rb-splash";
  o.innerHTML=`<svg viewBox="0 0 1200 360" preserveAspectRatio="xMidYMin slice">${paths}</svg>`;
  document.body.appendChild(o);
  setTimeout(glowPill,1150); setTimeout(()=>o.classList.add("out"),2500); setTimeout(()=>o.remove(),3400);
}
function glowPill(){
  const pill=[...document.querySelectorAll("#acts .act")].find(a=>{const n=a.querySelector(".name");return n&&/Rainbow/.test(n.textContent);});
  if(!pill)return;
  pill.classList.remove("rb-glow"); void pill.offsetWidth; pill.classList.add("rb-glow");
  const r=pill.getBoundingClientRect();
  ["✨","🪙","✨","🌟","🪙","✨"].forEach((e,i)=>{const s=document.createElement("div"); s.className="rb-spark"; s.textContent=e;
    s.style.left=(r.left+8+Math.random()*Math.max(10,r.width-16))+"px"; s.style.top=(r.top+6+Math.random()*Math.max(8,r.height-14))+"px";
    s.style.animationDelay=(i*90)+"ms"; document.body.appendChild(s); setTimeout(()=>s.remove(),1800);});
  setTimeout(()=>{if(pill)pill.classList.remove("rb-glow");},2600);
}
/* venue pill — shows open/closed from local hours + season (e.g. a bakery in town) */
function venuePillHTML(v){
  const t=todayMD(), dow=dowET(), nm=nowMinET();
  let lv="none",rate="Closed",why="";
  const inSeason=!v.season||inRange(t,v.season.from,v.season.to);
  if(!inSeason){ why="closed for the season"; }
  else{ const hrs=v.hours&&v.hours[dow];
    if(!hrs){ why="closed today"; }
    else{ const o=toMin(hrs[0]),c=toMin(hrs[1]);
      if(nm>=o&&nm<c){ lv="good"; rate="Open"; why=`open till ${fmt12(hrs[1])}${v.addr?" · "+v.addr:""} ${v.ico}`; }
      else if(nm<o){ why=`opens ${fmt12(hrs[0])}${v.addr?" · "+v.addr:""}`; }
      else { why=`closed for the night — opens ${fmt12(hrs[0])}`; } }
  }
  return `<div class="act ${lv}"><div class="top"><div class="name"><span class="ico">${v.ico}</span>${v.label}</div>`+
    `<div class="rate">${rate}</div></div><div class="why">${why}</div></div>`;
}
/* ---------- visible planets (needs astronomy-engine, loaded on demand) ---------- */
const PLANETS=[
  {b:"Venus",nm:"Venus"},{b:"Jupiter",nm:"Jupiter"},{b:"Mars",nm:"Mars"},
  {b:"Saturn",nm:"Saturn"},{b:"Mercury",nm:"Mercury"}
];
let _astroLib=null; // null=untried, Promise while loading, true=ready, false=failed
function loadAstroLib(){
  if(_astroLib===true)return Promise.resolve(true);
  if(_astroLib===false)return Promise.resolve(false);
  if(_astroLib)return _astroLib;
  if(typeof window!=="undefined"&&window.Astronomy){_astroLib=true;return Promise.resolve(true);}
  _astroLib=new Promise(res=>{
    if(typeof document==="undefined"){_astroLib=false;return res(false);}
    const s=document.createElement("script");
    s.src="https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/astronomy.browser.min.js";
    s.async=true;
    s.onload=()=>{_astroLib=!!window.Astronomy;res(_astroLib);};
    s.onerror=()=>{_astroLib=false;res(false);};
    document.head.appendChild(s);
  });
  return _astroLib;
}
function planetAltAz(A,body,time,obs){
  const eq=A.Equator(body,time,obs,true,true);
  const hor=A.Horizon(time,obs,eq.ra,eq.dec,"normal");
  return {alt:hor.altitude,az:hor.azimuth};
}
function visiblePlanets(spot){
  const A=(typeof window!=="undefined")?window.Astronomy:null; if(!A)return null;
  let obs,sunset,sunrise; const now=new Date();
  try{
    obs=new A.Observer(spot.lat,spot.lon,0);
    sunset=A.SearchRiseSet("Sun",obs,-1,now,1);
    sunrise=A.SearchRiseSet("Sun",obs,+1,now,1);
  }catch(e){return null;}
  if(!sunset||!sunrise)return null;
  const eveT=new A.AstroTime(new Date(sunset.date.getTime()+70*60000));
  const morT=new A.AstroTime(new Date(sunrise.date.getTime()-70*60000));
  const eve=[],mor=[];
  for(const p of PLANETS){
    try{
      const e=planetAltAz(A,p.b,eveT,obs); if(e.alt>7)eve.push({nm:p.nm,alt:e.alt,dir:compass(e.az)});
      const m=planetAltAz(A,p.b,morT,obs); if(m.alt>7)mor.push({nm:p.nm,alt:m.alt,dir:compass(m.az)});
    }catch(e){}
  }
  eve.sort((a,b)=>b.alt-a.alt); mor.sort((a,b)=>b.alt-a.alt);
  return {eve,mor};
}
function planetsHTML(spot){
  const v=visiblePlanets(spot); if(!v)return null;
  const fmt=arr=>arr.map(p=>`${p.nm} <span style="color:var(--muted)">(${p.dir}, ${Math.round(p.alt)}° up)</span>`).join(", ");
  const parts=[];
  if(v.eve.length)parts.push(`<b>after dusk</b> — ${fmt(v.eve)}`);
  if(v.mor.length)parts.push(`<b>before dawn</b> — ${fmt(v.mor)}`);
  if(!parts.length)return "No bright planets are well-placed tonight — they're too close to the sun this week.";
  return "Look "+parts.join("; ")+".";
}
function fillPlanets(spot){
  const box=$("#planets"); if(!box)return;
  loadAstroLib().then(ok=>{
    const cur=$("#planets"); if(!cur)return; // section may have re-rendered
    if(!ok){cur.innerHTML="<b>🪐 Planets:</b> couldn't load the planet almanac just now — try a refresh.";return;}
    const h=planetsHTML(spot);
    cur.innerHTML=h?`<b>🪐 Planets tonight:</b> ${h}`:"<b>🪐 Planets:</b> none well-placed tonight.";
  });
}
function renderAstro(){
  const box=$("#astro"); if(!box)return; const spot=CFG.spots[ACTIVE], now=new Date();
  const mp=moonPhase(now), fd=d=>d.toLocaleDateString("en-US",{month:"short",day:"numeric"});
  box.innerHTML=
    `<div class="astromoon"><span class="mE">${mp.emoji}</span><div><div class="status good" style="color:var(--brand)">${mp.name} · ${mp.illum}% lit</div>`+
    `<div class="detail">Next full moon ${fd(mp.nextFull)} · new moon ${fd(mp.nextNew)}.</div></div></div>`+
    `<div class="detail" style="margin-top:12px"><b>🌈 Rainbow watch:</b> ${rainbowStatus(spot).full}</div>`+
    `<div class="detail" style="margin-top:10px"><b>☄️ Meteor showers:</b> ${meteorNow(now,mp.illum)}</div>`+
    `<div class="detail" id="planets" style="margin-top:10px"><b>🪐 Planets:</b> checking the sky…</div>`+
    `<div class="detail" style="margin-top:10px;font-style:italic">Moon, rainbow &amp; meteor peaks are computed locally (approximate); planet positions use the astronomy-engine almanac. A stargazing app has exact rise/set times.</div>`;
  fillPlanets(spot);
}
/* ============================================================
   Nature & sky notes — reuses moon, tide, sun, water & cloud data
   ============================================================ */
const WILDLIFE=[
  {emoji:"🦅",name:"Ospreys",from:"03-18",to:"09-20",note:"nesting on channel markers &amp; platforms; they migrate to South America by late September"},
  {emoji:"🌹",name:"Beach roses",from:"06-01",to:"08-15",note:"Rosa rugosa in bloom along the dunes"},
  {emoji:"✨",name:"Fireflies",from:"06-01",to:"07-20",note:"lighting up dunes &amp; yards after dusk"},
  {emoji:"🌊",name:"Sea sparkle",from:"07-20",to:"09-20",note:"bioluminescence possible on warm, dark, calm nights"},
  {emoji:"🐋",name:"Whales &amp; dolphins",from:"06-15",to:"10-15",note:"feeding offshore as bunker (menhaden) run"},
  {emoji:"🌾",name:"Goldenrod &amp; asters",from:"08-20",to:"10-15",note:"blooming along dunes &amp; roadsides"},
  {emoji:"🦋",name:"Monarchs",from:"09-01",to:"10-10",note:"streaming down the coast toward Mexico"},
  {emoji:"🦭",name:"Harbor seals",from:"11-15",to:"04-15",note:"hauled out on rocks &amp; sandbars — give them room"}
];
function daysUntilMD(md){ const now=new Date(),y=now.getFullYear(),p=md.split("-");
  let d=new Date(y,+p[0]-1,+p[1]); if(d<now)d=new Date(y+1,+p[0]-1,+p[1]); return Math.round((d-now)/86400000); }
function wildlifeNow(){
  const t=todayMD();
  const active=WILDLIFE.filter(m=>inRange(t,m.from,m.to));
  let html=active.slice(0,5).map(m=>`${m.emoji} <b>${m.name}</b> — ${m.note}`).join("<br>");
  const up=WILDLIFE.filter(m=>!inRange(t,m.from,m.to)).map(m=>({m,d:daysUntilMD(m.from)})).sort((a,b)=>a.d-b.d)[0];
  if(up&&up.d<45) html+=(html?"<br>":"")+`<span style="color:var(--muted)">Coming up: ${up.m.emoji} ${up.m.name} around ${fmtMD(up.m.from)}.</span>`;
  return html||"Quiet season — check back as spring warms up.";
}
function mdOf(dt){ return (dt.getMonth()+1)+"-"+dt.getDate(); }
function goldenHourHTML(c){
  if(!c.sunrise||!c.sunset)return null;
  const amEnd=new Date(c.sunrise.getTime()+40*60000), pmStart=new Date(c.sunset.getTime()-40*60000);
  return `Morning ${fmtTime(c.sunrise)}–${fmtTime(amEnd)}, evening ${fmtTime(pmStart)}–${fmtTime(c.sunset)}. Blue hour is the ~20 min just before sunrise &amp; after sunset.`;
}
function horseshoeHTML(){
  const t=todayMD(); if(!inRange(t,"04-25","07-10"))return null;
  const mp=moonPhase(new Date()), near=mp.illum<10||mp.illum>90;
  let hi=null; const ev=DATA&&DATA.tideEvents, now=new Date();
  if(ev){ const fut=ev.filter(e=>e.type==="H"&&e.t>now);
    hi=fut.find(e=>{const h=+new Intl.DateTimeFormat("en-US",{hour:"numeric",hour12:false,timeZone:TZ}).format(e.t);return h>=18||h<=1;})||fut[0]; }
  const hiTxt=hi?fmtTime(hi.t):"the evening high tide";
  const soon=mp.nextNew<mp.nextFull?mp.nextNew:mp.nextFull, sn=mp.nextNew<mp.nextFull?"new moon":"full moon";
  if(near) return `<b>Spawning likely tonight</b> — best around the evening high tide (${hiTxt}); look at the waterline after dark.`;
  return `Spawning season — the big nights are the next ${sn} (${fmtMD(mdOf(soon))}). A few crawl up on any evening high tide (${hiTxt}).`;
}
function jellyfishHTML(c){
  const t=todayMD(); if(!inRange(t,"06-25","09-30"))return null;
  if(c.waterF==null)return null;
  const warm=c.waterF>=68, breezy=c.windMph>=8;
  if(warm&&breezy) return `<b>Higher odds</b> — warm water (${round(c.waterF)}°) and an onshore breeze can push jellyfish &amp; sea nettles toward the beach.`;
  if(warm) return `Some possible — water's warm (${round(c.waterF)}°) but winds are light; usually easy to avoid.`;
  return `Low right now — water's still on the cool side (${round(c.waterF)}°).`;
}
function stargazeHTML(){
  const wx=DATA&&DATA.wx, H=wx&&wx.hourly; if(!H||!H.cloud_cover)return null;
  const buckets={};
  for(let i=0;i<H.time.length;i++){ const tms=H.time[i]*1000;
    if(tms<Date.now()-3600000)continue;
    const h=+new Intl.DateTimeFormat("en-US",{hour:"numeric",hour12:false,timeZone:TZ}).format(new Date(tms));
    if(h<21&&h>2)continue;                                   // only late-night hours
    const cc=H.cloud_cover[i]; if(cc==null)continue;
    const key=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,month:"2-digit",day:"2-digit"}).format(new Date(tms-(h<=2?86400000:0)));
    (buckets[key]=buckets[key]||{sum:0,n:0,tms}).sum+=cc; buckets[key].n++;
  }
  const nights=Object.values(buckets).map(v=>{ const cloud=v.sum/v.n, illum=moonPhase(new Date(v.tms)).illum;
    return {cloud,illum,tms:v.tms,score:cloud*0.6+illum*0.4}; });
  if(!nights.length)return null;
  const byTime=nights.slice().sort((a,b)=>a.tms-b.tms);
  nights.sort((a,b)=>a.score-b.score);
  const best=nights[0], dt=new Date(best.tms);
  const wd=new Intl.DateTimeFormat("en-US",{weekday:"long",timeZone:TZ}).format(dt);
  const tonight=byTime[0].tms===best.tms;
  const cloudTxt=best.cloud<25?"clear skies":best.cloud<55?"partly clear":"cloudy";
  const mp=moonPhase(new Date());
  return `Best window ahead: <b>${tonight?"tonight":wd}</b> — ${cloudTxt}, moon ${Math.round(best.illum)}% lit. Darkest skies around the new moon (${fmtMD(mdOf(mp.nextNew))}).`;
}
function renderNature(){
  const box=$("#nature"); if(!box||!COND)return; const c=COND, parts=[];
  const gh=goldenHourHTML(c); if(gh)parts.push(`<div class="detail"><b>🌅 Golden hour:</b> ${gh}</div>`);
  const sg=stargazeHTML(); if(sg)parts.push(`<div class="detail" style="margin-top:10px"><b>🔭 Stargazing:</b> ${sg}</div>`);
  const hc=horseshoeHTML(); if(hc)parts.push(`<div class="detail" style="margin-top:10px"><b>🦀 Horseshoe crabs:</b> ${hc}</div>`);
  const jf=jellyfishHTML(c); if(jf)parts.push(`<div class="detail" style="margin-top:10px"><b>🪼 Jellyfish:</b> ${jf}</div>`);
  parts.push(`<div class="detail" style="margin-top:10px"><b>🌿 In season now:</b><br>${wildlifeNow()}</div>`);
  parts.push(`<div class="detail" style="margin-top:10px;font-style:italic">Seasonal notes are general Long Island guidance — wildlife timing shifts year to year.</div>`);
  box.innerHTML=parts.join("");
}
function renderPollen(){
  const box=$("#pollen"); if(!box||!CFG.pollen)return; const spot=CFG.spots[ACTIVE];
  box.innerHTML='<span style="color:var(--muted)">Checking pollen…</span>';
  const url=CFG.pollen+(CFG.pollen.indexOf("?")>=0?"&":"?")+"lat="+spot.lat+"&lon="+spot.lon;
  getJSON(url).then(d=>{ const cur=$("#pollen"); if(!cur)return;
    if(!d||d.error||!d.types){cur.innerHTML='<span style="color:var(--muted)">Pollen data unavailable right now.</span>';return;}
    const line=d.types.map(t=>`${t.name}: <b>${t.category}</b>`).join(" · ");
    const plants=(d.plants&&d.plants.length)?`<div class="detail" style="margin-top:6px">Main culprits: ${d.plants.map(p=>p.name+" ("+String(p.category).toLowerCase()+")").join(", ")}.</div>`:"";
    cur.innerHTML=`<div class="detail"><b>🌾 Pollen today:</b> ${line}.</div>${plants}`+
      `<div class="detail" style="margin-top:8px;font-style:italic">Tree/grass/weed levels for this spot; updates about once a day.</div>`;
  }).catch(()=>{const cur=$("#pollen");if(cur)cur.innerHTML='<span style="color:var(--muted)">Pollen data unavailable right now.</span>';});
}
function renderTides(){
  const t=$("#tides"); const ev=DATA&&DATA.tideEvents;
  if(!ev||!ev.length){t.innerHTML="<span class='err'>Tide data unavailable.</span>";return;}
  const now=new Date(Date.now()-3600000);
  t.innerHTML=ev.filter(e=>e.t>now).slice(0,8).map(e=>{const cls=e.type==="H"?"hi":"lo",lab=e.type==="H"?"High":"Low";
    return `<div class="tide-item"><b class="${cls}">${lab}</b> ${fmtTime(e.t)} · ${round(e.v,1)} ft</div>`;}).join("");
}

function loadRadar(){
  const img=$("#radar"); if(!img)return; const st=CFG.radarStation||"KOKX";
  img.onerror=()=>{$("#radarcap").innerHTML='Radar unavailable here — <a href="https://radar.weather.gov" target="_blank" rel="noopener">open full radar ↗</a>';};
  img.onload=()=>{$("#radarcap").innerHTML='NWS '+st+' loop · <a href="https://radar.weather.gov" target="_blank" rel="noopener">full interactive radar ↗</a>';};
  img.src="https://radar.weather.gov/ridge/standard/"+st+"_loop.gif?_="+Date.now();
}

/* date helpers */
function ymdET(){const p=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const g=t=>p.find(x=>x.type===t).value;return g("year")+g("month")+g("day");}

/* boot */
function boot(){
  if(new URLSearchParams(location.search).get("eink")==="1")document.body.classList.add("eink");
  skeleton();
  selectSpot(0);
  setInterval(()=>{CFG.spots.forEach(s=>{s._ts=0;}); loadActive();},REFRESH_MS);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot); else boot();
// expose for testing
window.__engine={ACTS,deriveNow,fetchSpot,assessWQ};
})();
