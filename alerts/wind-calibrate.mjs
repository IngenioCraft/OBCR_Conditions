/* ============================================================
   Wind-model calibration for the Beekman Beach shelter model.

   Usage:  node alerts/wind-calibrate.mjs [days]      (default 30)

   Reads the live-vs-model samples the Worker logs every 15 min
   (see data-worker.js /windlog), then:
     1. shows model accuracy by wind-direction sector, and
     2. grid-searches the page's shelter formula
            f(dir) = min + (1-min) * (1 + cos(dir - open)) / 2
        for the {open, min} that best matches reality.
   Paste the suggested values into oyster-bay.html → shelter:{...}.
   ============================================================ */
const WORKER = "https://costal-data.help-f0d.workers.dev";
const days = +(process.argv[2] || 30);

const j = await (await fetch(`${WORKER}/windlog?days=${days}`)).json();
if (!j.ok) { console.error("windlog error:", j.error || j); process.exit(1); }
console.log(`${j.count} samples over ${days} day(s)\n`);

// Ratios are only meaningful when the model shows real wind; below ~4 mph the
// ratio is mostly sensor noise (1 mph vs 2 mph = "0.5" but means nothing).
const usable = j.samples.filter(s => s.lw != null && s.mw != null && s.md != null && s.mw >= 4);
console.log(`${usable.length} usable samples (model wind ≥ 4 mph)\n`);
if (usable.length < 50) console.log("⚠ Fewer than ~50 usable samples — treat results as preliminary.\n");

/* ---- 1. accuracy by direction sector (binned on MODEL direction, which is what the page trims) ---- */
const SECT = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const bins = SECT.map(() => []);
for (const s of usable) bins[Math.round(s.md / 22.5) % 16].push(s);
console.log("sector   n    model→live (mph)   ratio    current-f(340,0.6)");
const curF = d => shelterF(d, 340, 0.6);
for (let i = 0; i < 16; i++) {
  const b = bins[i]; if (!b.length) continue;
  const mw = avg(b.map(s => s.mw)), lw = avg(b.map(s => s.lw));
  const ratio = median(b.map(s => s.lw / s.mw));
  console.log(`${SECT[i].padEnd(5)} ${String(b.length).padStart(4)}   ${mw.toFixed(1).padStart(5)} → ${lw.toFixed(1).padStart(5)}      ${ratio.toFixed(2)}        ${curF(i * 22.5).toFixed(2)}`);
}

/* ---- 2. fit {open, min} to the observed ratios ---- */
function shelterF(dir, open, min) {
  let d = Math.abs(dir - open); if (d > 180) d = 360 - d;
  return min + (1 - min) * (1 + Math.cos(d * Math.PI / 180)) / 2;
}
let best = null;
for (let open = 0; open < 360; open += 5) {
  for (let min = 0.30; min <= 1.001; min += 0.05) {
    let err = 0;
    for (const s of usable) {
      const r = Math.min(s.lw / s.mw, 1.3);          // cap outlier ratios
      const e = shelterF(s.md, open, min) - r;
      err += e * e * s.mw;                           // weight windier samples — they matter for safety
    }
    if (!best || err < best.err) best = { open, min: +min.toFixed(2), err };
  }
}
if (best) {
  console.log(`\nBest fit:      shelter:{ open:${best.open}, min:${best.min} }`);
  console.log(`Current page:  shelter:{ open:340, min:0.6 }`);
  // overall bias with each
  const bias = (o, m) => avg(usable.map(s => s.mw * shelterF(s.md, o, m) - s.lw));
  console.log(`Mean error (sheltered model − live):  current ${bias(340, 0.6).toFixed(1)} mph · best-fit ${bias(best.open, best.min).toFixed(1)} mph`);
}

/* ---- gusts: a single overall scale check ---- */
const gs = j.samples.filter(s => s.lg != null && s.mg != null && s.mg >= 6);
if (gs.length) console.log(`\nGusts: median live/model ratio ${median(gs.map(s => s.lg / s.mg)).toFixed(2)} over ${gs.length} samples (page currently trims gusts half as much as wind).`);

function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
