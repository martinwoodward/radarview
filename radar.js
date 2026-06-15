/* Radar View — animated CRT radar scope fed by a local PiAware/SkyAware ADS-B receiver.
 *
 * Data sources:
 *   - <ADSB_BASE>/data/aircraft.json   live positions/altitude/groundspeed/track
 *   - <ADSB_BASE>/data/receiver.json   receiver lat/lon
 *   - <ADSB_BASE>/db/<prefix>.json     hex -> {r:registration, t:typecode} (hierarchical)
 *   - <ADSB_BASE>/db/aircraft_types/icao_aircraft_types.json   typecode -> {desc,wtc}
 *   - https://api.adsbdb.com/v0/callsign/<CALLSIGN>  flight number, airline, dep/arr (IATA)
 *
 * ADSB_BASE: default "/adsb" works behind the bundled serve.py proxy. If you enable CORS
 * on the device's lighttpd you can point straight at it, e.g.:
 *   <script>window.ADSB_BASE="http://192.168.2.74:8080"</script>  (before radar.js)
 */
"use strict";

const ADSB_BASE = (window.ADSB_BASE || "/adsb").replace(/\/$/, "");
const ADSBDB = "https://api.adsbdb.com/v0";

// ---- tunables -------------------------------------------------------------
const RANGES_MI = [12.5, 25, 50, 100, 200];   // zoom steps
const DEFAULT_RANGE_IDX = 2;                   // 50 miles
const POLL_MS = 1000;                           // device refresh is ~1Hz
const STALE_SEC = 15;                            // dim aircraft not seen for this long
const DROP_SEC = 75;                             // remove entirely
const MOVING_MIN_GS = 50;                        // kts; below this a target counts as not "moving"
const DR_MAX_SEC = 4;                            // cap dead-reckoning extrapolation
const MI_PER_DEG_LAT = 69.172;                   // statute miles per degree latitude
const KT_TO_MI_PER_SEC = 1.15078 / 3600;         // knots -> statute miles/second

const THEMES = {
  green:  { dim: "#0a3d12", mid: "#1f9c3a", hot: "#7dff8e", base: "#33ff66" },
  orange: { dim: "#3d2400", mid: "#b86b00", hot: "#ffd27d", base: "#ffb000" },
  blue:   { dim: "#06324d", mid: "#1f7fb8", hot: "#bfe9ff", base: "#33ccff" },
};

// ---- state ----------------------------------------------------------------
const state = {
  receiver: { lat: 54.76, lon: -6.35 },
  aircraft: new Map(),     // hex -> record
  rangeIdx: DEFAULT_RANGE_IDX,
  theme: "green",
  persistence: 55,         // 0..100 slider; higher = longer phosphor burn
  closestHex: null,
  lastPollOk: 0,
  lastPollTry: 0,
  pollError: null,
  coast: null,             // {coast:[[ [lon,lat],.. ]], lake:[...] }
};

const dbShardCache = new Map();   // prefix -> data (or null)
const dbShardInflight = new Map();
const hexCache = new Map();        // hex -> {r,t,desc} | null  (resolved aircraft)
const hexInflight = new Set();
let typeTable = null;
const routeCache = new Map();      // callsign -> route | null
const routeInflight = new Set();

// ---- math -----------------------------------------------------------------
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613; // earth radius, statute miles
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// project lat/lon to local miles offset (east, north) around receiver
function toMiles(lat, lon) {
  const east = (lon - state.receiver.lon) * Math.cos(rad(state.receiver.lat)) * MI_PER_DEG_LAT;
  const north = (lat - state.receiver.lat) * MI_PER_DEG_LAT;
  return { east, north };
}

function compass(b) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(b / 22.5) % 16];
}

// ---- data polling ---------------------------------------------------------
async function loadReceiver() {
  try {
    const r = await fetch(`${ADSB_BASE}/data/receiver.json`, { cache: "no-store" });
    const j = await r.json();
    if (typeof j.lat === "number" && typeof j.lon === "number") {
      state.receiver = { lat: j.lat, lon: j.lon };
    }
  } catch (e) { /* keep default */ }
}

