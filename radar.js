/* Radar View — animated CRT radar scope for live ADS-B aircraft.
 *
 * FEEDS (see FEEDS registry below) are switchable at runtime from the panel:
 *   - "local"          a PiAware/SkyAware/dump1090-fa receiver (aircraft.json format)
 *   - "airplaneslive"  https://api.airplanes.live  (free, CORS-enabled, global)
 *   - "adsblol"        https://api.adsb.lol         (free; no CORS -> via serve.py proxy)
 *   - "adsbexchange"   ADSBExchange via RapidAPI    (needs your RapidAPI key)
 *
 * Enrichment (all feeds): https://api.adsbdb.com  -> flight number, airline, dep/arr (IATA).
 * Local feed also resolves type/registration from the receiver's own /db/ database; the
 * internet feeds already include registration (r) and ICAO type (t) inline.
 *
 * Quick config:
 *   - ADSB_BASE: base URL of the local receiver data (default "/adsb" via serve.py).
 *       To talk to a CORS-enabled device directly, set window.ADSB_BASE before this script.
 *   - HOME: fallback map centre for internet feeds when no local receiver is available.
 *   - DEFAULT_FEED: which feed to start on.
 *   - window.RADAR_HOME = {lat,lon} overrides HOME; selection is remembered in localStorage.
 */
"use strict";

const ADSB_BASE = (window.ADSB_BASE || "/adsb").replace(/\/$/, "");
const ADSBDB = "https://api.adsbdb.com/v0";
const FEED_PROXY = "/feed";   // serve.py allow-listed proxy for CORS-less internet feeds

// Fallback scope centre (used by internet feeds if there is no local receiver to ask).
const HOME = window.RADAR_HOME || { lat: 54.76, lon: -6.35 };
const DEFAULT_FEED = "local";

// ---- feed registry --------------------------------------------------------
// Each feed: kind ("dump1090" local | "readsb" internet), how to build the request,
// which JSON key holds the aircraft array, and whether registration/type come inline.
const FEEDS = {
  local: {
    label: "Local receiver",
    kind: "dump1090",
    array: "aircraft",
    inlineDb: false,
    usesLocalReceiver: true,
    build: () => ({ url: `${ADSB_BASE}/data/aircraft.json` }),
  },
  airplaneslive: {
    label: "airplanes.live (internet)",
    kind: "readsb",
    array: "ac",
    inlineDb: true,
    build: (lat, lon, nm) => ({
      url: `https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${clampNm(nm)}`,
    }),
  },
  adsblol: {
    label: "adsb.lol (internet)",
    kind: "readsb",
    array: "ac",
    inlineDb: true,
    proxy: true, // adsb.lol sends no CORS header, so route through serve.py
    build: (lat, lon, nm) => ({
      url: `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${clampNm(nm)}`,
    }),
  },
  adsbexchange: {
    label: "ADSBExchange (RapidAPI key)",
    kind: "readsb",
    array: "ac",
    inlineDb: true,
    proxy: true, // forward via serve.py so the key/host headers are applied reliably
    needsKey: true,
    build: (lat, lon, nm) => ({
      url: `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${clampNm(nm)}/`,
      headers: {
        "X-RapidAPI-Key": state.rapidKey || "",
        "X-RapidAPI-Host": "adsbexchange-com1.p.rapidapi.com",
      },
    }),
  },
};

function clampNm(nm) { return Math.max(1, Math.min(250, Math.ceil(nm))); }

// ---- tunables -------------------------------------------------------------
const RANGES_MI = [12.5, 25, 50, 100, 200];   // zoom steps
const DEFAULT_RANGE_IDX = 2;                   // 50 miles
const POLL_MS = 1000;                           // device refresh is ~1Hz
const STALE_SEC = 15;                            // dim aircraft not seen for this long
const DROP_SEC = 75;                             // remove entirely
const MOVING_MIN_GS = 50;                        // kts; below this a target counts as not "moving"
const LOCK_MAX_MS = 10 * 60 * 1000;              // auto-release a user lock after 10 minutes
const DR_MAX_SEC = 4;                            // cap dead-reckoning extrapolation
const SWEEP_PERIOD_MS = 4000;                    // sweep revolution time
const PAINT_DECAY_MS = 1100;                     // how fast a painted target fades after the sweep passes
const MI_PER_DEG_LAT = 69.172;                   // statute miles per degree latitude
const KT_TO_MI_PER_SEC = 1.15078 / 3600;         // knots -> statute miles/second
const MI_TO_NM = 1 / 1.15078;                    // statute miles -> nautical miles

const THEMES = {
  green:  { dim: "#0a3d12", mid: "#1f9c3a", hot: "#7dff8e", base: "#33ff66" },
  orange: { dim: "#3d2400", mid: "#b86b00", hot: "#ffd27d", base: "#ffb000" },
  blue:   { dim: "#06324d", mid: "#1f7fb8", hot: "#bfe9ff", base: "#33ccff" },
};

