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

   RATE LIMITING + EMAIL OWNERSHIP VERIFICATION (recommended — both need one KV binding):
     1. Storage & Databases → KV → create a namespace (e.g. "signup-kv").
     2. Worker → Settings → Bindings → add KV binding named  SIGNUP_KV  → that namespace.
     Without this binding, rate limiting and the email-confirm flow are both skipped (requests
     pass straight through — same as before this feature existed), so it's safe to deploy first
     and provision the KV namespace separately.

     Email ownership verification (magic link): a plain signup POST for channel:"email" no longer
     writes to the subscriber store directly — it stores a short-lived pending record in SIGNUP_KV
     and emails a confirm link. Clicking it hits this same Worker at GET /confirm?token=... which
     does the actual write. SMS/push/Telegram are unchanged (Telegram is already self-verifying —
     you have to message the bot from the account itself; SMS/push ownership verification would need
     its own OTP/subscription-proof flow, not implemented here).
       MAIL_FROM        (var)     "Rainbow Alerts <alerts@yourdomain>" — must be a domain you've
                                   verified with your email provider
       RESEND_API_KEY   (secret)  a free API key from resend.com (or swap sendConfirmEmail() below
                                   for any other HTTP email API — it's the one place that's called)

   The form posts JSON per channel:
     { channel:"email",    email:"a@b.com",     includeMaybe, targets:[{label,lat,lon}] }
     { channel:"sms",      phone:"+1...",       includeMaybe, targets:[...] }
     { channel:"push",     push:{endpoint,keys},includeMaybe, targets:[...] }
     { channel:"telegram", telegram:"chatid",   includeMaybe, targets:[...] }  (usually set by the bot, not here)
   ============================================================ */

const MAX_TARGETS = 6;
const MAX_SUBS_PER_CONTACT = 12; // across all spots/time — bounds unbounded growth from one contact
const CHANNELS = ["email", "sms", "push", "telegram"];
const RATE_LIMIT_WINDOW_SEC = 300;  // 5 minutes
const RATE_LIMIT_MAX = 5;           // signup POSTs per IP per window
const PENDING_TTL_SEC = 3600;       // how long an email confirm link stays valid

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/confirm" && request.method === "GET") return handleConfirm(url, env);
    if (request.method === "GET") return json({ ok: true, service: "rainbow-signup" }, 200, cors);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    // --- flood-level rate limit (per client IP). Skipped entirely if SIGNUP_KV isn't bound yet. ---
    if (env.SIGNUP_KV) {
      const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
      const limited = await rateLimited(env, "rl:" + ip);
      if (limited) return json({ error: "Too many signup attempts — please try again in a few minutes." }, 429, cors);
    }

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
      contact = sub.endpoint; contactKey = sub.endpoint; // full endpoint — never truncate the dedupe key
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

    // --- email: verify ownership via a confirm link instead of writing immediately ---
    if (channel === "email") {
      if (!env.SIGNUP_KV) {
        return json({ error: "Email signup needs the SIGNUP_KV binding — see the Worker's header comment." }, 502, cors);
      }
      if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
        return json({ error: "Email sending isn't configured yet (RESEND_API_KEY / MAIL_FROM) — see the Worker's header comment." }, 502, cors);
      }
      const token = crypto.randomUUID().replace(/-/g, "");
      await env.SIGNUP_KV.put("pending:" + token, JSON.stringify({ channel, contactKey, contactFields, clean, includeMaybe, contact }), { expirationTtl: PENDING_TTL_SEC });
      const confirmUrl = url.origin + "/confirm?token=" + token;
      try {
        await sendConfirmEmail(env, contact, confirmUrl, clean.map((t) => t.label).join(", "));
      } catch (e) {
        return json({ error: "Could not send confirmation email", detail: e.message }, 502, cors);
      }
      return json({ ok: true, pending: true, channel, note: "Check your email for a confirm link — it expires in an hour." }, 200, cors);
    }

    // --- sms / push / telegram: unchanged, immediate write (no ownership-verification flow yet) ---
    try {
      const result = await commitSignup(env, channel, contactKey, contactFields, clean, includeMaybe);
      if (result.added === 0 && result.reactivated === 0) {
        const capped = result.contactTotal >= MAX_SUBS_PER_CONTACT;
        return json({ ok: true, added: 0, note: capped ? `You're at the ${MAX_SUBS_PER_CONTACT}-spot limit per contact.` : "Already subscribed to those spots." }, 200, cors);
      }
      let welcome = "skipped";
      const spots = result.addedLabels.join(", ");
      try {
        if (channel === "sms" && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)) {
          await twilioSend(env, contact, `\u{1F308} You're subscribed to Rainbow Alerts for ${spots}. We'll text you when a rainbow is likely. Reply STOP to opt out.`);
          welcome = "sent";
        } else if (channel === "telegram" && env.TELEGRAM_BOT_TOKEN) {
          await telegramSend(env, contact, `\u{1F308} You're subscribed to Rainbow Alerts for ${spots}. Send /stop anytime to turn these off.`);
          welcome = "sent";
        }
      } catch (e) { welcome = "failed: " + e.message; }
      return json({ ok: true, added: result.added, reactivated: result.reactivated, channel, welcome }, 200, cors);
    } catch (e) {
      return json({ error: e.message }, 502, cors);
    }
  },
};