async function poll() {
  state.lastPollTry = Date.now();
  try {
    const r = await fetch(`${ADSB_BASE}/data/aircraft.json`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const now = Date.now();
    const serverNow = j.now ? j.now * 1000 : now;
    for (const a of j.aircraft || []) {
      if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
      const hex = (a.hex || "").toUpperCase();
      if (!hex) continue;
      const seenPos = typeof a.seen_pos === "number" ? a.seen_pos : 0;
      let rec = state.aircraft.get(hex);
      if (!rec) { rec = { hex, trail: [] }; state.aircraft.set(hex, rec); }
      rec.callsign = (a.flight || "").trim();
      rec.altRaw = a.alt_baro;
      rec.gs = typeof a.gs === "number" ? a.gs : null;
      rec.track = typeof a.track === "number" ? a.track : null;
      rec.lat = a.lat; rec.lon = a.lon;
      rec.seenPos = seenPos;
      rec.posClientTime = now - seenPos * 1000; // when this fix was actually valid
      rec.lastUpdate = now;
      const m = toMiles(a.lat, a.lon);
      rec.east = m.east; rec.north = m.north;
      // velocity vector in miles/sec for dead reckoning
      if (rec.gs != null && rec.track != null) {
        const sp = rec.gs * KT_TO_MI_PER_SEC;
        rec.vEast = sp * Math.sin(rad(rec.track));
        rec.vNorth = sp * Math.cos(rad(rec.track));
      } else { rec.vEast = rec.vNorth = 0; }
      rec.distMi = haversineMi(state.receiver.lat, state.receiver.lon, a.lat, a.lon);
      rec.brng = bearingDeg(state.receiver.lat, state.receiver.lon, a.lat, a.lon);
      // trail (sampled positions in miles)
      const last = rec.trail[rec.trail.length - 1];
      if (!last || Math.hypot(last.e - m.east, last.n - m.north) > 0.05) {
        rec.trail.push({ e: m.east, n: m.north, t: now });
        if (rec.trail.length > 60) rec.trail.shift();
      }
      // kick off enrichment lookups (cached + deduped)
      resolveHex(hex);
      if (rec.callsign) resolveRoute(rec.callsign);
    }
    // prune
    for (const [hex, rec] of state.aircraft) {
      if (now - rec.lastUpdate > DROP_SEC * 1000) state.aircraft.delete(hex);
    }
    state.lastPollOk = now;
    state.pollError = null;
  } catch (e) {
    state.pollError = e.message || String(e);
  }
}

// ---- hex -> type/registration (hierarchical SkyAware db) ------------------
async function fetchShard(prefix) {
  if (dbShardCache.has(prefix)) return dbShardCache.get(prefix);
  if (dbShardInflight.has(prefix)) return dbShardInflight.get(prefix);
  const p = (async () => {
    try {
      const r = await fetch(`${ADSB_BASE}/db/${prefix}.json`, { cache: "force-cache" });
      const data = r.ok ? await r.json() : null;
      dbShardCache.set(prefix, data);
      return data;
    } catch (e) { dbShardCache.set(prefix, null); return null; }
    finally { dbShardInflight.delete(prefix); }
  })();
  dbShardInflight.set(prefix, p);
  return p;
}

async function loadTypeTable() {
  if (typeTable) return typeTable;
  try {
    const r = await fetch(`${ADSB_BASE}/db/aircraft_types/icao_aircraft_types.json`, { cache: "force-cache" });
    typeTable = r.ok ? await r.json() : {};
  } catch (e) { typeTable = {}; }
  return typeTable;
}

async function resolveHex(hex) {
  if (hexCache.has(hex) || hexInflight.has(hex)) return;
  hexInflight.add(hex);
  try {
    let level = 1, found = null;
    while (level <= hex.length) {
      const bkey = hex.substring(0, level);
      const data = await fetchShard(bkey);
      if (!data) break;
      const dkey = hex.substring(level);
      if (dkey in data) { found = data[dkey]; break; }
      const child = bkey + dkey.substring(0, 1);
      if (data.children && data.children.indexOf(child) !== -1) { level++; continue; }
      break;
    }
    if (found) {
      const out = { r: found.r || null, t: found.t || null, desc: null };
      if (out.t) { const tt = await loadTypeTable(); if (tt[out.t.toUpperCase()]) out.desc = tt[out.t.toUpperCase()].desc; }
      hexCache.set(hex, out);
      const rec = state.aircraft.get(hex); if (rec) rec.typeData = out;
    } else {
      hexCache.set(hex, null);
    }
  } catch (e) { hexCache.set(hex, null); }
  finally { hexInflight.delete(hex); }
}

// ---- callsign -> route (adsbdb) -------------------------------------------
async function resolveRoute(callsign) {
  const cs = callsign.trim();
  if (!cs || routeCache.has(cs) || routeInflight.has(cs)) return;
  routeInflight.add(cs);
  try {
    const r = await fetch(`${ADSBDB}/callsign/${encodeURIComponent(cs)}`, { cache: "no-store" });
    const j = await r.json();
    const fr = j && j.response && j.response.flightroute;
    if (fr) {
      routeCache.set(cs, {
        flightNo: fr.callsign_iata || null,
        airline: fr.airline ? fr.airline.name : null,
        depIata: fr.origin ? fr.origin.iata_code : null,
        depName: fr.origin ? fr.origin.municipality || fr.origin.name : null,
        arrIata: fr.destination ? fr.destination.iata_code : null,
        arrName: fr.destination ? fr.destination.municipality || fr.destination.name : null,
      });
    } else {
      routeCache.set(cs, null);
    }
  } catch (e) { routeCache.set(cs, null); }
  finally { routeInflight.delete(cs); }
}

// ---- closest selection ----------------------------------------------------
function isMoving(rec) {
  if (rec.altRaw === "ground") return false;       // on the ground / runway
  if (rec.gs == null || rec.gs < MOVING_MIN_GS) return false; // stationary / taxiing
  return true;
}

function pickClosest() {
  let best = null, bestD = Infinity;
  const now = Date.now();
  for (const rec of state.aircraft.values()) {
    if (rec.seenPos > STALE_SEC) continue;
    if (now - rec.lastUpdate > STALE_SEC * 1000) continue;
    if (!isMoving(rec)) continue;                   // closest *airborne, moving* target only
    if (rec.distMi < bestD) { bestD = rec.distMi; best = rec; }
  }
  state.closestHex = best ? best.hex : null;
  return best;
}

// ---- rendering ------------------------------------------------------------
const canvas = document.getElementById("scope");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, CX = 0, CY = 0, R = 0, DPR = 1;
let coastCanvas = null;        // offscreen, rendered once per range/theme/size change
let coastKey = "";

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  const rect = canvas.getBoundingClientRect();
  W = rect.width; H = rect.height;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  CX = W / 2; CY = H / 2;
  R = Math.min(W, H) / 2 - 14;
  coastKey = ""; // force coastline re-render
}

