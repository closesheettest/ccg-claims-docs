// netlify/functions/harvest-sync-iq-background.js
//
// Sync inbound-lead JobNimbus contacts that have NO job onto the DoorDispatcher,
// per the office's JN Sync filters (app_settings.harvest_jn_filters):
//   iq → "Instant Quote" → IQ pins   ·   fb → "Facebook" → FB pins
//   ai → "AI Bot"       → AI pins
// Each: { enabled, created_before }. Same rule for all three.
//
// Background (up to 15 min) — thousands of contacts. Uses the contact's own JN
// geo when present (free); Google-geocodes the rest (bounded + cached). Date-
// shards past JN's 10k pagination cap. Reconciles away pins whose contact got a
// job / fell outside the cutoff / whose source was turned off.
//
//   Trigger: POST/GET /.netlify/functions/harvest-sync-iq-background[?source=iq|fb|ai]
//            (no source → all three). Result per source → app_settings.harvest_leadsync_<key>
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//      GOOGLE_MAPS_API_KEY (or VITE_GOOGLE_PLACES_API_KEY)

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const GEOCACHE_KEY = "iq_pin_geocache";   // shared contact-jnid -> {lat,lng} cache
const CAP = 9500, START = 1451606400;
const GEO_BUDGET = 400;

const SOURCES = {
  iq: { source: "Instant Quote", status: "iq", list: "JN Instant Quote" },
  fb: { source: "Facebook",      status: "fb", list: "JN Facebook" },
  ai: { source: "AI Bot",        status: "ai", list: "JN AI Bot" },
};

