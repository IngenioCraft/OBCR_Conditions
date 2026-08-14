# 🌈 Rainbow Alerts

Notifies subscribers when a rainbow is likely at their spot. It reuses the **exact
same rainbow logic** the website uses (sun low in the sky + showers around + a
sky that's actually breaking so the sun can reach the rain), runs on a schedule,
and can deliver over **four channels** — each subscriber picks one:

| Channel | What the friend needs | Cost | Notes |
|---|---|---|---|
| ✉️ **Email** | an email address | free | Works everywhere, nothing to install. The easy default. |
| 🔔 **Web push** | a browser | free | Phone/desktop notification, no app. iPhone must "Add to Home Screen" first. |
| ✈️ **Telegram** | a Telegram account | free | Fully self-service through the bot. |
| 💬 **SMS** | a phone number | ~$2/mo + carrier reg | A real text. Needs Twilio + 10DLC/toll-free registration. |

**It is safe by default.** With no configuration it runs in *dry-run* mode:
it logs what it *would* send and sends nothing. You flip it live deliberately
with the `DRY_RUN=0` repo variable.

---

## What's here

| File | What it does |
|---|---|
| `rainbow-logic.mjs` | Pure rainbow decision + sun math + `formatAlert()` per channel. In lock-step with `assets/conditions.js`. |
| `senders.mjs` | Delivery layer: `sendEmail` / `sendPush` / `sendTelegram` / `sendSMS` + `dispatch()` router. |
| `rainbow-watch.mjs` | The watcher: reads subscribers → checks each location's sky → sends matches over their chosen channel. |
| `subscribers.json` | The subscriber list (**keep this private** — it holds contact info). |
| `state.json` | Cooldown memory (last time each person was alerted). Auto-updated. |
| `signup.html` | Signup form with the channel chooser (email / push / SMS; links to the bot for Telegram). |
| `signup-worker.js` | Cloudflare Worker that stores signups into `subscribers.json`. |
| `telegram-bot.js` | Cloudflare Worker webhook — the Telegram bot (self-service /start, /stop). |
| `sw.js` | Service worker for web push. **Must be served from the site root.** |
| `package.json` | Deps: `nodemailer` (email), `web-push` (push). |
| `test-watch.mjs` | Unit tests (decision, formatting, dispatch routing). Run `node test-watch.mjs`. |
| `rainbow-alerts.workflow.yml` | Copy to `.github/workflows/` in the private repo. |

---

## ⚠️ Privacy: put this in a PRIVATE repo

`subscribers.json` holds people's contact info. **Do not commit it to the public
GitHub Pages repo.** Website stays public; this `alerts/` folder + workflow live
in a **separate private repo**. The public signup form posts to the private side
via the `SIGNUP_ENDPOINT` Worker.

---

## Choose your channel(s)

You only configure the channels you want. Add just those secrets; leave the rest blank.

### ✉️ Email (recommended — free, universal)
Use any SMTP server. For a personal Gmail: turn on 2-step verification, create an
**App Password**, and use it as `SMTP_PASS`.

Secrets: `SMTP_HOST` (e.g. `smtp.gmail.com`), `SMTP_PORT` (`587`), `SMTP_USER`
(your address), `SMTP_PASS` (app password), `SMTP_FROM` (usually same as user).

### 🔔 Web push (free)
1. Generate a key pair: `npx web-push generate-vapid-keys`.
2. Put the **public** key in `signup.html` (`VAPID_PUBLIC_KEY`) — that unhides the option.
3. Add secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:you@…`).
4. Serve `sw.js` from the **site root** (e.g. `https://prey.tel/sw.js`).

### ✈️ Telegram (free)
1. Create a bot with **@BotFather** → get the token.
2. Deploy `telegram-bot.js` as a Worker; set `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`,
   and the same `GH_*` vars as the signup Worker.
3. Point Telegram's webhook at it:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/<WEBHOOK_SECRET>`
4. Put your bot's username (without `@`) in `signup.html` (`TELEGRAM_BOT`) to show the option.
5. Add `TELEGRAM_BOT_TOKEN` to the **watcher's** secrets too (so it can send alerts).

### 💬 SMS (Twilio — the only paid one)
Needs a Twilio number **and** carrier registration (10DLC or toll-free verification)
before US carriers will deliver. Secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
and either `TWILIO_FROM` (your number) or `TWILIO_MESSAGING_SERVICE_SID`.

---

## Going live — step by step

1. **Add the workflow.** Copy `rainbow-alerts.workflow.yml` to
   `.github/workflows/rainbow-alerts.yml` in the private repo. It installs deps,
   runs every 15 min, and can be run by hand from the **Actions** tab.
2. **Add secrets** for the channel(s) you chose (above), under
   Settings → Secrets and variables → Actions → *Secrets*.
3. **Test in dry-run.** Leave `DRY_RUN` unset (defaults to `1`). Run the workflow
   by hand and read the logs — you'll see `[DRY] would email …` / `would sms …`
   lines and nothing is sent.
4. **Send one real test.** Run the workflow manually with the `test_email`
   (or `test_to` / `test_telegram`) input filled in — it sends a single test to
   just that address and exits.
5. **Go live.** Add repo **Variable** `DRY_RUN = 0`. Optional variables:
   `COOLDOWN_HOURS` (2), `QUIET_START` (22), `QUIET_END` (6), `ALERT_TZ`
   (`America/New_York`).
6. **Wire signups.** Deploy `signup-worker.js`, set its `SIGNUP_ENDPOINT` URL in
   `signup.html`, and (for Telegram) deploy `telegram-bot.js`.

Add subscribers by hand anytime in `subscribers.json` — one row per person per spot:
```json
{ "id": "unique-id", "channel": "email", "email": "friend@example.com",
  "label": "Oyster Bay", "lat": 40.8757, "lon": -73.5326,
  "includeMaybe": false, "active": true }
```
Swap `channel`/contact for `"channel":"sms","phone":"+1…"`, `"channel":"telegram","telegram":"<chatid>"`,
or `"channel":"push","push":{…}`.

---

## How the decision works
For each subscriber's location the watcher pulls the live Open-Meteo forecast and
fires when **daytime + sun below 42° + showers (or very recent rain) + the sky is
not solid overcast** (so the sun can actually light the rain). Each person is
alerted at most once per `COOLDOWN_HOURS`, and never during quiet hours.
`includeMaybe: true` also alerts on borderline "recent rain, sun's out" days.

## Tuning
Thresholds live in `rainbow-logic.mjs` (`SUN_MAX_ALT`, `SHOWERY`, `SUN_OVERCAST`,
`SUN_CLEARISH`). Keep them in sync with `rainbowStatus()` in
`assets/conditions.js` so an alert and the website never disagree.
