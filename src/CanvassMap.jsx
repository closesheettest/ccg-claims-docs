// Canvassing map — "Sales Rabbit"-style door-knocking tool. Lives at ?mode=canvass.
//
// Baseline: the office uploads a list of addresses (geocoded server-side into
// canvass_prospects as status 'iq'); a rep opens this on their phone, sees the
// pins colored by status, taps one, and changes its status (e.g. IQ → Appt).
// v1 just records the status on the pin — no JobNimbus write yet.
import React, { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { supabase } from "./lib/supabase";
import VisitActions from "./VisitActions";

// Fallback used only if the harvest_pin_types config table can't be reached.
// The live pin types (label, color, allowed outcomes, who sees them) are loaded
// from that table so the office can edit them on the admin page.
const FALLBACK_TYPES = [
  { key: "iq", label: "IQ", color: "#2563eb", outcomes: ["iq_ni", "appt", "new_roof"] },
  { key: "fb", label: "Facebook", color: "#1877f2", outcomes: ["iq_ni", "appt", "new_roof"] },
  { key: "ai", label: "AI Bot", color: "#0d9488", outcomes: ["iq_ni", "appt", "new_roof"] },
  { key: "appt", label: "Appointment", color: "#16a34a", outcomes: ["no_sit_reschedule", "new_roof"] },
  { key: "no_sit_reschedule", label: "No sit – need to reschedule", color: "#dc2626", outcomes: ["appt", "dead", "new_roof"] },
  { key: "iq_ni", label: "IQ – Not Interested", color: "#f59e0b", outcomes: ["insp_sold", "dead", "new_roof"] },
  { key: "insp", label: "Inspection Lead", color: "#0ea5e9", outcomes: ["insp_sold", "insp_ni", "insp_callback", "dead", "new_roof"] },
  // "Pending (come back)" — statuses the door but KEEPS it on the go-back list
  // (see KEEP_ROUTABLE); a rep can note "talked to them, come back" without it
  // dropping off their route for the day.
  { key: "insp_callback", label: "⏳ Pending (come back)", color: "#eab308", outcomes: ["insp_sold", "insp_ni", "insp_callback", "dead", "new_roof"] },
  { key: "insp_ni", label: "Not Interested", color: "#78716c", outcomes: [], is_terminal: true },
  { key: "insp_pending", label: "Pending signature", color: "#ea580c", outcomes: ["insp_sold", "dead"] },
  { key: "insp_sold", label: "Inspection Sold", color: "#7c3aed", outcomes: [], is_terminal: true },
  { key: "new_roof", label: "New Roof", color: "#0891b2", outcomes: [], is_terminal: true },
  { key: "dead", label: "Dead / DNK", color: "#111827", outcomes: [], is_terminal: true },
];
const UNKNOWN_TYPE = { color: "#64748b", label: "—", outcomes: [] };
// Statuses that RECORD an outcome but keep the door on the go-back list (not
// "resolved") — so a rep can mark it and still return to it later the same day.
const KEEP_ROUTABLE = new Set(["insp_callback"]);

// The street a stop is on, for street-by-street routing. "123 N Main St, Tampa"
// → "n main st". A stop with no parseable street becomes its own micro-group
// (keyed by rounded lat/lng) so it's still routed, just not merged with others.
function streetKey(p) {
  const raw = String(p.address || "").split(",")[0].trim().toLowerCase();
  const s = raw
    .replace(/^\s*\d+[a-z]?\s+/, "")                    // drop the leading house number
    .replace(/\s+(apt|unit|ste|suite|#|lot|bldg)\b.*$/, "") // drop unit/apt
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return s || `~${(p.latitude || 0).toFixed(3)},${(p.longitude || 0).toFixed(3)}`;
}
function houseNum(p) { const m = String(p.address || "").match(/\d+/); return m ? parseInt(m[0], 10) : 0; }
// Break the day's stops into STREET SEGMENTS: group by street name, sort each by
// house number, then split a group wherever consecutive houses jump more than
// GAP_FT apart. That split matters — one street NAME often covers two far-apart
// stretches (a road that resumes across town, or the same name reused in another
// neighbourhood). Left merged, the house-number sort interleaves those distant
// houses and marches the rep out, back, and out again (the "why am I returning to
// this street?" zig-zag). Each returned segment is one real, contiguous stretch,
// already in walking order.
function streetSegments(stops) {
  const GAP_FT = 1200;
  const groups = new Map();
  for (const p of stops) { const k = streetKey(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const segs = [];
  for (const g of groups.values()) {
    const sorted = g.slice().sort((a, b) => houseNum(a) - houseNum(b) || a.latitude - b.latitude || a.longitude - b.longitude);
    let run = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (feetBetween({ lat: a.latitude, lng: a.longitude }, { lat: b.latitude, lng: b.longitude }) > GAP_FT) {
        segs.push(run); run = [b];
      } else run.push(b);
    }
    segs.push(run);
  }
  return segs;
}
// Order the day's stops so the rep FINISHES a street before leaving it, and never
// walks away only to come back. We route whole street segments (never individual
// houses): nearest-segment-first to build a sane order, then a segment-level 2-opt
// that reverses runs of whole streets whenever that shortens the drive. Because the
// 2-opt moves whole segments (never splitting one), a street can never get chopped
// across the route — the old stop-level 2-opt COULD split a street mid-run, which
// is exactly what sent reps back to a street they'd "already done". All distances
// are true feet (haversine), so FL longitude isn't under-counted vs latitude.
function orderStops(start, stops) {
  const segs = streetSegments(stops);
  if (segs.length <= 1) return segs.flat();
  const co = (p) => ({ lat: p.latitude, lng: p.longitude });
  // Nearest-segment-first construction. Each pick also chooses which END of the
  // segment to enter from (rev = walk it high→low), whichever endpoint is closer.
  const remaining = segs.slice();
  const entries = [];
  let cur = { lat: start.lat, lng: start.lng };
  while (remaining.length) {
    let bi = 0, bd = Infinity, rev = false;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const dF = feetBetween(cur, co(s[0])), dL = feetBetween(cur, co(s[s.length - 1]));
      if (dF < bd) { bd = dF; bi = i; rev = false; }
      if (dL < bd) { bd = dL; bi = i; rev = true; }
    }
    const s = remaining.splice(bi, 1)[0];
    entries.push({ seg: s, rev });
    const tail = rev ? s[0] : s[s.length - 1];
    cur = co(tail);
  }
  // Segment-level 2-opt: reversing entries[i..k] flips both their ORDER and each
  // segment's internal direction (you'd traverse that block backwards). Whole
  // streets stay atomic. n = segment count (small — a day is tens of streets), so
  // recomputing the full length per trial is cheap.
  const head = (e) => co(e.rev ? e.seg[e.seg.length - 1] : e.seg[0]);
  const tail = (e) => co(e.rev ? e.seg[0] : e.seg[e.seg.length - 1]);
  const total = (arr) => {
    let t = feetBetween(start, head(arr[0]));
    for (let i = 0; i < arr.length - 1; i++) t += feetBetween(tail(arr[i]), head(arr[i + 1]));
    return t;
  };
  let best = total(entries), improved = true, pass = 0;
  while (improved && pass < 8) {
    improved = false; pass++;
    for (let i = 0; i < entries.length - 1; i++) {
      for (let k = i + 1; k < entries.length; k++) {
        const block = entries.slice(i, k + 1).reverse().map((e) => ({ seg: e.seg, rev: !e.rev }));
        const cand = entries.slice(0, i).concat(block, entries.slice(k + 1));
        const t = total(cand);
        if (t + 1e-6 < best) { entries.splice(0, entries.length, ...cand); best = t; improved = true; }
      }
    }
  }
  const out = [];
  for (const e of entries) { const walk = e.rev ? e.seg.slice().reverse() : e.seg; for (const p of walk) out.push(p); }
  return out;
}

// Order stops by REAL DRIVING distance (the road network), not straight line. This
// is what makes a single-entrance subdivision get worked in ONE pass: by air its
// streets sit near each other and near the outside, so a crow-flies route hops in and
// out of it; by ROAD every interior stop is far from the outside (you can only get in
// one way) but close to its neighbours, so they cluster and stay together.
// Uses OSRM's table service — the same public router the turn-by-turn line already
// hits — to get an NxN driving-time matrix, then nearest-neighbour + 2-opt on it.
// Returns null on ANY failure (server down, rate-limited, too many stops) so the
// caller keeps the instant street-by-street order as a fallback.
async function roadOrder(start, stops) {
  const n = stops.length;
  if (n < 3 || n > 90) return null; // tiny routes don't need it; the table server caps ~100 coords
  const pts = [start, ...stops.map((p) => ({ lat: p.latitude, lng: p.longitude }))];
  const coords = pts.map((p) => `${p.lng},${p.lat}`).join(";");
  try {
    const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`);
    const j = await res.json();
    if (j.code !== "Ok" || !Array.isArray(j.durations)) return null;
    const D = j.durations, N = pts.length;
    const val = (a, b) => (D[a] && D[a][b] != null ? D[a][b] : Infinity);
    // Nearest-neighbour from the start point (index 0).
    const used = new Array(N).fill(false); used[0] = true;
    let cur = 0; const seq = [0];
    for (let k = 1; k < N; k++) {
      let best = -1, bd = Infinity;
      for (let j2 = 1; j2 < N; j2++) if (!used[j2] && val(cur, j2) < bd) { bd = val(cur, j2); best = j2; }
      if (best < 0) for (let j2 = 1; j2 < N; j2++) if (!used[j2]) { best = j2; break; } // unreachable → append
      used[best] = true; seq.push(best); cur = best;
    }
    // 2-opt on the driving matrix to iron out the remaining crossings.
    let improved = true, pass = 0;
    while (improved && pass < 10) {
      improved = false; pass++;
      for (let i = 1; i < seq.length - 1; i++) {
        for (let k = i + 1; k < seq.length; k++) {
          const A = seq[i - 1], B = seq[i], C = seq[k], E = k + 1 < seq.length ? seq[k + 1] : null;
          const before = val(A, B) + (E != null ? val(C, E) : 0);
          const after = val(A, C) + (E != null ? val(B, E) : 0);
          if (after + 1e-6 < before) { let lo = i, hi = k; while (lo < hi) { const t = seq[lo]; seq[lo] = seq[hi]; seq[hi] = t; lo++; hi--; } improved = true; }
        }
      }
    }
    return seq.slice(1).map((idx) => stops[idx - 1]);
  } catch { return null; }
}

// Short date / time for the pin's visit-history timeline (e.g. "7/18" · "2:14 PM").
function fmtMD(iso) { try { return new Date(iso).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }); } catch { return ""; } }
function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); } catch { return ""; } }

// Fields the map needs per pin (status_log is left out — heavy + unused here).
// LITE = everything needed to PLACE a pin + drive the route/actions (identity,
// contact, geo, status). Deliberately drops the heavy fields — chiefly `extra`
// (the whole CSV row as JSON, ~340KB of a 790KB viewport) plus notes/metadata —
// so a 6000-pin viewport ships ~260KB instead of ~790KB (≈3× faster to load).
const PIN_FIELDS_LITE = "id,name,address,city,state,zip,phone,email,latitude,longitude,status,jn_job_id,list_name,status_updated_at,status_by";
// "Worked today" doors show baby blue so other reps see them handled and skip them.
const BABY_BLUE = "#7dd3fc";
// A door counts as worked today only if a REP touched it today — status_by is a
// rep's name, NOT a "JN … sync" (the sync stamps status_updated_at on every synced
// door, which would otherwise baby-blue hundreds of untouched pins).
function workedTodayET(p) {
  if (!p || !p.status_updated_at || !p.status_by || /^JN\b/i.test(p.status_by)) return false;
  const d = new Date(p.status_updated_at);
  if (isNaN(d)) return false;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === today;
}
// The rest, fetched for ONE pin on demand (click / before an action) so the
// detail sheet + booking prefill (extra.phone, extra.orig_appt_sec) still work.
const PIN_DETAIL_FIELDS = "id,notes,extra,list_name,status_updated_at,status_by,upload_id,created_at";
// Range-paginate a Supabase query (PostgREST returns ≤1000/request) up to `cap`.
// `build` must return a FRESH query builder each call. Fetches page 0 first, then
// — only if the result spans more pages — pulls the rest CONCURRENTLY (in fan-out
// batches) instead of one slow round-trip at a time, so a big viewport loads in a
// couple of trips rather than six.
async function sbFetchAll(build, cap) {
  const PAGE = 1000, FAN = 6;
  const first = await build().range(0, PAGE - 1);
  let out = first.data || [];
  if (out.length < PAGE || cap <= PAGE) return out;
  const totalPages = Math.ceil(cap / PAGE);
  for (let start = 1; start < totalPages; start += FAN) {
    const batch = [];
    for (let p = start; p < Math.min(start + FAN, totalPages); p++) {
      batch.push(build().range(p * PAGE, p * PAGE + PAGE - 1).then((r) => r.data || []));
    }
    const rows = (await Promise.all(batch)).flat();
    out = out.concat(rows);
    if (rows.length < batch.length * PAGE) break; // a page came back short → no more rows
  }
  return out;
}

// Gold star for installs (roofs we've already put on) — a read-only reference
// layer every rep (junior + senior) sees. Distinct shape so it never reads as a
// canvassing pin.
const INSTALL_COLOR = "#ca8a04";
const STAR_ICON = L.divIcon({
  className: "harvest-install-star",
  html: `<svg width="24" height="24" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))"><path d="M12 1.8l3 6.1 6.7 1-4.8 4.7 1.1 6.7L12 17.9 6 21l1.1-6.7L2.3 8.9l6.7-1z" fill="${INSTALL_COLOR}" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// Straight-line distance in FEET between two {lat,lng} points (haversine).
function feetBetween(a, b) {
  if (!a || !b) return Infinity;
  const R = 20902231; // earth radius, feet
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const ARRIVE_FT = 400; // must be within this many feet of the stop to status it.
// 400 (was 200) absorbs geocoding error — an address often geocodes to the street
// centroid or parcel corner a few hundred feet off the actual door — plus everyday
// phone-GPS drift. GPS accuracy is credited on top, and there's a manual override.
// "Start my day" routes the most efficient N stops. IQ canvassing is denser work
// (30 doors); inspection go-backs cover more ground per rep (100).
// Only inspection-lead days (juniors — huge volume) route 100 stops. Every other
// kind of day (IQ, No-sit, mixed) routes 30, so it stays local instead of
// sprawling across the metro.
const ROUTE_CAP_DEFAULT = 30, ROUTE_CAP_INSP = 100;
const MAX_ROUTE_MI = 25; // never route a stop more than 25 mi from the start point
const routeCap = (pins) => {
  if (!pins || !pins.length) return ROUTE_CAP_DEFAULT;
  // Any higher-priority work in the pool (IQ / Facebook / AI / No-sit) makes it a
  // senior day → 30. Only a pure inspection-lead day (juniors) routes 100.
  if (pins.some((p) => p.status === "iq" || p.status === "fb" || p.status === "ai" || p.status === "no_sit_reschedule")) return ROUTE_CAP_DEFAULT;
  const insp = pins.filter((p) => p.status === "insp").length;
  return insp >= pins.length / 2 ? ROUTE_CAP_INSP : ROUTE_CAP_DEFAULT;
};

// Colored dot as an L.Marker (divIcon) so it clusters — markerClusterGroup only
// clusters L.Marker, not L.circleMarker.
function dotIcon(color) {
  return L.divIcon({
    className: "harvest-dot",
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}
// Below this zoom the map shows SERVER-side cluster bubbles (aggregated counts)
// instead of downloading thousands of individual pins; at/above it, real pins.
const CLUSTER_ZOOM = 13;
// Seniors work these TWO together — the filter is locked to both (they can't
// narrow to just one).
const SENIOR_STATUSES = ["iq", "no_sit_reschedule"];

// ── Team-trail helpers (office view) ────────────────────────────────────────
function trailMi(a, b) {
  const R = 3958.8, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Drop GPS-jump outliers: a ping that would require >90 mph from the last kept
// one is a bad fix (cell-tower/wifi), so we skip it entirely — keeps the current-
// position dot and trail from teleporting even if a stray ping slipped into the DB.
function dropGpsOutliers(pings) {
  const out = [];
  for (const p of pings) {
    if (out.length) {
      const prev = out[out.length - 1];
      const mi = trailMi([prev.lat, prev.lng], [p.lat, p.lng]);
      const dtH = Math.max((Date.parse(p.at) - Date.parse(prev.at)) / 3.6e6, 1 / 3600);
      if (mi > 0.15 && mi / dtH > 90) continue;
    }
    out.push(p);
  }
  return out;
}
// Split a rep's pings into segments, breaking where two consecutive pings imply
// an IMPOSSIBLE speed (>85 mph) — that's a stale/backgrounded jump, not a drive,
// so we don't connect it (kills the straight line cutting across the whole map).
function trailSegments(pings) {
  const segs = []; let cur = [];
  for (let i = 0; i < pings.length; i++) {
    const p = pings[i], pt = [p.lat, p.lng];
    if (cur.length) {
      const prev = pings[i - 1];
      const mi = trailMi([prev.lat, prev.lng], pt);
      const dtH = Math.max((Date.parse(p.at) - Date.parse(prev.at)) / 3.6e6, 1 / 3600);
      if (mi > 0.25 && mi / dtH > 85) { segs.push(cur); cur = []; }
    }
    cur.push(pt);
  }
  if (cur.length) segs.push(cur);
  return segs;
}
// Snap one segment to the road network (OSRM). Downsamples to ≤24 waypoints so
// the request stays small; returns the straight segment if OSRM is slow/down.
async function snapTrailSegment(seg) {
  if (seg.length < 2) return seg;
  let ws = seg;
  if (seg.length > 24) { const step = Math.ceil(seg.length / 23); ws = seg.filter((_, i) => i % step === 0); if (ws[ws.length - 1] !== seg[seg.length - 1]) ws.push(seg[seg.length - 1]); }
  const coords = ws.map(([lat, lng]) => `${lng},${lat}`).join(";");
  try {
    const j = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`)).json();
    const g = j.routes?.[0]?.geometry?.coordinates;
    if (g && g.length) return g.map(([lng, lat]) => [lat, lng]);
  } catch { /* fall through to straight */ }
  return seg;
}
// Scope selector: a status bucket bigger than this must be narrowed to a REGION
// before the map loads it, so we never pull 200k+ pins at once. Small buckets
// (IQ, no-sit, FB) load statewide as before. Regions = rough Florida boxes
// [[south, west], [north, east]].
const REGION_THRESHOLD = 15000;
const REGIONS = [
  { key: "north", label: "🧭 North",       bounds: [[28.4, -87.7], [31.2, -80.9]] },
  { key: "west",  label: "🌅 West Coast",  bounds: [[25.7, -83.1], [28.6, -81.55]] },
  { key: "east",  label: "🌊 East Coast",  bounds: [[26.4, -81.0], [28.7, -79.8]] },
  { key: "south", label: "🌴 South",       bounds: [[24.3, -82.3], [26.6, -79.9]] },
];

// Persist an in-progress "Start my day" route so a refresh or dropped signal
// never wipes it. Keyed by the rep's link so different reps/devices don't collide.
function daySavedKey() {
  try { const p = new URLSearchParams(window.location.search); return `harvest_day_${p.get("rt") || p.get("admin") || "office"}`; }
  catch { return "harvest_day_x"; }
}
function readSavedDay() {
  try {
    const raw = localStorage.getItem(daySavedKey());
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.route) || !d.route.length) return null;
    // Don't resurrect a stale day (yesterday's route). 18h covers a long day.
    if (d.at && Date.now() - d.at > 18 * 3600 * 1000) { localStorage.removeItem(daySavedKey()); return null; }
    return d;
  } catch { return null; }
}
function clusterDivIcon(n, color) {
  const size = n >= 1000 ? 54 : n >= 250 ? 46 : n >= 50 ? 38 : 32;
  const label = n >= 1000 ? `${(Math.round(n / 100) / 10)}k` : String(n);
  return L.divIcon({
    className: "harvest-cluster",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};opacity:.9;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:${n >= 1000 ? 12 : 12.5}px;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}
const FONT = "'Nunito', system-ui, sans-serif";
const escapeHtml = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Live "you are here" blue dot (Google-Maps style).
const ME_ICON = L.divIcon({
  className: "harvest-me",
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#1d4ed8;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25),0 1px 5px rgba(0,0,0,.5)"></div>`,
  iconSize: [16, 16], iconAnchor: [8, 8],
});
// Rep-generated door — a purple house pin so self-gen leads stand out from the
// uploaded/synced pins. `pulse` = the pin the rep is placing right now.
function selfGenIcon(pulse) {
  return L.divIcon({
    className: "harvest-selfgen",
    html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 2px;transform:rotate(45deg);background:#7c3aed;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)${pulse ? ";animation:hpulse 1.2s ease-out infinite" : ""}"><div style="transform:rotate(-45deg);color:#fff;font-size:13px;font-weight:800;text-align:center;line-height:24px">🏠</div></div>`,
    iconSize: [26, 26], iconAnchor: [13, 24],
  });
}
// Post-inspection go-back visits — a squared badge (distinct from round door dots
// and the self-gen house) in the same color/emoji as the Rep Visit Hub buckets.
const GOBACK_META = {
  damage:    { color: "#b8324f", emoji: "🏚️", label: "Damage",    sub: "Set the PA appointment" },
  no_damage: { color: "#16a34a", emoji: "✅", label: "No-Damage", sub: "Referrals + send certificate" },
  retail:    { color: "#d97706", emoji: "🏠", label: "Retail",    sub: "Schedule a retail options appt" },
};
function gobackIcon(bucket, due) {
  const m = GOBACK_META[bucket] || GOBACK_META.damage;
  const ring = due ? ";box-shadow:0 0 0 3px rgba(250,204,21,.9),0 1px 4px rgba(0,0,0,.5)" : ";box-shadow:0 1px 4px rgba(0,0,0,.5)";
  return L.divIcon({
    className: "harvest-goback",
    html: `<div style="width:24px;height:24px;border-radius:6px;background:${m.color};border:2px solid #fff${ring};display:flex;align-items:center;justify-content:center;font-size:13px">${m.emoji}</div>`,
    iconSize: [24, 24], iconAnchor: [12, 12],
  });
}
// Which go-backs need attention TODAY. result_task_at = a hard booked PA time;
// review_availability = the homeowner's soft day/time preference ("Mon, Wed · 2pm").
function visitDueStatus(v) {
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (v.result_task_at) {
    const dt = new Date(v.result_task_at);
    if (isNaN(dt)) return "none";
    const k = dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return k < todayKey ? "overdue" : k === todayKey ? "today" : "later";
  }
  const s = v.review_availability;
  if (s) {
    const daysPart = String(s).split(" · ")[0] || "";
    const wd = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" }).slice(0, 3).toLowerCase();
    return (/any/i.test(daysPart) || daysPart.toLowerCase().includes(wd)) ? "today" : "flex";
  }
  return "none";
}
function visitWhenLabel(v) {
  if (v.result_task_at) {
    const dt = new Date(v.result_task_at);
    if (!isNaN(dt)) return dt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", hour12: true });
  }
  return v.review_availability || "";
}
// Days since the inspection result was set (how long the go-back has waited).
function visitAgeDays(v) {
  if (!v.result_at) return null;
  const d = Date.parse(v.result_at);
  return isNaN(d) ? null : Math.max(0, Math.floor((Date.now() - d) / 864e5));
}
// A go-back "needs work now" if it's scheduled for today / overdue, OR it's just
// been AGING unworked (most go-backs have no scheduled date — they'd otherwise
// never alert). Returns "overdue" | "today" | "aging" | null.
const GOBACK_AGING_DAYS = 7;
function visitNeedsWork(v) {
  const s = visitDueStatus(v);
  if (s === "overdue" || s === "today") return s;
  if (s === "later") return null;               // has a future scheduled date → not yet
  const age = visitAgeDays(v);
  return age != null && age >= GOBACK_AGING_DAYS ? "aging" : null;
}

export default function CanvassMap() {
  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const clusterLayer = useRef(null); // server-side cluster bubbles (low zoom)
  const routeLayer = useRef(null);
  const navLayer = useRef(null);   // in-app driving route to the current stop
  const locLayer = useRef(null);   // live "you are here" blue dot
  const teamLayer = useRef(null);  // office view: every rep's trail + position
  const selectLayer = useRef(null); // the box being drawn to route an area
  const selectStart = useRef(null); // first corner of the selection box
  const lastPingRef = useRef(0);   // throttle rep location pings
  const lastPosRef = useRef(null); // last GOOD posted position (reject GPS jumps)
  const accessLogged = useRef(false); // stamp map access (billing) once per session
  const zoomHintTimer = useRef(null); // auto-hide the "zoom in" nudge
  const [team, setTeam] = useState([]); // other reps' breadcrumbs (admin only)
  const trailCache = useRef(new Map()); // rep trail key → road-snapped segments
  const trailSnapping = useRef(new Set());
  const [snapTick, setSnapTick] = useState(0); // bump to redraw once a trail is snapped
  // Admin route-history: view a past day's trails (pauses the live poll).
  const [historyMode, setHistoryMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDate, setHistoryDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyReps, setHistoryReps] = useState([]); // per-rep summaries for the panel
  const fitted = useRef(false);
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [selActs, setSelActs] = useState(null);     // office/admin pin sheet: this pin's visit history (null=loading, "err", or rows[])
  const [showStatusEdit, setShowStatusEdit] = useState(false); // admin: reveal the status-change buttons (hidden by default)
  const [noteDraft, setNoteDraft] = useState("");   // editable note on a self-gen pin
  const [savingNote, setSavingNote] = useState(false);
  // Status filter — a Set of selected pin-type keys. Empty = show All. Multi-select
  // so a rep can, e.g., work IQ + No-sit-reschedule together.
  const [sel, setSel] = useState(() => new Set());
  const inFilter = (status) => sel.size === 0 || sel.has(status);
  const toggleSel = (key) => setSel((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const [pinTypes, setPinTypes] = useState(FALLBACK_TYPES);
  const [me, setMe] = useState(null);          // { name, level } once signed in
  const [authError, setAuthError] = useState("");
  const [apptPin, setApptPin] = useState(null); // pin being scheduled → appointment
  const [btrPin, setBtrPin] = useState(null);   // insp pin → back-to-retail appt
  // "Add a house" — a rep in the field drops their own pin on a damaged roof.
  const [adding, setAdding] = useState(false);  // tap-to-place mode armed
  const addingRef = useRef(false);              // map-click reads this (no stale closure)
  const [newPin, setNewPin] = useState(null);   // { lat, lng, checking, check, saving } being placed
  const dropPinRef = useRef(null);              // latest drop handler for the map click
  const newPinLayer = useRef(null);             // temp layer for the pin being placed
  const [installs, setInstalls] = useState([]);        // read-only star layer (jr + sr)
  const [showInstalls, setShowInstalls] = useState(true);
  const [workedPins, setWorkedPins] = useState([]);    // doors worked TODAY (baby blue, not routable)
  const [showWorked, setShowWorked] = useState(true);
  const workedLayer = useRef(null);
  const [selectedInstall, setSelectedInstall] = useState(null);
  const [visits, setVisits] = useState([]);            // rep's post-inspection go-backs (damage/no_damage/retail)
  const [showGobacks, setShowGobacks] = useState(true);
  const [selectedVisit, setSelectedVisit] = useState(null);
  const [gobackCard, setGobackCard] = useState(false); // "Today's go-backs" list open
  const [visitToken, setVisitToken] = useState("");    // token to drive the visit-action endpoints
  const visitsLayer = useRef(null);
  const visitsLoaded = useRef(false);
  // "Start my day" route planner. Restore an in-progress route (survives refresh
  // / lost signal) synchronously from localStorage so it's there on first paint.
  const savedDay = useMemo(() => readSavedDay(), []);
  const [dayMode, setDayMode] = useState(savedDay ? "active" : null);   // null | 'choosing' | 'active'
  const [startPt, setStartPt] = useState(savedDay?.startPt || null);    // {lat,lng} the route starts from
  const [route, setRoute] = useState(() => savedDay?.route || []);      // ordered stops (nearest-first)
  const [stopIdx, setStopIdx] = useState(savedDay ? Math.min(savedDay.stopIdx || 0, savedDay.route.length - 1) : 0);
  const [optimizing, setOptimizing] = useState(false); // fetching the road-distance order in the background
  const [routeGeom, setRouteGeom] = useState(null);    // the route line SNAPPED to roads (OSRM), or null → straight fallback
  const routeGen = useRef(0);                          // bumps on every new base route; a stale road-order result won't apply
  const stopIdxRef = useRef(0);                        // current stop index, for the road-order guard (don't reshuffle after they've started)
  const [myLoc, setMyLoc] = useState(null);            // live GPS (always on while the map is open)
  const [selecting, setSelecting] = useState(false);   // drawing a box to route the doors inside it
  const [zoomHint, setZoomHint] = useState(false);     // tapped Start/Route while zoomed out (clusters, no pins)
  const [round, setRound] = useState(savedDay?.round || 1);             // 1st round, 2nd round, …
  const [resolvedIds, setResolvedIds] = useState(() => new Set(savedDay?.resolved || [])); // pins the rep has STATUSED this session (drop from later rounds)
  const workingRef = useRef(new Set(savedDay?.working || []));          // the ORIGINAL round-1 routed pin ids — later rounds only recycle these, minus statused
  const arrivedRef = useRef(null);                     // { key } — already logged arrival at this stop
  const [panelPos, setPanelPos] = useState(null);      // {left,top} px if dragged, else default bottom-right
  const [ignoreDist, setIgnoreDist] = useState(false); // admin test toggle: skip the distance gate
  const [manualHere, setManualHere] = useState(null);  // stop id the rep confirmed "I'm at the door" (GPS/geocode wrong)
  const [capped, setCapped] = useState(false);         // more pins in view than the cap → "zoom in"
  const [shownCount, setShownCount] = useState(0);     // pins actually drawn after the category filter
  const [dbCounts, setDbCounts] = useState(null);      // TRUE per-status counts (RPC), so chips are right even when the load is capped
  const [showAll, setShowAll] = useState(false);       // office overview: load every pin, ignore viewport
  const [region, setRegion] = useState(null);          // scope a huge bucket to a Florida region before loading
  const [needRegion, setNeedRegion] = useState(false); // huge bucket + no region → prompt to pick one
  const regionRef = useRef(null);                      // load() reads region without a stale closure
  const showAllRef = useRef(false);                    // moveend/load read this without a stale closure
  const loadRef = useRef(null);                        // latest load() for the map moveend handler
  const loadClustersRef = useRef(null);                // latest loadClusters() for the moveend handler
  const clusterRpcOk = useRef(null);                   // null=unknown, false=RPC absent (stop retrying), true=works
  const moveTimer = useRef(null);                      // debounce map moves
  const [clusters, setClusters] = useState([]);        // server-aggregated cluster cells (low zoom)
  const authInfo = useRef(null);                       // {rep, pin_types} resolved once from the token
  const [fillOffer, setFillOffer] = useState(null);    // {available, need} when an IQ day is under a full 30 stops
  const [editingRoute, setEditingRoute] = useState(false); // route-trim sheet open
  const [signingStop, setSigningStop] = useState(null); // pin being signed in the intake tab
  const signingStopRef = useRef(null);                 // for the cross-tab 'signed' listener
  const completeSignRef = useRef(null);                // latest completeSign() for the listeners
  const panelDrag = useRef(null);
  const watchRef = useRef(null);
  const choosingRef = useRef(false);                   // map-click reads this (avoid stale closure)
  const activeDayRef = useRef(false);                  // day in progress → don't reload pins on map move
  const fillPoolRef = useRef([]);                      // wide no-sit pool (fetched on start) to fill a short day
  const shownRef = useRef([]);                         // current on-screen prospects, for routing
  const startFromRef = useRef(null);
  const S = useMemo(() => Object.fromEntries(pinTypes.map((t) => [t.key, t])), [pinTypes]);
  const repName = me?.name || "";
  // Self-gen pins belong to the rep who dropped them. Any rep can SEE the pin,
  // but only its creator (or admin/office) can work it. Match by JobNimbus id,
  // falling back to name. Non-self-gen pins are workable by anyone as before.
  // Detectable on the LIGHT load (no `extra`) via the reserved list name.
  const isSelfGenPin = (p) => !!(p && (p.list_name === "Self-Generated" || (p.extra && typeof p.extra === "object" && p.extra.self_generated)));
  const ownsPin = (p) => {
    if (!isSelfGenPin(p)) return true;
    if (!auth.rt || me?.level === "admin") return true; // office / admin see & work all
    const jn = p.extra?.created_by_jn, nm = p.extra?.created_by;
    if (jn && me?.jn_id) return String(jn) === String(me.jn_id);
    if (nm && me?.name) return nm === me.name;
    return false;
  };
  const pinOwnerName = (p) => (p && p.extra && p.extra.created_by) || "another rep";

  // "View as" — the office can preview exactly what a junior/senior rep sees.
  // effLevel is the level we're rendering as (own level, or the previewed one).
  // visKeys = the pin-type keys that level may see (null = no restriction).
  // Web (desktop) vs mobile — desktop puts the status filters in a right column
  // with upload / JN-sync there; mobile keeps the top chip bar.
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 980px)").matches);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 980px)");
    const on = () => setIsDesktop(mq.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);
  const [viewAs, setViewAs] = useState(null);          // null → office's own full view
  const effLevel = viewAs || me?.level || null;
  const seesAll = !effLevel || effLevel === "admin";
  // Seniors' status filter is fixed to IQ + No-sit — they can't switch to one.
  const selLocked = effLevel === "senior";
  const visKeys = useMemo(() => {
    if (seesAll) return null;
    const canSee = (t) => !((t.visible_levels) || []).length || ((t.visible_levels) || []).includes(effLevel);
    return new Set(pinTypes.filter(canSee).map((t) => t.key));
  }, [seesAll, effLevel, pinTypes]);
  const visTypes = useMemo(() => (visKeys ? pinTypes.filter((t) => visKeys.has(t.key)) : pinTypes), [visKeys, pinTypes]);
  // Statuses that are NOT a door to knock, so "Start my day" and every later round
  // skip them: anything terminal (Inspection Sold, Dead) plus "Pending signature"
  // (the link's already out — waiting on the homeowner, not a stop to re-work).
  const nonRoutableStatuses = useMemo(() => {
    const s = new Set(["insp_pending"]);
    for (const t of pinTypes) if (t.is_terminal) s.add(t.key);
    return s;
  }, [pinTypes]);
  // If we switch to a level that can't see some selected types, drop just those.
  useEffect(() => {
    if (!visKeys) return;
    setSel((prev) => {
      const n = new Set([...prev].filter((k) => visKeys.has(k)));
      return n.size === prev.size ? prev : n;
    });
    /* eslint-disable-next-line */
  }, [visKeys]);

  // Server decides which pins this rep's level may see. Reads the personal link
  // token (?rt=) or the office view-all token (?admin=).
  const auth = (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      return { rt: q.get("rt") || "", admin: q.get("admin") || "" };
    } catch { return { rt: "", admin: "" }; }
  })();

  // Load pins for a viewport (bounds). Without bounds → an initial global sample
  // so the map can fit to wherever the data is; after that, moves load by view.
  //
  // The data lives in Supabase (the JN sync writes it there), so the map reads it
  // DIRECTLY from Supabase — paginating with range requests — instead of routing
  // it through the harvest-pins function (which buffers into one response and hit
  // Netlify's ~6MB limit at scale). The function is only used ONCE, for auth: it
  // resolves the rep's level + pin types from their token.
  async function load(bounds) {
    setLoading(true);
    try {
      // 1) Resolve auth/level once (tiny call).
      if (!authInfo.current) {
        const qs = auth.admin ? `admin=${encodeURIComponent(auth.admin)}` : `rt=${encodeURIComponent(auth.rt)}`;
        const r = await fetch(`/.netlify/functions/harvest-pins?${qs}&authonly=1`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) { setAuthError(j.error || "Couldn't load your Harvesting Map."); setLoading(false); return []; }
        setAuthError("");
        setMe(j.rep || null);
        if (Array.isArray(j.pin_types) && j.pin_types.length) setPinTypes(j.pin_types);
        authInfo.current = { rep: j.rep || {}, pin_types: j.pin_types || [] };
      }
      const { rep, pin_types } = authInfo.current;
      const lvl = rep && rep.level;
      // The pin-type keys this rep's LEVEL may see (same rule the function used).
      const baseKeys = (pin_types || [])
        .filter((t) => lvl === "admin" || !((t.visible_levels) || []).length || ((t.visible_levels) || []).includes(lvl))
        .map((t) => t.key);
      if (!baseKeys.length) { setProspects([]); setInstalls([]); setCapped(false); setLoading(false); return []; }

      // Load ONLY the selected statuses ("only load what's picked"). Empty
      // selection (office "All") = everything the level can see. No region gate —
      // clustering keeps the zoomed-out view cheap; the viewport scopes the rest.
      const effStatuses = sel.size ? [...sel].filter((k) => baseKeys.includes(k)) : baseKeys;
      if (!effStatuses.length) { setProspects([]); setInstalls([]); setClusters([]); setCapped(false); setLoading(false); return []; }

      // 2) Pins + installs, straight from Supabase (range-paginated → no payload cap).
      const showAll = showAllRef.current;
      const CAP = showAll ? 40000 : bounds ? 6000 : 3000;
      const box = (q) => (!showAll && bounds)
        ? q.gte("latitude", bounds.getSouth()).lte("latitude", bounds.getNorth()).gte("longitude", bounds.getWest()).lte("longitude", bounds.getEast())
        : q;
      // NO order-by: sorting the in-view rows (created_at OR id) makes Postgres
      // sort a large result set and TIMES OUT once the table is big (200k+ pins).
      // Un-ordered returns in-bounds rows fast; the map doesn't need them sorted.
      const pins = await sbFetchAll(() => box(
        supabase.from("canvass_prospects").select(PIN_FIELDS_LITE).not("latitude", "is", null).in("status", effStatuses),
      ), CAP);
      const installs = await sbFetchAll(() => box(
        supabase.from("installs").select("id,jnid,address_line,city,product_type,color,latitude,longitude").not("latitude", "is", null),
      ).order("id"), CAP);
      // Doors worked TODAY (any status, so ones that changed off the filter still
      // show) — baby blue, so other reps see them handled. Best-effort.
      const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const worked = await sbFetchAll(() => box(
        supabase.from("canvass_prospects").select(PIN_FIELDS_LITE).not("latitude", "is", null)
          .gte("status_updated_at", `${todayKey}T00:00:00-04:00`).not("status_by", "is", null).not("status_by", "ilike", "JN%"),
      ), CAP).catch(() => []);

      setProspects(pins);
      setInstalls(installs);
      setWorkedPins(worked || []);
      setClusters([]); // entering pin mode → drop any cluster bubbles
      setCapped(pins.length >= CAP || installs.length >= CAP);
      // The initial no-bounds load returns everything (statewide); the map already
      // opens Florida-wide, so we just mark it ready — no fragile fitBounds/size
      // race. Panning/zooming then loads by viewport.
      if (!bounds && !fitted.current) { fitted.current = true; if (map.current) { try { map.current.invalidateSize(); } catch { /* ignore */ } } }
      setLoading(false);
      return pins;
    } catch (e) { setAuthError(e.message || "Network error."); }
    setLoading(false);
    return [];
  }
  loadRef.current = load;
  regionRef.current = region;
  // Jump to a Florida region + scope the load to it (clears the "pick a region"
  // gate). Fitting the map there means the viewport load pulls only that area.
  function pickRegion(key) {
    const r = REGIONS.find((x) => x.key === key);
    if (!r) return;
    regionRef.current = key; setRegion(key); setNeedRegion(false);
    if (map.current) { try { map.current.fitBounds(r.bounds, { padding: [20, 20] }); } catch { /* ignore */ } }
    load(map.current ? map.current.getBounds() : null);
  }
  function clearRegion() { regionRef.current = null; setRegion(null); load(map.current ? map.current.getBounds() : null); }

  // Level defaults: senior → IQ, junior → Inspection Leads, office/admin → All.
  // Set once per level (and when VIEW AS changes); manual chip picks are kept.
  const defaultedFor = useRef(undefined);
  useEffect(() => {
    if (!me && !viewAs) return; // wait until auth resolves
    const key = effLevel || "office";
    if (defaultedFor.current === key) return;
    defaultedFor.current = key;
    regionRef.current = null; setRegion(null);
    // Seniors work IQ + No-sit TOGETHER — not one or the other (filter locked below).
    if (effLevel === "senior") setSel(new Set(SENIOR_STATUSES));
    else if (effLevel === "junior") setSel(new Set(["insp"]));
    else setSel(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effLevel, me, viewAs]);

  // Re-load whenever the selected status changes — we now fetch ONLY what's picked.
  const firstSelRun = useRef(true);
  useEffect(() => {
    if (firstSelRun.current) { firstSelRun.current = false; return; }
    if (fitted.current && loadRef.current) loadRef.current(map.current ? map.current.getBounds() : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // Zoomed-out view: fetch SERVER-aggregated cluster cells for the current box
  // (one grouped query) instead of downloading thousands of pins. Returns true
  // if it rendered clusters, false to fall back to the per-pin load (RPC missing
  // or errored). Respects the rep's level + the active chip filter.
  async function loadClusters(bounds) {
    try {
      if (clusterRpcOk.current === false) return false; // RPC not installed → don't keep retrying
      const info = authInfo.current;
      if (!info || !bounds) return false;
      const { rep, pin_types } = info;
      const lvl = rep && rep.level;
      const baseKeys = (pin_types || [])
        .filter((t) => lvl === "admin" || !((t.visible_levels) || []).length || ((t.visible_levels) || []).includes(lvl))
        .map((t) => t.key);
      if (!baseKeys.length) return false;
      const selArr = [...sel].filter((k) => baseKeys.includes(k));
      const statuses = selArr.length ? selArr : baseKeys;
      const { data, error } = await supabase.rpc("canvass_clusters", {
        min_lat: bounds.getSouth(), min_lng: bounds.getWest(),
        max_lat: bounds.getNorth(), max_lng: bounds.getEast(),
        cells: 48, statuses,
      });
      if (error || !Array.isArray(data)) { clusterRpcOk.current = false; return false; } // RPC not created → fall back to pins for the session
      clusterRpcOk.current = true;
      setProspects([]);   // no individual pins at this zoom
      setInstalls([]);    // installs come back when you zoom in
      setClusters(data);
      setCapped(false);
      setLoading(false);
      return true;
    } catch { return false; }
  }
  loadClustersRef.current = loadClusters;

  useEffect(() => { load(); /* initial global sample; eslint-disable-next-line */ }, []);
  // Re-cluster when the chip filter changes while zoomed out.
  useEffect(() => {
    const m = map.current;
    if (m && fitted.current && !showAllRef.current && m.getZoom() < CLUSTER_ZOOM) loadClusters(m.getBounds());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // Init the Leaflet map once.
  useEffect(() => {
    if (map.current || !mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([27.7, -81.6], 7); // Florida-wide default
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap",
    }).addTo(m);
    map.current = m;
    // "Start my day": while choosing a start point, a map tap starts the route there.
    m.on("click", (e) => {
      if (addingRef.current && dropPinRef.current) { dropPinRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
      if (choosingRef.current && startFromRef.current) { startFromRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
      // Tap empty map to dismiss an open pin/install/visit info sheet. (Marker
      // clicks don't reach the map, so tapping another pin still opens that one.)
      setSelected(null);
      setSelectedInstall(null);
      setSelectedVisit(null);
    });
    newPinLayer.current = L.layerGroup().addTo(m);
    visitsLayer.current = L.layerGroup().addTo(m);
    workedLayer.current = L.layerGroup().addTo(m);
    // Viewport loading — reload the pins in view whenever the map settles (debounced).
    m.on("moveend", () => {
      // Skip refetch when we already hold every pin, while a day is in progress
      // (we loaded a wide radius up front), OR before the initial full-sample load
      // has fit the map — otherwise the default-view moveend races the first load
      // and overwrites it with a tiny-box result.
      if (showAllRef.current || activeDayRef.current || !fitted.current) return;
      clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(async () => {
        // Zoomed out → server cluster bubbles (no per-pin download); zoomed in →
        // individual pins. If the cluster RPC isn't there / fails, fall back to pins.
        if (m.getZoom() < CLUSTER_ZOOM && loadClustersRef.current) {
          const ok = await loadClustersRef.current(m.getBounds());
          if (ok) return;
        }
        if (loadRef.current) loadRef.current(m.getBounds());
      }, 350);
    });
    // Cluster group so a zoomed-out map groups nearby pins into a numbered
    // bubble; zooming in splits them back into individual pins/stars.
    layer.current = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
      chunkedLoading: true,
    }).addTo(m);
    clusterLayer.current = L.layerGroup().addTo(m); // server cluster bubbles (low zoom)
    // Separate layer for the "Start my day" route line + numbered stops (on top).
    routeLayer.current = L.layerGroup().addTo(m);
    navLayer.current = L.layerGroup().addTo(m); // in-app driving route to current stop
    selectLayer.current = L.layerGroup().addTo(m); // route-an-area box
    teamLayer.current = L.layerGroup().addTo(m);   // office: everyone's trails
    locLayer.current = L.layerGroup().addTo(m);    // blue "you are here" (on top)
    // Leaflet computes its size at init; inside a flex layout the container
    // may not have its final size yet, leaving the tiles rendered for a tiny
    // box. Recalc on mount AND whenever the container resizes.
    const recalc = () => m.invalidateSize();
    setTimeout(recalc, 0); setTimeout(recalc, 300);
    const ro = new ResizeObserver(recalc);
    ro.observe(mapEl.current);
    return () => ro.disconnect();
  }, []);

  const mapped = useMemo(
    () => prospects.filter((p) => p.latitude != null && p.longitude != null),
    [prospects],
  );

  // (Re)draw pins whenever the data or the filter changes.
  useEffect(() => {
    const m = map.current, lyr = layer.current;
    if (!m || !lyr) return;
    lyr.clearLayers();
    // Self-generated doors ALWAYS show — even after the status moves off the
    // active filter (e.g. tapping Pending → insp_callback), so a rep's own leads
    // never vanish. (Routing still skips terminal statuses.)
    const shown = mapped.filter((p) => isSelfGenPin(p) || (inFilter(p.status) && (!visKeys || visKeys.has(p.status))));
    // Routing skips doors already worked TODAY — no rep gets re-routed to a door
    // another rep (or they) already handled today.
    shownRef.current = shown.filter((p) => !workedTodayET(p));
    setShownCount(shown.length); // drives the "0 match your filter" hint
    const markers = [];
    const pts = [];
    for (const p of shown) {
      const isSelfGen = isSelfGenPin(p);
      // Always draw a door in its REAL status color — a door statused today (e.g.
      // "New Roof") must READ as New Roof, not a generic baby-blue that hides the
      // outcome from the next rep. Re-knock protection doesn't need the colour: the
      // route builder already skips doors worked today (see shownRef below).
      const color = (S[p.status] || UNKNOWN_TYPE).color;
      const marker = L.marker([p.latitude, p.longitude], { icon: isSelfGen ? selfGenIcon(true) : dotIcon(color) });
      marker.on("click", () => openPin(p));
      markers.push(marker);
      pts.push([p.latitude, p.longitude]);
    }
    // Installs — gold stars, shown to every rep as a reference layer.
    if (showInstalls) {
      for (const it of installs) {
        if (typeof it.latitude !== "number" || typeof it.longitude !== "number") continue;
        const marker = L.marker([it.latitude, it.longitude], { icon: STAR_ICON });
        marker.on("click", () => { setSelected(null); setSelectedInstall(it); });
        markers.push(marker);
      }
    }
    lyr.addLayers(markers); // bulk add → clustered
    if (pts.length && !fitted.current) {
      m.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    }
  }, [mapped, sel, installs, showInstalls, visKeys]);

  // Baby-blue "worked today" layer — doors handled today whose status has since
  // moved OFF the active filter (so the main loop no longer draws them). Read-only
  // reference (like installs), never routed. In-filter worked pins are already
  // baby-blued by the main loop, so skip anything already drawn there.
  useEffect(() => {
    const lyr = workedLayer.current; if (!lyr) return;
    lyr.clearLayers();
    if (!showWorked) return;
    const shownIds = new Set(mapped.map((p) => p.id));
    for (const p of workedPins) {
      if (shownIds.has(p.id)) continue;
      if (typeof p.latitude !== "number" || typeof p.longitude !== "number") continue;
      const marker = L.marker([p.latitude, p.longitude], { icon: dotIcon(BABY_BLUE) });
      marker.on("click", () => openPin(p));
      lyr.addLayer(marker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workedPins, showWorked, mapped]);

  // Draw the server cluster bubbles (low zoom). Tapping one zooms into it.
  useEffect(() => {
    const m = map.current, lyr = clusterLayer.current;
    if (!m || !lyr) return;
    lyr.clearLayers();
    for (const c of clusters) {
      const cy = Number(c.cy), cx = Number(c.cx), n = Number(c.n) || 0;
      if (!Number.isFinite(cy) || !Number.isFinite(cx) || n <= 0) continue;
      const color = (S[c.top_status] || UNKNOWN_TYPE).color;
      const marker = L.marker([cy, cx], { icon: clusterDivIcon(n, color) });
      marker.on("click", () => m.setView([cy, cx], Math.min(19, Math.max(CLUSTER_ZOOM, m.getZoom() + 3))));
      lyr.addLayer(marker);
    }
  }, [clusters, S]);

  // Keep the map-click ref in sync + swap the cursor while placing a pin.
  useEffect(() => {
    addingRef.current = adding;
    const el = map.current?.getContainer();
    if (el) el.style.cursor = adding ? "crosshair" : "";
  }, [adding]);
  // Draw the pin the rep is currently placing (purple, pulsing). Draggable so
  // "wrong house" is a one-second fix — drop it on the right roof and, if they'd
  // already checked, it re-runs the owner lookup for the new spot.
  useEffect(() => {
    const lyr = newPinLayer.current; if (!lyr) return;
    lyr.clearLayers();
    if (!newPin) return;
    const mk = L.marker([newPin.lat, newPin.lng], { icon: selfGenIcon(true), zIndexOffset: 2200, draggable: true, autoPan: true });
    mk.on("dragend", () => { const ll = mk.getLatLng(); runOwnerCheck(ll.lat, ll.lng); }); // re-verify the new roof
    mk.addTo(lyr);
  }, [newPin]);

  // Keep the note editor in sync with whichever self-gen pin is open.
  useEffect(() => { setNoteDraft(selected && typeof selected.notes === "string" ? selected.notes : ""); }, [selected?.id, selected?.notes]);
  // Save a note onto a self-gen pin (only its creator / admin can, gated in the UI).
  async function saveNote() {
    if (!selected) return;
    setSavingNote(true);
    const note = noteDraft.trim();
    const { error } = await supabase.from("canvass_prospects").update({ notes: note }).eq("id", selected.id);
    setSavingNote(false);
    if (error) { alert(error.message); return; }
    setProspects((list) => list.map((x) => (x.id === selected.id ? { ...x, notes: note } : x)));
    setSelected((s) => (s && s.id === selected.id ? { ...s, notes: note } : s));
  }

  // Delete a door the rep self-generated (server verifies it's theirs + self-gen).
  async function deletePin() {
    if (!selected) return;
    if (!window.confirm(`Delete this self-generated door${selected.address ? ` — ${selected.address}` : ""}? This can't be undone.`)) return;
    const id = selected.id;
    try {
      const r = await fetch("/.netlify/functions/harvest-delete-pin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rt: auth.rt, pin_id: id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { alert(d.error || "Couldn't delete the pin."); return; }
      setProspects((list) => list.filter((x) => x.id !== id));
      workingRef.current.delete(id);
      setResolvedIds((s) => { const n = new Set(s); n.delete(id); return n; });
      setRoute((r2) => r2.filter((p) => p.id !== id));
      setSelected(null);
    } catch { alert("Couldn't delete the pin — try again."); }
  }

  async function setStatus(p, newStatus) {
    const nowIso = new Date().toISOString();
    const entry = { at: nowIso, from: p.status, to: newStatus, by: repName || "rep" };
    const log = Array.isArray(p.status_log) ? [...p.status_log, entry] : [entry];
    const patch = { status: newStatus, status_updated_at: nowIso, status_by: repName || null, status_log: log };
    const { error } = await supabase.from("canvass_prospects").update(patch).eq("id", p.id);
    if (error) { alert(error.message); return false; }
    logActivity({ pin_id: p.id, kind: "status", from_status: p.status, to_status: newStatus, ...locAudit(p) });
    // "Pending (come back)" records the status but stays on the go-back list.
    if (!KEEP_ROUTABLE.has(newStatus)) setResolvedIds((s) => new Set(s).add(p.id)); // statused → drops out of later rounds
    setProspects((list) => list.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
    setSelected((s) => (s && s.id === p.id ? { ...s, ...patch } : s));
    return true;
  }

  // Where the rep physically was when they logged an action, and how trustworthy the
  // GPS was. Feeds the office report so couch-canvassing (a whole route statused from
  // one spot) is obvious. loc_flag: 'verified' = at the door; 'gps_off' = phone had no
  // real fix; 'far' = phone was CONFIDENT the rep was well away from the door.
  function locAudit(pin) {
    const accM = myLoc?.acc ?? null;
    const d = (myLoc && pin && typeof pin.latitude === "number")
      ? feetBetween(myLoc, { lat: pin.latitude, lng: pin.longitude }) : null;
    const accFt = accM != null ? Math.min(accM * 3.28084, 400) : 0;
    let flag;
    if (d != null && d - accFt <= ARRIVE_FT) flag = "verified";
    else if (myLoc == null || accM == null || accM > 150) flag = "gps_off";
    else flag = "far";
    return { lat: myLoc?.lat ?? null, lng: myLoc?.lng ?? null, acc_m: accM != null ? Math.round(accM) : null, dist_ft: d != null ? Math.round(d) : null, loc_flag: flag };
  }
  // Log a rep action (visit / status change) for reporting. Non-blocking.
  // The row may carry the location-audit fields (lat/lng/acc_m/dist_ft/loc_flag). If
  // that migration (sql/harvest_location_audit.sql) hasn't run yet those columns don't
  // exist and the insert would 400 — so on that error we retry WITHOUT them, keeping
  // basic reporting alive until the office runs the SQL.
  function logActivity(row) {
    try {
      const full = { rep_name: repName || null, rep_token: auth.rt || null, round, ...row };
      supabase.from("canvass_activity").insert(full).then(({ error }) => {
        if (error && /lat|lng|acc_m|dist_ft|loc_flag|column/i.test(error.message || "")) {
          const { lat, lng, acc_m, dist_ft, loc_flag, ...basic } = full; // eslint-disable-line no-unused-vars
          supabase.from("canvass_activity").insert(basic).then(() => {}, () => {});
        }
      }, () => {});
    } catch { /* ignore */ }
  }

  // ── Start my day ───────────────────────────────────────────────────────
  // Order the on-screen prospect pins nearest-first from a start point (the
  // rep's location or a tapped spot), then walk them one stop at a time.
  useEffect(() => { choosingRef.current = dayMode === "choosing"; activeDayRef.current = dayMode !== null; }, [dayMode]);
  useEffect(() => { stopIdxRef.current = stopIdx; }, [stopIdx]);
  // Persist the in-progress route so a refresh / lost signal keeps it. Cleared
  // when the day ends (dayMode → null via "start over" / finishing the route).
  useEffect(() => {
    try {
      if (dayMode === "active" && route.length) {
        localStorage.setItem(daySavedKey(), JSON.stringify({ v: 1, at: Date.now(), route, stopIdx, round, startPt, resolved: [...resolvedIds], working: [...workingRef.current] }));
      } else if (dayMode === null) {
        localStorage.removeItem(daySavedKey());
      }
    } catch { /* private mode / quota — non-fatal */ }
  }, [dayMode, route, stopIdx, round, startPt, resolvedIds]);
  // Restored a route (refresh / signal loss) → recenter the map on it so the rep
  // sees their stops instead of the whole state.
  useEffect(() => {
    if (!savedDay) return;
    const pts = (savedDay.route || []).filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number").map((p) => [p.latitude, p.longitude]);
    if (!pts.length) return;
    const t = setTimeout(() => { try { map.current?.fitBounds(pts, { padding: [50, 50], maxZoom: 15 }); fitted.current = true; } catch { /* ignore */ } }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Load the rep's post-inspection go-backs once (damage / no-damage / retail),
  // so scheduled follow-ups ride on the same map as fresh doors.
  async function loadVisits() {
    try {
      const r = await fetch("/.netlify/functions/harvest-visits", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rt: auth.rt, lat: myLoc?.lat, lng: myLoc?.lng }),
      });
      const d = await r.json();
      if (d.ok && Array.isArray(d.visits)) setVisits(d.visits.filter((v) => v.latitude != null && v.longitude != null));
      if (d.visit_token) setVisitToken(d.visit_token);
    } catch { /* non-fatal */ }
  }
  useEffect(() => {
    if (visitsLoaded.current || !me || !auth.rt) return;
    visitsLoaded.current = true;
    loadVisits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  // Drive the visit-action endpoints with the visit token (same call shape the
  // Rep Visit Hub uses, so the shared panels behave identically).
  async function visitApi(fn, payload) {
    const r = await fetch(`/.netlify/functions/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: visitToken, ...payload }) });
    const o = await r.json().catch(() => ({}));
    if (!r.ok || !o.ok) { const err = new Error(o.error || "Request failed"); err.body = o; throw err; }
    return o;
  }
  // Close the visit sheet and refresh the list so a just-worked go-back drops off.
  function closeVisit() { setSelectedVisit(null); loadVisits(); }
  // Fold today's / overdue go-backs into the route as stops (worked inline in the
  // route panel via the same VisitActions). Nearest-first from the rep; appends if
  // a day's already running, else starts a go-back route.
  function addGobacksToRoute() {
    const today = visits.filter((v) => visitNeedsWork(v) && v.latitude != null && v.longitude != null);
    if (!today.length) return;
    const stops = today.map((v) => ({
      id: `v_${v.inspection_id}`, latitude: Number(v.latitude), longitude: Number(v.longitude),
      name: v.client_name || v.address, address: v.address, city: v.city, state: v.state, zip: v.zip,
      status: "goback", _visit: v,
    }));
    setGobackCard(false);
    if (dayMode === "active" && route.length) {
      const have = new Set(route.map((s) => s.id));
      const add = stops.filter((s) => !have.has(s.id));
      if (add.length) setRoute((r) => [...r, ...add]);
    } else {
      const from = myLoc || { lat: stops[0].latitude, lng: stops[0].longitude };
      const d2 = (s) => (from.lat - s.latitude) ** 2 + (from.lng - s.longitude) ** 2;
      const ordered = [...stops].sort((a, b) => d2(a) - d2(b));
      setStartPt(from); setRoute(ordered); setStopIdx(0); setRound(1);
      setResolvedIds(new Set()); workingRef.current = new Set(); setDayMode("active");
    }
  }
  // Draw the go-back badges (toggleable).
  useEffect(() => {
    const lyr = visitsLayer.current; if (!lyr) return;
    lyr.clearLayers();
    if (!showGobacks) return;
    for (const v of visits) {
      const mk = L.marker([v.latitude, v.longitude], { icon: gobackIcon(v.bucket, !!visitNeedsWork(v)), zIndexOffset: 500 });
      mk.on("click", () => { setSelected(null); setSelectedInstall(null); setSelectedVisit(v); });
      lyr.addLayer(mk);
    }
  }, [visits, showGobacks]);
  useEffect(() => { signingStopRef.current = signingStop; }, [signingStop]);
  // The intake tab writes localStorage 'harvest_signed' when a signing completes.
  // That 'storage' event fires in THIS tab (a different one) → advance instantly.
  // Fallback: when the rep switches back to the map, re-check the pin in the DB.
  useEffect(() => {
    const onSigned = (stop, status) => completeSignRef.current && completeSignRef.current(stop, status);
    const onStorage = (e) => {
      if (e.key !== "harvest_signed" || !e.newValue) return;
      let sig; try { sig = JSON.parse(e.newValue); } catch { return; }
      const st = signingStopRef.current;
      if (st && sig && String(sig.id) === String(st.id)) onSigned(st, sig.status || "insp_sold");
    };
    const onFocus = async () => {
      const st = signingStopRef.current;
      if (!st) return;
      try {
        const { data } = await supabase.from("canvass_prospects").select("status").eq("id", st.id).single();
        // Signed on the spot / homeowner signed (sold) OR remote link sent (pending)
        // — either way the rep is done here; advance with whatever the pin now is.
        if (data?.status === "insp_sold" || data?.status === "insp_pending") onSigned(st, data.status);
      } catch { /* ignore */ }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // Watch the rep's live location the WHOLE time the map is open — powers the
  // blue "you are here" dot, and the route's within-ARRIVE_FT gate. Keep the last
  // known position on a transient error (don't blank the dot).
  useEffect(() => {
    if (!navigator.geolocation) { setMyLoc(null); return; }
    const id = navigator.geolocation.watchPosition(
      (pos) => setMyLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      () => { /* keep last known */ },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 },
    );
    watchRef.current = id;
    return () => { try { navigator.geolocation.clearWatch(id); } catch { /* ignore */ } };
  }, []);
  // Draw/update the blue "you are here" dot (+ accuracy halo) as GPS moves.
  useEffect(() => {
    const lyr = locLayer.current;
    if (!lyr) return;
    lyr.clearLayers();
    if (!myLoc) return;
    if (myLoc.acc && myLoc.acc < 400) L.circle([myLoc.lat, myLoc.lng], { radius: myLoc.acc, color: "#1d4ed8", weight: 1, opacity: 0.5, fillColor: "#3b82f6", fillOpacity: 0.12, interactive: false }).addTo(lyr);
    L.marker([myLoc.lat, myLoc.lng], { icon: ME_ICON, zIndexOffset: 3000, interactive: false }).addTo(lyr);
  }, [myLoc]);
  // Real reps post their location (~every 60s) so the office team view can trail
  // them. Admin/office links (no rt) don't ping — they only WATCH.
  useEffect(() => {
    if (!myLoc || !auth.rt) return;
    const now = Date.now();
    if (now - lastPingRef.current < 10000) return;
    // Reject a bad GPS fix so it never lands on the map:
    //  • poor accuracy (>150m ⇒ a cell-tower / wifi fallback, not a real GPS lock)
    //  • a teleport — an impossible speed (>90 mph) from the last GOOD ping. The
    //    dt uses real elapsed time, so a genuine drive-then-reopen isn't rejected.
    if (myLoc.acc != null && myLoc.acc > 150) return;
    const prev = lastPosRef.current;
    if (prev) {
      const mi = trailMi([prev.lat, prev.lng], [myLoc.lat, myLoc.lng]);
      const dtH = Math.max((now - prev.at) / 3.6e6, 1 / 3600);
      if (mi > 0.15 && mi / dtH > 90) return;
    }
    lastPingRef.current = now;
    lastPosRef.current = { lat: myLoc.lat, lng: myLoc.lng, at: now };
    fetch("/.netlify/functions/harvest-ping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rt: auth.rt, lat: myLoc.lat, lng: myLoc.lng }) }).catch(() => {});
  }, [myLoc]);
  // Bill it: once a real rep opens the map, stamp their access for the month.
  useEffect(() => {
    if (accessLogged.current || !me || !auth.rt) return;
    accessLogged.current = true;
    fetch("/.netlify/functions/harvest-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rt: auth.rt }) }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  // Office/admin: poll everyone's breadcrumbs every 30s. Paused while viewing a
  // past day's route history (so it doesn't overwrite the loaded trails).
  useEffect(() => {
    if (me?.level !== "admin" || !auth.admin || historyMode) return;
    let live = true;
    const pull = async () => {
      try {
        const r = await fetch(`/.netlify/functions/harvest-team?admin=${encodeURIComponent(auth.admin)}`);
        const j = await r.json().catch(() => ({}));
        if (live && j.ok) setTeam(j.reps || []);
      } catch { /* ignore */ }
    };
    pull();
    const id = setInterval(pull, 5000);
    return () => { live = false; clearInterval(id); };
  }, [me?.level, auth.admin, historyMode]);
  // Draw each rep's trail (road-snapped, jumps broken) + a labelled dot at their
  // latest position. Snapping is async + cached, so a trail is snapped once and
  // reused across the 30s polls; a faint dashed straight line shows until it lands.
  useEffect(() => {
    const lyr = teamLayer.current;
    if (!lyr) return;
    lyr.clearLayers();
    for (const r of team) {
      const pings = dropGpsOutliers((r.pings || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)));
      if (!pings.length) continue;
      const last = pings[pings.length - 1];
      const key = `${r.rep_id || r.name}|${pings.length}|${last.at || ""}`;
      const cached = trailCache.current.get(key);
      if (cached) {
        cached.forEach((seg) => { if (seg.length > 1) L.polyline(seg, { color: "#2563eb", weight: 3.5, opacity: 0.75 }).addTo(lyr); });
      } else {
        const segs = trailSegments(pings);
        segs.forEach((seg) => { if (seg.length > 1) L.polyline(seg, { color: "#2563eb", weight: 2.5, opacity: 0.35, dashArray: "3 7" }).addTo(lyr); });
        if (!trailSnapping.current.has(key)) {
          trailSnapping.current.add(key);
          Promise.all(segs.map(snapTrailSegment)).then((snapped) => {
            trailCache.current.set(key, snapped);
            trailSnapping.current.delete(key);
            if (trailCache.current.size > 80) trailCache.current.delete(trailCache.current.keys().next().value);
            setSnapTick((t) => t + 1);
          }).catch(() => trailSnapping.current.delete(key));
        }
      }
      const label = `${escapeHtml(r.name)}${r.last_action ? " · " + escapeHtml(r.last_action) : ""}`;
      const icon = L.divIcon({
        className: "harvest-rep",
        html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-4px)"><div style="background:#1e3a8a;color:#fff;font-size:10px;font-weight:800;padding:1px 6px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4);margin-bottom:2px">${label}</div><div style="width:14px;height:14px;border-radius:50%;background:#2563eb;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div></div>`,
        iconSize: [1, 1], iconAnchor: [0, 7],
      });
      L.marker([last.lat, last.lng], { icon, zIndexOffset: 2500, interactive: false }).addTo(lyr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, snapTick]);
  // Load a past day's route history into the team view (road-snapped like live).
  async function loadHistory(date) {
    if (!auth.admin) return;
    setHistoryBusy(true);
    try {
      const r = await fetch(`/.netlify/functions/harvest-team-history?admin=${encodeURIComponent(auth.admin)}&date=${encodeURIComponent(date)}`);
      const j = await r.json();
      if (!j.ok) { alert(j.error || "Couldn't load history."); setHistoryBusy(false); return; }
      setHistoryMode(true);
      setHistoryReps(j.reps || []);
      setTeam(j.reps || []);           // reuses the road-snapped trail rendering
      // Fit the map to the day's trails.
      const pts = (j.reps || []).flatMap((rp) => (rp.pings || []).map((p) => [p.lat, p.lng]));
      if (pts.length && map.current) { try { map.current.fitBounds(pts, { padding: [50, 50], maxZoom: 15 }); } catch { /* ignore */ } }
    } catch { alert("Network error loading history."); }
    setHistoryBusy(false);
  }
  function backToLive() { setHistoryMode(false); setHistoryReps([]); setTeam([]); }
  // While in "route an area" mode, drag a box on the map; on release we route the
  // doors inside it. Pointer events cover both touch (phone) and mouse.
  useEffect(() => {
    const el = mapEl.current, m = map.current;
    if (!el || !m || !selecting) return;
    // iOS: without touch-action:none the browser claims a finger-drag as a SCROLL
    // and CANCELS our pointer events mid-drag — the screen moves and no box ever
    // draws. Leaflet's dragging.disable() only stops Leaflet's own panning, not
    // the browser gesture, so set it explicitly for the duration of the drag.
    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = "none";
    const toLatLng = (cx, cy) => { const r = el.getBoundingClientRect(); return m.containerPointToLatLng([cx - r.left, cy - r.top]); };
    const draw = (b) => { selectLayer.current.clearLayers(); L.rectangle(b, { color: "#1d4ed8", weight: 2, dashArray: "6 5", fillColor: "#3b82f6", fillOpacity: 0.12, interactive: false }).addTo(selectLayer.current); };
    const onDown = (e) => {
      selectStart.current = toLatLng(e.clientX, e.clientY);
      // Capture so the moves keep coming to us even if the finger slides off.
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    };
    const onMove = (e) => { if (!selectStart.current) return; e.preventDefault(); draw(L.latLngBounds(selectStart.current, toLatLng(e.clientX, e.clientY))); };
    const onUp = (e) => {
      if (!selectStart.current) return;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      const b = L.latLngBounds(selectStart.current, toLatLng(e.clientX, e.clientY));
      selectStart.current = null;
      finalizeSelection(b);
    };
    const onCancel = () => { selectStart.current = null; selectLayer.current?.clearLayers(); };
    el.addEventListener("pointerdown", onDown, { passive: false });
    el.addEventListener("pointermove", onMove, { passive: false });
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      el.style.touchAction = prevTouchAction;
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting]);

  // Log an "arrival" the first time the rep gets within range of the current stop,
  // so the report can measure time-at-spot (arrival → the outcome tap).
  useEffect(() => {
    if (dayMode !== "active" || !myLoc) return;
    const stop = route[stopIdx];
    if (!stop || typeof stop.latitude !== "number") return;
    const key = `${round}:${stopIdx}:${stop.id}`;
    if (arrivedRef.current === key) return;
    if (feetBetween(myLoc, { lat: stop.latitude, lng: stop.longitude }) <= ARRIVE_FT) {
      arrivedRef.current = key;
      logActivity({ pin_id: stop.id, kind: "arrival", ...locAudit(stop) });
    }
  }, [myLoc, stopIdx, dayMode, route, round]);

  // Snap the whole route line to the ROADS (not crow-flies): ask OSRM for the
  // driving geometry through the start + every stop in order, and draw THAT. Refetch
  // only when the route or start changes (NOT on each stop advance — the numbered
  // circles recolor without re-hitting the router). Falls back to straight segments
  // on any failure or a very long route. Guarded so a stale result can't overwrite a
  // newer route's line.
  const routeGeomGen = useRef(0);
  useEffect(() => {
    const gen = ++routeGeomGen.current;
    if (dayMode !== "active" || route.length < 2) { setRouteGeom(null); return; }
    const stops = route.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number");
    const pts = startPt ? [{ lat: startPt.lat, lng: startPt.lng }, ...stops.map((p) => ({ lat: p.latitude, lng: p.longitude }))]
      : stops.map((p) => ({ lat: p.latitude, lng: p.longitude }));
    if (pts.length < 2 || pts.length > 90) { setRouteGeom(null); return; } // OSRM route waypoint ceiling
    const coords = pts.map((p) => `${p.lng},${p.lat}`).join(";");
    fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`)
      .then((r) => r.json())
      .then((j) => {
        if (routeGeomGen.current !== gen) return; // a newer route replaced this one
        const g = j.routes?.[0]?.geometry?.coordinates;
        setRouteGeom(g && g.length ? g.map(([lng, lat]) => [lat, lng]) : null);
      })
      .catch(() => { if (routeGeomGen.current === gen) setRouteGeom(null); });
  }, [route, startPt, dayMode]);

  // Draw the route ON the map — a line through the stops in order + numbered
  // circles (current = green, visited = grey, upcoming = white). So the rep sees
  // their whole plan here, without leaving for another map.
  useEffect(() => {
    const lyr = routeLayer.current;
    if (!lyr) return;
    lyr.clearLayers();
    navLayer.current?.clearLayers(); // clear any in-app driving route when the stop/route changes
    if (dayMode !== "active" || route.length === 0) return;
    const stopPts = route.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number").map((p) => [p.latitude, p.longitude]);
    // Prefer the road-snapped geometry; fall back to straight segments from the start
    // through each stop until (or unless) the router answers.
    const straight = startPt ? [[startPt.lat, startPt.lng], ...stopPts] : stopPts;
    const snapped = routeGeom && routeGeom.length > 1;
    const linePts = snapped ? routeGeom : straight;
    if (linePts.length > 1) L.polyline(linePts, { color: "#16a34a", weight: 4, opacity: snapped ? 0.85 : 0.6, dashArray: snapped ? null : "6 7" }).addTo(lyr);
    if (startPt) {
      const startIcon = L.divIcon({
        className: "harvest-route-start",
        html: `<div style="width:26px;height:26px;border-radius:50%;background:#0f172a;color:#fff;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.5)">▶</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      });
      L.marker([startPt.lat, startPt.lng], { icon: startIcon, zIndexOffset: 1100 }).addTo(lyr);
    }
    route.forEach((p, i) => {
      if (typeof p.latitude !== "number") return;
      const current = i === stopIdx, done = i < stopIdx;
      const bg = current ? "#16a34a" : done ? "#cbd5e1" : "#fff";
      const fg = current ? "#fff" : done ? "#64748b" : "#16a34a";
      const icon = L.divIcon({
        className: "harvest-route-stop",
        html: `<div style="width:24px;height:24px;border-radius:50%;background:${bg};color:${fg};border:2px solid #16a34a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;box-shadow:0 1px 3px rgba(0,0,0,.4)">${i + 1}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
      });
      L.marker([p.latitude, p.longitude], { icon, zIndexOffset: 1000 }).on("click", () => openPin(p)).addTo(lyr);
    });
  }, [dayMode, route, stopIdx, startPt, routeGeom]);

  function buildRoute(start, pins, cap, skipRadius) {
    const routable = pins.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number" && !nonRoutableStatuses.has(p.status)
      && (skipRadius || feetBetween(start, { lat: p.latitude, lng: p.longitude }) / 5280 <= MAX_ROUTE_MI)); // within 25 mi of the start (unless the box already bounded them)
    const max = cap || routeCap(routable);
    // PRIORITY: a No-sit (already an appointment) outranks an IQ (qualified lead),
    // which outranks a cold Inspection Lead. When the pool is mixed and capped, the
    // higher-priority work makes the cut first (nearest-first within a tier). Then
    // we nearest-neighbour the chosen set so the actual drive is still efficient.
    const TIER = { no_sit_reschedule: 0, iq: 1, fb: 1, ai: 1 };
    const tierOf = (p) => (TIER[p.status] != null ? TIER[p.status] : 2);
    const dist2 = (a, p) => { const dx = a.lat - p.latitude, dy = a.lng - p.longitude; return dx * dx + dy * dy; };
    const rem = routable
      .map((p) => ({ p, t: tierOf(p), d: dist2(start, p) }))
      .sort((a, b) => a.t - b.t || a.d - b.d)
      .slice(0, max)
      .map((x) => x.p);
    // Whole-street ordering: finish a street before moving on, streets never split.
    return orderStops(start, rem);
  }

  // The instant street-by-street route (buildRoute) shows immediately; then this
  // quietly re-orders it by REAL driving distance and swaps in the better order. It's
  // guarded so a slow result can't reshuffle the day out from under the rep: it only
  // applies if no newer route replaced this one (routeGen) AND they haven't started
  // working yet (still on stop 1). Same pins, just a smarter order — ids unchanged.
  async function optimizeByRoad(start, baseStops) {
    if (!start || !baseStops || baseStops.length < 3) return;
    const gen = ++routeGen.current;
    setOptimizing(true);
    const better = await roadOrder(start, baseStops);
    if (routeGen.current === gen) setOptimizing(false);
    if (!better || routeGen.current !== gen || stopIdxRef.current !== 0) return;
    setRoute(better);
    if (map.current && better[0]) map.current.setView([better[0].latitude, better[0].longitude], Math.max(map.current.getZoom(), 15));
  }

  // Tapped Start/Route while zoomed out (only clusters loaded, no pins to route) —
  // flash a hint to zoom in instead of silently doing nothing.
  function nudgeZoom() { setZoomHint(true); clearTimeout(zoomHintTimer.current); zoomHintTimer.current = setTimeout(() => setZoomHint(false), 2600); }

  // ── Route an area: drag a box, route exactly the doors inside it ──────────
  function startSelecting() {
    const m = map.current; if (!m) return;
    setSelecting(true);
    // touchZoom too — on a phone a pinch mid-draw would otherwise zoom the map
    // out from under the box being drawn.
    try { m.dragging.disable(); m.doubleClickZoom.disable(); m.boxZoom.disable(); m.touchZoom.disable(); } catch { /* ignore */ }
  }
  function cancelSelecting() {
    const m = map.current;
    setSelecting(false); selectStart.current = null;
    selectLayer.current?.clearLayers();
    try { m?.dragging.enable(); m?.doubleClickZoom.enable(); m?.boxZoom.enable(); m?.touchZoom.enable(); } catch { /* ignore */ }
  }
  async function finalizeSelection(b) {
    const m = map.current;
    const inBox = (shownRef.current || []).filter((p) =>
      typeof p.latitude === "number" && typeof p.longitude === "number" && b.contains([p.latitude, p.longitude]) && !nonRoutableStatuses.has(p.status));
    cancelSelecting();
    if (!inBox.length) { alert("No doors in that box — draw around some pins."); return; }
    const start = myLoc || { lat: b.getCenter().lat, lng: b.getCenter().lng };
    const r = buildRoute(start, inBox, inBox.length, true); // route EXACTLY these, no 25-mi cap
    if (!r.length) return;
    workingRef.current = new Set(r.map((p) => p.id));
    setStartPt(start); setRoute(r); setStopIdx(0); setRound(1); setResolvedIds(new Set()); setDayMode("active"); setFillOffer(null);
    if (r[0]) m.setView([r[0].latitude, r[0].longitude], 16);
    optimizeByRoad(start, r); // refine to real driving order in the background
    // A short box (e.g. a sparse IQ area) isn't a full day — pull No-sit-reschedule
    // pins near the box and offer to top it up to a full day, same as Start my day.
    const c = b.getCenter(), FR = 0.8;
    fillPoolRef.current = await sbFetchAll(() =>
      supabase.from("canvass_prospects").select(PIN_FIELDS_LITE)
        .eq("status", "no_sit_reschedule").not("latitude", "is", null)
        .gte("latitude", c.lat - FR).lte("latitude", c.lat + FR)
        .gte("longitude", c.lng - FR).lte("longitude", c.lng + FR),
      4000,
    ).catch(() => []);
    if (r.length < ROUTE_CAP_DEFAULT) {
      const fill = availableFill(r);
      setFillOffer(fill.length ? { available: fill.length, need: ROUTE_CAP_DEFAULT - r.length } : null);
    }
  }

  async function startFrom(pt) {
    // Load a GENEROUS radius (~25 mi) around the start — not just the tight
    // on-screen box — so the route can actually reach the cap instead of only
    // routing whatever few pins happened to be loaded in view.
    const R = 0.36;
    const wide = { getNorth: () => pt.lat + R, getSouth: () => pt.lat - R, getEast: () => pt.lng + R, getWest: () => pt.lng - R };
    const loaded = await load(wide);
    const pool = (loaded.length ? loaded : (shownRef.current || [])).filter((p) => inFilter(p.status) && typeof p.latitude === "number" && (!visKeys || visKeys.has(p.status)));
    const r = buildRoute(pt, pool);
    if (!r.length) { alert("No stops near here to route. Zoom to your area or change the filter, then start your day."); setDayMode(null); return; }
    // Round 1's stops ARE the day's working set — later rounds only recycle these.
    workingRef.current = new Set(r.map((p) => p.id));
    setStartPt(pt); setRoute(r); setStopIdx(0); setRound(1); setResolvedIds(new Set()); setDayMode("active");
    optimizeByRoad(pt, r); // refine to real driving order in the background
    // Fill pool: pull a WIDE (~55 mi) net of No-sit-reschedule pins around the
    // start straight from Supabase — so an IQ day can fill up with no-sits even
    // when few are inside the tighter route-loading box.
    const FR = 0.8;
    fillPoolRef.current = await sbFetchAll(() =>
      supabase.from("canvass_prospects").select(PIN_FIELDS_LITE)
        .eq("status", "no_sit_reschedule").not("latitude", "is", null)
        .gte("latitude", pt.lat - FR).lte("latitude", pt.lat + FR)
        .gte("longitude", pt.lng - FR).lte("longitude", pt.lng + FR),
      4000,
    ).catch(() => []);
    // An IQ day that came up short of a full 30 stops isn't a full effort — offer
    // to top it up with No-sit-reschedule visits (their other go-back work).
    const iqDay = pool.length > 0 && pool.filter((p) => p.status === "iq").length >= pool.length / 2;
    if (iqDay && r.length < ROUTE_CAP_DEFAULT) {
      const fill = availableFill(r);
      setFillOffer(fill.length ? { available: fill.length, need: ROUTE_CAP_DEFAULT - r.length } : null);
    } else setFillOffer(null);
    if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 15);
  }
  // No-sit-reschedule pins we could add to a short day (from the wide fill pool if
  // loaded, else whatever's on the map), visible + not already in the given route.
  function availableFill(routePins) {
    const routed = new Set((routePins || route).map((p) => p.id));
    const src = (fillPoolRef.current && fillPoolRef.current.length) ? fillPoolRef.current : mapped;
    return src.filter((p) => p.status === "no_sit_reschedule" && !routed.has(p.id)
      && typeof p.latitude === "number" && (!visKeys || visKeys.has(p.status)));
  }
  // Top up the current day with the nearest No-sit-reschedule visits, up to 30 total.
  function addFillStops() {
    const fill = availableFill(route);
    if (!fill.length) { setFillOffer(null); return; }
    const from = route.length ? { lat: route[route.length - 1].latitude, lng: route[route.length - 1].longitude } : startPt;
    const add = buildRoute(from, fill, Math.max(1, ROUTE_CAP_DEFAULT - route.length));
    if (!add.length) { setFillOffer(null); return; }
    add.forEach((p) => workingRef.current.add(p.id));
    setRoute((cur) => [...cur, ...add]);
    // Some fill pins came from the WIDE pool (beyond the loaded map area) — merge
    // them into prospects so they render as pins + get shownRef for later rounds.
    setProspects((cur) => {
      const have = new Set(cur.map((p) => p.id));
      const extra = add.filter((p) => !have.has(p.id));
      return extra.length ? [...cur, ...extra] : cur;
    });
    setFillOffer(null);
  }
  // Of the original routed pins, how many are still un-statused (i.e. left to work).
  function remainingCount() {
    return [...workingRef.current].filter((id) => !resolvedIds.has(id)).length;
  }
  // Pins available to re-route today = every loaded pin PLUS the current route
  // stops. The route stops matter because a "Pending (come back)" door changes
  // status and the chip filter would drop it from shownRef — but it must stay on
  // the go-back list. Deduped by id; the loaded (freshest) copy wins.
  function dayPoolPins() {
    const m = new Map();
    for (const p of [...route, ...(mapped || [])]) if (p && p.id != null && typeof p.latitude === "number") m.set(p.id, p);
    return [...m.values()];
  }
  // Next round: re-route the ORIGINAL routed pins that haven't been RESOLVED yet
  // (Pending doors stay in), from where the rep is now. 30 → (minus resolved)
  // 25 → … until every door has a final outcome.
  function nextRound() {
    const left = dayPoolPins().filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id));
    if (!left.length) return; // all statused — the done panel shows "all worked"
    const from = myLoc || (route.length ? { lat: route[route.length - 1].latitude, lng: route[route.length - 1].longitude } : startPt);
    const r = buildRoute(from, left, routeCap(left));
    setStartPt(from); setRoute(r); setStopIdx(0); setRound((n) => n + 1); setDayMode("active"); setFillOffer(null);
    if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 15);
    optimizeByRoad(from, r); // refine to real driving order in the background
  }
  // "Re-route from here" — the rep has drifted and the remaining order no longer
  // matches where they're standing. Take every door still left to work today and
  // re-order it from their LIVE GPS, nearest street first, whole streets kept
  // together. No new round, no new pins pulled — just re-anchor what's left so they
  // stop walking away and back. Falls back to the current stop if GPS is blocked.
  const [rerouting, setRerouting] = useState(false);
  function rerouteFromHere() {
    const left = dayPoolPins().filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id));
    if (left.length < 2) return; // nothing meaningful to re-order
    const apply = (from) => {
      const r = buildRoute(from, left, routeCap(left), true); // exactly the day's leftovers, no radius cull
      setRerouting(false);
      if (!r.length) return;
      setStartPt(from); setRoute(r); setStopIdx(0); setDayMode("active"); setFillOffer(null);
      if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 16);
      optimizeByRoad(from, r); // refine to real driving order in the background
    };
    const fallback = () => apply(myLoc || (route[stopIdx] ? { lat: route[stopIdx].latitude, lng: route[stopIdx].longitude } : startPt));
    if (navigator.geolocation) {
      setRerouting(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => apply({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        fallback,
        { enableHighAccuracy: true, timeout: 8000 },
      );
    } else fallback();
  }
  startFromRef.current = startFrom;
  function useMyLocation() {
    if (!navigator.geolocation) { alert("Location isn't available on this device — tap the map to pick a start point."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => startFrom({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("Couldn't get your location. Allow location access, or tap the map to pick a start point."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }
  function advanceStop() {
    setManualHere(null); // the "I'm at the door" override is per-stop
    setStopIdx((i) => {
      const ni = i + 1;
      if (ni < route.length && map.current) map.current.setView([route[ni].latitude, route[ni].longitude], 15);
      return ni;
    });
  }
  // Pins load LITE (no notes/extra/metadata). Pull the rest for ONE pin the
  // moment it's needed — clicked open, or about to be signed / booked — so the
  // detail sheet + booking prefill (extra.phone, extra.orig_appt_sec) work. Merges
  // into the in-memory list too, so a second open is instant. Never blocks the UI.
  async function hydratePin(pin) {
    if (!pin || pin._hydrated) return pin;
    try {
      const { data } = await supabase.from("canvass_prospects").select(PIN_DETAIL_FIELDS).eq("id", pin.id).single();
      const merged = { ...pin, ...(data || {}), _hydrated: true };
      setProspects((list) => list.map((x) => (x.id === pin.id ? { ...x, ...(data || {}), _hydrated: true } : x)));
      return merged;
    } catch { return { ...pin, _hydrated: true }; }
  }
  // The office/admin pin sheet leads with the door's VISIT HISTORY — every knock,
  // who did it, when — so a manager can see at a glance how many times it's been
  // tried without anyone home. Reads canvass_activity for this one pin.
  async function loadPinActivity(pinId) {
    setSelActs(null); setShowStatusEdit(false);
    const pull = (cols) => supabase.from("canvass_activity").select(cols)
      .eq("pin_id", pinId).order("created_at", { ascending: true }).limit(200);
    try {
      // Include the location-audit columns (dist_ft/loc_flag); if that migration
      // hasn't run they don't exist, so fall back to the basic select.
      let { data, error } = await pull("rep_name, kind, to_status, from_status, created_at, dist_ft, loc_flag");
      if (error && /dist_ft|loc_flag|column/i.test(error.message || "")) ({ data, error } = await pull("rep_name, kind, to_status, from_status, created_at"));
      setSelActs(error ? "err" : (data || []));
    } catch { setSelActs("err"); }
  }
  // Open a pin's detail sheet: show it instantly with the LITE data, then fill in
  // notes/extra/etc. once hydrated.
  function openPin(p) {
    setSelectedInstall(null);
    setSelectedVisit(null);
    setSelected(p);
    if (seesAll) loadPinActivity(p.id); else setSelActs(null); // office/admin see the visit log
    hydratePin(p).then((full) => setSelected((s) => (s && s.id === p.id ? { ...s, ...full } : s)));
  }
  // Work the current stop right from the panel: log the visit, apply the outcome
  // (status / not-home / book appt), then move to the next stop — no window to close.
  async function workStop(outcome) {
    const stop = route[stopIdx];
    if (!stop) return;
    // Real leads: "Appt" opens the booking flow (creates the JobNimbus appt).
    // Test pins have no real homeowner/job, so their "Appt" just sets the status.
    if (outcome === "appt" && stop.status !== "test") { setApptPin(await hydratePin(stop)); return; }
    logActivity({ pin_id: stop.id, kind: "visit", to_status: outcome === "nothome" ? "not_home" : outcome, ...locAudit(stop) });
    if (outcome !== "nothome") {
      const ok = await setStatus(stop, outcome);
      if (ok === false) return; // save failed — stay put
    }
    advanceStop();
  }
  // "Sign Inspection" — open the Free Roof Inspection intake prefilled with what we
  // know about this pin (name/phone/address/city/state/zip/email), tagged with the
  // pin id. When the rep finishes signing there, the intake marks this pin sold and
  // pings us to advance (see the storage/focus listeners below). City/State/ZIP are
  // passed too so the intake never re-runs the address lookup on a known address.
  function signInspection(stop, opts = {}) {
    if (!stop) return;
    const p = new URLSearchParams({ intake: "1", harvest_pin: String(stop.id) });
    if (stop.name) p.set("name", stop.name);
    if (stop.phone) p.set("phone", stop.phone);
    if (stop.address) p.set("address", stop.address);
    if (stop.city) p.set("city", stop.city);
    if (stop.state) p.set("state", stop.state);
    if (stop.zip) p.set("zip", stop.zip);
    if (stop.email) p.set("email", stop.email);
    // A rep-generated door → JN lead source "Self Generated".
    if (opts.selfGen || (stop.extra && stop.extra.self_generated)) p.set("source", "Self Generated");
    // Carry the rep so the intake doesn't re-ask (only when signed in as a real rep).
    if (me?.jn_id || me?.email) {
      p.set("rep", me.jn_id || "");
      p.set("repName", me.name || "");
      p.set("repEmail", me.email || "");
    }
    setSigningStop(stop);
    window.open(`/?${p.toString()}`, "_blank", "noopener");
  }
  // The intake resolved this pin (cross-tab signal or focus re-check): reflect it
  // here. status is "insp_sold" (signed on the spot / homeowner signed) or
  // "insp_pending" (remote link sent, awaiting their signature). Either way the
  // rep is done at this door — drop it from later rounds and advance the route.
  function completeSign(stop, status = "insp_sold") {
    if (!stop) return;
    setResolvedIds((s) => new Set(s).add(stop.id));
    setProspects((list) => list.map((x) => (x.id === stop.id ? { ...x, status } : x)));
    setSigningStop(null);
    // Only advance the route if this pin is the stop we're currently on.
    if (route[stopIdx] && route[stopIdx].id === stop.id) advanceStop();
  }
  completeSignRef.current = completeSign;

  // ── Add-a-house (rep self-gen) ──────────────────────────────────────────
  // Arm tap-to-place: the next map tap drops a self-gen pin there.
  function startAddHouse() { setSelected(null); setSelectedInstall(null); setNewPin(null); setAdding(true); }
  function cancelAdd() { setAdding(false); setNewPin(null); }
  // The rep tapped a roof — place the pin and open its sheet (owner check runs
  // when they press "Owner occupied?").
  function dropPin({ lat, lng }) {
    setAdding(false);
    setNewPin({ lat, lng, checking: true, check: null, saving: false });
    map.current?.panTo([lat, lng]);
    runOwnerCheck(lat, lng);   // pull the address + owner right away
  }
  dropPinRef.current = dropPin;
  // "Owner occupied?" — homestead / mailing-address check via the FL cadastral,
  // at a specific spot (so a dragged pin re-checks the house it landed on).
  async function runOwnerCheck(lat, lng) {
    setNewPin((n) => (n ? { ...n, lat, lng, checking: true } : n));
    try {
      const r = await fetch("/.netlify/functions/harvest-owner-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      const d = await r.json();
      setNewPin((n) => (n ? { ...n, checking: false, check: d } : n));
    } catch {
      setNewPin((n) => (n ? { ...n, checking: false, check: { ok: false, found: false, reason: "Couldn't reach the property records — try again." } } : n));
    }
  }
  // Persist the self-gen door as a canvass pin, then route into the chosen action.
  // action: 'sign' | 'retail' | 'pending'. Returns after the pin row exists.
  async function commitSelfGen(action) {
    if (!newPin || newPin.saving) return;
    const c = newPin.check || {};
    setNewPin((n) => ({ ...n, saving: true }));
    try {
      const r = await fetch("/.netlify/functions/harvest-add-pin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rt: auth.rt, lat: newPin.lat, lng: newPin.lng,
          address: c.address?.line1 || "", city: c.address?.city || "", state: c.address?.state || "FL", zip: c.address?.zip || "",
          owner: c.owner || "", homestead: !!c.homestead, verdict: c.verdict || "", parcel_id: c.parcel_id || "",
        }),
      });
      const d = await r.json();
      if (d.duplicate) {
        // A pin was placed here between the check and commit — reflect the block.
        setNewPin((n) => (n ? { ...n, saving: false, check: { ...(n.check || {}), existing: d.existing } } : n));
        return;
      }
      if (!d.ok || !d.pin) { alert(d.error || "Couldn't save the pin."); setNewPin((n) => ({ ...n, saving: false })); return; }
      const pin = d.pin;
      setProspects((list) => [...list, pin]);   // show + persist on the map
      setNewPin(null);
      if (action === "sign") signInspection(pin, { selfGen: true });
      else if (action === "retail") setBtrPin(pin);
      else if (action === "pending") await setStatus(pin, "insp_callback");
    } catch {
      alert("Couldn't save the pin — try again.");
      setNewPin((n) => (n ? { ...n, saving: false } : n));
    }
  }

  function startOver() { routeGen.current++; setOptimizing(false); navLayer.current?.clearLayers(); setDayMode(null); setStartPt(null); setRoute([]); setStopIdx(0); setRound(1); setResolvedIds(new Set()); workingRef.current = new Set(); setPanelPos(null); setSigningStop(null); setFillOffer(null); setEditingRoute(false); }
  // Drop a stop the rep doesn't want to drive to (e.g. it's across the bay). Keeps
  // the current stop stable and re-numbers the rest; the map line redraws.
  function removeStop(id) {
    const curId = route[stopIdx]?.id;
    const next = route.filter((p) => p.id !== id);
    workingRef.current.delete(id);
    setRoute(next);
    const ni = next.findIndex((p) => p.id === curId);
    setStopIdx(ni >= 0 ? ni : Math.min(stopIdx, Math.max(0, next.length - 1)));
  }
  // Drag the route panel so it never blocks the map (pointer events = mouse + touch).
  function panelPointerDown(e) {
    const el = e.currentTarget.closest("[data-daypanel]"); if (!el) return;
    const rect = el.getBoundingClientRect();
    const parent = (el.offsetParent || el.parentElement).getBoundingClientRect();
    panelDrag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, parent, w: rect.width, h: rect.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  }
  function panelPointerMove(e) {
    const d = panelDrag.current; if (!d) return;
    const left = Math.max(4, Math.min(d.parent.width - d.w - 4, e.clientX - d.parent.left - d.dx));
    const top = Math.max(4, Math.min(d.parent.height - d.h - 4, e.clientY - d.parent.top - d.dy));
    setPanelPos({ left, top });
  }
  function panelPointerUp(e) { panelDrag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
  const addrOf = (p) => encodeURIComponent([p.address, p.city, p.state, p.zip].filter(Boolean).join(", ") || `${p.latitude},${p.longitude}`);
  // In-app directions: draw the driving route from the rep's location to the stop
  // ON our map (road-following via OSRM, best-effort; straight line if it's slow/
  // down). Keeps the rep in the app for the short canvass hops.
  async function navRoute(stop) {
    const from = myLoc || startPt;
    const lyr = navLayer.current, m = map.current;
    if (lyr) lyr.clearLayers();
    if (!from || !m) { if (m) m.setView([stop.latitude, stop.longitude], 16); return; }
    const straight = [[from.lat, from.lng], [stop.latitude, stop.longitude]];
    if (lyr) L.polyline(straight, { color: "#1d4ed8", weight: 5, opacity: 0.85 }).addTo(lyr);
    m.fitBounds(straight, { padding: [55, 55], maxZoom: 17 });
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${stop.longitude},${stop.latitude}?overview=full&geometries=geojson`;
      const j = await (await fetch(url)).json();
      const g = j.routes?.[0]?.geometry?.coordinates;
      if (g && g.length && lyr) {
        const latlngs = g.map(([lng, lat]) => [lat, lng]);
        lyr.clearLayers();
        L.polyline(latlngs, { color: "#1d4ed8", weight: 5, opacity: 0.9 }).addTo(lyr);
        m.fitBounds(latlngs, { padding: [55, 55], maxZoom: 17 });
      }
    } catch { /* keep the straight line */ }
  }

  // Counts from the LOADED pins — a fallback only. The load is capped + un-ordered,
  // so a big single-status upload (e.g. 40k inspection leads) can push smaller
  // buckets (IQ) out of the sample and show "(0)". The RPC below gives the truth.
  const loadedCounts = useMemo(() => {
    const c = {};
    for (const p of prospects) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [prospects]);
  // TRUE per-status counts, straight from the DB (one grouped query). Refreshed
  // when the auth/level resolves and after each load. Falls back to loadedCounts
  // until the RPC (sql/canvass_status_counts.sql) exists.
  useEffect(() => {
    let live = true;
    // Fetched ONCE — the chip totals are global, not per-view, so re-fetching on
    // every load just piled scans onto an already-strained DB.
    supabase.rpc("canvass_status_counts")
      .then(({ data }) => { if (live && Array.isArray(data)) setDbCounts(Object.fromEntries(data.map((r) => [r.status, Number(r.n)]))); })
      .catch(() => { /* RPC not created yet → keep loadedCounts */ });
    return () => { live = false; };
  }, []);
  const counts = dbCounts || loadedCounts;
  const notMapped = prospects.length - mapped.length;

  // Bad/missing link → don't show any pins, just tell them what to do.
  if (authError) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
        <div style={{ maxWidth: 360, textAlign: "center", background: "#fff", borderRadius: 16, padding: "28px 24px", boxShadow: "0 2px 12px rgba(0,0,0,.1)" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🔒</div>
          <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>Harvesting Map</div>
          <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.5 }}>{authError}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", fontFamily: FONT, background: "#f1f5f9" }}>
      {/* Header */}
      <div style={{ padding: "10px 14px", background: "#0f172a", color: "#fff", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 16, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }}>🌾 Harvesting Map</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{mapped.length} pins</div>
        {me?.level === "admin" && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <a href="/?mode=harvestupload" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>📥 Load Leads</a>
            <a href="/?mode=harvestlinks" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>🔗 Rep Links</a>
            <a href="/?mode=harvestadmin" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>🎛️ Pin Types</a>
            <a href="/?mode=harvestjnsync" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>🔄 JN Sync</a>
            <a href="/?mode=harvestreport" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>📊 Reports</a>
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {me?.level === "admin" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,.08)", borderRadius: 999, padding: 2 }}
              title="Preview exactly what a rep at this level sees on the map">
              <span style={{ fontSize: 10, fontWeight: 800, color: "#94a3b8", padding: "0 4px", textTransform: "uppercase", letterSpacing: "0.04em" }}>View as</span>
              {[["admin", "Office"], ["senior", "Sr"], ["junior", "Jr"]].map(([lv, lbl]) => {
                const on = (viewAs || "admin") === lv;
                return (
                  <button key={lv} type="button" onClick={() => setViewAs(lv === "admin" ? null : lv)}
                    style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", borderRadius: 999, padding: "3px 9px", border: "none", background: on ? "#7c3aed" : "transparent", color: on ? "#fff" : "#cbd5e1" }}>{lbl}</button>
                );
              })}
            </div>
          )}
          {me?.level === "admin" && (
            <button type="button"
              onClick={() => {
                const next = !showAll;
                setShowAll(next); showAllRef.current = next;
                // Turning ON → zoom out to the whole state so every pin is in view
                // (reliable setView, not a fitBounds guess).
                if (next && map.current) { try { map.current.setView([27.7, -81.6], 7); } catch { /* ignore */ } }
                load(next ? null : (map.current ? map.current.getBounds() : null));
              }}
              title="Load every pin at once (whole-state overview). Off = load by map area for speed at scale."
              style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", borderRadius: 999, padding: "3px 10px", border: "1px solid", borderColor: showAll ? "#16a34a" : "#475569", background: showAll ? "#16a34a" : "transparent", color: showAll ? "#fff" : "#cbd5e1" }}>
              🗺️ {showAll ? "Showing all" : "Show all"}
            </button>
          )}
          {me?.level === "admin" && (
            <button type="button" onClick={() => setIgnoreDist((v) => !v)}
              title="Test mode: let the outcome buttons work without being within 200 ft of the pin"
              style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", borderRadius: 999, padding: "3px 10px", border: "1px solid", borderColor: ignoreDist ? "#f59e0b" : "#475569", background: ignoreDist ? "#f59e0b" : "transparent", color: ignoreDist ? "#111827" : "#cbd5e1" }}>
              🧪 Distance {ignoreDist ? "OFF" : "ON"}
            </button>
          )}
          {me ? (
            <span style={{ fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              {me.name}
              <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: me.level === "senior" ? "#16a34a" : me.level === "admin" ? "#7c3aed" : "#334155", padding: "2px 8px", borderRadius: 10 }}>{me.level}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* Status filter chips — MOBILE only. Desktop puts them as cards in the
          right column (see below). Seniors' filter is locked to IQ + No-sit. */}
      {!isDesktop && (
        <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "8px 12px", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
          {!selLocked && <Chip active={sel.size === 0} onClick={() => setSel(new Set())} color="#334155" label={`All (${dbCounts ? Object.entries(dbCounts).reduce((sum, [k, n]) => sum + ((!visKeys || visKeys.has(k)) ? n : 0), 0) : (visKeys ? prospects.filter((p) => visKeys.has(p.status)).length : prospects.length)})`} />}
          {visTypes.map((s) => (
            <Chip key={s.key} active={sel.has(s.key)} check onClick={() => selLocked ? null : toggleSel(s.key)} color={s.color} label={`${s.label} (${counts[s.key] || 0})`} />
          ))}
          {installs.length > 0 && (
            <Chip active={showInstalls} onClick={() => setShowInstalls((v) => !v)} color={INSTALL_COLOR} label={`⭐ Installs (${installs.length})`} />
          )}
          {workedPins.length > 0 && (
            <Chip active={showWorked} onClick={() => setShowWorked((v) => !v)} color={BABY_BLUE} label={`🔵 Worked today (${workedPins.length})`} />
          )}
        </div>
      )}

      {/* Map */}
      <div style={{ position: "relative", flex: 1 }}>
        <div ref={mapEl} style={{ position: "absolute", inset: 0, right: isDesktop ? 300 : 0 }} />
        <style>{`@keyframes hpulse{0%{box-shadow:0 1px 5px rgba(0,0,0,.5),0 0 0 0 rgba(124,58,237,.5)}70%{box-shadow:0 1px 5px rgba(0,0,0,.5),0 0 0 14px rgba(124,58,237,0)}100%{box-shadow:0 1px 5px rgba(0,0,0,.5),0 0 0 0 rgba(124,58,237,0)}}`}</style>

        {/* ── Web (desktop) right column: status cards + upload / JN sync ── */}
        {isDesktop && (
          <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 300, background: "#f8fafc", borderLeft: "1px solid #e5e7eb", zIndex: 460, overflowY: "auto", padding: "14px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8", margin: "2px 2px 8px" }}>Pins to show</div>
            {selLocked && (
              <div style={{ fontSize: 12, fontWeight: 700, color: "#166534", background: "#dcfce7", border: "1px solid #86efac", borderRadius: 10, padding: "8px 10px", marginBottom: 10 }}>
                🔒 You work <b>IQ + No-sit</b> together — both always on.
              </div>
            )}
            {!selLocked && (
              <StatusCard color="#334155" label="All pins"
                count={dbCounts ? Object.entries(dbCounts).reduce((sum, [k, n]) => sum + ((!visKeys || visKeys.has(k)) ? n : 0), 0) : (visKeys ? prospects.filter((p) => visKeys.has(p.status)).length : prospects.length)}
                active={sel.size === 0} onClick={() => setSel(new Set())} />
            )}
            {visTypes.map((s) => (
              <StatusCard key={s.key} color={s.color} label={s.label} count={counts[s.key] || 0}
                active={sel.has(s.key)} locked={selLocked} onClick={() => selLocked ? null : toggleSel(s.key)} />
            ))}
            {installs.length > 0 && (
              <StatusCard color={INSTALL_COLOR} label="⭐ Installs" count={installs.length}
                active={showInstalls} onClick={() => setShowInstalls((v) => !v)} />
            )}
            {workedPins.length > 0 && (
              <StatusCard color={BABY_BLUE} label="🔵 Worked today" count={workedPins.length}
                active={showWorked} onClick={() => setShowWorked((v) => !v)} />
            )}
            {me?.level === "admin" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8", margin: "16px 2px 8px" }}>Office</div>
                {[["📥 Upload leads", "/?mode=harvestupload"], ["🔄 JN Sync", "/?mode=harvestjnsync"], ["🔗 Rep Links", "/?mode=harvestlinks"], ["📊 Reports", "/?mode=harvestreport"]].map(([lbl, href]) => (
                  <a key={href} href={href} style={{ display: "block", textDecoration: "none", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "11px 12px", marginBottom: 8, fontSize: 13.5, fontWeight: 800, color: "#0f172a" }}>{lbl}</a>
                ))}
              </>
            )}
          </div>
        )}
        {loading && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "6px 14px", borderRadius: 20, fontSize: 13, boxShadow: "0 2px 8px rgba(0,0,0,.15)", zIndex: 500 }}>Loading pins…</div>
        )}
        {!loading && prospects.length === 0 && clusters.length === 0 && (
          <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "14px 18px", borderRadius: 12, fontSize: 13.5, color: "#475569", boxShadow: "0 2px 10px rgba(0,0,0,.12)", zIndex: 500, textAlign: "center", maxWidth: 320 }}>
            No pins in your area yet. The office loads leads from the admin section.
          </div>
        )}
        {!loading && capped && shownCount > 0 && dayMode === null && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", padding: "6px 14px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, boxShadow: "0 2px 8px rgba(0,0,0,.12)", zIndex: 500, whiteSpace: "nowrap" }}>Showing the densest area — zoom in to see every pin</div>
        )}
        {/* Loaded pins, but the category filter is hiding them all — explain the
            blank map (e.g. "IQ" selected when every pin is an Inspection Lead). */}
        {!loading && shownCount === 0 && mapped.length > 0 && dayMode === null && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#eff6ff", border: "1px solid #93c5fd", color: "#1e3a8a", padding: "6px 14px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, boxShadow: "0 2px 8px rgba(0,0,0,.12)", zIndex: 500, whiteSpace: "nowrap" }}>
            0 of {mapped.length.toLocaleString()} pins match your filter — tap <b>All</b> up top to see them
          </div>
        )}

        {/* ── Start my day ── (stays visible in cluster view; nudges to zoom in) */}
        {dayMode === null && !selecting && (prospects.length > 0 || clusters.length > 0) && (
          <button type="button" onClick={() => (prospects.length ? setDayMode("choosing") : nudgeZoom())}
            style={{ position: "absolute", left: 12, bottom: 16, zIndex: 600, background: "#16a34a", color: "#fff", border: "none", borderRadius: 999, padding: "13px 20px", fontSize: 15, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer", opacity: prospects.length ? 1 : 0.85 }}>
            ▶ Start my day
          </button>
        )}
        {/* Route an area — drag a box, route exactly the doors inside it. */}
        {dayMode === null && !selecting && (prospects.length > 0 || clusters.length > 0) && (
          <button type="button" onClick={() => (prospects.length ? startSelecting() : nudgeZoom())}
            style={{ position: "absolute", left: 12, bottom: 68, zIndex: 600, background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 999, padding: "10px 16px", fontSize: 13, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer", opacity: prospects.length ? 1 : 0.85 }}>
            ▢ Route an area
          </button>
        )}
        {zoomHint && (
          <div style={{ position: "absolute", left: "50%", bottom: 120, transform: "translateX(-50%)", zIndex: 800, background: "#1e293b", color: "#fff", borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 700, boxShadow: "0 3px 14px rgba(0,0,0,.35)", whiteSpace: "nowrap" }}>
            🔍 Zoom into your neighborhood first, then start
          </div>
        )}
        {/* ── Add a house ── rep spots a damaged roof and drops their own pin.
             Top-right under the location pin — away from the Start-my-day /
             Route-an-area stack, so it can't be hit while building a route. */}
        {auth.rt && !selecting && !adding && !newPin && (
          <button type="button" onClick={startAddHouse} title="Add a house"
            style={{ position: "absolute", right: isDesktop ? 312 : 12, top: (myLoc && !selecting) ? 64 : 12, zIndex: 600, background: "#7c3aed", color: "#fff", border: "2px solid #fff", borderRadius: 999, width: 44, height: 44, fontSize: 19, boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
            🏠
          </button>
        )}
        {adding && (
          <div style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", zIndex: 750, background: "#7c3aed", color: "#fff", borderRadius: 12, padding: "10px 14px", boxShadow: "0 3px 14px rgba(0,0,0,.3)", display: "flex", alignItems: "center", gap: 12, whiteSpace: "nowrap" }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>🏠 Tap the roof of the house</span>
            <button type="button" onClick={cancelAdd} style={{ background: "rgba(255,255,255,.22)", color: "#fff", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>Cancel</button>
          </div>
        )}
        {selecting && (
          <div style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", zIndex: 750, background: "#1d4ed8", color: "#fff", borderRadius: 12, padding: "10px 14px", boxShadow: "0 3px 14px rgba(0,0,0,.3)", display: "flex", alignItems: "center", gap: 12, whiteSpace: "nowrap" }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>✏️ Drag your finger across the doors to box them in</span>
            <button type="button" onClick={cancelSelecting} style={{ background: "rgba(255,255,255,.22)", color: "#fff", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>Cancel</button>
          </div>
        )}
        {/* Recenter on the rep's live location. */}
        {myLoc && !selecting && (
          <button type="button" title="Center on me"
            onClick={() => map.current && map.current.setView([myLoc.lat, myLoc.lng], Math.max(map.current.getZoom(), 16))}
            style={{ position: "absolute", right: isDesktop ? 312 : 12, top: 12, zIndex: 600, background: "#fff", color: "#1d4ed8", border: "1px solid #cbd5e1", borderRadius: 999, width: 44, height: 44, fontSize: 19, boxShadow: "0 3px 12px rgba(0,0,0,.2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            📍
          </button>
        )}

        {/* ── Route history (admin) ── replay any past day's rep trails ── */}
        {me?.level === "admin" && (
          <div style={{ position: "absolute", left: 12, top: 12, zIndex: 640, width: "min(300px, 82%)" }}>
            <button type="button" onClick={() => setHistoryOpen((o) => !o)}
              style={{ background: historyMode ? "#7c3aed" : "#0f172a", color: "#fff", border: "none", borderRadius: historyOpen ? "12px 12px 0 0" : 12, padding: "9px 14px", fontSize: 13, fontWeight: 800, cursor: "pointer", boxShadow: "0 3px 12px rgba(0,0,0,.25)", width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>🕘 Route history{historyMode ? ` · ${historyDate}` : ""}</span>
              <span style={{ fontSize: 11, opacity: 0.8 }}>{historyOpen ? "▲" : "▼"}</span>
            </button>
            {historyOpen && (
              <div style={{ background: "#fff", borderRadius: "0 0 12px 12px", boxShadow: "0 3px 14px rgba(0,0,0,.25)", padding: "12px", maxHeight: "60vh", overflowY: "auto" }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="date" value={historyDate} max={new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })}
                    onChange={(e) => setHistoryDate(e.target.value)}
                    style={{ flex: 1, border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 8px", fontSize: 13 }} />
                  <button type="button" onClick={() => loadHistory(historyDate)} disabled={historyBusy}
                    style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 800, cursor: "pointer", opacity: historyBusy ? 0.6 : 1 }}>
                    {historyBusy ? "…" : "Show"}
                  </button>
                </div>
                {historyMode && (
                  <button type="button" onClick={backToLive} style={{ marginTop: 8, width: "100%", background: "#fff", color: "#7c3aed", border: "1px solid #ddd6fe", borderRadius: 8, padding: "7px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>← Back to live</button>
                )}
                {historyMode && (
                  <div style={{ marginTop: 10 }}>
                    {historyReps.length === 0 && <div style={{ fontSize: 12.5, color: "#94a3b8", textAlign: "center", padding: "6px 0" }}>No rep trails recorded that day.</div>}
                    {historyReps.map((r) => {
                      const s = r.summary || {};
                      const t = (iso) => iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "—";
                      const hm = `${Math.floor((s.active_min || 0) / 60)}h ${(s.active_min || 0) % 60}m`;
                      return (
                        <button key={r.rep_id || r.name} type="button"
                          onClick={() => { const pts = (r.pings || []).map((p) => [p.lat, p.lng]); if (pts.length && map.current) map.current.fitBounds(pts, { padding: [50, 50], maxZoom: 16 }); }}
                          style={{ display: "block", width: "100%", textAlign: "left", background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: 10, padding: "8px 10px", marginBottom: 6, cursor: "pointer" }}>
                          <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>{r.name}</div>
                          <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 2 }}>🚗 {s.miles} mi · ⏱ {hm} · {t(s.first_at)}–{t(s.last_at)}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Go-backs to work ── scheduled-due PLUS aging follow-ups (most have no
             scheduled date, so aging is what surfaces a stale pile). Worst first. */}
        {visits.length > 0 && !selecting && (() => {
          const RANK = { overdue: 0, aging: 1, today: 2 };
          const needs = visits.map((v) => ({ v, w: visitNeedsWork(v), age: visitAgeDays(v) }))
            .filter((x) => x.w)
            .sort((a, b) => (RANK[a.w] - RANK[b.w]) || ((b.age || 0) - (a.age || 0)));
          if (!needs.length) return null;
          const hot = needs.some((x) => x.w === "overdue" || (x.age || 0) >= 14);
          return (
            <div style={{ position: "absolute", top: 12, left: isDesktop ? "calc((100% - 300px) / 2)" : "50%", transform: "translateX(-50%)", zIndex: 650, width: "min(370px, 92%)" }}>
              <button type="button" onClick={() => setGobackCard((o) => !o)}
                style={{ width: "100%", background: hot ? "#7f1d1d" : "#0f172a", color: "#fff", border: "none", borderRadius: gobackCard ? "12px 12px 0 0" : 12, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", boxShadow: "0 3px 14px rgba(0,0,0,.3)" }}>
                <span style={{ fontSize: 13.5, fontWeight: 800 }}>{hot ? "⚠️" : "🗓️"} {needs.length} go-back{needs.length > 1 ? "s" : ""} to work</span>
                <span style={{ fontSize: 11, opacity: 0.85 }}>{gobackCard ? "▲ hide" : "▼ show"}</span>
              </button>
              {gobackCard && (
                <div style={{ background: "#fff", borderRadius: "0 0 12px 12px", boxShadow: "0 3px 14px rgba(0,0,0,.3)", maxHeight: "46vh", overflowY: "auto" }}>
                  {needs.map(({ v, w, age }) => {
                    const m = GOBACK_META[v.bucket] || GOBACK_META.damage;
                    const status = w === "overdue" ? "⚠️ overdue" : w === "aging" ? `⏳ ${age}d waiting` : "today";
                    const warn = w === "overdue" || (age || 0) >= 14;
                    return (
                      <button key={v.inspection_id} type="button"
                        onClick={() => { setGobackCard(false); if (v.latitude != null) map.current?.setView([v.latitude, v.longitude], Math.max(map.current.getZoom(), 16)); setSelected(null); setSelectedVisit(v); }}
                        style={{ display: "flex", width: "100%", gap: 10, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid #f1f5f9", background: "#fff", border: "none", cursor: "pointer", textAlign: "left" }}>
                        <span style={{ width: 28, height: 28, borderRadius: 7, background: m.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>{m.emoji}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 13, fontWeight: 800, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.client_name || v.address}</span>
                          <span style={{ display: "block", fontSize: 11.5, color: warn ? "#b91c1c" : "#64748b", fontWeight: warn ? 800 : 600 }}>{m.label} · {status}{visitWhenLabel(v) ? ` · ${visitWhenLabel(v)}` : ""}{v.distance_mi != null ? ` · ${v.distance_mi} mi` : ""}</span>
                        </span>
                      </button>
                    );
                  })}
                  <div style={{ padding: "10px 12px" }}>
                    <button type="button" onClick={addGobacksToRoute}
                      style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "11px", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>
                      ➕ Add these go-backs to my route
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {dayMode === "choosing" && (
          <div style={{ position: "absolute", right: 10, bottom: 14, zIndex: 600, background: "#fff", borderRadius: 14, padding: "16px 18px", boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: "min(340px, 88%)", textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", color: "#0f172a", marginBottom: 6 }}>Where are you starting?</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>Start from your location, or <b>tap anywhere on the map</b> to start there. We'll route your stops nearest-first.</div>
            <button type="button" onClick={useMyLocation}
              style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 15, fontWeight: 800, cursor: "pointer", marginBottom: 8 }}>
              📍 Start from my location
            </button>
            <button type="button" onClick={() => setDayMode(null)}
              style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 12, padding: "11px", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        )}

        {dayMode === "active" && (() => {
          const done = stopIdx >= route.length;
          const stop = done ? null : route[stopIdx];
          const posStyle = panelPos
            ? { left: panelPos.left, top: panelPos.top }
            : { right: 10, bottom: 14 };
          const left = done ? remainingCount() : 0;
          const leftPins = done ? dayPoolPins().filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id)) : [];
          return (
            <div data-daypanel style={{ position: "absolute", ...posStyle, zIndex: 600, background: "#fff", borderRadius: 14, boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: "min(340px, 88%)", overflow: "hidden" }}>
              {/* Drag handle so it never blocks the map */}
              <div onPointerDown={panelPointerDown} onPointerMove={panelPointerMove} onPointerUp={panelPointerUp}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "5px 0 3px", cursor: "grab", touchAction: "none", color: "#cbd5e1", fontSize: 13, letterSpacing: 2, userSelect: "none" }}>
                ⠿ <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.03em" }}>drag</span>
              </div>
              <div style={{ padding: "4px 16px 14px" }}>
              {done ? (
                <div style={{ textAlign: "center" }}>
                  {left > 0 ? (
                    <>
                      <div style={{ fontSize: 26 }}>✅</div>
                      <div style={{ fontSize: 15.5, fontWeight: 800, fontFamily: "'Oswald', sans-serif", margin: "4px 0 4px" }}>Round {round} done!</div>
                      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}><b>{left}</b> pin{left === 1 ? "" : "s"} left to work.</div>
                      <button type="button" onClick={nextRound} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: "pointer", marginBottom: 8 }}>
                        ▶ Start round {round + 1} — next {Math.min(routeCap(leftPins), left)}
                      </button>
                      <button type="button" onClick={startOver} style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Finish for the day</button>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 30 }}>🎉</div>
                      <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", margin: "4px 0 10px" }}>Every pin worked — nice work!</div>
                      <button type="button" onClick={startOver} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: "pointer" }}>▶ Start a new route</button>
                    </>
                  )}
                </div>
              ) : (() => {
                const distFt = myLoc ? feetBetween(myLoc, { lat: stop.latitude, lng: stop.longitude }) : null;
                // Credit the fix's own uncertainty: a ±100m GPS reading that says
                // 358 ft could really be at the door. Capped at 400 ft so a wildly
                // bad fix can't fully bypass the gate.
                const accFt = myLoc?.acc != null ? Math.min(myLoc.acc * 3.28084, 400) : 0;
                const effFt = distFt != null ? Math.max(0, distFt - accFt) : null;
                const gpsNear = effFt != null && effFt <= ARRIVE_FT;
                // Is the phone's own reading trustworthy? No fix, or a >150m accuracy
                // (a cell-tower / wifi guess, not a real satellite lock) = "GPS is off".
                // A GOOD fix that puts the rep far from the door is NOT "off" — it's
                // either a mis-located pin or someone statusing from the couch, so it
                // shouldn't get the easy one-tap bypass.
                const gpsUnsure = myLoc == null || myLoc.acc == null || myLoc.acc > 150;
                const near = ignoreDist || gpsNear || manualHere === stop.id;
                // Genuinely at the stop: once here, directions are turned off until
                // they STATUS this stop — statusing advances to the next stop.
                const arrived = gpsNear || manualHere === stop.id;
                const outs = ((S[stop.status]?.outcomes) || []).map((k) => S[k]).filter(Boolean);
                const oBtn = (key, label, color) => (
                  <button key={key} type="button" disabled={!near} onClick={() => workStop(key)}
                    style={{ flex: "1 1 44%", minWidth: 92, padding: "11px 8px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed",
                      border: `1px solid ${near ? color : "#e5e7eb"}`, background: near ? color : "#fff", color: near ? "#fff" : "#cbd5e1" }}>
                    {label}
                  </button>
                );
                return (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#16a34a" }}>{round > 1 ? `Round ${round} · ` : ""}Stop {stopIdx + 1} of {route.length}{optimizing ? <span style={{ color: "#94a3b8", fontWeight: 700 }}> · 🛣️ optimizing…</span> : null}</span>
                    <button type="button" onClick={() => setEditingRoute(true)} style={{ background: "none", border: "none", fontSize: 12.5, fontWeight: 700, color: "#1d4ed8", cursor: "pointer" }}>✏️ Edit route</button>
                  </div>
                  {/* One tap re-orders whatever's left from where the rep is standing —
                      the fix for "I keep walking away and coming back to this street". */}
                  <button type="button" onClick={rerouteFromHere} disabled={rerouting}
                    style={{ width: "100%", marginBottom: 10, background: "#ecfdf5", color: "#047857", border: "1px solid #6ee7b7", borderRadius: 10, padding: "9px", fontSize: 12.5, fontWeight: 800, cursor: rerouting ? "wait" : "pointer" }}>
                    {rerouting ? "📍 Finding you…" : "📍 Re-route from where I am"}
                  </button>
                  {fillOffer && (() => {
                    // Recompute live so trimming stops in Edit route bumps the
                    // "add N" up (remove 10 of 16 → room for 24 more, not 14).
                    const addN = Math.min(availableFill(route).length, Math.max(0, ROUTE_CAP_DEFAULT - route.length));
                    if (addN <= 0) return null;
                    return (
                    <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10, padding: "9px 11px", margin: "2px 0 8px" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: "#92400e" }}>Only {route.length} stops — that's not a full day's effort.</div>
                      <button type="button" onClick={addFillStops}
                        style={{ marginTop: 7, width: "100%", background: "#d97706", color: "#fff", border: "none", borderRadius: 9, padding: "9px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                        ➕ Add {addN} “{S["no_sit_reschedule"]?.label || "No sit – need to reschedule"}” to fill the day
                      </button>
                    </div>
                    );
                  })()}
                  {stop.name && <div style={{ fontSize: 15.5, fontWeight: 800 }}>{stop.name}</div>}
                  <div style={{ fontSize: 13.5, color: "#334155", fontWeight: 600 }}>{stop.address}</div>
                  <div style={{ fontSize: 12.5, color: "#64748b" }}>{[stop.city, stop.state, stop.zip].filter(Boolean).join(", ")}</div>
                  {stop.status === "no_sit_reschedule" && origApptLabel(stop) && (
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: "#c2410c", marginTop: 4 }}>🔄 No-sit · original appt was {origApptLabel(stop)}</div>
                  )}
                  {/* Thin red box right above Directions — reps couldn't find the old
                      faint text link. Confirms first so a mis-tap can't wipe the route. */}
                  <button type="button"
                    onClick={() => { if (window.confirm("Cancel this route and start a new one? Your progress on worked doors is saved — this just clears the current route.")) startOver(); }}
                    style={{ width: "100%", marginTop: 12, background: "#fff", color: "#dc2626", border: "1px solid #dc2626", borderRadius: 9, padding: "8px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                    ✕ Cancel route &amp; start a new one
                  </button>
                  <button type="button" onClick={() => !arrived && navRoute(stop)} disabled={arrived}
                    style={{ width: "100%", marginTop: 8, background: arrived ? "#e5e7eb" : "#1d4ed8", color: arrived ? "#94a3b8" : "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: arrived ? "not-allowed" : "pointer" }}>
                    {arrived ? "✓ You're here — status this stop below" : `🧭 Directions to ${stopIdx === 0 ? "first stop" : "this stop"}`}
                  </button>
                  {!arrived && (
                    <div style={{ textAlign: "center", marginTop: 5, display: "flex", justifyContent: "center", gap: 12 }}>
                      <a href={`https://www.google.com/maps/dir/?api=1&destination=${addrOf(stop)}`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, fontWeight: 700, color: "#94a3b8", textDecoration: "none" }}>Google Maps ↗</a>
                      <a href={`https://maps.apple.com/?daddr=${addrOf(stop)}&dirflg=d`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, fontWeight: 700, color: "#94a3b8", textDecoration: "none" }}>Apple Maps ↗</a>
                    </div>
                  )}
                  {signingStop && signingStop.id === stop.id ? (
                    <div style={{ marginTop: 14, background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 12, padding: "12px 14px", textAlign: "center" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 800, color: "#7c3aed" }}>🖊️ Signing {stop.name || "this homeowner"}…</div>
                      <div style={{ fontSize: 12, color: "#7c3aed", opacity: 0.85, margin: "4px 0 10px" }}>Finish in the intake tab. This stop marks <b>Inspection Sold</b> and moves to the next automatically once they sign.</div>
                      <button type="button" onClick={() => completeSign(stop)} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 11, padding: "11px", fontSize: 13.5, fontWeight: 800, cursor: "pointer", marginBottom: 6 }}>✅ They signed — next stop</button>
                      <button type="button" onClick={() => setSigningStop(null)} style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 11, padding: "9px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>← Back (didn't sign)</button>
                    </div>
                  ) : stop._visit ? (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: (GOBACK_META[stop._visit.bucket] || GOBACK_META.damage).color, marginBottom: 8 }}>
                        {(GOBACK_META[stop._visit.bucket] || GOBACK_META.damage).emoji} {(GOBACK_META[stop._visit.bucket] || GOBACK_META.damage).label} go-back — {(GOBACK_META[stop._visit.bucket] || GOBACK_META.damage).sub.toLowerCase()}
                      </div>
                      {visitToken
                        ? <VisitActions type={stop._visit.bucket} deal={stop._visit} rep={{ name: me?.name || "", jobnimbus_id: me?.jn_id || "", email: me?.email || "" }} api={visitApi} />
                        : <div style={{ fontSize: 13, color: "#94a3b8", textAlign: "center", padding: "8px 0" }}>Loading…</div>}
                      <button type="button" onClick={() => { loadVisits(); advanceStop(); }}
                        style={{ marginTop: 12, width: "100%", background: "#0f172a", color: "#fff", border: "none", borderRadius: 11, padding: "11px", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>Next stop →</button>
                    </div>
                  ) : !ownsPin(stop) ? (
                    <div style={{ marginTop: 14, background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 22 }}>🔒</div>
                      <div style={{ fontSize: 13.5, fontWeight: 800, color: "#334155", marginTop: 2 }}>This pin belongs to {pinOwnerName(stop)}</div>
                      <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>Only {pinOwnerName(stop)} can work their self-generated door.</div>
                    </div>
                  ) : (<>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "13px 0 6px" }}>How'd it go?</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {outs.map((o) => o.key === "insp_sold"
                      ? (
                        <button key={o.key} type="button" disabled={!near} onClick={() => signInspection(stop)}
                          style={{ flex: "1 1 44%", minWidth: 92, padding: "11px 8px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed",
                            border: `1px solid ${near ? "#7c3aed" : "#e5e7eb"}`, background: near ? "#7c3aed" : "#fff", color: near ? "#fff" : "#cbd5e1" }}>
                          🖊️ Sign Inspection
                        </button>
                      )
                      : oBtn(o.key, o.label, o.color))}
                    {oBtn("nothome", "🏠 Not home", "#475569")}
                  </div>
                  {/* Homeowner declined the inspection but wants a retail appt —
                      book it right from the route stop (same as the pin sheet). */}
                  {stop.status === "insp" && (
                    <button type="button" disabled={!near} onClick={() => near && setBtrPin(stop)}
                      style={{ marginTop: 8, width: "100%", padding: "11px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed",
                        border: `2px solid ${near ? "#b45309" : "#e5e7eb"}`, background: near ? "#fff7ed" : "#fff", color: near ? "#b45309" : "#cbd5e1" }}>
                      🏠 BTR appt — homeowner wants retail
                    </button>
                  )}
                  <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, textAlign: "center", color: near ? "#16a34a" : "#b45309" }}>
                    {ignoreDist
                      ? "🧪 Distance gate OFF (test) — pick what happened"
                      : distFt == null
                        ? "📍 Finding your location… (allow location access to log a stop)"
                        : near
                          ? (manualHere === stop.id ? "📍 Marked at the door — pick what happened" : "✓ You're here — pick what happened and it moves to the next stop")
                          : `~${Math.round(distFt).toLocaleString()} ft away — get within ${ARRIVE_FT} ft to log this stop`}
                  </div>
                  {/* Two different "I'm here anyway" paths, by how sure the phone is:
                      • GPS is genuinely off (no fix / junk accuracy) → friendly override,
                        because the phone truly can't confirm the rep either way.
                      • GPS is CONFIDENT the rep is far → still let them through (a pin can
                        be geocoded wrong), but it's clearly flagged and sent to the office
                        report, so statusing a whole route from the couch lights up. */}
                  {!near && (gpsUnsure ? (
                    <button type="button" onClick={() => { setManualHere(stop.id); logActivity({ pin_id: stop.id, kind: "manual_here", to_status: stop.status, ...locAudit(stop) }); }}
                      style={{ marginTop: 8, width: "100%", padding: "9px", borderRadius: 10, border: "1px dashed #b45309", background: "#fff", color: "#b45309", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                      📍 I'm at the door — GPS is weak, let me status it
                    </button>
                  ) : (
                    <button type="button" onClick={() => { setManualHere(stop.id); logActivity({ pin_id: stop.id, kind: "manual_here", to_status: stop.status, ...locAudit(stop) }); }}
                      style={{ marginTop: 8, width: "100%", padding: "9px", borderRadius: 10, border: "1px solid #dc2626", background: "#fef2f2", color: "#b91c1c", fontSize: 12, fontWeight: 800, cursor: "pointer", lineHeight: 1.35 }}>
                      ⚠️ GPS shows you ~{Math.round(distFt).toLocaleString()} ft from this door.<br />Status anyway — this gets flagged for your manager.
                    </button>
                  ))}
                  </>)}
                </>
                );
              })()}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Route editor — trim stops that are too far to be worth the drive */}
      {editingRoute && dayMode === "active" && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "14px 16px 20px", zIndex: 1100, maxHeight: "72vh", overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif" }}>Edit today's route</div>
            <button type="button" onClick={() => setEditingRoute(false)} style={{ background: "#0f172a", color: "#fff", border: "none", borderRadius: 9, padding: "7px 15px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>Done</button>
          </div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>Remove any stop you don't want to drive to — miles are straight-line from your start. {route.length} stop{route.length === 1 ? "" : "s"} in the route.</div>
          <div style={{ display: "grid", gap: 6 }}>
            {route.map((p, i) => {
              const mi = startPt ? feetBetween(startPt, { lat: p.latitude, lng: p.longitude }) / 5280 : null;
              const far = mi != null && mi >= 8;
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, border: "1px solid #eef2f7", background: i === stopIdx ? "#f0fdf4" : "#fff" }}>
                  <span style={{ minWidth: 22, height: 22, borderRadius: 11, background: i === stopIdx ? "#16a34a" : "#e2e8f0", color: i === stopIdx ? "#fff" : "#475569", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name || p.address}</div>
                    <div style={{ fontSize: 11.5, color: far ? "#b91c1c" : "#64748b", fontWeight: far ? 800 : 600 }}>{mi != null ? `${mi.toFixed(1)} mi from start${far ? " • far" : ""}` : p.address}</div>
                  </div>
                  <button type="button" onClick={() => removeStop(p.id)} disabled={route.length <= 1}
                    style={{ background: "#fff", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "6px 11px", fontSize: 12, fontWeight: 800, cursor: route.length <= 1 ? "not-allowed" : "pointer", flexShrink: 0 }}>Remove</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* New self-gen door sheet — owner-occupancy check + the three actions */}
      {newPin && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1200, maxHeight: "72vh", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: "#6d28d9" }}>🏠 New self-gen door</div>
              {newPin.check?.found && (
                <>
                  <div style={{ fontSize: 14, color: "#334155", fontWeight: 700, marginTop: 3 }}>{newPin.check.address?.line1}</div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>{[newPin.check.address?.city, newPin.check.address?.state, newPin.check.address?.zip].filter(Boolean).join(", ")}</div>
                  {newPin.check.owner && (
                    <div style={{ marginTop: 7, display: "inline-flex", alignItems: "center", gap: 6, background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: "5px 10px" }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.03em" }}>Owner</span>
                      <span style={{ fontSize: 16, fontWeight: 800, color: "#1e1b4b" }}>{newPin.check.owner}</span>
                    </div>
                  )}
                </>
              )}
            </div>
            <button type="button" onClick={cancelAdd} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: "#7c3aed", fontWeight: 700, background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 9, padding: "7px 10px" }}>
            ✋ Wrong house? Drag the purple pin onto the right roof — it re-checks automatically.
          </div>

          {/* While the lookup runs (on drop OR after a drag) */}
          {newPin.checking && (
            <div style={{ marginTop: 14, padding: "14px", borderRadius: 12, background: "#f5f3ff", border: "1px solid #ddd6fe", color: "#6d28d9", fontSize: 14.5, fontWeight: 800, textAlign: "center" }}>
              📍 Checking property records…
            </div>
          )}

          {/* Verdict + actions — hidden while a (re)check is in flight so nobody acts on a stale result */}
          {!newPin.checking && newPin.check && (() => {
            const c = newPin.check;
            // Fail-safe: this property is already on the map — no duplicate pins.
            if (c.existing) {
              const st = c.existing.status || "";
              return (
                <div style={{ marginTop: 12 }}>
                  <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>🚫 Already pinned</div>
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>This property is already on the map{c.existing.rep ? ` — ${c.existing.rep}` : ""}{st ? ` · ${S[st]?.label || st}` : ""}. You can't add a duplicate.</div>
                    {c.existing.address && <div style={{ fontSize: 12, marginTop: 3, opacity: 0.85 }}>{c.existing.address}</div>}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12.5, color: "#7c3aed", fontWeight: 700, textAlign: "center" }}>Drag the pin to a different house, or close.</div>
                </div>
              );
            }
            if (!c.found) {
              return (
                <div style={{ marginTop: 12 }}>
                  <div style={{ background: "#fef9c3", border: "1px solid #fde047", color: "#854d0e", borderRadius: 10, padding: "10px 12px", fontSize: 13, fontWeight: 600 }}>{c.reason || "No parcel found here — drag the pin onto the roof."}</div>
                </div>
              );
            }
            const occ = c.owner_occupied;
            const badge = occ
              ? { bg: "#dcfce7", bd: "#86efac", fg: "#166534", label: c.homestead ? "✅ OWNER OCCUPIED · homestead on file" : "✅ OWNER OCCUPIED · mailing matches" }
              : { bg: "#fee2e2", bd: "#fca5a5", fg: "#991b1b", label: "⚠️ NON owner-occupied · likely a rental" };
            return (
              <div style={{ marginTop: 12 }}>
                <div style={{ background: badge.bg, border: `1px solid ${badge.bd}`, color: badge.fg, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800 }}>{badge.label}</div>
                  <div style={{ fontSize: 12, marginTop: 3, opacity: 0.9 }}>{c.reason}</div>
                </div>
                {occ ? (
                  <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                    <button type="button" disabled={newPin.saving} onClick={() => commitSelfGen("sign")}
                      style={{ padding: "13px", borderRadius: 12, border: "none", background: "#7c3aed", color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer", opacity: newPin.saving ? 0.6 : 1 }}>🖊️ Sign Inspection</button>
                    <button type="button" disabled={newPin.saving} onClick={() => commitSelfGen("retail")}
                      style={{ padding: "13px", borderRadius: 12, border: "2px solid #b45309", background: "#fff7ed", color: "#b45309", fontSize: 14.5, fontWeight: 800, cursor: "pointer", opacity: newPin.saving ? 0.6 : 1 }}>🏠 Retail Appointment</button>
                    <button type="button" disabled={newPin.saving} onClick={() => commitSelfGen("pending")}
                      style={{ padding: "13px", borderRadius: 12, border: "2px solid #ca8a04", background: "#fefce8", color: "#a16207", fontSize: 14.5, fontWeight: 800, cursor: "pointer", opacity: newPin.saving ? 0.6 : 1 }}>⏳ Pending (come back)</button>
                  </div>
                ) : (
                  <button type="button" disabled={newPin.saving} onClick={() => commitSelfGen("pending")}
                    style={{ marginTop: 12, width: "100%", padding: "12px", borderRadius: 10, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", fontSize: 13.5, fontWeight: 700, cursor: "pointer", opacity: newPin.saving ? 0.6 : 1 }}>Save as pending anyway</button>
                )}
                {newPin.saving && <div style={{ marginTop: 8, fontSize: 12.5, color: "#7c3aed", fontWeight: 700, textAlign: "center" }}>Saving…</div>}
              </div>
            );
          })()}

          {/* Safety net — force a fresh lookup at the pin's current spot, no matter what. */}
          {!newPin.checking && !newPin.saving && (
            <button type="button" onClick={() => runOwnerCheck(newPin.lat, newPin.lng)}
              style={{ marginTop: 12, width: "100%", padding: "11px", borderRadius: 10, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              🔄 Re-check this spot
            </button>
          )}
        </div>
      )}

      {/* Selected prospect sheet */}
      {selected && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1000, maxHeight: "62vh", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              {selected.name && <div style={{ fontWeight: 800, fontSize: 16 }}>{selected.name}</div>}
              <div style={{ fontSize: 14, color: "#334155", fontWeight: 600 }}>{selected.address}</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>{[selected.city, selected.state, selected.zip].filter(Boolean).join(", ")}</div>
              {selected.status === "no_sit_reschedule" && origApptLabel(selected) && (
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#c2410c", marginTop: 4 }}>🔄 No-sit · original appt was {origApptLabel(selected)}</div>
              )}
              <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: (S[selected.status] || UNKNOWN_TYPE).color, display: "inline-block" }} />
                {(S[selected.status] || UNKNOWN_TYPE).label}
                {selected.status_by ? <span style={{ color: "#94a3b8", fontWeight: 600 }}> · by {selected.status_by}</span> : null}
              </div>
            </div>
            <button type="button" onClick={() => setSelected(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          {/* Info a REP actually needs at the door. The `extra` blob keeps every
              uploaded/synced field for the office, but reps don't need back-office
              metadata (Date Contact, List, RepCard user, Synced at, Updated, IDs,
              Country Code, Verified Pin, …). Show a short ALLOWLIST from extra and
              hide the rest — nothing is deleted, just not displayed. */}
          {(() => {
            const rows = [];
            if (selected.phone) rows.push(["Phone", selected.phone]);
            if (selected.email) rows.push(["Email", selected.email]);
            if (selected.extra && typeof selected.extra === "object") {
              // Keys worth showing a rep (case-insensitive). Everything else in
              // `extra` is office bookkeeping and stays hidden.
              const SHOW = { owner: "Owner", occupancy: "Occupancy", homestead: "Homestead", "damage notes": "Notes", "damage_notes": "Notes" };
              for (const [k, v] of Object.entries(selected.extra)) {
                const label = SHOW[String(k).toLowerCase()];
                if (label && v != null && String(v).trim()) rows.push([label, String(v)]);
              }
            }
            // Self-gen owned pins get the editable note field below instead.
            if (selected.notes && !(isSelfGenPin(selected) && ownsPin(selected))) rows.push(["Notes", selected.notes]);
            if (!rows.length) return null;
            return (
              <div style={{ marginTop: 12, borderTop: "1px solid #f1f5f9", paddingTop: 10, display: "grid", gap: 4 }}>
                {rows.map(([k, v], i) => (
                  <div key={k + i} style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                    <span style={{ color: "#94a3b8", fontWeight: 700, minWidth: 96, textTransform: "capitalize", flexShrink: 0 }}>{k}</span>
                    <span style={{ color: "#334155", fontWeight: 600, wordBreak: "break-word" }}>{v}</span>
                  </div>
                ))}
              </div>
            );
          })()}

          {!ownsPin(selected) ? (
            <div style={{ marginTop: 14, background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 22 }}>🔒</div>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: "#334155", marginTop: 2 }}>This pin belongs to {pinOwnerName(selected)}</div>
              <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>They self-generated this door — only {pinOwnerName(selected)} can work it.</div>
            </div>
          ) : auth.rt ? (
            // Reps STATUS a door only by working it on a route — so every knock is
            // logged in order, at the door (distance-gated). No off-route statusing.
            <div style={{ marginTop: 14, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "14px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: "#1e3a8a" }}>Work this door on a route</div>
              <div style={{ fontSize: 12.5, color: "#334155", marginTop: 4, lineHeight: 1.5 }}>To status it (signed, not interested, appt, …), tap <b>▶ Start my day</b> or <b>▢ Route an area</b>. It comes up in order with the <b>“How’d it go?”</b> buttons when you're at the door.</div>
            </div>
          ) : (() => {
            // Office/admin: lead with the door's VISIT HISTORY — every knock, who,
            // when — so a manager sees at a glance how many times it's been tried
            // with nobody home. Status-change buttons are tucked behind a toggle so
            // the sheet isn't a wall of buttons.
            const cur = S[selected.status];
            const allowed = (cur?.outcomes || []).map((k) => S[k]).filter(Boolean);
            const options = allowed.length ? allowed : pinTypes;
            const acts = Array.isArray(selActs) ? selActs.filter((a) => a.kind !== "arrival") : selActs;
            const knocks = Array.isArray(selActs) ? selActs.filter((a) => a.kind === "visit").length : 0;
            const actLabel = (a) => {
              if (a.kind === "status") return { txt: `✏️ ${(S[a.to_status]?.label) || a.to_status}`, color: "#0f172a" };
              if (a.kind === "manual_here") return { txt: "📍 Marked at door", color: "#b45309" };
              if (a.to_status === "not_home") return { txt: "🏠 Not home", color: "#475569" };
              return { txt: S[a.to_status]?.label ? `✓ ${S[a.to_status].label}` : "🚶 Visit", color: "#16a34a" };
            };
            return (
              <>
                <div style={{ marginTop: 14, borderTop: "1px solid #f1f5f9", paddingTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 8 }}>
                    🚪 Visit history{knocks ? ` · knocked ${knocks}×` : ""}
                  </div>
                  {selActs === null ? <div style={{ fontSize: 13, color: "#94a3b8" }}>Loading…</div>
                    : selActs === "err" ? <div style={{ fontSize: 12.5, color: "#94a3b8" }}>Couldn't load activity.</div>
                    : acts.length === 0 ? <div style={{ fontSize: 12.5, color: "#94a3b8" }}>No visits logged yet — nobody's worked this door.</div>
                    : (
                      <div style={{ display: "grid", gap: 4 }}>
                        {acts.map((a, i) => {
                          const lab = actLabel(a);
                          // How far the rep was from the door when they logged it, coloured
                          // by trust: red = confidently far, amber = weak GPS, grey = at the door.
                          const dist = a.dist_ft != null
                            ? { txt: `${a.dist_ft.toLocaleString()} ft`, color: a.loc_flag === "far" ? "#b91c1c" : a.loc_flag === "gps_off" ? "#b45309" : "#94a3b8" }
                            : null;
                          return (
                            <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12.5, background: "#f8fafc", borderRadius: 7, padding: "6px 9px" }}>
                              <span style={{ color: "#64748b", fontWeight: 700, minWidth: 38, flexShrink: 0 }}>{fmtMD(a.created_at)}</span>
                              <span style={{ fontWeight: 700, color: lab.color, flexShrink: 0 }}>{lab.txt}</span>
                              {dist ? <span style={{ color: dist.color, fontWeight: 700, flexShrink: 0 }}>· {dist.txt}</span> : null}
                              <span style={{ flex: 1 }} />
                              {a.rep_name ? <span style={{ color: "#334155", flexShrink: 0 }}>{a.rep_name}</span> : null}
                              <span style={{ color: "#94a3b8", flexShrink: 0 }}>{fmtTime(a.created_at)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                </div>
                {/* Status correction, hidden by default — not the old wall of buttons. */}
                <button type="button" onClick={() => setShowStatusEdit((v) => !v)}
                  style={{ marginTop: 12, background: "none", border: "none", padding: 0, fontSize: 12.5, fontWeight: 800, color: "#1d4ed8", cursor: "pointer" }}>
                  {showStatusEdit ? "▲ Hide status change" : "✏️ Change status"}
                </button>
                {showStatusEdit && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", margin: "10px 0 8px" }}>
                      {allowed.length ? "Outcome" : "Set status"}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {options.map((s) => {
                        const on = selected.status === s.key;
                        return (
                          <button key={s.key} type="button"
                            onClick={() => s.key === "appt" ? setApptPin(selected) : s.key === "insp_sold" ? signInspection(selected) : setStatus(selected, s.key)}
                            style={{ padding: "9px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                              border: on ? `2px solid ${s.color}` : "1px solid #e5e7eb",
                              background: on ? s.color : "#fff", color: on ? "#fff" : "#334155" }}>
                            {s.key === "insp_sold" && !on ? "🖊️ Sign Inspection" : s.label}
                          </button>
                        );
                      })}
                    </div>
                    {selected.status === "insp" && (
                      <button type="button" onClick={() => setBtrPin(selected)}
                        style={{ marginTop: 10, padding: "10px 16px", borderRadius: 10, fontSize: 13.5, fontWeight: 800, cursor: "pointer",
                          border: "2px solid #b45309", background: "#fff7ed", color: "#b45309" }}>
                        🏠 BTR appt — homeowner wants retail
                      </button>
                    )}
                  </>
                )}
              </>
            );
          })()}

          {/* Notes — only on doors a rep self-generated (their own lead). */}
          {isSelfGenPin(selected) && ownsPin(selected) && (
            <div style={{ marginTop: 16, borderTop: "1px solid #f1f5f9", paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#6d28d9", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>📝 My notes</div>
              <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} rows={3}
                placeholder="Notes on this door — gate code, best time to knock, roof details…"
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #ddd6fe", borderRadius: 10, padding: "10px 12px", fontSize: 13.5, fontFamily: FONT, resize: "vertical", background: "#faf5ff" }} />
              <button type="button" onClick={saveNote} disabled={savingNote || noteDraft === (selected.notes || "")}
                style={{ marginTop: 8, width: "100%", padding: "10px", borderRadius: 10, border: "none", fontSize: 13.5, fontWeight: 800, cursor: (savingNote || noteDraft === (selected.notes || "")) ? "default" : "pointer",
                  background: (savingNote || noteDraft === (selected.notes || "")) ? "#e9d5ff" : "#7c3aed", color: "#fff" }}>
                {savingNote ? "Saving…" : noteDraft === (selected.notes || "") ? "Saved" : "Save note"}
              </button>
              <button type="button" onClick={deletePin}
                style={{ marginTop: 8, width: "100%", padding: "9px", borderRadius: 10, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                🗑 Delete this pin
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", "))}`}
              target="_blank" rel="noreferrer"
              style={{ flex: 1, textAlign: "center", padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 13.5, textDecoration: "none" }}>
              🧭 Google Maps
            </a>
            <a href={`https://maps.apple.com/?daddr=${encodeURIComponent([selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", "))}&dirflg=d`}
              target="_blank" rel="noreferrer"
              style={{ flex: 1, textAlign: "center", padding: "12px", borderRadius: 12, background: "#0f172a", color: "#fff", fontWeight: 700, fontSize: 13.5, textDecoration: "none" }}>
              🍎 Apple Maps
            </a>
          </div>
        </div>
      )}

      {apptPin && (
        <AppointmentModal
          pin={apptPin} rt={auth.rt}
          onClose={() => setApptPin(null)}
          onBooked={(patch) => {
            setProspects((list) => list.map((x) => (x.id === apptPin.id ? { ...x, ...patch } : x)));
            setSelected((s) => (s && s.id === apptPin.id ? { ...s, ...patch } : s));
            setResolvedIds((s) => new Set(s).add(apptPin.id)); // booked → statused → drops from later rounds
            // If this was the current route stop, log the visit + move on.
            if (dayMode === "active" && route[stopIdx] && route[stopIdx].id === apptPin.id) {
              logActivity({ pin_id: apptPin.id, kind: "visit", to_status: "appt", ...locAudit(apptPin) });
              advanceStop();
            }
            setApptPin(null);
          }}
        />
      )}

      {btrPin && (
        <AppointmentModal
          variant="btr" pin={btrPin} rt={auth.rt}
          onClose={() => setBtrPin(null)}
          onBooked={(patch) => {
            setProspects((list) => list.map((x) => (x.id === btrPin.id ? { ...x, ...patch } : x)));
            setSelected((s) => (s && s.id === btrPin.id ? { ...s, ...patch } : s));
            setResolvedIds((s) => new Set(s).add(btrPin.id));
            if (dayMode === "active" && route[stopIdx] && route[stopIdx].id === btrPin.id) {
              logActivity({ pin_id: btrPin.id, kind: "visit", to_status: "appt", ...locAudit(btrPin) });
              advanceStop();
            }
            setBtrPin(null);
          }}
        />
      )}

      {/* Go-back visit sheet — a scheduled follow-up (damage / no-damage / retail). */}
      {selectedVisit && (() => {
        const v = selectedVisit, m = GOBACK_META[v.bucket] || GOBACK_META.damage, due = visitDueStatus(v);
        const dest = encodeURIComponent([v.address, v.city, v.state, v.zip].filter(Boolean).join(", ") || `${v.latitude},${v.longitude}`);
        return (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1000, maxHeight: "66vh", overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <span style={{ width: 34, height: 34, borderRadius: 8, background: m.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{m.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 16 }}>{v.client_name || "Homeowner"}</div>
                <div style={{ fontSize: 13.5, color: "#334155", fontWeight: 600 }}>{v.address}</div>
                <div style={{ fontSize: 12.5, color: "#64748b" }}>{[v.city, v.state, v.zip].filter(Boolean).join(", ")}</div>
              </div>
              <button type="button" onClick={closeVisit} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>

            <div style={{ marginTop: 12, background: due === "overdue" ? "#fef2f2" : "#f8fafc", border: `1px solid ${due === "overdue" ? "#fca5a5" : "#e2e8f0"}`, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: m.color }}>{m.label} visit — {m.sub.toLowerCase()}</div>
              <div style={{ fontSize: 12.5, color: due === "overdue" ? "#b91c1c" : "#475569", fontWeight: 700, marginTop: 3 }}>
                {visitWhenLabel(v) ? `${v.result_task_at ? "🗓️ Scheduled: " : "🏠 Best time: "}${visitWhenLabel(v)}` : (visitAgeDays(v) != null ? `⏳ waiting ${visitAgeDays(v)} days` : "🏠 anytime")}
                {due === "overdue" ? " · ⚠️ overdue" : due === "today" ? " · today" : ""}
                {v.distance_mi != null ? ` · ${v.distance_mi} mi away` : ""}
              </div>
            </div>

            {v.mobile && <div style={{ marginTop: 10, fontSize: 13 }}><a href={`tel:${v.mobile}`} style={{ color: "#1d4ed8", fontWeight: 700, textDecoration: "none" }}>📞 {v.mobile}</a></div>}

            {/* The bucket's real action, shared verbatim with the Rep Visit Hub. */}
            <div style={{ marginTop: 14 }}>
              {visitToken
                ? <VisitActions type={v.bucket} deal={v} rep={{ name: me?.name || "", jobnimbus_id: me?.jn_id || "", email: me?.email || "" }} api={visitApi} />
                : <div style={{ fontSize: 13, color: "#94a3b8", textAlign: "center", padding: "10px 0" }}>Loading…</div>}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <a href={`https://www.google.com/maps/dir/?api=1&destination=${dest}`} target="_blank" rel="noreferrer"
                style={{ flex: 1, textAlign: "center", padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 13.5, textDecoration: "none" }}>🧭 Google Maps</a>
              <a href={`https://maps.apple.com/?daddr=${dest}&dirflg=d`} target="_blank" rel="noreferrer"
                style={{ flex: 1, textAlign: "center", padding: "12px", borderRadius: 12, background: "#0f172a", color: "#fff", fontWeight: 700, fontSize: 13.5, textDecoration: "none" }}>🍎 Apple Maps</a>
            </div>
          </div>
        );
      })()}

      {/* Selected install sheet — read-only (installs aren't canvassing pins). */}
      {selectedInstall && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1000, maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: INSTALL_COLOR }}>⭐ Install</div>
              <div style={{ fontSize: 15, color: "#334155", fontWeight: 700, marginTop: 3 }}>{selectedInstall.address_line}</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>{selectedInstall.city}</div>
              {(selectedInstall.product_type || selectedInstall.color) && (
                <div style={{ fontSize: 13, color: "#475569", marginTop: 6 }}>
                  {[selectedInstall.product_type, selectedInstall.color].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
            <button type="button" onClick={() => setSelectedInstall(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([selectedInstall.address_line, selectedInstall.city].filter(Boolean).join(", "))}`}
            target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", marginTop: 14, padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
            🧭 Navigate to this address
          </a>
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, color, label, check }) {
  return (
    <button type="button" onClick={onClick}
      style={{ whiteSpace: "nowrap", padding: "6px 12px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
        border: active ? `2px solid ${color}` : "1px solid #e5e7eb",
        background: active ? color : "#fff", color: active ? "#fff" : "#475569" }}>
      {check && active ? "✓ " : ""}{label}
    </button>
  );
}

// Desktop right-column filter card — the "chip" for the web view.
function StatusCard({ color, label, count, active, onClick, locked }) {
  return (
    <button type="button" onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "11px 12px", marginBottom: 8, borderRadius: 12, cursor: locked ? "default" : "pointer",
        border: active ? `2px solid ${color}` : "1px solid #e2e8f0", background: active ? `${color}14` : "#fff" }}>
      <span style={{ width: 12, height: 12, borderRadius: 4, background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 14, fontWeight: 800, color: "#0f172a" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color: active ? "#fff" : "#64748b", background: active ? color : "#f1f5f9", borderRadius: 999, padding: "2px 9px", minWidth: 22, textAlign: "center" }}>{count}</span>
    </button>
  );
}

// Fixed appointment windows: Mon–Thu 11/2/5/7, Fri 9/12/3, Sat 9/12 (day-of-week
// 1–4 / 5 / 6). Built in the rep's local time (reps are in ET).
const APPT_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
function genSlots(days = 14) {
  const out = []; const b = new Date();
  // Start at d=1 (tomorrow) — no same-day appointments.
  for (let d = 1; d <= days; d++) {
    const day = new Date(b.getFullYear(), b.getMonth(), b.getDate() + d);
    for (const h of (APPT_HOURS[day.getDay()] || [])) {
      out.push({ iso: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0).toISOString(), dt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0) });
    }
  }
  return out;
}
const dayKey = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const hourLabel = (d) => d.toLocaleTimeString("en-US", { hour: "numeric" });

const slotKey = (d) => `${d.toDateString()}-${d.getHours()}`;

// Pull a phone/email out of the pin's CSV "extra" columns if present.
const extraVal = (pin, names) => {
  const e = pin.extra || {};
  for (const k of Object.keys(e)) if (names.some((n) => k.toLowerCase().includes(n)) && e[k]) return String(e[k]);
  return "";
};
// The ORIGINAL appointment a no-sit was booked for (from the JN sync), in ET.
// Midnight-ET means no specific time was set → show the date only.
function origApptLabel(pin) {
  const sec = Number(pin && pin.extra && pin.extra.orig_appt_sec);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const d = new Date(sec * 1000);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const datePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(d);
  if (hm === "00:00" || hm === "24:00") return datePart;
  const timePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d);
  return `${datePart} · ${timePart}`;
}

function AppointmentModal({ pin, rt, onClose, onBooked, variant }) {
  // "btr" = book a Back-To-Retail appointment off an inspection pin (homeowner
  // declined the inspection, wants retail). Always a fresh booking + always
  // needs contact info. Otherwise: a reschedule (pin already has a JN job — e.g.
  // a synced no-sit) just resets the existing appointment, so no phone/email.
  const isBtr = variant === "btr";
  const isReschedule = !isBtr && !!pin.jn_job_id;
  const [phone, setPhone] = useState(pin.phone || extraVal(pin, ["phone", "mobile", "cell"]));
  const [email, setEmail] = useState(pin.email || extraVal(pin, ["email", "e-mail"]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [booked, setBooked] = useState(null); // null = still checking JN
  const [ownerInfo, setOwnerInfo] = useState(null); // BTR: whose calendar (rep or zone manager)

  // Pull already-booked appointments so we only offer free times. For a BTR the
  // calendar belongs to whoever RUNS it (the rep, or the zone manager for William).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const url = isBtr
          ? `/.netlify/functions/harvest-btr-availability?rt=${encodeURIComponent(rt)}&pin_id=${encodeURIComponent(pin.id)}`
          : `/.netlify/functions/harvest-availability?rt=${encodeURIComponent(rt)}`;
        const r = await fetch(url);
        const j = await r.json().catch(() => ({}));
        if (live) {
          setBooked(Array.isArray(j.booked) ? j.booked : []);
          if (isBtr) setOwnerInfo({ name: j.owner_name || "you", is_manager: !!j.is_manager, zone: j.zone || null });
        }
      } catch { if (live) setBooked([]); }
    })();
    return () => { live = false; };
  }, [rt, isBtr, pin.id]);

  const bookedKeys = useMemo(() => new Set((booked || []).map((ms) => slotKey(new Date(ms)))), [booked]);
  const slots = useMemo(() => genSlots(14).filter((s) => !bookedKeys.has(slotKey(s.dt))), [bookedKeys]);
  const byDay = {};
  for (const s of slots) (byDay[dayKey(s.dt)] = byDay[dayKey(s.dt)] || []).push(s);

  async function book(slot) {
    if (!isReschedule && phone.replace(/\D/g, "").length < 10) { setErr("Enter the homeowner's phone number first."); return; }
    setBusy(slot.iso); setErr("");
    try {
      const r = await fetch(isBtr ? "/.netlify/functions/harvest-book-btr-appt" : "/.netlify/functions/harvest-book-appt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rt, pin_id: pin.id, appt_iso: slot.iso, phone, email }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.error || "Couldn't book — try again."); setBusy(false); return; }
      onBooked({ status: "appt", jn_job_id: j.job_id, status_updated_at: new Date().toISOString() });
    } catch (e) { setErr(e.message || "Network error"); setBusy(false); }
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 3000, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 520, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: "16px 18px 22px", maxHeight: "88vh", overflowY: "auto", fontFamily: FONT }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", color: isBtr ? "#b45309" : "#166534" }}>{isBtr ? "🏠 Retail (BTR) appointment" : pin.status === "no_sit_reschedule" ? "🔄 Reschedule appointment" : "📅 Schedule appointment"}</div>
          <button type="button" onClick={() => !busy && onClose()} style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: "#475569", fontWeight: 600, marginBottom: pin.status === "no_sit_reschedule" ? 6 : 12 }}>{pin.name ? `${pin.name} · ` : ""}{pin.address}{pin.city ? `, ${pin.city}` : ""}</div>
        {isBtr && (
          <div style={{ fontSize: 12.5, color: "#b45309", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 9, padding: "8px 11px", marginBottom: 12 }}>
            Books a <b>retail</b> appointment in JobNimbus and counts on your pay like a sign-up.
            {ownerInfo?.is_manager
              ? <> Runs with <b>{ownerInfo.name}</b>{ownerInfo.zone ? ` (${ownerInfo.zone} manager)` : ""} — showing their availability.</>
              : ownerInfo ? <> Shows your availability.</> : null}
          </div>
        )}
        {pin.status === "no_sit_reschedule" && (
          <div style={{ fontSize: 12.5, color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 9, padding: "8px 11px", marginBottom: 12 }}>
            {origApptLabel(pin) ? <><b>Original appointment:</b> {origApptLabel(pin)}.</> : "No original appointment time on file."} Picking a new time resets it in JobNimbus and assigns it to you.
          </div>
        )}

        {!isReschedule && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (required)" inputMode="tel"
              style={{ flex: 1, minWidth: 150, fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", boxSizing: "border-box" }} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" inputMode="email"
              style={{ flex: 1, minWidth: 150, fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", boxSizing: "border-box" }} />
          </div>
        )}
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>{isBtr ? "Pick a time — booked times are hidden." : isReschedule ? "Pick a new time — it resets the appointment in JobNimbus under your name. Times you're already booked are hidden." : "Pick a time — it books the appointment into JobNimbus and turns this pin into an Appointment. Times you're already booked are hidden."}</div>
        {err && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{err}</div>}

        {booked === null ? <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>{isBtr && ownerInfo?.is_manager ? `Checking ${ownerInfo.name}'s calendar…` : "Checking your calendar…"}</div>
          : !slots.length ? <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>No open times in the next 2 weeks.</div>
          : (
        <div style={{ maxHeight: "48vh", overflowY: "auto" }}>
          {Object.keys(byDay).map((k) => (
            <div key={k} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#374151", marginBottom: 6 }}>{k}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {byDay[k].map((s) => (
                  <button key={s.iso} type="button" disabled={!!busy} onClick={() => book(s)}
                    style={{ border: "1px solid #16a34a", color: "#16a34a", background: "#fff", borderRadius: 12, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
                    {busy === s.iso ? "…" : hourLabel(s.dt)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
