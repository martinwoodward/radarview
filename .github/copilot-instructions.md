# Copilot instructions — radarview

Retro green-phosphor CRT "radar scope" webpage that shows live aircraft overhead, fed
by an ADS-B receiver. **Vanilla HTML/CSS/JS, no build step, no npm, no JS dependencies** —
plus a zero-dependency Python 3 launcher/proxy (`serve.py`). Keep it that way.

## Files
- `index.html` — markup + control panel. Optional `window.ADSB_BASE`, `window.RADAR_HOME` overrides.
- `radar.css` — all styling. Themes via `body[data-theme]` CSS vars (green/orange/blue). Responsive: panel stacks under scope in portrait.
- `radar.js` (~700 lines) — all app logic (see map below).
- `serve.py` — static server + reverse proxies. Bind `127.0.0.1:8000` by default.
- `coastline.geojson` — Natural Earth coast+lakes, clipped to British Isles (rendered once to an offscreen canvas).
- `docs-preview.png` — the README hero screenshot. **Update it when major UI changes are made** (see below).
- `README.md` — run-locally / Raspberry Pi kiosk / CORS / feed-sources docs.

## radar.js map
- `FEEDS` registry (~L30-90): `local`, `airplaneslive`, `adsblol`, `adsbexchange`. Each has `kind`, `array` (`"aircraft"` vs `"ac"`), `inlineDb`, `proxy`, `needsKey`, `build()`.
- `state` (~L110-135): `feedId`, `rapidKey`, `homeKnown`. Persisted in localStorage: `radar.feed`, `radar.rapidkey`, plus theme/burn/range.
- `loadReceiver()` / `poll()` / `feedUrl()` (~L90-185): feed-aware. Internet feeds use `HOME`; local uses `receiver.json`.
- `resolveHex()` local SkyAware DB walk; `resolveRoute()` adsbdb.
- `pickClosest()` / `isMoving()`, `drawPlaneIcon()` / `placeLabels()` / `drawAircraft()`, `drawSweep()`, frame loop, `updateHud()`, `switchFeed()` / `updateFeedUi()` / `wireControls()`.

## Key technical facts
- **Receiver**: PiAware/SkyAware at `http://192.168.2.74:8080` (lat 54.76, lon -6.35, N. Ireland). User @martinwoodward has admin access to it.
- **CORS**: device (lighttpd) sends NO `Access-Control-Allow-Origin`. Solve via `serve.py` `/adsb/*` proxy OR enable CORS on the device (README snippet). Pick one.
- `aircraft.json` fields: `hex`, `flight` (space-padded — must `.trim()`), `alt_baro` (can be `"ground"` or missing), `gs` (kt), `track`, `lat`, `lon`, `seen_pos`.
- Local DB walk: `db/<1char>.json` has 5-char-suffix keys + `children` array of 2-char prefixes; `db/<2char>.json` has 4-char-suffix keys. Types: `db/aircraft_types/icao_aircraft_types.json`. Many aircraft legitimately absent → show "—".
- **adsbdb** `https://api.adsbdb.com/v0/callsign/<CALLSIGN>` → flightroute (callsign_iata, airline.name, origin/destination.iata_code). CORS-enabled. Returns `"unknown callsign"` for GA/military.
- **Internet feeds**: airplanes.live `https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}` → `{ac:[...]}`, CORS `*` (direct). adsb.lol `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` same shape but NO CORS → must go through `serve.py` `/feed?url=` proxy. ADSBExchange via RapidAPI needs `X-RapidAPI-Key`/`-Host` headers. **All APIs cap radius at 250 nm.** Community feeds carry inline `r` (reg) and `t` (ICAO type).
- **Rendering**: equirectangular projection to statute miles (east=`(lon-lon0)*cos(lat0)*69.172`, north=`(lat-lat0)*69.172`); canvas Y inverted (north up); haversine for rank. Dead-reckoning between 1 Hz polls (cap `DR_MAX_SEC=4`), not interpolation. Phosphor = per-frame black `fillRect` alpha. Coastline cached via `coastKey` (cache-busts on theme/range/size). DPR-aware (cap 2.5).
- Conic sweep aligned to leading line: `leadAng = atan2(-cos(sweepAngle), sin(sweepAngle))`, brightest at the leading edge.
- Plane icon: silhouette nose at `-y`, rotated by `track`; dot fallback when track null. Closest MOVING plane gets bigger icon + lock box. `isMoving()` excludes `alt_baro==="ground"` and `gs < MOVING_MIN_GS (50)`.
- `placeLabels()` greedily nudges overlapping label boxes (closest placed first).

## serve.py gotchas
- `ThreadingHTTPServer` + `SimpleHTTPRequestHandler`. Device URL is a **class attr** `Handler.device` — do NOT use a module global (causes "global used prior to declaration" SyntaxError).
- `/adsb/*` proxy blocks `..` and absolute paths, validates netloc.
- `/feed?url=` proxy: host-allowlisted via `FEED_HOSTS`, forwards `X-RapidAPI-*` headers, returns `Access-Control-Allow-Origin: *`, 403 for disallowed hosts.

## Validate / test before committing
- `node --check radar.js`
- `python3 -c "import ast;ast.parse(open('serve.py').read())"`
- Playwright (installed ad-hoc, NOT a dep): start `serve.py`, load page, switch feeds, confirm tracks render + closest panel populates, assert no `pageerror`. **Always clean up `node_modules/`, `shots/`, `package*.json` afterward** (they're gitignored, but remove them anyway).
- bash quirk: `kill` rejects a possibly-empty variable; capture the PID and `kill <number>` explicitly.

## Updating the screenshot (do this on major UI changes)
When you make a visible UI change (layout, theme, panel, sweep, icons), refresh `docs-preview.png`:
```bash
cd /Users/martin/src/radarview
npm i -D playwright >/dev/null 2>&1
python3 serve.py --port 8744 >/tmp/serve.log 2>&1 &   # note PID
node -e 'const{chromium}=require("playwright");(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:800},deviceScaleFactor:2});await p.goto("http://127.0.0.1:8744/",{waitUntil:"networkidle"});await p.waitForTimeout(5000);await p.screenshot({path:"docs-preview.png"});await b.close();})();'
kill <PID>; rm -rf node_modules shots package.json package-lock.json
git add docs-preview.png
```

## Conventions
- Commit trailer: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Repo: public `github.com/martinwoodward/radarview`, branch `main`, gh CLI auth = ssh.
- No secrets in the repo. The LAN IP + receiver coords are the user's own data (acceptable).
- Keep zero-dependency: no bundlers, no frameworks, no runtime npm packages.
