/* ============================================================
   Rainbow Alerts — delivery layer.
   One dispatch() that routes an alert to whatever channel a subscriber chose:
     email    → SMTP (nodemailer)          needs SMTP_* env
     push     → Web Push (web-push + VAPID) needs VAPID_* env
     telegram → Telegram Bot API (fetch)    needs TELEGRAM_BOT_TOKEN
     sms      → Twilio (fetch)              needs TWILIO_* env

   Only the channels you configure need to work — an unconfigured channel throws
   a clear "not configured" error for that one subscriber and the rest still send.
   nodemailer and web-push are optional deps; they're imported lazily so the SMS/
   Telegram-only path runs with no npm install at all.
   ============================================================ */

/* ---------- Email (SMTP via nodemailer) ---------- */
export async function sendEmail(to, subject, text, cfg){
  if(!cfg.smtp || !cfg.smtp.host || !cfg.smtp.user) throw new Error("email not configured (SMTP_* env missing)");
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port || 587,
    secure: (cfg.smtp.port || 587) === 465,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
  const info = await transport.sendMail({
    from: cfg.smtp.from || cfg.smtp.user,
    to, subject, text,
  });
  return info.messageId || "sent";
}

/* ---------- Web Push (VAPID) ---------- */
export async function sendPush(subscription, payload, cfg){
  if(!cfg.vapid || !cfg.vapid.publicKey || !cfg.vapid.privateKey) throw new Error("push not configured (VAPID_* env missing)");
  if(!subscription || !subscription.endpoint) throw new Error("subscriber has no push subscription");
  const { default: webpush } = await import("web-push");
  webpush.setVapidDetails(cfg.vapid.subject || "mailto:alerts@prey.tel", cfg.vapid.publicKey, cfg.vapid.privateKey);
  const res = await webpush.sendNotification(subscription, JSON.stringify(payload));
  return "push:" + (res.statusCode || "ok");
}

/* ---------- Telegram Bot API ---------- */
export async function sendTelegram(chatId, text, cfg, fetchImpl=fetch){
  if(!cfg.telegramToken) throw new Error("telegram not configured (TELEGRAM_BOT_TOKEN missing)");
  if(!chatId) throw new Error("subscriber has no telegram chat id");
  const url = `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`;
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok || !j.ok) throw new Error(`Telegram ${r.status}: ${(j && j.description) || "send failed"}`);
  return "tg:" + (j.result && j.result.message_id);
}

/* ---------- Twilio SMS ---------- */
export async function sendSMS(to, body, cfg, fetchImpl=fetch){
  if(!cfg.twilio || !cfg.twilio.sid || !cfg.twilio.token) throw new Error("sms not configured (TWILIO_* env missing)");
  if(!cfg.twilio.from && !cfg.twilio.messagingServiceSid) throw new Error("sms not configured (no from number / messaging service)");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio.sid}/Messages.json`;
  const form = new URLSearchParams({ To: to, Body: body });
  if(cfg.twilio.messagingServiceSid) form.set("MessagingServiceSid", cfg.twilio.messagingServiceSid);
  else form.set("From", cfg.twilio.from);
  const auth = Buffer.from(`${cfg.twilio.sid}:${cfg.twilio.token}`).toString("base64");
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || "send failed"}`);
  return "sms:" + j.sid;
}

/* ---------- the router ----------
   sub:   a subscriber row (must have .channel and the matching contact field)
   parts: { subject, title, body } from formatAlert(label, rb, sub.channel)
   cfg:   built once in the watcher from env (see buildSenderCfg)                */
export async function dispatch(sub, parts, cfg, fetchImpl=fetch){
  const ch = sub.channel || "sms";
  switch(ch){
    case "email":    return sendEmail(sub.email, parts.subject, parts.body, cfg);
    case "push":     return sendPush(sub.push, { title: parts.title, body: parts.body }, cfg);
    case "telegram": return sendTelegram(sub.telegram, parts.body, cfg, fetchImpl);
    case "sms":      return sendSMS(sub.phone, parts.body, cfg, fetchImpl);
    default:         throw new Error(`unknown channel "${ch}"`);
  }
}

/* the contact string for a subscriber, for logging (never logs full push keys) */
export function contactOf(sub){
  const ch = sub.channel || "sms";
  if(ch==="email")    return sub.email;
  if(ch==="telegram") return "tg:" + sub.telegram;
  if(ch==="push")     return "push:" + (sub.push && sub.push.endpoint ? sub.push.endpoint.slice(0, 40) + "…" : "?");
  return sub.phone;
}

/* build the sender cfg from environment variables (call once). */
export function buildSenderCfg(env){
  return {
    smtp: {
      host: env.SMTP_HOST, port: env.SMTP_PORT ? +env.SMTP_PORT : 587,
      user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM || env.SMTP_USER,
    },
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT || "mailto:alerts@prey.tel",
    },
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    twilio: {
      sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    },
  };
}
