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
function uvSpf(u){ if(u==null)return""; if(u<3)return"Minimal — sunscreen optional"; if(u<6)return"SPF 30, hat"; if(u<8)return"SPF 30+, reapply every 2h"; if(u<11)return"SPF 50, shade midday"; return"SPF 50+, avoid midday sun"; }
function aqiCat(a){ if(a==null)return""; if(a<=50)return"Good"; if(a<=100)return"Moderate"; if(a<=150)return"Unhealthy (sensitive)"; if(a<=200)return"Unhealthy"; if(a<=300)return"Very unhealthy"; return"Hazardous"; }

/* ============================================================
   Activity scoring — each returns {lv, why}
   ============================================================ */
function lvFromRank(r){return ["good","fair","poor","storm"][Math.min(r,3)];}
const ACTS=[
 {key:"swim",label:"Swim",ico:"🏊",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — out of the water."};
    if(c.wq&&c.wq.lv==="poor")return{lv:"poor",why:"Water-quality caution after recent rain (see below)."};
    let r=0, w=[];
    if(c.waterF!=null){ if(c.waterF<T.swimCold){r=Math.max(r,2);w.push("cold water "+round(c.waterF)+"°");}
      else if(c.waterF<T.swimOK){r=Math.max(r,1);w.push("brisk "+round(c.waterF)+"°");}
      else w.push("water "+round(c.waterF)+"°");}
    if(c.waveFt!=null){ if(c.waveFt>T.swimWavePoor){r=Math.max(r,2);w.push("big surf "+round(c.waveFt,1)+"ft");}
      else if(c.waveFt>T.swimWaveFair){r=Math.max(r,1);w.push("chop "+round(c.waveFt,1)+"ft");}}
    if(c.wq&&c.wq.lv==="fair"){r=Math.max(r,1);w.push("some runoff risk");}
    if(c.uv!=null&&c.uv>=T.uvVery)w.push("UV "+round(c.uv)+" — sunscreen");
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

 {key:"sup",label:"Paddleboard",ico:"🏄‍♀️",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — no."};
    let r=0,w=[];
    if(c.windMph>T.paddleWindPoor||c.gustMph>T.paddleGustPoor){r=2;w.push("too windy for SUP "+round(c.windMph)+" g"+round(c.gustMph));}
    else if(c.windMph>T.paddleWindGood||c.gustMph>T.paddleGustGood){r=1;w.push("getting breezy "+round(c.windMph)+" mph");}
    else w.push("calm & glassy "+round(c.windMph)+" mph");
    if(c.waveFt!=null&&c.waveFt>2){r=Math.max(r,1);w.push("bumpy "+round(c.waveFt,1)+"ft");}
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

 {key:"beachday",label:"Beach / sunbathe",ico:"🏖️",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms."};
    let r=0,w=[];
    if(c.precipProb!=null&&c.precipProb>50){r=2;w.push("rain "+round(c.precipProb)+"%");}
    else if(c.precipProb!=null&&c.precipProb>30){r=1;w.push("some clouds/rain risk");}
    if(c.airF!=null){ if(c.airF<58){r=Math.max(r,2);w.push("cool "+round(c.airF)+"°");}
      else if(c.airF<70){r=Math.max(r,1);w.push(round(c.airF)+"°");} else w.push("warm "+round(c.airF)+"°");}
    if(c.uv!=null&&c.uv>=T.uvVery)w.push("UV "+round(c.uv)+" — "+uvSpf(c.uv));
    return{lv:lvFromRank(r),why:w.join(", ")};}},

 {key:"kite",label:"Fly a kite",ico:"🪁",needs:s=>true,score:(c)=>{
    if(isStorm(c.code))return{lv:"storm",why:"Thunderstorms — no kites."};
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
    return{lv:lvFromRank(r),why:w.join(", ")};}}
];

/* ============================================================
   Fetching + deriving conditions for one spot
   ============================================================ */
async function fetchSpot(spot){
  const {lat,lon}=spot;
  const wxU="https://api.open-meteo.com/v1/forecast?latitude="+lat+"&longitude="+lon+
    "&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,uv_index"+
    "&minutely_15=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code"+
    "&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,uv_index"+
    "&daily=sunrise,sunset,uv_index_max,precipitation_sum&timeformat=unixtime&past_days=1&forecast_days=2"+
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone="+encodeURIComponent(TZ);
  const aqU="https://air-quality-api.open-meteo.com/v1/air-quality?latitude="+lat+"&longitude="+lon+
    "&current=us_aqi&timezone="+encodeURIComponent(TZ);
  const marU=spot.marine?("https://marine-api.open-meteo.com/v1/marine?latitude="+lat+"&longitude="+lon+
    "&current=wave_height,wave_period,sea_surface_temperature&hourly=wave_height&length_unit=imperial&timeformat=unixtime&timezone="+encodeURIComponent(TZ)):null;

  const [wx,aq,mar]=await Promise.all([
    getJSON(wxU).catch(e=>{fails.push("Weather: "+e.message);return null;}),
    getJSON(aqU).catch(e=>{fails.push("Air quality: "+e.message);return null;}),
    marU?getJSON(marU).catch(e=>{fails.push("Marine: "+e.message);return null;}):Promise.resolve(null)
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
  return {wx,aq,mar,waterF,waterSrc,waterEst,tide,tideEvents};
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
    isDay:sr&&ss?(now>=sr&&now<=ss):true, tide:data.tide
  };
  // water-quality assessment (rain runoff based)
  cond.wq=assessWQ(cond,spot);
  return cond;
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
  if(CFG.spots&&CFG.spots.length>1){ const st=el("div","spottabs"); st.id="spottabs"; w.appendChild(st); }
  w.appendChild(el("div","spotnote")).id="spotnote";
  w.appendChild(el("div","summary lv-good")).id="summary";
  w.appendChild(el("div","diag")).id="diag";
  w.appendChild(el("h2",null,"Good for right now"));
  w.appendChild(el("div","acts")).id="acts";
  w.appendChild(el("h2",null,"The numbers"));
  w.appendChild(el("div","grid")).id="grid";
  w.appendChild(el("h2",null,"Through the day"));
  w.appendChild(el("p","h2note","Blocks are colored by how good conditions are — watch which way the colors trend."));
  const tg=el("div","toggle"); tg.id="toggle";
  tg.innerHTML='<button data-mode="hourly" class="on">Rest of today · hourly</button><button data-mode="q15">Next 3 hrs · 15 min</button>';
  w.appendChild(tg);
  w.appendChild(el("div","strip")).id="strip";
  w.appendChild(el("div","legend",'<span><i style="background:var(--good)"></i>Good</span><span><i style="background:var(--fair)"></i>Fair</span><span><i style="background:var(--poor)"></i>Rough</span><span><i style="background:var(--storm)"></i>Storms</span>'));
  if(CFG.ferry){ w.appendChild(el("h2",null,"Ferries to Bay Shore")); const fe=el("div"); fe.id="ferry"; w.appendChild(fe); }
  w.appendChild(el("h2",null,"Water quality"));
  w.appendChild(el("div","wq")).id="wq";
  if(CFG.fishing){ w.appendChild(el("h2",null,"What's biting now — seasonal fishing")); const f=el("div","wq"); f.id="fishing"; w.appendChild(f); }
  if(CFG.shellfish){ w.appendChild(el("h2",null,"Shellfish safety")); const sh=el("div","wq"); sh.id="shellfish"; w.appendChild(sh); }
  w.appendChild(el("h2",null,"Doppler radar"));
  w.appendChild(el("p","h2note","NWS "+(CFG.radarStation||"KOKX")+" loop — your area is near the center."));
  const rad=el("div","radar"); rad.innerHTML='<img id="radar" alt="radar loop"><div class="cap" id="radarcap">Loading radar…</div>';
  w.appendChild(rad);
  w.appendChild(el("h2",null,"Tides"));
  w.appendChild(el("div","tides")).id="tides";
  w.appendChild(el("div","note",(CFG.footNote||"")+
    "<br><br>Activity ratings are automated guidance from weather &amp; marine models to help you plan — not a substitute for lifeguards, posted flags, official advisories, or your own judgment on the day."));
  w.appendChild(el("footer",null,sourcesHtml()));
  app.appendChild(w);
  // toggle handler
  $("#toggle").addEventListener("click",e=>{const b=e.target.closest("button"); if(!b)return;
    [...$("#toggle").children].forEach(x=>x.classList.remove("on")); b.classList.add("on"); renderStrip(b.dataset.mode);});
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
  if(!spot._data || now-spot._ts>REFRESH_MS){ spot._data=await fetchSpot(spot); spot._ts=now; }
  DATA=spot._data; COND=deriveNow(DATA,spot);
  renderSummary(); renderCards(); renderActs(); renderStrip(currentMode()); renderWQ();
  if(CFG.ferry)renderFerry();
  if(CFG.fishing)renderFishing(); if(CFG.shellfish)renderShellfish();
  renderTides(); loadRadar();
  const diag=$("#diag");
  if(fails.length){diag.style.display="block";
    diag.innerHTML="<b>Some live data didn't load.</b> If you're viewing this in a preview pane, that's expected — external data is blocked there and it works once hosted or opened directly in a browser. Details: "+[...new Set(fails)].join("; ")+".";}
  else diag.style.display="none";
  $("#updated").innerHTML='<span class="dot"></span>Updated '+fmtTime(new Date());
}
function currentMode(){const on=$("#toggle")&&$("#toggle").querySelector(".on");return on?on.dataset.mode:"hourly";}

function renderSummary(){
  const s=$("#summary");
  if(!COND){s.className="summary lv-poor";s.innerHTML='<div class="headline">Conditions unavailable right now.</div>';return;}
  const spot=CFG.spots[ACTIVE];
  const acts=ACTS.filter(a=>a.needs(spot)).map(a=>a.score(COND,spot));
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

function renderCards(){
  const g=$("#grid"); if(!COND){g.innerHTML="<span class='err'>Unavailable.</span>";return;}
  const cards=[];
  const card=(lbl,val,meta,est)=>`<div class="card">${est?'<span class="est">'+est+'</span>':''}<div class="lbl">${lbl}</div><div class="val">${val}</div>${meta?'<div class="meta">'+meta+'</div>':''}</div>`;
  cards.push(card("Water temp",COND.waterF!=null?round(COND.waterF)+"<small>°F</small>":"—",DATA.waterSrc||"",DATA.waterEst?"est":""));
  cards.push(card("Air temp",round(COND.airF)+"<small>°F</small>","Feels "+round(COND.feelsF)+"° · "+(WMO[COND.code]||"")));
  const dir=compass(COND.windDir);
  cards.push(card("Wind",round(COND.windMph)+"<small> mph "+dir+"</small>","Gusts "+round(COND.gustMph)+" mph"));
  if(COND.waveFt!=null)cards.push(card("Waves",round(COND.waveFt,1)+"<small> ft</small>",(COND.wavePeriod!=null?round(COND.wavePeriod)+"s swell":"")||"open-water est","est"));
  cards.push(card("UV index",COND.uv!=null?round(COND.uv)+"<small> "+uvCat(COND.uv)+"</small>":"—",COND.uv!=null?uvSpf(COND.uv):""));
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
  const spot=CFG.spots[ACTIVE];
  const list=(CFG.activities&&CFG.activities.length?ACTS.filter(x=>CFG.activities.includes(x.key)):ACTS).filter(x=>x.needs(spot));
  a.innerHTML=list.map(act=>{const r=act.score(COND,spot);const lab={good:"Good",fair:"Fair",poor:"Poor",storm:"No"}[r.lv];
    return `<div class="act ${r.lv}"><div class="top"><div class="name"><span class="ico">${act.ico}</span>${act.label}</div>`+
      `<div class="rate">${lab}</div></div><div class="why">${r.why}</div></div>`;}).join("");
}

function renderStrip(mode){
  const strip=$("#strip"); const wx=DATA&&DATA.wx; if(!wx){strip.innerHTML="<div class='err' style='padding:8px'>Forecast unavailable.</div>";return;}
  const src=mode==="q15"&&wx.minutely_15?wx.minutely_15:wx.hourly;
  const now=Date.now(); let s=src.time.findIndex(t=>t*1000>=now); if(s<0)s=0;
  const H=wx.hourly;
  function popAt(ts){if(!H.precipitation_probability)return null;let idx=0;for(let i=0;i<H.time.length;i++){if(H.time[i]<=ts)idx=i;else break;}return H.precipitation_probability[idx];}
  let html="";
  for(let i=s;i<s+12&&i<src.time.length;i++){
    const ts=src.time[i],d=new Date(ts*1000);const w=src.wind_speed_10m[i],g=src.wind_gusts_10m[i],code=src.weather_code?src.weather_code[i]:0;
    // color by simple wind/gust/storm rowability
    let lv="good"; if(isStorm(code))lv="storm"; else if(w>16||g>23)lv="poor"; else if(w>10||g>17)lv="fair";
    const pop=popAt(ts);
    html+=`<div class="hour ${lv}"><div class="t">${mode==="q15"?fmtHM(d):fmtHour(d)}</div>`+
      `<div class="temp">${round(src.temperature_2m[i])}°</div>`+
      `<div class="wind">${round(w)} <span style="color:var(--muted);font-weight:400">${compass(src.wind_direction_10m?src.wind_direction_10m[i]:null)}</span></div>`+
      `<div class="gust">gust ${round(g)}</div>`+
      (pop!=null&&!isNaN(pop)?`<div class="rain">☔ ${round(pop)}%</div>`:``)+`</div>`;
  }
  strip.innerHTML=html||"<div class='err' style='padding:8px'>Forecast unavailable.</div>";
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
  const mapHtml=S.mapEmbed?`<iframe title="DEC shellfish closures map" loading="lazy" src="${S.mapEmbed}${S.mapEmbed.indexOf('?')>=0?'&':'?'}center=${sp.lon},${sp.lat}&level=13" style="width:100%;height:430px;border:1px solid var(--line);border-radius:12px;margin-top:10px"></iframe>`:"";
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
