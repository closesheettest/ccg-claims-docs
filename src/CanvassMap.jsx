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
  { key: "insp", label: "Inspection Lead", color: "#0ea5e9", outcomes: ["insp_sold", "insp_ni", "dead", "new_roof"] },
  { key: "insp_ni", label: "Not Interested", color: "#78716c", outcomes: [], is_terminal: true },
  { key: "insp_pending", label: "Pending signature", color: "#ea580c", outcomes: ["insp_sold", "dead"] },
  { key: "insp_sold", label: "Inspection Sold", color: "#7c3aed", outcomes: [], is_terminal: true },
  { key: "new_roof", label: "New Roof", color: "#0891b2", outcomes: [], is_terminal: true },
  { key: "dead", label: "Dead / DNK", color: "#111827", outcomes: [], is_terminal: true },
];
const UNKNOWN_TYPE = { color: "#64748b", label: "—", outcomes: [] };

// Fields the map needs per pin (status_log is left out — heavy + unused here).
// LITE = everything needed to PLACE a pin + drive the route/actions (identity,
// contact, geo, status). Deliberately drops the heavy fields — chiefly `extra`
// (the whole CSV row as JSON, ~340KB of a 790KB viewport) plus notes/metadata —
// so a 6000-pin viewport ships ~260KB instead of ~790KB (≈3× faster to load).
const PIN_FIELDS_LITE = "id,name,address,city,state,zip,phone,email,latitude,longitude,status,jn_job_id";
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
const ARRIVE_FT = 200; // must be within this many feet of the stop to advance
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