function themeColors() { return THEMES[state.theme]; }

function milesToPx(east, north) {
  const range = RANGES_MI[state.rangeIdx];
  return { x: CX + (east / range) * R, y: CY - (north / range) * R };
}

function renderCoastOffscreen() {
  const range = RANGES_MI[state.rangeIdx];
  const key = `${state.theme}|${range}|${Math.round(W)}x${Math.round(H)}`;
  if (key === coastKey && coastCanvas) return;
  coastKey = key;
  coastCanvas = document.createElement("canvas");
  coastCanvas.width = Math.round(W * DPR); coastCanvas.height = Math.round(H * DPR);
  const c = coastCanvas.getContext("2d");
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (!state.coast) return;
  const col = themeColors();
  const drawSet = (segs, alpha, width) => {
    c.strokeStyle = col.dim; c.globalAlpha = alpha; c.lineWidth = width;
    c.lineJoin = "round"; c.lineCap = "round";
    for (const seg of segs) {
      c.beginPath();
      for (let i = 0; i < seg.length; i++) {
        const m = toMiles(seg[i][1], seg[i][0]);
        const p = milesToPx(m.east, m.north);
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.stroke();
    }
  };
  // clip to scope circle
  c.save();
  c.beginPath(); c.arc(CX, CY, R, 0, Math.PI * 2); c.clip();
  drawSet(state.coast.coast || [], 0.85, 1.1);
  drawSet(state.coast.lake || [], 0.7, 1.0);
  c.restore();
  c.globalAlpha = 1;
}

function drawGrid() {
  const col = themeColors();
  ctx.save();
  ctx.translate(CX, CY);
  ctx.strokeStyle = col.mid; ctx.fillStyle = col.mid;
  ctx.globalAlpha = 0.55;
  // range rings (quarter fractions)
  const range = RANGES_MI[state.rangeIdx];
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath(); ctx.arc(0, 0, R * i / 4, 0, Math.PI * 2); ctx.stroke();
  }
  // bearing spokes every 30°
  for (let a = 0; a < 360; a += 30) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(R * Math.sin(rad(a)), -R * Math.cos(rad(a)));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // ring range labels
  ctx.font = "11px 'VT323', monospace";
  ctx.globalAlpha = 0.8;
  for (let i = 1; i <= 4; i++) {
    ctx.fillText(`${(range * i / 4)}mi`, 4, -R * i / 4 + 12);
  }
  // cardinal labels
  ctx.globalAlpha = 0.95;
  ctx.font = "16px 'VT323', monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = col.hot;
  ctx.fillText("N", 0, -R + 8); ctx.fillText("S", 0, R - 8);
  ctx.fillText("E", R - 8, 0); ctx.fillText("W", -R + 8, 0);
  ctx.textAlign = "left";
  ctx.restore();
}

