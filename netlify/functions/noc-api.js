// netlify/functions/noc-api.js
//
// "Send NOC" flow for the sales-rep dashboard. A rep who just sold a roof
// (still standing with the homeowner) looks the address up in JobNimbus,
// confirms the homeowner's contact, picks the county, and the homeowner is
// texted + emailed their county's Proof "easy-link" online-notarization URL
// plus the acceptable-forms-of-ID guide.
//
// CORS-open (GET preflight + POST) so the static rep dashboard
// (us-shingle-rep-dashboard.netlify.app) can call it cross-origin.
//
// Actions (POST { action, ... }):
//   'counties'                          → { ok, counties:[{key,label}] }  (no URLs — kept server-side)
//   'search'  { q }                     → { ok, results:[{jnid,address,city,state,zip,name}] }
//   'select'  { jnid }                  → { ok, name,phone,email,address,city,state,zip, county_key,county_label }
//   'send'    { name,phone,email,address,county_key }
//                                       → { ok, sms, email, county_label }
//
// Proof easy-links carry an ApiKey — they live ONLY here, never in the page.
//
// Env: JOBNIMBUS_API_KEY, GOOGLE_MAPS_API_KEY|VITE_GOOGLE_PLACES_API_KEY,
//      URL (self, to reach ghl-sms / send-email internally).

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const GEO_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const SELF = (process.env.URL || process.env.DEPLOY_PRIME_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
const ID_LINK = "https://support.proof.com/hc/en-us/articles/360057120014-Acceptable-Forms-of-ID-for-Online-Notarization";
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

// County / city → Proof easy-link (from "Proof- Easylinks County NOC").
// `key` is the value the page sends back; `match` are normalized strings the
// geocoder's county/city may resolve to (handles spelling quirks, St. Johns, etc.).
const NOC = [
  { key: "alachua", label: "Alachua County", match: ["alachua"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_WqaEkadavGjoPSFKELr4RhSW_1b929dfe" },
  { key: "baker", label: "Baker County", match: ["baker"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_rEDevKA68WUNFk1xftXxDgUD_5457a3bc" },
  { key: "bradford", label: "Bradford County", match: ["bradford"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_CuKWjX4DnmZBCfVoV7mMi81J_e7fe1920" },
  { key: "broward", label: "Broward County", match: ["broward"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_7xhGdHNzjxGBdz1SEcRyNQLP_39590b43" },
  { key: "charlotte", label: "Charlotte County", match: ["charlotte"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_VDWudCaDRa8mrUM1C4bXDQyE_57de0d7c" },
  { key: "citrus", label: "Citrus County", match: ["citrus"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_XPEg3QzE6zCe8ZCwMqMLQsVV_c3c960b3" },
  { key: "clay", label: "Clay County", match: ["clay"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_tux77Ae6MRBzpVZFpbo5jJpM_605a4829" },
  { key: "collier", label: "Collier County", match: ["collier"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_NiEQJyXsdFrLv6VJL38njffn_0c735630" },
  { key: "duval", label: "Duval County", match: ["duval"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_kp1JZ9oCymWGYteiGr6YrCiL_80e36010" },
  { key: "flagler", label: "Flagler County", match: ["flagler", "flaglier"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_8qbJ24cUYkKwHHdGMNAXYCwZ_85b5437d" },
  { key: "hernando", label: "Hernando County", match: ["hernando"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_2H16zMVcJEdV6o37LoRfLQLx_6ddcaea3" },
  { key: "hillsborough", label: "Hillsborough County", match: ["hillsborough"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_zKuwF7voZqZtpDWGh3MMez8S_647fa612" },
  { key: "lake", label: "Lake County", match: ["lake"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_uA2op2DdmAAm4FbjxK97VZYA_b1bec714" },
  { key: "lee", label: "Lee County", match: ["lee"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_pZDBSLuuL1tM5F8QXLxrgD2m_e514a877" },
  { key: "manatee", label: "Manatee County", match: ["manatee"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_NWpiKEVw556GJD3FR4W2fppF_d039d2ba" },
  { key: "marion", label: "Marion County", match: ["marion"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_TaeVeRY1dpbGvPAehuGvhLny_7e70367f" },
  { key: "martin", label: "Martin County", match: ["martin"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_fVupi5kLxsYb4vCvKB34ZhkD_b8afd373" },
  { key: "miamidade", label: "Miami-Dade County", match: ["miamidade", "miami dade", "dade"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_TUnQUmJNE7yCQWwLWF4mdh9s_4ef90a06" },
  { key: "nassau", label: "Nassau County", match: ["nassau"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_ZjCV5yoEYDLpUhHN7zTKttaX_3d2ae10e" },
  { key: "okaloosa", label: "Okaloosa County", match: ["okaloosa"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_fhfwPgyKzgcy1xsittn9eMzy_7cd18330" },
  { key: "orange", label: "Orange County", match: ["orange"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_RsCosanVnzQKtRTkeKk3mJAS_97797104" },
  { key: "osceola", label: "Osceola County", match: ["osceola"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_FSCXD2VMjx6Ci2c65Pru9uNr_71fe5bbe" },
  { key: "palmbeach", label: "Palm Beach County", match: ["palm beach", "palmbeach"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_2jMAFdFeAYStmckYAwJQKb2G_2569c1a8" },
  { key: "pasco", label: "Pasco County", match: ["pasco"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_ArKDbTaRoDwNQUoTLqAYNzh9_dfd74937" },
  { key: "pinellas", label: "Pinellas County", match: ["pinellas"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_EGUuVU41TyLApGqbbGd5YdHp_18ec62d4" },
  { key: "polk", label: "Polk County", match: ["polk"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_zEpp8htwx5963zZSYM9DJCJS_f62ff6f0" },
  { key: "sarasota", label: "Sarasota County", match: ["sarasota"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_Nr8fRKSkNvnQytjJFTGbWRUA_6777fd18" },
  { key: "seminole", label: "Seminole County", match: ["seminole"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_w2ry7poHL6XFm1DR7A6Y4zMm_b635e03e" },
  { key: "stjohns", label: "St. Johns County", match: ["st johns", "saint johns", "st john", "stjohns"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_zFZYaGdWm2Yun9uVLsucNyZ3_0ef78eda" },
  { key: "stlucie", label: "St. Lucie County", match: ["st lucie", "saint lucie", "stlucie"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_a9kz3E6VdLZEuPjhyDqX45XC_f5edcead" },
  { key: "volusia", label: "Volusia County", match: ["volusia"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_fkzYKtt5Q13LEAuEhQFFoKqP_9b4d3cfc" },
  // City-level NOCs — auto-detect picks the county; the rep selects these manually when the property is inside the city limits.
  { key: "city_ocala", label: "City of Ocala", match: ["ocala"], city: true, url: "https://app.proof.com/easy-link?ApiKey=prf_cli_4WZtKyZXiPw1Vcttrp5NiLwb_950de8f0" },
  { key: "city_palmcoast", label: "City of Palm Coast", match: ["palm coast"], city: true, url: "https://app.proof.com/easy-link?ApiKey=prf_cli_Ghq2RWAxcdfi9Qzn83SAV3ed_a2436756" },
  { key: "city_madeira", label: "City of Madeira Beach", match: ["madeira beach"], city: true, url: "https://app.proof.com/easy-link?ApiKey=prf_cli_Dd5unyktLLBLYYA4Xej3M3UF_4c360468" },
  { key: "city_mulberry", label: "City of Mulberry", match: ["mulberry"], city: true, url: "https://app.proof.com/easy-link?ApiKey=prf_cli_wR44nnxy39s3WGCWvtZuXKVB_dc654512" },
  { key: "island", label: "Island County", match: ["island"], url: "https://app.proof.com/easy-link?ApiKey=prf_cli_xiaDgSXPVKgEYc6sVGRCqDoX_bdcf3c74" },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });
const norm = (s) => String(s || "").toLowerCase().replace(/\bcounty\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
  const action = String(body.action || "");

  try {
    if (action === "counties") {
      return json(200, { ok: true, counties: NOC.map((c) => ({ key: c.key, label: c.label, city: !!c.city })) });
    }

    if (action === "search") {
      // Search the homeowner CONTACT by address (not the job) — works even
      // before the deal hits Sit Sold, since the contact exists from the start.
      // The dropdown shows the contact NAME so the rep picks the right person.
      const q = String(body.q || "").trim();
      if (q.length < 3) return json(200, { ok: true, results: [] });
      // JN's address_line1 only supports a leading-prefix match, AND its data
      // is inconsistent (some "426 Southwest Avenue", some "1250 E Madison st").
      // So we prefix-match the typed text PLUS its abbreviated and expanded
      // variants, covering St↔Street, E↔East, etc. either way it's stored.
      const ABBR = { north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw", street: "st", avenue: "ave", drive: "dr", road: "rd", lane: "ln", court: "ct", circle: "cir", boulevard: "blvd", place: "pl", terrace: "ter", parkway: "pkwy", highway: "hwy", trail: "trl" };
      const EXP = Object.fromEntries(Object.entries(ABBR).map(([k, v]) => [v, k]));
      const mapWords = (s, m) => s.toLowerCase().split(/\s+/).map((w) => m[w] || w).join(" ");
      const variants = [...new Set([q, mapWords(q, ABBR), mapWords(q, EXP)].map((x) => x.trim()).filter(Boolean))];
      const should = variants.map((v) => ({ match_phrase_prefix: { address_line1: v } }));
      const filter = encodeURIComponent(JSON.stringify({ must: [{ bool: { should, minimum_should_match: 1 } }] }));
      const byId = new Map();
      // Search homeowner CONTACTS and JOBS (covers either record carrying the address).
      try {
        const cr = await fetch(`${JN_BASE}/contacts?filter=${filter}&size=12`, { headers: jnHeaders });
        if (cr.ok) { const d = await cr.json().catch(() => ({})); for (const c of (d.results || d.contacts || d.data || [])) {
          const id = c.jnid || c.id; if (!id || byId.has(id)) continue;
          byId.set(id, { contact_id: id, name: `${c.first_name || ""} ${c.last_name || ""}`.trim() || c.display_name || "", address: c.address_line1 || "", city: c.city || "", state: c.state_text || c.state || "", zip: c.zip || "" });
        } }
      } catch { /* keep going */ }
      try {
        const jr = await fetch(`${JN_BASE}/jobs?filter=${filter}&size=12`, { headers: jnHeaders });
        if (jr.ok) { const d = await jr.json().catch(() => ({})); for (const j of (d.results || d.data || [])) {
          const p = j.primary || {}; const id = p.id; if (!id || byId.has(id)) continue;
          byId.set(id, { contact_id: id, name: p.name || j.display_name || "", address: j.address_line1 || "", city: j.city || "", state: j.state_text || j.state || "", zip: j.zip || "" });
        } }
      } catch { /* keep going */ }
      const results = [...byId.values()].filter((x) => x.contact_id && (x.name || x.address)).slice(0, 12);
      return json(200, { ok: true, results });
    }

    if (action === "select") {
      const cid = String(body.contact_id || "").trim();
      if (!cid) return json(400, { ok: false, error: "contact_id required" });
      const cr = await fetch(`${JN_BASE}/contacts/${cid}`, { headers: jnHeaders });
      if (!cr.ok) return json(502, { ok: false, error: `JN contact ${cr.status}` });
      const c = await cr.json();
      const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || c.display_name || "";
      const phone = c.mobile_phone || c.home_phone || c.work_phone || "";
      const email = c.email || "";
      const address = c.address_line1 || "";
      const city = c.city || "";
      const state = c.state_text || c.state || "";
      const zip = c.zip || "";
      const det = await detectCounty(address, city, state, zip);
      return json(200, { ok: true, name, phone, email, address, city, state, zip, county_key: det.key, county_label: det.label });
    }

    if (action === "send") {
      const countyKey = String(body.county_key || "");
      const entry = NOC.find((c) => c.key === countyKey);
      if (!entry) return json(400, { ok: false, error: "Pick a county/NOC link first" });
      const name = String(body.name || "").trim();
      const firstName = name.split(/\s+/)[0] || "there";
      const phone = String(body.phone || "").trim();
      const email = String(body.email || "").trim();
      const address = String(body.address || "").trim();
      if (!phone && !email) return json(400, { ok: false, error: "No phone or email to send to" });

      const sms =
        `Hi ${firstName}, this is U.S. Shingle & Metal. To finalize the permit for your new roof` +
        `${address ? ` at ${address}` : ""}, please complete your quick online notarization here:\n${entry.url}\n\n` +
        `You'll need a valid photo ID. Accepted IDs: ${ID_LINK}`;

      const emailHtml =
        `<p>Hi ${escapeHtml(firstName)},</p>` +
        `<p>Thank you for choosing U.S. Shingle &amp; Metal. To finalize the permit for your new roof` +
        `${address ? ` at <strong>${escapeHtml(address)}</strong>` : ""}, please complete your quick online notarization for <strong>${escapeHtml(entry.label)}</strong>:</p>` +
        `<p><a href="${entry.url}" style="background:#13294b;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Complete your online notarization →</a></p>` +
        `<p>You will need a valid photo ID. Please review the accepted forms of ID here:<br>` +
        `<a href="${ID_LINK}">Acceptable Forms of ID for Online Notarization</a></p>` +
        `<p>Thank you,<br>U.S. Shingle &amp; Metal</p>`;

      const out = { sms: null, email: null, county_label: entry.label };
      if (phone) {
        try {
          const r = await fetch(`${SELF}/.netlify/functions/ghl-sms`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: phone, name: name || "Homeowner", message: sms }),
          });
          out.sms = r.ok;
        } catch { out.sms = false; }
      }
      if (email) {
        try {
          const r = await fetch(`${SELF}/.netlify/functions/send-email`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: email, subject: "Finalize your new roof — quick online notarization", html: emailHtml }),
          });
          out.email = r.ok;
        } catch { out.email = false; }
      }
      if (out.sms === false && out.email !== true && out.email === false) {
        return json(502, { ok: false, error: "Both SMS and email failed to send", ...out });
      }
      return json(200, { ok: true, ...out });
    }

    return json(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

// Geocode the address → match the resolved county (or city, for city NOCs)
// against the NOC table. Best-effort; the rep can override in the UI.
async function detectCounty(address, city, state, zip) {
  if (!GEO_KEY) return { key: "", label: "" };
  try {
    const q = [address, city, state, zip].filter(Boolean).join(", ");
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${GEO_KEY}`);
    if (!r.ok) return { key: "", label: "" };
    const d = await r.json();
    const comps = d.results?.[0]?.address_components || [];
    const countyComp = comps.find((c) => c.types.includes("administrative_area_level_2"));
    const localityComp = comps.find((c) => c.types.includes("locality"));
    const countyN = norm(countyComp?.long_name);
    const localityN = norm(localityComp?.long_name);
    // County match first (the common case).
    if (countyN) {
      const hit = NOC.find((c) => !c.city && c.match.some((m) => norm(m) === countyN));
      if (hit) return { key: hit.key, label: hit.label };
    }
    // Fall back to a city match if the county isn't in our list.
    if (localityN) {
      const hit = NOC.find((c) => c.city && c.match.some((m) => norm(m) === localityN));
      if (hit) return { key: hit.key, label: hit.label };
    }
    return { key: "", label: "" };
  } catch { return { key: "", label: "" }; }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