export default function CanvassMap() {
  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const clusterLayer = useRef(null); // server-side cluster bubbles (low zoom)
  const routeLayer = useRef(null);
  const navLayer = useRef(null);   // in-app driving route to the current stop
  const fitted = useRef(false);
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
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
  const [installs, setInstalls] = useState([]);        // read-only star layer (jr + sr)
  const [showInstalls, setShowInstalls] = useState(true);
  const [selectedInstall, setSelectedInstall] = useState(null);
  // "Start my day" route planner.
  const [dayMode, setDayMode] = useState(null);        // null | 'choosing' | 'active'
  const [startPt, setStartPt] = useState(null);        // {lat,lng} the route starts from
  const [route, setRoute] = useState([]);              // ordered stops (nearest-first)
  const [stopIdx, setStopIdx] = useState(0);
  const [myLoc, setMyLoc] = useState(null);            // live GPS while a route is active
  const [round, setRound] = useState(1);               // 1st round, 2nd round, …
  const [resolvedIds, setResolvedIds] = useState(() => new Set()); // pins the rep has STATUSED this session (drop from later rounds)
  const workingRef = useRef(new Set());                // the ORIGINAL round-1 routed pin ids — later rounds only recycle these, minus statused
  const arrivedRef = useRef(null);                     // { key } — already logged arrival at this stop
  const [panelPos, setPanelPos] = useState(null);      // {left,top} px if dragged, else default bottom-right
  const [ignoreDist, setIgnoreDist] = useState(false); // admin test toggle: skip the 200 ft gate
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

  // "View as" — the office can preview exactly what a junior/senior rep sees.
  // effLevel is the level we're rendering as (own level, or the previewed one).
  // visKeys = the pin-type keys that level may see (null = no restriction).
  const [viewAs, setViewAs] = useState(null);          // null → office's own full view
  const effLevel = viewAs || me?.level || null;
  const seesAll = !effLevel || effLevel === "admin";
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
      // selection (office "All") = everything the level can see.
      const effStatuses = sel.size ? [...sel].filter((k) => baseKeys.includes(k)) : baseKeys;
      if (!effStatuses.length) { setProspects([]); setInstalls([]); setClusters([]); setCapped(false); setNeedRegion(false); setLoading(false); return []; }

      // Region gate: a huge bucket (Inspection Leads, 200k+) must be narrowed to
      // a Florida region first — otherwise we'd pull the whole state. Small
      // buckets (IQ, no-sit, FB) skip the gate and load statewide.
      const showAll = showAllRef.current;
      const rgn = regionRef.current;
      const bigBucket = dbCounts
        ? effStatuses.reduce((s, k) => s + (dbCounts[k] || 0), 0) > REGION_THRESHOLD
        : effStatuses.includes("insp");
      // Only gate when the view is broad (low zoom). Zoomed into a neighborhood
      // the viewport already scopes it, so a big bucket is fine to load there.
      const zNow = map.current ? map.current.getZoom() : 7;
      if (!showAll && bigBucket && !rgn && zNow < CLUSTER_ZOOM) {
        setProspects([]); setInstalls([]); setClusters([]); setCapped(false); setNeedRegion(true);
        if (!bounds && !fitted.current) fitted.current = true;
        setLoading(false); return [];
      }
      setNeedRegion(false);

      // 2) Pins + installs, straight from Supabase (range-paginated → no payload cap).
      const CAP = showAll ? 40000 : bounds ? 6000 : 3000;
      const rb = rgn ? (REGIONS.find((r) => r.key === rgn)?.bounds) : null; // [[s,w],[n,e]]
      const box = (q) => {
        let qq = q;
        if (rb) qq = qq.gte("latitude", rb[0][0]).lte("latitude", rb[1][0]).gte("longitude", rb[0][1]).lte("longitude", rb[1][1]);
        if (!showAll && bounds) qq = qq.gte("latitude", bounds.getSouth()).lte("latitude", bounds.getNorth()).gte("longitude", bounds.getWest()).lte("longitude", bounds.getEast());
        return qq;
      };
      // NO order-by: sorting the in-view rows (created_at OR id) makes Postgres
      // sort a large result set and TIMES OUT once the table is big (200k+ pins).
      // Un-ordered returns in-bounds rows fast; the map doesn't need them sorted.
      const pins = await sbFetchAll(() => box(
        supabase.from("canvass_prospects").select(PIN_FIELDS_LITE).not("latitude", "is", null).in("status", effStatuses),
      ), CAP);
      const installs = await sbFetchAll(() => box(
        supabase.from("installs").select("id,jnid,address_line,city,product_type,color,latitude,longitude").not("latitude", "is", null),
      ).order("id"), CAP);

      setProspects(pins);
      setInstalls(installs);
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
    if (effLevel === "senior") setSel(new Set(["iq"]));
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
      if (choosingRef.current && startFromRef.current) startFromRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
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
    const shown = mapped.filter((p) => inFilter(p.status) && (!visKeys || visKeys.has(p.status)));
    shownRef.current = shown; // for "Start my day" routing (already level-filtered)
    setShownCount(shown.length); // drives the "0 match your filter" hint
    const markers = [];
    const pts = [];
    for (const p of shown) {
      const color = (S[p.status] || UNKNOWN_TYPE).color;
      const marker = L.marker([p.latitude, p.longitude], { icon: dotIcon(color) });
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

  async function setStatus(p, newStatus) {
    const nowIso = new Date().toISOString();
    const entry = { at: nowIso, from: p.status, to: newStatus, by: repName || "rep" };
    const log = Array.isArray(p.status_log) ? [...p.status_log, entry] : [entry];
    const patch = { status: newStatus, status_updated_at: nowIso, status_by: repName || null, status_log: log };
    const { error } = await supabase.from("canvass_prospects").update(patch).eq("id", p.id);
    if (error) { alert(error.message); return false; }
    logActivity({ pin_id: p.id, kind: "status", from_status: p.status, to_status: newStatus });
    setResolvedIds((s) => new Set(s).add(p.id)); // statused → drops out of later rounds
    setProspects((list) => list.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
    setSelected((s) => (s && s.id === p.id ? { ...s, ...patch } : s));
    return true;
  }

  // Log a rep action (visit / status change) for reporting. Non-blocking.
  function logActivity(row) {
    try {
      supabase.from("canvass_activity")
        .insert({ rep_name: repName || null, rep_token: auth.rt || null, round, ...row })
        .then(() => {}, () => {});
    } catch { /* ignore */ }
  }

  // ── Start my day ───────────────────────────────────────────────────────
  // Order the on-screen prospect pins nearest-first from a start point (the
  // rep's location or a tapped spot), then walk them one stop at a time.
  useEffect(() => { choosingRef.current = dayMode === "choosing"; activeDayRef.current = dayMode !== null; }, [dayMode]);
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

  // While a route is active, watch the rep's live location so "Next" only
  // unlocks once they're within ARRIVE_FT of the current stop.
  useEffect(() => {
    if (dayMode !== "active" || !navigator.geolocation) { setMyLoc(null); return; }
    const id = navigator.geolocation.watchPosition(
      (pos) => setMyLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      () => setMyLoc(null),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 },
    );
    watchRef.current = id;
    return () => { try { navigator.geolocation.clearWatch(id); } catch { /* ignore */ } };
  }, [dayMode]);

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
      logActivity({ pin_id: stop.id, kind: "arrival" });
    }
  }, [myLoc, stopIdx, dayMode, route, round]);

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
    // Line runs FROM the chosen start point, through every stop in order.
    const linePts = startPt ? [[startPt.lat, startPt.lng], ...stopPts] : stopPts;
    if (linePts.length > 1) L.polyline(linePts, { color: "#16a34a", weight: 4, opacity: 0.7, dashArray: "6 7" }).addTo(lyr);
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
  }, [dayMode, route, stopIdx, startPt]);

  function buildRoute(start, pins, cap) {
    const routable = pins.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number" && !nonRoutableStatuses.has(p.status)
      && feetBetween(start, { lat: p.latitude, lng: p.longitude }) / 5280 <= MAX_ROUTE_MI); // within 25 mi of the start
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
    const out = [];
    let cur = start;
    // Greedy nearest-neighbour over the chosen (priority-selected) stops.
    while (rem.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rem.length; i++) {
        const d = dist2(cur, rem[i]);
        if (d < bd) { bd = d; bi = i; }
      }
      const nx = rem.splice(bi, 1)[0];
      out.push(nx);
      cur = { lat: nx.latitude, lng: nx.longitude };
    }
    return out;
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
  // Next round: re-route the ORIGINAL routed pins that haven't been statused yet,
  // from where the rep is now. 30 → (minus statused) 25 → … until all are statused.
  function nextRound() {
    const left = (shownRef.current || []).filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id) && typeof p.latitude === "number");
    if (!left.length) return; // all statused — the done panel shows "all worked"
    const from = myLoc || (route.length ? { lat: route[route.length - 1].latitude, lng: route[route.length - 1].longitude } : startPt);
    const r = buildRoute(from, left, routeCap(left));
    setStartPt(from); setRoute(r); setStopIdx(0); setRound((n) => n + 1); setDayMode("active"); setFillOffer(null);
    if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 15);
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
  // Open a pin's detail sheet: show it instantly with the LITE data, then fill in
  // notes/extra/etc. once hydrated.
  function openPin(p) {
    setSelectedInstall(null);
    setSelected(p);
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
    logActivity({ pin_id: stop.id, kind: "visit", to_status: outcome === "nothome" ? "not_home" : outcome });
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
  function signInspection(stop) {
    if (!stop) return;
    const p = new URLSearchParams({ intake: "1", harvest_pin: String(stop.id) });
    if (stop.name) p.set("name", stop.name);
    if (stop.phone) p.set("phone", stop.phone);
    if (stop.address) p.set("address", stop.address);
    if (stop.city) p.set("city", stop.city);
    if (stop.state) p.set("state", stop.state);
    if (stop.zip) p.set("zip", stop.zip);
    if (stop.email) p.set("email", stop.email);
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
  function startOver() { navLayer.current?.clearLayers(); setDayMode(null); setStartPt(null); setRoute([]); setStopIdx(0); setRound(1); setResolvedIds(new Set()); workingRef.current = new Set(); setPanelPos(null); setSigningStop(null); setFillOffer(null); setEditingRoute(false); }
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

      {/* Status filter chips */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "8px 12px", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
        {region && (
          <button type="button" onClick={clearRegion} title="Change area"
            style={{ whiteSpace: "nowrap", padding: "6px 12px", borderRadius: 20, fontSize: 12.5, fontWeight: 800, cursor: "pointer", border: "1px solid #0e7490", background: "#0e7490", color: "#fff" }}>
            {REGIONS.find((r) => r.key === region)?.label || "Area"} ✕
          </button>
        )}
        <Chip active={sel.size === 0} onClick={() => setSel(new Set())} color="#334155" label={`All (${dbCounts ? Object.entries(dbCounts).reduce((sum, [k, n]) => sum + ((!visKeys || visKeys.has(k)) ? n : 0), 0) : (visKeys ? prospects.filter((p) => visKeys.has(p.status)).length : prospects.length)})`} />
        {visTypes.map((s) => (
          <Chip key={s.key} active={sel.has(s.key)} check onClick={() => toggleSel(s.key)} color={s.color} label={`${s.label} (${counts[s.key] || 0})`} />
        ))}
        {installs.length > 0 && (
          <Chip active={showInstalls} onClick={() => setShowInstalls((v) => !v)} color={INSTALL_COLOR} label={`⭐ Installs (${installs.length})`} />
        )}
      </div>

      {/* Map */}
      <div style={{ position: "relative", flex: 1 }}>
        <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />
        {loading && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "6px 14px", borderRadius: 20, fontSize: 13, boxShadow: "0 2px 8px rgba(0,0,0,.15)", zIndex: 500 }}>Loading pins…</div>
        )}
        {!loading && !needRegion && prospects.length === 0 && clusters.length === 0 && (
          <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "14px 18px", borderRadius: 12, fontSize: 13.5, color: "#475569", boxShadow: "0 2px 10px rgba(0,0,0,.12)", zIndex: 500, textAlign: "center", maxWidth: 320 }}>
            No pins in your area yet. The office loads leads from the admin section.
          </div>
        )}
        {/* Big bucket (Inspection Leads) + no region yet → pick an area so we don't
            load the whole state. Small buckets (IQ) never hit this. */}
        {needRegion && !loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 700, background: "rgba(255,255,255,.65)" }}>
            <div style={{ background: "#fff", borderRadius: 16, padding: "20px 22px", maxWidth: 360, textAlign: "center", boxShadow: "0 8px 30px rgba(0,0,0,.2)", border: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>📍 Pick your area</div>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>Too many doors to load the whole state at once — choose the region you're working:</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {REGIONS.map((r) => (
                  <button key={r.key} type="button" onClick={() => pickRegion(r.key)} style={{ padding: "14px 10px", borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: "pointer", border: "2px solid #0e7490", background: "#ecfeff", color: "#0e7490" }}>{r.label}</button>
                ))}
              </div>
            </div>
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

        {/* ── Start my day ── */}
        {dayMode === null && prospects.length > 0 && (
          <button type="button" onClick={() => setDayMode("choosing")}
            style={{ position: "absolute", left: 12, bottom: 16, zIndex: 600, background: "#16a34a", color: "#fff", border: "none", borderRadius: 999, padding: "13px 20px", fontSize: 15, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer" }}>
            ▶ Start my day
          </button>
        )}

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
          const leftPins = done ? (shownRef.current || []).filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id)) : [];
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
                const near = ignoreDist || (distFt != null && distFt <= ARRIVE_FT);
                // Genuinely at the stop (real proximity, not the admin test toggle):
                // once here, directions are turned off until they STATUS this stop —
                // statusing advances to the next stop, which re-enables directions.
                const arrived = distFt != null && distFt <= ARRIVE_FT;
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
                    <span style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#16a34a" }}>{round > 1 ? `Round ${round} · ` : ""}Stop {stopIdx + 1} of {route.length}</span>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button type="button" onClick={() => setEditingRoute(true)} style={{ background: "none", border: "none", fontSize: 12.5, fontWeight: 700, color: "#1d4ed8", cursor: "pointer" }}>✏️ Edit route</button>
                      <button type="button" onClick={startOver} style={{ background: "none", border: "none", fontSize: 12.5, fontWeight: 700, color: "#94a3b8", cursor: "pointer" }}>↺ Start over</button>
                    </div>
                  </div>
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
                  <button type="button" onClick={() => !arrived && navRoute(stop)} disabled={arrived}
                    style={{ width: "100%", marginTop: 12, background: arrived ? "#e5e7eb" : "#1d4ed8", color: arrived ? "#94a3b8" : "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: arrived ? "not-allowed" : "pointer" }}>
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
                  <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, textAlign: "center", color: near ? "#16a34a" : "#b45309" }}>
                    {ignoreDist
                      ? "🧪 Distance gate OFF (test) — pick what happened"
                      : distFt == null
                        ? "📍 Finding your location… (allow location access to log a stop)"
                        : near
                          ? "✓ You're here — pick what happened and it moves to the next stop"
                          : `~${Math.round(distFt).toLocaleString()} ft away — get within ${ARRIVE_FT} ft to log this stop`}
                  </div>
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

          {/* All the info we have on this pin */}
          {(() => {
            const rows = [];
            if (selected.phone) rows.push(["Phone", selected.phone]);
            if (selected.email) rows.push(["Email", selected.email]);
            if (selected.extra && typeof selected.extra === "object") {
              for (const [k, v] of Object.entries(selected.extra)) if (v != null && String(v).trim()) rows.push([k, String(v)]);
            }
            if (selected.list_name) rows.push(["List", selected.list_name]);
            if (selected.status_updated_at) rows.push(["Updated", new Date(selected.status_updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })]);
            if (selected.notes) rows.push(["Notes", selected.notes]);
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

          {(() => {
            // Behavior flow: offer only the outcomes this pin type allows. If the
            // type defines none (terminal, or unconfigured), fall back to every
            // type so a mis-set pin can still be corrected.
            const cur = S[selected.status];
            const allowed = (cur?.outcomes || []).map((k) => S[k]).filter(Boolean);
            const options = allowed.length ? allowed : pinTypes;
            return (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", margin: "14px 0 8px" }}>
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
                {/* Homeowner declined the inspection but wants a retail appt —
                    book it here. Counts on the rep's pay like a sign-up; for
                    William it books onto the zone manager's calendar. */}
                {selected.status === "insp" && (
                  <button type="button" onClick={() => setBtrPin(selected)}
                    style={{ marginTop: 10, padding: "10px 16px", borderRadius: 10, fontSize: 13.5, fontWeight: 800, cursor: "pointer",
                      border: "2px solid #b45309", background: "#fff7ed", color: "#b45309" }}>
                    🏠 BTR appt — homeowner wants retail
                  </button>
                )}
              </>
            );
          })()}

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
              logActivity({ pin_id: apptPin.id, kind: "visit", to_status: "appt" });
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
              logActivity({ pin_id: btrPin.id, kind: "visit", to_status: "appt" });
              advanceStop();
            }
            setBtrPin(null);
          }}
        />
      )}

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