let sweepAngle = 0;
function drawSweep(dt) {
  sweepAngle = (sweepAngle + dt * (Math.PI * 2) / 4000) % (Math.PI * 2); // 4s revolution
  const col = themeColors();
  ctx.save();
  ctx.translate(CX, CY);
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
  // The conic gradient is anchored to the sweep line: brightest exactly at the
  // leading edge, fading back over the trailing wedge. Canvas conic angle 0 points
  // along +x and increases clockwise; the leading line vector is (sin, -cos).
  const leadAng = Math.atan2(-Math.cos(sweepAngle), Math.sin(sweepAngle));
  const g = ctx.createConicGradient(leadAng, 0, 0);
  g.addColorStop(0.00, hexA(col.hot, 0.45));   // leading edge (on the sweep line)
  g.addColorStop(0.03, hexA(col.base, 0.0));   // nothing ahead of the sweep
  g.addColorStop(0.80, hexA(col.base, 0.0));
  g.addColorStop(0.94, hexA(col.base, 0.14));  // trailing afterglow ramps up...
  g.addColorStop(1.00, hexA(col.hot, 0.45));   // ...back to the leading edge
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  // leading line (coincides with the bright edge of the gradient)
  ctx.strokeStyle = hexA(col.hot, 0.55); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.lineTo(R * Math.sin(sweepAngle), -R * Math.cos(sweepAngle));
  ctx.stroke();
  ctx.restore();
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function effPos(rec, now) {
  // dead-reckon from last valid fix, capped
  let dt = (now - rec.posClientTime) / 1000;
  if (rec.seenPos > 2 || dt > DR_MAX_SEC) dt = Math.min(dt, 0);
  dt = Math.max(0, Math.min(dt, DR_MAX_SEC));
  return { east: rec.east + rec.vEast * dt, north: rec.north + rec.vNorth * dt };
}

function fmtAlt(raw) {
  if (raw === "ground") return "GROUND";
  if (typeof raw !== "number") return "n/a";
  if (raw >= 18000) return "FL" + Math.round(raw / 100);
  return raw.toLocaleString() + " ft";
}

// directional plane silhouette (nose points "up" = -y, then rotated to heading)
function drawPlaneIcon(x, y, headingDeg, s, fill) {
  ctx.save();
  ctx.translate(x, y);
  if (headingDeg != null) ctx.rotate(rad(headingDeg));
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.05);          // nose
  ctx.lineTo(s * 0.16, -s * 0.30);
  ctx.lineTo(s * 0.98, s * 0.30);    // right wing
  ctx.lineTo(s * 0.98, s * 0.48);
  ctx.lineTo(s * 0.16, s * 0.16);
  ctx.lineTo(s * 0.14, s * 0.74);
  ctx.lineTo(s * 0.52, s * 1.02);    // right tailplane
  ctx.lineTo(s * 0.52, s * 1.14);
  ctx.lineTo(0, s * 0.86);
  ctx.lineTo(-s * 0.52, s * 1.14);   // left tailplane
  ctx.lineTo(-s * 0.52, s * 1.02);
  ctx.lineTo(-s * 0.14, s * 0.74);
  ctx.lineTo(-s * 0.16, s * 0.16);
  ctx.lineTo(-s * 0.98, s * 0.48);   // left wing
  ctx.lineTo(-s * 0.98, s * 0.30);
  ctx.lineTo(-s * 0.16, -s * 0.30);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.restore();
}