// ---- state ----------------------------------------------------------------
const LS = window.localStorage;
const state = {
  feedId: (LS && LS.getItem("radar.feed")) || DEFAULT_FEED,
  rapidKey: (LS && LS.getItem("radar.rapidkey")) || "",
  receiver: { lat: HOME.lat, lon: HOME.lon },  // scope centre
  homeKnown: false,                            // set true once a local receiver is located
  aircraft: new Map(),     // hex -> record
  rangeIdx: DEFAULT_RANGE_IDX,
  theme: "green",
  persistence: 55,         // phosphor burn amount; fixed default (higher = longer burn)
  closestHex: null,
  lockedHex: null,         // user-selected focus (click/touch); overrides auto-pick
  lockTime: 0,             // when the current lock was set (for the 10-min auto-release)
  lastPollOk: 0,
  lastPollTry: 0,
  pollError: null,
  coast: null,             // {coast:[[ [lon,lat],.. ]], lake:[...] }
  ctr: null,               // UK control zones: [[ [lon,lat],.. ]] closed rings
  airports: null,          // [{name,code,lat,lon,cls}] cls 2=large 1=medium 0=airfield
};
if (!FEEDS[state.feedId]) state.feedId = DEFAULT_FEED;

// fetch() that always rejects after `timeoutMs` instead of hanging forever, so a
// stalled receiver/feed/enrichment endpoint can never wedge a long-running kiosk.
const FETCH_TIMEOUT_MS = 8000;
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Bounded TTL cache: caps entry count (oldest-inserted evicted) and expires
// entries so a kiosk running for weeks never grows without bound. Negative
// (null) results expire sooner so a transient lookup failure is retried, not
// cached forever.
function makeCache(maxEntries, posTtlMs, negTtlMs) {
  const m = new Map();  // key -> {v, exp}
  return {
    has(k) {
      const e = m.get(k);
      if (!e) return false;
      if (Date.now() > e.exp) { m.delete(k); return false; }
      return true;
    },
    get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      if (Date.now() > e.exp) { m.delete(k); return undefined; }
      return e.v;
    },
    set(k, v) {
      m.set(k, { v, exp: Date.now() + (v == null ? negTtlMs : posTtlMs) });
      if (m.size > maxEntries) m.delete(m.keys().next().value); // evict oldest
    },
  };
}

const dbShardCache = new Map();   // prefix -> data (or null); bounded (finite shards)
const dbShardInflight = new Map();
// hex -> {r,t,desc} | null  (resolved aircraft); bounded + TTL for long uptimes
const hexCache = makeCache(4000, 24 * 3600 * 1000, 10 * 60 * 1000);
const hexInflight = new Set();
let typeTable = null;
let friendlyTypes = null;          // ICAO designator -> "Boeing 787-9 Dreamliner"
// callsign -> route | null; bounded + TTL (routes go stale across days)
const routeCache = makeCache(4000, 12 * 3600 * 1000, 15 * 60 * 1000);
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
// Locate the scope centre. Local feed asks the receiver; internet feeds use HOME
// (or the last known local receiver position, so switching keeps you centred).
async function loadReceiver() {
  if (!FEEDS[state.feedId].usesLocalReceiver) {
    state.receiver = { lat: HOME.lat, lon: HOME.lon };
    return;
  }
  try {
    const r = await fetchWithTimeout(`${ADSB_BASE}/data/receiver.json`, { cache: "no-store" });
    const j = await r.json();
    if (typeof j.lat === "number" && typeof j.lon === "number") {
      state.receiver = { lat: j.lat, lon: j.lon };
      state.homeKnown = true;
    }
  } catch (e) { /* keep default/HOME */ }
}

function feedUrl(feed, built) {
  // route CORS-less internet feeds through serve.py's allow-listed proxy
  if (feed.proxy) return `${FEED_PROXY}?url=${encodeURIComponent(built.url)}`;
  return built.url;
}

let pollInFlight = false;
async function poll() {
  if (pollInFlight) return;   // single-flight: never let polls stack up on a slow link
  pollInFlight = true;
  state.lastPollTry = Date.now();
  const feed = FEEDS[state.feedId] || FEEDS.local;
  try {
    if (feed.needsKey && !state.rapidKey) throw new Error("RapidAPI key required");
    const nm = RANGES_MI[state.rangeIdx] * MI_TO_NM;
    const built = feed.build(state.receiver.lat, state.receiver.lon, nm);
    const r = await fetchWithTimeout(feedUrl(feed, built), { cache: "no-store", headers: built.headers || {} });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const now = Date.now();
    const list = j[feed.array];
    if (!Array.isArray(list)) throw new Error("unexpected feed response"); // e.g. {error:…} with HTTP 200
    for (const a of list) {
      if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
      const hex = (a.hex || "").toUpperCase().replace(/^~/, ""); // ~ = TIS-B/non-ICAO
      if (!hex) continue;
      const seenPos = typeof a.seen_pos === "number" ? a.seen_pos : 0;
      let rec = state.aircraft.get(hex);
      if (!rec) { rec = { hex, trail: [] }; state.aircraft.set(hex, rec); }
      rec.callsign = (a.flight || "").trim();
      rec.altRaw = a.alt_baro;
      rec.gs = typeof a.gs === "number" ? a.gs : null;
      rec.category = a.category || rec.category || null;
      if (typeof a.dbFlags === "number") rec.mil = !!(a.dbFlags & 1);
      rec.track = typeof a.track === "number" ? a.track
        : (typeof a.true_heading === "number" ? a.true_heading : null);
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
      // enrichment: internet feeds carry registration/type inline; local feed resolves
      // them from the receiver's own database.
      if (feed.inlineDb) {
        if ((a.t || a.r) && !rec.typeData) {
          rec.typeData = { t: a.t || null, r: a.r || null, desc: a.desc || null };
        }
      } else {
        resolveHex(hex);
      }
      classifyIcon(rec);
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
  } finally {
    // Prune even when a poll fails, so a feed outage doesn't leave ghost tracks
    // lingering on screen for days (the successful-path prune above is a no-op
    // here, but this guarantees cleanup keeps running during an outage too).
    const dropNow = Date.now();
    for (const [hex, rec] of state.aircraft) {
      if (dropNow - rec.lastUpdate > DROP_SEC * 1000) state.aircraft.delete(hex);
    }
    pollInFlight = false;
  }
}

// ---- hex -> type/registration (hierarchical SkyAware db) ------------------
async function fetchShard(prefix) {
  if (dbShardCache.has(prefix)) return dbShardCache.get(prefix);
  if (dbShardInflight.has(prefix)) return dbShardInflight.get(prefix);
  const p = (async () => {
    try {
      const r = await fetchWithTimeout(`${ADSB_BASE}/db/${prefix}.json`, { cache: "force-cache" });
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
    const r = await fetchWithTimeout(`${ADSB_BASE}/db/aircraft_types/icao_aircraft_types.json`, { cache: "force-cache" });
    typeTable = r.ok ? await r.json() : {};
  } catch (e) { typeTable = {}; }
  return typeTable;
}

// Bundled ICAO Doc 8643 lookup: designator -> friendly name (works on every feed,
// incl. the local receiver feed which otherwise only carries the engine code).
async function loadFriendlyTypes() {
  if (friendlyTypes) return friendlyTypes;
  try {
    const r = await fetchWithTimeout("aircraft_types.json", { cache: "force-cache" });
    friendlyTypes = r.ok ? await r.json() : {};
  } catch (e) { friendlyTypes = {}; }
  return friendlyTypes;
}

// Friendly aircraft name for an ICAO type designator, e.g. "B789" -> "Boeing
// 787-9 Dreamliner". Falls back to the raw designator when unknown.
function friendlyType(t) {
  if (!t) return null;
  const code = t.toUpperCase();
  return (friendlyTypes && friendlyTypes[code]) || t;
}

// ---- aircraft kind classification (for the icon) --------------------------
// ICAO type designators that are (almost always) military, so we can show a
// fighter/military icon even when the engine descriptor says "jet/turboprop".
const MIL_TYPES = new Set([
  // fast jets
  "F15", "F16", "F18", "F22", "F35", "EUFI", "TYP", "TOR", "RFAL", "GR4", "A10",
  "F117", "J39", "M2000", "MIR2", "MG29", "MG31", "S37", "SU25", "SU27", "SU30",
  "SU34", "SU57", "T50", "JF17", "F2", "F4", "F5", "AV8B", "HARR", "HAWK", "T38",
  "T6", "PC21", "PC9", "TUC", "TEX2", "L39",
  // military transport / tanker / maritime / AEW
  "C130", "C30J", "K35R", "KC135", "KC10", "KC30", "A400", "C17", "C5M", "C5",
  "C160", "C27J", "C295", "CN35", "P8", "P3", "NIM", "A124", "AN12", "AN24",
  "AN26", "AN70", "IL76", "IL78", "E3CF", "E3TF", "E2", "E6", "E8", "C2", "U2",
  "B52", "B1", "B2", "RC135", "K35E",
  // military helicopters
  "H60", "UH60", "S70", "H64", "AH64", "H47", "CH47", "H53", "CH53", "H46",
  "LYNX", "WG13", "MERL", "EH10", "EH01", "AS32", "PUMA", "NH90", "H1", "AH1",
  "UH1", "TIGR", "EC65", "A129", "KA50", "KA52", "MI24", "MI28", "MI8", "MI17",
  // military UAV
  "RQ4", "MQ9", "MQ1", "MQ4", "GHWK",
]);

// Per-registration icon overrides for local aircraft the feeds mis-type or can't
// resolve. Key = registration with dashes/spaces stripped, upper-case.
const REG_OVERRIDES = new Map([
  ["GJMRT", "piston"],      // Comco Ikarus C42 microlight (Newtownards)
  ["GPSNI", "helicopter"],  // PSNI Eurocopter EC135
  ["GPSNO", "helicopter"],  // PSNI Eurocopter EC145
  ["N980SN", "turboprop"],  // Daher TBM 700 (single turboprop)
]);
// Per-hex (Mode S) icon overrides for airframes absent from every DB and not
// broadcasting a usable type/emitter-category. Key = hex, upper-case.
const HEX_OVERRIDES = new Map([
  ["4624A2", "helicopter"],
]);
const normReg = (r) => (r || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function descToKind(code) {
  // ICAO descriptor code like "L2J" (type / #engines / engine kind)
  if (!code || !/^[A-Z][0-9C][A-Z]$/.test(code)) return null;
  if (code[0] === "H" || code[0] === "G" || code[0] === "T") return "helicopter"; // H=heli, G=gyro, T=tiltrotor
  switch (code[2]) {
    case "J": return "jet";
    case "T": return "turboprop";
    case "P": return "piston";
    case "E": return "piston";       // electric prop — draw as prop
    default: return null;
  }
}

// resolve descriptor code from a type designator via the ICAO type table
async function typeToDesc(t) {
  if (!t) return null;
  const tt = await loadTypeTable();
  const e = tt[t.toUpperCase()];
  return e && e.desc ? e.desc : null;
}

// decide which icon to use for a record; stored on rec.iconKind (async).
async function classifyIcon(rec) {
  const td = rec.typeData || {};
  // explicit overrides win: hex (most specific) then registration
  if (rec.hex && HEX_OVERRIDES.has(rec.hex.toUpperCase())) { rec.iconKind = HEX_OVERRIDES.get(rec.hex.toUpperCase()); return; }
  const reg = normReg(td.r);
  if (reg && REG_OVERRIDES.has(reg)) { rec.iconKind = REG_OVERRIDES.get(reg); return; }
  const t = td.t || null;
  // military wins (so a C-130 reads "military", not "turboprop")
  if (rec.mil || (t && MIL_TYPES.has(t.toUpperCase()))) {
    // distinguish military helicopters
    let code = (td.desc && /^[A-Z][0-9C][A-Z]$/.test(td.desc)) ? td.desc : await typeToDesc(t);
    rec.iconKind = (descToKind(code) === "helicopter" || rec.category === "A7") ? "helicopter" : "military";
    return;
  }
  // ADS-B emitter category A7 == rotorcraft
  if (rec.category === "A7") { rec.iconKind = "helicopter"; return; }
  // engine type from the ICAO descriptor (local desc is the code; else look up by t)
  let code = (td.desc && /^[A-Z][0-9C][A-Z]$/.test(td.desc)) ? td.desc : await typeToDesc(t);
  const kind = descToKind(code);
  if (kind) { rec.iconKind = kind; return; }
  // fallback by emitter category: large/heavy => jet
  if (rec.category === "A3" || rec.category === "A4" || rec.category === "A5" || rec.category === "A6") {
    rec.iconKind = "jet"; return;
  }
  // leave whatever we had (default handled at draw time)
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
      const rec = state.aircraft.get(hex); if (rec) { rec.typeData = out; classifyIcon(rec); }
    } else {
      // local DB doesn't know this airframe (common for GA / police / military);
      // fall back to adsbdb's registration->type lookup so we can still classify it.
      const api = await resolveAircraftApi(hex);
      if (api && (api.t || api.r)) {
        const out = { r: api.r || null, t: api.t || null, desc: null };
        if (out.t) { const tt = await loadTypeTable(); if (tt[out.t.toUpperCase()]) out.desc = tt[out.t.toUpperCase()].desc; }
        hexCache.set(hex, out);
        const rec = state.aircraft.get(hex); if (rec) { rec.typeData = out; classifyIcon(rec); }
      } else {
        hexCache.set(hex, null);
      }
    }
  } catch (e) { hexCache.set(hex, null); }
  finally { hexInflight.delete(hex); }
}

// ---- callsign -> route (adsbdb) -------------------------------------------
// adsbdb hex/reg -> aircraft type fallback when the local DB has no entry.
async function resolveAircraftApi(hex) {
  try {
    const r = await fetchWithTimeout(`${ADSBDB}/aircraft/${encodeURIComponent(hex)}`, { cache: "force-cache" });
    if (!r.ok) return null;   // 404 = unknown airframe
    const j = await r.json();
    const ac = j && j.response && j.response.aircraft;
    if (!ac) return null;
    return { r: ac.registration || null, t: ac.icao_type || null };
  } catch (e) { return null; }
}

async function resolveRoute(callsign) {
  const cs = callsign.trim();
  if (!cs || routeCache.has(cs) || routeInflight.has(cs)) return;
  routeInflight.add(cs);
  try {
    const r = await fetchWithTimeout(`${ADSBDB}/callsign/${encodeURIComponent(cs)}`, { cache: "no-store" });
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

// true while the aircraft's (dead-reckoned) position falls inside the scope circle
function onScope(rec, now) {
  const p = effPos(rec, now);
  const px = milesToPx(p.east, p.north);
  return Math.hypot(px.x - CX, px.y - CY) <= R + 6;
}

function pickClosest() {
  const now = Date.now();
  // A user-locked target keeps the focus, but we release it (and fall back to
  // auto-tracking the closest moving aircraft) once any of these happen:
  //   - it disappears from radar,
  //   - it stops moving / lands (isMoving == false),
  //   - it drifts outside the scope circle, or
  //   - the lock has been held for more than 10 minutes.
  if (state.lockedHex) {
    const locked = state.aircraft.get(state.lockedHex);
    const expired = now - (state.lockTime || 0) > LOCK_MAX_MS;
    if (locked && !expired && isMoving(locked) && onScope(locked, now)) {
      state.closestHex = locked.hex;
      return locked;
    }
    state.lockedHex = null;   // released — resume auto-tracking the closest
  }
  let best = null, bestD = Infinity;
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
  // UK control zones: faint dotted outlines (CTR boundaries)
  if (state.ctr && state.ctr.length) {
    c.save();
    c.strokeStyle = col.mid; c.globalAlpha = 0.55; c.lineWidth = 1;
    c.lineJoin = "round"; c.lineCap = "round";
    c.setLineDash([1, 4]);
    for (const ring of state.ctr) {
      c.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const m = toMiles(ring[i][1], ring[i][0]);
        const p = milesToPx(m.east, m.north);
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.stroke();
    }
    c.restore();
  }
  // airports & airfields as dots (larger/brighter for bigger airports)
  for (const a of state.airports || []) {
    const m = toMiles(a.lat, a.lon);
    const p = milesToPx(m.east, m.north);
    if (Math.hypot(p.x - CX, p.y - CY) > R) continue;
    if (a.cls >= 2) {                       // large airport: bright dot + ring
      c.globalAlpha = 0.95; c.fillStyle = col.base;
      c.beginPath(); c.arc(p.x, p.y, 2.6, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 0.5; c.strokeStyle = col.base; c.lineWidth = 1;
      c.beginPath(); c.arc(p.x, p.y, 4.6, 0, Math.PI * 2); c.stroke();
    } else if (a.cls === 1) {               // medium airport
      c.globalAlpha = 0.8; c.fillStyle = col.mid;
      c.beginPath(); c.arc(p.x, p.y, 2.0, 0, Math.PI * 2); c.fill();
    } else {                                // small airfield: faint, like the coastline
      c.globalAlpha = 0.85; c.fillStyle = col.dim;
      c.beginPath(); c.arc(p.x, p.y, 1.2, 0, Math.PI * 2); c.fill();
    }
  }
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
  sweepAngle = (sweepAngle + dt * (Math.PI * 2) / SWEEP_PERIOD_MS) % (Math.PI * 2);
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

function rgbOf(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(h1, h2, t) {
  const a = rgbOf(h1), b = rgbOf(h2);
  const m = i => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

// 0..1 "paint" intensity for a screen point: 1 just as the sweep crosses it,
// decaying as the sweep moves on, back to ~0 before it comes round again.
function sweepGlow(px, py) {
  const ang = Math.atan2(px - CX, CY - py);          // 0 = north, increasing clockwise
  let behind = (sweepAngle - ang) % (Math.PI * 2);
  if (behind < 0) behind += Math.PI * 2;
  const sinceMs = (behind / (Math.PI * 2)) * SWEEP_PERIOD_MS;
  return Math.exp(-sinceMs / PAINT_DECAY_MS);
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

// ---- aircraft icons (nose points "up" = -y, then rotated to heading) -------
// Airliner / generic jet: swept wings.
function pathJet(g, s) {
  g.beginPath();
  g.moveTo(0, -s * 1.05);          // nose
  g.lineTo(s * 0.16, -s * 0.30);
  g.lineTo(s * 0.98, s * 0.30);    // right wing (swept)
  g.lineTo(s * 0.98, s * 0.48);
  g.lineTo(s * 0.16, s * 0.16);
  g.lineTo(s * 0.14, s * 0.74);
  g.lineTo(s * 0.52, s * 1.02);    // right tailplane
  g.lineTo(s * 0.52, s * 1.14);
  g.lineTo(0, s * 0.86);
  g.lineTo(-s * 0.52, s * 1.14);   // left tailplane
  g.lineTo(-s * 0.52, s * 1.02);
  g.lineTo(-s * 0.14, s * 0.74);
  g.lineTo(-s * 0.16, s * 0.16);
  g.lineTo(-s * 0.98, s * 0.48);   // left wing
  g.lineTo(-s * 0.98, s * 0.30);
  g.lineTo(-s * 0.16, -s * 0.30);
  g.closePath();
  g.fill();
}

// Turboprop / piston: straight (unswept) high-aspect wings + nose prop disc.
function pathProp(g, s) {
  g.beginPath();
  g.moveTo(0, -s * 0.98);          // nose
  g.lineTo(s * 0.13, -s * 0.55);
  g.lineTo(s * 0.13, -s * 0.05);
  g.lineTo(s * 1.05, s * 0.02);    // straight right wing
  g.lineTo(s * 1.05, s * 0.20);
  g.lineTo(s * 0.13, s * 0.30);
  g.lineTo(s * 0.13, s * 0.78);
  g.lineTo(s * 0.46, s * 0.92);    // right tailplane
  g.lineTo(s * 0.46, s * 1.06);
  g.lineTo(0, s * 0.84);
  g.lineTo(-s * 0.46, s * 1.06);   // left tailplane
  g.lineTo(-s * 0.46, s * 0.92);
  g.lineTo(-s * 0.13, s * 0.78);
  g.lineTo(-s * 0.13, s * 0.30);
  g.lineTo(-s * 1.05, s * 0.20);   // straight left wing
  g.lineTo(-s * 1.05, s * 0.02);
  g.lineTo(-s * 0.13, -s * 0.05);
  g.lineTo(-s * 0.13, -s * 0.55);
  g.closePath();
  g.fill();
  // propeller disc at the nose
  g.lineWidth = Math.max(1, s * 0.10);
  g.beginPath();
  g.moveTo(-s * 0.34, -s * 1.02);
  g.lineTo(s * 0.34, -s * 1.02);
  g.stroke();
}

// Military fast jet: sharp delta with twin tail fins.
function pathMil(g, s) {
  g.beginPath();
  g.moveTo(0, -s * 1.18);          // long pointed nose
  g.lineTo(s * 0.10, -s * 0.30);
  g.lineTo(s * 0.86, s * 0.62);    // swept delta right
  g.lineTo(s * 0.74, s * 0.78);
  g.lineTo(s * 0.12, s * 0.34);
  g.lineTo(s * 0.12, s * 0.78);
  g.lineTo(s * 0.40, s * 1.12);    // right tail fin
  g.lineTo(s * 0.24, s * 1.16);
  g.lineTo(0, s * 0.92);
  g.lineTo(-s * 0.24, s * 1.16);   // left tail fin
  g.lineTo(-s * 0.40, s * 1.12);
  g.lineTo(-s * 0.12, s * 0.78);
  g.lineTo(-s * 0.12, s * 0.34);
  g.lineTo(-s * 0.74, s * 0.78);   // swept delta left
  g.lineTo(-s * 0.86, s * 0.62);
  g.lineTo(-s * 0.10, -s * 0.30);
  g.closePath();
  g.fill();
}

// Helicopter: fuselage + tail boom + rotor disc with two blades.
function pathHeli(g, s) {
  // fuselage
  g.beginPath();
  g.moveTo(0, -s * 0.62);
  g.bezierCurveTo(s * 0.40, -s * 0.55, s * 0.38, s * 0.10, s * 0.20, s * 0.34);
  g.bezierCurveTo(s * 0.10, s * 0.46, -s * 0.10, s * 0.46, -s * 0.20, s * 0.34);
  g.bezierCurveTo(-s * 0.38, s * 0.10, -s * 0.40, -s * 0.55, 0, -s * 0.62);
  g.closePath();
  g.fill();
  // tail boom
  g.beginPath();
  g.moveTo(-s * 0.07, s * 0.20);
  g.lineTo(s * 0.07, s * 0.20);
  g.lineTo(s * 0.05, s * 1.06);
  g.lineTo(-s * 0.05, s * 1.06);
  g.closePath();
  g.fill();
  // tail rotor
  g.lineWidth = Math.max(1, s * 0.09);
  g.beginPath();
  g.moveTo(-s * 0.22, s * 1.02);
  g.lineTo(s * 0.10, s * 1.10);
  g.stroke();
  // main rotor disc + blades
  g.save();
  g.globalAlpha *= 0.6;
  g.beginPath();
  g.arc(0, -s * 0.08, s * 1.02, 0, Math.PI * 2);
  g.stroke();
  g.restore();
  g.beginPath();
  g.moveTo(-s * 0.95, -s * 0.78);
  g.lineTo(s * 0.95, s * 0.62);
  g.moveTo(s * 0.95, -s * 0.78);
  g.lineTo(-s * 0.95, s * 0.62);
  g.stroke();
}

function drawPlaneIcon(g, x, y, headingDeg, s, fill, kind) {
  g.save();
  g.translate(x, y);
  if (headingDeg != null) g.rotate(rad(headingDeg));
  g.fillStyle = fill; g.strokeStyle = fill; g.lineCap = "round";
  switch (kind) {
    case "helicopter": pathHeli(g, s); break;
    case "military": pathMil(g, s); break;
    case "turboprop":
    case "piston": pathProp(g, s); break;
    default: pathJet(g, s); break;   // jet / unknown
  }
  g.restore();
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

let hitTargets = [];   // rebuilt each frame: clickable {hex, x, y, r} icons + {hex, isLabel, box} labels
function drawAircraft(now) {
  const col = themeColors();
  const range = RANGES_MI[state.rangeIdx];
  const lineH = 13, charW = 6.4;
  const labels = [];
  hitTargets = [];
  for (const rec of state.aircraft.values()) {
    const p = effPos(rec, now);
    const px = milesToPx(p.east, p.north);
    if (Math.hypot(px.x - CX, px.y - CY) > R + 6) continue; // outside scope
    const stale = rec.seenPos > STALE_SEC || (now - rec.lastUpdate > STALE_SEC * 1000);
    const isClosest = rec.hex === state.closestHex;
    // register the icon as a clickable target (generous radius, matches what's drawn)
    hitTargets.push({ hex: rec.hex, x: px.x, y: px.y, r: isClosest ? 16 : 14 });
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
    // plane icon, pointing along its track. Targets keep a clearly-visible
    // resting brightness (so they stay easy to see and click) and brighten
    // further as the sweep line paints over them, then settle back.
    let glow = stale ? 0 : Math.max(0.45, sweepGlow(px.x, px.y));
    if (isClosest) glow = Math.max(glow, 0.7);        // keep the focus target legible
    const fill = stale ? hexA(col.mid, 0.55) : lerpColor(col.mid, col.hot, glow);
    const s = isClosest ? 10 : 7;
    if (rec.track != null || rec.iconKind) drawPlaneIcon(ctx, px.x, px.y, rec.track, s, fill, rec.iconKind);
    else { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(px.x, px.y, s * 0.45, 0, Math.PI * 2); ctx.fill(); }
    if (isClosest) {
      ctx.strokeStyle = col.hot; ctx.lineWidth = 1.5;
      ctx.strokeRect(px.x - 13, px.y - 13, 26, 26);
      // corner ticks mark a user-locked (pinned) target
      if (rec.hex === state.lockedHex) {
        const L = 13, t = 5;
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.moveTo(px.x + sx * L, px.y + sy * (L - t));
          ctx.lineTo(px.x + sx * L, px.y + sy * L);
          ctx.lineTo(px.x + sx * (L - t), px.y + sy * L);
        }
        ctx.stroke();
      }
    }
    // collect label (declutter: only closest, or all when zoomed in <= 50mi)
    if (isClosest || range <= 50) {
      const td = rec.typeData || hexCache.get(rec.hex) || null;
      const typeStr = (isClosest && td && td.t) ? td.t : null;  // aircraft type, above the flight no.
      const lines = [];
      if (typeStr) lines.push(typeStr);
      lines.push(rec.callsign || rec.hex);
      if (isClosest && typeof rec.altRaw === "number") lines.push(fmtAlt(rec.altRaw));
      const w = Math.max(...lines.map(t => t.length)) * charW;
      labels.push({
        hex: rec.hex,
        ax: px.x + s + 6, ay: px.y - 8 - (typeStr ? lineH : 0), w, h: lines.length * lineH,
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
    // the rendered label is also a clickable target for its aircraft
    hitTargets.push({ hex: lb.hex, isLabel: true,
      box: { x: lb.x - 3, y: lb.y - 2, w: lb.w + 6, h: lb.h + 4 } });
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
let frameErrLogged = false;
function frame(t) {
  // A thrown error must never kill the animation loop: if rendering one frame
  // fails (transient bad data, etc.) we log it once and keep going, so the scope
  // never freezes (a frozen scope also stops click/lock feedback from showing).
  try {
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
  } catch (e) {
    if (!frameErrLogged) { console.error("radar frame error:", e); frameErrLogged = true; }
  }
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
  setText("c-type", td && td.t ? friendlyType(td.t) : null);
  setText("c-reg", td ? td.r : null);
  setText("c-alt", fmtAlt(rec.altRaw));
  setText("c-gs", rec.gs != null ? Math.round(rec.gs) + " kts" : null);
  if (route && (route.depIata || route.arrIata)) {
    setText("c-route", `${route.depIata || "???"} → ${route.arrIata || "???"}`);
  } else { setText("c-route", rec.callsign ? "route unknown" : null); }
  setText("c-pos", typeof rec.distMi === "number" && typeof rec.brng === "number"
    ? `${rec.distMi.toFixed(1)} mi · ${Math.round(rec.brng)}° ${compass(rec.brng)}`
    : null);
}

// ---- controls -------------------------------------------------------------
function applyTheme() {
  document.body.dataset.theme = state.theme;
  coastKey = "";
}

// cycle scope colour green -> orange -> blue -> green (bound to the "c" key)
function cycleTheme() {
  const order = Object.keys(THEMES);
  state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
  applyTheme();
}
function zoom(dir) {
  const prev = state.rangeIdx;
  state.rangeIdx = Math.max(0, Math.min(RANGES_MI.length - 1, state.rangeIdx + dir));
  if (state.rangeIdx !== prev) {
    coastKey = "";
    // internet feeds query by radius — re-poll so the new range is covered
    if (FEEDS[state.feedId].kind === "readsb") poll();
  }
}

async function switchFeed(id) {
  if (!FEEDS[id]) return;
  state.feedId = id;
  if (LS) LS.setItem("radar.feed", id);
  state.aircraft.clear();
  state.closestHex = null;
  state.lockedHex = null;
  state.lastPollOk = 0;
  state.pollError = null;
  updateFeedUi();
  await loadReceiver();   // re-centre (local receiver vs HOME)
  coastKey = "";          // coastline depends on centre
  await poll();
}

function updateFeedUi() {
  const feed = FEEDS[state.feedId];
  const keyWrap = $("rapidkey-wrap");
  if (keyWrap) keyWrap.style.display = feed.needsKey ? "block" : "none";
  const sel = $("feed-select");
  if (sel && sel.value !== state.feedId) sel.value = state.feedId;
}

function wireControls() {
  $("zoom-in").addEventListener("click", () => zoom(-1));
  $("zoom-out").addEventListener("click", () => zoom(1));
  // "c" cycles the scope colour (ignored while typing in a control)
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "c" || e.key === "C") cycleTheme();
  });
  window.addEventListener("resize", resize);

  // click / tap a target (its icon OR its label) to lock focus on it; auto-pick
  // is suspended until that aircraft drops off radar. Click empty space to release.
  // Hit-tests the exact icons/labels drawn last frame so what you see is what you can
  // click. Press Escape to release too. Bound to "click" (not "pointerdown"): some
  // browser/extension setups never dispatch pointer events to the canvas, whereas the
  // synthesised "click" is reliable everywhere and also avoids selects mid-drag.
  canvas.style.cursor = "crosshair";
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let hit = null, bestD = Infinity;
    for (const t of hitTargets) {
      let d;
      if (t.isLabel) {
        const b = t.box;                       // distance to label rectangle (0 if inside)
        const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
        const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
        d = Math.hypot(dx, dy);
      } else {
        d = Math.hypot(t.x - x, t.y - y) - t.r;   // inside the icon radius => negative
      }
      if (d < bestD) { bestD = d; hit = t; }
    }
    if (hit && bestD <= 6) {        // on (or within 6px of) an icon or its label
      state.lockedHex = hit.hex;    // always select the clicked aircraft (no toggle)
      state.lockTime = Date.now();  // start the 10-minute auto-release timer
    } else {
      state.lockedHex = null;       // clicked clear space => release the lock
    }
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") state.lockedHex = null; });

  // feed selector
  const sel = $("feed-select");
  if (sel) {
    sel.innerHTML = "";
    for (const [id, f] of Object.entries(FEEDS)) {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = f.label;
      sel.appendChild(opt);
    }
    sel.value = state.feedId;
    sel.addEventListener("change", () => switchFeed(sel.value));
  }
  // RapidAPI key
  const key = $("rapid-key");
  if (key) {
    key.value = state.rapidKey;
    key.addEventListener("change", () => {
      state.rapidKey = key.value.trim();
      if (LS) LS.setItem("radar.rapidkey", state.rapidKey);
      if (FEEDS[state.feedId].needsKey) poll();
    });
  }
  updateFeedUi();
}

// ---- boot -----------------------------------------------------------------
async function loadCoast() {
  try {
    const r = await fetchWithTimeout("coastline.geojson", { cache: "force-cache" });
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

// UK control zones (CTR boundaries) as closed [lon,lat] rings, drawn dotted.
async function loadCtr() {
  try {
    const r = await fetchWithTimeout("controlzones.geojson", { cache: "force-cache" });
    const j = await r.json();
    let segs = [];
    for (const f of j.features || []) {
      if (f.properties && f.properties.kind === "ctr") {
        segs = (f.geometry && f.geometry.coordinates) || [];
      }
    }
    state.ctr = segs;
    coastKey = "";   // fold into the cached coast layer on next render
  } catch (e) { /* control zones optional */ }
}

async function loadAirports() {
  try {
    const r = await fetchWithTimeout("airports.json", { cache: "force-cache" });
    const j = await r.json();
    state.airports = Array.isArray(j.airports) ? j.airports : [];
    coastKey = "";   // fold into the cached coast layer on next render
  } catch (e) { /* airports optional */ }
}

async function main() {
  wireControls();
  applyTheme();
  resize();
  // Start the animation loop immediately, before any network I/O, so a dead
  // receiver/feed shows an animated "CONNECTING…/LINK FAIL" scope rather than a
  // blank frozen screen on a kiosk that boots before the network is up.
  requestAnimationFrame(frame);
  loadCoast();
  loadCtr();
  loadAirports();
  loadFriendlyTypes();
  await loadReceiver();   // best-effort scope centre (times out, won't hang boot)
  pollLoop();
}

// Self-scheduling 1Hz poll: waits for each poll to settle before scheduling the
// next, so polls never overlap or pile up (paired with poll()'s single-flight
// guard, which also covers the manual poll() calls from the controls).
function pollLoop() {
  poll().finally(() => setTimeout(pollLoop, POLL_MS));
}
main();
