import { selectAlerts } from "./rainbow-watch.mjs";
import { sunPos, rainbowStatus, formatAlert } from "./rainbow-logic.mjs";
import { dispatch } from "./senders.mjs";

let pass=0, fail=0;
const ok=(name,c)=>{ if(c){pass++;console.log("  ok  "+name);} else {fail++;console.log("  FAIL "+name);} };

const LAT=40.87, LON=-73.53; // Oyster Bay-ish

// Find an evening time today where the sun is low but up (0 < alt < 42)
function findLowSun(){
  const base=new Date();
  for(let m=0;m<24*60;m+=10){
    const t=new Date(base.getTime()+m*60000);
    const sp=sunPos(t,LAT,LON);
    if(sp.alt>3 && sp.alt<40) return t;
  }
  return null;
}
const now=findLowSun();
console.log("Chosen low-sun time:", now.toISOString(), "alt=", sunPos(now,LAT,LON).alt.toFixed(1));

const SHOWERS={isDay:true, code:80, recentRainIn:0.1};      // rb=good
const RECENT ={isDay:true, code:3,  recentRainIn:0.1};      // rb=fair (cloudy, rained recently)
const DRY    ={isDay:true, code:0,  recentRainIn:0};        // rb=none
const NIGHT  ={isDay:false,code:80, recentRainIn:0.1};      // rb=none (sun down)

// sanity on rainbowStatus itself
ok("showers+low sun => good", rainbowStatus(now,LAT,LON,SHOWERS).lv==="good");
ok("recent rain+low sun => fair", rainbowStatus(now,LAT,LON,RECENT).lv==="fair");
ok("dry => none", rainbowStatus(now,LAT,LON,DRY).lv==="none");
ok("night => none", rainbowStatus(now,LAT,LON,NIGHT).lv==="none");

// cloud-cover gate: a downpour is overcast — the sun's blocked, so NO rainbow alert
const POURING={isDay:true, code:65, recentRainIn:0.4, cloudCover:100};     // heavy rain, solid grey
const BREAKING={isDay:true, code:81, recentRainIn:0.15, cloudCover:50};    // shower + sun breaking through
const SHOWER_GREY={isDay:true, code:80, recentRainIn:0.1, cloudCover:78};  // shower but still mostly cloudy
ok("pouring/overcast => none", rainbowStatus(now,LAT,LON,POURING).lv==="none");
ok("shower + sky breaking => good", rainbowStatus(now,LAT,LON,BREAKING).lv==="good");
ok("shower but still grey => fair", rainbowStatus(now,LAT,LON,SHOWER_GREY).lv==="fair");
ok("missing cloud data keeps old behavior", rainbowStatus(now,LAT,LON,SHOWERS).lv==="good");

const key=`${LAT.toFixed(3)},${LON.toFixed(3)}`;
const opts={cooldownHours:2, quietStart:22, quietEnd:6, tz:"America/New_York"};

// Scenario 1: a "good" subscriber with no prior alert -> send
{
  const subs=[{id:"a",phone:"+15165550142",label:"Oyster Bay",lat:LAT,lon:LON,includeMaybe:false}];
  const cond=new Map([[key,SHOWERS]]);
  const {toSend,skipped}=selectAlerts(subs,cond,{lastAlert:{}},now,opts);
  ok("good subscriber is queued", toSend.length===1 && toSend[0].sub.id==="a");
  const smsBody=formatAlert(toSend[0].sub.label, toSend[0].rb, "sms").body;
  ok("message names the spot & a direction", /Oyster Bay/.test(smsBody) && /Look [NSEW]/.test(smsBody));
}

// Scenario 2: "maybe" day, subscriber did NOT opt into maybes -> skip
{
  const subs=[{id:"b",phone:"+1516",label:"X",lat:LAT,lon:LON,includeMaybe:false}];
  const {toSend,skipped}=selectAlerts(subs,new Map([[key,RECENT]]),{lastAlert:{}},now,opts);
  ok("maybe-day skipped when not opted in", toSend.length===0 && skipped[0].reason==="rb=fair");
}

// Scenario 3: "maybe" day, subscriber opted into maybes -> send
{
  const subs=[{id:"c",phone:"+1516",label:"X",lat:LAT,lon:LON,includeMaybe:true}];
  const {toSend}=selectAlerts(subs,new Map([[key,RECENT]]),{lastAlert:{}},now,opts);
  ok("maybe-day sent when opted in", toSend.length===1);
}

// Scenario 4: cooldown -> skip
{
  const subs=[{id:"d",phone:"+1516",label:"X",lat:LAT,lon:LON,includeMaybe:false}];
  const recent=new Date(now.getTime()-30*60000).toISOString(); // 30 min ago < 2h cooldown
  const {toSend,skipped}=selectAlerts(subs,new Map([[key,SHOWERS]]),{lastAlert:{d:recent}},now,opts);
  ok("within cooldown skipped", toSend.length===0 && skipped[0].reason==="cooldown");
}

