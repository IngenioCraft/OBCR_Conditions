/* ============================================================
   Rainbow Alerts — Telegram bot Worker (Cloudflare)
   Self-service signup for the Telegram channel. Friends open the bot, tap /start,
   pick a spot from buttons, and they're registered in subscribers.json (channel:"telegram").
   /stop turns their alerts off.

   Deploy on Cloudflare Workers, then point Telegram's webhook at it:
     https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<this-worker-url>/<WEBHOOK_SECRET>

   Set (Settings → Variables):
     TELEGRAM_BOT_TOKEN (secret)  from @BotFather
     WEBHOOK_SECRET     (secret)  any random string; must match the path in setWebhook
     GH_TOKEN           (secret)  fine-grained token, Contents R/W on the private repo
     GH_OWNER / GH_REPO / GH_PATH (vars)  same as the signup Worker
   ============================================================ */

const SPOTS = [
  { label: "Oyster Bay", lat: 40.8757, lon: -73.5326 },
  { label: "Ocean Beach", lat: 40.6435, lon: -73.1548 },
  { label: "Asharoken", lat: 40.9085, lon: -73.3490 },
  { label: "Montauk", lat: 41.0590, lon: -71.9545 },
  { label: "Southold", lat: 41.0640, lon: -72.4265 },
  { label: "Jones Inlet", lat: 40.5875, lon: -73.5677 },
  { label: "Jones Beach", lat: 40.5920, lon: -73.5100 },
  { label: "Robert Moses", lat: 40.6200, lon: -73.2600 },
  { label: "Sore Thumb", lat: 40.6270, lon: -73.3080 },
  { label: "Nissequogue River", lat: 40.8850, lon: -73.2250 },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // require the secret path so randoms can't drive the bot
    if (url.pathname.replace(/^\//, "") !== (env.WEBHOOK_SECRET || "")) {
      return new Response("not found", { status: 404 });
    }
    if (request.method !== "POST") return new Response("ok");

    let update;
    try { update = await request.json(); } catch { return new Response("ok"); }

    try {
      if (update.message && update.message.text) {
        await onMessage(env, update.message);
      } else if (update.callback_query) {
        await onCallback(env, update.callback_query);
      }
    } catch (e) {
      // never 500 back to Telegram — it would just retry the same update
      console.log("bot error:", e && e.message);
    }
    return new Response("ok");
  },
};

async function onMessage(env, msg) {
  const chatId = msg.chat.id;
  const raw = (msg.text || "").trim();
  const text = raw.toLowerCase();
  if (text.startsWith("/stop")) {
    const n = await deactivate(env, chatId);
    return tg(env, "sendMessage", { chat_id: chatId,
      text: n ? "🌈 Done — you won't get any more Rainbow Alerts. Send /start to sign up again." : "You weren't subscribed. Send /start to sign up." });
  }
  // a bare 5-digit US zip → look it up and subscribe to that town
  if (/^\d{5}$/.test(raw)) {
    const spot = await geocodeZip(raw);
    if (!spot) return tg(env, "sendMessage", { chat_id: chatId, text: "Couldn't find that zip — double-check the 5 digits." });
    const added = await addSubscriber(env, chatId, spot);
    return tg(env, "sendMessage", { chat_id: chatId,
      text: added ? `🌈 You're set for ${spot.label}. I'll message you when a rainbow is likely. Send /stop anytime.`
                  : `You're already subscribed to ${spot.label}.` });
  }
  if (text.startsWith("/start") || text.startsWith("/help")) {
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🌈 Rainbow Alerts — pick a spot below, or just send me a US zip code for anywhere else. I'll message you when a rainbow is likely there.",
      reply_markup: { inline_keyboard: SPOTS.map((s, i) => [{ text: s.label, callback_data: "spot:" + i }]) },
    });
  }
  return tg(env, "sendMessage", { chat_id: chatId, text: "Send /start to choose a spot, send a 5-digit US zip code, or /stop to turn alerts off." });
}

async function geocodeZip(zip) {
  try {
    const r = await fetch("https://api.zippopotam.us/us/" + zip);
    if (!r.ok) return null;
    const j = await r.json();
    const p = j.places && j.places[0];
    if (!p) return null;
    return { label: `${p["place name"]}, ${p["state abbreviation"]} ${zip}`, lat: +p.latitude, lon: +p.longitude };
  } catch (e) { return null; }
}

async function onCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || "";
  const m = data.match(/^spot:(\d+)$/);
  if (!chatId || !m) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  const spot = SPOTS[+m[1]];
  if (!spot) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Unknown spot" });

  const added = await addSubscriber(env, chatId, spot);
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: added ? "Subscribed ✓" : "Already subscribed" });
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: added
      ? `🌈 You're set for ${spot.label}. I'll message you when a rainbow is likely. Send /stop anytime to turn these off.`
      : `You're already subscribed to ${spot.label}. Send /start to add another spot, or /stop to turn alerts off.`,
  });
}

/* ---------- Telegram API ---------- */
async function tg(env, method, payload) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
}

/* ---------- subscriber store (GitHub) ---------- */
async function readStore(env) {
  const api = ghApi(env);
  const r = await fetch(api, { headers: ghHeaders(env) });
  if (r.status === 404) return { list: [], sha: undefined };
  if (!r.ok) throw new Error("store read " + r.status);
  const meta = await r.json();
  let list = [];
  try { list = JSON.parse(b64decode(meta.content)); } catch { list = []; }
  return { list: Array.isArray(list) ? list : [], sha: meta.sha };
}
async function writeStore(env, list, sha, message) {
  const r = await fetch(ghApi(env), {
    method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: b64encode(JSON.stringify(list, null, 2) + "\n"), sha }),
  });
  if (!r.ok) throw new Error("store write " + r.status);
}
async function addSubscriber(env, chatId, spot) {
  const { list, sha } = await readStore(env);
  const id = spot.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-tg-" + chatId;
  if (list.some((s) => s.id === id && s.active !== false)) return false;
  const idx = list.findIndex((s) => s.id === id);
  const row = {
    id, channel: "telegram", telegram: String(chatId),
    label: spot.label, lat: spot.lat, lon: spot.lon,
    includeMaybe: false, active: true, added: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = row; else list.push(row);
  await writeStore(env, list, sha, `telegram signup: ${spot.label}`);
  return true;
}
async function deactivate(env, chatId) {
  const { list, sha } = await readStore(env);
  let n = 0;
  for (const s of list) {
    if (s.channel === "telegram" && String(s.telegram) === String(chatId) && s.active !== false) { s.active = false; n++; }
  }
  if (n) await writeStore(env, list, sha, `telegram /stop: ${chatId}`);
  return n;
}

/* ---------- helpers ---------- */
const ghApi = (env) => `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${env.GH_PATH}`;
const ghHeaders = (env) => ({ "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "rainbow-telegram-bot" });
function b64encode(str) { const b = new TextEncoder().encode(str); let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s); }
function b64decode(x) { const bin = atob(String(x).replace(/\n/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }
