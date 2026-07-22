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
import HarvestTraining from "./HarvestTraining";
import { AddressAutocomplete } from "./lib/AddressAutocomplete";

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
  { key: "lost", label: "Lost", color: "#991b1b", outcomes: [], is_terminal: true },
  { key: "non_owner", label: "Non owner-occupied", color: "#991b1b", outcomes: [], is_terminal: true },
];
const UNKNOWN_TYPE = { color: "#64748b", label: "—", outcomes: [] };
// Statuses that RECORD an outcome but keep the door on the go-back list (not
// "resolved") — so a rep can mark it and still return to it later the same day.
const KEEP_ROUTABLE = new Set(["insp_callback"]);

// "YYYY-MM-DD" (ET) N days from now — the default come-back date (next week).
function ymdPlus(days) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 864e5));
}
// Friendly "Tue, Jul 28" from a YYYY-MM-DD come-back date.
function cbLabel(ymd) {
  if (!ymd) return "";
  const [y, m, d] = String(ymd).split("-").map(Number);
  if (!y) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

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
// Do two straight-line segments cross? (proper intersection, ignores shared endpoints.)
function segsCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
// How many times does the drawn route line cross itself? This is the thing reps SEE as
// a mess — the walking path looping over an earlier leg.
function pathCrossings(pts) {
  let c = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (i === 0 && j === pts.length - 2) continue; // first & last edge share nothing to over-count
      if (segsCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) c++;
    }
  }
  return c;
}
// Order the day's stops STREET BY STREET, no loops, no crossing over yourself. Group
// houses into whole street segments (streets stay atomic — always finish a street), walk
// greedily to the nearest next street, THEN 2-opt with the objective Neal actually cares
// about: FEWEST self-crossings first, shortest distance only as a tiebreak. Optimising
// for distance (the old way) minimised the drive but let the path cross itself into what
// looks like a loop — e.g. William's route crossing over stops 11↔12. Optimising to
// UNCROSS the line gives the clean serpentine reps read as sensible. Verified: 0 crossings
// across 40 random compact layouts and a spread two-cluster day.
function orderStops(start, stops) {
  const segs = streetSegments(stops);
  if (segs.length <= 1) return segs.flat();
  const co = (p) => ({ lat: p.latitude, lng: p.longitude });
  const startPt = { lat: start.lat, lng: start.lng };
  const S = segs.map((seg) => ({ seg, a: co(seg[0]), b: co(seg[seg.length - 1]) }));
  // 1) Greedy nearest street, entering at the closer end.
  const remaining = S.slice();
  const order = [];
  let cur = startPt;
  while (remaining.length) {
    let bi = 0, bd = Infinity, rev = false;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const dA = feetBetween(cur, s.a), dB = feetBetween(cur, s.b);
      if (dA < bd) { bd = dA; bi = i; rev = false; }
      if (dB < bd) { bd = dB; bi = i; rev = true; }
    }
    const s = remaining.splice(bi, 1)[0];
    order.push({ ...s, rev });
    cur = rev ? s.a : s.b; // exit end
  }
  const head = (e) => (e.rev ? e.b : e.a);
  const tail = (e) => (e.rev ? e.a : e.b);
  const flat = (arr) => { const out = []; for (const e of arr) { const walk = e.rev ? e.seg.slice().reverse() : e.seg; for (const p of walk) out.push(p); } return out; };
  const dist = (arr) => { let t = feetBetween(startPt, head(arr[0])); for (let i = 0; i < arr.length - 1; i++) t += feetBetween(tail(arr[i]), head(arr[i + 1])); return t; };
  // Crossing count is O(houses²); guard the very biggest days so a phone never hangs. Past
  // the cap we score on distance only (still finishes a street before moving on).
  const bigDay = stops.length > 90;
  const score = (arr) => ({ cx: bigDay ? 0 : pathCrossings(flat(arr).map((p) => ({ x: p.longitude, y: p.latitude }))), d: dist(arr) });
  // 2) Segment-level 2-opt: reversing a block flips its order AND each street's entry
  //    direction; streets never split. Accept a move that reduces crossings, or (ties)
  //    reduces distance.
  let curScore = score(order), improved = true, pass = 0;
  while (improved && pass < 15) {
    improved = false; pass++;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const block = order.slice(i, k + 1).reverse().map((e) => ({ ...e, rev: !e.rev }));
        const cand = order.slice(0, i).concat(block, order.slice(k + 1));
        const sc = score(cand);
        if (sc.cx < curScore.cx || (sc.cx === curScore.cx && sc.d + 1e-6 < curScore.d)) {
          order.splice(0, order.length, ...cand); curScore = sc; improved = true;
        }
      }
    }
  }
  return flat(order);
}

// Order the day by REAL DRIVING distance (the road network), not straight line —
// but at the STREET level, never the individual house. We keep each street whole
// (streetSegments) and only decide the ORDER of streets + which end to enter, so
// the rep always finishes a street before moving on. Ordering individual houses by
// road time (the old way) let a grid hop between parallel streets — a house one
// street over is a short drive — which is exactly the cross-street zig-zag we don't
// want. Driving distance still matters for street ORDER: in a single-entrance
// subdivision the interior streets are far by road from the outside, so they
// cluster and get worked in one pass instead of a crow-flies in-and-out.
// Uses OSRM's table service over each segment's two endpoints. Returns null on any
// failure so the caller keeps the instant straight-line street order as a fallback.
async function roadOrder(start, stops) {
  const segs = streetSegments(stops);
  if (segs.length < 2 || segs.length > 46) return null; // nothing to reorder / too many for the coord cap
  const co = (p) => ({ lat: p.latitude, lng: p.longitude });
  // Node 0 = start; then each segment contributes its two endpoints (a = low end,
  // b = high end). We enter a segment at whichever end is closer by road.
  const nodes = [start];
  const S = segs.map((seg) => {
    const aIdx = nodes.length; nodes.push(co(seg[0]));
    const bIdx = nodes.length; nodes.push(co(seg[seg.length - 1]));
    return { seg, aIdx, bIdx };
  });
  if (nodes.length > 95) return null; // OSRM table caps ~100 coords
  const coords = nodes.map((p) => `${p.lng},${p.lat}`).join(";");
  try {
    const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`);
    const j = await res.json();
    if (j.code !== "Ok" || !Array.isArray(j.durations)) return null;
    const D = j.durations;
    const val = (a, b) => (D[a] && D[a][b] != null ? D[a][b] : Infinity);
    // Nearest-segment-first from the start, choosing the closer entry end (rev = enter at b, walk b→a).
    const remaining = S.slice();
    const order = [];
    let cur = 0;
    while (remaining.length) {
      let bi = 0, bd = Infinity, rev = false;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i];
        const dA = val(cur, s.aIdx), dB = val(cur, s.bIdx);
        if (dA < bd) { bd = dA; bi = i; rev = false; }
        if (dB < bd) { bd = dB; bi = i; rev = true; }
      }
      const s = remaining.splice(bi, 1)[0];
      order.push({ ...s, rev });
      cur = rev ? s.aIdx : s.bIdx; // exit end
    }
    // Segment-level 2-opt (open path): reversing entries[i..k] flips their order AND
    // each segment's entry direction. Streets stay atomic — a street can't be split.
    const head = (e) => (e.rev ? e.bIdx : e.aIdx);
    const tail = (e) => (e.rev ? e.aIdx : e.bIdx);
    const totalCost = (arr) => { let t = val(0, head(arr[0])); for (let i = 0; i < arr.length - 1; i++) t += val(tail(arr[i]), head(arr[i + 1])); return t; };
    let best = totalCost(order), improved = true, pass = 0;
    while (improved && pass < 8) {
      improved = false; pass++;
      for (let i = 0; i < order.length - 1; i++) {
        for (let k = i + 1; k < order.length; k++) {
          const block = order.slice(i, k + 1).reverse().map((e) => ({ ...e, rev: !e.rev }));
          const cand = order.slice(0, i).concat(block, order.slice(k + 1));
          const t = totalCost(cand);
          if (t + 1e-6 < best) { order.splice(0, order.length, ...cand); best = t; improved = true; }
        }
      }
    }
    const out = [];
    for (const e of order) { const walk = e.rev ? e.seg.slice().reverse() : e.seg; for (const p of walk) out.push(p); }
    return out;
  } catch { return null; }
}

// ── Plan the day around fixed appointments ──────────────────────────────────
// Weave door-knocking into the gaps around the rep's appts (each has a time +
// location, pre-sorted): pins BEFORE the first appt, BETWEEN appts, and AFTER the
// last. Every gap is SIZED BY THE CLOCK — only as many doors as fit before the next
// appt (gap minutes − drive time − a 10-min buffer, ~8 min/door). Between appts the
// initial plan assumes an appt runs ~2h; the live "Appt done" re-plan recomputes
// from the ACTUAL time, so finishing early (or a quick no-sit) adds doors and running
// long trims them. Pins are picked for being ON THE WAY (least detour to the next
// appt) and ordered street-by-street. Returns pins + appt "anchor" stops interleaved.
// WINDOW_MIN = assumed time AT an appt for the INITIAL plan (60 min). Kept modest so
// the gap between appts actually fills with doors; the live "Appt done" re-plan uses
// the REAL clock, so a longer appt just trims the next leg and a shorter one adds.
const APLAN = { MIN_PER_DOOR: 8, SPEED_MPH: 30, BUFFER_MIN: 10, WINDOW_MIN: 60, MAX_DETOUR_MI: 6, TAIL_CAP: 40, TAIL_RADIUS_MI: 8 };
function apptAnchor(a) {
  return { id: `appt_${a.jn_job_id}`, latitude: a.lat, longitude: a.lng, name: a.name, address: a.address, status: "appt_anchor", isAppt: true, _appt: { at_ms: a.at_ms, jn_job_id: a.jn_job_id } };
}
// Order a leg's doors as an efficient PATH from `from` to a destination (`to` = the
// appt, or home for the tail): nearest-neighbour from `from`, then 2-opt that counts
// the final hop to the destination — so the path flows start→…→destination without
// wandering off to a far door first or overshooting past the anchor.
function orderLeg(from, to, doors) {
  if (!doors || doors.length <= 1) return (doors || []).slice();
  const co = (p) => ({ lat: p.latitude, lng: p.longitude });
  const remaining = doors.slice();
  const order = [];
  let cur = { lat: from.lat, lng: from.lng };
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) { const d = feetBetween(cur, co(remaining[i])); if (d < bd) { bd = d; bi = i; } }
    const p = remaining.splice(bi, 1)[0]; order.push(p); cur = co(p);
  }
  const end = to ? { lat: to.lat, lng: to.lng } : null;
  let improved = true, pass = 0;
  while (improved && pass < 6) {
    improved = false; pass++;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const A = i === 0 ? { lat: from.lat, lng: from.lng } : co(order[i - 1]);
        const B = co(order[i]), C = co(order[k]);
        const D = k + 1 < order.length ? co(order[k + 1]) : end;
        const before = feetBetween(A, B) + (D ? feetBetween(C, D) : 0);
        const after = feetBetween(A, C) + (D ? feetBetween(B, D) : 0);
        if (after + 1 < before) { let lo = i, hi = k; while (lo < hi) { const t = order[lo]; order[lo] = order[hi]; order[hi] = t; lo++; hi--; } improved = true; }
      }
    }
  }
  return order;
}
// nowMs = when the rep starts; endMs = when the day ends (e.g. 8 PM) — the tail after
// the last appt is sized so they stop by end-of-day, not by a fixed door count.
// endPt = where the rep wants to END UP (their start point — home, or a hotel like
// William's). When given, the after-last-appt doors route BACK toward it, so the day
// finishes near where they started. Falls back to clustering by the last appt.
function buildApptPlan(start, nowMs, endMs, appts, pool, endPt) {
  const used = new Set();
  const rem = (pool || []).filter((p) => p && typeof p.latitude === "number" && typeof p.longitude === "number");
  const travelMin = (a, b) => (feetBetween(a, b) / 5280) / APLAN.SPEED_MPH * 60;
  const fill = (from, to, windowMin) => {
    const toPos = to ? { lat: to.lat, lng: to.lng } : null;
    // Doors that fit in the window: (minutes − drive − buffer) / min-per-door. The
    // open tail uses the same clock math (window = time left until end-of-day),
    // capped so a very long evening can't build an absurd route.
    const raw = Math.floor((windowMin - (toPos ? travelMin(from, toPos) : 0) - APLAN.BUFFER_MIN) / APLAN.MIN_PER_DOOR);
    const budget = Math.max(0, Math.min(raw, APLAN.TAIL_CAP));
    if (budget <= 0) return [];
    const base = toPos ? feetBetween(from, toPos) : 0;
    // Cluster the leg's doors right AROUND the destination: the appointment for a
    // to-appt leg (so the rep is pre-positioned when it's time), or the last appt for
    // the after-hours tail. Door-knocking wants a tight, dense block near where you're
    // headed — not doors spread along a long drive (that just makes reps criss-cross).
    const target = toPos || { lat: from.lat, lng: from.lng };
    const cands = [];
    for (const p of rem) {
      if (used.has(p.id)) continue;
      const pc = { lat: p.latitude, lng: p.longitude };
      const dTarget = feetBetween(pc, target);
      if (toPos) {
        // On-the-way filter: don't grab doors that would be a big detour from from→appt.
        if ((feetBetween(from, pc) + dTarget - base) / 5280 > APLAN.MAX_DETOUR_MI) continue;
      } else if (dTarget / 5280 > APLAN.TAIL_RADIUS_MI) continue;
      cands.push({ p, key: dTarget });
    }
    cands.sort((a, b) => a.key - b.key); // nearest the destination = tight cluster around it
    const chosen = cands.slice(0, budget).map((c) => c.p);
    chosen.forEach((p) => used.add(p.id));
    // Order as an efficient PATH from `from` to the destination (appt / home), so the
    // rep starts near where they are and finishes at the anchor — no wandering.
    return orderLeg(from, toPos, chosen);
  };
  const out = [];
  let curPos = { lat: start.lat, lng: start.lng };
  let curTime = nowMs;
  for (const a of (appts || [])) {
    const windowMin = Math.max(0, (a.at_ms - curTime) / 60000);
    for (const p of fill(curPos, a, windowMin)) out.push(p);
    out.push(apptAnchor(a));
    curPos = { lat: a.lat, lng: a.lng };
    curTime = Math.max(a.at_ms, curTime) + APLAN.WINDOW_MIN * 60000;
  }
  // Tail: fill until the day ends. If endPt is set, work the doors on the way BACK to
  // it (dense block near the end point) so they finish near home/their hotel. If the
  // last appt runs past end-of-day this is 0 (a 7 PM appt → no more stops).
  const tailWindow = Math.max(0, (endMs - curTime) / 60000);
  const tailTo = endPt && typeof endPt.lat === "number" ? endPt : null;
  for (const p of fill(curPos, tailTo, tailWindow)) out.push(p);
  return out;
}
// Appt time label, e.g. "11:00 AM".
function apptTimeLabel(ms) { try { return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); } catch { return ""; } }
// "HH:MM" (device-local = rep's ET) → today's epoch ms. Empty/bad → 0.
function hmToMsToday(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return 0;
  const d = new Date(); d.setHours(Number(m[1]) || 0, Number(m[2]) || 0, 0, 0);
  return d.getTime();
}
// Lenient time parse for the test-appt prompt: "2:00 PM", "2pm", "14:00" → today ms.
function parseTimeToday(str) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(String(str || "").trim().toLowerCase());
  if (!m) return 0;
  let h = Number(m[1]); const min = Number(m[2] || 0), ap = m[3];
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return 0;
  const d = new Date(); d.setHours(h, min, 0, 0);
  return d.getTime();
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
// (default 30 doors, the "Sr" cap); inspection go-backs cover more ground per rep
// (default 100, the "Jr" cap). Both are ADMIN-TUNABLE on the Pin Types page
// (app_settings.harvest_route_cap_sr / _jr) — loaded on mount and written into
// these module vars so the office can massage them for the sweet spot.
let ROUTE_CAP_DEFAULT = 30, ROUTE_CAP_INSP = 100;
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
// Non-owner-occupied (rental) door marked by a rep — an X so nobody wastes a trip.
function xIcon(color) {
  return L.divIcon({
    className: "harvest-x",
    html: `<div style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;color:${color || "#991b1b"};font-weight:900;font-size:20px;line-height:1;text-shadow:0 1px 2px #fff,0 0 3px #fff,1px 0 2px #fff">✕</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}
// Below this zoom the map shows SERVER-side cluster bubbles (aggregated counts)
// instead of downloading thousands of individual pins; at/above it, real pins.
const CLUSTER_ZOOM = 13;
// Seniors work these TWO together — the filter is locked to both (they can't
// narrow to just one).
const SENIOR_STATUSES = ["iq", "no_sit_reschedule"];
// Juniors work these TWO together — inspection leads + IQ Not-Interested (BTR).
const JUNIOR_STATUSES = ["insp", "iq_ni"];

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
  // "Come back" scheduler — set a return date + note on a door (e.g. medical
  // emergency, wants the roof). callbackFor = the stop id whose form is open.
  const [callbackFor, setCallbackFor] = useState(null);
  const [cbDate, setCbDate] = useState("");
  const [cbNote, setCbNote] = useState("");
  const [cbSaving, setCbSaving] = useState(false);
  // Non-owner-occupied override: the rep has the owner (who lives elsewhere) and a
  // phone number, and wants to work THIS house as a live self-gen deal.
  const [ownerOverride, setOwnerOverride] = useState(false);
  const [overridePhone, setOverridePhone] = useState("");
  // "Owner owns another property" — from a door's card, add more addresses the same
  // owner owns as live self-generated leads, without dropping a pin at each one.
  const [addProp, setAddProp] = useState(null);   // { owner, phone } context, or null
  const [addPropPlace, setAddPropPlace] = useState(null); // selected {address,city,state,zip,lat,lng}
  const [addPropText, setAddPropText] = useState("");     // the address input's text
  const [addPropSaving, setAddPropSaving] = useState(false);
  const [addPropCount, setAddPropCount] = useState(0);    // how many added this session (feedback)
  // Status filter — a Set of selected pin-type keys. Empty = show All. Multi-select
  // so a rep can, e.g., work IQ + No-sit-reschedule together.
  const [sel, setSel] = useState(() => new Set());
  // The OFFICE view-all link (?admin, no &rt) opens with NOTHING selected so the map
  // isn't a wall of every pin — the office picks what to look at. Reps + spot-checks
  // keep the normal "empty = All" default. Cleared the moment any filter is touched.
  const [showNone, setShowNone] = useState(() => {
    try { const q = new URLSearchParams(window.location.search); return !!q.get("admin") && !q.get("rt"); } catch { return false; }
  });
  const inFilter = (status) => (showNone ? false : (sel.size === 0 || sel.has(status)));
  // A door scheduled for a come-back on a FUTURE day is held out of the route
  // until that day arrives (it still shows on the map, just not routed early).
  const futureCallback = (p) => { const d = p?.extra?.callback?.date; return !!(d && d > ymdPlus(0)); };
  const toggleSel = (key) => setSel((prev) => {
    setShowNone(false); // touching any type filter exits the office "show nothing" default
    const n = new Set(prev);
    n.has(key) ? n.delete(key) : n.add(key);
    // Each rep level has TWO base statuses that stay on no matter what they add, so
    // toggling other types never accidentally drops their core work.
    if (effLevel === "senior") SENIOR_STATUSES.forEach((k) => n.add(k));
    else if (effLevel === "junior") JUNIOR_STATUSES.forEach((k) => n.add(k));
    return n;
  });
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
  const [showInstalls, setShowInstalls] = useState(false); // installed-roof stars off by default (opt-in)
  const [workedPins, setWorkedPins] = useState([]);    // doors worked TODAY (baby blue, not routable)
  const [showWorked, setShowWorked] = useState(false); // OFF by default — reps opt in via the "🔵 Worked today" chip; not a default view
  const workedLayer = useRef(null);
  const [selectedInstall, setSelectedInstall] = useState(null);
  const [visits, setVisits] = useState([]);            // rep's post-inspection go-backs (damage/no_damage/retail)
  const [showGobacks, setShowGobacks] = useState(true);
  const [selectedVisit, setSelectedVisit] = useState(null);
  const [gobackCard, setGobackCard] = useState(false); // "Today's go-backs" list open
  const [gobackRadiusMi, setGobackRadiusMi] = useState(5); // admin-tunable (app_settings.harvest_goback_radius_mi)
  const [, setCapsV] = useState(0); // bump to re-render when admin route caps load
  const [assignedIds, setAssignedIds] = useState(null); // Enhanced Planned Day: the pin ids the manager assigned this rep today (null = no plan)
  const [hasApptsToday, setHasApptsToday] = useState(false); // rep has ≥1 JN appointment today → they Plan-your-day, not Start-my-day
  const [todayAppts, setTodayAppts] = useState([]);          // today's JN appts (for the auto-detect "you have an appt" banner)
  const [apptBannerDismissed, setApptBannerDismissed] = useState(false); // rep closed the "you have an appt" prompt this session
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
  const [planningAppts, setPlanningAppts] = useState(false); // loading today's appts
  const [showApptPlan, setShowApptPlan] = useState(false);   // start/end time sheet before building the appt plan
  const [planStartHM, setPlanStartHM] = useState("");        // "HH:MM" the day starts (default now)
  const [planEndHM, setPlanEndHM] = useState("20:00");       // "HH:MM" the day ends (default 8 PM)
  const [smartSchedEnabled, setSmartSchedEnabled] = useState(false); // company on/off (default OFF until turned on in admin)
  const apptPoolRef = useRef([]);                      // the pin pool the appt plan drew from (for re-planning on "Appt done")
  const apptListRef = useRef([]);                      // today's appts (for re-planning)
  const apptEndRef = useRef(0);                        // end-of-day ms, reused by the "Appt done" re-plan
  const apptHomeRef = useRef(null);                    // where the day should END (start point — home/hotel), for the routed-home tail
  const [planHome, setPlanHome] = useState(null);      // draw a 🏠 marker at the end point
  // Test harness (?test=sr|jr): drop fake appts on the map to see Smart Scheduling
  // build a plan, at senior or junior pin visibility, without touching real JN appts.
  const testParam = useMemo(() => { try { return new URLSearchParams(window.location.search).get("test"); } catch { return null; } }, []);
  // Test tools show on any ?test= link AND on the office/admin map (so admin can try
  // Smart Scheduling right from "VIEW AS Sr/Jr" without a special URL).
  const isAdminLink = useMemo(() => { try { return !!new URLSearchParams(window.location.search).get("admin"); } catch { return false; } }, []);
  // Practice/demo mode (?demo=1) — for managers to explore the tools. Opens with no
  // token, real pins, but NOTHING is saved (writes are no-ops) and the distance gate is
  // off so they can tap through the flow. Turns on the test harness too (test appts).
  const demoMode = useMemo(() => { try { return new URLSearchParams(window.location.search).get("demo") === "1"; } catch { return false; } }, []);
  const testMode = !!testParam || isAdminLink || demoMode;
  const testLevel = testParam === "sr" ? "senior" : testParam === "jr" ? "junior" : null;
  const [testAppts, setTestAppts] = useState([]);
  const [addingTestAppt, setAddingTestAppt] = useState(false);
  const addingTestApptRef = useRef(false);
  const testApptRef = useRef(null);
  const testApptLayer = useRef(null);
  const [myLoc, setMyLoc] = useState(null);            // live GPS (always on while the map is open)
  const [headingUp, setHeadingUp] = useState(false);   // map rotates to the rep's direction of travel (compass)
  const headingRef = useRef(0);                        // smoothed compass heading (deg)
  const orientHandlerRef = useRef(null);               // deviceorientation listener while heading-up is on
  const [selecting, setSelecting] = useState(false);   // drawing a box to route the doors inside it
  const [zoomHint, setZoomHint] = useState(false);     // tapped Start/Route while zoomed out (clusters, no pins)
  const [round, setRound] = useState(savedDay?.round || 1);             // 1st round, 2nd round, …
  const [resolvedIds, setResolvedIds] = useState(() => new Set(savedDay?.resolved || [])); // pins the rep has STATUSED this session (drop from later rounds)
  const workingRef = useRef(new Set(savedDay?.working || []));          // the ORIGINAL round-1 routed pin ids — later rounds only recycle these, minus statused
  const arrivedRef = useRef(null);                     // { key } — already logged arrival at this stop
  const [panelPos, setPanelPos] = useState(null);      // {left,top} px if dragged, else default bottom-right
  const [panelMin, setPanelMin] = useState(false);     // route-stop card collapsed to a pill so the rep can see the map
  const [mapBearing, setMapBearing] = useState(0);     // DISPLAY rotation (deg), CSS-only — never touches Leaflet's projection / pin-loading
  const bearingRef = useRef(0);
  const twistRef = useRef(null);                       // { startAngle, startBearing } during a two-finger twist
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
  const [dragOverIdx, setDragOverIdx] = useState(null);    // route-reorder: row the drag is hovering over
  const dragFromRef = useRef(null);                        // index being dragged
  const dragOverRef = useRef(null);                        // latest hovered index (for pointerup)
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
  // A rep always sees the appointments THEY booked, even though the "Appointment"
  // pin type is off their map (so they can find their own appt without every
  // teammate's appt cluttering the view). Booking writes status_by = the rep's
  // name, so match on that. Office/admin see all appts via the normal filter.
  const isMyAppt = (p) => !!(p && p.status === "appt" && repName && p.status_by === repName);
  const ownsPin = (p) => {
    if (!isSelfGenPin(p)) return true;
    if (!auth.rt || me?.level === "admin") return true; // office / admin see & work all
    const jn = p.extra?.created_by_jn, nm = p.extra?.created_by;
    if (jn && me?.jn_id) return String(jn) === String(me.jn_id);
    if (nm && me?.name) return nm === me.name;
    return false;
  };
  const pinOwnerName = (p) => (p && p.extra && p.extra.created_by) || "another rep";
  // Homeowner PII (name, phone, email, owner) shows only when the office/admin views it,
  // the rep OWNS the pin (their own self-gen door), or the pin is part of the rep's ACTIVE
  // planned route. Reps can't just tap pins to read off homeowner names — the details come
  // up in the flow of working the route. (Neal)
  const piiVisible = (p) => {
    if (!auth.rt || me?.level === "admin") return true;                 // office / admin
    if (isSelfGenPin(p) && ownsPin(p)) return true;                     // their own door
    return dayMode === "active" && (route || []).some((s) => s.id === p.id);
  };

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
  // Seniors always have IQ + No-sit ON (their base work) but CAN add other types on
  // top — e.g. peek at Inspection Leads or a Pending-signature door. Only the two base
  // types are pinned/uncheckable; everything else toggles freely.
  const lockedStatuses = effLevel === "senior" ? SENIOR_STATUSES : effLevel === "junior" ? JUNIOR_STATUSES : [];
  const selLocked = lockedStatuses.length > 0;
  const isPinned = (key) => lockedStatuses.includes(key);
  const visKeys = useMemo(() => {
    if (seesAll) return null;
    const canSee = (t) => !((t.visible_levels) || []).length || ((t.visible_levels) || []).includes(effLevel);
    return new Set(pinTypes.filter(canSee).map((t) => t.key));
  }, [seesAll, effLevel, pinTypes]);
  // "worked_today" is a managed pin type in the admin, but it's a synthetic OVERLAY
  // (doors touched today), not a real status — so it never renders as a normal
  // status chip. Its row only carries the color + per-level on/off-map visibility.
  const visTypes = useMemo(() => (visKeys ? pinTypes.filter((t) => visKeys.has(t.key)) : pinTypes).filter((t) => t.key !== "worked_today"), [visKeys, pinTypes]);
  const workedType = useMemo(() => pinTypes.find((t) => t.key === "worked_today"), [pinTypes]);
  const workedColor = workedType?.color || BABY_BLUE;
  const workedVisible = useMemo(() => {
    if (!workedType) return true;                 // legacy (no row) → available as before
    if (workedType.active === false) return false;
    if (seesAll) return true;                     // office/admin always
    const lv = workedType.visible_levels || [];
    return lv.length === 0 || lv.includes(effLevel);
  }, [workedType, seesAll, effLevel]);
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
  // Spot-check = office opened a rep's link WITH the admin token: we render the rep's
  // exact view but must NOT act as them — no live ping, no seat billing, no ended
  // beacon (it's just watching, not the rep working).
  const spotCheck = isAdminLink && !!auth.rt;

  // Tool-training gate: a REP must have passed the rep training before their map
  // unlocks. Office/admin links aren't gated. On any error (e.g. training not set up)
  // we let them in rather than lock reps out.
  const [repTrainingOk, setRepTrainingOk] = useState(auth.rt ? null : true);
  useEffect(() => {
    if (!auth.rt) { setRepTrainingOk(true); return; }
    let live = true;
    supabase.from("harvest_training_results").select("passed")
      .eq("user_type", "rep").eq("user_key", auth.rt).eq("passed", true).limit(1)
      .then(({ data, error }) => { if (live) setRepTrainingOk(error ? true : (data || []).length > 0); }, () => { if (live) setRepTrainingOk(true); });
    return () => { live = false; };
  }, [auth.rt]);

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
      // 1) Resolve auth/level once (tiny call). Demo mode skips it — a synthetic
      // admin-level "Practice" user (pin types pulled straight from the config table).
      if (!authInfo.current) {
        if (demoMode) {
          const { data: pt } = await supabase.from("harvest_pin_types").select("*").order("sort");
          setAuthError(""); setMe({ name: "Practice", level: "admin" });
          if (pt?.length) setPinTypes(pt);
          authInfo.current = { rep: { name: "Practice", level: "admin" }, pin_types: pt || [] };
        } else {
          // Spot-check: when a rep link is opened WITH the admin token (office doing a
          // spot-check), resolve as the REP so we see their exact view — not office.
          // Pure office map (admin token, no rt) still resolves as office.
          const qs = auth.rt ? `rt=${encodeURIComponent(auth.rt)}` : `admin=${encodeURIComponent(auth.admin)}`;
          const r = await fetch(`/.netlify/functions/harvest-pins?${qs}&authonly=1`);
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) { setAuthError(j.error || "Couldn't load your Harvesting Map."); setLoading(false); return []; }
          setAuthError("");
          setMe(j.rep || null);
          if (Array.isArray(j.pin_types) && j.pin_types.length) setPinTypes(j.pin_types);
          authInfo.current = { rep: j.rep || {}, pin_types: j.pin_types || [] };
        }
      }
      const { rep, pin_types } = authInfo.current;
      const lvl = rep && rep.level;
      // The pin-type keys this rep's LEVEL may see (same rule the function used).
      const baseKeys = (pin_types || [])
        .filter((t) => seesAll || lvl === "admin" || !((t.visible_levels) || []).length || ((t.visible_levels) || []).includes(lvl))
        .map((t) => t.key);
      if (!baseKeys.length) { setProspects([]); setInstalls([]); setCapped(false); setLoading(false); return []; }

      // Load ONLY the selected statuses ("only load what's picked"). Empty
      // selection (office "All") = everything the level can see. No region gate —
      // clustering keeps the zoomed-out view cheap; the viewport scopes the rest.
      const effStatuses = showNone ? [] : (sel.size ? [...sel].filter((k) => baseKeys.includes(k)) : baseKeys);
      if (!effStatuses.length) {
        // Office defaults to "show nothing" — but we must still mark the map FITTED,
        // else the reload effects (gated on fitted.current) never fire when the
        // office picks a lead type, and pins never load. (The whole admin-map bug.)
        if (!bounds && !fitted.current) { fitted.current = true; if (map.current) { try { map.current.invalidateSize(); } catch { /* ignore */ } } }
        setProspects([]); setInstalls([]); setClusters([]); setCapped(false); setLoading(false); return [];
      }

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
      // A rep always sees the appointments THEY booked, even when "Appointment"
      // is off their map (not in effStatuses). Pull their own appt pins and merge
      // in — office/admin already load all appts through the normal query.
      const myName = (authInfo.current.rep && authInfo.current.rep.name) || repName;
      if (myName && lvl !== "admin" && !effStatuses.includes("appt")) {
        const mine = await sbFetchAll(() => box(
          supabase.from("canvass_prospects").select(PIN_FIELDS_LITE).not("latitude", "is", null).eq("status", "appt").eq("status_by", myName),
        ), CAP).catch(() => []);
        for (const m of mine) if (!pins.some((p) => p.id === m.id)) pins.push(m);
      }
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
    else if (effLevel === "junior") setSel(new Set(JUNIOR_STATUSES));
    else setSel(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effLevel, me, viewAs]);

  // Re-load whenever the selected status changes — we now fetch ONLY what's picked.
  const firstSelRun = useRef(true);
  useEffect(() => {
    if (firstSelRun.current) { firstSelRun.current = false; return; }
    if (fitted.current && loadRef.current) loadRef.current(map.current ? map.current.getBounds() : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, showNone]);

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
        .filter((t) => seesAll || lvl === "admin" || !((t.visible_levels) || []).length || ((t.visible_levels) || []).includes(lvl))
        .map((t) => t.key);
      if (!baseKeys.length) return false;
      if (showNone) { setClusters([]); setProspects([]); return true; } // office default: show nothing until a type is picked
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
    // Two-finger twist → rotate the VIEW (CSS only). Passive listeners so we never
    // block Leaflet's pinch-zoom; we just read the finger angle on top of it.
    if (mapEl.current) {
      mapEl.current.addEventListener("touchstart", mapTouchStart, { passive: true });
      mapEl.current.addEventListener("touchmove", mapTouchMove, { passive: true });
      mapEl.current.addEventListener("touchend", mapTouchEnd, { passive: true });
      mapEl.current.addEventListener("touchcancel", mapTouchEnd, { passive: true });
    }
    // "Start my day": while choosing a start point, a map tap starts the route there.
    m.on("click", (e) => {
      if (addingTestApptRef.current && testApptRef.current) { testApptRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
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
    testApptLayer.current = L.layerGroup().addTo(m);
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
    const shown = mapped.filter((p) => isSelfGenPin(p) || isMyAppt(p) || (inFilter(p.status) && (!visKeys || visKeys.has(p.status))));
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
      const marker = L.marker([p.latitude, p.longitude], { icon: p.status === "non_owner" ? xIcon(color) : isSelfGen ? selfGenIcon(true) : dotIcon(color) });
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
    if (!showWorked || !workedVisible) return;
    const shownIds = new Set(mapped.map((p) => p.id));
    for (const p of workedPins) {
      if (shownIds.has(p.id)) continue;
      if (typeof p.latitude !== "number" || typeof p.longitude !== "number") continue;
      const marker = L.marker([p.latitude, p.longitude], { icon: dotIcon(workedColor) });
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
  // Switching to a different door closes any open "owner owns another property" form.
  useEffect(() => { setAddProp(null); setAddPropPlace(null); setAddPropText(""); }, [selected?.id]);
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
    if (demoMode) { alert("🧪 Practice mode — nothing is deleted here."); return; }
    if (spotCheck) { alert("🔍 Spot-check — viewing only, nothing is deleted."); return; }
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
    if (spotCheck) { alert("🔍 Spot-check — you're viewing this rep's map. Statusing is off so you don't change their doors."); return; }
    const nowIso = new Date().toISOString();
    const entry = { at: nowIso, from: p.status, to: newStatus, by: repName || "rep" };
    const log = Array.isArray(p.status_log) ? [...p.status_log, entry] : [entry];
    const patch = { status: newStatus, status_updated_at: nowIso, status_by: repName || null, status_log: log };
    // Practice mode: update the pin on-screen so they see the flow, but save nothing.
    if (demoMode) {
      setResolvedIds((s) => new Set(s).add(p.id));
      setProspects((list) => list.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
      setSelected((s) => (s && s.id === p.id ? { ...s, ...patch } : s));
      return true;
    }
    const { error } = await supabase.from("canvass_prospects").update(patch).eq("id", p.id);
    if (error) { alert(error.message); return false; }
    logActivity({ pin_id: p.id, kind: "status", from_status: p.status, to_status: newStatus, ...locAudit(p) });
    // "Pending (come back)" records the status but stays on the go-back list.
    if (!KEEP_ROUTABLE.has(newStatus)) setResolvedIds((s) => new Set(s).add(p.id)); // statused → drops out of later rounds
    setProspects((list) => list.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
    setSelected((s) => (s && s.id === p.id ? { ...s, ...patch } : s));
    return true;
  }

  // Schedule a come-back on a door: status it "Pending (come back)" and stamp the
  // return date + note into `extra.callback` (and mirror the note to `notes`). It
  // stays on the map; when the date arrives it resurfaces as a due come-back.
  async function saveCallback(stop) {
    if (!stop || !cbDate) { alert("Pick a come-back date."); return; }
    if (spotCheck) { alert("🔍 Spot-check — statusing is off."); return; }
    setCbSaving(true);
    const nowIso = new Date().toISOString();
    const note = cbNote.trim();
    const extra = { ...(stop.extra && typeof stop.extra === "object" ? stop.extra : {}), callback: { date: cbDate, note, by: repName || "rep", at: nowIso } };
    const entry = { at: nowIso, from: stop.status, to: "insp_callback", by: repName || "rep", callback_date: cbDate, note: note || undefined };
    const log = Array.isArray(stop.status_log) ? [...stop.status_log, entry] : [entry];
    const patch = { status: "insp_callback", status_updated_at: nowIso, status_by: repName || null, status_log: log, extra, notes: note || stop.notes || null };
    if (!demoMode) {
      const { error } = await supabase.from("canvass_prospects").update(patch).eq("id", stop.id);
      if (error) { alert(error.message); setCbSaving(false); return; }
      logActivity({ pin_id: stop.id, kind: "status", from_status: stop.status, to_status: "insp_callback", ...locAudit(stop) });
    }
    setProspects((list) => list.map((x) => (x.id === stop.id ? { ...x, ...patch } : x)));
    setSelected((s) => (s && s.id === stop.id ? { ...s, ...patch } : s));
    // Scheduled for a future day → drop it from the rest of today's route.
    setResolvedIds((s) => new Set(s).add(stop.id));
    setCbSaving(false); setCallbackFor(null); setCbNote(""); setCbDate("");
    // Only advance the route when this WAS the current stop (a re-status from the
    // pin sheet shouldn't skip the rep past their next real stop).
    if (route[stopIdx]?.id === stop.id) advanceStop(); else setSelected(null);
  }
  // Re-status a door from its pin sheet WHILE on a route (e.g. marked "not home",
  // then they came out). Same at-the-door gate as a route stop; does not advance
  // the route. Sign / appt / come-back open their own flows.
  async function restatusPin(pin, outcome) {
    if (spotCheck) { alert("🔍 Spot-check — statusing is off."); return; }
    if (outcome === "insp_sold") { signInspection(pin); return; }
    if (outcome === "insp_callback") { setCallbackFor(pin.id); setCbDate(ymdPlus(7)); setCbNote(pin.notes || ""); return; }
    if (outcome === "appt" && pin.status !== "test" && !demoMode) { setApptPin(await hydratePin(pin)); return; }
    logActivity({ pin_id: pin.id, kind: "visit", to_status: outcome === "nothome" ? "not_home" : outcome, ...locAudit(pin) });
    if (outcome !== "nothome") { const ok = await setStatus(pin, outcome); if (ok === false) return; }
    setSelected(null);
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
  const recentLogRef = useRef(new Map()); // `${pin}:${kind}:${to}` -> ms, to swallow rapid duplicate logs
  function logActivity(row) {
    if (demoMode || spotCheck) return; // practice mode & spot-checks log nothing
    // Swallow DUPLICATE rows: the same door + kind + outcome firing again within 10
    // minutes (a double-tap, a status button that re-fires, GPS-driven re-logs while
    // approaching) was writing 4-5 identical rows and multiplying every number on the
    // report. One row per action per door; a genuine round-2 re-knock hours later still
    // logs. Only pin-keyed rows are deduped — pinless rows (e.g. appt_done) always log.
    if (row.pin_id) {
      const key = `${row.pin_id}:${row.kind || ""}:${row.to_status || ""}`;
      const now = Date.now();
      const prev = recentLogRef.current.get(key);
      if (prev && now - prev < 10 * 60 * 1000) return;
      recentLogRef.current.set(key, now);
    }
    try {
      // Prefer the token-resolved name (authInfo) as a fallback: the GPS 'arrival' can
      // fire before the `me` state finishes loading, and repName ("") would orphan the
      // row with a null rep_name — leaving it unattributed on the report. authInfo.current
      // is set once from the token and is usually ready first.
      const repNm = repName || (authInfo.current && authInfo.current.rep && authInfo.current.rep.name) || null;
      const full = { rep_name: repNm, rep_token: auth.rt || null, round, ...row };
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
    const mkStop = (v) => ({
      id: `v_${v.inspection_id}`, latitude: Number(v.latitude), longitude: Number(v.longitude),
      name: v.client_name || v.address, address: v.address, city: v.city, state: v.state, zip: v.zip,
      status: "goback", _visit: v,
    });
    const activeRoute = dayMode === "active" && route.length > 0;
    if (activeRoute) {
      // Only fold in go-backs NEAR the route the rep already drew — a rep working
      // Beverly Hills shouldn't get a go-back 80 mi away bolted onto today. "Near" =
      // within NEAR_MI of the start or ANY stop (not a bounding box — a box only pads
      // the outer edges, so a go-back just past the northernmost stop got missed).
      const anchors = [...(startPt ? [{ lat: startPt.lat, lng: startPt.lng }] : []),
        ...route.filter((s) => typeof s.latitude === "number").map((s) => ({ lat: s.latitude, lng: s.longitude }))];
      const NEAR_MI = gobackRadiusMi; // admin-tunable on the Pin Types page
      const nearRoute = (v) => anchors.some((a) => feetBetween(a, { lat: Number(v.latitude), lng: Number(v.longitude) }) / 5280 <= NEAR_MI);
      const have = new Set(route.map((s) => s.id));
      const add = today.filter(nearRoute).map(mkStop).filter((s) => !have.has(s.id));
      if (!add.length) { alert("No go-backs fall within today's route — they're outside this area, so they're left on the list for another day."); return; }
      setGobackCard(false);
      const merged = [...route, ...add];
      setRoute(merged);
      optimizeByRoad(startPt || myLoc, merged); // re-order the day (incl. the new go-backs) by road if they haven't started
    } else {
      // No route yet → build one from all the go-backs, nearest-first from the rep.
      const stops = today.map(mkStop);
      setGobackCard(false);
      const from = myLoc || { lat: stops[0].latitude, lng: stops[0].longitude };
      const d2 = (s) => (from.lat - s.latitude) ** 2 + (from.lng - s.longitude) ** 2;
      const ordered = [...stops].sort((a, b) => d2(a) - d2(b));
      setStartPt(from); setRoute(ordered); setStopIdx(0); setRound(1);
      setResolvedIds(new Set()); workingRef.current = new Set(); setDayMode("active");
      optimizeByRoad(from, ordered);
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
    if (!myLoc || !auth.rt || spotCheck) return;
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
  // When the rep CLOSES the map (tab/app close, navigate away), fire a one-shot
  // beacon marking their last ping "ended" — so the live team views drop them right
  // away instead of showing them live for the 15-min idle grace. Only on a real
  // teardown (pagehide with persisted=false); a bfcache background (they may come
  // straight back) is left alone, and reopening just resumes normal pinging.
  useEffect(() => {
    if (!auth.rt || spotCheck) return;
    const bye = (e) => {
      if (e && e.persisted) return;
      const p = lastPosRef.current; if (!p) return;
      try {
        const blob = new Blob([JSON.stringify({ rt: auth.rt, lat: p.lat, lng: p.lng, ended: true })], { type: "application/json" });
        navigator.sendBeacon("/.netlify/functions/harvest-ping", blob);
      } catch { /* ignore */ }
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, [auth.rt]);
  // Bill it: once a real rep opens the map, stamp their access for the month.
  useEffect(() => {
    if (accessLogged.current || !me || !auth.rt || spotCheck) return;
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
    if (dayMode !== "active" || route.length < 2) { setRouteGeom(null); return; }
    const stops = route.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number");
    const pts = startPt ? [{ lat: startPt.lat, lng: startPt.lng }, ...stops.map((p) => ({ lat: p.latitude, lng: p.longitude }))]
      : stops.map((p) => ({ lat: p.latitude, lng: p.longitude }));
    if (pts.length < 2) { setRouteGeom(null); return; }
    // Debounce: the route can be set a few times in a row as a day loads (go-backs
    // fold in, appts weave). Wait for it to settle so the fetch isn't fired then
    // discarded (which was leaving the line un-snapped/straight).
    const debounce = setTimeout(() => {
    const gen = ++routeGeomGen.current;
    // OSRM caps ~100 waypoints per request, and a full day can be 100+ doors — so we
    // snap the line to the roads in CHUNKS of ~90 (sharing the seam point so the
    // segments join) and stitch them. A chunk that fails just uses its straight
    // waypoints, so a long route still follows the streets instead of crow-flying.
    const CHUNK = 90;
    const chunks = [];
    for (let i = 0; i < pts.length - 1; i += CHUNK - 1) chunks.push(pts.slice(i, i + CHUNK));
    if (chunks.length > 8) { setRouteGeom(null); return; } // absurdly long → don't hammer the router
    Promise.all(chunks.map(async (c) => {
      const coords = c.map((p) => `${p.lng},${p.lat}`).join(";");
      // Generous per-waypoint snap radius (1km) so a pin that geocoded a little off the
      // road doesn't make OSRM return NoRoute and blank the whole chunk.
      const radiuses = c.map(() => "1000").join(";");
      try {
        const j = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&radiuses=${radiuses}`)).json();
        const g = j.routes?.[0]?.geometry?.coordinates;
        if (g && g.length) return { snapped: true, pts: g.map(([lng, lat]) => [lat, lng]) };
        console.warn("[route-line] OSRM chunk not snapped:", j.code, j.message || "");
      } catch (e) { console.warn("[route-line] OSRM chunk fetch failed:", e && e.message); }
      return { snapped: false, pts: c.map((p) => [p.lat, p.lng]) };
    })).then((chunkRes) => {
      if (routeGeomGen.current !== gen) return; // a newer route replaced this one
      if (!chunkRes.some((r) => r.snapped)) { console.warn("[route-line] no chunk snapped → straight fallback"); setRouteGeom(null); return; }
      const all = [];
      for (const r of chunkRes) for (const p of r.pts) all.push(p);
      setRouteGeom(all.length > 1 ? all : null);
    }).catch((e) => { console.warn("[route-line] snap error:", e && e.message); if (routeGeomGen.current === gen) setRouteGeom(null); });
    }, 350);
    return () => clearTimeout(debounce);
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
    // End-of-day point (home / hotel) the plan routes back to — 🏠 marker.
    if (planHome && typeof planHome.lat === "number") {
      const homeIcon = L.divIcon({
        className: "harvest-route-home",
        html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-4px)"><div style="background:#0f172a;color:#fff;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4);margin-bottom:2px">end by 8pm</div><div style="width:24px;height:24px;border-radius:50%;background:#0f172a;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:13px">🏠</div></div>`,
        // Float it up so the last door number (drawn AT the point) peeks out below it.
        iconSize: [1, 1], iconAnchor: [0, 40],
      });
      L.marker([planHome.lat, planHome.lng], { icon: homeIcon, zIndexOffset: 1050 }).addTo(lyr);
    }
    // Number the DOORS 1,2,3… continuously — appointments get their own 📅+time badge
    // and DON'T consume a door number (so the door sequence never skips at an appt).
    let doorNum = 0;
    route.forEach((p, i) => {
      if (typeof p.latitude !== "number") return;
      const current = i === stopIdx, done = i < stopIdx;
      if (p.isAppt) {
        const apptIcon = L.divIcon({
          className: "harvest-route-appt",
          html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px)"><div style="background:${done ? "#c4b5fd" : "#7c3aed"};color:#fff;font-size:10px;font-weight:800;padding:1px 7px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4);margin-bottom:2px">📅 ${apptTimeLabel(p._appt?.at_ms)}</div><div style="width:28px;height:28px;border-radius:50% 50% 50% 2px;transform:rotate(45deg);background:${done ? "#c4b5fd" : "#7c3aed"};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)"><div style="transform:rotate(-45deg);color:#fff;font-size:13px;text-align:center;line-height:25px">📅</div></div></div>`,
          // Float it up so the door that ends at the appt (drawn AT the point) peeks out below.
          iconSize: [1, 1], iconAnchor: [0, 42],
        });
        L.marker([p.latitude, p.longitude], { icon: apptIcon, zIndexOffset: 1500 }).addTo(lyr);
        return;
      }
      doorNum += 1;
      const bg = current ? "#16a34a" : done ? "#cbd5e1" : "#fff";
      const fg = current ? "#fff" : done ? "#64748b" : "#16a34a";
      const icon = L.divIcon({
        className: "harvest-route-stop",
        html: `<div style="width:24px;height:24px;border-radius:50%;background:${bg};color:${fg};border:2px solid #16a34a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;box-shadow:0 1px 3px rgba(0,0,0,.4)">${doorNum}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
      });
      L.marker([p.latitude, p.longitude], { icon, zIndexOffset: 1000 }).on("click", () => openPin(p)).addTo(lyr);
    });
  }, [dayMode, route, stopIdx, startPt, routeGeom, planHome]);

  // Draw the dropped TEST appts (test harness) with their time, until a plan is built.
  useEffect(() => {
    const lyr = testApptLayer.current; if (!lyr) return;
    lyr.clearLayers();
    if (dayMode === "active") return; // once planned, the route markers take over
    testAppts.forEach((a, i) => {
      const icon = L.divIcon({
        className: "test-appt",
        html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px)"><div style="background:#7c3aed;color:#fff;font-size:10px;font-weight:800;padding:1px 6px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4);margin-bottom:2px">🧪 #${i + 1} · ${apptTimeLabel(a.at_ms)}</div><div style="width:26px;height:26px;border-radius:50% 50% 50% 2px;transform:rotate(45deg);background:#7c3aed;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)"><div style="transform:rotate(-45deg);color:#fff;font-size:12px;text-align:center;line-height:24px">📅</div></div></div>`,
        iconSize: [1, 1], iconAnchor: [0, 12],
      });
      L.marker([a.lat, a.lng], { icon, zIndexOffset: 1600 }).addTo(lyr);
    });
  }, [testAppts, dayMode]);

  function buildRoute(start, pins, cap, skipRadius) {
    const routable = pins.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number" && !nonRoutableStatuses.has(p.status) && !futureCallback(p)
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
    // DISABLED (Neal, Jul 2026): the driving-time re-order reshuffled whole streets
    // out of geographic order, which read as backtracking. The instant street-by-street
    // serpentine (buildRoute → orderStops) is what the reps want — tight, one street at
    // a time, minimal backtracking — so we keep that and don't override it. Kept as a
    // no-op so every call site still works; re-enable the body if we ever need road
    // ordering for a single-entrance subdivision.
    return;
    /* eslint-disable no-unreachable */
    if (!start || !baseStops || baseStops.length < 3) return;
    const gen = ++routeGen.current;
    setOptimizing(true);
    const better = await roadOrder(start, baseStops);
    if (routeGen.current === gen) setOptimizing(false);
    if (!better || routeGen.current !== gen || stopIdxRef.current !== 0) return;
    setRoute(better);
    if (map.current && better[0]) map.current.setView([better[0].latitude, better[0].longitude], Math.max(map.current.getZoom(), 15));
    /* eslint-enable no-unreachable */
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
    cancelSelecting();
    // Load the doors INSIDE the drawn box straight from Supabase (by the box bounds),
    // so "Route an area" works at ANY zoom — even zoomed way out where the map is
    // showing clusters, not individual pins. No more "zoom in first" just to box a
    // spread-out area on a phone. Falls back to whatever's already on screen.
    const loaded = await load(b);
    const source = (loaded && loaded.length) ? loaded : (shownRef.current || []);
    const inBox = source.filter((p) =>
      typeof p.latitude === "number" && typeof p.longitude === "number" && b.contains([p.latitude, p.longitude])
      && inFilter(p.status) && (!visKeys || visKeys.has(p.status)) && !nonRoutableStatuses.has(p.status) && !workedTodayET(p));
    if (!inBox.length) { alert("No doors in that box — draw around some pins."); return; }
    const start = myLoc || { lat: b.getCenter().lat, lng: b.getCenter().lng };
    // Route the box's doors (nearest-first within it), ceilinged so a giant zoomed-out
    // box can't build a thousand-stop day.
    const r = buildRoute(start, inBox, Math.min(inBox.length, 300), true);
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
    // Enhanced Planned Day: this rep has a manager-assigned section → route exactly
    // those doors (their whole section), efficient order from the start point.
    if (assignedIds && assignedIds.size) {
      const assigned = await sbFetchAll(() =>
        supabase.from("canvass_prospects").select(PIN_FIELDS_LITE).in("id", [...assignedIds]), 5000).catch(() => []);
      const pool = assigned.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number" && !nonRoutableStatuses.has(p.status) && !workedTodayET(p));
      const r = buildRoute(pt, pool, pool.length, true); // whole section, no radius cull
      if (!r.length) { alert("Your assigned doors are all worked or couldn't be routed — check with your manager."); setDayMode(null); return; }
      workingRef.current = new Set(r.map((p) => p.id));
      setStartPt(pt); setRoute(r); setStopIdx(0); setRound(1); setResolvedIds(new Set()); setDayMode("active"); setFillOffer(null);
      optimizeByRoad(pt, r);
      if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 15);
      return;
    }
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

  // ── Test harness: drop fake appts on the map (?test=sr|jr) ─────────────────
  function dropTestAppt(pt) {
    setAddingTestAppt(false);
    const t = window.prompt("Test appointment time today (e.g. 2:00 PM or 14:00):", "2:00 PM");
    if (t == null) return;
    const at_ms = parseTimeToday(t);
    if (!at_ms) { alert("Couldn't read that time — try like “2:00 PM” or “14:00”."); return; }
    setTestAppts((list) => [...list, { jn_job_id: `test_${Date.now()}_${list.length}`, name: `Test appt ${list.length + 1}`, address: "Test appointment", lat: pt.lat, lng: pt.lng, at_ms }]);
  }
  testApptRef.current = dropTestAppt;

  // ── Plan the day around today's appointments ───────────────────────────────
  // Open the little "start / end time" sheet, defaulting start to NOW and end to 8 PM.
  function openApptPlan() {
    if (!auth.rt && !testMode) return;
    const d = new Date();
    setPlanStartHM(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    setShowApptPlan(true);
  }
  // Pull the rep's appts (time + location), then weave door-knocking into the gaps
  // (buildApptPlan) between their chosen start and end times. Appts are anchor stops.
  async function planAroundAppts() {
    if ((!auth.rt && !testMode) || planningAppts) return;
    const startMs = hmToMsToday(planStartHM) || Date.now();
    // End of day is fixed at 8 PM (not a rep input). Leaving earlier = a personal-note
    // thing, handled separately — the plan always fills toward 8 PM.
    let endMs = hmToMsToday("20:00");
    if (endMs <= startMs) endMs = startMs + 3600000; // guard (started after 8 PM)
    setPlanningAppts(true);
    try {
      // Test harness uses the fake appts dropped on the map; otherwise pull today's from JN.
      let raw = testAppts;
      if (!raw.length) raw = ((await (await fetch(`/.netlify/functions/harvest-today-appts?rt=${encodeURIComponent(auth.rt || "")}`)).json().catch(() => ({}))).appts) || [];
      const appts = raw
        .filter((a) => typeof a.lat === "number" && typeof a.lng === "number" && a.at_ms >= startMs - 30 * 60000)
        .sort((a, b) => a.at_ms - b.at_ms);
      if (!appts.length) { setPlanningAppts(false); alert(testMode ? "No test appts ahead of your start time — drop some with “Add test appt” (and set times after your start)." : "No upcoming appointments for today (that we can place on the map). Book appts first, then plan around them."); return; }
      const start = myLoc || { lat: appts[0].lat, lng: appts[0].lng };
      // Load a generous box around the rep + every appt so the plan has pins to fill with.
      const lats = [start.lat, ...appts.map((a) => a.lat)], lngs = [start.lng, ...appts.map((a) => a.lng)];
      const R = 0.15;
      const wide = { getNorth: () => Math.max(...lats) + R, getSouth: () => Math.min(...lats) - R, getEast: () => Math.max(...lngs) + R, getWest: () => Math.min(...lngs) - R };
      const loaded = await load(wide);
      const pool = (loaded.length ? loaded : (shownRef.current || [])).filter((p) => inFilter(p.status) && typeof p.latitude === "number"
        && (!visKeys || visKeys.has(p.status)) && !nonRoutableStatuses.has(p.status) && !workedTodayET(p)
        && (!assignedIds || assignedIds.has(p.id))); // Enhanced Planned Day: stay within the assigned section
      // End the day back where they started (home, or a hotel like William's).
      const home = { lat: start.lat, lng: start.lng };
      apptPoolRef.current = pool; apptListRef.current = appts; apptEndRef.current = endMs; apptHomeRef.current = home;
      const route = buildApptPlan(start, startMs, endMs, appts, pool, home);
      workingRef.current = new Set(route.filter((s) => !s.isAppt).map((s) => s.id));
      setStartPt(start); setRoute(route); setStopIdx(0); setRound(1); setResolvedIds(new Set()); setDayMode("active"); setFillOffer(null); setShowApptPlan(false); setPlanHome(home);
      if (map.current && route[0]) map.current.setView([route[0].latitude, route[0].longitude], 15);
    } catch { alert("Couldn't load your appointments — try again."); }
    setPlanningAppts(false);
  }
  // "Appt done" — the rep is leaving an appointment. Keep everything up to & including
  // it, then RE-PLAN the rest from HERE and NOW: the gap to the next appt is recomputed
  // off the real clock, so ending early adds doors and running long trims them.
  function completeAppt(stop) {
    const i = route.findIndex((s) => s.id === stop.id);
    const prefix = i >= 0 ? route.slice(0, i + 1) : route.slice();
    const from = { lat: stop.latitude, lng: stop.longitude };
    const restAppts = (apptListRef.current || []).filter((a) => a.at_ms > (stop._appt?.at_ms || 0));
    const prefixIds = new Set(prefix.map((s) => s.id));
    const pool = (apptPoolRef.current || []).filter((p) => !prefixIds.has(p.id) && !resolvedIds.has(p.id));
    const endMs = apptEndRef.current || (Date.now() + 3600000);
    const tail = buildApptPlan(from, Date.now(), endMs, restAppts, pool, apptHomeRef.current);
    const next = [...prefix, ...tail];
    workingRef.current = new Set(next.filter((s) => !s.isAppt).map((s) => s.id));
    logActivity({ pin_id: null, kind: "appt_done", to_status: "appt" });
    setRoute(next); setStopIdx(prefix.length);
    if (map.current && next[prefix.length]) map.current.setView([next[prefix.length].latitude, next[prefix.length].longitude], 16);
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
    // Just re-optimize the doors still left, STREET BY STREET, from the day's start.
    // (Neal: stop trying to end round 1 near pin 1 / make a loop — go street by street.)
    // orderStops now uncrosses the line, so round 2 is a clean serpentine of whatever's
    // left, same as round 1.
    const from = startPt || myLoc || { lat: left[0].latitude, lng: left[0].longitude };
    const ordered = buildRoute(from, left, routeCap(left), true);
    if (!ordered.length) return;
    setStartPt(from); setRoute(ordered); setStopIdx(0); setRound((n) => n + 1); setDayMode("active"); setFillOffer(null);
    if (map.current) map.current.setView([ordered[0].latitude, ordered[0].longitude], 15);
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

  // ── Map rotation — DISPLAY ONLY (CSS transform on the map element) ─────────
  // Rotates just the VIEW. It never touches Leaflet's projection or getBounds, so
  // pin-loading is unaffected (that's what broke with the old plugin). Two-finger twist
  // for manual turn, plus an optional compass "heading-up" that faces the way you walk.
  // While rotated, tapping a pin can be slightly off — it's a "look around / follow me"
  // mode; tap the compass to snap back to North (then taps are exact again).
  function applyMapTransform(deg) {
    bearingRef.current = deg;
    const el = mapEl.current; if (!el) return;
    if (!deg) { el.style.transform = ""; el.style.transformOrigin = ""; return; }
    const rad = (deg * Math.PI) / 180;
    const cover = Math.abs(Math.sin(rad)) + Math.abs(Math.cos(rad)); // scale just enough to fill the corners (1 at 0°, ~1.41 at 45°)
    el.style.transformOrigin = "center center";
    el.style.transform = `rotate(${deg}deg) scale(${cover})`;
  }
  const twoFingerAngle = (a, b) => (Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180) / Math.PI;
  function mapTouchStart(e) {
    // Two fingers → begin a twist. (If heading-up is on, the compass just re-applies on
    // the next tick, so a stray twist is harmless — no stale-state check needed.)
    if (e.touches && e.touches.length === 2) twistRef.current = { startAngle: twoFingerAngle(e.touches[0], e.touches[1]), startBearing: bearingRef.current };
    else twistRef.current = null;
  }
  function mapTouchMove(e) {
    const t = twistRef.current; if (!t || !e.touches || e.touches.length !== 2) return;
    const delta = twoFingerAngle(e.touches[0], e.touches[1]) - t.startAngle;
    applyMapTransform(((((t.startBearing + delta) % 360) + 360) % 360));
  }
  function mapTouchEnd(e) {
    if (twistRef.current && (!e.touches || e.touches.length < 2)) { twistRef.current = null; setMapBearing(Math.round(bearingRef.current)); }
  }
  function resetNorth() { if (headingUp) { disableHeadingUp(); return; } applyMapTransform(0); setMapBearing(0); }

  // Compass "heading-up" — reads the phone compass and turns the map so the way you're
  // facing is UP, like a car GPS.
  function smoothHeading(raw) {
    const prev = headingRef.current;
    const diff = ((raw - prev + 540) % 360) - 180; // shortest signed turn, handles the 360→0 wrap
    const next = (prev + diff * 0.25 + 360) % 360;  // low-pass so it doesn't jitter
    headingRef.current = next;
    return next;
  }
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;   // iOS: true compass, 0=N clockwise
    else if (typeof e.alpha === "number") h = (360 - e.alpha) % 360;              // Android
    if (h == null || isNaN(h)) return;
    const sm = smoothHeading(h);
    applyMapTransform((360 - sm) % 360); setMapBearing(Math.round((360 - sm) % 360)); // heading to the top
  }
  async function enableHeadingUp() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const res = await DeviceOrientationEvent.requestPermission(); // iOS 13+ needs this on a tap
        if (res !== "granted") { alert("To use heading-up, allow Motion & Orientation access when your phone asks."); return; }
      }
    } catch { /* older browsers don't need permission */ }
    const handler = (ev) => onOrient(ev);
    orientHandlerRef.current = handler;
    window.addEventListener("deviceorientationabsolute", handler, true);
    window.addEventListener("deviceorientation", handler, true);
    setHeadingUp(true);
    if (myLoc && map.current) map.current.panTo([myLoc.lat, myLoc.lng]);
  }
  function disableHeadingUp() {
    const h = orientHandlerRef.current;
    if (h) { window.removeEventListener("deviceorientationabsolute", h, true); window.removeEventListener("deviceorientation", h, true); orientHandlerRef.current = null; }
    headingRef.current = 0; applyMapTransform(0); setMapBearing(0); setHeadingUp(false);
  }
  function toggleHeadingUp() { headingUp ? disableHeadingUp() : enableHeadingUp(); }
  // Stop listening if the component unmounts while heading-up is on.
  useEffect(() => () => { const h = orientHandlerRef.current; if (h) { window.removeEventListener("deviceorientationabsolute", h, true); window.removeEventListener("deviceorientation", h, true); } }, []);
  // While heading-up, keep the rep centered (follow-me), so the map turns around them.
  useEffect(() => { if (headingUp && myLoc && map.current) { try { map.current.panTo([myLoc.lat, myLoc.lng], { animate: true, duration: 0.4 }); } catch { /* ignore */ } } }, [myLoc, headingUp]);

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
    // Real leads: "Appt" opens the booking flow (creates the JobNimbus appt). Test
    // pins / practice mode just set the status (no real homeowner/job to book).
    if (outcome === "appt" && stop.status !== "test" && !demoMode) { setApptPin(await hydratePin(stop)); return; }
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
    if (demoMode) { alert("🧪 Practice mode — signing opens the real intake, so it's turned off here. Everything else you can try freely."); return; }
    if (spotCheck) { alert("🔍 Spot-check — viewing this rep's map only; signing is off."); return; }
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
  function startAddHouse() { setSelected(null); setSelectedInstall(null); setNewPin(null); setOwnerOverride(false); setOverridePhone(""); setAdding(true); }
  function cancelAdd() { setAdding(false); setNewPin(null); setOwnerOverride(false); setOverridePhone(""); }
  // The rep tapped a roof — place the pin and open its sheet (owner check runs
  // when they press "Owner occupied?").
  function dropPin({ lat, lng }) {
    setAdding(false);
    setOwnerOverride(false); setOverridePhone("");
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
          // Non-owner-occupied (rental) → mark it with an X so no rep re-knocks it, and
          // keep the owner's mailing address for possible internal marketing.
          status: action === "non_owner" ? "non_owner" : undefined,
          mailing: c.mailing || null,
          // Override: rep captured the owner's phone and is working this house as a
          // live deal even though the cadastral said non-owner-occupied.
          phone: ownerOverride ? overridePhone.trim() : undefined,
          override: ownerOverride || undefined,
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
      // Owner-occupied but the homeowner isn't interested — log it terminal so
      // no rep re-knocks this door.
      else if (action === "not_interested") await setStatus(pin, "insp_ni");
    } catch {
      alert("Couldn't save the pin — try again.");
      setNewPin((n) => (n ? { ...n, saving: false } : n));
    }
  }

  // "Owner owns another property" — create a live Self-Generated pin at a typed
  // address (geocoded by the autocomplete), then route into Sign / Retail / Pending.
  // Repeatable: the address clears but the owner/phone stay so a rep can add house
  // after house the same owner owns.
  async function addOwnerProperty(action) {
    if (!addProp || !addPropPlace || addPropSaving) return;
    if (spotCheck) { alert("🔍 Spot-check — statusing is off."); return; }
    const pl = addPropPlace;
    if (typeof pl.lat !== "number" || typeof pl.lng !== "number") { alert("Pick the address from the dropdown so we can place it on the map."); return; }
    setAddPropSaving(true);
    try {
      const r = await fetch("/.netlify/functions/harvest-add-pin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rt: auth.rt, lat: pl.lat, lng: pl.lng,
          address: pl.address || "", city: pl.city || "", state: pl.state || "FL", zip: pl.zip || "",
          owner: addProp.owner || "", phone: (addProp.phone || "").trim() || undefined,
          override: true, verdict: "owner_owns_multiple",
        }),
      });
      const d = await r.json();
      if (d.duplicate) { alert(`There's already a pin at ${pl.address || "that address"}.`); setAddPropSaving(false); return; }
      if (!d.ok || !d.pin) { alert(d.error || "Couldn't add the property."); setAddPropSaving(false); return; }
      const pin = d.pin;
      setProspects((list) => [...list, pin]);
      setAddPropCount((n) => n + 1);
      setAddPropPlace(null);   // clear the address; keep owner/phone for the next one
      setAddPropSaving(false);
      if (action === "sign") signInspection(pin, { selfGen: true });
      else if (action === "retail") setBtrPin(pin);
      else if (action === "pending") await setStatus(pin, "insp_callback");
    } catch { alert("Couldn't add the property — try again."); setAddPropSaving(false); }
  }

  function startOver() { routeGen.current++; setOptimizing(false); navLayer.current?.clearLayers(); setDayMode(null); setStartPt(null); setRoute([]); setStopIdx(0); setRound(1); setResolvedIds(new Set()); workingRef.current = new Set(); setPanelPos(null); setSigningStop(null); setFillOffer(null); setEditingRoute(false); setPlanHome(null); }
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
  // ── Drag-to-reorder the day's stops (Google-Maps-style waypoint reorder) ──────
  // The rep planned the efficient route; this lets them hand-order it by importance.
  // Pointer events so it works with a thumb on a phone AND a mouse in the office.
  function reorderRoute(fromIdx, toIdx) {
    if (fromIdx == null || toIdx == null || fromIdx === toIdx) return;
    const curId = route[stopIdx]?.id;
    const next = route.slice();
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx > fromIdx ? toIdx - 1 : toIdx, 0, moved);
    setRoute(next);
    const ni = next.findIndex((p) => p.id === curId);      // keep "you're here" on the same door
    if (ni >= 0) setStopIdx(ni);
    routeGen.current++;                                     // a hand-order shouldn't get auto-reshuffled
  }
  function rowDragStart(e, i) {
    dragFromRef.current = i; dragOverRef.current = i; setDragOverIdx(i);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    window.addEventListener("pointermove", rowDragMove);
    window.addEventListener("pointerup", rowDragEnd, { once: true });
    e.preventDefault();
  }
  function rowDragMove(e) {
    if (dragFromRef.current == null) return;
    const rows = document.querySelectorAll("[data-routerow]");
    let over = rows.length; // past the last row = drop at end
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { over = i; break; }
    }
    dragOverRef.current = over; setDragOverIdx(over);
  }
  function rowDragEnd() {
    window.removeEventListener("pointermove", rowDragMove);
    const from = dragFromRef.current, to = dragOverRef.current;
    dragFromRef.current = null; dragOverRef.current = null; setDragOverIdx(null);
    reorderRoute(from, to);
  }
  // Snap the hand-ordered route back to the efficient nearest-street order.
  function reoptimizeRoute() {
    if (route.length < 2) return;
    const from = startPt || (route[stopIdx] ? { lat: route[stopIdx].latitude, lng: route[stopIdx].longitude } : null);
    if (!from) return;
    const ordered = orderStops(from, route.filter((p) => typeof p.latitude === "number"));
    setRoute(ordered); setStopIdx(0);
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
  // Admin-tunable go-back route radius (miles) + Smart Scheduling on/off. Pin Types admin page.
  useEffect(() => {
    supabase.from("app_settings").select("value").eq("key", "harvest_goback_radius_mi").maybeSingle()
      .then(({ data }) => { const n = Number(data?.value); if (Number.isFinite(n) && n > 0) setGobackRadiusMi(n); })
      .catch(() => { /* keep default 5 */ });
    supabase.from("app_settings").select("value").eq("key", "harvest_smart_scheduling_enabled").maybeSingle()
      .then(({ data }) => { if (data) setSmartSchedEnabled(String(data.value) !== "false"); })
      .catch(() => { /* keep default on */ });
    // Admin-tunable daily pin caps (Sr = IQ/no-sit days, Jr = inspection days).
    supabase.from("app_settings").select("key,value").in("key", ["harvest_route_cap_sr", "harvest_route_cap_jr"])
      .then(({ data }) => {
        let changed = false;
        for (const row of data || []) {
          const n = Number(row.value);
          if (Number.isFinite(n) && n > 0) { if (row.key === "harvest_route_cap_sr") ROUTE_CAP_DEFAULT = n; else ROUTE_CAP_INSP = n; changed = true; }
        }
        if (changed) setCapsV((v) => v + 1); // re-render so "next N" labels reflect
      })
      .catch(() => { /* keep defaults 30 / 100 */ });
  }, []);
  // Enhanced Planned Day — if this rep has a published assignment today, Start-my-day
  // routes exactly those doors (and Route-an-area hides). Endpoint returns empty when
  // Enhanced mode is off / no plan, so this quietly no-ops otherwise.
  useEffect(() => {
    if (!auth.rt) return;
    fetch(`/.netlify/functions/harvest-my-plan?rt=${encodeURIComponent(auth.rt)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && Array.isArray(j.pin_ids) && j.pin_ids.length) setAssignedIds(new Set(j.pin_ids));
      })
      .catch(() => { /* fall back to normal */ });
  }, [auth.rt]);
  // Today's appointments — fetched for EVERY rep (not just manager-assigned ones), so a
  // rep who has an appt sees a prompt the moment the map opens instead of having to know
  // to tap "Plan your day". Drives both the auto-detect banner and the Start-my-day gate.
  useEffect(() => {
    if (!auth.rt) return;
    fetch(`/.netlify/functions/harvest-today-appts?rt=${encodeURIComponent(auth.rt)}`)
      .then((r) => r.json())
      .then((a) => { const list = (a && Array.isArray(a.appts)) ? a.appts : []; setTodayAppts(list); setHasApptsToday(list.length > 0); })
      .catch(() => { /* assume none */ });
  }, [auth.rt]);
  // Test link ?test=sr|jr → preview at that rep level.
  useEffect(() => { if (testLevel) setViewAs(testLevel); }, [testLevel]);
  useEffect(() => { addingTestApptRef.current = addingTestAppt; }, [addingTestAppt]);
  const counts = dbCounts || loadedCounts;
  const notMapped = prospects.length - mapped.length;

  // Rep hasn't passed the tool training yet → send them through it first. (Skips
  // itself if no training content is authored, so it never locks reps out.)
  if (auth.rt && !authError && repTrainingOk === false && !isAdminLink) { // admin link bypasses the gate for spot-checks
    return <HarvestTraining track="rep" userType="rep" userKey={auth.rt} name={me?.name} toolLabel="your Harvesting Map" onPass={() => setRepTrainingOk(true)} />;
  }

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
      {demoMode && (
        <div style={{ background: "#7c3aed", color: "#fff", textAlign: "center", padding: "6px 12px", fontSize: 12.5, fontWeight: 800, letterSpacing: "0.02em" }}>
          🧪 PRACTICE MODE — try anything, nothing you do here is saved. Real pins, no real changes.
        </div>
      )}
      {spotCheck && (
        <div style={{ background: "#0f172a", color: "#fff", textAlign: "center", padding: "6px 12px", fontSize: 12.5, fontWeight: 800, letterSpacing: "0.02em" }}>
          🔍 SPOT-CHECK — you're seeing {me?.name || "this rep"}'s map exactly as they do. Viewing only — nothing you tap changes their doors or logs as them.
        </div>
      )}
      {/* Header */}
      <div style={{ padding: "10px 14px", background: "#0f172a", color: "#fff", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 16, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }}>🌾 Harvesting Map</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{mapped.length} pins</div>
        {me?.level === "admin" && !demoMode && (
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
          {!selLocked && <Chip active={!showNone && sel.size === 0} onClick={() => { setShowNone(false); setSel(new Set()); }} color="#334155" label={`All (${dbCounts ? Object.entries(dbCounts).reduce((sum, [k, n]) => sum + ((!visKeys || visKeys.has(k)) ? n : 0), 0) : (visKeys ? prospects.filter((p) => visKeys.has(p.status)).length : prospects.length)})`} />}
          {visTypes.map((s) => (
            <Chip key={s.key} active={sel.has(s.key)} check onClick={() => isPinned(s.key) ? null : toggleSel(s.key)} color={s.color} label={`${isPinned(s.key) ? "🔒 " : ""}${s.label} (${counts[s.key] || 0})`} />
          ))}
          {installs.length > 0 && (
            <Chip active={showInstalls} onClick={() => setShowInstalls((v) => !v)} color={INSTALL_COLOR} label={`⭐ Installs (${installs.length})`} />
          )}
          {workedPins.length > 0 && workedVisible && (
            <Chip active={showWorked} onClick={() => setShowWorked((v) => !v)} color={workedColor} label={`🔵 ${workedType?.label || "Worked today"} (${workedPins.length})`} />
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
                🔒 <b>IQ + No-sit</b> stay on always. Tap any other type to add it to your map too.
              </div>
            )}
            {!selLocked && (
              <StatusCard color="#334155" label="All pins"
                count={dbCounts ? Object.entries(dbCounts).reduce((sum, [k, n]) => sum + ((!visKeys || visKeys.has(k)) ? n : 0), 0) : (visKeys ? prospects.filter((p) => visKeys.has(p.status)).length : prospects.length)}
                active={!showNone && sel.size === 0} onClick={() => { setShowNone(false); setSel(new Set()); }} />
            )}
            {visTypes.map((s) => (
              <StatusCard key={s.key} color={s.color} label={`${isPinned(s.key) ? "🔒 " : ""}${s.label}`} count={counts[s.key] || 0}
                active={sel.has(s.key)} locked={isPinned(s.key)} onClick={() => isPinned(s.key) ? null : toggleSel(s.key)} />
            ))}
            {installs.length > 0 && (
              <StatusCard color={INSTALL_COLOR} label="⭐ Installs" count={installs.length}
                active={showInstalls} onClick={() => setShowInstalls((v) => !v)} />
            )}
            {workedPins.length > 0 && workedVisible && (
              <StatusCard color={workedColor} label={`🔵 ${workedType?.label || "Worked today"}`} count={workedPins.length}
                active={showWorked} onClick={() => setShowWorked((v) => !v)} />
            )}
            {me?.level === "admin" && !demoMode && (
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

        {/* ── Start my day ── Hidden by default (reps prefer Route-an-area / Plan-your-day,
            and it had bugs). Kept in code, shown ONLY for an Enhanced Planned Day (to run
            the manager's pre-planned section) AND only when the rep has no appointment
            today — with an appt they Plan-your-day instead. */}
        {dayMode === null && !selecting && assignedIds && assignedIds.size > 0 && !hasApptsToday && (prospects.length > 0 || clusters.length > 0) && (
          <button type="button" onClick={() => (prospects.length ? setDayMode("choosing") : nudgeZoom())}
            style={{ position: "absolute", left: 12, bottom: 16, zIndex: 600, background: "#16a34a", color: "#fff", border: "none", borderRadius: 999, padding: "13px 20px", fontSize: 15, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer", opacity: prospects.length ? 1 : 0.85 }}>
            ▶ Start my day
          </button>
        )}
        {/* Enhanced Planned Day — this rep's manager assigned them a section today. */}
        {dayMode === null && !selecting && assignedIds && assignedIds.size > 0 && (
          <div style={{ position: "absolute", left: 12, right: 12, top: 56, zIndex: 590, background: "#7c3aed", color: "#fff", padding: "9px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700, boxShadow: "0 2px 8px rgba(0,0,0,.25)", textAlign: "center" }}>
            📋 Your day is planned by your manager — {assignedIds.size} doors. {hasApptsToday ? <>You have an appointment today — tap <b>📅 Plan your day</b> to weave your doors around it.</> : <>Tap <b>▶ Start my day</b>.</>}
          </div>
        )}
        {/* Auto-detect "you have an appointment" — shows the moment the map opens for a
            rep who has a JN appt today but ISN'T on a manager-assigned day (those reps
            get the purple banner above). No need to know to tap the button first. */}
        {dayMode === null && !selecting && !(assignedIds && assignedIds.size > 0) && todayAppts.length > 0 && !apptBannerDismissed && ((auth.rt && smartSchedEnabled) || testMode) && (
          <div style={{ position: "absolute", left: 12, right: 12, top: 56, zIndex: 595, background: "#7c3aed", color: "#fff", padding: "11px 14px", borderRadius: 12, boxShadow: "0 3px 12px rgba(0,0,0,.28)", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700, lineHeight: 1.3 }}>
              📅 You have {todayAppts.length} appointment{todayAppts.length > 1 ? "s" : ""} today — first at{" "}
              <b>{new Date(todayAppts[0].at_ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })}</b>. Plan your doors around it?
            </div>
            <button type="button" onClick={openApptPlan}
              style={{ background: "#fff", color: "#6d28d9", border: "none", borderRadius: 999, padding: "9px 15px", fontSize: 13, fontWeight: 800, fontFamily: "'Oswald', sans-serif", cursor: "pointer", whiteSpace: "nowrap" }}>
              Plan my day →
            </button>
            <button type="button" onClick={() => setApptBannerDismissed(true)} aria-label="Dismiss"
              style={{ background: "transparent", color: "#fff", border: "none", fontSize: 18, fontWeight: 800, cursor: "pointer", lineHeight: 1, padding: "0 2px" }}>
              ✕
            </button>
          </div>
        )}
        {/* Route an area — drag a box, route exactly the doors inside it. Hidden when
            the rep's day is manager-assigned (they work their section, not a free area). */}
        {dayMode === null && !selecting && !(assignedIds && assignedIds.size > 0) && (prospects.length > 0 || clusters.length > 0) && (
          <button type="button" onClick={startSelecting}
            style={{ position: "absolute", left: 12, bottom: 68, zIndex: 600, background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 999, padding: "10px 16px", fontSize: 13, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer" }}>
            ▢ Route an area
          </button>
        )}
        {/* Smart Scheduling — plan the day around appts. Real reps see it only when the
            company toggle is ON; a ?test= link always shows it (so it can be tried while off). */}
        {dayMode === null && !selecting && ((auth.rt && smartSchedEnabled) || testMode) && (
          <button type="button" onClick={openApptPlan}
            style={{ position: "absolute", left: 12, bottom: 112, zIndex: 600, background: "#7c3aed", color: "#fff", border: "none", borderRadius: 999, padding: "10px 16px", fontSize: 13, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer" }}>
            📅 Have an appt? Plan your day!
          </button>
        )}
        {/* Test harness: drop fake appts to see Smart Scheduling work; clear to reset. */}
        {dayMode === null && !selecting && testMode && (
          <div style={{ position: "absolute", left: 12, bottom: 156, zIndex: 600, display: "flex", gap: 6, alignItems: "center" }}>
            <button type="button" onClick={() => setAddingTestAppt(true)}
              style={{ background: "#f59e0b", color: "#111827", border: "none", borderRadius: 999, padding: "9px 15px", fontSize: 12.5, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer" }}>
              🧪 Add test appt{testAppts.length ? ` (${testAppts.length})` : ""}
            </button>
            {testAppts.length > 0 && (
              <button type="button" onClick={() => { setTestAppts([]); setAddingTestAppt(false); }}
                style={{ background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 999, padding: "9px 12px", fontSize: 12, fontWeight: 800, boxShadow: "0 3px 12px rgba(0,0,0,.2)", cursor: "pointer" }}>
                ✕ Clear
              </button>
            )}
          </div>
        )}
        {addingTestAppt && (
          <div style={{ position: "absolute", left: "50%", bottom: 200, transform: "translateX(-50%)", zIndex: 800, background: "#7c3aed", color: "#fff", borderRadius: 10, padding: "9px 15px", fontSize: 13, fontWeight: 700, boxShadow: "0 3px 14px rgba(0,0,0,.35)", whiteSpace: "nowrap" }}>
            📅 Tap the map to drop a test appt
          </div>
        )}
        {showApptPlan && (
          <div style={{ position: "absolute", right: 10, bottom: 14, zIndex: 700, background: "#fff", borderRadius: 14, padding: "16px 18px", boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: "min(340px, 90%)" }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", color: "#0f172a", marginBottom: 4 }}>📅 Plan your day</div>
            <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 12 }}>Your appts go in in order; we fill the gaps with doors that fit before each one, then keep you knocking until <b>8:00 PM</b>.</div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 12 }}>What time are you starting?
              <input type="time" value={planStartHM} onChange={(e) => setPlanStartHM(e.target.value)} style={{ marginTop: 4, width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 9, fontSize: 15, fontFamily: FONT }} />
            </label>
            <button type="button" onClick={planAroundAppts} disabled={planningAppts}
              style={{ width: "100%", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 15, fontWeight: 800, cursor: planningAppts ? "default" : "pointer", opacity: planningAppts ? 0.7 : 1, marginBottom: 8 }}>
              {planningAppts ? "Building your plan…" : "Build my plan"}
            </button>
            <button type="button" onClick={() => setShowApptPlan(false)}
              style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          </div>
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
        {/* Compass — twist two fingers on the map to rotate it; this button shows which
            way is North (needle) and taps back to North-up. Tap it (from North-up) to
            turn on heading-up (map faces the way you're walking). Display-only rotation. */}
        {(auth.rt || auth.admin) && !selecting && !adding && !newPin && (
          <button type="button"
            onClick={() => { (headingUp || mapBearing) ? resetNorth() : toggleHeadingUp(); }}
            title={headingUp ? "Heading-up ON — tap for North-up" : mapBearing ? "Rotated — tap to reset North (or twist two fingers)" : "Twist two fingers to rotate · tap for heading-up"}
            style={{ position: "absolute", right: isDesktop ? 312 : 12, top: (myLoc && !selecting) ? (auth.rt ? 116 : 64) : (auth.rt ? 64 : 12), zIndex: 600, background: headingUp ? "#16a34a" : "#fff", color: headingUp ? "#fff" : "#334155", border: "2px solid #fff", borderRadius: 999, width: 44, height: 44, boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
            <span style={{ display: "inline-block", transform: `rotate(${-mapBearing}deg)`, transition: "transform .12s", fontSize: 15, fontWeight: 900 }}>
              <span style={{ color: "#dc2626" }}>▲</span><span style={{ display: "block", fontSize: 9, marginTop: -3, color: headingUp ? "#fff" : "#334155" }}>N</span>
            </span>
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

        {/* ── Route history (admin) ── replay any past day's rep trails ──
            Hidden in practice mode: it reads real reps' location history, which
            isn't a "practice" tool — the sandbox stays map-only. */}
        {me?.level === "admin" && !demoMode && (
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
            <div style={{ position: "absolute", top: 12, left: isDesktop ? "calc((100% - 300px) / 2)" : "50%", transform: "translateX(-50%)", zIndex: 650, width: gobackCard ? "min(370px, 92%)" : "auto", maxWidth: "min(370px, 92%)" }}>
              <button type="button" onClick={() => setGobackCard((o) => !o)}
                style={{ width: "100%", background: hot ? "#7f1d1d" : "#0f172a", color: "#fff", border: "none", borderRadius: gobackCard ? "12px 12px 0 0" : 999, padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer", boxShadow: "0 3px 14px rgba(0,0,0,.3)", whiteSpace: "nowrap" }}>
                <span style={{ fontSize: 13, fontWeight: 800 }}>{hot ? "⚠️" : "🗓️"} {needs.length} go-back{needs.length > 1 ? "s" : ""}</span>
                <span style={{ fontSize: 11, opacity: 0.85 }}>{gobackCard ? "▲ hide" : "▼ show"}</span>
              </button>
              {gobackCard && (
                <div style={{ background: "#fff", borderRadius: "0 0 12px 12px", boxShadow: "0 3px 14px rgba(0,0,0,.3)", overflow: "hidden" }}>
                  {/* Action pinned at the TOP so it's always visible — a long go-back
                      list used to push it off-screen where reps never scrolled to it. */}
                  <div style={{ padding: "10px 12px", borderBottom: "1px solid #eef2f7" }}>
                    <button type="button" onClick={addGobacksToRoute}
                      style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "11px", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>
                      {dayMode === "active" && route.length ? "➕ Add the go-backs within my route" : "➕ Route these go-backs"}
                    </button>
                    {dayMode === "active" && route.length ? (
                      <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", marginTop: 6 }}>Only go-backs inside today's route area get added — the rest stay here.</div>
                    ) : null}
                  </div>
                  <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
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
          // Door numbering (appointments excluded) to match the map's markers.
          const doorTotal = route.filter((s) => !s.isAppt).length;
          const doorNo = route.slice(0, stopIdx + 1).filter((s) => !s.isAppt).length;
          const posStyle = panelPos
            ? { left: panelPos.left, top: panelPos.top }
            : { right: 10, bottom: 14 };
          const left = done ? remainingCount() : 0;
          const leftPins = done ? dayPoolPins().filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id)) : [];
          // Compact-pill summary (shown when the card is minimized so the rep can see the map).
          const sumLabel = done ? (left > 0 ? `Round ${round} · ${left} left` : "Route complete")
            : stop.isAppt ? "📅 Appointment"
            : `${round > 1 ? `Round ${round} · ` : ""}${doorTotal ? `Door ${doorNo} of ${doorTotal}` : `Stop ${stopIdx + 1} of ${route.length}`}`;
          const sumName = done ? "" : (stop.name || stop.address || "");
          return (
            <div data-daypanel style={{ position: "absolute", ...posStyle, zIndex: 600, background: "#fff", borderRadius: 14, boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: panelMin ? "min(250px, 74%)" : "min(340px, 88%)", overflow: "hidden" }}>
              {/* Header: drag handle (move it) + minimize toggle (collapse to a pill so
                  the rep can see the map, then expand to status the next door). */}
              <div style={{ display: "flex", alignItems: "center", padding: "3px 6px 2px" }}>
                <div onPointerDown={panelPointerDown} onPointerMove={panelPointerMove} onPointerUp={panelPointerUp}
                  style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: "grab", touchAction: "none", color: "#cbd5e1", fontSize: 13, letterSpacing: 2, userSelect: "none", padding: "3px 0" }}>
                  ⠿ <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.03em" }}>drag</span>
                </div>
                <button type="button" onClick={() => setPanelMin((v) => !v)} aria-label={panelMin ? "Expand" : "Minimize"}
                  style={{ background: "#f1f5f9", border: "none", borderRadius: 8, cursor: "pointer", color: "#475569", fontSize: 15, fontWeight: 900, lineHeight: 1, padding: "4px 9px" }}>
                  {panelMin ? "▢" : "—"}
                </button>
              </div>
              {/* Minimized: a compact pill — current door + one tap to expand & status. */}
              {panelMin && (
                <button type="button" onClick={() => setPanelMin(false)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "0 14px 12px" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.04em" }}>{sumLabel}</div>
                  {sumName && <div style={{ fontSize: 14.5, fontWeight: 800, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sumName}</div>}
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: "#1d4ed8", marginTop: 4 }}>▲ Tap to status / next door</div>
                </button>
              )}
              {!panelMin && (
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
              ) : stop.isAppt ? (
                // An APPOINTMENT anchor — not a door to status. Directions + "Appt done".
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#7c3aed" }}>📅 Appointment</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: "#94a3b8" }}>Next door: {Math.min(doorNo + 1, doorTotal)} of {doorTotal}</span>
                  </div>
                  <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 12, padding: "12px 14px" }}>
                    <div style={{ fontSize: 17, fontWeight: 800, color: "#6d28d9" }}>{apptTimeLabel(stop._appt?.at_ms)}</div>
                    {stop.name && <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", marginTop: 2 }}>{stop.name}</div>}
                    <div style={{ fontSize: 13, color: "#334155" }}>{stop.address}</div>
                  </div>
                  <a href={`https://www.google.com/maps/dir/?api=1&destination=${addrOf(stop)}`} target="_blank" rel="noreferrer"
                    style={{ display: "block", textAlign: "center", width: "100%", boxSizing: "border-box", marginTop: 12, background: "#1d4ed8", color: "#fff", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, textDecoration: "none" }}>
                    🧭 Directions to the appointment
                  </a>
                  <button type="button" onClick={() => completeAppt(stop)}
                    style={{ width: "100%", marginTop: 10, background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 14.5, fontWeight: 800, cursor: "pointer" }}>
                    ✅ Appointment done — plan the rest of my day
                  </button>
                  <div style={{ fontSize: 11.5, color: "#94a3b8", textAlign: "center", marginTop: 7 }}>Tap when you leave — we re-fill your doors based on the time before your next appt.</div>
                  <button type="button"
                    onClick={() => { if (window.confirm("Cancel this plan and start over?")) startOver(); }}
                    style={{ width: "100%", marginTop: 10, background: "#fff", color: "#dc2626", border: "1px solid #dc2626", borderRadius: 10, padding: "9px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                    ✕ Cancel plan &amp; start over
                  </button>
                </>
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
                const near = ignoreDist || demoMode || gpsNear || manualHere === stop.id;
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
                    <span style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#16a34a" }}>{round > 1 ? `Round ${round} · ` : ""}{doorTotal ? `Door ${doorNo} of ${doorTotal}` : `Stop ${stopIdx + 1} of ${route.length}`}{optimizing ? <span style={{ color: "#94a3b8", fontWeight: 700 }}> · 🛣️ optimizing…</span> : null}</span>
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
                  {stop.extra?.callback?.date && (
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: "#854d0e", marginTop: 4 }}>📅 Come back {cbLabel(stop.extra.callback.date)}{stop.extra.callback.note ? ` — ${stop.extra.callback.note}` : ""}</div>
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
                      : o.key === "insp_callback"
                      ? (
                        <button key={o.key} type="button" disabled={!near} onClick={() => { setCallbackFor(stop.id); setCbDate(ymdPlus(7)); setCbNote(stop.notes || ""); }}
                          style={{ flex: "1 1 44%", minWidth: 92, padding: "11px 8px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed",
                            border: `1px solid ${near ? o.color : "#e5e7eb"}`, background: near ? o.color : "#fff", color: near ? "#fff" : "#cbd5e1" }}>
                          {o.label}
                        </button>
                      )
                      : oBtn(o.key, o.label, o.color))}
                    {oBtn("nothome", "🏠 Not home", "#475569")}
                  </div>
                  {/* Come-back scheduler — pick a return day + note. */}
                  {callbackFor === stop.id && (
                    <div style={{ marginTop: 10, background: "#fefce8", border: "1px solid #fde047", borderRadius: 12, padding: "12px 14px" }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#854d0e", marginBottom: 8 }}>📅 Come back — when?</div>
                      <input type="date" value={cbDate} min={ymdPlus(0)} onChange={(e) => setCbDate(e.target.value)}
                        style={{ width: "100%", boxSizing: "border-box", height: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 16, background: "#fff", marginBottom: 8 }} />
                      <textarea value={cbNote} onChange={(e) => setCbNote(e.target.value)} rows={2} placeholder="Note — e.g. medical emergency, still wants the roof"
                        style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 14, fontFamily: "inherit", resize: "vertical", marginBottom: 8 }} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" disabled={cbSaving || !cbDate} onClick={() => saveCallback(stop)}
                          style={{ flex: 1, background: "#ca8a04", color: "#fff", border: "none", borderRadius: 10, padding: "11px", fontSize: 13.5, fontWeight: 800, cursor: cbSaving ? "wait" : "pointer", opacity: cbDate ? 1 : 0.6 }}>
                          {cbSaving ? "Saving…" : "📅 Schedule come-back"}
                        </button>
                        <button type="button" onClick={() => setCallbackFor(null)}
                          style={{ background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 10, padding: "11px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {/* Homeowner declined the inspection but wants a retail appt —
                      book it right from the route stop (same as the pin sheet). */}
                  {stop.status === "insp" && (
                    <button type="button" disabled={!near} onClick={() => near && (demoMode ? alert("🧪 Practice mode — booking is off here.") : setBtrPin(stop))}
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
              )}
            </div>
          );
        })()}
      </div>

      {/* Route editor — trim stops that are too far to be worth the drive */}
      {editingRoute && dayMode === "active" && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "14px 16px 20px", zIndex: 1100, maxHeight: "72vh", overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif" }}>Edit today's route</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={reoptimizeRoute} disabled={route.length < 2} title="Snap back to the most efficient order"
                style={{ background: "#fff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 9, padding: "7px 12px", fontSize: 12.5, fontWeight: 800, cursor: route.length < 2 ? "not-allowed" : "pointer" }}>🛣️ Re-optimize</button>
              <button type="button" onClick={() => setEditingRoute(false)} style={{ background: "#0f172a", color: "#fff", border: "none", borderRadius: 9, padding: "7px 15px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>Done</button>
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>Drag <b>☰</b> to reorder by importance, or Remove a stop you're skipping. The route line + numbers update as you go. {route.length} stop{route.length === 1 ? "" : "s"}.</div>
          <div style={{ display: "grid", gap: 6 }} data-routelist>
            {route.map((p, i) => {
              const mi = startPt ? feetBetween(startPt, { lat: p.latitude, lng: p.longitude }) / 5280 : null;
              const far = mi != null && mi >= 8;
              const dragging = dragOverIdx != null && dragFromRef.current === i;
              return (
                <div key={p.id} data-routerow style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, border: "1px solid #eef2f7", background: dragging ? "#eff6ff" : i === stopIdx ? "#f0fdf4" : "#fff", borderTop: dragOverIdx === i ? "3px solid #1d4ed8" : "1px solid #eef2f7", opacity: dragging ? 0.6 : 1 }}>
                  <span onPointerDown={(e) => rowDragStart(e, i)} title="Drag to reorder"
                    style={{ cursor: "grab", color: "#94a3b8", fontSize: 18, padding: "0 2px", flexShrink: 0, touchAction: "none", userSelect: "none" }}>☰</span>
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
            {/* drop-at-end indicator */}
            {dragOverIdx === route.length && <div style={{ height: 3, background: "#1d4ed8", borderRadius: 2 }} />}
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
                    <button type="button" disabled={newPin.saving} onClick={() => commitSelfGen("not_interested")}
                      style={{ padding: "13px", borderRadius: 12, border: "2px solid #78716c", background: "#fff", color: "#57534e", fontSize: 14.5, fontWeight: 800, cursor: "pointer", opacity: newPin.saving ? 0.6 : 1 }}>🚫 Not Interested</button>
                  </div>
                ) : ownerOverride ? (() => {
                  const phoneOk = overridePhone.replace(/\D/g, "").length >= 10;
                  const dis = newPin.saving || !phoneOk;
                  return (
                    <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 12.5, color: "#166534", fontWeight: 700 }}>✅ Override — the owner (across the street) wants a quote on this house. Enter their phone, then it becomes a live self-generated lead.</div>
                      <input type="tel" inputMode="tel" value={overridePhone} onChange={(e) => setOverridePhone(e.target.value)} placeholder="Owner's phone number"
                        style={{ width: "100%", boxSizing: "border-box", height: 46, padding: "0 12px", borderRadius: 12, border: "1px solid #d1d5db", fontSize: 16, background: "#fff" }} />
                      <button type="button" disabled={dis} onClick={() => commitSelfGen("sign")}
                        style={{ padding: "13px", borderRadius: 12, border: "none", background: "#7c3aed", color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: dis ? "not-allowed" : "pointer", opacity: dis ? 0.5 : 1 }}>🖊️ Sign Inspection</button>
                      <button type="button" disabled={dis} onClick={() => commitSelfGen("retail")}
                        style={{ padding: "13px", borderRadius: 12, border: "2px solid #b45309", background: "#fff7ed", color: "#b45309", fontSize: 14.5, fontWeight: 800, cursor: dis ? "not-allowed" : "pointer", opacity: dis ? 0.5 : 1 }}>🏠 Retail Appointment</button>
                      <button type="button" disabled={dis} onClick={() => commitSelfGen("pending")}
                        style={{ padding: "13px", borderRadius: 12, border: "2px solid #ca8a04", background: "#fefce8", color: "#a16207", fontSize: 14.5, fontWeight: 800, cursor: dis ? "not-allowed" : "pointer", opacity: dis ? 0.5 : 1 }}>⏳ Pending (come back)</button>
                      {!phoneOk && <div style={{ fontSize: 11.5, color: "#94a3b8", textAlign: "center" }}>Enter a valid phone number to continue.</div>}
                      <button type="button" onClick={() => { setOwnerOverride(false); setOverridePhone(""); }}
                        style={{ padding: "9px", borderRadius: 10, border: "none", background: "none", color: "#64748b", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>← Back</button>
                    </div>
                  );
                })() : (
                  <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                    <button type="button" disabled={newPin.saving} onClick={() => commitSelfGen("non_owner")}
                      style={{ padding: "13px", borderRadius: 12, border: "none", background: "#991b1b", color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer", opacity: newPin.saving ? 0.6 : 1 }}>✕ Mark non owner-occupied</button>
                    <div style={{ fontSize: 11.5, color: "#64748b", textAlign: "center" }}>Drops an <b>X</b> here so no one re-knocks it, and saves the owner's info.</div>
                    <button type="button" disabled={newPin.saving} onClick={() => { setOwnerOverride(true); setOverridePhone(""); }}
                      style={{ padding: "12px", borderRadius: 11, border: "2px solid #16a34a", background: "#f0fdf4", color: "#166534", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>✅ Override — owner's here &amp; wants a quote</button>
                    <button type="button" disabled={newPin.saving} onClick={() => commitSelfGen("pending")}
                      style={{ padding: "11px", borderRadius: 10, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", fontSize: 13.5, fontWeight: 700, cursor: "pointer", opacity: newPin.saving ? 0.6 : 1 }}>Save as pending anyway</button>
                  </div>
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
              {piiVisible(selected) ? (
                <>
                  {selected.name && <div style={{ fontWeight: 800, fontSize: 16 }}>{selected.name}</div>}
                  <div style={{ fontSize: 14, color: "#334155", fontWeight: 600 }}>{selected.address}</div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>{[selected.city, selected.state, selected.zip].filter(Boolean).join(", ")}</div>
                </>
              ) : (
                <div style={{ fontWeight: 800, fontSize: 14, color: "#94a3b8" }}>🔒 Homeowner &amp; address show once this door is on your route</div>
              )}
              {selected.status === "no_sit_reschedule" && origApptLabel(selected) && (
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#c2410c", marginTop: 4 }}>🔄 No-sit · original appt was {origApptLabel(selected)}</div>
              )}
              <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: (S[selected.status] || UNKNOWN_TYPE).color, display: "inline-block" }} />
                {(S[selected.status] || UNKNOWN_TYPE).label}
                {selected.status_by ? <span style={{ color: "#94a3b8", fontWeight: 600 }}> · by {selected.status_by}</span> : null}
              </div>
              {selected.extra?.callback?.date && (
                <div style={{ marginTop: 6, background: "#fefce8", border: "1px solid #fde047", borderRadius: 10, padding: "7px 10px" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: "#854d0e" }}>📅 Come back {cbLabel(selected.extra.callback.date)}</div>
                  {selected.extra.callback.note && <div style={{ fontSize: 12.5, color: "#713f12", marginTop: 2 }}>{selected.extra.callback.note}</div>}
                </div>
              )}
            </div>
            <button type="button" onClick={() => setSelected(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          {/* Info a REP actually needs at the door. The `extra` blob keeps every
              uploaded/synced field for the office, but reps don't need back-office
              metadata (Date Contact, List, RepCard user, Synced at, Updated, IDs,
              Country Code, Verified Pin, …). Show a short ALLOWLIST from extra and
              hide the rest — nothing is deleted, just not displayed. */}
          {piiVisible(selected) && (() => {
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
          ) : auth.rt && !dayMode ? (
            // NOT on a route: statusing stays gated to route work, so every knock is
            // logged in order, at the door. Start a route to work / re-status doors.
            <div style={{ marginTop: 14, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "14px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: "#1e3a8a" }}>Work this door on a route</div>
              <div style={{ fontSize: 12.5, color: "#334155", marginTop: 4, lineHeight: 1.5 }}>To status it (signed, not interested, appt, …), tap <b>▶ Start my day</b> or <b>▢ Route an area</b>. It comes up in order with the <b>“How’d it go?”</b> buttons when you're at the door.</div>
            </div>
          ) : auth.rt ? (() => {
            // ON a route: let the rep RE-STATUS any door from its pin sheet — e.g.
            // they marked "not home" and then the homeowner came out. Same at-the-door
            // gate (proximity + "I'm here" override) so it stays honest; no re-route.
            const distFt = myLoc ? feetBetween(myLoc, { lat: selected.latitude, lng: selected.longitude }) : null;
            const accFt = myLoc?.acc != null ? Math.min(myLoc.acc * 3.28084, 400) : 0;
            const effFt = distFt != null ? Math.max(0, distFt - accFt) : null;
            const near = ignoreDist || demoMode || (effFt != null && effFt <= ARRIVE_FT) || manualHere === selected.id;
            const outs = ((S[selected.status]?.outcomes) || []).map((k) => S[k]).filter(Boolean);
            const opts = outs.length ? outs : ["insp_sold", "insp_ni", "insp_callback", "dead"].map((k) => S[k]).filter(Boolean);
            const rBtn = (key, label, color) => (
              <button key={key} type="button" disabled={!near} onClick={() => restatusPin(selected, key)}
                style={{ flex: "1 1 44%", minWidth: 92, padding: "11px 8px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed",
                  border: `1px solid ${near ? color : "#e5e7eb"}`, background: near ? color : "#fff", color: near ? "#fff" : "#cbd5e1" }}>{label}</button>
            );
            return (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Re-status this door</div>
                {!near && (
                  <div style={{ fontSize: 12, color: "#b45309", marginBottom: 8, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 9, padding: "8px 10px" }}>
                    {distFt != null ? `~${Math.round(distFt).toLocaleString()} ft away — get within ${ARRIVE_FT} ft, or ` : "GPS is off — "}
                    <button type="button" onClick={() => setManualHere(selected.id)} style={{ background: "none", border: "none", padding: 0, color: "#1d4ed8", fontWeight: 800, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>I'm at the door</button>
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {opts.map((o) => o.key === "insp_sold"
                    ? <button key={o.key} type="button" disabled={!near} onClick={() => signInspection(selected)} style={{ flex: "1 1 44%", minWidth: 92, padding: "11px 8px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed", border: `1px solid ${near ? "#7c3aed" : "#e5e7eb"}`, background: near ? "#7c3aed" : "#fff", color: near ? "#fff" : "#cbd5e1" }}>🖊️ Sign Inspection</button>
                    : rBtn(o.key, o.label, o.color))}
                  {rBtn("nothome", "🏠 Not home", "#475569")}
                </div>
                {callbackFor === selected.id && (
                  <div style={{ marginTop: 10, background: "#fefce8", border: "1px solid #fde047", borderRadius: 12, padding: "12px 14px" }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#854d0e", marginBottom: 8 }}>📅 Come back — when?</div>
                    <input type="date" value={cbDate} min={ymdPlus(0)} onChange={(e) => setCbDate(e.target.value)}
                      style={{ width: "100%", boxSizing: "border-box", height: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 16, background: "#fff", marginBottom: 8 }} />
                    <textarea value={cbNote} onChange={(e) => setCbNote(e.target.value)} rows={2} placeholder="Note — e.g. medical emergency, still wants the roof"
                      style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 14, fontFamily: "inherit", resize: "vertical", marginBottom: 8 }} />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" disabled={cbSaving || !cbDate} onClick={() => saveCallback(selected)}
                        style={{ flex: 1, background: "#ca8a04", color: "#fff", border: "none", borderRadius: 10, padding: "11px", fontSize: 13.5, fontWeight: 800, cursor: cbSaving ? "wait" : "pointer", opacity: cbDate ? 1 : 0.6 }}>{cbSaving ? "Saving…" : "📅 Schedule come-back"}</button>
                      <button type="button" onClick={() => setCallbackFor(null)} style={{ background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 10, padding: "11px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })() : (() => {
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
                            onClick={() => s.key === "appt" ? (demoMode ? setStatus(selected, "appt") : setApptPin(selected)) : s.key === "insp_sold" ? signInspection(selected) : setStatus(selected, s.key)}
                            style={{ padding: "9px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                              border: on ? `2px solid ${s.color}` : "1px solid #e5e7eb",
                              background: on ? s.color : "#fff", color: on ? "#fff" : "#334155" }}>
                            {s.key === "insp_sold" && !on ? "🖊️ Sign Inspection" : s.label}
                          </button>
                        );
                      })}
                    </div>
                    {selected.status === "insp" && (
                      <button type="button" onClick={() => demoMode ? alert("🧪 Practice mode — booking is off here.") : setBtrPin(selected)}
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

          {/* Owner owns another property — add more addresses the same owner owns
              as live self-generated leads, no pin-drop needed. Unlimited. */}
          {!spotCheck && (
            <div style={{ marginTop: 16, borderTop: "1px solid #f1f5f9", paddingTop: 12 }}>
              {!addProp ? (
                <button type="button" onClick={() => { setAddProp({ owner: selected.name || "", phone: selected.phone || "" }); setAddPropPlace(null); setAddPropText(""); setAddPropCount(0); }}
                  style={{ width: "100%", padding: "12px", borderRadius: 11, border: "2px solid #0e7490", background: "#ecfeff", color: "#0e7490", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>
                  🏠 Owner owns another property
                </button>
              ) : (
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 12 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>Same owner, another house — sign it up. It drops on the map as a self-generated lead.</div>
                  <input value={addProp.owner} onChange={(e) => setAddProp((a) => ({ ...a, owner: e.target.value }))} placeholder="Owner name"
                    style={{ width: "100%", boxSizing: "border-box", height: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, background: "#fff", marginBottom: 8 }} />
                  <input type="tel" inputMode="tel" value={addProp.phone} onChange={(e) => setAddProp((a) => ({ ...a, phone: e.target.value }))} placeholder="Owner phone"
                    style={{ width: "100%", boxSizing: "border-box", height: 44, padding: "0 12px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 15, background: "#fff", marginBottom: 8 }} />
                  <AddressAutocomplete value={addPropText} onChange={(v) => { setAddPropText(v); setAddPropPlace(null); }}
                    onPlaceSelected={(pl) => { setAddPropPlace(pl); setAddPropText(pl.formatted || pl.address || ""); }}
                    placeholder="Property address" style={{ height: 44, borderRadius: 10, fontSize: 15 }} />
                  {(() => {
                    const ready = addPropPlace && typeof addPropPlace.lat === "number" && !addPropSaving;
                    const b = (bg, bd, fg, label, act) => (
                      <button type="button" disabled={!ready} onClick={() => addOwnerProperty(act)}
                        style={{ flex: "1 1 30%", minWidth: 90, padding: "11px 6px", borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: ready ? "pointer" : "not-allowed", border: `1px solid ${bd}`, background: ready ? bg : "#fff", color: ready ? fg : "#cbd5e1" }}>{label}</button>
                    );
                    return (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
                        {b("#7c3aed", "#7c3aed", "#fff", "🖊️ Sign", "sign")}
                        {b("#fff7ed", "#b45309", "#b45309", "🏠 Retail", "retail")}
                        {b("#fefce8", "#ca8a04", "#a16207", "⏳ Pending", "pending")}
                      </div>
                    );
                  })()}
                  {!addPropPlace && addPropText && <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 6 }}>Pick the address from the dropdown so it lands in the right spot.</div>}
                  {addPropCount > 0 && <div style={{ fontSize: 12, color: "#166534", fontWeight: 700, marginTop: 8 }}>✓ {addPropCount} propert{addPropCount === 1 ? "y" : "ies"} added — add another or close.</div>}
                  <button type="button" onClick={() => { setAddProp(null); setAddPropPlace(null); setAddPropText(""); }}
                    style={{ marginTop: 8, width: "100%", padding: "9px", borderRadius: 10, border: "none", background: "none", color: "#64748b", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Done</button>
                </div>
              )}
            </div>
          )}

          {/* Directions reveal the address, so they're gated the same as the address
              itself — only once the door is on the rep's route (office/admin always). */}
          {piiVisible(selected) && (
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
          )}
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
            // Log the booking with its ORIGIN (from_status) so the harvest leaderboard
            // can credit IQ/No-sit→appt work. Always logged (not only on a route stop);
            // the server also logs it and the leaderboard dedupes by pin.
            logActivity({ pin_id: apptPin.id, kind: "visit", from_status: apptPin.status, to_status: "appt", ...locAudit(apptPin) });
            if (dayMode === "active" && route[stopIdx] && route[stopIdx].id === apptPin.id) advanceStop();
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
            // Origin drives the harvest leaderboard. A SELF-GENERATED retail appt is
            // harvest work (the rep found the damaged roof) → tag it "self_gen" so it's
            // counted. A real BTR (retail off an inspection pin) keeps its status (insp)
            // and stays EXCLUDED — that's post-inspection, not lead-gen.
            logActivity({ pin_id: btrPin.id, kind: "visit", from_status: isSelfGenPin(btrPin) ? "self_gen" : btrPin.status, to_status: "appt", ...locAudit(btrPin) });
            if (dayMode === "active" && route[stopIdx] && route[stopIdx].id === btrPin.id) advanceStop();
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
function genSlots(days = 14, includeToday = false) {
  const out = []; const b = new Date(); const nowMs = b.getTime();
  // Default starts at d=1 (tomorrow) — no same-day. includeToday (no-sit reschedules,
  // where the rep is at the door and wants to re-book for later today) starts at d=0
  // but only offers hours still AHEAD of right now.
  for (let d = includeToday ? 0 : 1; d <= days; d++) {
    const day = new Date(b.getFullYear(), b.getMonth(), b.getDate() + d);
    for (const h of (APPT_HOURS[day.getDay()] || [])) {
      const dt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0);
      if (d === 0 && dt.getTime() <= nowMs) continue; // today: skip hours already past
      out.push({ iso: dt.toISOString(), dt });
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

  // Same-day booking is allowed for a NO-SIT reschedule (rep's at the door, wants to
  // re-book today) — Neal. Every other appt type stays tomorrow-onward.
  const allowSameDay = pin.status === "no_sit_reschedule";
  const bookedKeys = useMemo(() => new Set((booked || []).map((ms) => slotKey(new Date(ms)))), [booked]);
  const slots = useMemo(() => genSlots(14, allowSameDay).filter((s) => !bookedKeys.has(slotKey(s.dt))), [bookedKeys, allowSameDay]);
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
      // Booked on the map even if JobNimbus refused this one job — tell the rep so
      // someone resets it in JN manually (the map + JN are briefly out of sync).
      if (j.warning) { try { window.alert("⚠️ " + j.warning); } catch { /* ignore */ } }
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
