/* ============================================================
   Rainbow Alerts — signup Worker (Cloudflare)
   Receives a signup POST from the form on your site and appends the
   subscriber to alerts/subscribers.json in your PRIVATE GitHub repo.

   Deploy on Cloudflare Workers. Set these (Settings → Variables):
     GH_TOKEN   (secret)  a fine-grained GitHub token with
                          "Contents: Read and write" on Rainbow_Numbers_Private
     GH_OWNER   (var)     IngenioCraft
     GH_REPO    (var)     Rainbow_Numbers_Private
     GH_PATH    (var)     alerts/subscribers.json
     ALLOW_ORIGIN (var)   https://prey.tel   (the site allowed to POST here)
   Optional welcome messages (only used if present):
     TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / (TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID)  → SMS welcome
     TELEGRAM_BOT_TOKEN                                                                      → Telegram welcome

   The form posts JSON per channel:
     { channel:"email",    email:"a@b.com",     includeMaybe, targets:[{label,lat,lon}] }
     { channel:"sms",      phone:"+1...",       includeMaybe, targets:[...] }
     { channel:"push",     push:{endpoint,keys},includeMaybe, targets:[...] }
     { channel:"telegram", telegram:"chatid",   includeMaybe, targets:[...] }  (usually set by the bot, not here)
   ============================================================ */

const MAX_TARGETS = 6;
const CHANNELS = ["email", "sms", "push", "telegram"];

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return json({ ok: true, service: "rainbow-signup" }, 200, cors);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Bad JSON" }, 400, cors); }

    // --- channel + contact validation ---
    const channel = CHANNELS.includes(body.channel) ? body.channel : "email";
    let contact, contactKey, contactFields;
    if (channel === "email") {
      contact = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return json({ error: "Invalid email" }, 400, cors);
      contactKey = contact; contactFields = { email: contact };
    } else if (channel === "sms") {
      contact = normPhone(body.phone);
      if (!contact) return json({ error: "Invalid phone number" }, 400, cors);
      contactKey = contact; contactFields = { phone: contact };
    } else if (channel === "push") {
      const sub = body.push;
      if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return json({ error: "Invalid push subscription" }, 400, cors);
      contact = sub.endpoint; contactKey = sub.endpoint.slice(0, 120);
      contactFields = { push: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } };
    } else { // telegram
      contact = String(body.telegram || "").replace(/\D/g, "");
      if (!contact) return json({ error: "Invalid telegram id" }, 400, cors);
      contactKey = contact; contactFields = { telegram: contact };
    }

    const includeMaybe = body.includeMaybe === true;
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS) : [];
    const clean = [];
    for (const t of targets) {
      const lat = Number(t.lat), lon = Number(t.lon);
      const label = String(t.label || "").trim().slice(0, 60);
      if (!label || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      clean.push({ label, lat: round4(lat), lon: round4(lon) });
    }
    if (!clean.length) return json({ error: "No valid spots" }, 400, cors);

    // --- read current subscribers.json from GitHub ---
    const api = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${env.GH_PATH}`;
    const ghHeaders = {
      "Authorization": `Bearer ${env.GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "rainbow-signup-worker",
    };

    let list = [], sha = undefined;
    const getRes = await fetch(api, { headers: ghHeaders });
    if (getRes.status === 200) {
      const meta = await getRes.json();
      sha = meta.sha;
      try { list = JSON.parse(b64decode(meta.content)); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
    } else if (getRes.status !== 404) {
      return json({ error: "Store read failed", status: getRes.status }, 502, cors);
    }

    // --- append (dedupe by channel + contact + label) ---
    const existing = new Set(list.map((s) => `${s.channel || "sms"}|${contactKeyOf(s)}|${s.label}`));
    let added = 0;
    const addedLabels = [];
    for (const t of clean) {
      const key = `${channel}|${contactKey}|${t.label}`;
      if (existing.has(key)) continue;
      existing.add(key);
      list.push({
        id: slug(channel, contactKey, t.label),
        channel, ...contactFields,
        label: t.label, lat: t.lat, lon: t.lon,
        includeMaybe, active: true,
        added: new Date().toISOString(),
      });
      added++;
      addedLabels.push(t.label);
    }

    if (added === 0) return json({ ok: true, added: 0, note: "Already subscribed to those spots." }, 200, cors);

    // --- write back ---
    const put = await fetch(api, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `signup: ${channel} (+${added} spot${added > 1 ? "s" : ""})`,
        content: b64encode(JSON.stringify(list, null, 2) + "\n"),
        sha,
      }),
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => "");
      return json({ error: "Store write failed", status: put.status, detail: detail.slice(0, 200) }, 502, cors);
    }

    // --- welcome (only for channels the Worker can reach directly: SMS, Telegram) ---
    let welcome = "skipped";
    const spots = addedLabels.join(", ");
    try {
      if (channel === "sms" && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)) {
        await twilioSend(env, contact, `\u{1F308} You're subscribed to Rainbow Alerts for ${spots}. We'll text you when a rainbow is likely. Reply STOP to opt out.`);
        welcome = "sent";
      } else if (channel === "telegram" && env.TELEGRAM_BOT_TOKEN) {
        await telegramSend(env, contact, `\u{1F308} You're subscribed to Rainbow Alerts for ${spots}. Send /stop anytime to turn these off.`);
        welcome = "sent";
      }
    } catch (e) { welcome = "failed: " + e.message; }

    return json({ ok: true, added, channel, welcome }, 200, cors);
  },
};

async function twilioSend(env, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({ To: to, Body: body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", env.TWILIO_FROM);
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`Twilio ${r.status}: ${j.message || "send failed"}`); }
}

async function telegramSend(env, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`Telegram ${r.status}`);
}

/* ---------- helpers ---------- */
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}
function contactKeyOf(s) {
  const ch = s.channel || "sms";
  if (ch === "email") return String(s.email || "").toLowerCase();
  if (ch === "sms") return s.phone || "";
  if (ch === "telegram") return String(s.telegram || "");
  if (ch === "push") return (s.push && s.push.endpoint) ? s.push.endpoint.slice(0, 120) : "";
  return "";
}
function normPhone(v) {
  if (!v) return null;
  let d = String(v).replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null; // US numbers only
}
function slug(channel, contactKey, label) {
  const tail = String(contactKey).replace(/[^a-z0-9]/gi, "").slice(-6) || "x";
  return (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + channel + "-" + tail);
}
const round4 = (n) => Math.round(n * 1e4) / 1e4;
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
