# Coastal Conditions — Long Island

Live water & weather dashboards with **activity guidance** for a few Long Island spots:

- **Oyster Bay / Beekman Beach** (OBCR rowing) — `oyster-bay.html`
- **Ocean Beach, Fire Island** — ocean + bay sides — `ocean-beach.html`
- **Asharoken & Centerport Yacht Club** — `asharoken.html`

Everything runs client-side from **free, no-key public APIs** (Open-Meteo + NOAA). No server, no build step, no API keys, nothing to pay for.

## What each page shows

- A plain-language summary: how many activities are good right now, and whether conditions are **building / easing / steady**.
- Per-activity ratings (**Good / Fair / Poor / No**) for swimming, surfing, kayaking, SUP, sailing, rowing, fishing, beach walks, sunbathing, kite-flying, sandcastles, dolphin-watching, and backyard parties — only the ones that make sense for each spot.
- The numbers: water temp, air temp, wind + gusts, waves (open-water spots), **UV index (with SPF guidance)**, **air quality (US AQI)**, chance of rain, tide state, sunrise/sunset.
- A **through-the-day** forecast strip, toggleable between hourly and 15-minute steps, color-coded by conditions.
- **Water quality**: a rain-runoff advisory (heavy recent rain raises bacteria risk) plus a link to official Suffolk County beach advisories.
- NWS Doppler radar loop.

## Project layout

```
Coding Weather/
  index.html            landing page linking to all locations
  oyster-bay.html       thin config page
  ocean-beach.html      thin config page (ocean + bay spots)
  asharoken.html        thin config page (Asharoken + Centerport spots)
  assets/
    conditions.css      shared styles (incl. e-ink mode)
    conditions.js       shared engine — all logic lives here
  obcr-conditions.html  the original standalone single-file OBCR widget (self-contained)
  README.md
```

Each location page just sets a `window.SPOT_CONFIG` object and loads the shared engine. **Fixes or new features in `assets/conditions.js` apply to every page at once.**

## Hosting on GitHub Pages

1. Create a repo and add all these files (keep the `assets/` folder).
2. **Settings → Pages → Deploy from a branch → `main` / root.**
3. Your site: `https://YOURNAME.github.io/REPO/` → open `index.html`.
4. Embed a single page in another website with an iframe:
   `<iframe src="https://YOURNAME.github.io/REPO/ocean-beach.html" style="width:100%;height:1200px;border:0"></iframe>`

> The pages fetch live data in the browser, so they only show real numbers when opened as a **hosted page** (or via a local web server) — not inside an app preview pane, which blocks outside data. To preview locally: run `python3 -m http.server` in the folder and open `http://localhost:8000`.

## Customizing

Everything tunable is near the top of `assets/conditions.js` (the `T` thresholds — wind limits per activity, water-temp comfort bands, rain-runoff cutoffs) and in each page's `SPOT_CONFIG` (coordinates, tide/water-temp station IDs, radar station, which activities to show, brand colors via the `--brand` / `--brand-2` CSS variables).

Station references: Oyster Bay tides `8516201`, water temp Kings Point `8516945`; Fire Island Inlet tides `8515228`, Great South Bay `8515186`; Northport Bay `8515586`; Long Island Sound water temp Bridgeport `8467150`; radar `KOKX` (NWS New York/Upton).

If NOAA ever blocks direct browser calls once hosted, set `proxyBase` in a page's config to a CORS proxy (or a tiny free Cloudflare Worker) — see comments in the engine.

### Seasonal fishing (Montauk & Southold)

The "what's biting now" section is date-driven. Open/close dates live in `NY_SEASONS` at the top of the section in `conditions.js` (NY DEC 2026 marine-district rules), and each page's `fishing.season` / `fishing.run` lists which species to show. A species flips between "open now" and "opens [date]" on the real calendar day. **DEC revises these each year** — update the `NY_SEASONS` dates annually (a few minutes) and the pages stay correct; the section always links to DEC for the authoritative current rules.

### Live shellfish closures (Montauk & Southold)

The shellfish section shows three things: my rain-runoff advisory (computed live), the **live DEC closure status for that exact spot**, and the **embedded live DEC closure map**. The status is fetched client-side: the engine resolves DEC's ArcGIS feature service from the stable item ID (`shellfish.closureItemId`) and runs a point-in-polygon query, so there's no fragile hardcoded service URL. If DEC's service is ever unreachable, it falls back to the embedded map + links. The map embed is `shellfish.mapEmbed`. Both are official NYSDEC data and update as DEC posts changes.

## E-ink / standalone-display mode

Add `?eink=1` to any page URL (e.g. `ocean-beach.html?eink=1`) for a **high-contrast, grayscale, large-type** layout designed for e-paper. It avoids relying on color — ratings use solid/dashed/dotted borders plus text labels — because e-paper is slow and low-color.

### Building a cheap always-on device

| Approach | Cost | Effort | Notes |
|---|---|---|---|
| **Old tablet/phone in kiosk mode** | $0–50 | None | Fullscreen the hosted URL. Backlit (not e-paper), always-on. Easiest by far. |
| **Raspberry Pi Zero 2 W + Waveshare e-paper HAT (7.5")** | ~$75 | Medium | *Recommended for true e-ink.* Pi runs headless Chromium, screenshots the `?eink=1` page every ~15 min, pushes to the panel. Uses the exact page we built. |
| **ESP32 e-paper (Inkplate 6/10, LilyGo T5)** | ~$40–70 | Higher | Ultra-low-power, battery/solar-capable wall panel. The ESP32 fetches the JSON APIs directly and draws values itself (no webpage render). |
| **Pre-made e-ink dashboard (e.g. TRMNL)** | ~$130–200 | Low | Plug-and-play; point it at a URL. Least tinkering. |

**Recommended path** for a boathouse or kitchen panel: Raspberry Pi Zero 2 W + a 7.5" Waveshare e-paper display. A ~20-line Python script (Chromium `--screenshot` of the `?eink=1` URL → the Waveshare/`omni-epd` driver) on a 15-minute cron gives a silent, low-power, paper-like conditions board that always shows the latest data over Wi-Fi.