/* ---------- GET /confirm?token=... — the magic-link landing page ---------- */
async function handleConfirm(url, env) {
  const html = (title, body) => new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:16px -apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;color:#1c2b33">` +
    `<h1 style="color:#0b4f6c">${title}</h1><p>${body}</p></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
  if (!env.SIGNUP_KV) return html("Not available", "Confirmation isn't configured on this Worker yet.");
  const token = url.searchParams.get("token") || "";
  const raw = token && await env.SIGNUP_KV.get("pending:" + token);
  if (!raw) return html("Link expired", "This confirm link is invalid or has expired (links last 1 hour) — please sign up again.");
  let pending;
  try { pending = JSON.parse(raw); } catch { return html("Something went wrong", "Please sign up again."); }
  await env.SIGNUP_KV.delete("pending:" + token); // one-time use
  try {
    const result = await commitSignup(env, pending.channel, pending.contactKey, pending.contactFields, pending.clean, pending.includeMaybe);
    const spots = (result.addedLabels && result.addedLabels.length ? result.addedLabels : pending.clean.map((t) => t.label)).join(", ");
    return html("🌈 You're confirmed!", `You'll get Rainbow Alerts for <b>${spots}</b>.`);
  } catch (e) {
    return html("Something went wrong", "Please try signing up again. (" + e.message + ")");
  }
}

/* ---------- shared store-append logic (email-confirm path and immediate channels both use this) ---------- */
async function commitSignup(env, channel, contactKey, contactFields, clean, includeMaybe) {
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
    // Fail CLOSED on a malformed store: a parse error or non-array content means something is
    // wrong with the file, not that it's empty — proceeding would overwrite every real subscriber
    // with just this one signup. Refuse instead, so the store is never silently destroyed.
    let parsed;
    try { parsed = JSON.parse(b64decode(meta.content)); }
    catch { throw new Error("Store is corrupted (invalid JSON) — refusing to write"); }
    if (!Array.isArray(parsed)) throw new Error("Store is corrupted (not a list) — refusing to write");
    list = parsed;
  } else if (getRes.status !== 404) {
    throw new Error("Store read failed: " + getRes.status);
  }

  // --- append (dedupe by channel + contact + label; reactivate a matching inactive row
  //     instead of silently no-opping, so someone who unsubscribed can resubscribe) ---
  const existingActive = new Map(
    list.filter((s) => s.active !== false).map((s) => [`${s.channel || "sms"}|${contactKeyOf(s)}|${s.label}`, s])
  );
  const contactTotal = list.filter((s) => s.active !== false && (s.channel || "sms") === channel && contactKeyOf(s) === contactKey).length;
  let added = 0, reactivated = 0;
  const addedLabels = [];
  let room = Math.max(0, MAX_SUBS_PER_CONTACT - contactTotal);
  for (const t of clean) {
    const key = `${channel}|${contactKey}|${t.label}`;
    if (existingActive.has(key)) continue;
    const stale = list.find((s) => s.active === false && (s.channel || "sms") === channel && contactKeyOf(s) === contactKey && s.label === t.label);
    if (stale) {
      stale.active = true; stale.includeMaybe = includeMaybe; stale.added = new Date().toISOString();
      reactivated++; addedLabels.push(t.label);
      continue;
    }
    if (room <= 0) continue; // quietly stop adding new rows once this contact hits the cap
    list.push({
      id: slug(channel, contactKey, t.label),
      channel, ...contactFields,
      label: t.label, lat: t.lat, lon: t.lon,
      includeMaybe, active: true,
      added: new Date().toISOString(),
    });
    added++; room--;
    addedLabels.push(t.label);
  }

  if (added === 0 && reactivated === 0) return { added, reactivated, addedLabels, contactTotal };

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
    throw new Error(`Store write failed: ${put.status} ${detail.slice(0, 200)}`);
  }
  return { added, reactivated, addedLabels, contactTotal };
}

/* ---------- flood rate limit (Workers KV, fixed window) ----------
   Not atomic under true concurrency (KV is read-modify-write, not increment), which is fine here —
   this is an abuse deterrent, not a security boundary. A couple of requests slipping through right
   at the edge of the window doesn't matter; a sustained flood still gets capped within one window. */
async function rateLimited(env, key) {
  const windowKey = key + ":" + Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SEC);
  const current = +(await env.SIGNUP_KV.get(windowKey)) || 0;
  if (current >= RATE_LIMIT_MAX) return true;
  await env.SIGNUP_KV.put(windowKey, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC * 2 });
  return false;
}

/* ---------- confirmation email via Resend's HTTP API ----------
   Swap this one function for any other provider (SendGrid, Mailgun, Postmark, ...) — nothing else
   in the file needs to change. */
async function sendConfirmEmail(env, to, confirmUrl, spots) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to,
      subject: "🌈 Confirm your Rainbow Alerts signup",
      html: `<p>Tap below to confirm Rainbow Alerts for <b>${spots}</b>:</p>` +
            `<p><a href="${confirmUrl}" style="background:#0b4f6c;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Confirm my alerts</a></p>` +
            `<p style="color:#5d7280;font-size:.85rem">This link expires in an hour. If you didn't request this, ignore it — nothing happens unless you click it.</p>`,
    }),
  });
  if (!r.ok) { const detail = await r.text().catch(() => ""); throw new Error(`Resend ${r.status}: ${detail.slice(0, 200)}`); }
}

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
  if (ch === "push") return (s.push && s.push.endpoint) ? s.push.endpoint : ""; // full endpoint — never truncate
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
  // A short raw-character suffix (e.g. last 6 chars) collides easily — two different emails, or two
  // push endpoints sharing a common prefix, can land on the same tail. Hash the FULL contactKey
  // instead; ids are opaque anyway (they're only looked up by exact value, never typed by a person).
  const tail = fnv1a(String(contactKey));
  return (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + channel + "-" + tail);
}
// Fast, dependency-free, non-cryptographic hash — fine here since it's only for id-collision
// avoidance, not security. Returns 8 hex chars (32 bits).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
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