exports.handler = async (event) => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const NOW = Math.floor(Date.now() / 1000);
  const qp = (event && event.queryStringParameters) || {};
  const keys = qp.source && SOURCES[qp.source] ? [qp.source] : Object.keys(SOURCES);
  const filters = (await readSetting("harvest_jn_filters")) || {};

  const anyEnabled = keys.some((k) => (filters[k] || {}).enabled === true);
  // Which contacts already own a job (built once, shared). We ALSO capture the
  // job's status so a mapped lead that progressed (appt booked, sold, …) gets its
  // map pin RESTATUSED from the job — the reverse sync — instead of just dropping
  // off. jobStatusByContact keeps the "heaviest" status when a contact has several.
  const withJob = new Set();
  const jobStatusByContact = {};   // jn_contact_id -> mapped pin status (from its job)
  const jobByAddr = {};            // streetKey -> { zip5 -> heaviest pin-status } ("" bucket = job w/ no zip)
  const jobZips = new Set();       // every ZIP we saw a JN job in — scopes the pin index below
  const noteJob = (cid, name) => {
    if (!cid) return;
    withJob.add(cid);
    const st = jobPinStatus(name);
    if (!st) return;
    const cur = jobStatusByContact[cid];
    if (!cur || (PIN_RANK[st] || 0) > (PIN_RANK[cur] || 0)) jobStatusByContact[cid] = st;
  };
  if (anyEnabled) {
    await sharded(`${JN_BASE}/jobs`, H, [], START, NOW, (job) => {
      const name = job.status_name;
      if (job.primary && job.primary.id) noteJob(job.primary.id, name);
      for (const r of job.related || []) if (r && r.id && (r.type === "contact" || !r.type)) noteJob(r.id, name);
      // ADDRESS index: a JN job at an address (any contact/name) can restatus the
      // pin there — catches manually-created deals + contact/name mismatches that
      // the contact match above can't see (e.g. "Bart Natali" vs "Bartolomeo Natoli").
      const sk = streetKey(job.address_line1);
      if (sk) {
        const st = jobPinStatus(name);
        if (st) {
          // Bucket by ZIP within the street key. Keying by street alone let a
          // same-street-number job in ANOTHER city (different zip) occupy the slot
          // with a heavier status, after which the zip guard below skipped the
          // real same-city pin — so it never flipped (the 668 Arlington / Al Tee
          // company-appointment case). Per-zip buckets keep each location's own
          // heaviest status. "" = job with no zip (drift/manual entries).
          const z = zip5(job.zip) || "";
          if (z) jobZips.add(z);
          let bucket = jobByAddr[sk]; if (!bucket) { bucket = {}; jobByAddr[sk] = bucket; }
          if (!(z in bucket) || (PIN_RANK[st] || 0) > (PIN_RANK[bucket[z]] || 0)) bucket[z] = st;
        }
      }
    });
  }
  const geocache = (await readSetting(GEOCACHE_KEY)) || {};
  let geocacheDirty = false;

  // Global address index — every pin on the map, keyed by normalized street, so no
  // source ever drops a SECOND pin on a house another source already pinned (the
  // RepCard-vs-JN-IQ duplicate bug). Per house we remember the heaviest occupant:
  //   workedId (appt/sold/NI/…) → a new lead is SKIPPED (worked owns the house)
  //   rawId (another raw JN lead) → SKIPPED (dedupe)
  //   inspId (an unworked RepCard "insp") → the incoming IQ CONVERTS it in place
  //                                          (your "IQ beats inspection-needed")
  // This index used to load EVERY pin on the map. That was fine at a few thousand
  // pins; canvass_prospects is now ~1.57M rows, so it meant ~1,570 back-to-back
  // Supabase reads every 30 minutes — which is what pushed the OTHER dedupe queries
  // into statement timeouts and set off the double-pin bug in the first place.
  // Now it loads only the ZIPs we could actually collide in, on demand, and caches
  // which ZIPs it already has. Same guarantees, a couple of reads instead of 1,570.
  const streetIdx = new Map();    // streetKey -> [{ id, status, zip, status_by, status_updated_at }]
  const claimedKeys = new Set();  // "street|zip" handled this run (converted or freshly inserted)
  const loadedZips = new Set();
  async function loadZips(zips) {
    const want = [...new Set([...zips].filter((z) => z && !loadedZips.has(z)))];
    if (!want.length) return;
    for (let i = 0; i < want.length; i += 40) {
      const chunk = want.slice(i, i + 40);
      for (const p of await sbGetAll(`canvass_prospects?latitude=not.is.null&zip=in.(${chunk.join(",")})&select=id,address,status,zip,status_by,status_updated_at`)) {
        const sk = streetKey(p.address); if (!sk) continue;
        let arr = streetIdx.get(sk); if (!arr) { arr = []; streetIdx.set(sk, arr); }
        arr.push({ id: p.id, status: p.status, zip: zip5(p.zip), status_by: p.status_by, status_updated_at: p.status_updated_at });
      }
      chunk.forEach((z) => loadedZips.add(z));
    }
  }

  for (const key of keys) {
    const def = SOURCES[key];
    const cfg = filters[key] || {};
    const started = new Date().toISOString();
    try {
      // Load EVERY pin for this list and split by status: RAW (still the
      // source's status, e.g. "iq") vs WORKED (a rep/RepCard set a terminal or
      // appt status). The map is the source of truth for worked pins — this sync
      // must never overwrite one back to raw, nor re-insert a duplicate for it.
      // Keying "existing" only on status=iq before was the duplicate bug.
      const existingRaw = {};             // jn_contact_id -> pin id (still raw source status)
      const workedContacts = new Set();   // jn_contact_id whose pin is already worked (leave alone)
      const pinByContact = {};            // jn_contact_id -> { id, status, ... } (any status; for reverse sync)
      for (const p of await sbGetAll(`canvass_prospects?list_name=eq.${encodeURIComponent(def.list)}&select=id,extra,status,status_by,status_updated_at,address,zip`)) {
        const cid = p.extra && p.extra.jn_contact_id;
        if (!cid) continue;
        pinByContact[cid] = { id: p.id, status: p.status, status_by: p.status_by, status_updated_at: p.status_updated_at, address: p.address, zip: p.zip };
        if (p.status === def.status) existingRaw[cid] = p.id;
        else workedContacts.add(cid);
      }

      if (cfg.enabled !== true) {
        const ids = Object.values(existingRaw);
        let removed = 0; if (ids.length) { if (await del(ids)) removed = ids.length; }
        await writeSetting(`harvest_leadsync_${key}`, { ok: true, enabled: false, source: def.source, inserted: 0, updated: 0, removed, candidates: 0, started, finished: new Date().toISOString() });
        continue;
      }

      // Filter is "created ON OR AFTER" — newer leads (older ones tend to have
      // already gone with a competitor / gotten a new roof).
      const afterSec = cfg.created_after ? Math.floor(Date.parse(`${cfg.created_after}T00:00:00-04:00`) / 1000) : START;
      const cands = [];
      await sharded(`${JN_BASE}/contacts`, H, [{ match_phrase: { source_name: def.source } }], afterSec, NOW, (c) => {
        const id = c.jnid || c.id;
        if (!id || withJob.has(id)) return;
        if (!(c.address_line1 || "").trim()) return;
        cands.push(c);
      });

      // Pull the existing pins for the ZIPs these candidates live in, so the address
      // dedupe below can see them. Failure here is non-fatal — the contact-level
      // dedupe above is the primary guard and it already fails closed.
      try { await loadZips(cands.map((c) => zip5(c.zip)).filter(Boolean)); }
      catch (e) { console.warn("address index load failed (non-fatal):", e.message); }

      const coordOf = (c) => {
        const g = c.geo || {};
        const lat = num(g.lat != null ? g.lat : g.latitude), lng = num(g.lon != null ? g.lon : (g.lng != null ? g.lng : g.longitude));
        if (lat != null && lng != null && (lat || lng)) return { lat, lng };
        return geocache[c.jnid || c.id] || null;
      };
      const need = cands.filter((c) => !coordOf(c)).slice(0, GOOGLE_KEY ? GEO_BUDGET : 0);
      let geocoded = 0;
      for (let i = 0; i < need.length; i += 10) {
        const chunk = need.slice(i, i + 10);
        const res = await Promise.all(chunk.map((c) => geocode([c.address_line1, c.city, c.state_text, c.zip].filter(Boolean).join(", "))));
        chunk.forEach((c, idx) => { const g = res[idx]; if (g) { geocache[c.jnid || c.id] = g; geocoded++; geocacheDirty = true; } });
      }

      const nowIso = new Date().toISOString();
      const shouldBe = new Set();
      const toInsert = []; const updates = []; let skipped = 0, preserved = 0, dupSkipped = 0, converted = 0;
      // Pins this run has handed to an IQ lead. They must survive the collapse
      // pass below — otherwise we take a door and immediately delete it again.
      const takeoverIds = new Set();
      // Every takeover is also written to harvest_takeovers, so this whole pass
      // can be put back door-by-door if the field says the map has gone mad.
      // Best-effort: a logging failure must never stop a sync, but a takeover we
      // failed to record is one we can't reverse, so it's counted and reported.
      const takeoverLog = []; let logFailed = 0; let staleScan = 0;
      // "They scanned the QR code AGAIN" means the scan came AFTER we last
      // worked the door. The candidate pool is every IQ contact since the
      // cutoff — thousands, going back months — not just today's, so a takeover
      // has to be tested against the pin it's taking. Without this a door a rep
      // worked this morning gets flipped back to a raw lead by an April contact
      // two hours later, and again every two hours after that — exactly the
      // "Sam marked it dead and it keeps coming back" loop (Neal, 2026-08-21).
      const scanIsNewer = (c, pin) => {
        const scan = Number(c.date_created) * 1000;
        if (!Number.isFinite(scan) || !scan) return false;
        if (scan < TAKEOVER_FROM_MS) return false;          // too old to count as "they came back"
        const worked = pin && pin.status_updated_at ? Date.parse(pin.status_updated_at) : 0;
        return !worked || scan > worked;
      };
      // One takeover: become the new lead, and keep what the door used to be.
      const patchTakeover = (pinId, prev, row, at) => (
        takeoverLog.push({
          pin_id: pinId, run_at: at, source: key,
          prev_status: prev.status || null, prev_status_by: prev.status_by || null,
          prev_status_at: prev.status_updated_at || null,
          new_status: def.status, address: row.address || null, city: row.city || null,
        }),
        fetch(
        `${SB_URL}/rest/v1/canvass_prospects?id=eq.${pinId}`,
        {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            ...row,
            extra: {
              ...row.extra,
              converted_from: prev.status || null,
              converted_at: at,
              prev_status: prev.status || null,
              prev_status_by: prev.status_by || null,
              prev_status_at: prev.status_updated_at || null,
            },
          }),
        },
      ).then((r) => r.ok));
      for (const c of cands) {
        const id = c.jnid || c.id;
        // Already worked on the map (rep/RepCard set a terminal/appt status) →
        // the map owns it. Don't re-add it as a fresh raw lead (the dup bug) and
        // don't let its raw twin, if any, survive reconcile below.
        // Their own pin is already worked. For IQ that is no longer a reason to
        // drop the lead — the scan reopens the door (see IQ_WINS_SOURCE).
        if (workedContacts.has(id)) {
          const own = pinByContact[id];
          if (!(key === IQ_WINS_SOURCE && own && !COMMITTED.has(own.status))) { preserved++; continue; }
          if (!scanIsNewer(c, own)) { staleScan++; continue; }   // we worked it after they scanned — our call stands
          takeoverIds.add(own.id);
        }
        const coord = coordOf(c);
        shouldBe.add(id);
        if (!coord) { skipped++; continue; }
        const street = (c.address_line1 || "").split(",")[0].trim();
        const row = {
          name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Homeowner",
          address: street, city: c.city || null, state: c.state_text || null, zip: c.zip || null,
          phone: (c.mobile_phone || c.home_phone || c.work_phone || "").trim() || null,
          email: (c.email || "").trim() || null,
          latitude: coord.lat, longitude: coord.lng, geocode_status: "ok",
          status: def.status, status_by: `JN ${def.source} sync`, status_updated_at: nowIso, list_name: def.list,
          extra: { jn_contact_id: id, jn_source: def.source, jn_created_sec: Number(c.date_created) || null, synced_at: nowIso },
        };
        const ownWorked = workedContacts.has(id) ? pinByContact[id] : null;
        if (ownWorked) {
          updates.push(patchTakeover(ownWorked.id, ownWorked, row, nowIso));
          converted++;
        } else if (existingRaw[id]) {
          updates.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${existingRaw[id]}`, { method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(row) }).then((r) => r.ok));
        } else {
          // ── Address dedup before creating a NEW pin ─────────────────────────
          const sk = streetKey(c.address_line1);
          if (sk) {
            const cz = zip5(c.zip);
            const ck = sk + "|" + cz;
            if (claimedKeys.has(ck)) { dupSkipped++; continue; }   // already handled this house this run
            // Same street; zips must agree when BOTH are present (so a missing zip
            // still matches — that's the ~90m-drift case — but different cities don't).
            const here = (streetIdx.get(sk) || []).filter((p) => !cz || !p.zip || p.zip === cz);
            const worked = here.find((p) => !RAW_SET.has(p.status));
            const rawTwin = here.find((p) => p.status !== "insp"); // another raw JN lead already here
            const insp = here.find((p) => p.status === "insp");
            // Someone else's pin owns this house. For IQ, take it over rather
            // than throw the lead away — same rule, same history stamp.
            if (worked || rawTwin) {
              const hold = worked || rawTwin;
              if (key !== IQ_WINS_SOURCE || COMMITTED.has(hold.status)) { dupSkipped++; continue; }
              if (!scanIsNewer(c, hold)) { staleScan++; continue; }
              claimedKeys.add(ck);
              takeoverIds.add(hold.id);
              updates.push(patchTakeover(hold.id, hold, row, nowIso));
              converted++;
              continue;
            }
            if (insp) {                                            // RepCard "insp" here → IQ takes over the pin (no dup)
              claimedKeys.add(ck);
              // STAMP THE TAKEOVER. This pin keeps its original created_at, so
              // nothing downstream could tell a conversion from an ordinary
              // refresh of an existing IQ pin — and a conversion IS a new IQ
              // lead. The door stopped being an inspection lead and became one
              // a homeowner asked for (Neal, 2026-08-21).
              takeoverIds.add(insp.id);
              updates.push(patchTakeover(insp.id, insp, row, nowIso));
              converted++;
              continue;
            }
            claimedKeys.add(ck);   // claim the house for the pin we're about to insert
          }
          toInsert.push(row);
        }
      }
      const updated = (await Promise.all(updates)).filter(Boolean).length;
      if (takeoverLog.length) {
        for (let i = 0; i < takeoverLog.length; i += 500) {
          const r = await fetch(`${SB_URL}/rest/v1/harvest_takeovers`, {
            method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(takeoverLog.slice(i, i + 500)),
          }).catch(() => null);
          if (!r || !r.ok) logFailed += Math.min(500, takeoverLog.length - i);
        }
      }
      let inserted = 0;
      for (let i = 0; i < toInsert.length; i += 500) {
        const batch = toInsert.slice(i, i + 500);
        const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, { method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(batch) });
        if (r.ok) inserted += batch.length;
      }
      // A worked sibling pin at the SAME house (rep-statused in the last 7 days). Used
      // to stop a JN-status re-stamp from lighting up a competing pin next to a door a
      // rep already handled (the Jessica case: Juan Carlos booked it, but her IQ
      // contact's job still read "No Sit" so this pin kept coming back as a no-sit).
      const repWorkedSibling = (pin) => {
        const sk = streetKey(pin.address); if (!sk) return false;
        const arr = streetIdx.get(sk); if (!arr) return false;
        const pz = zip5(pin.zip) || "";
        return arr.some((s) => s.id !== pin.id && (!s.zip || !pz || s.zip === pz) && !RAW_SET.has(s.status) && repProtected(s));
      };

      // REVERSE SYNC: a mapped lead that gained a job → set its pin to the job's
      // status (appt / insp_sold / new_roof / no_sit / lost / iq_ni). A real JobNimbus
      // job is heavy authority — but NOT heavier than a rep who physically worked this
      // exact door in the last 7 days. Their field call (dead / appt / callback / sold)
      // sticks; otherwise "Sam marked it dead" gets flipped back to no-sit every run.
      const rev = [];
      for (const [cid, target] of Object.entries(jobStatusByContact)) {
        const pin = pinByContact[cid];
        if (!pin || pin.status === target) continue;
        // A door this run just handed to a fresh IQ scan is NOT re-stamped from
        // the old job status. Otherwise the scan takes the door at the top of the
        // run and their stale "BTR - NI" job flips it straight back at the
        // bottom — the reopening would last milliseconds (Neal, 2026-08-21).
        if (takeoverIds.has(pin.id)) continue;
        if (repProtected(pin)) continue;                                  // rep worked THIS pin recently → keep it
        if (target === "no_sit_reschedule" && repWorkedSibling(pin)) continue; // a rep worked this house already
        rev.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${pin.id}`, {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: target, status_by: "JN job status", status_updated_at: nowIso }),
        }).then((r) => r.ok));
      }
      const restatused = (await Promise.all(rev)).filter(Boolean).length;

      // COLLAPSE DUPLICATES: a SYNC-set raw/no-sit pin that sits at the same house as a
      // rep-worked pin is a stale twin — the rep's pin owns the door. Drop the twin so
      // the map stops offering a door the rep already handled (Jessica / Kia / Jurgens).
      const dupDrop = [];
      for (const pin of Object.values(pinByContact)) {
        if (!/^JN\b/i.test(String(pin.status_by || ""))) continue;   // only sync-set pins
        if (!RAW_SET.has(pin.status)) continue;                       // only raw / no-sit twins
        if (takeoverIds.has(pin.id)) continue;                        // just handed to a fresh IQ scan — keep it
        if (repWorkedSibling(pin)) dupDrop.push(pin.id);
      }
      let collapsed = 0; if (dupDrop.length) { if (await del(dupDrop)) collapsed = dupDrop.length; }

      // Reconcile only RAW pins (worked pins are never auto-removed — the map owns
      // them). A raw pin whose contact gained a job is left to the reverse sync
      // above (restatused, not deleted), so exclude jobStatusByContact here.
      const stale = Object.entries(existingRaw).filter(([cid]) => !shouldBe.has(cid) && !jobStatusByContact[cid]).map(([, id]) => id);
      let removed = 0; if (stale.length) { if (await del(stale)) removed = stale.length; }

      await writeSetting(`harvest_leadsync_${key}`, {
        ok: true, enabled: true, source: def.source, created_on_or_after: cfg.created_after || null,
        candidates: cands.length, inserted, updated, removed, preserved_worked: preserved, restatused_from_job: restatused, collapsed_dup_twins: collapsed, geocoded, skipped_ungeocoded: skipped, dup_skipped: dupSkipped, converted_from_insp: converted, takeovers_logged: takeoverLog.length - logFailed, skipped_scan_older_than_our_work: staleScan, takeovers_unlogged: logFailed,
        started, finished: new Date().toISOString(),
      });
      // A CONVERSION COUNTS. 43 new IQ leads coming out of JobNimbus means 43 new
      // IQ pins, whether each one created a row or took over an inspection-lead
      // pin at that house. Counting only fresh rows understated the day.
      await bumpDailyNew(key, inserted + converted); // rolling per-day new-pin tally for the JN Sync report
    } catch (e) {
      await writeSetting(`harvest_leadsync_${key}`, { ok: false, source: def.source, error: String(e && e.message || e), started, finished: new Date().toISOString() });
    }
  }

  // ── ADDRESS-BASED REVERSE SYNC ─────────────────────────────────────────────
  // A JN job at a pin's ADDRESS overrides the pin's status when the job is heavier
  // (an appointment/sold beats a raw lead or a stale "not interested"). This is the
  // net that catches deals created manually in JobNimbus and same-house/different-
  // contact name mismatches — which the contact-based sync above cannot reach.
  try {
    // Only ZIPs that actually have a JN job can be restatused by this pass, so load
    // exactly those pins (most are already in the index from the candidate load).
    await loadZips(jobZips);
    const addrRev = [];
    let addrRestatused = 0;
    const nowIso = new Date().toISOString();
    // A REP's fresh field call wins over an address-match guess (Neal): if a human rep
    // statused this door in the last 7 days, leave it — don't let a (possibly stale or
    // same-street-different-house) JN job overwrite it (the Rayner Carballo case: Sam
    // marked it dead, the old no-sit appt at the address flipped it back to "appt").
    // repProtected() is the shared module helper.
    for (const [sk, arr] of streetIdx) {
      const bucket = jobByAddr[sk]; if (!bucket) continue;
      for (const p of arr) {
        const pz = zip5(p.zip) || "";
        // Pick the heaviest job status at THIS pin's own location. A job's zip and
        // the pin's zip must AGREE when both are present (so a different city can't
        // reach across); a missing zip on either side still matches (the ~90m drift
        // + manually-entered-no-zip cases the address net was built for).
        let best = null, bestRank = -1;
        for (const z in bucket) {
          if (z && pz && z !== pz) continue;
          const rk = PIN_RANK[bucket[z]] || 0;
          if (rk > bestRank) { bestRank = rk; best = bucket[z]; }
        }
        if (!best) continue;
        if (p.status === best) continue;
        if (repProtected(p)) continue;                                // rep worked it recently → their call sticks
        if ((PIN_RANK[p.status] || 0) >= bestRank) continue;          // don't downgrade a heavier pin
        addrRev.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${p.id}`, {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: best, status_by: "JN job (address match)", status_updated_at: nowIso }),
        }).then((r) => r.ok));
      }
    }
    addrRestatused = (await Promise.all(addrRev)).filter(Boolean).length;
    await writeSetting("harvest_addr_reverse_sync", { ok: true, restatused: addrRestatused, jobs_by_addr: Object.keys(jobByAddr).length, finished: nowIso });
  } catch (e) { console.warn("address reverse sync failed (non-fatal):", e.message); }

  if (geocacheDirty) await writeSetting(GEOCACHE_KEY, geocache);
  return { statusCode: 202, body: "" };
};

// ── helpers ──────────────────────────────────────────────────────────────────
// Map a JobNimbus JOB status_name → the map pin status (reverse sync). null = leave
// the pin alone (e.g. a bare "Lead" job with no meaningful stage yet).
const PIN_RANK = { insp_sold: 6, new_roof: 5, appt: 4, retail: 4, no_sit_reschedule: 3, dead: 2, lost: 2, iq_ni: 1, insp_ni: 1 };
function jobPinStatus(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return null;
  // SOLD splits by path: a roof-INSPECTION sale (Sit Sold Insp / Sit Sold PA) →
  // insp_sold. A RETAIL sale (Sit - Sold, Signed Contract, …) → appt — it's an
  // active deal, and the install-pin sync converts it to an installed pin once
  // the roof is on, so we don't terminal-ize it as an inspection sold.
  if (s.includes("sold") || s.includes("signed")) return (s.includes("insp") || /\bpa\b/.test(s)) ? "insp_sold" : "appt";
  if (s.includes("new roof")) return "new_roof";
  if (s.includes("refused")) return "iq_ni";                                // "Refused Appointment" — before the appt check
  if (s.includes("no sit") || s.includes("no show") || s.includes("reschedul")) return "no_sit_reschedule";
  if (s.includes("appointment") || s.includes("pending")) return "appt";    // Appointment Scheduled, Sit - Pending
  if (s.includes("lost") || s.includes("no sale") || s === "dq" || s.includes("disqualif")) return "lost";
  if (s.includes("btr") || s.includes("stale") || s.includes("credit denial") || s.includes("no info") || s.includes("no response")) return "iq_ni";
  return null;
}
// Unworked "lead" statuses — a pin in one of these is still fair game. Anything
// else (appt / insp_sold / iq_ni / dead / lost / …) is WORKED and owns its house.
const RAW_SET = new Set(["iq", "fb", "ai", "insp", "no_sit_reschedule"]);
// AN IQ LEAD ALWAYS TAKES THE DOOR.
//
// An IQ pin means the homeowner just scanned the QR code asking about their
// roof. That is fresh intent, and it outranks whatever the door used to be —
// including "not interested". We want to get to them (Neal, 2026-08-21).
//
// Before this, an IQ lead was thrown away if the door already had ANY worked
// pin or any other raw lead: 409 leads were dropped on a single run. So 43 new
// IQ leads out of JobNimbus did not produce 43 IQ pins on the map, which is
// what Neal expects and is right to expect.
//
// The old status is never lost — every takeover records what the pin was, who
// set it and when, in extra.prev_* — so "they said no in June" is still on the
// record, it just no longer blocks us from going back.
const IQ_WINS_SOURCE = "iq";
// A scan older than this never takes a door. Two reasons to hold the line here:
// the 14th–15th of August was the double-pin outage (the tally read 555 and 905;
// only 180 of the 15th's pins survive, and the 14th shows the 1.27M inspection-
// lead mass load), so nothing from that window can be trusted to mean "a
// homeowner scanned". And a genuinely old scan isn't news — we want the doors
// people have come back to recently, not a re-run of the spring (Neal,
// 2026-08-21). Move the date forward as the map settles.
const TAKEOVER_FROM_MS = Date.parse("2026-08-16T00:00:00-04:00");
// The two states an IQ scan does NOT reopen: a booked appointment and a signed
// inspection. Those are commitments with something already on a calendar, and
// turning one back into a raw lead would drop a real appointment off the map.
// Everything else — not interested, dead, no-sit, lost, new roof, clover,
// inspection lead — gives way to the scan.
const COMMITTED = new Set(["appt", "insp_sold"]);
// A pin a human REP statused recently OWNS its house — a JN-derived re-stamp must
// never overwrite it (Neal's rule; the "Sam marked it dead, the sync flipped it
// back to no-sit next run" bug). Sync-set statuses (status_by "JN …") and anything
// older than the window stay eligible for a JN override.
const REP_PROTECT_MS = 7 * 24 * 60 * 60 * 1000;
function repProtected(p) {
  const by = String((p && p.status_by) || "");
  if (!by || /^JN\b/i.test(by)) return false;   // sync-set / unknown → not a rep
  const t = Date.parse((p && p.status_updated_at) || "");
  return Number.isFinite(t) && (Date.now() - t) < REP_PROTECT_MS;
}
// Normalized street key so the same house collapses across sources despite
// geocode drift + spelling ("12735 NEWTON PL" == "12735 Newton Place").
const ADDR_SUF = { street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", place: "pl", pl: "pl", drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", terrace: "ter", terr: "ter", ter: "ter", boulevard: "blvd", blvd: "blvd", road: "rd", rd: "rd", circle: "cir", cir: "cir", trail: "trl", trl: "trl", parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", cove: "cv", cv: "cv", point: "pt", pt: "pt", square: "sq", sq: "sq" };
const ADDR_DIR = { north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w", northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw" };
function streetKey(address) {
  const s = String(address || "").split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || !/^\d/.test(s)) return null;
  return s.split(" ").map((t) => ADDR_SUF[t] || ADDR_DIR[t] || t).join(" ");
}
function zip5(z) { return String(z || "").replace(/\D/g, "").slice(0, 5); }
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null; };
async function del(ids) {
  try { let ok = true; for (let i = 0; i < ids.length; i += 200) { const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=in.(${ids.slice(i, i + 200).join(",")})`, { method: "DELETE", headers: { ...sbHeaders, Prefer: "return=minimal" } }); ok = ok && r.ok; } return ok; } catch { return false; }
}
// FAIL-CLOSED, COMPLETE read. Everything this sync uses to decide "does a pin
// already exist?" comes through here, and every row missing from the result gets
// INSERTED as a new pin below — so a partial read is a duplicate-pin generator.
// The old version broke out of the loop on `!r.ok` and returned whatever it had
// (often nothing), which is how a single statement timeout re-inserted the whole
// Instant Quote list every 30 minutes on Aug 15. Now: throw on any bad page, and
// keyset-paginate on id (stable + index-friendly) instead of offset ranges with no
// ORDER BY, which could skip rows and had a hard 400k cap the table has outgrown.
async function sbGetAll(path) {
  const out = [];
  let after = "";
  for (let guard = 0; guard < 5000; guard++) {
    const url = `${SB_URL}/rest/v1/${path}&order=id.asc&limit=1000${after ? `&id=gt.${after}` : ""}`;
    const r = await fetch(url, { headers: sbHeaders });
    if (!r.ok) throw new Error(`Supabase read failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 180)}`);
    const b = await r.json();
    if (!Array.isArray(b)) throw new Error("Supabase read returned a non-array");
    out.push(...b);
    if (b.length < 1000) return out;
    after = b[b.length - 1].id;
  }
  throw new Error("Supabase read exceeded the page guard");
}
async function sharded(base, headers, must, lo, hi, onRow) {
  const filterFor = (gte, lte) => encodeURIComponent(JSON.stringify({ must: [...must, { range: { date_created: { gte, lte } } }] }));
  const countOf = async (gte, lte) => { const r = await fetch(`${base}?size=1&filter=${filterFor(gte, lte)}`, { headers }); const d = await r.json().catch(() => ({})); return Number(d.count || 0); };
  const drain = async (gte, lte) => {
    for (let page = 0; page < 100; page++) { const r = await fetch(`${base}?size=100&from=${page * 100}&filter=${filterFor(gte, lte)}`, { headers }); if (!r.ok) break; const d = await r.json().catch(() => ({})); const rows = d.results || d.contacts || d.jobs || []; if (!rows.length) break; rows.forEach(onRow); if (rows.length < 100) break; }
  };
  const rec = async (gte, lte) => { const c = await countOf(gte, lte); if (!c) return; if (c <= CAP || (lte - gte) <= 86400) { await drain(gte, lte); return; } const mid = Math.floor((gte + lte) / 2); await rec(gte, mid); await rec(mid + 1, lte); };
  await rec(lo, hi);
}
async function geocode(addr) {
  if (!GOOGLE_KEY || !addr) return null;
  try { const r = await fetch(`${GOOGLE_GEOCODE}?address=${encodeURIComponent(addr)}&region=us&key=${GOOGLE_KEY}`); if (!r.ok) return null; const d = await r.json().catch(() => ({})); const loc = d.results && d.results[0] && d.results[0].geometry && d.results[0].geometry.location; return loc && typeof loc.lat === "number" ? { lat: loc.lat, lng: loc.lng } : null; } catch { return null; }
}
async function readSetting(key) {
  try { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sbHeaders }); if (!r.ok) return null; const rows = await r.json().catch(() => []); const v = rows?.[0]?.value; return v ? (typeof v === "string" ? JSON.parse(v) : v) : null; } catch { return null; }
}
// Rolling per-day count of NEW pins this sync added, keyed by source (iq/fb/ai).
// Stored in app_settings.harvest_sync_daily → { "YYYY-MM-DD": { iq, fb, ai, nosit } }.
// The JN Sync page reads this for the "new pins per day" report. Last 21 days kept.
async function bumpDailyNew(source, count) {
  const n = Number(count) || 0; if (!n) return;
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const cur = (await readSetting("harvest_sync_daily")) || {};
    const day = cur[today] || {};
    day[source] = (day[source] || 0) + n;
    cur[today] = day;
    const keep = {}; for (const k of Object.keys(cur).sort().slice(-21)) keep[k] = cur[k];
    await writeSetting("harvest_sync_daily", keep);
  } catch { /* non-fatal */ }
}
async function writeSetting(key, obj) {
  try { await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }) }); } catch { /* ignore */ }
}