// Scenario 5: cooldown expired -> send
{
  const subs=[{id:"e",phone:"+1516",label:"X",lat:LAT,lon:LON,includeMaybe:false}];
  const old=new Date(now.getTime()-3*3600*1000).toISOString(); // 3h ago > 2h
  const {toSend}=selectAlerts(subs,new Map([[key,SHOWERS]]),{lastAlert:{e:old}},now,opts);
  ok("after cooldown sent again", toSend.length===1);
}

// Scenario 6: quiet hours -> skip (force quiet window covering 'now')
{
  const h=+new Intl.DateTimeFormat("en-US",{hour:"numeric",hour12:false,timeZone:"America/New_York"}).format(now);
  const q={...opts, quietStart:h, quietEnd:(h+1)%24}; // 1-hour quiet window over now
  const subs=[{id:"f",phone:"+1516",label:"X",lat:LAT,lon:LON,includeMaybe:false}];
  const {toSend,skipped}=selectAlerts(subs,new Map([[key,SHOWERS]]),{lastAlert:{}},now,q);
  ok("quiet hours skipped", toSend.length===0 && skipped[0].reason==="quiet hours");
}

// Scenario 7: inactive subscriber -> skip
{
  const subs=[{id:"g",phone:"+1516",label:"X",lat:LAT,lon:LON,active:false}];
  const {toSend,skipped}=selectAlerts(subs,new Map([[key,SHOWERS]]),{lastAlert:{}},now,opts);
  ok("inactive skipped", toSend.length===0 && skipped[0].reason==="inactive");
}

// ---- channel-aware formatting ----
const RBGOOD={ lv:"good", label:"Likely", look:"ESE" };
{
  const sms=formatAlert("Oyster Bay", RBGOOD, "sms");
  const email=formatAlert("Oyster Bay", RBGOOD, "email");
  const push=formatAlert("Oyster Bay", RBGOOD, "push");
  const tg=formatAlert("Oyster Bay", RBGOOD, "telegram");
  ok("sms body ends with STOP", /Reply STOP to end\.$/.test(sms.body));
  ok("email has a subject + unsubscribe", /Rainbow likely/.test(email.subject) && /unsubscribe/i.test(email.body));
  ok("push has a title", /Rainbow likely/.test(push.title));
  ok("telegram body mentions /stop", /\/stop/.test(tg.body));
  ok("all channels name the spot & direction", [sms,email,push,tg].every(p=>/Oyster Bay/.test(p.body) && /ESE/.test(p.body)));
}

// ---- dispatch routing (SMS + Telegram via mock fetch; email guard) ----
{
  const parts=formatAlert("Oyster Bay", RBGOOD, "sms");

  // SMS → Twilio
  let smsCall=null;
  const smsFetch=async(url,opt)=>{ smsCall={url,opt}; return { ok:true, json:async()=>({sid:"SM123"}) }; };
  const smsCfg={ twilio:{ sid:"AC1", token:"t", from:"+18557105264" } };
  const smsRes=await dispatch({channel:"sms",phone:"+15165550142"}, parts, smsCfg, smsFetch);
  ok("dispatch sms hits Twilio", /api\.twilio\.com/.test(smsCall.url) && smsRes==="sms:SM123");
  ok("dispatch sms uses the From number", /From=%2B18557105264/.test(smsCall.opt.body.toString()));

  // Telegram → Bot API
  let tgCall=null;
  const tgFetch=async(url,opt)=>{ tgCall={url,opt}; return { ok:true, json:async()=>({ok:true,result:{message_id:9}}) }; };
  const tgCfg={ telegramToken:"BOT:TOKEN" };
  const tgParts=formatAlert("Oyster Bay", RBGOOD, "telegram");
  const tgRes=await dispatch({channel:"telegram",telegram:"555"}, tgParts, tgCfg, tgFetch);
  ok("dispatch telegram hits Bot API", /api\.telegram\.org\/botBOT:TOKEN\/sendMessage/.test(tgCall.url) && tgRes==="tg:9");
  ok("dispatch telegram sends the right chat id", JSON.parse(tgCall.opt.body).chat_id==="555");

  // Email with no SMTP config → clear error, not a crash
  let emailErr="";
  try { await dispatch({channel:"email",email:"a@b.com"}, formatAlert("X",RBGOOD,"email"), {}, async()=>({})); }
  catch(e){ emailErr=e.message; }
  ok("dispatch email without config errors clearly", /email not configured/.test(emailErr));

  // Unknown channel → error
  let unkErr="";
  try { await dispatch({channel:"carrier-pigeon"}, parts, {}, async()=>({})); }
  catch(e){ unkErr=e.message; }
  ok("unknown channel errors", /unknown channel/.test(unkErr));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