function boxesOverlap(a, b) {
  const pad = 2;
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x ||
           a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}

// nudge label boxes so they don't overlap; returns nothing, mutates .x/.y
function placeLabels(labels) {
  const offsets = [[0, 0], [0, 15], [0, -15], [16, 0], [-16, 0], [0, 30],
                   [16, 15], [-16, 15], [16, -15], [-16, -15], [0, -30], [0, 45]];
  const placed = [];
  // place closest first so it keeps its preferred spot
  labels.sort((a, b) => (b.isClosest ? 1 : 0) - (a.isClosest ? 1 : 0));
  for (const lb of labels) {
    let chosen = null;
    for (const [dx, dy] of offsets) {
      const box = { x: lb.ax + dx, y: lb.ay + dy, w: lb.w, h: lb.h };
      if (!placed.some(q => boxesOverlap(box, q))) { chosen = box; break; }
    }
    if (!chosen) chosen = { x: lb.ax, y: lb.ay, w: lb.w, h: lb.h };
    lb.x = chosen.x; lb.y = chosen.y;
    placed.push(chosen);
  }
}

function drawAircraft(now) {
  const col = themeColors();
  const range = RANGES_MI[state.rangeIdx];
  const lineH = 13, charW = 6.4;
  const labels = [];
  for (const rec of state.aircraft.values()) {
    const p = effPos(rec, now);
    const px = milesToPx(p.east, p.north);
    if (Math.hypot(px.x - CX, px.y - CY) > R + 6) continue; // outside scope
    const stale = rec.seenPos > STALE_SEC || (now - rec.lastUpdate > STALE_SEC * 1000);
    const isClosest = rec.hex === state.closestHex;
    // trail
    if (rec.trail.length > 1) {
      for (let i = 1; i < rec.trail.length; i++) {
        const a0 = rec.trail[i - 1], a1 = rec.trail[i];
        const q0 = milesToPx(a0.e, a0.n), q1 = milesToPx(a1.e, a1.n);
        ctx.strokeStyle = hexA(col.mid, (i / rec.trail.length) * 0.5);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
      }
    }
    // plane icon, pointing along its track
    const fill = stale ? hexA(col.mid, 0.55) : col.hot;
    const s = isClosest ? 10 : 7;
    if (rec.track != null) drawPlaneIcon(px.x, px.y, rec.track, s, fill);
    else { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(px.x, px.y, s * 0.45, 0, Math.PI * 2); ctx.fill(); }
    if (isClosest) {
      ctx.strokeStyle = col.hot; ctx.lineWidth = 1.5;
      ctx.strokeRect(px.x - 13, px.y - 13, 26, 26);
    }
    // collect label (declutter: only closest, or all when zoomed in <= 50mi)
    if (isClosest || range <= 50) {
      const lines = [rec.callsign || rec.hex];
      if (isClosest && typeof rec.altRaw === "number") lines.push(fmtAlt(rec.altRaw));
      const w = Math.max(...lines.map(t => t.length)) * charW;
      labels.push({
        ax: px.x + s + 6, ay: px.y - 8, w, h: lines.length * lineH,
        lines, isClosest,
        color: stale ? hexA(col.mid, 0.6) : (isClosest ? col.hot : col.base),
      });
    }
  }
  // resolve overlaps, then draw labels on top
  placeLabels(labels);
  ctx.font = "13px 'VT323', monospace";
  ctx.textBaseline = "top";
  for (const lb of labels) {
    ctx.fillStyle = lb.color;
    for (let i = 0; i < lb.lines.length; i++) ctx.fillText(lb.lines[i], lb.x, lb.y + i * lineH);
  }
  ctx.textBaseline = "alphabetic";
}

function drawCenter() {
  const col = themeColors();
  ctx.fillStyle = col.hot;
  ctx.beginPath(); ctx.arc(CX, CY, 3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = hexA(col.hot, 0.6); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(CX, CY, 6, 0, Math.PI * 2); ctx.stroke();
}

let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(60, t - lastFrame); lastFrame = t;
  const now = Date.now();
  // phosphor persistence: fade previous frame toward black
  const fade = 0.30 - (state.persistence / 100) * 0.28; // 0.30 .. 0.02
  ctx.fillStyle = `rgba(0,8,2,${fade})`;
  ctx.fillRect(0, 0, W, H);

  renderCoastOffscreen();
  if (coastCanvas) ctx.drawImage(coastCanvas, 0, 0, W, H);

  drawGrid();
  drawSweep(dt);
  pickClosest();
  drawAircraft(now);
  drawCenter();

  updateHud(now);
  requestAnimationFrame(frame);
}

// ---- HUD / info panel -----------------------------------------------------
const $ = (id) => document.getElementById(id);
function setText(id, v) { const el = $(id); if (el) el.textContent = (v == null || v === "") ? "—" : v; }

function updateHud(now) {
  const rec = state.closestHex ? state.aircraft.get(state.closestHex) : null;
  setText("range-val", RANGES_MI[state.rangeIdx] + " mi");
  // status
  const ageS = state.lastPollOk ? ((now - state.lastPollOk) / 1000) : null;
  let status, cls;
  if (state.pollError && (!ageS || ageS > 5)) { status = "LINK FAIL: " + state.pollError; cls = "err"; }
  else if (ageS == null) { status = "CONNECTING…"; cls = "warn"; }
  else if (ageS > 4) { status = `STALE FEED (${ageS.toFixed(0)}s)`; cls = "warn"; }
  else { status = "LIVE"; cls = "ok"; }
  const sEl = $("status"); sEl.textContent = status; sEl.className = "status " + cls;
  setText("count", state.aircraft.size + " tracks");

  if (!rec) {
    setText("c-callsign", "NO TARGET"); setText("c-flight", null); setText("c-airline", null);
    setText("c-type", null); setText("c-reg", null); setText("c-alt", null); setText("c-gs", null);
    setText("c-route", null); setText("c-pos", null);
    return;
  }
  const td = rec.typeData || (hexCache.get(rec.hex) || null);
  const route = rec.callsign ? routeCache.get(rec.callsign) : null;
  setText("c-callsign", rec.callsign || rec.hex);
  setText("c-flight", route && route.flightNo ? route.flightNo : (rec.callsign ? "(no IATA)" : null));
  setText("c-airline", route ? route.airline : null);
  setText("c-type", td && td.t ? (td.t + (td.desc ? " · " + td.desc : "")) : null);
  setText("c-reg", td ? td.r : null);
  setText("c-alt", fmtAlt(rec.altRaw));
  setText("c-gs", rec.gs != null ? Math.round(rec.gs) + " kts" : null);
  if (route && (route.depIata || route.arrIata)) {
    setText("c-route", `${route.depIata || "???"} → ${route.arrIata || "???"}`);
  } else { setText("c-route", rec.callsign ? "route unknown" : null); }
  setText("c-pos", `${rec.distMi.toFixed(1)} mi · ${Math.round(rec.brng)}° ${compass(rec.brng)}`);
}

// ---- controls -------------------------------------------------------------
function applyTheme() {
  document.body.dataset.theme = state.theme;
  coastKey = "";
}
function zoom(dir) {
  state.rangeIdx = Math.max(0, Math.min(RANGES_MI.length - 1, state.rangeIdx + dir));
  coastKey = "";
}
function wireControls() {
  $("zoom-in").addEventListener("click", () => zoom(-1));
  $("zoom-out").addEventListener("click", () => zoom(1));
  document.querySelectorAll(".theme-btn").forEach(b =>
    b.addEventListener("click", () => { state.theme = b.dataset.theme; applyTheme(); }));
  const slider = $("phosphor");
  slider.addEventListener("input", () => { state.persistence = +slider.value; });
  window.addEventListener("resize", resize);
}

// ---- boot -----------------------------------------------------------------
async function loadCoast() {
  try {
    const r = await fetch("coastline.geojson", { cache: "force-cache" });
    const j = await r.json();
    const out = { coast: [], lake: [] };
    for (const f of j.features || []) {
      const kind = f.properties && f.properties.kind;
      const segs = f.geometry && f.geometry.coordinates || [];
      if (kind === "coast") out.coast = segs;
      else if (kind === "lake") out.lake = segs;
    }
    state.coast = out;
  } catch (e) { /* coastline optional */ }
}

async function main() {
  wireControls();
  applyTheme();
  resize();
  await loadReceiver();
  loadCoast();
  await poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
}
main();
