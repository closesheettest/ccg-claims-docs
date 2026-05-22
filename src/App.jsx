import React, { useEffect, useRef, useState } from "react";
import html2pdf from "html2pdf.js/dist/html2pdf";
import {
  ArrowLeft,
  FileSignature,
  Mail,
  RotateCcw,
  Send,
} from "lucide-react";
import { supabase } from "./lib/supabase";
import { InspectorMobileApp, InspectorsAdminPanel, InspectorSetupPage, ManagerInspectorReports, InspectionAssignmentsPanel, ManagerRoutePlanner, PAHandoffPanel } from "./InspectorViews";
import InspectionPhotosModal from "./InspectionPhotosModal";
import JnMatchPickerModal from "./JnMatchPickerModal";

// Inject Oswald font
if (typeof document !== "undefined" && !document.getElementById("oswald-font")) {
  const link = document.createElement("link");
  link.id = "oswald-font";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Nunito:wght@400;500;600;700&display=swap";
  document.head.appendChild(link);
}

const PA_FIXED = {
  name: "Kortni Keckler",
  initials: "KK",
  license: "PA License W435195 | Business License G033912",
  signatureImage: "/benito-signature.png",
};

// PA workflow toggle. Hides:
//   * The LoR + PA Authorization options from the sales-rep signing UI
//   * The "Claim Admin" section on the homeowner intake form
//
// Currently the PA is handling their own paperwork outside this system, so
// the workflow is OFF by default. If we ever switch to a different PA who
// wants to sign through here, admin flips this back ON via
// Manager → Security & Notifications → "PA Workflow" toggle, and all the
// hidden bits return. Nothing is deleted — toggle off just hides.
//
// Stored in localStorage under the same "ccg_mgr_" prefix as other manager
// settings. Read at module load, so toggling triggers a one-time page
// reload to refresh every reference site cleanly. Already-signed PA docs
// are unaffected either way.
const PA_FORMS_DISABLED = (() => {
  try {
    return localStorage.getItem("ccg_mgr_paWorkflowEnabled") !== "true";
  } catch {
    return true;
  }
})();

const PA_ASSETS = {
  header: "/pa-header.png",
  footer: "/pa-footer.png",
  titleBar: "/pa-titlebar.png",
};

const REP_FIXED = {
  name: "Hank Smith",
  signatureImage: "/rep-signature.png",
};

const INSPECTION_COMPANY = {
  name: "U.S. Shingle & Metal LLC",
  address: "3845 Gateway Centre Blvd Suite 300 • Pinellas Park, FL 33782",
  phone: "727.761.5200",
  email: "info@shingleusa.com",
  license: "CCC1331960",
};

const VALID_DOCS = ["insp", "lor", "pac"];

// ── US states for the State dropdown ─────────────────────────────────
// Used in every form that captures a property/billing state. Locking it
// down to a fixed list means we never get "fl" / "FL" / "Florida" / " fl"
// inconsistencies in the data.
const US_STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"],
];
// Normalize any existing free-text state value to the 2-letter code.
// Accepts "fl", "FL", " fl ", "Florida", "florida" → "FL".
const normalizeStateValue = (raw) => {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (trimmed.length === 2) return trimmed.toUpperCase(); // already a code
  // Try matching the full name (case-insensitive)
  const lower = trimmed.toLowerCase();
  const match = US_STATES.find(([_, name]) => name.toLowerCase() === lower);
  if (match) return match[0];
  // Last resort — if it's longer than 2 chars but matches the start of a state name
  const partial = US_STATES.find(([_, name]) => name.toLowerCase().startsWith(lower));
  return partial ? partial[0] : trimmed.toUpperCase().slice(0, 2);
};

// ── Email validation ──────────────────────────────────────────────
// Empty strings are considered valid (so optional email fields don't
// throw errors when blank). Non-empty values must match a basic
// "user@host.tld" shape: at least one char before @, at least one char
// before the dot, and at least 2 chars after the dot. This is the same
// lightweight shape JN, Resend, and most APIs expect — strict enough to
// catch typos like "ppumphrey" but loose enough not to reject anything
// real (no full RFC-5322 nightmare regex).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isValidEmail = (v) => {
  const s = (v || "").trim();
  return s === "" || EMAIL_RE.test(s);
};

const SIGNATURE_FONTS = [
  `"Brush Script MT", cursive`,
  `"Segoe Script", cursive`,
  `"Lucida Handwriting", cursive`,
];

// ── Google Places Autocomplete ────────────────────────────────────────
// Loads the Maps JavaScript API once (idempotently) and exposes a small
// React component that wraps the new PlaceAutocompleteElement Web Component.
// The legacy Autocomplete class was deprecated for new customers in March 2025
// (see https://developers.google.com/maps/documentation/javascript/places-migration-overview),
// so we use the new element-based API.
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_PLACES_API_KEY || "";
let googlePlacesLoadPromise = null;
const loadGooglePlaces = () => {
  if (typeof window === "undefined") return Promise.reject(new Error("not in browser"));
  if (window.google?.maps?.places?.PlaceAutocompleteElement) return Promise.resolve(window.google);
  if (googlePlacesLoadPromise) return googlePlacesLoadPromise;
  if (!GOOGLE_API_KEY) {
    return Promise.reject(new Error("VITE_GOOGLE_PLACES_API_KEY is not set in environment variables"));
  }
  googlePlacesLoadPromise = new Promise((resolve, reject) => {
    // Remove any cached old-format script that doesn't support importLibrary
    document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]').forEach(s => s.remove());
    if (window.google?.maps && !window.google.maps.importLibrary) {
      // Wipe the partially-loaded older API so we can reload with the new bootstrap
      try { delete window.google.maps; } catch (_) { window.google.maps = undefined; }
    }

    // Use the official bootstrap loader pattern from Google docs.
    // This always exposes window.google.maps.importLibrary regardless of script version.
    // Reference: https://developers.google.com/maps/documentation/javascript/load-maps-js-api
    (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({
      key: GOOGLE_API_KEY,
      v: "weekly",
    });

    // Now use importLibrary to load just what we need
    window.google.maps.importLibrary("places")
      .then(() => resolve(window.google))
      .catch(reject);
  });
  return googlePlacesLoadPromise;
};

// AddressAutocomplete — wraps the new google.maps.places.PlaceAutocompleteElement
// (a Web Component). It auto-displays a styled dropdown of US addresses
// (Florida-biased). When the user picks a suggestion, `onPlaceSelected({ address, city, state, zip })`
// fires with the parsed components.
//
// Lock-down: the new element handles its own input, so the only way to
// commit data to the parent is by selecting from the dropdown. Free-typed
// text without a selection never makes it through.
function AddressAutocomplete({ value, onChange, onPlaceSelected, placeholder, style, errorBorder, id }) {
  const wrapperRef = React.useRef(null);
  const elementRef = React.useRef(null);
  const [verified, setVerified] = React.useState(false);
  const [loadError, setLoadError] = React.useState(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    loadGooglePlaces()
      .then(async (google) => {
        if (!mounted || !wrapperRef.current) return;

        // Create the new element. PlaceAutocompleteElement is a custom HTML
        // element (Web Component) — we just append it to our wrapper div.
        const el = new google.maps.places.PlaceAutocompleteElement({
          // Restrict to US addresses
          includedRegionCodes: ["us"],
        });
        // Apply some styling so the element fits our form aesthetic
        el.style.width = "100%";
        elementRef.current = el;

        // Listen for the user picking an address
        el.addEventListener("gmp-select", async (event) => {
          try {
            const place = event.placePrediction.toPlace();
            // The new API requires us to fetch the fields we want
            await place.fetchFields({ fields: ["addressComponents", "formattedAddress"] });
            const comps = place.addressComponents || [];
            let streetNum = "", route = "", city = "", state = "", zip = "";
            for (const c of comps) {
              const types = c.types || [];
              if (types.includes("street_number")) streetNum = c.longText || c.shortText || "";
              else if (types.includes("route")) route = c.longText || c.shortText || "";
              else if (types.includes("locality")) city = c.longText || c.shortText || "";
              else if (types.includes("sublocality") && !city) city = c.longText || c.shortText || "";
              else if (types.includes("administrative_area_level_3") && !city) city = c.longText || c.shortText || "";
              else if (types.includes("administrative_area_level_1")) state = c.shortText || c.longText || "";
              else if (types.includes("postal_code")) zip = c.longText || c.shortText || "";
            }
            const fullAddr = [streetNum, route].filter(Boolean).join(" ");
            setVerified(true);
            onPlaceSelected?.({ address: fullAddr, city, state, zip, formatted: place.formattedAddress || fullAddr });
          } catch (err) {
            console.error("Failed to parse selected address:", err);
          }
        });

        wrapperRef.current.appendChild(el);
        setReady(true);
      })
      .catch((e) => {
        console.error("Google Places load error:", e);
        if (mounted) setLoadError(e.message || "Could not load address autocomplete");
      });
    return () => {
      mounted = false;
      if (elementRef.current && elementRef.current.parentNode) {
        elementRef.current.parentNode.removeChild(elementRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the element's input value in sync with our React state when the
  // parent updates (e.g. clearing, prefilling from My Homeowners).
  React.useEffect(() => {
    if (!elementRef.current) return;
    try {
      // PlaceAutocompleteElement doesn't expose .value directly; the inner
      // input does. Grab it via the shadow DOM or property accessor.
      if (typeof elementRef.current.value !== "undefined") {
        elementRef.current.value = value || "";
      }
    } catch (_) { /* ignore */ }
    if (!value) setVerified(false);
  }, [value]);

  // The new element doesn't expose typing events as cleanly as a regular input,
  // so we render a plain fallback input ALONGSIDE for the parent's controlled
  // value display. The Google element overlays it for UI/dropdown purposes.

  return (
    <div style={{ position: "relative" }}>
      {loadError ? (
        // Fallback to a plain input if Google failed to load
        <>
          <input
            id={id}
            type="text"
            value={value || ""}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={placeholder || "Address (autocomplete unavailable)"}
            style={{
              width: "100%",
              height: 44,
              borderRadius: 14,
              padding: "0 12px",
              fontSize: 14,
              boxSizing: "border-box",
              fontFamily: "'Nunito', sans-serif",
              background: "#fff",
              border: errorBorder ? "2px solid #ef4444" : "1px solid #d1d5db",
              ...(style || {}),
            }}
          />
          <div style={{ fontSize: 11, color: "#dc2626", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
            ⚠️ {loadError}
          </div>
        </>
      ) : (
        <>
          {/* Google's PlaceAutocompleteElement is appended into this wrapper at runtime */}
          <div
            ref={wrapperRef}
            style={{
              width: "100%",
              border: errorBorder
                ? "2px solid #ef4444"
                : verified && value
                  ? "2px solid #199c2e"
                  : "1px solid #d1d5db",
              borderRadius: 14,
              background: "#fff",
              minHeight: 44,
              boxSizing: "border-box",
              ...(style || {}),
            }}
          />
          {!ready ? (
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
              Loading address search…
            </div>
          ) : verified && value ? (
            <div style={{ fontSize: 11, color: "#166534", marginTop: 4, fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
              ✓ Verified address: {value}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
              Type and pick an address from the dropdown
            </div>
          )}
        </>
      )}
    </div>
  );
}

const PDF_LAYOUT = {
  headerHeight: "1.85in",
  footerHeight: "1.0in",
};

const REVIEW_INTRO_TEXT =
  "Two quick documents stand between you and getting your claim moving.";

const LOR_REVIEW_TEXT =
  'First is the “Letter of Representation” which simply tells your insurance company that you’ve hired a Public Adjuster.';

const PAC_REVIEW_TEXT =
  'The second is the “Public Adjuster Authorization” which is the authorization between you and the Public Adjuster.';

const REVIEW_HELP_TEXT =
  "Preview each document first if you'd like, then click 'Click to Authorize' for both before signing.";

const initialData = {
  date: new Date().toISOString().split("T")[0],
  insuranceCompany: "",
  policyNumber: "",
  lossLocation: "",
  lossLocationSameAsAddress: true,
  signerEmail: "",
  paEmail: "Kkeckleradj@gmail.com",
  representativeName: "",
  leadSource: "Inspection",  // "Inspection" (was "NEED") | "INS"
  salesRepId: "",
  salesRepName: "",
  salesRepEmail: "",
  homeowner1: "",
  homeowner2: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
  situation: "",
  claimStage: "pre_inspection", // "pre_inspection" | "post_inspection"
  dateOfLoss: "",
  claimNumber: "",
  claimType: "Wind/Hail",
  lossDescription: "Roof",
  initials1: "",
  initials2: "",
};

const initialAuditInfo = {
  signedAt: "",
  signedIp: "",
  signedUserAgent: "",
  signMethod: "",
  signedByEmail: "",
  signedByName: "",
  signedCity: "",
  signedRegion: "",
};

function documentLabel(doc) {
  if (doc === "pac") return "PA Authorization";
  if (doc === "insp") return "Free Roof Inspection";
  return "Letter of Representation";
}

function documentFilename(doc) {
  if (doc === "pac") return "Public-Adjuster-Authorization.pdf";
  if (doc === "insp") return "Free-Roof-Inspection-Agreement.pdf";
  return "Letter-of-Representation.pdf";
}

function formatAddress(data) {
  return [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

function typedSignatureToDataUrl(text, fontFamily, width = 500, height = 140) {
  if (!String(text || "").trim()) return "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111827";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `42px ${fontFamily}`;
  ctx.fillText(text, width / 2, height / 2);
  return canvas.toDataURL("image/png");
}

function typedInitialsToDataUrl(text, fontFamily, width = 220, height = 70) {
  if (!String(text || "").trim()) return "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111827";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `30px ${fontFamily}`;
  ctx.fillText(text, width / 2, height / 2);
  return canvas.toDataURL("image/png");
}
const INSP_ROWS_NO_DAMAGE = [
  { category: "Roofing Material Type",       finding: "Asphalt Shingle & Metal Roofing System",           result: "PASS" },
  { category: "Shingle Condition",            finding: "No cracking, curling, buckling, or granule loss",  result: "PASS" },
  { category: "Metal Panel Condition",        finding: "No rust, corrosion, dents, or seam separation",    result: "PASS" },
  { category: "Flashing & Sealants",          finding: "All flashings intact; sealants in good condition", result: "PASS" },
  { category: "Gutters & Downspouts",         finding: "Clear of debris; properly secured and functional", result: "PASS" },
  { category: "Ridge & Hip Caps",             finding: "Intact; no lifting or displacement observed",      result: "PASS" },
  { category: "Roof Deck (Visible)",          finding: "No soft spots, sagging, or structural compromise", result: "PASS" },
  { category: "Ventilation",                  finding: "Adequate ventilation present; no obstruction",     result: "PASS" },
  { category: "Water Intrusion / Leaks",      finding: "No evidence of active or prior water intrusion",   result: "PASS" },
  { category: "Overall Structural Integrity", finding: "Roof system structurally sound and weathertight",  result: "PASS" },
];

const INSP_ROWS_DAMAGE = [
  { category: "Roofing Material Type",       finding: "Asphalt Shingle & Metal Roofing System",              result: "N/A"  },
  { category: "Shingle Condition",            finding: "Storm damage observed — see inspection notes",         result: "FAIL" },
  { category: "Metal Panel Condition",        finding: "N/A",                                                  result: "N/A"  },
  { category: "Flashing & Sealants",          finding: "N/A",                                                  result: "N/A"  },
  { category: "Gutters & Downspouts",         finding: "N/A",                                                  result: "N/A"  },
  { category: "Ridge & Hip Caps",             finding: "N/A",                                                  result: "N/A"  },
  { category: "Roof Deck (Visible)",          finding: "N/A",                                                  result: "N/A"  },
  { category: "Ventilation",                  finding: "N/A",                                                  result: "N/A"  },
  { category: "Water Intrusion / Leaks",      finding: "N/A",                                                  result: "N/A"  },
  { category: "Overall Structural Integrity", finding: "Structural damage confirmed — replacement required",   result: "FAIL" },
];

function InspectionCertificatePDF({ record, result, inspectorName, certNumber, inspectionDate, fmtDateLong, fmtDateShort, addOneYearStr }) {
  if (!record) return null;
  const hasDamage = result === "damage";
  const rows = hasDamage ? INSP_ROWS_DAMAGE : INSP_ROWS_NO_DAMAGE;
  const today = inspectionDate || new Date().toISOString().split("T")[0];
  const certNo = certNumber || `RC-${today.replace(/-/g,"").slice(0,8)}-0001`;
  const inspector = inspectorName || "—";
  const tdL = { padding: "6px 10px", fontSize: 10.5, fontWeight: 700, color: "#0a0a0a", background: "#eef1f8", border: "1px solid #c8d4e8", width: "24%" };
  const tdV = { padding: "6px 10px", fontSize: 10.5, color: "#111827", background: "#fff", border: "1px solid #c8d4e8" };

  return (
    <div id="inspection-certificate-printable" style={{ width: "8.5in", minHeight: "11in", background: "#fff", fontFamily: "Arial, Helvetica, sans-serif", boxSizing: "border-box" }}>
      <div style={{ border: "6px solid #1a2e5a", margin: "0.3in 0.35in" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "stretch", borderBottom: "4px solid #1a2e5a" }}>
          <div style={{ width: "1.9in", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 10px", borderRight: "3px solid #1a2e5a", flexShrink: 0 }}>
            <img src="/uss-header.png" alt="U.S. Shingle & Metal" style={{ width: "100%", maxHeight: "1in", objectFit: "contain" }} />
          </div>
          <div style={{ flex: 1, textAlign: "center", padding: "12px 14px" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1a2e5a", textTransform: "uppercase" }}>CERTIFIED ROOFING INSPECTION CERTIFICATE</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#c8392b", marginTop: 3 }}>U.S. Shingle and Metal LLC</div>
            <div style={{ fontSize: 10.5, color: "#374151", marginTop: 2 }}>Residential &amp; Commercial Roofing Inspection</div>
            <div style={{ fontSize: 10.5, color: "#374151" }}>Licensed • Insured • Roof Inspectors</div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#c8392b", marginTop: 2 }}>ASPHALT SHINGLE | METAL ROOFING SYSTEMS</div>
          </div>
        </div>

        {/* Contact bar */}
        <div style={{ background: "#1a2e5a", color: "#fff", textAlign: "center", padding: "5px 14px", fontSize: 10.5, borderBottom: "3px solid #c8392b" }}>
          Phone: 727-761-5200 &nbsp;|&nbsp; Email: inspection@shingleusa.com &nbsp;|&nbsp; www.shingleusa.com &nbsp;|&nbsp; License #: CCC1331960
        </div>

        {/* Cert # / date */}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 14px", fontSize: 10.5, borderBottom: "1px solid #c8d4e8", background: "#f8fafc" }}>
          <div><strong>Certificate No:</strong> {certNo}</div>
          <div><strong>Issue Date:</strong> {fmtDateLong(today)}</div>
        </div>

        {/* Property info */}
        <div style={{ padding: "10px 14px 6px", borderBottom: "2px solid #1a2e5a" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#1a2e5a", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>PROPERTY INFORMATION</div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 4 }}>
            <tbody>
              <tr><td style={tdL}>Property Address:</td><td style={tdV}>{record.address || ""}</td><td style={tdL}>Inspection Date:</td><td style={tdV}>{fmtDateLong(today)}</td></tr>
              <tr><td style={tdL}>City, State, ZIP:</td><td style={tdV}>{[record.city, record.state, record.zip].filter(Boolean).join(", ")}</td><td style={tdL}>Inspector Name:</td><td style={tdV}>{inspector}</td></tr>
              <tr><td style={tdL}>Property Owner:</td><td style={tdV}>{record.client_name || ""}</td><td style={tdL}>License No.:</td><td style={tdV}>CCC1331960</td></tr>
            </tbody>
          </table>
        </div>

        {/* Certification statement */}
        <div style={{ margin: "8px 14px", border: "2px solid #1a2e5a", borderRadius: 4, padding: "9px 13px", background: hasDamage ? "#fff5f5" : "#f0fdf4" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1a2e5a", textAlign: "center", marginBottom: 5, textTransform: "uppercase" }}>OFFICIAL CERTIFICATION STATEMENT</div>
          <div style={{ fontSize: 10.5, lineHeight: 1.65, color: "#111827", textAlign: "center" }}>
            {hasDamage
              ? <>This is to certify that a thorough roofing inspection was conducted by U.S. Shingle and Metal LLC on the above-referenced property. Based on the findings, the roof system has been evaluated and <strong>STORM DAMAGE HAS BEEN IDENTIFIED</strong>. The roof system requires immediate attention. A licensed Public Adjuster has been notified to assist with the insurance claims process.</>
              : <>This is to certify that a thorough roofing inspection was conducted by U.S. Shingle and Metal LLC on the above-referenced property. Based on the findings, the roof system has been evaluated and is hereby certified to be <strong>FREE FROM STRUCTURAL DAMAGE</strong>, with an estimated remaining serviceable life of <strong>FIVE (5) YEARS OR MORE</strong> under normal weather and maintenance conditions.</>}
          </div>
        </div>

        {/* Findings table */}
        <div style={{ padding: "0 14px 6px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#1a2e5a", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>INSPECTION FINDINGS</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
            <thead>
              <tr style={{ background: "#1a2e5a", color: "#fff" }}>
                <th style={{ padding: "5px 9px", textAlign: "left", border: "1px solid #1a2e5a", width: "30%" }}>INSPECTION CATEGORY</th>
                <th style={{ padding: "5px 9px", textAlign: "left", border: "1px solid #1a2e5a" }}>FINDINGS / OBSERVATIONS</th>
                <th style={{ padding: "5px 9px", textAlign: "center", border: "1px solid #1a2e5a", width: "72px" }}>RESULT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isFail = row.result === "FAIL";
                const isNA = row.result === "N/A";
                return (
                  <tr key={row.category} style={{ background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                    <td style={{ padding: "4px 9px", border: "1px solid #d1d5db", fontWeight: 700, color: isFail ? "#dc2626" : "#1a2e5a", fontSize: 10 }}>{row.category}</td>
                    <td style={{ padding: "4px 9px", border: "1px solid #d1d5db", color: "#374151", fontSize: 10 }}>{row.finding}</td>
                    <td style={{ padding: "4px 9px", border: "1px solid #d1d5db", textAlign: "center" }}>
                      <div style={{ background: isFail ? "#dc2626" : isNA ? "#6b7280" : "#199c2e", color: "#fff", borderRadius: 3, padding: "2px 5px", fontSize: 9.5, fontWeight: 700, display: "inline-block", minWidth: 32 }}>{row.result}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Status boxes */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", margin: "6px 14px", border: "2px solid #1a2e5a", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ background: "#1a2e5a", padding: "9px 13px", borderRight: "2px solid #fff" }}>
            <div style={{ fontSize: 8.5, color: "#c8392b", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>ESTIMATED REMAINING ROOF LIFE:</div>
            <div style={{ fontSize: hasDamage ? 14 : 20, fontWeight: 700, color: "#fff" }}>{hasDamage ? "Needs Replacement" : "5+ YEARS"}</div>
          </div>
          <div style={{ background: hasDamage ? "#dc2626" : "#199c2e", padding: "9px 13px", textAlign: "center", borderRight: "2px solid #fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,0.85)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>DAMAGE STATUS</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{hasDamage ? "DAMAGE FOUND" : "NO DAMAGE"}</div>
          </div>
          <div style={{ background: "#c8392b", padding: "9px 13px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,0.85)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>CERT. INSPECTED ON</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{fmtDateShort(today)}</div>
          </div>
        </div>

        {/* Signature */}
        <div style={{ padding: "7px 14px 9px" }}>
          <div style={{ borderTop: "1px solid #c8d4e8", paddingTop: 7 }}>
            <div style={{ borderBottom: "1px solid #111827", height: 32, width: "2.5in", marginBottom: 3 }} />
            <div style={{ fontSize: 9.5, fontWeight: 700, color: "#374151" }}>Inspector Signature</div>
            <div style={{ fontSize: 9.5, color: "#374151", marginTop: 1 }}>Name: {inspector} &nbsp;&nbsp;&nbsp; License #: CCC1331960</div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ background: "#f8fafc", borderTop: "3px solid #1a2e5a", padding: "7px 14px", display: "flex", alignItems: "center", gap: 12 }}>
          <img src="/uss-header.png" alt="USS" style={{ height: 32, objectFit: "contain", flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: "#1a2e5a" }}>U.S. Shingle and Metal LLC — Residential &amp; Commercial Roofing Inspection</div>
            <div style={{ fontSize: 8.5, color: "#6b7280" }}>This certificate is based on visual inspection only and does not constitute a warranty or guarantee.</div>
            <div style={{ fontSize: 8.5, color: "#6b7280" }}>Cert No. {certNo} | Issued: {fmtDateLong(today)} | Valid Through: {addOneYearStr(today)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
function DuplicateScreen({ duplicateRecord, signMode, signerEmail, onGoBack, onProceedAnyway, onResend }) {
  const rec = duplicateRecord.record;
  const isSigned = duplicateRecord.status === "signed";
  const isInsp = duplicateRecord.type === "inspection";
  const name = isInsp ? rec.client_name : [rec.homeowner1, rec.homeowner2].filter(Boolean).join(" & ");
  const addr = [rec.address, rec.city, rec.state, rec.zip].filter(Boolean).join(", ");
  const signedDate = rec.signed_at ? new Date(rec.signed_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "40px 20px" }}>
      {/* Banner */}
      <div style={{
        background: isSigned ? "linear-gradient(135deg, #0a0a0a 0%, #0f1e3d 100%)" : "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
        borderRadius: 24, padding: "32px 28px", textAlign: "center", color: "#fff", marginBottom: 20,
      }}>
        <div style={{ fontSize: 52, marginBottom: 10 }}>{isSigned ? "⚠️" : "📨"}</div>
        <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>
          {isSigned ? "Already Signed Up!" : "Documents Already Sent"}
        </div>
        <div style={{ fontSize: 15, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92, lineHeight: 1.6 }}>
          {isSigned
            ? `This address already has ${isInsp ? "an inspection agreement" : "signed PA documents"} on file.`
            : "Documents were sent to this address but haven't been signed yet."}
        </div>
      </div>

      {/* Details card */}
      <div style={{ background: "#fff", borderRadius: 20, border: "1px solid #e5e7eb", padding: "22px 24px", marginBottom: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", marginBottom: 14, letterSpacing: "0.02em" }}>
          Existing Record
        </div>
        <div style={{ display: "grid", gap: 8, fontSize: 14, fontFamily: "'Nunito', sans-serif" }}>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Name:</span>
            <span style={{ fontWeight: 700, color: "#111827" }}>{name || "—"}</span>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Address:</span>
            <span style={{ fontWeight: 600, color: "#374151" }}>{addr || "—"}</span>
          </div>
          {isInsp && rec.sales_rep_name ? (
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Rep:</span>
              <span style={{ fontWeight: 600, color: "#374151" }}>{rec.sales_rep_name}</span>
            </div>
          ) : null}
          {signedDate ? (
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ color: "#6b7280", width: 80, flexShrink: 0 }}>Signed:</span>
              <span style={{ fontWeight: 600, color: "#374151" }}>{signedDate}</span>
            </div>
          ) : null}
          {!isSigned ? (
            <div style={{ marginTop: 6, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#92400e", fontWeight: 600 }}>
              ⏳ Sent but not yet signed — you can resend the link without creating a duplicate.
            </div>
          ) : null}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: "grid", gap: 10 }}>
        {!isSigned ? (
          /* Pending — offer to resend */
          <button type="button" onClick={onResend}
            style={{ padding: "14px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
            📨 Resend Signing Link
          </button>
        ) : null}

        {isSigned && signMode !== "send" ? (
          /* Already signed + sign-now mode — can still proceed if it's a different form */
          <button type="button" onClick={onProceedAnyway}
            style={{ padding: "14px", borderRadius: 14, border: "none", background: "#6b7280", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
            ⚠️ Sign Anyway (Different Forms)
          </button>
        ) : null}

        {isSigned && signMode === "send" ? (
          <button type="button" onClick={onProceedAnyway}
            style={{ padding: "14px", borderRadius: 14, border: "none", background: "#6b7280", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
            ⚠️ Send Anyway (Different Forms)
          </button>
        ) : null}

        <button type="button" onClick={onGoBack}
          style={{ padding: "14px", borderRadius: 14, border: "2px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
          ← Go Back
        </button>
      </div>
    </div>
  );
}

function SendingScreen({ onMount }) {
  const calledRef = React.useRef(false);
  React.useEffect(() => {
    if (!calledRef.current) { calledRef.current = true; onMount(); }
  }, []);
  return (
    <div style={{ maxWidth: 440, margin: "80px auto", padding: "0 20px", textAlign: "center" }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>📨</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#199c2e", marginBottom: 10 }}>
        Sending...
      </div>
      <div style={{ fontSize: 15, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
        Saving record and sending signing link to homeowner.
      </div>
    </div>
  );
}

function Button({
  children,
  onClick,
  type = "button",
  variant = "default",
  disabled = false,
  style: overrideStyle = {},
}) {
  const baseStyle = {
    height: 48,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid #d1d5db",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    opacity: disabled ? 0.6 : 1,
    transition: "background 0.2s, border-color 0.2s",
  };

  const styles =
    variant === "outline"
      ? {
          ...baseStyle,
          background: "#fff",
          color: "#111827",
          ...overrideStyle,
        }
      : {
          ...baseStyle,
          background: "#199c2e",
          color: "#fff",
          border: "1px solid #199c2e",
          ...overrideStyle,
        };

  return (
    <button type={type} onClick={onClick} style={styles} disabled={disabled}>
      {children}
    </button>
  );
}

function Card({ children, style = {} }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 24,
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        border: "1px solid #e5e7eb",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({ children }) {
  return <div style={{ padding: 24, paddingBottom: 12 }}>{children}</div>;
}

function CardTitle({ children }) {
  return (
    <div style={{ fontSize: 30, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }}>
      {children}
    </div>
  );
}

function CardDescription({ children }) {
  return (
    <div style={{ fontSize: 16, color: "#6b7280", marginTop: 8, fontFamily: "'Nunito', sans-serif", fontWeight: 500, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function CardContent({ children, style }) {
  return <div style={{ padding: 24, paddingTop: 12, ...(style || {}) }}>{children}</div>;
}

function Label({ children }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: 14,
        color: "#374151",
        marginBottom: 8,
        fontWeight: 600,
        fontFamily: "'Nunito', sans-serif",
      }}
    >
      {children}
    </label>
  );
}

function SectionTitle({ children }) {
  return (
    <div
      style={{
        fontSize: 16,
        fontWeight: 700,
        color: "#111827",
        marginBottom: 14,
        fontFamily: "'Oswald', sans-serif",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function Separator() {
  return (
    <div
      style={{
        width: "100%",
        height: 1,
        background: "#e5e7eb",
        margin: "8px 0",
      }}
    />
  );
}

function FormField({
  label,
  value,
  onChange,
  type = "text",
  placeholder = "",
  disabled = false,
  // When type="email", showError can be passed by parent to force the error
  // visible (e.g. when the form is submitted and the field is invalid).
  // Otherwise the error appears only after the field has been blurred once,
  // so the user isn't yelled at while they're still typing.
  showError = false,
}) {
  const [touched, setTouched] = useState(false);
  const isEmail = type === "email";
  const trimmed = (value || "").toString().trim();
  const isInvalidEmail = isEmail && trimmed.length > 0 && !EMAIL_RE.test(trimmed);
  const showErrorState = isInvalidEmail && (touched || showError);

  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        // Hint to mobile browsers + password managers that this is an email field
        autoCapitalize={isEmail ? "off" : undefined}
        autoCorrect={isEmail ? "off" : undefined}
        spellCheck={isEmail ? false : undefined}
        inputMode={isEmail ? "email" : undefined}
        style={{
          width: "100%",
          height: 44,
          borderRadius: 14,
          border: showErrorState ? "1.5px solid #dc2626" : "1px solid #d1d5db",
          padding: "0 12px",
          fontSize: 14,
          boxSizing: "border-box",
          background: disabled ? "#f3f4f6" : (showErrorState ? "#fef2f2" : "#fff"),
        }}
      />
      {showErrorState ? (
        <div style={{ color: "#dc2626", fontSize: 11, marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
          Please enter a valid email address (e.g. name@example.com).
        </div>
      ) : null}
    </div>
  );
}

function CheckboxField({ label, checked, onChange }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 14,
        color: "#374151",
        fontWeight: 500,
        marginBottom: 8,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16 }}
      />
      {label}
    </label>
  );
}

function SignaturePad({
  title,
  value,
  onChange,
  height = 160,
  required = false,
  missing = false,
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(window.devicePixelRatio || 1, 1);

    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = value;
    }
  }, [value]);

  const getPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
  };

  const start = (e) => {
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawingRef.current = true;
  };

  const move = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange(canvasRef.current.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    onChange("");
  };

  const isEmpty = !value;

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Outer card */}
      <div style={{
        borderRadius: 20,
        border: missing
          ? "2.5px solid #ef4444"
          : isEmpty
            ? "2.5px dashed #199c2e"
            : "2.5px solid #199c2e",
        background: missing ? "#fef2f2" : "#f0fdf4",
        overflow: "hidden",
        boxShadow: missing
          ? "0 0 0 4px rgba(239,68,68,0.08)"
          : isEmpty
            ? "0 0 0 4px rgba(25,156,46,0.08)"
            : "0 0 0 4px rgba(25,156,46,0.12)",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}>
        {/* Hint bar at top */}
        {isEmpty ? (
          <div style={{
            background: "#199c2e",
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <span style={{
              color: "#fff",
              fontSize: 13,
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 700,
            }}>
              ✍️ Sign in the box below
            </span>
            <span style={{
              color: "rgba(255,255,255,0.8)",
              fontSize: 12,
              fontFamily: "'Nunito', sans-serif",
            }}>
              Use finger or mouse
            </span>
          </div>
        ) : (
          <div style={{
            background: "#15803d",
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <span style={{
              color: "#fff",
              fontSize: 13,
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 700,
            }}>
              ✅ Signature captured!
            </span>
            <button
              type="button"
              onClick={clear}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                borderRadius: 8,
                color: "#fff",
                fontSize: 12,
                fontFamily: "'Nunito', sans-serif",
                fontWeight: 700,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              ↺ Redo
            </button>
          </div>
        )}

        {/* Canvas area */}
        <div style={{ position: "relative", background: "#fff" }}>
          {isEmpty ? (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              userSelect: "none",
            }}>
              <span style={{
                fontSize: 15,
                color: "#d1d5db",
                fontFamily: "'Nunito', sans-serif",
                fontStyle: "italic",
                fontWeight: 600,
              }}>
                Your signature here...
              </span>
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              height,
              display: "block",
              touchAction: "none",
              cursor: "crosshair",
            }}
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
          />
          {/* Signature line */}
          <div style={{
            position: "absolute",
            bottom: 24,
            left: "10%",
            right: "10%",
            height: 1,
            background: "#e5e7eb",
            pointerEvents: "none",
          }} />
        </div>
      </div>

      {missing ? (
        <div style={{
          color: "#ef4444",
          fontSize: 13,
          marginTop: 8,
          fontFamily: "'Nunito', sans-serif",
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}>
          ⚠️ Please add your signature above
        </div>
      ) : null}
    </div>
  );
}

function InitialsPad({
  title,
  value,
  onChange,
  required = false,
  missing = false,
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(window.devicePixelRatio || 1, 1);

    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = value;
    }
  }, [value]);

  const getPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
  };

  const start = (e) => {
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawingRef.current = true;
  };

  const move = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const p = getPoint(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange(canvasRef.current.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    onChange("");
  };

  const isEmpty = !value;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        borderRadius: 16,
        border: missing
          ? "2.5px solid #ef4444"
          : isEmpty
            ? "2.5px dashed #199c2e"
            : "2.5px solid #199c2e",
        background: missing ? "#fef2f2" : "#fff",
        overflow: "hidden",
        boxShadow: missing
          ? "0 0 0 3px rgba(239,68,68,0.08)"
          : isEmpty
            ? "0 0 0 3px rgba(25,156,46,0.08)"
            : "0 0 0 3px rgba(25,156,46,0.12)",
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}>
        {/* Top label bar */}
        <div style={{
          background: isEmpty ? "#f0fdf4" : "#15803d",
          padding: "6px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: isEmpty ? "1px solid #bbf7d0" : "none",
        }}>
          <span style={{
            fontSize: 12,
            fontFamily: "'Nunito', sans-serif",
            fontWeight: 700,
            color: isEmpty ? "#166534" : "#fff",
          }}>
            {isEmpty ? "✏️ Initials here" : "✅ Initials captured!"}
          </span>
          {!isEmpty ? (
            <button
              type="button"
              onClick={clear}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 11,
                fontFamily: "'Nunito', sans-serif",
                fontWeight: 700,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              ↺ Redo
            </button>
          ) : null}
        </div>

        {/* Canvas */}
        <div style={{ position: "relative", background: "#fff" }}>
          {isEmpty ? (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              userSelect: "none",
            }}>
              <span style={{
                fontSize: 13,
                color: "#d1d5db",
                fontFamily: "'Nunito', sans-serif",
                fontStyle: "italic",
                fontWeight: 600,
              }}>e.g. JD</span>
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              height: 52,
              display: "block",
              touchAction: "none",
              cursor: "crosshair",
            }}
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
          />
        </div>
      </div>

      {missing ? (
        <div style={{
          color: "#ef4444",
          fontSize: 13,
          marginTop: 6,
          fontFamily: "'Nunito', sans-serif",
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}>
          ⚠️ Please add your initials above
        </div>
      ) : null}
    </div>
  );
}

function TypedSignatureField({
  title,
  value,
  onChange,
  fontValue,
  onFontChange,
  required = false,
  missing = false,
  placeholder,
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Label>
        {title}
        {required ? <span style={{ color: "#dc2626" }}> *</span> : null}
      </Label>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          height: 44,
          borderRadius: 12,
          border: missing ? "2px solid #dc2626" : "1px solid #d1d5db",
          padding: "0 12px",
          marginBottom: 10,
          boxSizing: "border-box",
          background: missing ? "#fef2f2" : "#fff",
        }}
      />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {SIGNATURE_FONTS.map((font, idx) => (
          <button
            key={font}
            type="button"
            onClick={() => onFontChange(font)}
            style={{
              border:
                fontValue === font
                  ? "2px solid #111827"
                  : "1px solid #d1d5db",
              borderRadius: 10,
              background: "#fff",
              cursor: "pointer",
              padding: "10px 14px",
              fontSize: 22,
              fontFamily: font,
            }}
          >
            {value || `Style ${idx + 1}`}
          </button>
        ))}
      </div>

      {missing ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          Required before submitting.
        </div>
      ) : null}
    </div>
  );
}

function TypedInitialsField({
  title,
  value,
  onChange,
  fontValue,
  onFontChange,
  required = false,
  missing = false,
  placeholder,
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Label>
        {title}
        {required ? <span style={{ color: "#dc2626" }}> *</span> : null}
      </Label>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          height: 44,
          borderRadius: 12,
          border: missing ? "2px solid #dc2626" : "1px solid #d1d5db",
          padding: "0 12px",
          marginBottom: 10,
          boxSizing: "border-box",
          background: missing ? "#fef2f2" : "#fff",
        }}
      />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {SIGNATURE_FONTS.map((font, idx) => (
          <button
            key={font}
            type="button"
            onClick={() => onFontChange(font)}
            style={{
              border:
                fontValue === font
                  ? "2px solid #111827"
                  : "1px solid #d1d5db",
              borderRadius: 10,
              background: "#fff",
              cursor: "pointer",
              padding: "10px 14px",
              fontSize: 18,
              fontFamily: font,
            }}
          >
            {value || `Style ${idx + 1}`}
          </button>
        ))}
      </div>

      {missing ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          Required before submitting.
        </div>
      ) : null}
    </div>
  );
}

// Rep-facing help modal: "Understanding the App". Walks reps through what
// they're responsible for, what the app does automatically, when the PA
// gets pulled in, and how the three inspection outcomes (Damage / No
// Damage / Retail) play out. Same flow as the PA onboarding doc but from
// the rep's perspective.
function RepHelpModal({ onClose }) {
  const stepCard = (color, num, title, body, autoNote, paNote) => (
    <div style={{
      border: `1.5px solid ${color.border}`,
      background: color.bg,
      borderRadius: 12,
      padding: "14px 16px",
    }}>
      <span style={{
        display: "inline-block",
        background: color.numBg, color: color.numFg,
        fontFamily: "'Oswald', sans-serif", fontWeight: 700,
        fontSize: 12, padding: "3px 10px", borderRadius: 999,
        marginBottom: 8, letterSpacing: "0.05em",
      }}>{num}</span>
      <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, fontWeight: 700, color: "#0a0a0a", marginBottom: 6, letterSpacing: "0.02em" }}>{title}</div>
      <div style={{ fontSize: 13.5, color: "#374151", lineHeight: 1.5 }}>{body}</div>
      {autoNote ? (
        <div style={{ marginTop: 8, padding: "6px 10px", background: "#c9a35c", color: "#0a0a0a", borderRadius: 6, fontSize: 12, fontWeight: 700, fontFamily: "'Oswald', sans-serif", display: "inline-block", letterSpacing: "0.04em" }}>
          📲 {autoNote}
        </div>
      ) : null}
      {paNote ? (
        <div style={{ marginTop: 8, padding: "6px 10px", background: "#0a0a0a", color: "#c9a35c", borderRadius: 6, fontSize: 12, fontWeight: 700, fontFamily: "'Oswald', sans-serif", display: "inline-block", letterSpacing: "0.04em" }}>
          📩 {paNote}
        </div>
      ) : null}
    </div>
  );
  const C = {
    muted:   { bg: "#f9fafb", border: "#d1d5db", numBg: "#0a0a0a", numFg: "#c9a35c" },
    gold:    { bg: "#fffbf3", border: "#c9a35c", numBg: "#c9a35c", numFg: "#0a0a0a" },
    damage:  { bg: "#fff1f1", border: "#dc2626", numBg: "#dc2626", numFg: "#fff" },
    nodam:   { bg: "#f0fdf4", border: "#15803d", numBg: "#15803d", numFg: "#fff" },
    retail:  { bg: "#eff6ff", border: "#2563eb", numBg: "#2563eb", numFg: "#fff" },
  };
  const arrow = <div style={{ textAlign: "center", color: "#c9a35c", fontSize: 22, lineHeight: 1, margin: "2px 0" }}>▼</div>;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      zIndex: 9999, padding: "30px 16px", overflowY: "auto",
      fontFamily: "'Nunito', system-ui, sans-serif",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        maxWidth: 880, margin: "0 auto", background: "#fff",
        borderRadius: 16, overflow: "hidden",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      }}>
        {/* Branded header */}
        <div style={{ background: "#0a0a0a", color: "#fff", borderBottom: "3px solid #c9a35c", padding: "20px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 20, fontWeight: 700, color: "#c9a35c", letterSpacing: "0.05em", textTransform: "uppercase" }}>
              ❔ Understanding the App
            </div>
            <div style={{ fontSize: 12, color: "#d4af6c", fontStyle: "italic", marginTop: 4, fontFamily: "Georgia, serif" }}>
              How the rep / inspection / PA flow runs — from start to handoff
            </div>
          </div>
          <button type="button" onClick={onClose} style={{
            background: "transparent", border: "1px solid rgba(255,255,255,0.3)",
            color: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer",
            fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12,
            letterSpacing: "0.05em", textTransform: "uppercase",
          }}>✕ Close</button>
        </div>

        <div style={{ padding: "20px 28px", color: "#374151" }}>
          <p style={{ margin: "0 0 14px", fontSize: 14 }}>
            Quick walkthrough of what <strong>you</strong> do, what the app does automatically, and when the PA is pulled in. The 📲 markers show what the <strong>homeowner</strong> gets automatically. The 📩 markers show what gets sent to <strong>Kortni (the PA)</strong>.
          </p>

          {/* Banner — only shown when PA workflow is off. Toggle on
              Manager → PA Management → PA Workflow re-enables the
              LoR + PA Authorization options across the app. */}
          {PA_FORMS_DISABLED && (
            <div style={{ padding: "10px 14px", background: "#fef3c7", border: "2px solid #d97706", borderRadius: 10, fontSize: 13, color: "#78350f", fontWeight: 600, lineHeight: 1.4, marginBottom: 14 }}>
              ⛔ <strong>Heads up:</strong> PA paperwork is handled outside this system right now. You can only sign Inspection Agreements here — the PA team will follow up with the homeowner directly on their LoR + PA Authorization.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>

            {stepCard(C.muted, "1", "You sign up the homeowner",
              "On the first visit, you have the homeowner e-sign the Inspection Agreement. (PA paperwork is currently disabled — see banner above.)"
            )}
            {arrow}

            {stepCard(C.muted, "2", "Inspector visits the property",
              "Scheduled in JobNimbus. The inspector goes on-site, photographs the roof, and documents findings. You don't have to do anything in this step."
            )}
            {arrow}

            {stepCard(C.gold, "3", "Inspector classifies the result in JobNimbus",
              <>One of three outcomes gets logged: <strong>Damage</strong>, <strong>No Damage</strong>, or <strong>Retail (Wear &amp; Tear)</strong>. The app reads the status automatically — you don't chase anyone for it.</>
            )}
            {arrow}

            <div style={{ textAlign: "center", fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "#6b7280", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", margin: "4px 0 6px" }}>
              — Auto-message goes to the homeowner (all three outcomes) —
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {stepCard(C.damage, "4A", "⚠️ Damage",
                "Storm damage confirmed — claim path. (Currently the LoR/PA paperwork step is paused while we set up the new PA.)",
                <>"U.S. Shingle has completed the inspection — <em>{`{your name}`}</em> will be swinging by"</>
              )}
              {stepCard(C.nodam, "4B", "✅ No Damage",
                "Roof is sound. No claim, no PA paperwork.",
                <>"U.S. Shingle has completed the inspection — <em>{`{your name}`}</em> will be swinging by"</>
              )}
              {stepCard(C.retail, "4C", <>🏠 Retail<span style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginLeft: 6 }}>(Wear &amp; Tear)</span></>,
                "Significant age-related wear & tear — roof needs replacement but it's not storm damage, so not a claim. Direct retail sale path.",
                <>"U.S. Shingle has completed the inspection — <em>{`{your name}`}</em> will be swinging by"</>
              )}
            </div>

            <p style={{ textAlign: "center", margin: "8px 0 0", fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>
              Same auto-text + email goes out the moment the inspector logs the result. <strong>Don't wait</strong> — go follow up promptly so the homeowner isn't ahead of you.
            </p>

            {arrow}

            <div style={{ padding: "12px 14px", background: "#fef3c7", border: "2px dashed #d97706", borderRadius: 12 }}>
              <span style={{ display: "inline-block", background: "#d97706", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: "0.06em", padding: "3px 10px", borderRadius: 999, marginBottom: 8 }}>EXCEPTION</span>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 15, color: "#92400e", marginBottom: 4 }}>
                Paperwork already signed BEFORE inspection &nbsp;+&nbsp; result = Damage
              </div>
              <div style={{ fontSize: 13, color: "#78350f", lineHeight: 1.5 }}>
                Skip the default "rep will swing by" message. Homeowner is moved to the <strong>custom stage configured in Admin</strong> instead — whatever email/SMS lives there fires.
              </div>
            </div>

            {arrow}

            {stepCard(C.gold, "5", "You visit the homeowner & walk through results in person",
              <>This is your call. <strong>Damage:</strong> {PA_FORMS_DISABLED ? "the PA team takes it from here — they'll contact the homeowner directly to handle paperwork." : "get LoR + PA Authorization signed."} <strong>Retail:</strong> walk them through the wear & tear findings, offer a paid roof replacement. <strong>No Damage:</strong> confirm with them and leave the certificate (they can submit it to their insurer if asked to replace).</>,
              null,
              "Damage path: Once paperwork is signed, Kortni receives the damage-confirmation email + signed LoR + signed PA Authorization automatically."
            )}
            {arrow}

            {stepCard(C.gold, "6", "Damage path: PA takes the claim from here",
              "Once Kortni has the signed paperwork, she calls the homeowner within 24 hours and handles the carrier from there. Your job on that lead is done unless someone tags you back in."
            )}

          </div>

          {/* Inbox legend */}
          <div style={{ marginTop: 18, padding: "12px 14px", border: "1px dashed #c9a35c", borderRadius: 10, background: "#fffbf3", fontSize: 13, color: "#4b5563" }}>
            <strong style={{ color: "#0a0a0a" }}>What kicks in automatically:</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 20, lineHeight: 1.6 }}>
              <li>Homeowner SMS + email after every inspection result (Damage / No Damage / Retail)</li>
              <li>Inspection certificate PDF generated for No Damage and Retail outcomes</li>
              <li>Damage-confirmation email + signed PDFs to Kortni — Damage path only</li>
            </ul>
          </div>

          <div style={{ marginTop: 14, fontSize: 11, color: "#9ca3af", fontStyle: "italic", textAlign: "center" }}>
            Click anywhere outside this box, or hit ✕ Close, to dismiss.
          </div>
        </div>
      </div>
    </div>
  );
}

function PdfPage({
  children,
  header,
  footer,
  isExportingPdf = false,
  contentPadding = "0 0.42in 0.12in",
  headerHeight = PDF_LAYOUT.headerHeight,
  footerHeight = PDF_LAYOUT.footerHeight,
}) {
  if (isExportingPdf) {
    return (
      <div
        className="pdf-page"
        style={{
          position: "relative",
          width: "8.5in",
          height: "11in",
          background: "#fff",
          boxSizing: "border-box",
          overflow: "hidden",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "#111827",
        }}
      >
        {header ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: headerHeight,
              lineHeight: 0,
              overflow: "hidden",
            }}
          >
            {header}
          </div>
        ) : null}

        {footer ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: footerHeight,
              lineHeight: 0,
              overflow: "hidden",
            }}
          >
            {footer}
          </div>
        ) : null}

        <div
          style={{
            position: "absolute",
            top: header ? headerHeight : 0,
            left: 0,
            right: 0,
            bottom: footer ? footerHeight : 0,
            boxSizing: "border-box",
            padding: contentPadding,
            overflow: "hidden",
          }}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      className="pdf-page"
      style={{
        background: "#fff",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        overflow: "hidden",
        marginBottom: 16,
        fontFamily: "Georgia, 'Times New Roman', serif",
        color: "#111827",
      }}
    >
      {header ? <div style={{ lineHeight: 0 }}>{header}</div> : null}
      <div style={{ padding: contentPadding }}>{children}</div>
      {footer ? <div style={{ lineHeight: 0 }}>{footer}</div> : null}
    </div>
  );
}

function AuditTrailPage({
  auditInfo,
  data,
  docLabel,
  claimId,
  isExportingPdf = false,
}) {
  if (!auditInfo?.signedAt) return null;

  const rows = [
    ["Document", docLabel],
    ["Claim ID", claimId || "Not available"],
    [
      "Signed by",
      auditInfo.signedByName ||
        [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
    ],
    ["Signer email", auditInfo.signedByEmail || data.signerEmail],
    ["Signed at", auditInfo.signedAt],
    ["IP address", auditInfo.signedIp],
    ...(auditInfo.signedCity || auditInfo.signedRegion
      ? [[
          "City / State",
          [auditInfo.signedCity, auditInfo.signedRegion]
            .filter(Boolean)
            .join(", "),
        ]]
      : []),
    ["Sign method", auditInfo.signMethod],
    ["Browser / device", auditInfo.signedUserAgent],
  ];

  return (
    <div
      className="pdf-page"
      style={
        isExportingPdf
          ? {
              width: "8.5in",
              height: "11in",
              background: "#fff",
              boxSizing: "border-box",
              overflow: "hidden",
              fontFamily: "Arial, Helvetica, sans-serif",
              color: "#111827",
            }
          : {
              background: "#fff",
              borderRadius: 24,
              border: "1px solid #e5e7eb",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
              overflow: "hidden",
              marginBottom: 16,
              fontFamily: "Arial, Helvetica, sans-serif",
              color: "#111827",
            }
      }
    >
      <div
        style={{
          padding: "0.55in 0.6in",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontSize: 26, fontWeight: 700, marginBottom: 10 }}>
          Signature Acknowledgment
        </div>

        <div style={{ fontSize: 14, color: "#4b5563", marginBottom: 24 }}>
          Electronic signing audit trail for this document.
        </div>

        <div
          style={{
            border: "1px solid #d1d5db",
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          {rows.map(([label, value], i) => (
            <div
              key={label}
              style={{
                display: "grid",
                gridTemplateColumns: "200px 1fr",
                borderTop: i === 0 ? "none" : "1px solid #e5e7eb",
              }}
            >
              <div
                style={{
                  background: "#f8fafc",
                  padding: "14px 16px",
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                {label}
              </div>
              <div
                style={{
                  padding: "14px 16px",
                  fontSize: 13,
                  wordBreak: "break-word",
                  whiteSpace: "pre-wrap",
                }}
              >
                {value || "Not available"}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 24,
            border: "1px solid #d1d5db",
            borderRadius: 16,
            padding: 18,
            background: "#f8fafc",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          By signing electronically, the signer acknowledged intent to sign this
          document and submitted the signature using the browser session that
          generated the audit information shown above.
        </div>
      </div>
    </div>
  );
}


function LetterOfRepresentation({
  data,
  sig1,
  sig2,
  auditInfo,
  claimId,
  isExportingPdf = false,
}) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const fullAddress = formatAddress(data);
  const displayedLossLocation = data.lossLocationSameAsAddress
    ? fullAddress
    : data.lossLocation;

  // HTML-rendered header — Healthy Homes black/gold theme with the
  // shield mark (cropped from the full logo) on the left and the
  // company info on the right. Uses table layout (not flex) for
  // reliable side-by-side positioning under html2pdf. Shield uses
  // object-fit:contain + max-height so it scales to the cell without
  // overflow regardless of the PNG's intrinsic ratio.
  const HeaderImg = () => (
    <div style={{
      width: "100%", height: "1.85in", boxSizing: "border-box",
      background: "#0a0a0a", color: "#fff",
      borderBottom: "3px solid #c9a35c",
      padding: "0.1in 0.4in",
    }}>
      <div style={{ display: "table", width: "100%", height: "100%" }}>
        <div style={{ display: "table-cell", verticalAlign: "middle", width: "1.65in", paddingRight: 16 }}>
          <div style={{ width: "1.55in", height: "1.55in", display: "flex", alignItems: "center", justifyContent: "center", overflow: "visible" }}>
            <img src="/hh-shield.png" alt="Healthy Homes shield" style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", display: "block" }} />
          </div>
        </div>
        <div style={{ display: "table-cell", verticalAlign: "middle", textAlign: "left" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#c9a35c", letterSpacing: "0.05em", lineHeight: 1.2, fontFamily: "'Oswald', Arial, sans-serif" }}>
            HEALTHY HOMES PUBLIC ADJUSTING
          </div>
          <div style={{ fontSize: 11, color: "#d4af6c", marginTop: 5, lineHeight: 1.3, fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: "italic" }}>
            Public Adjusting &nbsp;·&nbsp; Property Claim Documentation &nbsp;·&nbsp; Roof / Wind / Water Support
          </div>
          <div style={{ fontSize: 11, color: "#fff", marginTop: 5, lineHeight: 1.3, fontFamily: "Georgia, 'Times New Roman', serif" }}>
            Kortni Keckler &nbsp;|&nbsp; Public Adjuster &nbsp;|&nbsp; FL License W435195
          </div>
          <div style={{ fontSize: 11, color: "#fff", marginTop: 2, lineHeight: 1.3, fontFamily: "Georgia, 'Times New Roman', serif" }}>
            Phone: 561-283-5674 &nbsp;|&nbsp; Email: Kkeckleradj@gmail.com
          </div>
        </div>
      </div>
    </div>
  );

  const FooterImg = () => (
    <div style={{
      width: "100%", height: "1.0in", boxSizing: "border-box",
      background: "#0a0a0a", color: "#fff",
      borderTop: "3px solid #c9a35c",
      padding: "0.08in 0.4in 0",
      textAlign: "center",
      fontFamily: "Georgia, 'Times New Roman', serif",
    }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, color: "#c9a35c", textTransform: "uppercase", letterSpacing: "0.08em", lineHeight: 1.2, fontFamily: "'Oswald', Arial, sans-serif" }}>
        Confidential &nbsp;·&nbsp; For Intended Recipient Only
      </div>
      <div style={{ fontSize: 7, color: "#d1d5db", lineHeight: 1.35, marginTop: 3, fontStyle: "italic" }}>
        This document is for claim-documentation and operational coordination purposes only. No coverage determination, engineering opinion, construction guarantee, or legal advice is being provided. All claim decisions remain subject to policy terms, carrier review, applicable Florida law, and licensed public adjuster review.
      </div>
      <div style={{ fontSize: 8, color: "#c9a35c", fontWeight: 700, marginTop: 4, lineHeight: 1.25, fontFamily: "'Oswald', Arial, sans-serif", letterSpacing: "0.04em" }}>
        Kort Co, LLC d/b/a Healthy Homes Public Adjusting
      </div>
      <div style={{ fontSize: 7.5, color: "#c9a35c", fontWeight: 700, marginTop: 1, lineHeight: 1.25, fontFamily: "'Oswald', Arial, sans-serif", letterSpacing: "0.03em" }}>
        FL PA License W435195 &nbsp;|&nbsp; Business License G033912 &nbsp;|&nbsp; PropertyDamageInspection.com &nbsp;|&nbsp; 561-283-5674
      </div>
    </div>
  );

  const LorTitleBar = () => (
    <div
      style={{
        margin: "10px 0 12px",
        background: "#0a0a0a",
        color: "#c9a35c",
        textAlign: "center",
        fontWeight: 700,
        fontSize: 20,
        letterSpacing: 1,
        padding: "11px 16px",
        textTransform: "uppercase",
        fontFamily: "'Oswald', Arial, sans-serif",
        border: "2px solid #c9a35c",
      }}
    >
      Letter of Representation
    </div>
  );

  const labelStyle = {
    display: "block",
    fontSize: 12,
    color: "#4b5563",
    marginBottom: 6,
    fontWeight: 400,
  };

  const fieldBoxStyle = {
    minHeight: 46,
    border: "1px solid #d1d5db",
    borderRadius: 12,
    padding: "10px 12px",
    background: "#fff",
    fontSize: 12,
    lineHeight: 1.35,
    color: "#111827",
    boxSizing: "border-box",
  };

  const bodyText = {
    fontSize: 14,
    lineHeight: 1.5,
    color: "#111827",
  };

  const footerBlock = (
    <div
      style={{
        borderTop: "3px solid #c9a35c",
        marginTop: 14,
        paddingTop: 10,
        fontSize: 12,
        color: "#111827",
        lineHeight: 1.35,
      }}
    >
      <div style={{ fontWeight: 700 }}>3570 S Ocean Blvd</div>
      <div>
        South Palm Beach, FL 33480 • Kkeckleradj@gmail.com • 561-283-5674 •
        propertydamageinspection.com
      </div>
      <div style={{ marginTop: 6, fontWeight: 700, color: "#a17e3f" }}>
        License No: W435195
      </div>
    </div>
  );

  return (
    <div
      id="lor-printable-document"
      style={{
        background: "transparent",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#111827",
      }}
    >
      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        footer={<FooterImg />}
        contentPadding="0 0.42in 0.12in"
      >
        <LorTitleBar />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginTop: 10,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={labelStyle}>Date</div>
            <div style={fieldBoxStyle}>{data.date}</div>
          </div>

          <div>
            <div style={labelStyle}>Insurance Company</div>
            <div style={fieldBoxStyle}>{data.insuranceCompany}</div>
          </div>

          <div>
            <div style={labelStyle}>Address</div>
            <div style={fieldBoxStyle}>
              <div style={{ whiteSpace: "pre-line" }}>{fullAddress}</div>
            </div>
          </div>

          <div>
            <div style={labelStyle}>State</div>
            <div style={fieldBoxStyle}>{data.state}</div>
          </div>

          <div>
            <div style={labelStyle}>Claim #</div>
            <div style={fieldBoxStyle}>{data.claimNumber}</div>
          </div>

          <div>
            <div style={labelStyle}>Client / Insured</div>
            <div style={fieldBoxStyle}>
              {[data.homeowner1, data.homeowner2].filter(Boolean).join(", ")}
            </div>
          </div>

          <div>
            <div style={labelStyle}>Loss Location</div>
            <div style={fieldBoxStyle}>
              <div style={{ whiteSpace: "pre-line" }}>
                {displayedLossLocation}
              </div>
            </div>
          </div>

          <div>
            <div style={labelStyle}>Policy #</div>
            <div style={fieldBoxStyle}>{data.policyNumber}</div>
          </div>

          <div>
            <div style={labelStyle}>Date of Loss</div>
            <div style={fieldBoxStyle}>{data.dateOfLoss}</div>
          </div>

          <div>
            <div style={labelStyle}>Signer Email (recipient)</div>
            <div style={fieldBoxStyle}>{data.signerEmail}</div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid #d1d5db", marginBottom: 14 }} />

        <div style={bodyText}>
          <p style={{ margin: "0 0 10px" }}>Dear Claims Manager:</p>

          <p style={{ margin: "0 0 10px" }}>
            This correspondence will serve to inform you and the Insurance
            Company that your insured has formally retained our services to
            assist them in evaluating and presenting their above-referenced
            claim. We have enclosed a copy of our signed representation notice,
            which we request that you record in your claim file and properly
            provide us with a written acknowledgment of our involvement.
          </p>

          <p style={{ margin: "0 0 10px" }}>
            Additionally, we request that all further contact and communication
            involving this claim’s processing from the Insurance Company be
            directed exclusively through our offices. This also extends to your
            representative contractor/claims agents and/or any other claims
            agents you may be using in the processing of this claim.
          </p>

          <p style={{ margin: "0 0 10px" }}>
            Further, as the policy sets forth the duties, rights, and
            parameters of coverage, it is critical that we have expedited access
            to this information, we hereby request a true and complete certified
            copy of the applicable policy contract including the declarations
            page, all policy endorsements, and the original policy application.
            Please expedite these documents to our attention.
          </p>
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        footer={<FooterImg />}
        contentPadding="0 0.42in 0.12in"
      >
        <div style={{ ...bodyText, marginTop: 10 }}>
          <p style={{ margin: "0 0 14px", fontStyle: "italic" }}>
            Also, please note that Healthy Homes Public Adjusting should be named as
            an additional payee on all insurance drafts and/or payments,
            pursuant to the enclosed Notice of Loss/Notice of Representation
            signed by the Insured(s). The insured(s) hereby reserve all rights
            to make claims under the policy for replacement cost benefits as set
            forth in the policy and likewise invoke their rights to repair,
            rebuild or replace the damaged property.
          </p>

          <p style={{ margin: "0 0 10px" }}>
            Surely, you understand the Assured’s need to have this claim
            processed as quickly as possible, and as such, we will be
            undertaking all necessary steps to document and prepare their claim
            for submission. We look forward to working cooperatively with you to
            reach a fair and prompt resolution to this claim. Please feel free
            to contact us at 954-874-3563 to discuss the current status of this
            claim and to coordinate our efforts in the loss investigation and
            valuation process.
          </p>

          <p style={{ margin: "0 0 18px", fontStyle: "italic" }}>
            The Assureds hereby reserve all of their rights under the policy and
            the laws of this State and nothing contained herein is intended to
            waive or prejudice said rights.
          </p>

          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              marginBottom: 8,
            }}
          >
            Insured Signature
          </div>

          <div
            style={{
              border: "1px dashed #cbd5e1",
              borderRadius: 12,
              minHeight: 138,
              background: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              padding: 12,
            }}
          >
            {sig1 || sig2 ? (
              <div
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
                  gap: 18,
                  alignItems: "center",
                }}
              >
                <div style={{ textAlign: "center" }}>
                  {sig1 ? (
                    <img
                      src={sig1}
                      alt="Insured Signature 1"
                      style={{
                        maxWidth: "100%",
                        maxHeight: 80,
                        objectFit: "contain",
                      }}
                    />
                  ) : (
                    <span style={{ color: "#94a3b8", fontSize: 12 }}>
                      Signature pending
                    </span>
                  )}
                </div>

                {hasSecond ? (
                  <div style={{ textAlign: "center" }}>
                    {sig2 ? (
                      <img
                        src={sig2}
                        alt="Insured Signature 2"
                        style={{
                          maxWidth: "100%",
                          maxHeight: 80,
                          objectFit: "contain",
                        }}
                      />
                    ) : (
                      <span style={{ color: "#94a3b8", fontSize: 12 }}>
                        Signature pending
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <span style={{ color: "#94a3b8", fontSize: 12 }}>
                Signature pending
              </span>
            )}
          </div>

          {footerBlock}
        </div>
      </PdfPage>

      <AuditTrailPage
        auditInfo={auditInfo}
        data={data}
        docLabel="Letter of Representation"
        claimId={claimId}
        isExportingPdf={isExportingPdf}
      />
    </div>
  );
}

function PublicAdjusterContract({
  data,
  sig1,
  sig2,
  auditInfo,
  claimId,
  isExportingPdf = false,
}) {
  const hasSecond = Boolean(data.homeowner2?.trim());
  const insuredNames = [data.homeowner1, data.homeowner2]
    .filter(Boolean)
    .join(", ");

  const bodyText = {
    fontSize: 14,
    lineHeight: 1.43,
    color: "#111827",
    fontFamily: "Arial, Helvetica, sans-serif",
  };

  const sectionHead = {
    color: "#a17e3f",
    fontWeight: 700,
    textTransform: "uppercase",
  };

  // Mirrors the LorPdf HeaderImg above — shield on the left + info on
  // the right via table layout for html2pdf compatibility.
  const HeaderImg = () => (
    <div style={{
      width: "100%", height: "1.85in", boxSizing: "border-box",
      background: "#0a0a0a", color: "#fff",
      borderBottom: "3px solid #c9a35c",
      padding: "0.1in 0.4in",
    }}>
      <div style={{ display: "table", width: "100%", height: "100%" }}>
        <div style={{ display: "table-cell", verticalAlign: "middle", width: "1.65in", paddingRight: 16 }}>
          <div style={{ width: "1.55in", height: "1.55in", display: "flex", alignItems: "center", justifyContent: "center", overflow: "visible" }}>
            <img src="/hh-shield.png" alt="Healthy Homes shield" style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", display: "block" }} />
          </div>
        </div>
        <div style={{ display: "table-cell", verticalAlign: "middle", textAlign: "left" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#c9a35c", letterSpacing: "0.05em", lineHeight: 1.2, fontFamily: "'Oswald', Arial, sans-serif" }}>
            HEALTHY HOMES PUBLIC ADJUSTING
          </div>
          <div style={{ fontSize: 11, color: "#d4af6c", marginTop: 5, lineHeight: 1.3, fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: "italic" }}>
            Public Adjusting &nbsp;·&nbsp; Property Claim Documentation &nbsp;·&nbsp; Roof / Wind / Water Support
          </div>
          <div style={{ fontSize: 11, color: "#fff", marginTop: 5, lineHeight: 1.3, fontFamily: "Georgia, 'Times New Roman', serif" }}>
            Kortni Keckler &nbsp;|&nbsp; Public Adjuster &nbsp;|&nbsp; FL License W435195
          </div>
          <div style={{ fontSize: 11, color: "#fff", marginTop: 2, lineHeight: 1.3, fontFamily: "Georgia, 'Times New Roman', serif" }}>
            Phone: 561-283-5674 &nbsp;|&nbsp; Email: Kkeckleradj@gmail.com
          </div>
        </div>
      </div>
    </div>
  );

  const FooterImg = () => (
    <div style={{
      width: "100%", height: "1.0in", boxSizing: "border-box",
      background: "#0a0a0a", color: "#fff",
      borderTop: "3px solid #c9a35c",
      padding: "0.08in 0.4in 0",
      textAlign: "center",
      fontFamily: "Georgia, 'Times New Roman', serif",
    }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, color: "#c9a35c", textTransform: "uppercase", letterSpacing: "0.08em", lineHeight: 1.2, fontFamily: "'Oswald', Arial, sans-serif" }}>
        Confidential &nbsp;·&nbsp; For Intended Recipient Only
      </div>
      <div style={{ fontSize: 7, color: "#d1d5db", lineHeight: 1.35, marginTop: 3, fontStyle: "italic" }}>
        This document is for claim-documentation and operational coordination purposes only. No coverage determination, engineering opinion, construction guarantee, or legal advice is being provided. All claim decisions remain subject to policy terms, carrier review, applicable Florida law, and licensed public adjuster review.
      </div>
      <div style={{ fontSize: 8, color: "#c9a35c", fontWeight: 700, marginTop: 4, lineHeight: 1.25, fontFamily: "'Oswald', Arial, sans-serif", letterSpacing: "0.04em" }}>
        Kort Co, LLC d/b/a Healthy Homes Public Adjusting
      </div>
      <div style={{ fontSize: 7.5, color: "#c9a35c", fontWeight: 700, marginTop: 1, lineHeight: 1.25, fontFamily: "'Oswald', Arial, sans-serif", letterSpacing: "0.03em" }}>
        FL PA License W435195 &nbsp;|&nbsp; Business License G033912 &nbsp;|&nbsp; PropertyDamageInspection.com &nbsp;|&nbsp; 561-283-5674
      </div>
    </div>
  );

  const TitleBarImg = () => (
    <div
      style={{
        width: "100%",
        display: "block",
        margin: "10px 0 12px",
        background: "#0a0a0a",
        color: "#c9a35c",
        textAlign: "center",
        fontWeight: 700,
        fontSize: 20,
        letterSpacing: 1,
        padding: "11px 16px",
        textTransform: "uppercase",
        fontFamily: "'Oswald', Arial, sans-serif",
        boxSizing: "border-box",
        border: "2px solid #c9a35c",
      }}
    >
      Public Adjuster Contract
    </div>
  );

  const InitialsRow = () => (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 24,
        marginTop: 12,
        paddingTop: 8,
        borderTop: "1px solid #e5e7eb",
        flexWrap: "wrap",
      }}
    >
      {/* PA Initials — Kortni Keckler "KK" in Brush Script */}
      <div style={{ minWidth: 80 }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 2 }}>PA Initials:</div>
        <div
          style={{
            borderBottom: "1px solid #a17e3f",
            height: 26,
            display: "flex",
            alignItems: "flex-end",
            paddingBottom: 2,
          }}
        >
          <span
            style={{
              fontFamily: '"Brush Script MT", cursive',
              fontSize: 20,
              color: "#111827",
              lineHeight: 1,
            }}
          >
            KK
          </span>
        </div>
      </div>

      {/* Homeowner 1 initials */}
      <div style={{ minWidth: 80 }}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 2 }}>
          {data.homeowner1 ? `${data.homeowner1} Initials:` : "Homeowner Initials:"}
        </div>
        <div
          style={{
            borderBottom: "1px solid #000",
            height: 26,
            display: "flex",
            alignItems: "flex-end",
            paddingBottom: 2,
          }}
        >
          {data.initials1 ? (
            <img src={data.initials1} alt="initials 1" style={{ height: 20 }} />
          ) : (
            <span style={{ fontSize: 13, color: "#9ca3af" }}>__</span>
          )}
        </div>
      </div>

      {/* Homeowner 2 initials — only if second homeowner */}
      {hasSecond ? (
        <div style={{ minWidth: 80 }}>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 2 }}>
            {data.homeowner2 ? `${data.homeowner2} Initials:` : "Homeowner 2 Initials:"}
          </div>
          <div
            style={{
              borderBottom: "1px solid #000",
              height: 26,
              display: "flex",
              alignItems: "flex-end",
              paddingBottom: 2,
            }}
          >
            {data.initials2 ? (
              <img src={data.initials2} alt="initials 2" style={{ height: 20 }} />
            ) : (
              <span style={{ fontSize: 13, color: "#9ca3af" }}>__</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );

  const Footer = ({ page }) => (
    <div>
      {isExportingPdf ? (
        <div
          style={{
            textAlign: "center",
            fontSize: 11,
            color: "#6b7280",
            fontStyle: "italic",
            marginBottom: 4,
            lineHeight: 1.2,
            fontFamily: "Georgia, 'Times New Roman', serif",
          }}
        >
          Page {page} of 4
        </div>
      ) : null}
      <FooterImg />
    </div>
  );

  const topGrid = (
    <div
      style={{
        ...bodyText,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        columnGap: 36,
        rowGap: 10,
        marginTop: 10,
        marginBottom: 4,
      }}
    >
      <div>
        <strong>Insured:</strong> {insuredNames}
      </div>
      <div>
        <strong>Loss Description:</strong> {data.lossDescription}
      </div>

      <div>
        <strong>Phone:</strong> {data.phone}
      </div>
      <div>
        <strong>Claim Type:</strong> {data.claimType}
      </div>

      <div>
        <strong>Email:</strong> {data.signerEmail}
      </div>
      <div>
        <strong>Situation:</strong> {data.situation}
      </div>

      <div>
        <strong>Insurer:</strong> {data.insuranceCompany}
      </div>
      <div>
        <strong>Date of Loss:</strong> {data.dateOfLoss}
      </div>

      <div>
        <strong>Policy #:</strong> {data.policyNumber}
      </div>
      <div>
        <strong>Claim #:</strong> {data.claimNumber}
      </div>

      <div style={{ gridColumn: "1 / -1" }}>
        <strong>Address:</strong>{" "}
        {[data.address, data.city, data.state, data.zip]
          .filter(Boolean)
          .join(", ")}
      </div>
    </div>
  );

  return (
    <div id="pac-printable-document" style={{ background: "transparent" }}>
      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={1} />}
      >
        {topGrid}
        <TitleBarImg />

        <div style={bodyText}>
          <p style={{ margin: "0 0 6px" }}>
            1. <span style={sectionHead}>Service Fee:</span>
          </p>
          <p style={{ margin: "0 0 6px" }}>
            The insured(s) hereby retains Healthy Homes Public Adjusting to be its public
            adjuster and hereby appoints Healthy Homes Public Adjusting to be its
            independent appraiser to appraise, advise, negotiate, and/or settle
            the above-referenced claim.
          </p>
          <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            The insured(s) agrees to pay and hereby assigns to Healthy Homes Public Adjusting <strong>10%</strong> of all payments made by the insurance company related to this claim.
          </p>
          <p style={{ margin: "0 0 10px" }}>
            In the event appraisal, mediation is demanded, or a lawsuit ensues regarding the
            above-mentioned claim, there will be an additional charge of five
            percent. The total contractual percentage shall not exceed the
            maximum allowed by law.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            2. <span style={sectionHead}>Additional Payee:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured authorizes and requests the insurer and the insured’s
            mortgage carrier to have Healthy Homes Public Adjusting appear as an
            additional payee on all checks issued regarding the above-mentioned
            claim. The insured hereby grants Healthy Homes Public Adjusting a lien on
            recovered proceeds received by the insurer to the extent of the fee
            due to Healthy Homes Public Adjusting pursuant to this agreement.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            3. <span style={sectionHead}>Third-Party Fees:</span>
          </p>
          <p style={{ margin: 0 }}>
            The insured understands it may be necessary to incur professional
            fees on the insured’s behalf to properly adjust the claim. These
            fees may include, but are not limited to, a General Contractor,
            Engineer, Claim Appraiser, Plumber, Roofer, and Environmental
            Hygienist. The insured understands that no professional fees will be
            incurred without the insured’s written or verbal authorization, and
            that the insured may then be responsible for such fees.
          </p>

          <InitialsRow />
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={2} />}
      >
        <div style={bodyText}>
          <p style={{ margin: "0 0 6px" }}>
            4. <span style={sectionHead}>Endorsement:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured’s endorsement on any insurance proceeds check will be
            deemed to be an agreement with the terms and conditions of any
            related settlement regarding the above-mentioned claim.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            5. <span style={sectionHead}>Affidavit:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            I,{" "}
            <span
              style={{
                display: "inline-block",
                minWidth: 250,
                borderBottom: "1px solid #111827",
                fontWeight: 600,
              }}
            >
              {insuredNames || "____________________________"}
            </span>
            , a named insured under the above-mentioned policy, hereby swear and
            attest that I have the authority to enter into this contract and
            settle all claims issued on behalf of all named insureds. Insured
            acknowledges, understands, and agrees that under section 626.8796,
            Florida Statutes, an agreement with a public adjuster must be signed
            by all named insureds.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            6. <span style={sectionHead}>Legal:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            Healthy Homes Public Adjusting is not a law firm and does not offer legal
            advice, and there will be no attorney-client relationship with the
            insured(s). The insured is hereby advised of the right to counsel
            and may consult with an attorney regarding their claim independently
            of Healthy Homes Public Adjusting.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            7. <span style={sectionHead}>Letter of Protection:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured understands and agrees that if it becomes necessary to
            retain an attorney, the insured authorizes and agrees to a Letter of
            Protection for Healthy Homes Public Adjusting.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            8. <span style={sectionHead}>Representation:</span>
          </p>
          <p style={{ margin: "0 0 10px" }}>
            The insured hereby affirms that no other claim(s) have been filed in
            reference to the same peril and that no other legal representation
            is involved with the claim other than:
          </p>

          <div
            style={{
              borderBottom: "1px solid #111827",
              width: 320,
              marginBottom: 12,
              minHeight: 18,
              fontWeight: 600,
            }}
          >
            Healthy Homes Public Adjusting
          </div>

          <p style={{ margin: "0 0 6px" }}>
            9. <span style={sectionHead}>Severability:</span>
          </p>
          <p style={{ margin: 0 }}>
            Unenforceability or invalidity of one or more clauses in this
            Agreement shall not affect any other clause.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            10. <span style={sectionHead}>Dispute:</span>
          </p>
          <p style={{ margin: "0 0 12px" }}>
            In the event of litigation arising from this agreement, the venue
            shall be in Miami-Dade County, Florida. The prevailing party shall
            be entitled to recover its court costs, reasonable attorney fees,
            including those incurred during any appeal proceedings, and interest
            on any past due fees at the maximum rate permitted by applicable
            law.
          </p>

          <p style={{ margin: "0 0 6px" }}>
            11.{" "}
            <span style={sectionHead}>Commercial Policy Cancellation:</span>
          </p>
          <p style={{ margin: "0 0 12px" }}>
            You, the insured(s), may cancel this contract for any reason without
            penalty or obligation to you within 10 days after the date of this
            contract.
          </p>

          <InitialsRow />
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={3} />}
      >
        <div style={bodyText}>
          <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 18, lineHeight: 1.4 }}>
            12.{" "}
            <span style={{ color: "#199c2e" }}>
              Residential Policy Cancellation:
            </span>
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            You, the insured, may cancel this contract for any reason without
            penalty or obligation to you within 10 days after the date of this
            contract.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            If this contract was entered into based on events that are the
            subject of a declaration of a state of emergency by the Governor,
            you may cancel this contract for any reason without penalty or
            obligation to you within 30 days after the date of loss or 10 days
            after the date on which the contract is executed, whichever is
            longer. You may also cancel this contract without penalty or
            obligation to you if I, as your public adjuster, fail to provide you
            and your insurer a copy of a written estimate within 60 days of the
            execution of the contract, unless the failure to provide the
            estimate within 60 days is caused by factors beyond my control.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            The notice of cancellation shall be provided to Healthy Homes
            Public Adjusting, submitted in writing, and sent by certified mail, return
            receipt requested, or another form of mailing that provides proof
            thereof, at the address specified in the contract.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            Pursuant to s. 817.234, Florida Statutes, any person who, with the
            intent to injure, defraud, or deceive any insurer or insured,
            prepares, presents, or causes to be presented a proof of loss or
            estimate of cost or repair of damaged property in support of a claim
            under an insurance policy, knowing that the proof of loss or
            estimate of claim or repairs contains any false, incomplete, or
            misleading information concerning any fact or thing material to the
            claim, commits a felony of the third degree, punishable as provided
            in s. 775.082, s. 775.803, or s. 775.084, Florida Statutes.
          </p>

          <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 18, lineHeight: 1.5 }}>
            Insured(s) have read, understand and voluntarily sign the foregoing
            Agreement. A computer or faxed signature or copy of this document
            shall be deemed to have the same effect as the original.
          </p>

          <InitialsRow />
        </div>
      </PdfPage>

      <PdfPage
        isExportingPdf={isExportingPdf}
        header={<HeaderImg />}
        contentPadding="0 0.42in 0.12in"
        footer={<Footer page={4} />}
      >
        <div style={bodyText}>

          <div
            style={{
              borderTop: "3px solid #a17e3f",
              marginTop: 18,
              marginBottom: 14,
            }}
          />

          <div
            style={{
              color: "#a17e3f",
              fontWeight: 700,
              fontSize: 14,
              marginBottom: 14,
              letterSpacing: "0.06em",
              fontFamily: "'Oswald', Arial, sans-serif",
            }}
          >
            HEALTHY HOMES PUBLIC ADJUSTING
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: hasSecond ? "1fr 1fr" : "1fr",
              gap: 24,
              alignItems: "start",
            }}
          >
            <div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "70px 1fr",
                  rowGap: 8,
                  columnGap: 8,
                  fontSize: 12,
                }}
              >
                <div>By:</div>
                <div style={{ background: "#faf3e0", padding: "4px 8px" }}>
                  {PA_FIXED.name}
                </div>

                <div>License:</div>
                <div
                  style={{
                    background: "#faf3e0",
                    padding: "4px 8px",
                    fontWeight: 700,
                  }}
                >
                  {PA_FIXED.license}
                </div>

                <div>Signature:</div>
                <div style={{ background: "#faf3e0", padding: "4px 8px" }}>
                  <img
                    src={PA_FIXED.signatureImage}
                    alt="PA signature"
                    style={{ height: 22, objectFit: "contain" }}
                  />
                </div>

                <div>Date:</div>
                <div>{data.date}</div>
              </div>
            </div>

            <div>
              <div style={{ marginBottom: 10, fontSize: 12 }}>
                <div>Insured (Print): {data.homeowner1}</div>
                <div style={{ marginTop: 8, minHeight: 36 }}>
                  {sig1 ? (
                    <img
                      src={sig1}
                      alt="Insured signature 1"
                      style={{ height: 30, objectFit: "contain" }}
                    />
                  ) : null}
                </div>
                <div style={{ fontSize: 12 }}>
                  Signature of the policyholder
                </div>
                <div style={{ marginTop: 8 }}>Date: {data.date}</div>
              </div>

              {hasSecond ? (
                <div style={{ marginTop: 18, fontSize: 12 }}>
                  <div>Insured (Print): {data.homeowner2}</div>
                  <div style={{ marginTop: 8, minHeight: 36 }}>
                    {sig2 ? (
                      <img
                        src={sig2}
                        alt="Insured signature 2"
                        style={{ height: 30, objectFit: "contain" }}
                      />
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12 }}>
                    Signature of the policyholder
                  </div>
                  <div style={{ marginTop: 8 }}>Date: {data.date}</div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </PdfPage>

      <AuditTrailPage
        auditInfo={auditInfo}
        data={data}
        docLabel="PA Authorization"
        claimId={claimId}
        isExportingPdf={isExportingPdf}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// GuidedIntakeFlow — interview-style wrapper around the intake form.
// New reps clicked through one question at a time; veteran reps stick
// with the Quick form. This component reads/writes the same `data`
// state the Quick form uses, so on the final step we can hand off to
// the existing Quick-mode signing pipeline without translating fields.
//
// Steps:
//   0  → New vs Existing customer
//   1  → Which forms today (insp / lor+pa / all three)
//   2  → Sales rep
//   3  → Lead source (new only — existing customers already have one)
//   4  → Homeowner name + phone + email
//   5  → Property address
//   6  → Review and "Continue to Sign"
// ─────────────────────────────────────────────────────────────────────
function GuidedIntakeFlow({
  step, setStep,
  newVsExisting, setNewVsExisting,
  data, setData,
  selectedDocs, setSelectedDocs,
  reps, repSearch, setRepSearch,
  existingInsp, alreadySignedDocs,
  openMyHomeowners, myHomeownersOpen,
  onFinishToSign, onCancel,
}) {
  // Helper to update one or more fields on `data` at once
  const update = (patch) => setData(prev => ({ ...prev, ...patch }));
  // Helper to toggle a doc in/out of the selectedDocs array
  const toggleDoc = (key) => {
    // Temporary block: PA forms disabled until new PA is ready.
    if (PA_FORMS_DISABLED && (key === "lor" || key === "pac")) return;
    setSelectedDocs(prev => {
      const has = prev.includes(key);
      return has ? prev.filter(d => d !== key) : [...prev, key];
    });
  };

  // When the rep is on the New/Existing step and they picked an existing
  // homeowner via the My Homeowners modal, auto-advance to the existing-
  // customer summary step. We watch `existingInsp` because it gets set
  // by the modal's "Add Docs" handler (along with all the other prefill
  // state we depend on). The modal closes itself when picked, so this is
  // the cleanest signal that selection happened.
  useEffect(() => {
    if (newVsExisting === "existing" && existingInsp && step !== 6) {
      // Skip past New-customer-only steps (1 forms, 2 rep, 3 lead source,
      // 4 homeowner, 5 address) and land on the new "existing summary"
      // step which we anchor at index 6. Review remains the last step.
      setStep(6);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingInsp, newVsExisting]);

  // For the Existing-customer path: if the rep arrived at the Sales Rep
  // step because they didn't have a rep set when clicking Existing, open
  // the My Homeowners modal automatically once they pick one. The modal
  // filters by rep, so it can't be opened until rep is known.
  useEffect(() => {
    if (
      newVsExisting === "existing" &&
      step === 2 &&
      (data.salesRepName || data.salesRepId) &&
      !existingInsp &&
      !myHomeownersOpen
    ) {
      openMyHomeowners();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.salesRepName, data.salesRepId, step, newVsExisting]);

  // Determine which step indices count for the progress dots. We always
  // show 7 logical steps even though some may be auto-filled depending
  // on the New vs Existing branch.
  const TOTAL_STEPS = 7;

  const next = () => setStep(s => {
    // Existing path on step 0 jumps to the rep selection (step 2). The
    // forms step (1) doesn't apply because the My Homeowners modal sets
    // selectedDocs to whichever forms are still unsigned for that customer.
    if (s === 0 && newVsExisting === "existing" && !existingInsp) return 2;
    return Math.min(s + 1, TOTAL_STEPS - 1);
  });
  // Back skips the New-customer steps when we're on the Existing path.
  // The Existing flow only ever sees steps 0 and 6, so back from 6 should
  // go straight to 0 — going to 5 would land the rep on an empty address
  // form they have no business filling out.
  const back = () => setStep(s => {
    if (newVsExisting === "existing" && existingInsp && s === 6) return 0;
    return Math.max(s - 1, 0);
  });

  // ── Validation gate per step — returns null when the step is good
  //    to advance, or a user-facing message string when it's not.
  const stepError = () => {
    if (step === 0) {
      if (!newVsExisting) return "Pick New or Existing to continue.";
      if (newVsExisting === "existing" && !existingInsp && (data.salesRepName || data.salesRepId)) {
        // Rep is set, so they should have picked a homeowner from the modal
        return "Pick a homeowner from the My Homeowners list to continue.";
      }
      // Otherwise (rep not set yet) Next routes them through the rep step
      return null;
    }
    if (step === 1) {
      // Need at least one doc box checked
      const anyDoc = (selectedDocs || []).length > 0;
      return anyDoc ? null : "Pick at least one form.";
    }
    if (step === 2) return data.salesRepName ? null : "Choose a sales rep.";
    if (step === 3) return data.leadSource ? null : "Pick a lead source.";
    if (step === 4) {
      if (!data.homeowner1) return "Homeowner name is required.";
      if (!data.phone) return "Phone is required.";
      if (data.signerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.signerEmail)) {
        return "That doesn't look like a valid email.";
      }
      return null;
    }
    if (step === 5) {
      if (!data.address) return "Property address is required.";
      return null;
    }
    return null;
  };

  // Common style helpers — kept inline so this component is self-contained.
  // Color palette pulled from the rest of the app's USS branding:
  //   Navy  #0a0a0a — primary
  //   Red   #c9a35c — accent / active CTA
  //   Green #16a34a — success / "Selected" badges
  const stepCard = {
    background: "linear-gradient(180deg, #f8fafc 0%, #ffffff 60%)",
    border: "1px solid #c8d4e8",
    borderRadius: 16,
    padding: 0,
    boxShadow: "0 4px 16px rgba(26, 46, 90, 0.08)",
    overflow: "hidden",
  };
  const bigChoice = (active) => ({
    width: "100%", padding: "20px 22px", borderRadius: 14,
    border: active ? "3px solid #0a0a0a" : "2px solid #d1d5db",
    background: active
      ? "linear-gradient(135deg, #0a0a0a 0%, #1f1f1f 100%)"
      : "#fff",
    color: active ? "#fff" : "#111827",
    cursor: "pointer", textAlign: "left", fontFamily: "'Nunito', sans-serif",
    transition: "all 0.15s",
    boxShadow: active ? "0 6px 20px rgba(26, 46, 90, 0.25)" : "0 1px 3px rgba(0,0,0,0.05)",
    position: "relative",
    overflow: "hidden",
  });
  const bigChoiceTitle = { fontSize: 17, fontWeight: 700, marginBottom: 4 };
  const bigChoiceSub = { fontSize: 13, opacity: 0.85 };
  const navBtn = (primary, disabled) => ({
    padding: "12px 26px", borderRadius: 12, border: "none",
    background: disabled
      ? "#cbd5e1"
      : (primary
          ? "linear-gradient(135deg, #c9a35c 0%, #a17e3f 100%)"
          : "transparent"),
    color: primary ? "#fff" : "#0a0a0a",
    fontFamily: "'Oswald', sans-serif", fontSize: 14, fontWeight: 700,
    letterSpacing: "0.06em", textTransform: "uppercase",
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: primary && !disabled ? "0 4px 12px rgba(200, 57, 43, 0.3)" : "none",
    transition: "all 0.15s",
  });

  // ── Step content ─────────────────────────────────────────────
  let title = "";
  let subtitle = "";
  let body = null;

  if (step === 0) {
    title = "Has this homeowner signed anything with us before?";
    subtitle = "If they've signed forms with our app already, pick Existing. Otherwise pick New.";
    body = (
      <div style={{ display: "grid", gap: 14 }}>
        <button type="button"
          style={bigChoice(newVsExisting === "new")}
          onClick={() => setNewVsExisting("new")}>
          <div style={bigChoiceTitle}>🆕 New Customer</div>
          <div style={bigChoiceSub}>First time signing anything with us. We'll collect their info.</div>
        </button>
        <button type="button"
          style={bigChoice(newVsExisting === "existing")}
          onClick={() => {
            // Existing customer flow piggybacks on the My Homeowners modal
            // that Quick mode already uses — that modal handles search,
            // selection, prefilling all the homeowner data, locking already-
            // signed forms, and setting the right currentClaimId so the
            // submit UPDATEs the existing record instead of creating a dupe.
            //
            // BUT — the My Homeowners modal filters by the current rep's
            // sales_rep_id/sales_rep_name. If we don't know who the rep is,
            // the list is empty. So when rep isn't set, route through the
            // rep-selection step first; the useEffect below will reopen the
            // modal once the rep gets picked.
            setNewVsExisting("existing");
            if (data.salesRepName || data.salesRepId) {
              openMyHomeowners();
            } else {
              // Jump to the rep step (index 2). The auto-open useEffect
              // catches the rep being set and opens the modal then.
              setStep(2);
            }
          }}>
          <div style={bigChoiceTitle}>↩️ Existing Customer</div>
          <div style={bigChoiceSub}>They've signed before — we'll look them up and add new forms.</div>
        </button>
        {newVsExisting === "existing" && !existingInsp ? (
          <div style={{ marginTop: 4, padding: "12px 16px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, fontSize: 13, color: "#1e40af", fontFamily: "'Nunito', sans-serif" }}>
            {data.salesRepName || data.salesRepId ? (
              <>
                👉 Pick the homeowner from the My Homeowners list that just opened. Once you click <strong>Add Docs</strong>, we'll skip ahead to review.
                <button type="button" onClick={openMyHomeowners}
                  style={{ marginLeft: 10, padding: "4px 10px", borderRadius: 8, border: "1px solid #1e40af", background: "#fff", color: "#1e40af", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Open List
                </button>
              </>
            ) : (
              <>👉 First we need to know who the sales rep is — we'll look up customers under that rep's name. Click <strong>Next</strong>.</>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  if (step === 1) {
    title = "Which forms is the homeowner signing today?";
    subtitle = "You can pick more than one if multiple forms are being signed at the same visit.";
    const opt = (key, emoji, label, sub) => {
      const active = (selectedDocs || []).includes(key);
      const blocked = PA_FORMS_DISABLED && (key === "lor" || key === "pac");
      // Make the selected state unmistakable: thick green border, light green
      // background, drop shadow, and an explicit "SELECTED" pill in the corner.
      // Unselected stays calm/neutral so the active one stands out by contrast.
      const cardStyle = blocked
        ? {
            width: "100%", padding: "20px 22px", borderRadius: 14,
            border: "2px dashed #d1d5db",
            background: "#f3f4f6",
            cursor: "not-allowed", textAlign: "left", fontFamily: "'Nunito', sans-serif",
            opacity: 0.55,
            transition: "all 0.15s",
            position: "relative",
            filter: "grayscale(0.8)",
          }
        : active
        ? {
            width: "100%", padding: "20px 22px", borderRadius: 14,
            border: "3px solid #16a34a",
            background: "#f0fdf4",
            cursor: "pointer", textAlign: "left", fontFamily: "'Nunito', sans-serif",
            boxShadow: "0 4px 12px rgba(22, 163, 74, 0.18)",
            transition: "all 0.15s",
            position: "relative",
          }
        : {
            width: "100%", padding: "20px 22px", borderRadius: 14,
            border: "2px solid #e5e7eb",
            background: "#fff",
            cursor: "pointer", textAlign: "left", fontFamily: "'Nunito', sans-serif",
            opacity: 0.85,
            transition: "all 0.15s",
            position: "relative",
          };
      const checkBox = active
        ? { width: 32, height: 32, borderRadius: 8, background: "#16a34a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, fontWeight: 800 }
        : { width: 32, height: 32, borderRadius: 8, background: "#fff", border: "2px solid #d1d5db", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
      return (
        <button type="button" style={cardStyle} onClick={() => toggleDoc(key)} disabled={blocked} title={blocked ? "Temporarily disabled — new PA setup in progress" : undefined}>
          {blocked ? (
            <span style={{
              position: "absolute", top: 10, right: 12,
              padding: "2px 8px", borderRadius: 6,
              background: "#d97706", color: "#fff",
              fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
              fontFamily: "'Oswald', sans-serif",
            }}>⛔ DISABLED</span>
          ) : active ? (
            <span style={{
              position: "absolute", top: 10, right: 12,
              padding: "2px 8px", borderRadius: 6,
              background: "#16a34a", color: "#fff",
              fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
              fontFamily: "'Oswald', sans-serif",
            }}>✓ SELECTED</span>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={checkBox}>{active ? "✓" : ""}</div>
            <div style={{ flex: 1 }}>
              <div style={{ ...bigChoiceTitle, color: active ? "#15803d" : "#111827" }}>{emoji} {label}</div>
              <div style={{ ...bigChoiceSub, color: "#6b7280" }}>{blocked ? "Temporarily disabled — only inspection agreements can be signed right now." : sub}</div>
            </div>
          </div>
        </button>
      );
    };
    body = (
      <div style={{ display: "grid", gap: 12 }}>
        {/* PA forms (LoR + PAC) are completely hidden when PA workflow
            is off — see Manager → PA Management. Reps see only the
            inspection agreement option, no banner, no "disabled" badges. */}
        {opt("insp", "🔍", "Free Roof Inspection Agreement", "First-visit inspection signoff")}
        {!PA_FORMS_DISABLED && opt("lor",  "📝", "Letter of Representation", "Authorizes us to talk to insurance")}
        {!PA_FORMS_DISABLED && opt("pac",  "📜", "Public Adjuster Contract", "Storm damage confirmed — claim paperwork")}
        {!PA_FORMS_DISABLED && (
          <div style={{ marginTop: 8, padding: "10px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, fontSize: 12, color: "#92400e" }}>
            💡 Common combos: <strong>Inspection only</strong> on first visit. <strong>LOR + PA</strong> on second visit when damage is confirmed. <strong>All three</strong> when everything happens at once.
          </div>
        )}
      </div>
    );
  }

  if (step === 2) {
    title = "Who's the sales rep?";
    // Subtitle is intentionally short — the prominent prompt below the
    // search field is what we want the rep to read.
    subtitle = "";
    const trimmedSearch = (repSearch || "").trim();
    const filtered = trimmedSearch
      ? (reps || []).filter(m => m.name.toLowerCase().includes(trimmedSearch.toLowerCase()))
      : [];
    body = (
      <div style={{ display: "grid", gap: 14 }}>
        {/* Big in-your-face prompt — USS red palette, large type, can't
            be skimmed past. New reps tend to glance at the screen and
            type a customer name; this stops them cold. */}
        <div style={{
          padding: "24px 28px",
          background: "linear-gradient(135deg, #c9a35c 0%, #a17e3f 100%)",
          borderRadius: 14,
          fontFamily: "'Oswald', sans-serif",
          color: "#fff",
          textAlign: "center",
          boxShadow: "0 6px 20px rgba(200, 57, 43, 0.35)",
          border: "3px solid #fff",
          outline: "3px solid #c9a35c",
        }}>
          <div style={{
            fontSize: 28, fontWeight: 800,
            letterSpacing: "0.04em", textTransform: "uppercase",
            marginBottom: 8, lineHeight: 1.15,
          }}>
            👇 Pick YOUR name
          </div>
          <div style={{
            fontSize: 16, fontWeight: 600, lineHeight: 1.4,
            fontFamily: "'Nunito', sans-serif",
            opacity: 0.95,
          }}>
            Search by typing <strong>YOUR</strong> name below — not the customer's.
          </div>
        </div>

        <input
          type="text"
          placeholder="🔍 Type rep's name..."
          value={repSearch || ""}
          onChange={(e) => setRepSearch(e.target.value)}
          autoFocus
          style={{
            width: "100%", height: 48, borderRadius: 12,
            border: "2px solid #0a0a0a",
            padding: "0 16px", fontSize: 15,
            fontFamily: "'Nunito', sans-serif",
            boxSizing: "border-box",
            outline: "none",
          }}
        />

        {/* Result list — only renders after rep types something. Avoids
            the overwhelming wall-of-200-reps that was here before. */}
        {trimmedSearch ? (
          <div style={{ display: "grid", gap: 8, maxHeight: 360, overflowY: "auto" }}>
            {filtered.map(m => {
              const active = data.salesRepName === m.name;
              return (
                <button key={m.jobnimbus_id || m.name} type="button"
                  style={{
                    ...bigChoice(active),
                    padding: "14px 18px",
                    minHeight: "auto",
                  }}
                  onClick={() => update({
                    salesRepName: m.name,
                    salesRepEmail: m.email || "",
                    salesRepId: m.jobnimbus_id || "",
                  })}>
                  <div style={{
                    fontSize: 15, fontWeight: 700,
                    lineHeight: 1.3, marginBottom: m.email ? 3 : 0,
                    whiteSpace: "normal",
                  }}>
                    {m.name}
                  </div>
                  {m.email ? (
                    <div style={{
                      fontSize: 12, opacity: 0.85,
                      lineHeight: 1.3, whiteSpace: "normal",
                      wordBreak: "break-all",
                    }}>
                      {m.email}
                    </div>
                  ) : null}
                </button>
              );
            })}
            {filtered.length === 0 ? (
              <div style={{ padding: 18, color: "#9ca3af", fontSize: 13, textAlign: "center", fontFamily: "'Nunito', sans-serif" }}>
                No reps match "{trimmedSearch}". Try a shorter search.
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{
            padding: "20px 16px",
            color: "#9ca3af",
            fontSize: 13,
            textAlign: "center",
            fontFamily: "'Nunito', sans-serif",
            fontStyle: "italic",
          }}>
            👆 Type a name above to see matching reps.
          </div>
        )}
      </div>
    );
  }

  if (step === 3) {
    title = "How did they come to us?";
    subtitle = "This is the lead source — where the customer originated.";
    const sources = [
      { code: "Inspection", label: "Inspection", desc: "Free roof inspection lead (default)" },
      { code: "INS",        label: "INS",        desc: "Insurance lead" },
      { code: "Door Knock", label: "Door Knock", desc: "Walked the neighborhood" },
      { code: "Referral",   label: "Referral",   desc: "Referred by another customer" },
    ];
    body = (
      <div style={{ display: "grid", gap: 10 }}>
        {sources.map(s => (
          <button key={s.code} type="button"
            style={{ ...bigChoice(data.leadSource === s.code), padding: "14px 16px" }}
            onClick={() => update({ leadSource: s.code })}>
            <div style={{ ...bigChoiceTitle, fontSize: 15 }}>{s.label}</div>
            <div style={bigChoiceSub}>{s.desc}</div>
          </button>
        ))}
      </div>
    );
  }

  if (step === 4) {
    title = "Who's the homeowner?";
    subtitle = "Their name, phone, and email — for signing notifications and welcome emails.";
    const fld = { width: "100%", height: 44, borderRadius: 12, border: "1px solid #d1d5db", padding: "0 14px", fontSize: 14, fontFamily: "'Nunito', sans-serif", boxSizing: "border-box" };
    body = (
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <Label>Homeowner 1 *</Label>
          <input type="text" style={fld} placeholder="Jane Doe"
            value={data.homeowner1 || ""}
            onChange={(e) => update({ homeowner1: e.target.value })}
            autoCapitalize="words" />
        </div>
        <div>
          <Label>Homeowner 2 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(optional — co-signer)</span></Label>
          <input type="text" style={fld} placeholder="John Doe"
            value={data.homeowner2 || ""}
            onChange={(e) => update({ homeowner2: e.target.value })}
            autoCapitalize="words" />
        </div>
        <div>
          <Label>Phone *</Label>
          <input type="tel" style={fld} placeholder="555-555-5555"
            value={data.phone || ""}
            onChange={(e) => update({ phone: e.target.value })} />
        </div>
        <div>
          <Label>Email <span style={{ color: "#9ca3af", fontWeight: 400 }}>(optional but recommended)</span></Label>
          <input type="email" style={fld} placeholder="jane@example.com"
            value={data.signerEmail || ""}
            onChange={(e) => update({ signerEmail: e.target.value })}
            autoCapitalize="off" autoCorrect="off" />
        </div>
      </div>
    );
  }

  if (step === 5) {
    title = "What's the property address?";
    subtitle = "Where is the home being inspected?";
    const fld = { width: "100%", height: 44, borderRadius: 12, border: "1px solid #d1d5db", padding: "0 14px", fontSize: 14, fontFamily: "'Nunito', sans-serif", boxSizing: "border-box" };
    body = (
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <Label>Property Address *</Label>
          {/* AddressAutocomplete = Google Places typeahead. Same component
              the Quick form uses. Picking a suggestion fires onPlaceSelected
              and atomically fills address + city + state + zip — no chance
              to mistype the city / mismatch the state / miss the zip. */}
          <AddressAutocomplete
            value={data.address || ""}
            onChange={(v) => update({ address: v })}
            onPlaceSelected={({ address, city, state, zip }) => {
              update({
                address,
                city,
                state: normalizeStateValue(state),
                zip,
              });
            }}
            placeholder="Start typing the property address..."
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
          <div>
            <Label>City</Label>
            <input type="text" style={fld} placeholder="Sarasota"
              value={data.city || ""}
              onChange={(e) => update({ city: e.target.value })}
              autoCapitalize="words" />
          </div>
          {/* State = dropdown so we never get fl / FL / Florida mismatches
              from free typing. Mirrors the Quick form. */}
          <div>
            <Label>State</Label>
            <select
              value={normalizeStateValue(data.state) || ""}
              onChange={(e) => update({ state: e.target.value })}
              style={{ ...fld, background: "#fff" }}
            >
              <option value="">— Select —</option>
              {US_STATES.map(([code, name]) => (
                <option key={code} value={code}>{code} — {name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>ZIP</Label>
            <input type="text" style={fld} placeholder="34239"
              value={data.zip || ""}
              onChange={(e) => update({ zip: e.target.value })} />
          </div>
        </div>
      </div>
    );
  }

  if (step === 6) {
    const isExisting = newVsExisting === "existing" && existingInsp;
    title = isExisting ? "Returning customer — ready to sign?" : "Ready to sign?";
    // For Existing path the subtitle is replaced with a big red callout
    // inside the body (same pattern as Pick Yourself / Pick the Homeowner).
    // For New path we keep the small subtitle.
    subtitle = isExisting
      ? ""
      : "Review everything below. Tap any field to jump back and fix it.";
    const row = (label, value, gotoStep) => (
      <button type="button" onClick={() => gotoStep != null && setStep(gotoStep)}
        style={{
          width: "100%", textAlign: "left", padding: "12px 16px",
          background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10,
          cursor: gotoStep != null ? "pointer" : "default", fontFamily: "'Nunito', sans-serif",
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
        }}>
        <div>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>{label}</div>
          <div style={{ fontSize: 14, color: "#111827", marginTop: 2, fontWeight: 600 }}>{value || "—"}</div>
        </div>
        {gotoStep != null ? <div style={{ fontSize: 11, color: "#0a0a0a", fontWeight: 700 }}>EDIT</div> : null}
      </button>
    );
    const docsList = (selectedDocs || []).map(d => {
      if (d === "insp") return "Inspection";
      if (d === "lor") return "LOR";
      if (d === "pac") return "PA";
      return d;
    }).join(", ");

    if (isExisting) {
      // Existing-customer path — homeowner data already populated by the
      // My Homeowners modal, alreadySignedDocs lists what's on file. We
      // show the homeowner read-only and call out what's done vs what's
      // being signed today, so the rep can sanity-check before continuing.
      const docPill = (key, label) => {
        const already = (alreadySignedDocs || []).includes(key);
        const today = !already && (selectedDocs || []).includes(key);
        const bg = already ? "#dcfce7" : today ? "#dbeafe" : "#f3f4f6";
        const color = already ? "#15803d" : today ? "#1e40af" : "#9ca3af";
        const icon = already ? "✓" : today ? "✎" : "○";
        const status = already ? "ALREADY SIGNED" : today ? "SIGNING TODAY" : "—";
        return (
          <div style={{ padding: "12px 14px", background: bg, borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color, width: 22, textAlign: "center" }}>{icon}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{label}</div>
              <div style={{ fontSize: 11, color, fontWeight: 700, letterSpacing: "0.05em", fontFamily: "'Oswald', sans-serif" }}>{status}</div>
            </div>
          </div>
        );
      };
      body = (
        <div style={{ display: "grid", gap: 10 }}>
          {/* Big red callout — same pattern as Pick Yourself / Pick the
              Homeowner so the Existing flow has consistent visual language. */}
          <div style={{
            padding: "24px 28px",
            background: "linear-gradient(135deg, #c9a35c 0%, #a17e3f 100%)",
            borderRadius: 14,
            fontFamily: "'Oswald', sans-serif",
            color: "#fff",
            textAlign: "center",
            boxShadow: "0 6px 20px rgba(200, 57, 43, 0.35)",
            border: "3px solid #fff",
            outline: "3px solid #c9a35c",
            marginBottom: 8,
          }}>
            <div style={{
              fontSize: 28, fontWeight: 800,
              letterSpacing: "0.04em", textTransform: "uppercase",
              marginBottom: 8, lineHeight: 1.15,
            }}>
              ✓ Returning Customer
            </div>
            <div style={{
              fontSize: 16, fontWeight: 600, lineHeight: 1.4,
              fontFamily: "'Nunito', sans-serif",
              opacity: 0.95,
            }}>
              We found this homeowner on file. Review what's already done and the forms we'll sign today.
            </div>
          </div>
          {row("Homeowner", [data.homeowner1, data.homeowner2].filter(Boolean).join(" & "), null)}
          {row("Address", [data.address, data.city, data.state, data.zip].filter(Boolean).join(", "), null)}
          {row("Sales rep", data.salesRepName, null)}
          <div style={{ marginTop: 4, padding: "14px 16px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, marginBottom: 10 }}>Forms</div>
            <div style={{ display: "grid", gap: 8 }}>
              {docPill("insp", "Free Roof Inspection")}
              {docPill("lor",  "Letter of Representation")}
              {docPill("pac",  "PA Authorization")}
            </div>
          </div>
          <div style={{
            marginTop: 12, padding: "20px 24px",
            background: "linear-gradient(135deg, #c9a35c 0%, #a17e3f 100%)",
            borderRadius: 14,
            border: "3px solid #fff",
            outline: "3px solid #c9a35c",
            boxShadow: "0 6px 20px rgba(200, 57, 43, 0.35)",
            color: "#fff",
            textAlign: "center",
            fontFamily: "'Oswald', sans-serif",
          }}>
            <div style={{
              fontSize: 22, fontWeight: 800,
              letterSpacing: "0.04em", textTransform: "uppercase",
              marginBottom: 6, lineHeight: 1.2,
            }}>
              👇 Tap Continue to Sign
            </div>
            <div style={{
              fontSize: 14, fontWeight: 600, lineHeight: 1.4,
              fontFamily: "'Nunito', sans-serif",
              opacity: 0.95,
            }}>
              Sign the highlighted forms with this customer.
            </div>
          </div>
        </div>
      );
    } else {
      // New-customer path — full review with all collected fields
      body = (
        <div style={{ display: "grid", gap: 10 }}>
          {row("Customer type", "New", 0)}
          {row("Forms today", docsList, 1)}
          {row("Sales rep", data.salesRepName, 2)}
          {row("Lead source", data.leadSource, 3)}
          {row("Homeowner", [data.homeowner1, data.homeowner2].filter(Boolean).join(" & "), 4)}
          {row("Phone", data.phone, 4)}
          {row("Email", data.signerEmail, 4)}
          {row("Address", [data.address, data.city, data.state, data.zip].filter(Boolean).join(", "), 5)}
          <div style={{ marginTop: 12, padding: "12px 16px", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, fontSize: 13, color: "#065f46" }}>
            ✅ Looks good? Hit <strong>Continue to Sign</strong> below — that'll take you to the signing screen with all this info pre-filled.
          </div>
        </div>
      );
    }
  }

  // ── Render frame ─────────────────────────────────────────────
  const err = stepError();
  const onLastStep = step === TOTAL_STEPS - 1;

  return (
    <div style={stepCard}>
      {/* Navy banner header — progress dots + step counter + title.
          Mirrors the certificate-template aesthetic the rest of the app
          uses so Guided feels like part of the family rather than bolted
          on. The thin red rule under the banner is the USS accent. */}
      <div style={{
        background: "linear-gradient(135deg, #0a0a0a 0%, #1f1f1f 100%)",
        padding: "20px 28px 22px",
        position: "relative",
      }}>
        {/* Progress dots */}
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 14 }}>
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div key={i} style={{
              width: i === step ? 28 : 8, height: 8, borderRadius: 4,
              background: i < step ? "#c9a35c" : i === step ? "#fff" : "rgba(255,255,255,0.3)",
              transition: "all 0.2s",
            }} />
          ))}
        </div>
        <div style={{
          textAlign: "center", fontSize: 11,
          color: "rgba(255,255,255,0.7)",
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: "0.12em", textTransform: "uppercase",
          marginBottom: 6,
        }}>
          Step {step + 1} of {TOTAL_STEPS}
        </div>
        <div style={{
          textAlign: "center",
          fontSize: 22, fontWeight: 700, color: "#fff",
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: "0.02em",
          lineHeight: 1.25,
        }}>
          {title}
        </div>
      </div>

      {/* Red accent rule */}
      <div style={{ height: 4, background: "#c9a35c" }} />

      {/* Content area */}
      <div style={{ padding: "24px 28px 28px" }}>
        {subtitle ? (
          <div style={{
            fontSize: 14, color: "#475569",
            marginBottom: 22, fontFamily: "'Nunito', sans-serif",
            textAlign: "center",
          }}>
            {subtitle}
          </div>
        ) : null}

        <div>{body}</div>

        {err ? (
          <div style={{
            marginTop: 18, padding: "12px 16px",
            background: "#fef2f2", border: "1px solid #fecaca",
            borderRadius: 10, fontSize: 13, color: "#991b1b",
            fontFamily: "'Nunito', sans-serif", fontWeight: 600,
          }}>
            ⚠️ {err}
          </div>
        ) : null}

        {/* Navigation — Back, Cancel, Next/Finish */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 28, gap: 10, flexWrap: "wrap",
          paddingTop: 22, borderTop: "1px solid #e5e7eb",
        }}>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 ? (
              <button type="button" style={navBtn(false, false)} onClick={back}>
                ← Back
              </button>
            ) : null}
            <button type="button" style={{ ...navBtn(false, false), color: "#94a3b8" }} onClick={onCancel}>
              Cancel
            </button>
          </div>
          {!onLastStep ? (
            <button type="button" style={navBtn(true, !!err)} disabled={!!err} onClick={() => { if (!err) next(); }}>
              Next →
            </button>
          ) : (
            <button type="button"
              disabled={!!err}
              onClick={() => { if (!err) onFinishToSign(); }}
              style={{
                ...navBtn(true, !!err),
                padding: "16px 36px",
                fontSize: 17,
                letterSpacing: "0.08em",
                boxShadow: !err ? "0 8px 24px rgba(200, 57, 43, 0.4), 0 0 0 4px rgba(200, 57, 43, 0.15)" : "none",
                transform: !err ? "scale(1.02)" : "none",
              }}>
              ✓ Continue to Sign
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // Early-return URL param routing for one-off public pages — these
  // don't share state with the rest of the App, so we short-circuit
  // BEFORE all the heavy claim-intake state initializes.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const inspectorSetupToken = params.get("inspector_setup");
    if (inspectorSetupToken) {
      return (
        <InspectorSetupPage
          token={inspectorSetupToken}
          onDone={() => {
            window.location.href = window.location.origin + "/";
          }}
        />
      );
    }
  }

  // ?mode=inspector lands the inspector straight in the mobile app
  // (skipping the rep-facing homepage). Used by the SMS/email invite
  // we text the inspector when the manager activates them.
  const [view, setView] = useState(() => {
    if (typeof window === "undefined") return "input";
    const mode = new URLSearchParams(window.location.search).get("mode");
    return mode === "inspector" ? "inspector" : "input";
  });
  // ── Guided intake mode ──────────────────────────────────────────
  // When true, the intake screen replaces the all-at-once form with a
  // step-by-step interview flow for new reps. Quick mode (the original
  // form) is the default; reps opt into Guided via a toggle.
  // intakeMode: "quick" | "guided"
  // guidedStep: 0..N — index into the GUIDED_STEPS array below
  // guidedNewVsExisting: "new" | "existing" | null — answer to step 1
  const [intakeMode, setIntakeMode] = useState("quick");
  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedNewVsExisting, setGuidedNewVsExisting] = useState(null);
  const [selectedDocs, setSelectedDocs] = useState(
    PA_FORMS_DISABLED ? ["insp"] : ["insp", "lor", "pac"]
  );

  // "Understanding the App" — rep-facing help modal with the inspection
  // → result → swing-by → PA-handoff flow.
  const [showRepHelp, setShowRepHelp] = useState(false);

  // Safety net for PA_FORMS_DISABLED: even if some other code path
  // (signing link, My Homeowners "Add Docs", reset button, etc.) puts
  // lor/pac into selectedDocs, strip them out so the rep never reaches
  // the review/sign step with PA forms still in the list. Without this,
  // a rep can land in the flow with lor/pac pre-selected and no way to
  // un-toggle them (since the toggle buttons are disabled).
  useEffect(() => {
    if (!PA_FORMS_DISABLED) return;
    if (selectedDocs.some(d => d === "lor" || d === "pac")) {
      setSelectedDocs(prev => {
        const filtered = prev.filter(d => d !== "lor" && d !== "pac");
        return filtered.length ? filtered : ["insp"];
      });
    }
  }, [selectedDocs]);

  // ── My Homeowners (existing-homeowner add-on signing) ──────────────
  // When set, we're signing additional docs for an existing homeowner.
  // alreadySignedDocs is a set of doc keys ("insp","lor","pac") already
  // on file. The doc selector disables those checkboxes and shows
  // "✓ Already signed" badges. existingClaim/existingInsp hold the source
  // records so we can update them in place rather than creating duplicates.
  const [existingClaim, setExistingClaim] = useState(null);
  const [existingInsp, setExistingInsp] = useState(null);
  const [alreadySignedDocs, setAlreadySignedDocs] = useState([]);
  // My Homeowners modal
  const [myHomeownersOpen, setMyHomeownersOpen] = useState(false);
  const [myHomeownersList, setMyHomeownersList] = useState([]);
  const [myHomeownersLoading, setMyHomeownersLoading] = useState(false);
  const [myHomeownersSearch, setMyHomeownersSearch] = useState("");
  // When true, the modal filters to rows where signed_at IS NULL (the homeowner
  // got a link but never finished signing). Set by the "Awaiting Signature"
  // button on the input screen so reps can quickly resend pending links.
  const [myHomeownersPendingOnly, setMyHomeownersPendingOnly] = useState(false);
  // Count of pending homeowners for the current rep — drives the badge on the
  // Awaiting Signature button. Refreshed whenever the modal data loads.
  const [pendingHomeownersCount, setPendingHomeownersCount] = useState(0);
  // Tracks which pending row is currently being resent (for spinner / disabled state)
  const [resendingHomeownerKey, setResendingHomeownerKey] = useState(null);

  // ── My Stats modal ──────────────────────────────────────────────────
  // Shows the rep's own performance for this/last week + their leaderboard rank.
  // The summary banner uses the same data computed for "this week".
  const [myStatsOpen, setMyStatsOpen] = useState(false);
  const [myStatsLoading, setMyStatsLoading] = useState(false);
  const [myStatsData, setMyStatsData] = useState(null); // { thisWeek, lastWeek, leaderboard }
  const [myStatsRange, setMyStatsRange] = useState("thisWeek"); // "thisWeek" | "lastWeek"
  const [bannerStats, setBannerStats] = useState(null); // small banner that always shows once loaded
  // Drilldown — when a stat tile is clicked, show the homeowners contributing to that stat
  // null | "damage" | "no_damage" | "retail" | "pending"
  const [myStatsDrilldown, setMyStatsDrilldown] = useState(null);
  const [signMode, setSignMode] = useState("now");
  const [data, setData] = useState(initialData);
  const [pendingSend, setPendingSend] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [testOverrideEmail, setTestOverrideEmail] = useState("");
  const [testOverridePhone, setTestOverridePhone] = useState("");

  // ── Inspection form state ──
  const initialInspData = {
    date: new Date().toISOString().split("T")[0],
    clientName: "",
    mobile: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    email: "",
  };
  const [inspData, setInspData] = useState(initialInspData);
  const [inspSig, setInspSig] = useState("");
  const [inspSigMethod, setInspSigMethod] = useState("draw");
  const [inspTypedSig, setInspTypedSig] = useState("");
  const [inspSigFont, setInspSigFont] = useState(SIGNATURE_FONTS[0]);
  const [inspSubmitting, setInspSubmitting] = useState(false);
  // Synchronous re-entrancy guard. State updates from setInspSubmitting
  // don't apply until the next render, so a fast double-tap can fire
  // submitInspection twice before the button visually disables. The
  // useRef flips immediately so the second invocation early-returns.
  // (Goldstein triple-submit on 2026-05-20 — 3 inserts in 37ms.)
  const inspSubmittingRef = useRef(false);
  const [inspectionOnly, setInspectionOnly] = useState(false);
  const [duplicateRecord, setDuplicateRecord] = useState(null);
  const [inspSubmitAttempted, setInspSubmitAttempted] = useState(false);

 const updateInsp = (key, val) => setInspData(prev => ({ ...prev, [key]: val }));

  // ── Record Lookup & Inspection Result state ──
  const [recordSearch, setRecordSearch] = useState("");
  const [recordSearchResults, setRecordSearchResults] = useState([]);
  const [recordSearchLoading, setRecordSearchLoading] = useState(false);
  const [selectedInspRecord, setSelectedInspRecord] = useState(null);
  const [resultChoice, setResultChoice] = useState("");
  const [resultInspectorName, setResultInspectorName] = useState("");
  const [resultSubmitting, setResultSubmitting] = useState(false);
  const [resultCertDate, setResultCertDate] = useState(new Date().toISOString().split("T")[0]);
  const [resultDone, setResultDone] = useState(false);
  const [resultCertNumber, setResultCertNumber] = useState(() => {
    const d = new Date(); const m = String(d.getMonth()+1).padStart(2,"0"); const dy = String(d.getDate()).padStart(2,"0");
    return `RC-${d.getFullYear()}-${m}${dy}-${Math.floor(Math.random()*9000)+1000}`;
  });

  // ── Check Now + per-row admin override + manual notification state ──
  const [checkNowLoading, setCheckNowLoading] = useState(false);
  const [checkNowSummary, setCheckNowSummary] = useState(null);
  const [rowBusyId, setRowBusyId] = useState(null);  // id of the row currently being updated/notified
  const [listMode, setListMode] = useState(null);     // null | "pending" | "last30" | "dateLookup"
  // Date used for the "Load by Date" lookup. Defaults to today.
  // Format: YYYY-MM-DD (matches the HTML date input value).
  const [lookupDate, setLookupDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [resultFilter, setResultFilter] = useState("all"); // "all" | "damage" | "no_damage" | "retail" | "pending"

  const effectiveInspSig = inspSigMethod === "type"
    ? (inspTypedSig ? typedSignatureToDataUrl(inspTypedSig, inspSigFont) : "")
    : inspSig;
  const [teamMembers, setTeamMembers] = useState([]);
  const [currentClaimId, setCurrentClaimId] = useState(null);
  const [isSigningFromLink, setIsSigningFromLink] = useState(false);
  const [isLoadingSigningLink, setIsLoadingSigningLink] = useState(false);
  const [auditInfo, setAuditInfo] = useState(initialAuditInfo);

  // Manager-editable content — persisted to localStorage
  const DEFAULTS = {
    reviewHeadline: "We're fighting for you — just two quick steps and we can get your claim moving. It's fast, easy, and completely secure.",
    reviewLorText: "This simply lets your insurance company know that Healthy Homes Public Adjusting is in your corner, handling all the back-and-forth on your behalf. You won't have to deal with them directly at all.",
    reviewPacText: "This is our working agreement — it outlines how we get paid (only when you get paid) and confirms that we're fully committed to maximizing your claim. No upfront costs, ever.",
    reviewHelpText: "You can tap 'Preview' to read any document first. When you're ready, hit 'Looks Good!' on each one and scroll down to sign.",
    thankYouHeadline: "You're All Set — Let's Get Your Money! 🚀",
    thankYouOpening: "You did it! Your documents are signed and we're officially on the case. Here's exactly what happens next:",
    thankYouSteps: JSON.stringify([
      "📞 Your public adjuster will call you within 24 hours to introduce themselves and answer any questions.",
      "🏠 We'll schedule a property inspection to document every bit of damage — the insurance company won't miss a thing.",
      "📋 We build your full claim package and submit it to the insurance company on your behalf.",
      "💰 We negotiate hard to maximize your settlement — you don't pay us unless you get paid.",
      "🎉 You receive your settlement and we handle all the paperwork. Sit back and let us do the work!",
    ]),
    thankYouClosing: "We're so glad you chose Healthy Homes Public Adjusting. You made the right call. Talk soon! 💚",
    preInspHeadline: "Inspection Booked — We're On It! 🏠",
    preInspOpening: "You're all signed up! Your free roof inspection is next. Here's what to expect:",
    preInspSteps: JSON.stringify([
      "📅 Your rep will schedule your free roof inspection — usually within 1–3 business days.",
      "🏠 One of our trained inspectors will visit the property and document any damage thoroughly.",
      "📊 We review the inspection report and advise you on whether to file a claim.",
      "✅ If damage is found, we'll have you sign the PA paperwork and get to work immediately.",
      "💚 No damage found? No problem — the inspection is completely free, no strings attached.",
    ]),
    preInspClosing: "We'll be in touch soon to schedule your inspection. Thank you for trusting Healthy Homes Public Adjusting! 💚",
    inspOnlyHeadline: "Inspection Booked — We'll Be In Touch! 🏠",
    inspOnlyOpening: "Thank you for signing your Free Roof Inspection Agreement with U.S. Shingle & Metal LLC. Your inspector will be in touch shortly to schedule a visit.",
    inspOnlySteps: JSON.stringify([
      "📞 Your sales rep will contact you within 24 hours to schedule the inspection.",
      "🏠 A licensed inspector will visit your property and document any roof damage.",
      "📊 All findings and photos are forwarded to a licensed Public Adjuster for review.",
      "✅ If storm damage is confirmed, you'll be contacted about your options for filing a claim.",
      "💚 No damage found? No problem — the inspection is completely free with no obligation.",
    ]),
    inspOnlyClosing: "Thank you for trusting U.S. Shingle & Metal LLC. We'll be in touch soon! 🏠",
    ussWelcomeHeading: "What Happens Next",
    ussWelcomeSteps: JSON.stringify([
      "Your sales representative will contact you within 24 hours to coordinate the inspection.",
      "One of our trained inspectors will visit your property and thoroughly document any storm damage.",
      "All findings and photos are forwarded to a licensed Public Adjuster for professional review.",
      "If storm damage is confirmed, you will be contacted about your options for filing an insurance claim.",
      "If no damage is found — no problem! The inspection is completely free with no obligation.",
    ]),
    ussContactPhone: "727.761.5200",
    ussContactEmail: "info@shingleusa.com",
    activityEmail: "",
    managerPin: "1234",
  };

  const loadSetting = (key) => {
    try { return localStorage.getItem("ccg_mgr_" + key) || DEFAULTS[key]; } catch { return DEFAULTS[key]; }
  };
  const saveSetting = (key, value) => {
    try { localStorage.setItem("ccg_mgr_" + key, value); } catch {}
  };

  const [reviewHeadline, setReviewHeadlineRaw] = useState(() => loadSetting("reviewHeadline"));
  const [reviewLorText, setReviewLorTextRaw] = useState(() => loadSetting("reviewLorText"));
  const [reviewPacText, setReviewPacTextRaw] = useState(() => loadSetting("reviewPacText"));
  const [reviewHelpText, setReviewHelpTextRaw] = useState(() => loadSetting("reviewHelpText"));
  const [thankYouHeadline, setThankYouHeadlineRaw] = useState(() => loadSetting("thankYouHeadline"));
  const [thankYouOpening, setThankYouOpeningRaw] = useState(() => loadSetting("thankYouOpening"));
  const [thankYouSteps, setThankYouStepsRaw] = useState(() => {
    try { return JSON.parse(loadSetting("thankYouSteps")); } catch { return JSON.parse(DEFAULTS.thankYouSteps); }
  });
  const [thankYouClosing, setThankYouClosingRaw] = useState(() => loadSetting("thankYouClosing"));
  const [managerPin, setManagerPinRaw] = useState(() => loadSetting("managerPin"));
  const [managerPinEntry, setManagerPinEntry] = useState("");
  const [managerUnlocked, setManagerUnlocked] = useState(false);
  const [managerTYTab, setManagerTYTab] = useState("post_inspection");
  const [managerSection, setManagerSection] = useState("home");

  // ── Browse All Records — paginated full-list audit tool for managers ──
  // Shows every inspection in the system in chronological order. Each row
  // links to the existing edit modal so issues can be fixed in place.
  const [browseAllRows, setBrowseAllRows] = useState([]);
  const [browseAllLoading, setBrowseAllLoading] = useState(false);
  const [browseAllPage, setBrowseAllPage] = useState(0);
  const [browseAllPageSize] = useState(50);
  const [browseAllSort, setBrowseAllSort] = useState("signed_at_desc"); // signed_at_desc | signed_at_asc | name_asc
  const [browseAllSearch, setBrowseAllSearch] = useState("");
  const [browseAllStatus, setBrowseAllStatus] = useState("all"); // all | pending | resulted | cancelled | no_jn | no_result

  // ── Find Duplicates — manager dedupe tool ──────────────────────────
  // Groups records by normalized address+zip and shows any group with >1 row.
  // Manager picks which row to keep; the others get deleted.
  const [dupeGroups, setDupeGroups] = useState([]);
  const [dupeLoading, setDupeLoading] = useState(false);
  const [dupeBusy, setDupeBusy] = useState(false);
  const [reportData, setReportData] = useState(null);
  const [reportPdfLoading, setReportPdfLoading] = useState(false);
  // Email-the-Report modal state. null = closed. Manager types an email and
  // hits send; the PDF is generated fresh on send rather than precomputed.
  const [reportEmailModal, setReportEmailModal] = useState(null); // null | { to: string }
  const [reportEmailSending, setReportEmailSending] = useState(false);

  // ── JN Inspection Report state ──────────────────────────────────
  // For homeowners that exist in JN but never went through the app's
  // signing flow. Admin enters the JN job ID, the function pulls the
  // job + photos and uploads a report PDF back to JN's documents tab.
  const [jnReportJnid, setJnReportJnid] = useState("");
  const [jnReportSending, setJnReportSending] = useState(false);

  // ── Bulk Inspection Reports state ──────────────────────────────
  // Manager picks a status (Damage / No Damage / Retail) and runs the
  // per-job insp report generator across every matching JN job. The
  // candidates list is fetched first so the user can review what will
  // be processed; the actual run is a background function that returns
  // immediately and writes progress to Netlify logs.
  const [bulkResult, setBulkResult] = useState("Retail");
  const [bulkSinceDays, setBulkSinceDays] = useState(30);
  const [bulkSkipExisting, setBulkSkipExisting] = useState(true);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkCandidates, setBulkCandidates] = useState(null); // null = not loaded; [] = loaded empty

  // ── Resend Signed Documents modal state ────────────────────────
  // Lets admin re-send archived PDFs to any email address (PA, office,
  // homeowner, or a typed-in custom address). For records that haven't
  // been archived yet, the resend function regenerates them on the fly.
  const [resendModal, setResendModal] = useState(null); // null | { rec, to, cc, recipientType, customTo, forceRegen }
  const [resendLoading, setResendLoading] = useState(false);

  // ── Edit Record modal ──────────────────────────────────────────────
  // Lets admin correct errors on any inspection record: name typos, wrong
  // address, missing JN link, bad result, etc. Shows a danger zone at the
  // bottom for cancellation / deletion.
  const [editModal, setEditModal] = useState(null); // null | { rec, draft }
  // Photo gallery modal — when set, shows the inspection_photos JSON
  // for that inspection id (with signed URLs + category labels).
  const [photosModalId, setPhotosModalId] = useState(null);
  // JN match-picker modal — shown before "Sync to JN" creates anything,
  // so the manager can link to an existing JN job instead of silently
  // duplicating it. Holds the row that's being synced.
  const [jnPickerRow, setJnPickerRow] = useState(null);
  const [editLoading, setEditLoading] = useState(false);

  // Sales rep manager

  // Sales rep manager
  const [reps, setReps] = useState([]);
  const [repsLoaded, setRepsLoaded] = useState(false);
  const [newRepName, setNewRepName] = useState("");
  const [newRepEmail, setNewRepEmail] = useState("");
  const [newRepJnId, setNewRepJnId] = useState("");
  const [newRepPhone, setNewRepPhone] = useState("");
  const [repSearch, setRepSearch] = useState("");
  const [repSuggestions, setRepSuggestions] = useState([]);
  const [showRepSuggestions, setShowRepSuggestions] = useState(false);
  const [repSaving, setRepSaving] = useState(false);
  const [jnUsers, setJnUsers] = useState([]);
  const [jnImporting, setJnImporting] = useState(false);
  const [jnImportError, setJnImportError] = useState("");

  const fetchJnUsers = async () => {
    setJnImporting(true);
    setJnImportError("");
    try {
      const res = await fetch("/.netlify/functions/jobnimbus-users");
      const data = await res.json();
      if (data.members && data.members.length > 0) {
        setJnUsers(data.members);
      } else {
        setJnImportError("No users returned from JN. Check API connection.");
      }
    } catch (e) {
      setJnImportError("Failed to connect to JN API.");
    } finally {
      setJnImporting(false);
    }
  };

  const lookupJnUser = async (repId, repName) => {
    // Try to find matching JN user by name similarity
    if (!jnUsers.length) return null;
    const nameLower = repName.toLowerCase();
    const parts = nameLower.split(" ");
    return jnUsers.find(u => {
      const jnName = u.name.toLowerCase();
      return jnName === nameLower ||
        (parts.length >= 2 && jnName.includes(parts[0]) && jnName.includes(parts[parts.length - 1]));
    }) || null;
  };

  const syncRepFromJn = async (repId, repName) => {
    const match = await lookupJnUser(repId, repName);
    if (!match) {
      alert(`Could not find "${repName}" in Job Nimbus. Check that the name matches exactly.`);
      return;
    }
    const { error } = await supabase.from("sales_reps")
      .update({ jobnimbus_id: match.jobnimbus_id })
      .eq("id", repId);
    if (!error) {
      await loadReps();
      alert(`✅ Linked "${repName}" → JN ID: ${match.jobnimbus_id}`);
    }
  };

  const importAllFromJn = async () => {
    if (!jnUsers.length) { alert("Load JN users first."); return; }
    let added = 0;
    for (const u of jnUsers) {
      if (!u.name || u.name.toLowerCase().includes("test")) continue;
      const exists = reps.find(r => r.name.toLowerCase() === u.name.toLowerCase());
      if (!exists) {
        await supabase.from("sales_reps").insert([{
          name: u.name,
          jobnimbus_id: u.jobnimbus_id,
          email: u.email || "",
        }]);
        added++;
      } else if (u.jobnimbus_id) {
        const updates = { jobnimbus_id: u.jobnimbus_id };
        if (u.email && !exists.email) updates.email = u.email;
        await supabase.from("sales_reps").update(updates).eq("id", exists.id);
      }
    }
    await loadReps();
    alert(`✅ Import complete — ${added} new rep(s) added.`);
  };

  const loadReps = async () => {
    // 1. Try JN live first
    try {
      const res = await fetch("/.netlify/functions/jobnimbus-users");
      if (res.ok) {
        const json = await res.json();
        if (json.members && json.members.length > 0) {
          // Shape JN members to match the reps object shape the rest of the app expects
          const jnReps = json.members.map((m) => ({
            id: m.jobnimbus_id,          // use jnid as the id
            name: m.name,
            email: m.email || "",
            jobnimbus_id: m.jobnimbus_id,
            active: true,
            _fromJN: true,               // flag so we know it came live from JN
          }));
          setReps(jnReps);
          setRepsLoaded(true);

          // Silently sync any new reps / emails back to Supabase in the background
          syncJnRepsToSupabase(jnReps);
          return;
        }
      }
    } catch (e) {
      console.warn("JN users fetch failed, falling back to Supabase:", e.message);
    }

    // 2. Fall back to Supabase
    const { data, error } = await supabase.from("sales_reps").select("*").order("name");
    if (!error) { setReps(data || []); setRepsLoaded(true); }
    else console.error("loadReps error:", error);
  };

  // Keep Supabase in sync with JN data (runs silently in background)
  const syncJnRepsToSupabase = async (jnReps) => {
    try {
      const { data: existing } = await supabase.from("sales_reps").select("name, jobnimbus_id, email");
      const existingMap = {};
      (existing || []).forEach(r => { existingMap[r.jobnimbus_id] = r; });

      for (const rep of jnReps) {
        if (rep.name.toLowerCase().includes("test")) continue;
        if (!existingMap[rep.jobnimbus_id]) {
          // New rep — insert
          await supabase.from("sales_reps").insert([{
            name: rep.name,
            jobnimbus_id: rep.jobnimbus_id,
            email: rep.email,
            active: true,
          }]);
        } else if (rep.email && existingMap[rep.jobnimbus_id].email !== rep.email) {
          // Email changed in JN — update Supabase
          await supabase.from("sales_reps").update({ email: rep.email })
            .eq("jobnimbus_id", rep.jobnimbus_id);
        }
      }
    } catch (e) {
      console.warn("syncJnRepsToSupabase error:", e.message);
    }
  };

  const seedRepsFromList = async () => {
    const knownReps = [
      { name: 'Anthony "Brent" Parker', jobnimbus_id: "54ef6f4d65ec46f083d2d8abf678c2fc" },
      { name: "Brandon Latronica",      jobnimbus_id: "22c5d7fc66a54ce98e6a84baf7d242f4" },
      { name: "Bruce Holbert",          jobnimbus_id: "2f48ee33e65f49bb93018f55dd2992e3" },
      { name: "Bruce Lowther",          jobnimbus_id: "e5a7561db36e43e0aa4c7f254b291165" },
      { name: "Byron Ulrich",           jobnimbus_id: "mjbyrlmh4k077ynqcnt97a6" },
      { name: "Chris Baughan",          jobnimbus_id: "95bf148916f141acad5d9df5e7aba0d0" },
      { name: "Chris Gourdine",         jobnimbus_id: "mbtud30ydxwyiwsljut9ue6" },
      { name: "Chris Hill",             jobnimbus_id: "31e0d80686714125ab0e08eefd13f8a7" },
      { name: "Christopher Rath",       jobnimbus_id: "mjaf8gndd3am0tpi2jrgbt1" },
      { name: "Corrie Dennie",          jobnimbus_id: "mbjvh9ev82npk3wh91tkm5k" },
      { name: "Corynn Colbert",         jobnimbus_id: "mjheo3un8v3xbk0etrk101x" },
      { name: "David Kirkbribe",        jobnimbus_id: "mjiuedq3au9cjffclui1g30" },
      { name: "Eric Kofler",            jobnimbus_id: "mjiufcezufnrdze6h414e3m" },
      { name: "Heath Larner",           jobnimbus_id: "715ff737aa334af29eefd5014c9bc519" },
      { name: "Jason Hunt",             jobnimbus_id: "cbf9e3ab0f564d269bce24efdc48e7d6" },
      { name: "Jermie James",           jobnimbus_id: "mjiuednf61am6t4td796xef" },
      { name: "Jerry Rooney",           jobnimbus_id: "mjomom1c1v3jod1z97il1z6" },
      { name: "John King",              jobnimbus_id: "496e19b644c0459cab64144378357f16" },
      { name: "Jose Huerta",            jobnimbus_id: "e66f617fb6cb4e829ca87592b454a44d" },
      { name: "Joseph LeBlanc",         jobnimbus_id: "1fde2aa1681d49be8ea15d7f498c2535" },
      { name: "Justin Jones",           jobnimbus_id: "mjbyrnzv1sn3fu3chh26m98" },
      { name: "Michael Brown",          jobnimbus_id: "40f8a3d05be14548906510da185a55d5" },
      { name: "William Hernandez",      jobnimbus_id: "m9k7jgp9j6t5ncdvy8w5it6" },
      { name: "Yulia Karnitskaya",      jobnimbus_id: "21a6d8b32e4442ffb50b9d911266c89f" },
    ];
    setRepSaving(true);
    let added = 0, updated = 0;
    for (const rep of knownReps) {
      const existing = reps.find(r => r.name.toLowerCase() === rep.name.toLowerCase());
      if (!existing) {
        await supabase.from("sales_reps").insert([rep]);
        added++;
      } else if (!existing.jobnimbus_id) {
        await supabase.from("sales_reps").update({ jobnimbus_id: rep.jobnimbus_id }).eq("id", existing.id);
        updated++;
      }
    }
    await loadReps();
    setRepSaving(false);
    alert(`✅ Done — ${added} added, ${updated} updated.`);
  };

 const saveRep = async () => {
    if (!newRepName.trim()) return;
    setRepSaving(true);
    const { error } = await supabase.from("sales_reps").insert([{
      name: newRepName.trim(),
      email: newRepEmail.trim(),
      phone: newRepPhone.trim(),
      jobnimbus_id: newRepJnId.trim(),
    }]);
    if (!error) {
      setNewRepName(""); setNewRepEmail(""); setNewRepPhone(""); setNewRepJnId("");
      await loadReps();
    }
    setRepSaving(false);
  };

  const deleteRep = async (id) => {
    await supabase.from("sales_reps").delete().eq("id", id);
    await loadReps();
  };

  const toggleRepActive = async (id, currentActive) => {
    await supabase.from("sales_reps").update({ active: !currentActive }).eq("id", id);
    await loadReps();
  };

  const [showInactiveReps, setShowInactiveReps] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const today = new Date().toISOString().split("T")[0];
  // Default range = current Mon–Sun pay week
  const _mondayStart = (() => {
    const t = new Date();
    const daysBack = (t.getDay() + 6) % 7; // 0 if Mon, 6 if Sun
    const d = new Date(t);
    d.setDate(t.getDate() - daysBack);
    return d.toISOString().split("T")[0];
  })();
  const [reportStartDate, setReportStartDate] = useState(_mondayStart);
  const [reportEndDate, setReportEndDate] = useState(today);

  // ── Submission Analytics state ──────────────────────────────────
  // Defaults to last 30 days (signed_at window).
  const _thirtyDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  })();
  const [analyticsStart, setAnalyticsStart] = useState(_thirtyDaysAgo);
  const [analyticsEnd, setAnalyticsEnd] = useState(today);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsData, setAnalyticsData] = useState(null);

  // ── My Stats fetcher ─────────────────────────────────────────────────
  // Loads this week + last week stats for a single rep, plus computes
  // their rank on the company-wide leaderboard for this week.
  // Week = Monday 00:00 → Sunday 23:59 (US convention; tweak if needed).
  const fetchMyStats = async (repIdOrName, repName) => {
    setMyStatsLoading(true);
    try {
      // Compute Monday-of-this-week and Monday-of-last-week
      const now = new Date();
      const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Mon, 6 = Sun
      const thisMon = new Date(now); thisMon.setDate(now.getDate() - dayOfWeek); thisMon.setHours(0,0,0,0);
      const thisSun = new Date(thisMon); thisSun.setDate(thisMon.getDate() + 6); thisSun.setHours(23,59,59,999);
      const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
      const lastSun = new Date(thisMon); lastSun.setDate(thisMon.getDate() - 1); lastSun.setHours(23,59,59,999);

      // Fetch ALL inspections within last week → this week range so we can
      // build the leaderboard AND filter for this rep in one query.
      const { data: rows, error } = await supabase
        .from("inspections")
        .select("id, sales_rep_id, sales_rep_name, signed_at, result, result_at, client_name, address, city, state, zip, mobile, jn_status, cancelled_at, docs_signed, signed_pdfs")
        .gte("signed_at", lastMon.toISOString())
        .lte("signed_at", thisSun.toISOString())
        .is("cancelled_at", null);
      if (error) throw error;

      // Apply the same dedup logic as Submission Analytics so a rep with
      // duplicate rows doesn't get double-counted.
      const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
      const normKey = (n, zip, addr) => {
        const z = (zip || "").trim();
        if (z) return `${normName(n)}|zip:${z}`;
        return `${normName(n)}|st:${(addr || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ")}`;
      };
      const PENDING_STATUSES = new Set(["", "needs inspection", "new lead"]);
      const isActivePending = (r) => {
        const st = (r.jn_status || "").trim().toLowerCase();
        return !r.result && PENDING_STATUSES.has(st);
      };

      // Bucket rows by week first, then dedup within each week
      const inWeek = (r, mon, sun) => {
        const t = r.signed_at ? new Date(r.signed_at).getTime() : 0;
        return t >= mon.getTime() && t <= sun.getTime();
      };

      const dedupAndCount = (rowsForWeek, repFilter) => {
        const groupByKey = new Map();
        for (const r of rowsForWeek) {
          const k = normKey(r.client_name, r.zip, r.address);
          const ex = groupByKey.get(k);
          if (!ex) { groupByKey.set(k, r); continue; }
          if (r.result && !ex.result) { groupByKey.set(k, r); continue; }
          if (ex.result && !r.result) continue;
          const tNew = r.result_at ? new Date(r.result_at).getTime() : (r.signed_at ? new Date(r.signed_at).getTime() : 0);
          const tOld = ex.result_at ? new Date(ex.result_at).getTime() : (ex.signed_at ? new Date(ex.signed_at).getTime() : 0);
          if (tNew > tOld) groupByKey.set(k, r);
        }
        const deduped = [...groupByKey.values()].filter(r => r.result || isActivePending(r));
        // Filter to a specific rep if requested
        const filtered = repFilter ? deduped.filter(r =>
          (r.sales_rep_id && r.sales_rep_id === repFilter.id) ||
          (r.sales_rep_name && r.sales_rep_name === repFilter.name)
        ) : deduped;

        const counts = { submissions: filtered.length, damage: 0, no_damage: 0, retail: 0, pending: 0 };
        for (const r of filtered) {
          if (r.result === "damage") counts.damage++;
          else if (r.result === "no_damage") counts.no_damage++;
          else if (r.result === "retail") counts.retail++;
          else counts.pending++;
        }
        const resulted = counts.damage + counts.no_damage + counts.retail;
        counts.resulted = resulted;
        counts.damagePct = resulted > 0 ? Math.round((counts.damage / resulted) * 100) : 0;
        counts.noDamagePct = resulted > 0 ? Math.round((counts.no_damage / resulted) * 100) : 0;
        counts.retailPct = resulted > 0 ? Math.round((counts.retail / resulted) * 100) : 0;
        counts.pendingPct = counts.submissions > 0 ? Math.round((counts.pending / counts.submissions) * 100) : 0;
        return { counts, rows: filtered };
      };

      const repFilter = { id: repIdOrName, name: repName };
      const thisWeekRows = (rows || []).filter(r => inWeek(r, thisMon, thisSun));
      const lastWeekRows = (rows || []).filter(r => inWeek(r, lastMon, lastSun));

      const thisWeek = dedupAndCount(thisWeekRows, repFilter);
      const lastWeek = dedupAndCount(lastWeekRows, repFilter);

      // ── All-time stats for this rep ──────────────────────────────────
      // Pull the rep's full submission history so they can see lifetime
      // damage / no_damage / retail / pending breakdown. We don't compute
      // a leaderboard for all-time since rankings shift over time and
      // people who have left the company would distort the picture.
      const orFilter = `sales_rep_id.eq.${repIdOrName},sales_rep_name.eq.${repName}`;
      const { data: allTimeRaw } = await supabase
        .from("inspections")
        .select("id, sales_rep_id, sales_rep_name, signed_at, result, result_at, client_name, address, city, state, zip, mobile, jn_status, cancelled_at, docs_signed, signed_pdfs")
        .or(orFilter)
        .is("cancelled_at", null)
        .order("signed_at", { ascending: false })
        .limit(1000);
      const allTime = dedupAndCount(allTimeRaw || [], repFilter);

      // Enrich the rep's own rows with docs_signed from the claims table.
      // Claims table is the truth source for what was signed; inspections
      // table only shows "insp" for inspection-only signings.
      // We do this once per call rather than during dedup so the count math stays simple.
      const allMyRows = [...thisWeek.rows, ...lastWeek.rows, ...allTime.rows];
      const myZips = [...new Set(allMyRows.map(r => (r.zip || "").trim()).filter(Boolean))];
      if (myZips.length > 0) {
        const { data: claimsForRep } = await supabase
          .from("claims")
          .select("homeowner1, address, zip, docs_signed")
          .in("zip", myZips);
        const byZipStreet = new Map();
        for (const c of claimsForRep || []) {
          const z = (c.zip || "").trim();
          if (!z) continue;
          const street = (c.address || "").toLowerCase().trim().split(",")[0].replace(/\s+/g, " ").trim();
          const num = (street.match(/^\d+/) || [""])[0];
          byZipStreet.set(`${z}|${street}`, c.docs_signed || "");
          if (num) {
            const numKey = `${z}|num:${num}`;
            if (!byZipStreet.has(numKey)) byZipStreet.set(numKey, c.docs_signed || "");
          }
          const lastName = ((c.homeowner1 || "").trim().split(/\s+/).pop() || "").toLowerCase();
          if (lastName) {
            const nameKey = `${z}|name:${lastName}`;
            if (!byZipStreet.has(nameKey)) byZipStreet.set(nameKey, c.docs_signed || "");
          }
        }
        const attach = (r) => {
          const z = (r.zip || "").trim();
          const street = (r.address || "").toLowerCase().trim().split(",")[0].replace(/\s+/g, " ").trim();
          const num = (street.match(/^\d+/) || [""])[0];
          const lastName = ((r.client_name || "").trim().split(/\s+/).pop() || "").toLowerCase();
          let claimDocs = byZipStreet.get(`${z}|${street}`);
          if (!claimDocs && num)      claimDocs = byZipStreet.get(`${z}|num:${num}`);
          if (!claimDocs && lastName) claimDocs = byZipStreet.get(`${z}|name:${lastName}`);
          // Combine — inspection's docs_signed OR claim's docs_signed OR signed_pdfs.
          // signed_pdfs is authoritative since archive only happens after a successful sign.
          const combined = [r.docs_signed || "", claimDocs || ""].join(",").toLowerCase();
          const sp = r.signed_pdfs || {};
          r._docsSigned = {
            insp: combined.includes("insp") || !!sp.insp,
            lor:  combined.includes("lor")  || !!sp.lor,
            pac:  combined.includes("pac")  || !!sp.pac || !!sp.pa,
          };
        };
        thisWeek.rows.forEach(attach);
        lastWeek.rows.forEach(attach);
        allTime.rows.forEach(attach);
      }

      // Build company-wide leaderboard for THIS WEEK
      const allDeduped = dedupAndCount(thisWeekRows, null).rows;
      const byRep = new Map();
      for (const r of allDeduped) {
        const key = r.sales_rep_id || r.sales_rep_name || "unknown";
        const name = r.sales_rep_name || "(no rep)";
        if (!byRep.has(key)) byRep.set(key, { id: key, name, submissions: 0, damage: 0, no_damage: 0, retail: 0 });
        const e = byRep.get(key);
        e.submissions++;
        if (r.result === "damage") e.damage++;
        else if (r.result === "no_damage") e.no_damage++;
        else if (r.result === "retail") e.retail++;
      }
      const leaderboard = [...byRep.values()].sort((a, b) => b.submissions - a.submissions);
      const myRank = leaderboard.findIndex(x =>
        x.id === repFilter.id || x.name === repFilter.name
      );
      const rankInfo = {
        rank: myRank >= 0 ? myRank + 1 : null,
        totalReps: leaderboard.length,
        topFive: leaderboard.slice(0, 5),
      };

      const result = { thisWeek, lastWeek, allTime, leaderboard: rankInfo };
      setMyStatsData(result);
      setBannerStats({ submissions: thisWeek.counts.submissions, resulted: thisWeek.counts.resulted, rank: rankInfo.rank, totalReps: rankInfo.totalReps });
    } catch (e) {
      alert("Could not load stats: " + (e.message || e));
    } finally {
      setMyStatsLoading(false);
    }
  };

  const fetchAnalytics = async (startDate, endDate) => {
    setAnalyticsLoading(true);
    setAnalyticsData(null);
    try {
      const start = startDate + "T00:00:00.000Z";
      const end   = endDate   + "T23:59:59.999Z";

      const { data: insps, error } = await supabase
        .from("inspections")
        .select("id, sales_rep_name, signed_at, result, result_at, client_name, address, zip, jn_status")
        .gte("signed_at", start)
        .lte("signed_at", end)
        .is("cancelled_at", null)
        .order("signed_at", { ascending: false });
      if (error) throw error;

      // ── Match the Pending list's definition of "pending" ────────────────
      // 1) Dedupe by homeowner+zip — duplicate inspection rows for the same
      //    person should count as one submission, not multiple.
      // 2) Within a dedupe group, prefer the resolved row (one with result set)
      //    over orphans without results. This means if Stahley has 3 rows and
      //    1 has result=retail, the group counts as 1 retail (not 1 retail + 2 pending).
      // 3) For active-pending inclusion, the JN status must be in the
      //    "Needs Inspection" / "New Lead" / null / empty set — anything else
      //    (Lost, Sold, In Progress, etc.) is excluded.
      const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
      const normKey = (n, zip, addr) => {
        const z = (zip || "").trim();
        if (z) return `${normName(n)}|zip:${z}`;
        const street = (addr || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
        return `${normName(n)}|st:${street}`;
      };
      const PENDING_STATUSES = new Set(["", "needs inspection", "new lead"]);
      const isActivePending = (r) => {
        const st = (r.jn_status || "").trim().toLowerCase();
        return !r.result && PENDING_STATUSES.has(st);
      };

      const groupByKey = new Map();
      for (const r of insps || []) {
        const k = normKey(r.client_name, r.zip, r.address);
        const existing = groupByKey.get(k);
        if (!existing) { groupByKey.set(k, r); continue; }
        const existingHasResult = !!existing.result;
        const currentHasResult  = !!r.result;
        // Prefer the row that has a result. If both do, keep the more recent
        // result_at (or signed_at as tiebreaker).
        if (currentHasResult && !existingHasResult) { groupByKey.set(k, r); continue; }
        if (existingHasResult && !currentHasResult) continue;
        const tNew = r.result_at ? new Date(r.result_at).getTime() : (r.signed_at ? new Date(r.signed_at).getTime() : 0);
        const tOld = existing.result_at ? new Date(existing.result_at).getTime() : (existing.signed_at ? new Date(existing.signed_at).getTime() : 0);
        if (tNew > tOld) groupByKey.set(k, r);
      }
      // Any group with all-pending rows that AREN'T in active-pending statuses
      // (e.g. all jn_status="Lost") should be excluded entirely from the report.
      const rows = [...groupByKey.values()].filter(r => r.result || isActivePending(r));

      // Company-wide totals
      const total = rows.length;
      const counts = { damage: 0, no_damage: 0, retail: 0, pending: 0 };
      const daysList = []; // days-to-inspection for resulted records (any rep)

      for (const r of rows) {
        if (r.result === "damage") counts.damage++;
        else if (r.result === "no_damage") counts.no_damage++;
        else if (r.result === "retail") counts.retail++;
        else counts.pending++;

        if (r.result_at && r.signed_at) {
          const diffMs = new Date(r.result_at).getTime() - new Date(r.signed_at).getTime();
          const days = diffMs / (1000 * 60 * 60 * 24);
          if (isFinite(days) && days >= 0) daysList.push(days);
        }
      }

      const pct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;
      // Resulted count = everything that isn't pending. Used as denominator for
      // damage/no_damage/retail percentages so pending records don't dilute them.
      const resulted = counts.damage + counts.no_damage + counts.retail;
      const pctOfResulted = (n) => resulted > 0 ? Math.round((n / resulted) * 100) : 0;
      const mean = daysList.length > 0 ? daysList.reduce((a, b) => a + b, 0) / daysList.length : null;
      const sortedDays = [...daysList].sort((a, b) => a - b);
      const median = sortedDays.length > 0
        ? (sortedDays.length % 2 === 1
            ? sortedDays[(sortedDays.length - 1) / 2]
            : (sortedDays[sortedDays.length / 2 - 1] + sortedDays[sortedDays.length / 2]) / 2)
        : null;

      // Per-rep breakdown
      const byRepMap = new Map();
      for (const r of rows) {
        const rep = r.sales_rep_name || "Unassigned";
        if (!byRepMap.has(rep)) {
          byRepMap.set(rep, { rep, total: 0, damage: 0, no_damage: 0, retail: 0, pending: 0, days: [] });
        }
        const b = byRepMap.get(rep);
        b.total++;
        if (r.result === "damage") b.damage++;
        else if (r.result === "no_damage") b.no_damage++;
        else if (r.result === "retail") b.retail++;
        else b.pending++;
        if (r.result_at && r.signed_at) {
          const d = (new Date(r.result_at).getTime() - new Date(r.signed_at).getTime()) / (1000 * 60 * 60 * 24);
          if (isFinite(d) && d >= 0) b.days.push(d);
        }
      }
      const byRep = [...byRepMap.values()]
        .filter(b => b.total > 0)
        .map(b => {
          const m = b.days.length > 0 ? b.days.reduce((a, c) => a + c, 0) / b.days.length : null;
          const s = [...b.days].sort((a, c) => a - c);
          const med = s.length > 0
            ? (s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2)
            : null;
          const repResulted = b.damage + b.no_damage + b.retail;
          const pctR = (n) => repResulted > 0 ? Math.round((n / repResulted) * 100) : 0;
          return {
            rep: b.rep,
            total: b.total,
            resulted: repResulted,
            damage: b.damage, damagePct: pctR(b.damage),
            no_damage: b.no_damage, noDamagePct: pctR(b.no_damage),
            retail: b.retail, retailPct: pctR(b.retail),
            pending: b.pending, pendingPct: Math.round((b.pending / b.total) * 100),
            meanDays: m, medianDays: med,
          };
        })
        .sort((a, b) => b.total - a.total); // most-active rep first

      setAnalyticsData({
        startDate, endDate,
        total,
        resulted,
        counts,
        pct: { damage: pctOfResulted(counts.damage), no_damage: pctOfResulted(counts.no_damage), retail: pctOfResulted(counts.retail), pending: pct(counts.pending) },
        meanDays: mean,
        medianDays: median,
        byRep,
      });
    } catch (e) {
      console.error("Analytics fetch error:", e);
      setAnalyticsData({ error: e.message || String(e) });
    } finally {
      setAnalyticsLoading(false);
    }
  };

  const fetchReport = async (startDate, endDate) => {
    setReportLoading(true);
    setReportData(null);
    try {
      const start = startDate + "T00:00:00.000Z";
      const end = endDate + "T23:59:59.999Z";

      // We need ALL inspections (not just in-window) because a claim signed
      // this week might reference an inspection signed weeks ago, and we
      // need to know which week that insp was signed in to color it.
      // We also fetch cancelled inspections (a separate query) so claims
      // rows can be flagged with "CANCELLED" when their matching inspection
      // got Marked Lost. The report itself shows cancelled rows with $0
      // earned — transparent without distorting the totals.
      const [claimsRes, inspRes, allInspRes, cancelledInspRes] = await Promise.allSettled([
        supabase.from("claims")
          .select("id, homeowner1, homeowner2, address, city, state, zip, signed_at, sign_method, representative_name_old, sales_rep_name, sales_rep_email, docs_signed")
          .gte("signed_at", start)
          .lte("signed_at", end)
          .order("signed_at", { ascending: false }),
        supabase.from("inspections")
          .select("id, client_name, address, city, state, zip, signed_at, sales_rep_name, sales_rep_email, docs_signed")
          .gte("signed_at", start)
          .lte("signed_at", end)
          .is("cancelled_at", null)
          .order("signed_at", { ascending: false }),
        // All inspections ever — small table, used to backfill prior-period insp dates
        // and (critically) to read docs_signed when the matching claim has been
        // dedup'd away. Find Duplicates merges claim docs_signed into the inspection
        // master, so without docs_signed here the report would undercount LOR/PAC.
        supabase.from("inspections")
          .select("id, client_name, address, city, state, zip, signed_at, sales_rep_name, docs_signed")
          .not("signed_at", "is", null)
          .is("cancelled_at", null)
          .order("signed_at", { ascending: false })
          .limit(2000),
        // Cancelled inspections — used purely for matching claims rows to
        // a cancelled state. We don't show inspections-table cancellations
        // directly here (they're already filtered by date+cancelled_at above);
        // this is so a claim signed this period can detect that its sibling
        // inspection got Marked Lost.
        supabase.from("inspections")
          .select("id, client_name, address, zip, cancelled_at")
          .not("cancelled_at", "is", null)
          .order("cancelled_at", { ascending: false })
          .limit(2000),
      ]);

      const claims       = claimsRes.status === "fulfilled" ? (claimsRes.value.data || []) : [];
      const inspsInRange = inspRes.status === "fulfilled" ? (inspRes.value.data || []) : [];
      const allInsps     = allInspRes.status === "fulfilled" ? (allInspRes.value.data || []) : [];
      const cancelledInsps = cancelledInspRes.status === "fulfilled" ? (cancelledInspRes.value.data || []) : [];

      const claimsError = claimsRes.value?.error?.message || (claimsRes.status === "rejected" ? claimsRes.reason : null);
      const inspError   = inspRes.value?.error?.message || (inspRes.status === "rejected" ? inspRes.reason : null);

      console.log("Report range:", start, "to", end);
      console.log("Claims in range:", claims.length, "| Insps in range:", inspsInRange.length, "| Total insps:", allInsps.length, "| Cancelled insps:", cancelledInsps.length);

      // Helper: normalize homeowner + ZIP into a single lookup key.
      // Using ZIP (not full address) because the same property often gets
      // re-entered with different address spellings — ZIP stays consistent.
      // Falls back to street (first comma piece of address) if zip is missing.
      const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
      const normKey = (name, zip, address) => {
        const z = (zip || "").trim();
        if (z) return `${normName(name)}|zip:${z}`;
        const street = (address || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
        return `${normName(name)}|st:${street}`;
      };

      // Build lookup: key → most recent inspection record (any date)
      const inspByKey = {};
      for (const i of allInsps) {
        const k = normKey(i.client_name, i.zip, i.address);
        if (!inspByKey[k] || new Date(i.signed_at) > new Date(inspByKey[k].signed_at)) {
          inspByKey[k] = i;
        }
      }

      // Address-based cancellation lookup. We deliberately key on
      // street+zip (NOT homeowner name) because typos in the homeowner
      // name across inspections vs claims would otherwise hide the link.
      // Real example: an inspection saved as "Jerry Maertz" got cancelled,
      // but the claim was signed as "Jerry & Maerz" — same property, same
      // zip, different name spellings. With name in the key the cancelled
      // status was invisible to the claim row. Keying on address+zip means
      // any cancellation at a property propagates to every claim there.
      // We also expand common street suffix abbreviations so "St" and
      // "Street" bucket together.
      const STREET_SUFFIXES = [
        ["st","street"],["ave","avenue"],["av","avenue"],["rd","road"],
        ["blvd","boulevard"],["dr","drive"],["ln","lane"],["ct","court"],
        ["pl","place"],["ter","terrace"],["pkwy","parkway"],["hwy","highway"],
        ["cir","circle"],["trl","trail"],
      ];
      const normStreet = (street) => {
        let v = (street || "").toLowerCase().trim().replace(/[.,]/g, "").replace(/\s+/g, " ");
        // Drop unit designators so "123 Main St Apt 4" matches "123 Main St"
        const unitMatch = v.match(/\s+(apt|apartment|unit|ste|suite|#\S*)\b.*$/);
        if (unitMatch) v = v.slice(0, unitMatch.index).trim();
        // Expand the trailing token if it's a known abbreviation
        const tokens = v.split(" ");
        if (tokens.length >= 2) {
          const last = tokens[tokens.length - 1];
          const hit = STREET_SUFFIXES.find(([abbr]) => abbr === last);
          if (hit) tokens[tokens.length - 1] = hit[1];
        }
        return tokens.join(" ").trim();
      };
      const addrKey = (address, zip) => {
        const street = (address || "").split(",")[0];
        const z = (zip || "").trim();
        return `${normStreet(street)}|${z}`;
      };

      // Build lookup: addrKey → cancelled inspection (most recent cancellation if multiple).
      const cancelledByAddr = {};
      for (const i of cancelledInsps) {
        const k = addrKey(i.address, i.zip);
        if (!k || k === "|") continue;
        if (!cancelledByAddr[k] || new Date(i.cancelled_at) > new Date(cancelledByAddr[k].cancelled_at)) {
          cancelledByAddr[k] = i;
        }
      }

      const inRange = (ts) => ts && ts >= start && ts <= end;

      // Build one merged row per homeowner+zip.
      // A row appears in the report only if SOMETHING was signed this period.
      const merged = new Map();

      // Start with claims in the period — each claim represents LOR/PAC (and
      // sometimes insp) signed this period
      for (const c of claims) {
        const key = normKey(
          [c.homeowner1, c.homeowner2].filter(Boolean).join(" & "),
          c.zip,
          [c.address, c.city, c.state].filter(Boolean).join(", ")
        );
        // Pull docs_signed from BOTH the claim AND any matching inspection.
        // Find Duplicates merges sibling claims into the inspection master and
        // moves docs_signed there — so a claim row signed in this period might
        // genuinely be missing LOR/PAC entries that were rolled into the
        // inspection during a previous dedup pass. Union both sources.
        const inspMatch = inspByKey[key];
        const claimDocs = (c.docs_signed || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        const inspDocs  = (inspMatch?.docs_signed || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        const unionedDocs = [...new Set([...claimDocs, ...inspDocs])];
        // If both sources are empty, fall back to "all three" (legacy claims
        // sometimes wrote a row with no docs_signed value when everything
        // was signed in one shot).
        const assumedAll = unionedDocs.length === 0;
        const inspOnClaim = assumedAll || unionedDocs.includes("insp");
        const lorOnClaim  = assumedAll || unionedDocs.includes("lor");
        const pacOnClaim  = assumedAll || unionedDocs.includes("pac");

        // Determine insp status:
        // - If this claim includes "insp" → signed this period via the claim flow
        // - Else look up the prior inspection record for this homeowner
        let inspStatus = "none";
        let inspSignedAt = null;
        if (inspOnClaim) {
          inspStatus = "current";
          inspSignedAt = c.signed_at;
        } else {
          const priorInsp = inspByKey[key];
          if (priorInsp) {
            inspSignedAt = priorInsp.signed_at;
            inspStatus = inRange(priorInsp.signed_at) ? "current" : "prior";
          }
        }

        const cancelledMatch = cancelledByAddr[addrKey(c.address, c.zip)];
        merged.set(key, {
          name: [c.homeowner1, c.homeowner2].filter(Boolean).join(" & ") || "—",
          address: [c.address, c.city, c.state].filter(Boolean).join(", "),
          rep: c.sales_rep_name || c.representative_name_old || "Unassigned",
          signedAt: c.signed_at,
          inspStatus,
          inspSignedAt,
          lorStatus: lorOnClaim ? "current" : "none",
          pacStatus: pacOnClaim ? "current" : "none",
          // If the matching inspection got Marked Lost, flag the row. The earnings
          // calculation downstream reads this flag and forces earned = 0.
          cancelled: !!cancelledMatch,
          cancelledAt: cancelledMatch?.cancelled_at || null,
        });
      }

      // Add insp-only rows for homeowners who signed insp this period but
      // don't have a claim yet (no merged entry).
      // Note: inspsInRange is already filtered to non-cancelled, so these
      // rows are inherently active. cancelled stays false.
      //
      // Critically, we now also read docs_signed from the inspection record
      // here — Find Duplicates merges sibling claim docs_signed into the
      // inspection master and deletes the claim, so an "insp-only" row may
      // still legitimately have LOR/PAC if the dedup tool moved them over.
      // If we ignored docs_signed here, those signings would silently drop
      // off the pay report and reps would be undercompensated.
      for (const i of inspsInRange) {
        const key = normKey(i.client_name, i.zip, [i.address, i.city, i.state].filter(Boolean).join(", "));
        if (merged.has(key)) continue; // claim row already covers this
        const inspDocs = (i.docs_signed || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        const lorOnInsp = inspDocs.includes("lor");
        const pacOnInsp = inspDocs.includes("pac");
        merged.set(key, {
          name: i.client_name || "—",
          address: [i.address, i.city, i.state].filter(Boolean).join(", "),
          rep: i.sales_rep_name || "Unassigned",
          signedAt: i.signed_at,
          inspStatus: "current",
          inspSignedAt: i.signed_at,
          lorStatus: lorOnInsp ? "current" : "none",
          pacStatus: pacOnInsp ? "current" : "none",
          cancelled: false,
          cancelledAt: null,
        });
      }

      // Compute earnings per row. There are TWO policy regimes:
      //
      //   • Pre-cutoff (signed before Mon 2026-05-18): old tiered
      //     formula — Insp $100 / LOR+PA $150 / All 3 $250. Honored so
      //     reps' historic deals still pay out correctly.
      //
      //   • Post-cutoff (signed on/after Mon 2026-05-18): new policy
      //     under PA-forms-disabled — only William Hernandez earns,
      //     $150 per free inspection. Every other rep keeps their
      //     signing rows in the report but with no dollar figure.
      //
      // Cancelled rows always earn $0 regardless of regime.
      const POLICY_CUTOFF = new Date("2026-05-18T00:00:00");
      const rows = [...merged.values()].map(r => {
        if (r.cancelled) return { ...r, earned: 0 };
        const inspThisWeek = r.inspStatus === "current";
        const lorThisWeek  = r.lorStatus === "current";
        const pacThisWeek  = r.pacStatus === "current";
        const dealDate = r.signedAt ? new Date(r.signedAt) : null;
        const isPostCutoff = dealDate && dealDate >= POLICY_CUTOFF;
        let earned = 0;
        if (isPostCutoff) {
          if (r.rep === "William Hernandez" && inspThisWeek) earned = 150;
        } else {
          if (inspThisWeek && lorThisWeek && pacThisWeek) earned = 250;
          else if (lorThisWeek && pacThisWeek)            earned = 150;
          else if (inspThisWeek)                          earned = 100;
        }
        return { ...r, earned };
      });

      // Group by rep, sort rows newest-first within each rep
      const byRep = {};
      rows.forEach(r => {
        const key = r.rep || "Unassigned";
        if (!byRep[key]) byRep[key] = [];
        byRep[key].push(r);
      });
      Object.values(byRep).forEach(arr => arr.sort((a, b) => new Date(b.signedAt) - new Date(a.signedAt)));

      // Per-rep totals
      const repTotals = {};
      Object.keys(byRep).forEach(rep => {
        repTotals[rep] = byRep[rep].reduce((sum, r) => sum + r.earned, 0);
      });

      setReportData({
        byRep,
        repTotals,
        totalRows: rows.length,
        totalEarned: rows.reduce((sum, r) => sum + r.earned, 0),
        startDate, endDate,
        claimsError,
        inspError,
      });
    } catch (e) {
      console.error("Report fetch error:", e);
    } finally {
      setReportLoading(false);
    }
  };

  // Wrappers that save to localStorage on every change
  const setReviewHeadline = (v) => { setReviewHeadlineRaw(v); saveSetting("reviewHeadline", v); };
  const setReviewLorText  = (v) => { setReviewLorTextRaw(v);  saveSetting("reviewLorText", v); };
  const setReviewPacText  = (v) => { setReviewPacTextRaw(v);  saveSetting("reviewPacText", v); };
  const setReviewHelpText = (v) => { setReviewHelpTextRaw(v); saveSetting("reviewHelpText", v); };
  const setThankYouHeadline = (v) => { setThankYouHeadlineRaw(v); saveSetting("thankYouHeadline", v); };
  const setThankYouOpening = (v) => { setThankYouOpeningRaw(v); saveSetting("thankYouOpening", v); };
  const setThankYouSteps   = (v) => { setThankYouStepsRaw(v);   saveSetting("thankYouSteps", JSON.stringify(v)); };
  const setThankYouClosing = (v) => { setThankYouClosingRaw(v); saveSetting("thankYouClosing", v); };
  const setManagerPin     = (v) => { setManagerPinRaw(v);     saveSetting("managerPin", v); };

  // Pre-inspection flow state
  const [preInspHeadline, setPreInspHeadlineRaw] = useState(() => loadSetting("preInspHeadline"));
  const [preInspOpening,  setPreInspOpeningRaw]  = useState(() => loadSetting("preInspOpening"));
  const [preInspSteps,    setPreInspStepsRaw]    = useState(() => {
    try { return JSON.parse(loadSetting("preInspSteps")); } catch { return JSON.parse(DEFAULTS.preInspSteps); }
  });
  const [preInspClosing,  setPreInspClosingRaw]  = useState(() => loadSetting("preInspClosing"));
  const setPreInspHeadline = (v) => { setPreInspHeadlineRaw(v); saveSetting("preInspHeadline", v); };

  // Inspection-only flow state
  const [inspOnlyHeadline, setInspOnlyHeadlineRaw] = useState(() => loadSetting("inspOnlyHeadline"));
  const [inspOnlyOpening,  setInspOnlyOpeningRaw]  = useState(() => loadSetting("inspOnlyOpening"));
  const [inspOnlySteps,    setInspOnlyStepsRaw]    = useState(() => {
    try { return JSON.parse(loadSetting("inspOnlySteps")); } catch { return JSON.parse(DEFAULTS.inspOnlySteps); }
  });
  const [inspOnlyClosing,  setInspOnlyClosingRaw]  = useState(() => loadSetting("inspOnlyClosing"));
  const setInspOnlyHeadline = (v) => { setInspOnlyHeadlineRaw(v); saveSetting("inspOnlyHeadline", v); };
  const setInspOnlyOpening  = (v) => { setInspOnlyOpeningRaw(v);  saveSetting("inspOnlyOpening", v); };
  const setInspOnlySteps    = (v) => { setInspOnlyStepsRaw(v);    saveSetting("inspOnlySteps", JSON.stringify(v)); };
  const setInspOnlyClosing  = (v) => { setInspOnlyClosingRaw(v);  saveSetting("inspOnlyClosing", v); };

  // USS Welcome PDF editable content
  const [ussWelcomeHeading, setUssWelcomeHeadingRaw] = useState(() => loadSetting("ussWelcomeHeading"));
  const [ussWelcomeSteps,   setUssWelcomeStepsRaw]   = useState(() => {
    try { return JSON.parse(loadSetting("ussWelcomeSteps")); } catch { return JSON.parse(DEFAULTS.ussWelcomeSteps); }
  });
  const [ussContactPhone,   setUssContactPhoneRaw]   = useState(() => loadSetting("ussContactPhone"));
  const [ussContactEmail,   setUssContactEmailRaw]   = useState(() => loadSetting("ussContactEmail"));
  const setUssWelcomeHeading = (v) => { setUssWelcomeHeadingRaw(v); saveSetting("ussWelcomeHeading", v); };
  const setUssWelcomeSteps   = (v) => { setUssWelcomeStepsRaw(v);   saveSetting("ussWelcomeSteps", JSON.stringify(v)); };
  const setUssContactPhone   = (v) => { setUssContactPhoneRaw(v);   saveSetting("ussContactPhone", v); };
  const setUssContactEmail   = (v) => { setUssContactEmailRaw(v);   saveSetting("ussContactEmail", v); };

  const [activityEmail, setActivityEmailRaw] = useState(() => loadSetting("activityEmail"));
  const setActivityEmail = (v) => { setActivityEmailRaw(v); saveSetting("activityEmail", v); };
  const [noDamageManagerPhone, setNoDamageManagerPhoneRaw] = useState(() => loadSetting("noDamageManagerPhone") || "4437973758");
const [noDamageManagerSms, setNoDamageManagerSmsRaw] = useState(() => loadSetting("noDamageManagerSms") || "✅ No damage found at {address} for {client}. Rep: {rep}. Inspection complete — no claim needed.");
const setNoDamageManagerPhone = (v) => { setNoDamageManagerPhoneRaw(v); saveSetting("noDamageManagerPhone", v); };
const setNoDamageManagerSms = (v) => { setNoDamageManagerSmsRaw(v); saveSetting("noDamageManagerSms", v); };

// ── SMS Templates — 12 templates stored in Supabase sms_templates table ──
// Keys: {damage,nodamage,retail}_{insp,all}_{rep,homeowner}
// `insp` = only inspection was signed; `all` = insp + PA paperwork all signed
// These override any other SMS rules in the system for result-based messages
const SMS_TEMPLATE_KEYS = [
  "damage_insp_rep", "damage_insp_homeowner",
  "damage_all_rep", "damage_all_homeowner",
  "nodamage_insp_rep", "nodamage_insp_homeowner",
  "nodamage_all_rep", "nodamage_all_homeowner",
  "retail_insp_rep", "retail_insp_homeowner",
  "retail_all_rep", "retail_all_homeowner",
];
const [smsTemplates, setSmsTemplates] = useState({});
const [smsTemplatesLoaded, setSmsTemplatesLoaded] = useState(false);
const loadSmsTemplates = async () => {
  try {
    const { data, error } = await supabase.from("sms_templates").select("key, body");
    if (error) { console.warn("SMS templates load error:", error.message); setSmsTemplatesLoaded(true); return; }
    const map = {};
    (data || []).forEach(row => { map[row.key] = row.body; });
    setSmsTemplates(map);
    setSmsTemplatesLoaded(true);
  } catch (e) { console.warn("SMS templates load exception:", e.message); setSmsTemplatesLoaded(true); }
};
// Debounced save — waits 600ms after last keystroke before writing to Supabase.
// Prevents flooding the DB with one upsert per character, and keeps error
// alerts from firing on every keystroke if something's broken.
const smsSaveTimersRef = useRef({});
const smsSaveAlertedRef = useRef({}); // per-key dedupe for error alerts
const saveSmsTemplate = (key, body) => {
  // Optimistic local update so the textarea stays responsive
  setSmsTemplates(prev => ({ ...prev, [key]: body }));

  // Clear any pending save for this key
  if (smsSaveTimersRef.current[key]) clearTimeout(smsSaveTimersRef.current[key]);

  // Schedule the actual DB write
  smsSaveTimersRef.current[key] = setTimeout(async () => {
    try {
      const { data, error } = await supabase
        .from("sms_templates")
        .upsert({ key, body, updated_at: new Date().toISOString() }, { onConflict: "key" })
        .select();
      if (error) {
        console.error("SMS template save ERROR:", error.message, error);
        // Alert once per key per session — enough to know it's broken, not spammy
        if (!smsSaveAlertedRef.current[key]) {
          smsSaveAlertedRef.current[key] = true;
          alert(`Could not save "${key}":\n${error.message}\n\nCheck browser console for details.`);
        }
        return;
      }
      // Clear the alert dedupe on success so the user gets re-notified if it breaks again
      smsSaveAlertedRef.current[key] = false;
      if (!data || data.length === 0) {
        console.warn("SMS template save returned no rows for key:", key, "— upsert may have been blocked by RLS or unique-constraint missing");
      } else {
        console.log("SMS template saved:", key, "| body length:", body.length);
      }
    } catch (e) {
      console.error("SMS template save exception:", e);
      if (!smsSaveAlertedRef.current[key]) {
        smsSaveAlertedRef.current[key] = true;
        alert(`Exception saving "${key}":\n${e.message || e}`);
      }
    }
  }, 600);
};
const renderSmsTemplate = (key, vars) => {
  const body = smsTemplates[key] || "";
  return body
    .replace(/\{client\}/g,    vars.client    || "")
    .replace(/\{address\}/g,   vars.address   || "")
    .replace(/\{city\}/g,      vars.city      || "")
    .replace(/\{rep\}/g,       vars.rep       || "")
    .replace(/\{repPhone\}/g,  vars.repPhone  || "");
};

  const setPreInspOpening  = (v) => { setPreInspOpeningRaw(v);  saveSetting("preInspOpening", v); };
  const setPreInspSteps    = (v) => { setPreInspStepsRaw(v);    saveSetting("preInspSteps", JSON.stringify(v)); };
  const setPreInspClosing  = (v) => { setPreInspClosingRaw(v);  saveSetting("preInspClosing", v); };

  // Derived: which thank you content to show
  // inspectionOnly = only inspection was signed (no PA forms)
  const activeTYHeadline = inspectionOnly ? inspOnlyHeadline
    : data.claimStage === "pre_inspection" ? preInspHeadline : thankYouHeadline;
  const activeTYOpening  = inspectionOnly ? inspOnlyOpening
    : data.claimStage === "pre_inspection" ? preInspOpening  : thankYouOpening;
  const activeTYSteps    = inspectionOnly ? inspOnlySteps
    : data.claimStage === "pre_inspection" ? preInspSteps    : thankYouSteps;
  const activeTYClosing  = inspectionOnly ? inspOnlyClosing
    : data.claimStage === "pre_inspection" ? preInspClosing  : thankYouClosing;

  const [sig1, setSig1] = useState("");
  const [sig2, setSig2] = useState("");
  const [typedSig1, setTypedSig1] = useState("");
  const [typedSig2, setTypedSig2] = useState("");
  const [sigMethod1, setSigMethod1] = useState("draw");
  const [sigMethod2, setSigMethod2] = useState("draw");
  const [sigFont1, setSigFont1] = useState(SIGNATURE_FONTS[0]);
  const [sigFont2, setSigFont2] = useState(SIGNATURE_FONTS[0]);

  const [initials1Typed, setInitials1Typed] = useState("");
  const [initials2Typed, setInitials2Typed] = useState("");
  const [initialsMethod1, setInitialsMethod1] = useState("draw");
  const [initialsMethod2, setInitialsMethod2] = useState("draw");
  const [initialsFont1, setInitialsFont1] = useState(SIGNATURE_FONTS[0]);
  const [initialsFont2, setInitialsFont2] = useState(SIGNATURE_FONTS[0]);

  const [lorAgreed, setLorAgreed] = useState(false);
  const [pacAgreed, setPacAgreed] = useState(false);
  const [inspAgreed, setInspAgreed] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const hasSecond = Boolean(data.homeowner2?.trim());

  // ── Test mode — triggered when last name contains "test" ────
  const isTestMode = Boolean(
    (data.homeowner1 || "").toLowerCase().split(" ").pop()?.includes("test") ||
    (data.homeowner2 || "").toLowerCase().split(" ").pop()?.includes("test")
  );

  // Helper: redirect emails/SMS in test mode
  const testEmail = (originalEmail) => {
    if (isTestMode && testOverrideEmail) return testOverrideEmail;
    return originalEmail;
  };
  const testPhone = (originalPhone) => {
    if (isTestMode && testOverridePhone) return testOverridePhone;
    return originalPhone;
  };

  const propertyAddressText = [
    data.address,
    [data.city, data.state, data.zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");

  const reviewReady =
    (!selectedDocs.includes("insp") || inspAgreed) &&
    (!selectedDocs.includes("lor") || lorAgreed) &&
    (!selectedDocs.includes("pac") || pacAgreed);

  useEffect(() => {
    if (data.lossLocationSameAsAddress) {
      setData((prev) => ({ ...prev, lossLocation: propertyAddressText }));
    }
  }, [
    data.address,
    data.city,
    data.state,
    data.zip,
    data.lossLocationSameAsAddress,
    propertyAddressText,
  ]);

  // Load reps on mount
  useEffect(() => { loadReps(); }, []);

  // Load SMS templates when the manager opens the SMS section
  useEffect(() => {
    if (view === "manager" && managerSection === "sms" && !smsTemplatesLoaded) {
      loadSmsTemplates();
    }
  }, [view, managerSection, smsTemplatesLoaded]);

  // Also ensure templates are available for submitInspectionResult (Record Lookup)
  useEffect(() => {
    if (view === "manager" && managerSection === "lookup" && !smsTemplatesLoaded) {
      loadSmsTemplates();
    }
  }, [view, managerSection, smsTemplatesLoaded]);

  // Auto-run damage check silently when view changes to manager
  useEffect(() => {
    if (view === "manager") {
      fetch("/.netlify/functions/inspection-checker")
        .then(r => r.json())
        .then(d => console.log("Auto damage check:", d))
        .catch(e => console.warn("Auto damage check failed:", e));
    }
  }, [view]);

  const checkForDuplicate = async () => {
    if (!data.address || !data.zip) return null;
    const addr = data.address.trim().toLowerCase();
    const zip = data.zip.trim();
    try {
      const [claimRes, inspRes] = await Promise.allSettled([
        supabase.from("claims").select("id, homeowner1, homeowner2, address, city, state, zip, signed_at").ilike("address", addr).eq("zip", zip).order("signed_at", { ascending: false }).limit(1),
        supabase.from("inspections").select("id, client_name, address, city, state, zip, signed_at, sales_rep_name").ilike("address", addr).eq("zip", zip).order("signed_at", { ascending: false }).limit(1),
      ]);
      const claim = claimRes.status === "fulfilled" && claimRes.value.data?.[0];
      const insp  = inspRes.status  === "fulfilled" && inspRes.value.data?.[0];
      if (claim) return { type: "claim", status: "signed", record: claim };
      if (insp)  return { type: "inspection", status: "signed", record: insp };
    } catch (e) { console.warn("Duplicate check failed:", e); }
    return null;
  };

  useEffect(() => {
    const loadFromSigningLink = async () => {
      const params = new URLSearchParams(window.location.search);
      const claimId = params.get("claim");
      const docs = params.get("docs");
      const sign = params.get("sign");

      if (!claimId || sign !== "1") return;

      setIsLoadingSigningLink(true);

      try {
        const docsFromLink = docs
          ? docs
              .split(",")
              .map((item) => item.trim())
              .filter((item) => VALID_DOCS.includes(item))
          : ["lor"];

        const { data: claim, error } = await supabase
          .from("claims")
          .select("*")
          .eq("id", claimId)
          .single();

        if (error || !claim) {
          alert("Unable to load signing request.");
          return;
        }

        setCurrentClaimId(claim.id);
        {
          const wantedDocs = docsFromLink.length ? docsFromLink : ["lor"];
          const safeDocs = PA_FORMS_DISABLED
            ? wantedDocs.filter(d => d !== "lor" && d !== "pac")
            : wantedDocs;
          setSelectedDocs(safeDocs.length ? safeDocs : ["insp"]);
        }
        setSignMode("now");
        setPendingSend(false);
        setIsSigningFromLink(true);
        setLorAgreed(false);
        setPacAgreed(false);
        setSubmitAttempted(false);

        setSig1(claim.signature1 || "");
        setSig2(claim.signature2 || "");

        setAuditInfo({
          signedAt: claim.signed_at || "",
          signedIp: claim.signed_ip || "",
          signedUserAgent: claim.signed_user_agent || "",
          signMethod: claim.sign_method || "",
          signedByEmail: claim.signed_by_email || claim.homeowner_email || "",
          signedByName:
            claim.signed_by_name ||
            [claim.homeowner1, claim.homeowner2].filter(Boolean).join(", "),
          signedCity: claim.signed_city || "",
          signedRegion: claim.signed_region || "",
        });

        setData((prev) => ({
          ...prev,
          date: claim.date || prev.date,
          insuranceCompany: claim.insurance_company || "",
          policyNumber: claim.policy_number || "",
          claimNumber: claim.claim_number || "",
          representativeName: claim.representative_name || "",
          homeowner1: claim.homeowner1 || "",
          homeowner2: claim.homeowner2 || "",
          phone: claim.phone || "",
          address: claim.address || "",
          city: claim.city || "",
          state: claim.state || "",
          zip: claim.zip || "",
          lossLocation: claim.loss_location || "",
          dateOfLoss: claim.date_of_loss || "",
          situation: claim.situation || "",
          signerEmail: claim.homeowner_email || "",
          paEmail: claim.pa_email || prev.paEmail,
          salesRepEmail: claim.sales_rep_email || prev.salesRepEmail,
          // Hydrate the rep name/id from the saved claim so the
          // recipient-side validator (missingSigningFields) doesn't
          // block submit on "Sales rep name" — that field isn't shown
          // to the homeowner and can't be filled in on this view, so
          // if we don't seed it, the submit button stays disabled
          // forever no matter what they sign.
          salesRepName: claim.sales_rep_name || prev.salesRepName || "",
          salesRepId: claim.sales_rep_id || prev.salesRepId || "",
          initials1: claim.initials1 || "",
          initials2: claim.initials2 || "",
          claimType: prev.claimType,
          lossDescription: prev.lossDescription,
          lossLocationSameAsAddress:
            (claim.loss_location || "") ===
            [
              claim.address,
              [claim.city, claim.state, claim.zip].filter(Boolean).join(", "),
            ]
              .filter(Boolean)
              .join("\n"),
        }));

        // Restore rep search field from saved rep name
        if (claim.sales_rep_name) setRepSearch(claim.sales_rep_name);

        setView("review");
      } finally {
        setIsLoadingSigningLink(false);
      }
    };

    loadFromSigningLink();
  }, []);

  // JN team members fetch disabled — re-enable on test site when API key works

  useEffect(() => {
    if (view === "review" && reviewReady) {
      const timer = setTimeout(() => {
        const el = document.getElementById("signature-section");
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 200);

      return () => clearTimeout(timer);
    }
  }, [view, reviewReady]);

  // ── Pre-flight duplicate check ──────────────────────────────────────
  // Backend has a trigger that blocks duplicate inspection inserts within a
  // 5-minute window for the same address+zip. This helper checks BEFORE the
  // insert so the rep sees a friendly explanation + path forward (use My
  // Homeowners) instead of a raw SQL error.
  // Uses ADDRESS+ZIP as the duplicate key — not name — because a single
  // homeowner can legitimately own multiple properties with separate jobs.
  // Returns true if the rep wants to proceed anyway, false if they cancelled.
  // ── Load + open the My Homeowners modal ─────────────────────────
  // Extracted from the Quick-mode button so the Guided flow can call the
  // same fetch logic (the original lived inline in the Quick button's
  // onClick, which meant Guided opening the modal saw an empty list).
  // Loads inspections + claims for the current rep, merges by name+zip,
  // and shows the result in the modal.
  // Wrapper that opens the modal pre-filtered to awaiting-signature rows only.
  // Used by the "Awaiting Signature" button so reps can quickly find every
  // homeowner who got a link but didn't finish signing, and resend it.
  const loadAndOpenAwaitingSignature = async () => {
    setMyHomeownersPendingOnly(true);
    await loadAndOpenMyHomeowners();
  };

  // Resend an existing pending signing link without leaving the modal.
  // Reuses the same claim row (no new record) and the same originally-sent
  // doc set, so the homeowner can pick up where they left off.
  const resendSigningLink = async (h, docsList) => {
    const claim = h.raw_claim;
    if (!claim || !claim.id) {
      alert("Cannot resend — this homeowner has no claim record yet. Open Add Docs and send a new link instead.");
      return;
    }
    if (!h.email) {
      alert("This homeowner doesn't have an email on file. Open Add Docs and add one before resending.");
      return;
    }
    if (!isValidEmail(h.email)) {
      alert("The homeowner email on this record isn't valid. Open Add Docs to correct it and try again.");
      return;
    }
    const key = claim.id;
    setResendingHomeownerKey(key);
    try {
      const docs = (docsList || []).filter(d => ["insp","lor","pac"].includes(d));
      const sendDocs = PA_FORMS_DISABLED
        ? (docs.filter(d => d === "insp").length ? docs.filter(d => d === "insp") : ["insp"])
        : (docs.length ? docs : ["insp"]);
      const params = new URLSearchParams({
        sign: "1",
        docs: sendDocs.join(","),
        claim: String(claim.id),
      });
      const signingLink = `${window.location.origin}/?${params.toString()}`;
      const subject = isTestMode
        ? `🧪 [TEST] Reminder — Please Sign: ${sendDocs.length > 1 ? "Claim Documents" : documentLabel(sendDocs[0])}`
        : sendDocs.length > 1
          ? "Reminder — Please Sign: Claim Documents"
          : `Reminder — Please Sign: ${documentLabel(sendDocs[0])}`;
      const emailResponse = await fetch("/.netlify/functions/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: [testEmail(h.email)].filter(Boolean),
          subject,
          html: `
            <h2>Signature Reminder</h2>
            <p>Just a friendly reminder — your document${sendDocs.length > 1 ? "s are" : " is"} still waiting for your signature. Click the link below to review and sign.</p>
            <p><a href="${signingLink}">${signingLink}</a></p>
            <p><strong>Forms included:</strong></p>
            <ul>${sendDocs.map(doc => `<li>${documentLabel(doc)}</li>`).join("")}</ul>
            <p><strong>Important:</strong> You can draw your signature or use the bold typed-signature option if you're on a computer without a touchscreen.</p>
          `,
        }),
      });
      await parseJsonResponse(emailResponse, "Resend failed.");
      alert(`✅ Signing link resent to:\n${h.email}`);
    } catch (e) {
      alert("Resend failed: " + (e.message || e));
    } finally {
      setResendingHomeownerKey(null);
    }
  };

  const loadAndOpenMyHomeowners = async () => {
    setMyHomeownersOpen(true);
    setMyHomeownersLoading(true);
    setMyHomeownersSearch("");
    try {
      const repId = data.salesRepId;
      const repName = data.salesRepName;
      if (!repId && !repName) {
        setMyHomeownersList([]);
        return;
      }
      // Build the OR filter — only include parts that have a value to
      // avoid generating a malformed `sales_rep_id.eq.,sales_rep_name.eq.X`
      // query that some Postgrest versions reject.
      const orParts = [];
      if (repId) orParts.push(`sales_rep_id.eq.${repId}`);
      if (repName) orParts.push(`sales_rep_name.eq.${repName}`);
      const orFilter = orParts.join(",");

      const { data: claims } = await supabase
        .from("claims")
        .select("id, homeowner1, homeowner2, address, city, state, zip, phone, signed_by_email, homeowner_email, signed_at, docs_signed, sales_rep_id, sales_rep_name")
        .or(orFilter)
        .order("signed_at", { ascending: false })
        .limit(200);

      const { data: insps } = await supabase
        .from("inspections")
        .select("id, client_name, address, city, state, zip, mobile, email, signed_at, docs_signed, sales_rep_id, sales_rep_name, result, cancelled_at")
        .or(orFilter)
        .is("cancelled_at", null)
        .order("signed_at", { ascending: false })
        .limit(200);

      const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
      const byKey = new Map();
      for (const c of claims || []) {
        const name = [c.homeowner1, c.homeowner2].filter(Boolean).join(" & ");
        const key = `${norm(name.split("&")[0].trim())}|${(c.zip || "").trim()}`;
        byKey.set(key, {
          source: "claim",
          claim_id: c.id,
          name,
          address: c.address || "",
          city: c.city || "",
          state: c.state || "",
          zip: c.zip || "",
          phone: c.phone || "",
          email: c.signed_by_email || c.homeowner_email || "",
          signed_at: c.signed_at,
          docs_signed: c.docs_signed || "",
          raw_claim: c,
        });
      }
      for (const i of insps || []) {
        const key = `${norm((i.client_name || "").split("&")[0].trim())}|${(i.zip || "").trim()}`;
        if (!byKey.has(key)) {
          byKey.set(key, {
            source: "insp",
            insp_id: i.id,
            name: i.client_name || "",
            address: i.address || "",
            city: i.city || "",
            state: i.state || "",
            zip: i.zip || "",
            phone: i.mobile || "",
            email: i.email || "",
            signed_at: i.signed_at,
            docs_signed: i.docs_signed || "insp",
            raw_insp: i,
          });
        } else {
          byKey.get(key).insp_id = i.id;
          byKey.get(key).raw_insp = i;
        }
      }
      const merged = [...byKey.values()].sort((a, b) => {
        const ta = a.signed_at ? new Date(a.signed_at).getTime() : 0;
        const tb = b.signed_at ? new Date(b.signed_at).getTime() : 0;
        return tb - ta;
      });
      setMyHomeownersList(merged);
      // Refresh the pending count so the input-screen badge stays accurate.
      setPendingHomeownersCount(merged.filter(h => !h.signed_at).length);
    } catch (e) {
      alert("Could not load homeowners: " + (e.message || e));
    } finally {
      setMyHomeownersLoading(false);
    }
  };

  const checkForExistingByAddress = async (address, zip) => {
    const a = (address || "").trim();
    const z = (zip || "").trim();
    if (!a) return true; // nothing to check — let the submit proceed

    try {
      // Look back 90 days for any inspection at this address+zip.
      // Address match is case-insensitive (ilike) and tolerant of leading/trailing
      // whitespace differences. Whitespace inside the string still matters somewhat
      // but ilike with the exact address handles most real-world cases.
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      let query = supabase
        .from("inspections")
        .select("id, client_name, address, zip, signed_at, jn_job_id, sales_rep_name, docs_signed, cancelled_at")
        .ilike("address", a)
        .gte("signed_at", since)
        .is("cancelled_at", null);
      if (z) query = query.eq("zip", z);
      const { data: matches } = await query;

      if (!matches || matches.length === 0) return true; // no duplicate, safe to proceed

      // Build a friendly confirm message. Show the rep WHO it was and HOW LONG ago.
      const recent = matches[0];
      const daysAgo = recent.signed_at
        ? Math.floor((Date.now() - new Date(recent.signed_at).getTime()) / (24 * 60 * 60 * 1000))
        : null;
      const ageStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;

      const msg =
        `⚠️ DUPLICATE WARNING\n\n` +
        `An inspection for ${recent.address} (zip ${recent.zip || "—"}) was already created ${ageStr}` +
        ` by ${recent.sales_rep_name || "(unknown rep)"}.\n\n` +
        `Homeowner on file: ${recent.client_name}\n\n` +
        `To AVOID a duplicate, cancel here and instead use:\n` +
        `📋 My Homeowners → find this property → click "Add Docs"\n\n` +
        `Click OK to create a new record anyway, or Cancel to go back.`;

      return window.confirm(msg);
    } catch (e) {
      // If the check itself fails for some reason, don't block the rep — let them proceed.
      // The DB trigger is the safety net.
      console.warn("Duplicate check failed (non-blocking):", e);
      return true;
    }
  };

  const update = (key, value) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  // Auto-load this-week stats banner when a rep selects themselves.
  // We refresh once per session per rep so the banner shows up promptly
  // but we don't repeatedly hit the DB on every keystroke.
  useEffect(() => {
    if (!data.salesRepId || !data.salesRepName) {
      setBannerStats(null);
      setPendingHomeownersCount(0);
      return;
    }
    fetchMyStats(data.salesRepId, data.salesRepName);
    // Also refresh the awaiting-signature count so the input-screen button
    // shows an accurate badge before the rep ever opens the modal.
    (async () => {
      try {
        const orParts = [];
        if (data.salesRepId) orParts.push(`sales_rep_id.eq.${data.salesRepId}`);
        if (data.salesRepName) orParts.push(`sales_rep_name.eq.${data.salesRepName}`);
        const { count } = await supabase
          .from("claims")
          .select("id", { count: "exact", head: true })
          .or(orParts.join(","))
          .is("signed_at", null);
        setPendingHomeownersCount(count || 0);
      } catch (e) {
        console.warn("Pending count fetch failed (non-blocking):", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.salesRepId, data.salesRepName]);

  const parseJsonResponse = async (response, fallbackMessage) => {
    const rawText = await response.text();
    let result = {};

    try {
      result = rawText ? JSON.parse(rawText) : {};
    } catch {
      if (!response.ok) throw new Error(fallbackMessage);
      throw new Error(rawText || fallbackMessage);
    }

    if (!response.ok) {
      throw new Error(result.error || fallbackMessage);
    }

    return result;
  };

  const toggleDocSelection = (doc) => {
    // Disallow toggling docs that are already signed for an existing homeowner
    if (alreadySignedDocs.includes(doc)) return;
    // Temporary block: PA forms are disabled until new PA is ready.
    if (PA_FORMS_DISABLED && (doc === "lor" || doc === "pac")) return;
    setSelectedDocs((prev) => {
      if (prev.includes(doc)) {
        const next = prev.filter((item) => item !== doc);
        return next.length ? next : prev;
      }
      const next = [...prev, doc];
      return VALID_DOCS.filter((item) => next.includes(item));
    });
  };



  const beginDocumentFlow = async () => {
    // Final guard for PA_FORMS_DISABLED — strip lor/pac before entering
    // the signing/review flow regardless of how they got into selectedDocs.
    if (PA_FORMS_DISABLED && selectedDocs.some(d => d === "lor" || d === "pac")) {
      const filtered = selectedDocs.filter(d => d !== "lor" && d !== "pac");
      if (!filtered.length) {
        alert("PA forms are temporarily disabled. Please select the inspection agreement to continue.");
        return;
      }
      setSelectedDocs(filtered);
      // Bail this click — the state update will re-render; rep clicks Continue again.
      return;
    }
    if (!selectedDocs.length) {
      alert("Please select at least one form.");
      return;
    }

    if (!data.salesRepId) {
      alert("Please select a sales rep before continuing.");
      // Scroll to the rep field
      document.getElementById("rep-search-field")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Check for duplicate address
    const dupe = await checkForDuplicate();
    if (dupe) {
      setDuplicateRecord(dupe);
      setView("duplicate");
      return;
    }

    setPendingSend(signMode === "send");
    setCurrentClaimId(null);
    setAuditInfo(initialAuditInfo);
    setSig1("");
    setSig2("");
    setTypedSig1("");
    setTypedSig2("");
    setSigMethod1("draw");
    setSigMethod2("draw");
    setInitialsMethod1("draw");
    setInitialsMethod2("draw");
    setData((prev) => ({ ...prev, initials1: "", initials2: "" }));
    setInitials1Typed("");
    setInitials2Typed("");
    setLorAgreed(false);
    setPacAgreed(false);
    setInspAgreed(false);
    setSubmitAttempted(false);
    setInspSig("");
    setInspTypedSig("");
    setInspSubmitAttempted(false);
    setInspectionOnly(false);
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Pre-populate inspection fields
    if (selectedDocs.includes("insp")) {
      setInspData(prev => ({
        ...prev,
        clientName: [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ") || prev.clientName,
        mobile: data.phone || prev.mobile,
        address: data.address || prev.address,
        city: data.city || prev.city,
        state: data.state || prev.state,
        zip: data.zip || prev.zip,
        email: data.signerEmail || prev.email,
      }));
    }

    // Send for signing — skip review page entirely, go straight to send
    if (signMode === "send") {
      setView("sending");
      return;
    }

    // Sign now — go to review page to authorize and sign
    setView("review");
  };

  const effectiveSig1 =
    sigMethod1 === "type" ? typedSignatureToDataUrl(typedSig1, sigFont1) : sig1;
  const effectiveSig2 =
    sigMethod2 === "type" ? typedSignatureToDataUrl(typedSig2, sigFont2) : sig2;

  const effectiveInitials1 =
    initialsMethod1 === "type"
      ? typedInitialsToDataUrl(initials1Typed, initialsFont1)
      : data.initials1;

  const effectiveInitials2 =
    initialsMethod2 === "type"
      ? typedInitialsToDataUrl(initials2Typed, initialsFont2)
      : data.initials2;

  const missingSigningFields = (() => {
    if (pendingSend) return [];
    const missing = [];
    // Skip sales-rep-name validation on the recipient (signing-from-link)
    // side — the homeowner can't fix it, and the rep name should
    // already be persisted on the claim record from when the rep
    // sent the link. Keep the check for the rep-side "Sign Now" flow.
    if (!isSigningFromLink && !data.salesRepName) missing.push("Sales rep name");
    if (!effectiveSig1) missing.push("Homeowner 1 signature");
    if (hasSecond && !effectiveSig2) missing.push("Homeowner 2 signature");
    if (selectedDocs.includes("pac")) {
      if (!effectiveInitials1) missing.push("Homeowner 1 initials");
      if (hasSecond && !effectiveInitials2) {
        missing.push("Homeowner 2 initials");
      }
    }
    return missing;
  })();

  const isSigningComplete = missingSigningFields.length === 0;

  const generatePDF = async (selector, filename) => {
    setIsExportingPdf(true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const element = document.querySelector(selector);
    if (!element) {
      setIsExportingPdf(false);
      throw new Error("Printable document not found.");
    }

    try {
      const opt = {
        margin: 0,
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 1.5,
          useCORS: true,
          allowTaint: true,
          logging: false,
          ignoreElements: (el) => el.tagName === "IMG" && el.naturalWidth === 0,
          scrollX: 0,
          scrollY: 0,
        },
        jsPDF: {
          unit: "in",
          format: "letter",
          orientation: "portrait",
        },
        pagebreak: { mode: ["css"] },
      };

      return await html2pdf().set(opt).from(element).outputPdf("blob");
    } finally {
      setIsExportingPdf(false);
    }
  };

  const previewDocument = async (doc) => {
    try {
      const selector =
        doc === "lor" ? "#lor-printable-document" : "#pac-printable-document";
      const filename = documentFilename(doc);
      const blob = await generatePDF(selector, filename);
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
      alert(err?.message || "Failed to open preview.");
    }
  };

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

  const saveClaimToSupabase = async (audit = null) => {
    // When adding docs to an existing homeowner, preserve the previously-signed
    // docs in docs_signed (so the column reflects the cumulative state, not just
    // this session's docs). The merged set is the union of already-signed + this session.
    const mergedDocs = (() => {
      const set = new Set(selectedDocs);
      for (const d of alreadySignedDocs) set.add(d);
      return [...set].join(",");
    })();
    const payload = {
      date: data.date,
      insurance_company: data.insuranceCompany,
      policy_number: data.policyNumber,
      claim_number: data.claimNumber,
      sales_rep_name: data.salesRepName || "",
      sales_rep_email: data.salesRepEmail || "",
      sales_rep_id: data.salesRepId || "",
      docs_signed: mergedDocs,
      homeowner1: data.homeowner1,
      homeowner2: data.homeowner2,
      phone: data.phone,
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.zip,
      loss_location: data.lossLocation,
      date_of_loss: data.dateOfLoss,
      situation: data.situation,
      homeowner_email: data.signerEmail,
      pa_email: data.paEmail,
      signature1: effectiveSig1,
      signature2: effectiveSig2,
      initials1: effectiveInitials1,
      initials2: effectiveInitials2,
      signed_at: audit?.signedAt || null,
      signed_ip: audit?.signedIp || null,
      signed_user_agent: audit?.signedUserAgent || null,
      sign_method: audit?.signMethod || null,
      signed_by_email: audit?.signedByEmail || null,
      signed_by_name: audit?.signedByName || null,
      signed_city: audit?.signedCity || null,
      signed_region: audit?.signedRegion || null,
    };

    if (currentClaimId) {
      const { data: updated, error } = await supabase
        .from("claims")
        .update(payload)
        .eq("id", currentClaimId)
        .select()
        .single();

      return { record: updated, error };
    }

    const { data: inserted, error } = await supabase
      .from("claims")
      .insert([payload])
      .select()
      .single();

    if (inserted?.id) setCurrentClaimId(inserted.id);
    return { record: inserted, error };
  };

  const submitInspection = async () => {
    // Synchronous re-entrancy guard — flip BEFORE any await so a fast
    // double-tap can't slip a second call through while the first is
    // in flight. Reset on every early-return and in the finally below.
    if (inspSubmittingRef.current) return;
    inspSubmittingRef.current = true;
    setInspSubmitAttempted(true);
    if (!effectiveInspSig || !inspData.clientName || !inspData.address) {
      inspSubmittingRef.current = false;
      return;
    }
    // Block submit if a non-empty email is malformed. JN's API rejects the
    // create-contact call with a 400 if the email field doesn't pass its own
    // validator (e.g. "ppumphrey" with no @domain), which silently orphans
    // the record. Catch this at intake instead.
    if (!isValidEmail(inspData.email)) {
      alert("The email address is not valid. Please correct it (e.g. name@example.com) or clear the field.");
      inspSubmittingRef.current = false;
      return;
    }
    setInspSubmitting(true);
    // Pre-flight duplicate check by address+zip. If a recent inspection exists
    // for the same property, warn the rep and let them cancel.
    const okToProceed = await checkForExistingByAddress(inspData.address, inspData.zip);
    if (!okToProceed) {
      setInspSubmitting(false);
      inspSubmittingRef.current = false;
      return;
    }
    try {
      // Generate PDF
      const blob = await generatePDF("#inspection-printable", "Free-Roof-Inspection-Agreement.pdf");
      const base64 = await blobToBase64(blob);
      const base64Content = String(base64).split(",")[1];

      // Save to Supabase inspections table
      const { data: insertedInsp, error: inspSaveError } = await supabase.from("inspections").insert([{
        client_name: inspData.clientName,
        mobile: inspData.mobile,
        email: inspData.email,
        address: inspData.address,
        city: inspData.city,
        state: inspData.state,
        zip: inspData.zip,
        date: inspData.date,
        sales_rep_name: data.salesRepName || "",
        sales_rep_id: data.salesRepId || "",
        sales_rep_email: data.salesRepEmail || "",
        lead_source: data.leadSource || "Inspection",
      }]).select("id").single();
      if (inspSaveError) {
        console.error("Inspection save error:", inspSaveError);
        // Detect the trigger's duplicate-block error and show a friendly message
        // routing the rep to My Homeowners instead of the raw SQL exception.
        if (inspSaveError.message && inspSaveError.message.includes("DUPLICATE_INSPECTION")) {
          alert(
            "⚠️ This address was already submitted within the last 5 minutes.\n\n" +
            "If you're adding more documents to an existing record, please use:\n" +
            "📋 My Homeowners → find this property → click \"Add Docs\""
          );
          setInspSubmitting(false);
          return;
        }
        alert("Warning: Could not save to database — " + inspSaveError.message);
      }
      const newInspId = insertedInsp?.id || null;

      // Fire-and-forget: geocode the new inspection's address into
      // latitude/longitude so the Inspector mobile app can immediately
      // distance-route this job to the closest inspector. Runs server-
      // side via /.netlify/functions/geocode-inspection. Failure here
      // is non-fatal — admin can backfill later via
      // /.netlify/functions/bulk-geocode-inspections.
      if (newInspId) {
        fetch("/.netlify/functions/geocode-inspection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: newInspId }),
        }).catch((e) => console.warn("Geocode trigger failed (non-fatal):", e?.message));
      }

      // Email to homeowner
      if (inspData.email) {
        // Generate USS welcome PDF
        let ussWelcomeAttachment = null;
        try {
          const ussBlob = await generatePDF("#uss-welcome-printable", "USS-Welcome-Package.pdf");
          const ussBase64 = await blobToBase64(ussBlob);
          ussWelcomeAttachment = { filename: "USS-Welcome-Package.pdf", content: String(ussBase64).split(",")[1] };
        } catch(e) { console.warn("USS welcome PDF failed:", e); }

        const inspAttachments = [{ filename: "Free-Roof-Inspection-Agreement.pdf", content: base64Content }];
        if (ussWelcomeAttachment) inspAttachments.push(ussWelcomeAttachment);

        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [testEmail(inspData.email)],
            subject: `${isTestMode ? "🧪 [TEST] " : ""}Your Free Roof Inspection Agreement — U.S. Shingle & Metal`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: #0a0a0a; padding: 24px 32px; border-radius: 12px 12px 0 0;">
                  <h1 style="color: #fff; margin: 0; font-size: 22px;">🏠 Your Inspection Agreement</h1>
                </div>
                <div style="background: #f9fafb; padding: 24px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  <p style="font-size: 15px; color: #374151;">Hi ${inspData.clientName},</p>
                  <p style="font-size: 15px; color: #374151; line-height: 1.6;">
                    Thank you for signing your Free Roof Inspection Agreement with U.S. Shingle & Metal LLC.
                    Your signed agreement and welcome package are attached. We will be in touch shortly to schedule your inspection.
                  </p>
                  <div style="background: #eef1f8; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px 20px; margin: 16px 0;">
                    <p style="margin: 0; font-weight: 700; color: #0a0a0a;">📎 Attached:</p>
                    <ul style="margin: 8px 0 0; padding-left: 18px; color: #374151; font-size: 14px; line-height: 1.8;">
                      <li>Free Roof Inspection Agreement (signed copy)</li>
                      <li>USS Welcome Package — what to expect next</li>
                    </ul>
                  </div>
                  <div style="background: #0a0a0a; border-radius: 10px; padding: 16px 20px; margin: 16px 0;">
                    <p style="margin: 0; font-weight: 700; color: #fff;">📞 Questions? Contact us:</p>
                    <p style="margin: 6px 0 0; color: rgba(255,255,255,0.85); font-size: 14px;">
                      Phone: ${ussContactPhone}<br/>Email: ${ussContactEmail}
                    </p>
                  </div>
                </div>
              </div>
            `,
            attachments: inspAttachments,
            bcc: activityEmail ? [activityEmail] : [],
          }),
        }).catch(e => console.warn("Homeowner email non-fatal:", e));
      }

      // ── Archive signed inspection PDF to Supabase Storage ──────────────────
      // Free-Inspection-only flow: archive the signed insp PDF so it can be
      // re-sent later via the admin Re-send Docs button.
      if (newInspId && base64Content) {
        const pdfsToArchive = {
          insp: { filename: "Free-Roof-Inspection-Agreement.pdf", base64: base64Content },
        };
        fetch("/.netlify/functions/archive-signed-docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: newInspId, pdfs: pdfsToArchive }),
        }).then(r => r.ok ? console.log("📁 Inspection PDF archived") : console.warn("Archive returned not-ok"))
          .catch(e => console.warn("Archive call failed (non-fatal):", e));
      }

      // ── Job Nimbus sync ──────────────────────────────────────────────────
      // Fire JN sync and capture job ID to update Supabase record
      fetch("/.netlify/functions/jobnimbus-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadSource: data.leadSource || "Inspection",
          docsSignedList: ["insp"],
          homeowner1: inspData.clientName || data.homeowner1 || "",
          homeowner2: "",
          phone: inspData.mobile || data.phone || "",
          email: inspData.email || data.signerEmail || "",
          address: inspData.address || data.address || "",
          city: inspData.city || data.city || "",
          state: inspData.state || data.state || "",
          zip: inspData.zip || data.zip || "",
          salesRepName: data.salesRepName || "",
          salesRepId: data.salesRepId || "",
          pdfBase64: base64Content,
          pdfFilename: "Free-Roof-Inspection-Agreement.pdf",
          isTest: isTestMode,
          testOverrideEmail: isTestMode ? testOverrideEmail : undefined,
          testOverridePhone: isTestMode ? testOverridePhone : undefined,
        }),
      }).then(async r => {
        const d = await r.json().catch(() => ({}));
        console.log("JN sync (inspection):", d);
        // Save jn_job_id and docs_signed back to Supabase so checker can match.
        // Uses the captured Supabase record id from the insert above — much
        // more reliable than re-matching by client_name+address, which used
        // to silently fail on any whitespace or case mismatch.
        if (d.jobId && newInspId) {
          const { error: updateErr } = await supabase
            .from("inspections")
            .update({ jn_job_id: d.jobId, docs_signed: "insp" })
            .eq("id", newInspId);
          if (updateErr) console.warn("Failed to save jn_job_id:", updateErr.message);
          else console.log("Saved jn_job_id:", d.jobId, "to record:", newInspId);
        } else if (d.jobId && !newInspId) {
          // Fallback — insert didn't return an id (rare). Try the old path.
          const { error: updateErr } = await supabase
            .from("inspections")
            .update({ jn_job_id: d.jobId, docs_signed: "insp" })
            .eq("client_name", inspData.clientName)
            .eq("address", inspData.address);
          if (updateErr) console.warn("Fallback jn_job_id save failed:", updateErr.message);
          else console.log("Saved jn_job_id via fallback:", d.jobId);
        }
      }).catch(e => console.warn("JN sync non-fatal:", e));

      // Reset inspection sig fields
      setInspSig("");
      setInspTypedSig("");
      setInspSubmitAttempted(false);

      // ── Activity notification email ──
      if (activityEmail) {
        const repName = data.salesRepName || "—";
        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [activityEmail],
            subject: `🏠 New Inspection — ${inspData.clientName} (${repName})`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
                <div style="background: #0a0a0a; padding: 20px 28px; border-radius: 12px 12px 0 0;">
                  <h2 style="color: #fff; margin: 0; font-size: 20px;">🏠 New Inspection Signed</h2>
                </div>
                <div style="background: #f9fafb; padding: 24px 28px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 5px 0; font-weight: 700; width: 130px;">Client:</td><td>${inspData.clientName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Address:</td><td>${[inspData.address, inspData.city, inspData.state, inspData.zip].filter(Boolean).join(", ")}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Rep:</td><td>${repName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Doc:</td><td>Free Roof Inspection Agreement</td></tr>
                    ${inspData.mobile ? `<tr><td style="padding: 5px 0; font-weight: 700;">Phone:</td><td>${inspData.mobile}</td></tr>` : ""}
                    ${inspData.email ? `<tr><td style="padding: 5px 0; font-weight: 700;">Email:</td><td>${inspData.email}</td></tr>` : ""}
                  </table>
                </div>
              </div>
            `,
          }),
        }).catch(e => console.warn("Activity email non-fatal:", e));
      }

      // Go to thank you page
      window.scrollTo({ top: 0, behavior: "smooth" });
      setInspectionOnly(true);
      setView("thankyou");

    } catch (err) {
      alert(err?.message || "Something went wrong. Please try again.");
    } finally {
      setInspSubmitting(false);
      inspSubmittingRef.current = false;
    }
  };

  const submitDoc = async () => {
    try {
      setSubmitAttempted(true);
      if (!pendingSend && !isSigningComplete) {
        return;
      }

      // Block submit if any email field is non-empty but malformed. JN's
      // create-contact API rejects bad emails with a 400, silently orphaning
      // the record. Same problem as the inspection flow — catch at intake.
      if (!isValidEmail(data.signerEmail)) {
        alert("The homeowner email is not valid. Please correct it (e.g. name@example.com) or clear the field.");
        return;
      }
      if (!isValidEmail(data.paEmail)) {
        alert("The PA email is not valid. Please correct it (e.g. name@example.com) or clear the field.");
        return;
      }

      // Pre-flight duplicate check — only matters when this is creating a NEW
      // claim record. If we're updating an existing one (existingClaim or
      // currentClaimId is set, e.g. from My Homeowners flow), skip the check.
      if (!currentClaimId && !existingClaim) {
        const okToProceed = await checkForExistingByAddress(data.address, data.zip);
        if (!okToProceed) return;
      }

      setIsSubmitting(true);

      if (pendingSend) {
        const { record, error } = await saveClaimToSupabase(null);
        if (error) {
          alert("Error saving: " + error.message);
          return;
        }

        const params = new URLSearchParams({
          sign: "1",
          docs: selectedDocs.join(","),
          claim: String(record?.id || ""),
        });

        const signingLink = `${window.location.origin}/?${params.toString()}`;

        const emailResponse = await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [testEmail(data.signerEmail)].filter(Boolean),
            subject: isTestMode
              ? `🧪 [TEST] Please Sign: ${selectedDocs.length > 1 ? "Claim Documents" : documentLabel(selectedDocs[0])}`
              : selectedDocs.length > 1
                ? "Please Sign: Claim Documents"
                : `Please Sign: ${documentLabel(selectedDocs[0])}`,
            html: `
              <h2>Signature Requested</h2>
              <p>Please click the link below to review and sign your document${
                selectedDocs.length > 1 ? "s" : ""
              }.</p>
              <p><a href="${signingLink}">${signingLink}</a></p>
              <p><strong>Forms included:</strong></p>
              <ul>${selectedDocs
                .map((doc) => `<li>${documentLabel(doc)}</li>`)
                .join("")}</ul>
              <p><strong>Important:</strong> You can draw your signature or use the bold typed-signature option if you are on a computer without a touchscreen.</p>
            `,
          }),
        });

        await parseJsonResponse(emailResponse, "Signing email failed.");
        setIsSubmitting(false);
        setPendingSend(false);

        // Show clear confirmation before resetting
        const sentTo = data.signerEmail || "the homeowner";
        alert(`✅ Signing link sent successfully!\n\nAn email with the signing link has been sent to:\n${sentTo}\n\nThey can sign from any phone, tablet, or computer.`);

        setView("input");
        return;
      }

      let nextAuditInfo = {
        signedAt: new Date().toISOString(),
        signedIp: "",
        signedUserAgent: navigator.userAgent || "",
        signMethod: isSigningFromLink ? "email_link" : "sign_now",
        signedByEmail: data.signerEmail || "",
        signedByName: [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
        signedCity: "",
        signedRegion: "",
      };

      try {
        const auditResponse = await fetch("/.netlify/functions/sign-audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            claimId: currentClaimId,
            docType: selectedDocs.join(","),
            signMethod: isSigningFromLink ? "email_link" : "sign_now",
            signedByEmail: data.signerEmail,
            signedByName: [data.homeowner1, data.homeowner2].filter(Boolean).join(", "),
          }),
        });
        const serverAudit = await parseJsonResponse(auditResponse, "Audit failed.");
        nextAuditInfo = {
          signedAt: serverAudit.signedAt || nextAuditInfo.signedAt,
          signedIp: serverAudit.signedIp || "",
          signedUserAgent: serverAudit.signedUserAgent || navigator.userAgent || "",
          signMethod: serverAudit.signMethod || nextAuditInfo.signMethod,
          signedByEmail: serverAudit.signedByEmail || data.signerEmail || "",
          signedByName: serverAudit.signedByName || nextAuditInfo.signedByName,
          signedCity: serverAudit.signedCity || "",
          signedRegion: serverAudit.signedRegion || "",
        };
      } catch(auditErr) {
        console.warn("Audit non-fatal:", auditErr);
      }

      setAuditInfo(nextAuditInfo);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Only save to claims table if PA docs are included
      if (selectedDocs.includes("lor") || selectedDocs.includes("pac")) {
        const { error } = await saveClaimToSupabase(nextAuditInfo);
        if (error) {
          console.warn("Claims save error:", error.message);
        }
      }

      const attachments = [];

      // Track the inspection id we created (if any) so we can archive PDFs against it
      let archiveInspectionId = null;

      if (selectedDocs.includes("insp")) {
        // Save to inspections table
        const { data: insertedInsp, error: inspInsertErr } = await supabase.from("inspections").insert([{
          client_name: [data.homeowner1, data.homeowner2].filter(Boolean).join(" & "),
          mobile: data.phone,
          email: data.signerEmail,
          address: data.address,
          city: data.city,
          state: data.state,
          zip: data.zip,
          date: data.date,
          sales_rep_name: data.salesRepName || "",
          sales_rep_id: data.salesRepId || "",
          sales_rep_email: data.salesRepEmail || "",
          lead_source: data.leadSource || "Inspection",
        }]).select("id").single();
        if (inspInsertErr) {
          console.error("Inspection insert error:", inspInsertErr);
          if (inspInsertErr.message && inspInsertErr.message.includes("DUPLICATE_INSPECTION")) {
            alert(
              "⚠️ This address was already submitted within the last 5 minutes.\n\n" +
              "If you're adding more documents to an existing record, please use:\n" +
              "📋 My Homeowners → find this property → click \"Add Docs\""
            );
            setIsSubmitting(false);
            return;
          }
        }
        archiveInspectionId = insertedInsp?.id || null;

        // Fire-and-forget geocode of the new inspection — populates
        // latitude/longitude so the Inspector mobile app's distance
        // routing has data immediately. Non-fatal on failure.
        if (archiveInspectionId) {
          fetch("/.netlify/functions/geocode-inspection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inspectionId: archiveInspectionId }),
          }).catch((e) => console.warn("Geocode trigger failed (non-fatal):", e?.message));
        }

        try {
          const inspBlob = await generatePDF(
            "#inspection-printable",
            documentFilename("insp")
          );
          const inspBase64 = await blobToBase64(inspBlob);
          attachments.push({
            filename: documentFilename("insp"),
            content: String(inspBase64).split(",")[1],
          });
        } catch (e) {
          console.warn("Inspection PDF failed:", e);
        }
      }

      if (selectedDocs.includes("lor")) {
        const lorBlob = await generatePDF(
          "#lor-printable-document",
          documentFilename("lor")
        );
        const lorBase64 = await blobToBase64(lorBlob);
        attachments.push({
          filename: documentFilename("lor"),
          content: String(lorBase64).split(",")[1],
        });
      }

      if (selectedDocs.includes("pac")) {
        const pacBlob = await generatePDF(
          "#pac-printable-document",
          documentFilename("pac")
        );
        const pacBase64 = await blobToBase64(pacBlob);
        attachments.push({
          filename: documentFilename("pac"),
          content: String(pacBase64).split(",")[1],
        });
      }

      // Attach welcome package — USS for inspection-only, CCG for PA docs
      const isInspOnly = selectedDocs.includes("insp") && !selectedDocs.includes("lor") && !selectedDocs.includes("pac");
      try {
        const welcomeSelector = isInspOnly ? "#uss-welcome-printable" : "#ty-summary-printable";
        const welcomeFilename = isInspOnly ? "USS-Welcome-Package.pdf" : "HealthyHomes-Welcome-Package.pdf";
        const welcomeBlob = await generatePDF(welcomeSelector, welcomeFilename);
        const welcomeBase64 = await blobToBase64(welcomeBlob);
        attachments.push({ filename: welcomeFilename, content: String(welcomeBase64).split(",")[1] });
      } catch (e) {
        console.warn("Welcome package PDF failed, skipping:", e);
      }

      const emailSubject = isInspOnly
        ? "Your Free Roof Inspection Agreement — U.S. Shingle & Metal"
        : "Your Signed Documents — Healthy Homes Public Adjusting";
      const emailHeaderBg = isInspOnly ? "#0a0a0a" : "#199c2e";
      const emailHeaderText = isInspOnly ? "🏠 Your Inspection Agreement" : "🎉 You're All Set!";
      const emailWelcomeLine = isInspOnly
        ? `Your signed inspection agreement and USS welcome package are attached.`
        : `Your documents are signed and we're officially on the case. <strong>We've attached everything to this email</strong> for your records:`;
      const emailDocList = isInspOnly
        ? `<li><strong>Free Roof Inspection Agreement</strong> — your signed copy</li><li><strong>USS Welcome Package</strong> — what to expect next</li>`
        : `${selectedDocs.map(d => `<li><strong>${documentLabel(d)}</strong> — your signed copy</li>`).join("")}<li><strong>Healthy Homes Welcome Package</strong> — what to expect next &amp; our contact info</li>`;
      const emailContactBg = isInspOnly ? "#0a0a0a" : "#f0fdf4";
      const emailContactColor = isInspOnly ? "#fff" : "#166534";
      const emailContactInfo = isInspOnly
        ? `Phone: ${ussContactPhone}<br/>Email: ${ussContactEmail}`
        : `Phone: 561-283-5674<br/>Email: Kkeckleradj@gmail.com<br/>Website: propertydamageinspection.com`;

      const finalEmailResponse = await fetch("/.netlify/functions/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: [testEmail(data.signerEmail)].filter(Boolean),
          bcc: activityEmail ? [activityEmail] : [],
          subject: `${isTestMode ? "🧪 [TEST] " : ""}${emailSubject}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: ${emailHeaderBg}; padding: 28px 32px; border-radius: 12px 12px 0 0;">
                <h1 style="color: #fff; margin: 0; font-size: 24px;">${emailHeaderText}</h1>
              </div>
              <div style="background: #f9fafb; padding: 28px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                <p style="font-size: 16px; color: #111827; margin-top: 0;">
                  Hi ${[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")},
                </p>
                <p style="font-size: 15px; color: #374151; line-height: 1.6;">${emailWelcomeLine}</p>
                <ul style="font-size: 15px; color: #374151; line-height: 1.8;">${emailDocList}</ul>
                <div style="background: ${emailContactBg}; border-radius: 10px; padding: 18px 20px; margin: 20px 0;">
                  <p style="margin: 0 0 8px; font-weight: 700; color: ${emailContactColor};">📞 Need to reach us?</p>
                  <p style="margin: 0; color: ${emailContactColor}; font-size: 14px; line-height: 1.7;">${emailContactInfo}</p>
                </div>
                <p style="font-size: 14px; color: #6b7280; margin-bottom: 0;">
                  <em>Signed at: ${nextAuditInfo.signedAt || ""}</em>
                </p>
              </div>
            </div>
          `,
          attachments,
        }),
      });

      try { await parseJsonResponse(finalEmailResponse, "Homeowner email failed."); }
      catch(emailErr) { console.warn("Homeowner email error (non-fatal):", emailErr); }

      // ── Archive signed PDFs to Supabase Storage (non-blocking, runs in background) ──
      // Convert attachments array → keyed object for archive function consumption.
      // Skips if we don't have an inspection id (e.g. if user signed PA docs only without insp).
      if (archiveInspectionId && attachments.length > 0) {
        const pdfsToArchive = {};
        attachments.forEach(att => {
          const fn = (att.filename || "").toLowerCase();
          let key = "other";
          if (fn.includes("inspection-agreement"))     key = "insp";
          else if (fn.includes("letter-of-rep") || fn.includes("lor")) key = "lor";
          else if (fn.includes("public-adjuster") || fn.includes("pac")) key = "pac";
          else if (fn.includes("welcome"))             key = "welcome";
          pdfsToArchive[key] = { filename: att.filename, base64: att.content };
        });
        // Fire and forget — don't block signing on archive success
        fetch("/.netlify/functions/archive-signed-docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: archiveInspectionId, pdfs: pdfsToArchive }),
        }).then(r => r.ok ? console.log("📁 Signed docs archived to storage") : console.warn("Archive call returned not-ok"))
          .catch(e => console.warn("Archive call failed (non-fatal):", e));
      }

      // ── PA notification email — different content based on claim stage ──
      const isPostInspection = data.claimStage === "post_inspection";
      const homeownerName = [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ") || "Homeowner";
      const homeownerAddress = [data.address, data.city, data.state, data.zip].filter(Boolean).join(", ");

      const paSubject = isPostInspection
        ? `✅ Signed PA Docs — ${homeownerName} (Damage Confirmed)`
        : `📋 Signed PA Docs — ${homeownerName} (Inspection Pending)`;

      const paHtml = isPostInspection ? `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #1e40af; padding: 24px 32px; border-radius: 12px 12px 0 0;">
            <h1 style="color: #fff; margin: 0; font-size: 22px;">✅ Damage Confirmed — Docs Signed</h1>
          </div>
          <div style="background: #f9fafb; padding: 28px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
            <p style="font-size: 15px; color: #374151; line-height: 1.6; margin-top: 0;">
              You inspected this property and confirmed damage. The homeowner has now signed all required documents and is ready to move forward with the claim.
            </p>

            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 18px 20px; margin: 20px 0;">
              <p style="margin: 0 0 10px; font-weight: 700; color: #1e40af; font-size: 15px;">👤 Homeowner Details</p>
              <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 4px 0; font-weight: 600; width: 140px;">Name:</td><td>${homeownerName}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Address:</td><td>${homeownerAddress}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Phone:</td><td>${data.phone || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Email:</td><td>${data.signerEmail || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Insurance Co.:</td><td>${data.insuranceCompany || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Policy #:</td><td>${data.policyNumber || "—"}</td></tr>
                ${data.claimNumber ? `<tr><td style="padding: 4px 0; font-weight: 600;">Claim #:</td><td>${data.claimNumber}</td></tr>` : ""}
                ${data.dateOfLoss ? `<tr><td style="padding: 4px 0; font-weight: 600;">Date of Loss:</td><td>${data.dateOfLoss}</td></tr>` : ""}
              </table>
            </div>

            <p style="font-size: 14px; color: #374151; line-height: 1.6;">
              The signed documents are attached. You're good to proceed with filing the claim.
            </p>
            <p style="font-size: 13px; color: #6b7280; margin-bottom: 0;">
              <em>Signed at: ${nextAuditInfo.signedAt || ""} &nbsp;|&nbsp; IP: ${nextAuditInfo.signedIp || ""}</em>
            </p>
          </div>
        </div>
      ` : `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #d97706; padding: 24px 32px; border-radius: 12px 12px 0 0;">
            <h1 style="color: #fff; margin: 0; font-size: 22px;">📋 Signed Docs — Inspection Needed</h1>
          </div>
          <div style="background: #f9fafb; padding: 28px 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
            <p style="font-size: 15px; color: #374151; line-height: 1.6; margin-top: 0;">
              The homeowner has signed the paperwork. <strong>The roof has not been inspected yet</strong> — the inspection should be scheduled within the week. Please watch for this job in <strong>Job Nimbus</strong> and assign the inspection accordingly.
            </p>

            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 14px 18px; margin: 16px 0;">
              <p style="margin: 0; font-weight: 700; color: #92400e; font-size: 14px;">⚠️ Action Required: Schedule roof inspection within the week</p>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px 20px; margin: 16px 0;">
              <p style="margin: 0 0 10px; font-weight: 700; color: #111827; font-size: 15px;">👤 Homeowner Details</p>
              <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 4px 0; font-weight: 600; width: 140px;">Name:</td><td>${homeownerName}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Address:</td><td>${homeownerAddress}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Phone:</td><td>${data.phone || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Email:</td><td>${data.signerEmail || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Insurance Co.:</td><td>${data.insuranceCompany || "—"}</td></tr>
                <tr><td style="padding: 4px 0; font-weight: 600;">Policy #:</td><td>${data.policyNumber || "—"}</td></tr>
              </table>
            </div>

            <p style="font-size: 14px; color: #374151; line-height: 1.6;">
              Signed documents are attached for your records. Once the inspection confirms damage, proceed with the PA claim process.
            </p>
            <p style="font-size: 13px; color: #6b7280; margin-bottom: 0;">
              <em>Signed at: ${nextAuditInfo.signedAt || ""} &nbsp;|&nbsp; IP: ${nextAuditInfo.signedIp || ""}</em>
            </p>
          </div>
        </div>
      `;

      // Only send PA email if PA docs were included
      if (data.paEmail && (selectedDocs.includes("lor") || selectedDocs.includes("pac"))) {
        const paEmailResponse = await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [testEmail(data.paEmail)],
            subject: `${isTestMode ? "🧪 [TEST] " : ""}${paSubject}`,
            html: paHtml,
            attachments,
          }),
        });
        try { await parseJsonResponse(paEmailResponse, "PA notification email failed."); }
        catch(e) { console.warn("PA email non-fatal:", e); }
      }

      // ── Activity notification email ──
      if (activityEmail) {
        const repName = data.salesRepName || data.representativeName || "—";
        const homeownerName = [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ");
        const homeownerAddress = [data.address, data.city, data.state, data.zip].filter(Boolean).join(", ");
        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [activityEmail],
            subject: `${isTestMode ? "🧪 [TEST] " : ""}📋 New Signing — ${homeownerName} (${repName})`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
                <div style="background: #199c2e; padding: 20px 28px; border-radius: 12px 12px 0 0;">
                  <h2 style="color: #fff; margin: 0; font-size: 20px;">📋 New Signing Activity${isTestMode ? " 🧪 TEST" : ""}</h2>
                </div>
                <div style="background: #f9fafb; padding: 24px 28px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  ${isTestMode ? `<div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#92400e;font-weight:700;">🧪 TEST MODE — emails redirected to ${testOverrideEmail || "override"}</div>` : ""}
                  <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 5px 0; font-weight: 700; width: 130px;">Homeowner:</td><td>${homeownerName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Address:</td><td>${homeownerAddress}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Rep:</td><td>${repName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Docs:</td><td>${selectedDocs.map(d => documentLabel(d)).join(", ")}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Stage:</td><td>${data.claimStage === "post_inspection" ? "✅ Roof Inspected" : "🏠 Pre-Inspection"}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Signed:</td><td>${nextAuditInfo.signedAt || new Date().toLocaleString()}</td></tr>
                    ${data.phone ? `<tr><td style="padding: 5px 0; font-weight: 700;">Phone:</td><td>${data.phone}</td></tr>` : ""}
                    ${data.signerEmail ? `<tr><td style="padding: 5px 0; font-weight: 700;">Email:</td><td>${data.signerEmail}</td></tr>` : ""}
                  </table>
                </div>
              </div>
            `,
          }),
        }).catch(e => console.warn("Activity email non-fatal:", e));
      }

      // ── Rep notification email ──
      if (data.salesRepEmail) {
        const homeownerName = [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ");
        const homeownerAddress = [data.address, data.city, data.state, data.zip].filter(Boolean).join(", ");
        await fetch("/.netlify/functions/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [testEmail(data.salesRepEmail)],
            subject: `${isTestMode ? "🧪 [TEST] " : ""}✅ Signed — ${homeownerName}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
                <div style="background: #199c2e; padding: 20px 28px; border-radius: 12px 12px 0 0;">
                  <h2 style="color: #fff; margin: 0; font-size: 20px;">✅ Your client just signed!</h2>
                </div>
                <div style="background: #f9fafb; padding: 24px 28px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
                  <table style="font-size: 14px; color: #374151; width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 5px 0; font-weight: 700; width: 130px;">Homeowner:</td><td>${homeownerName}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Address:</td><td>${homeownerAddress}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Docs signed:</td><td>${selectedDocs.map(d => documentLabel(d)).join(", ")}</td></tr>
                    <tr><td style="padding: 5px 0; font-weight: 700;">Stage:</td><td>${data.claimStage === "post_inspection" ? "✅ Roof Inspected" : "🏠 Pre-Inspection"}</td></tr>
                    ${data.phone ? `<tr><td style="padding: 5px 0; font-weight: 700;">Phone:</td><td>${data.phone}</td></tr>` : ""}
                    ${data.signerEmail ? `<tr><td style="padding: 5px 0; font-weight: 700;">Email:</td><td>${data.signerEmail}</td></tr>` : ""}
                    ${data.insuranceCompany ? `<tr><td style="padding: 5px 0; font-weight: 700;">Insurance:</td><td>${data.insuranceCompany}</td></tr>` : ""}
                    ${data.policyNumber ? `<tr><td style="padding: 5px 0; font-weight: 700;">Policy #:</td><td>${data.policyNumber}</td></tr>` : ""}
                  </table>
                  <div style="margin-top: 16px; background: #f0fdf4; border-radius: 10px; padding: 12px 16px; font-size: 13px; color: #166534; font-weight: 600;">
                    Signed PDFs have been emailed to the homeowner and PA. Your copy is attached.
                  </div>
                </div>
              </div>
            `,
            attachments,
          }),
        }).catch(e => console.warn("Rep email non-fatal:", e));
      }
      setPendingSend(false);
      setIsSubmitting(false);

      // ── Job Nimbus sync ──────────────────────────────────────────────────
      // Find the inspection PDF attachment if it was generated
      const inspAttachment = attachments.find(a => a.filename && a.filename.toLowerCase().includes("inspection"));
      fetch("/.netlify/functions/jobnimbus-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadSource: data.leadSource || "Inspection",
          docsSignedList: selectedDocs,
          homeowner1: data.homeowner1 || "",
          homeowner2: data.homeowner2 || "",
          phone: data.phone || "",
          email: data.signerEmail || "",
          address: data.address || "",
          city: data.city || "",
          state: data.state || "",
          zip: data.zip || "",
          salesRepName: data.salesRepName || "",
          salesRepId: data.salesRepId || "",
          pdfBase64: inspAttachment?.content || null,
          pdfFilename: inspAttachment?.filename || null,
          isTest: isTestMode,
          testOverrideEmail: isTestMode ? testOverrideEmail : undefined,
          testOverridePhone: isTestMode ? testOverridePhone : undefined,
        }),
      }).then(async r => {
        const d = await r.json().catch(() => ({}));
        console.log("JN sync (submitDoc):", d);
      }).catch(e => console.warn("JN sync non-fatal:", e));

      window.scrollTo({ top: 0, behavior: "smooth" });
      if (isSigningFromLink) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      // Set inspectionOnly flag — insp signed but no PA docs
      setInspectionOnly(selectedDocs.includes("insp") && !selectedDocs.includes("lor") && !selectedDocs.includes("pac"));
      setView("thankyou");
    } catch (err) {
      setIsSubmitting(false);
      alert(err?.message || "Something went wrong. Please try again.");
    }
  };

  // Search filters the currently-loaded list in-memory rather than running
  // a fresh DB query. This preserves the docs_signed enrichment, jn_job_id,
  // signed_pdfs, etc. that the loader sets up. Empty query restores the full list.
  const searchInspectionRecords = async (query) => {
    // Note: this fn is called on every keystroke. We don't actually need to do
    // anything async here anymore — the filter happens in the rendered map via
    // recordSearch state. We keep the function signature so existing wiring works.
    return;
  };

  const genCertNo = (dateStr) => {
    const d = dateStr ? new Date(dateStr + "T12:00:00") : new Date();
    const m = String(d.getMonth()+1).padStart(2,"0"); const dy = String(d.getDate()).padStart(2,"0");
    return `RC-${d.getFullYear()}-${m}${dy}-${Math.floor(Math.random()*9000)+1000}`;
  };

  const fmtDateLong = (dateStr) => {
    if (!dateStr) return "";
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  };

  const fmtDateShort = (dateStr) => {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T12:00:00");
    return `${String(d.getMonth()+1).padStart(2,"0")} / ${String(d.getDate()).padStart(2,"0")} / ${d.getFullYear()}`;
  };

  const addOneYearStr = (dateStr) => {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T12:00:00"); d.setFullYear(d.getFullYear()+1);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  };

  // ── Per-row admin override — manually set result without sending anything ──
  const adminSetRowResult = async (rowId, choice) => {
    if (!rowId || !choice) return;
    setRowBusyId(rowId);
    try {
      const nowIso = new Date().toISOString();
      // Map UI choice to inspection_result (JN format) for column-sync
      const jnResultMap = { damage: "Damage", no_damage: "No Damage", retail: "Retail" };
      const payload = {
        result: choice,
        result_at: nowIso,
        inspection_result: jnResultMap[choice] || null,
      };
      const { error } = await supabase.from("inspections").update(payload).eq("id", rowId);
      if (error) { alert("Update failed: " + error.message); return; }
      // Reflect locally so UI updates without a reload
      setRecordSearchResults(prev => prev.map(r => r.id === rowId ? { ...r, result: choice, result_at: nowIso, checkedStatus: null } : r));
    } catch (e) {
      alert("Update error: " + (e.message || e));
    } finally {
      setRowBusyId(null);
    }
  };

  // ── Per-row manual notify — sends SMS (rep or homeowner) using templates ──
  // target: "rep" or "homeowner". Uses the same template resolution logic as
  // the old auto-send path. Does not send email — just SMS, per the owner's
  // current "silent until owner decides" policy.
  const adminNotifyRow = async (row, target) => {
    if (!row || !target) return;
    if (!row.result) { alert("Set a result for this record first."); return; }
    const resultKey = row.result === "damage" ? "damage"
                    : row.result === "no_damage" ? "nodamage"
                    : row.result === "retail" ? "retail" : null;
    if (!resultKey) { alert("Unknown result — cannot determine template."); return; }

    setRowBusyId(row.id);
    try {
      // Figure out the template variant (insp vs all) the same way as
      // submitInspectionResult does — check claims table for matching address+zip.
      const addr = (row.address || "").trim().toLowerCase();
      const zip  = (row.zip || "").trim();
      let paIsSigned = false;
      if (addr && zip) {
        const { data: claimData } = await supabase
          .from("claims")
          .select("id, docs_signed")
          .ilike("address", addr)
          .eq("zip", zip)
          .order("signed_at", { ascending: false })
          .limit(1);
        const c = claimData?.[0];
        paIsSigned = c && ((c.docs_signed || "").includes("lor") || (c.docs_signed || "").includes("pac"));
      }
      const variant = paIsSigned ? "all" : "insp";

      // Resolve rep + homeowner phones / names
      const homeownerPhone = row.mobile || row.phone || "";
      const homeownerName  = row.client_name || "Homeowner";
      const repName = row.sales_rep_name || "";
      let repPhone = "";
      if (row.sales_rep_id) {
        // inspections.sales_rep_id stores the JobNimbus id for imported reps
        // and a Supabase UUID for manually-added reps. Try matching on
        // jobnimbus_id first, then fall back to matching on the primary id.
        let repData = null;
        const byJn = await supabase.from("sales_reps").select("phone").eq("jobnimbus_id", row.sales_rep_id).maybeSingle();
        if (byJn?.data) repData = byJn.data;
        if (!repData) {
          const byId = await supabase.from("sales_reps").select("phone").eq("id", row.sales_rep_id).maybeSingle();
          if (byId?.data) repData = byId.data;
        }
        // Last resort — match by name (covers cases where sales_rep_id drifted)
        if (!repData && row.sales_rep_name) {
          const byName = await supabase.from("sales_reps").select("phone").ilike("name", row.sales_rep_name).maybeSingle();
          if (byName?.data) repData = byName.data;
        }
        repPhone = repData?.phone || "";
      } else if (row.sales_rep_name) {
        // No sales_rep_id at all — match by name
        const { data: repData } = await supabase.from("sales_reps").select("phone").ilike("name", row.sales_rep_name).maybeSingle();
        repPhone = repData?.phone || "";
      }

      const tvars = {
        client:   homeownerName,
        address:  row.address || "",
        city:     row.city || "",
        rep:      repName || "your rep",
        repPhone: repPhone || "",
      };

      if (target === "rep") {
        const msg = renderSmsTemplate(`${resultKey}_${variant}_rep`, tvars);
        if (!msg) { alert("No rep template found for " + `${resultKey}_${variant}_rep` + ". Configure it in SMS Templates."); return; }
        if (!repPhone) { alert("No rep phone on file — cannot send."); return; }
        if (!window.confirm(`Send this SMS to ${repName || "the rep"} at ${repPhone}?\n\n${msg}`)) return;
        const r = await fetch("/.netlify/functions/ghl-sms", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: repPhone, message: msg, name: repName || "Sales Rep" }),
        });
        if (r.ok) {
          const nowIso = new Date().toISOString();
          await supabase.from("inspections").update({ last_notified_rep_at: nowIso }).eq("id", row.id);
          setRecordSearchResults(prev => prev.map(rr => rr.id === row.id ? { ...rr, last_notified_rep_at: nowIso } : rr));
          alert("✅ SMS sent to rep.");
        } else {
          alert("❌ SMS send failed: " + (await r.text()).slice(0, 200));
        }
      } else if (target === "homeowner") {
        const msg = renderSmsTemplate(`${resultKey}_${variant}_homeowner`, tvars);
        if (!msg) { alert("No homeowner template found for " + `${resultKey}_${variant}_homeowner` + ". Configure it in SMS Templates."); return; }
        if (!homeownerPhone) { alert("No homeowner phone on file — cannot send."); return; }
        if (!window.confirm(`Send this SMS to ${homeownerName} at ${homeownerPhone}?\n\n${msg}`)) return;
        const r = await fetch("/.netlify/functions/ghl-sms", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: homeownerPhone, message: msg, name: homeownerName }),
        });
        if (r.ok) {
          const nowIso = new Date().toISOString();
          await supabase.from("inspections").update({ last_notified_homeowner_at: nowIso }).eq("id", row.id);
          setRecordSearchResults(prev => prev.map(rr => rr.id === row.id ? { ...rr, last_notified_homeowner_at: nowIso } : rr));
          alert("✅ SMS sent to homeowner.");
        } else {
          alert("❌ SMS send failed: " + (await r.text()).slice(0, 200));
        }
      }
    } catch (e) {
      alert("Notify error: " + (e.message || e));
    } finally {
      setRowBusyId(null);
    }
  };

  // ── Per-row PA email — sends damage confirmation + photos to claims@ ──
  // Only works for damage results where all 3 docs are signed (insp + LOR + PAC).
  // Calls the send-pa-email Netlify function which pulls photos from JN.
  const adminNotifyPA = async (row) => {
    if (!row) return;
    if (row.result !== "damage") { alert("PA notification is only for damage results."); return; }

    // Check all 3 docs are signed (via claims table)
    const addr = (row.address || "").trim().toLowerCase();
    const zip  = (row.zip || "").trim();
    let allSigned = false;
    if (addr && zip) {
      const { data: claimData } = await supabase
        .from("claims")
        .select("docs_signed")
        .ilike("address", addr)
        .eq("zip", zip)
        .order("signed_at", { ascending: false })
        .limit(1);
      const c = claimData?.[0];
      const docs = (c?.docs_signed || "");
      allSigned = docs.includes("insp") && docs.includes("lor") && docs.includes("pac");
    }
    if (!allSigned) {
      alert("Cannot notify PA — all 3 documents (Inspection + LOR + PA) must be signed for this property. Verify in Supabase or re-enter signing.");
      return;
    }

    const clientName = row.client_name || "Homeowner";
    const propAddr = [row.address, row.city, row.state, row.zip].filter(Boolean).join(", ");
    if (!window.confirm(`Send damage confirmation email to the PA (Kkeckleradj@gmail.com)?\n\nHomeowner: ${clientName}\nProperty: ${propAddr}\n\nThis will include inspection photos from JobNimbus.`)) return;

    setRowBusyId(row.id);
    try {
      const r = await fetch("/.netlify/functions/send-pa-email", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: row.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        const nowIso = new Date().toISOString();
        await supabase.from("inspections").update({ last_notified_pa_at: nowIso }).eq("id", row.id);
        setRecordSearchResults(prev => prev.map(rr => rr.id === row.id ? { ...rr, last_notified_pa_at: nowIso } : rr));
        alert(`✅ Email sent to PA. Photos: ${d.photoCount}`);
      } else {
        alert("❌ PA email failed: " + (d.error || (await r.text()).slice(0, 200)));
      }
    } catch (e) {
      alert("PA email error: " + (e.message || e));
    } finally {
      setRowBusyId(null);
    }
  };

  // ── Retry JN sync for orphaned inspections ──────────────────────────
  // When homeowner signs, we fire a JN sync async. If JN's API times out
  // or errors, the sync fails silently and we get an orphan (no jn_job_id).
  // This admin-only button calls retry-jn-sync which re-pushes the record.
  const adminRetryJnSync = async (row) => {
    if (!row) return;
    if (row.jn_job_id) { alert("This record is already synced to JobNimbus."); return; }
    if (!window.confirm(`Push this record to JobNimbus?\n\n${row.client_name}\n${row.address}, ${row.city} ${row.zip}\n\nA new JN job will be created. This cannot be undone.`)) return;

    setRowBusyId(row.id);
    try {
      const r = await fetch("/.netlify/functions/retry-jn-sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: row.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        setRecordSearchResults(prev => prev.map(rr => rr.id === row.id
          ? { ...rr, jn_job_id: d.jobId, docs_signed: d.docsSigned || rr.docs_signed }
          : rr));
        if (d.linkedExisting) {
          alert(`🔗 Linked to existing JN job (id: ${d.jobId}).\n\nNo fields were overwritten — any manual changes you made in JN (status, custom fields) are preserved.`);
        } else {
          alert(`✅ Synced to JN — job id: ${d.jobId}`);
        }
      } else {
        alert("❌ JN sync failed: " + (d.error || (await r.text()).slice(0, 200)) + (d.detail ? "\n\n" + JSON.stringify(d.detail).slice(0, 300) : ""));
      }
    } catch (e) {
      alert("JN sync error: " + (e.message || e));
    } finally {
      setRowBusyId(null);
    }
  };

  // Inline per-row status for the "Push to JN" button. Map of
  // row.id → { stage, ok?, message? }. Replaces the prior
  // confirm()+alert() flow which hid all progress behind a modal
  // and gave no indication anything was happening.
  // stage values: "updating" | "queueing" | "done" | "error"
  const [pushStatus, setPushStatus] = useState({});

  const adminPushResultToJn = async (row) => {
    if (!row) return;
    if (!row.result) {
      setPushStatus((s) => ({ ...s, [row.id]: { stage: "error", message: "No result on this record yet." } }));
      return;
    }
    if (!row.jn_job_id) {
      setPushStatus((s) => ({ ...s, [row.id]: { stage: "error", message: "Not linked to JN yet — hit Sync to JN first." } }));
      return;
    }
    setRowBusyId(row.id);
    setPushStatus((s) => ({ ...s, [row.id]: { stage: "updating", message: "Updating JN inspection result…" } }));
    try {
      // STEP 1: Server PUTs cf_string_34 and returns the photo list.
      // Fast — server returns in ~1s. Each per-photo upload happens
      // in its own Lambda below so Netlify's 10s budget never matters.
      const r = await fetch("/.netlify/functions/push-result-to-jn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: row.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        const detail = d.error || d.detail || d.jn_update_error || `HTTP ${r.status}`;
        setPushStatus((s) => ({ ...s, [row.id]: { stage: "error", ok: false, message: `❌ ${detail}` } }));
        setRowBusyId(null);
        return;
      }

      const photos = Array.isArray(d.photos_to_upload) ? d.photos_to_upload : [];
      const photosAlreadyInJn = d.photos_already_in_jn || 0;
      const jnJobId = d.jn_job_id;
      const isRetail = !!d.needs_retail_swap || row.result === "retail";

      // Build a swap-result message that surfaces what ACTUALLY changed
      // in JN. The PUT can return 200 even when JN silently ignored
      // location.id (e.g. lookup couldn't find the location) — we read
      // fields_set and location_lookup_note from the response so the
      // manager sees the truth, not just "✅ swap applied".
      function buildSwapMsg(res) {
        if (!res) return "";
        if (!res.jn_updated) {
          return `⚠ Retail swap failed: ${res.jn_update_error || res.error || "see logs"}.`;
        }
        const parts = [];
        const locationId = res.fields_set?.location_id;
        if (locationId) {
          parts.push(`record_type=Lead, location id=${locationId}`);
        } else {
          parts.push("record_type=Lead, location UNCHANGED");
        }
        let line = `✅ Retail swap applied (${parts.join(", ")}).`;
        // Show the lookup note (e.g. "Could not find a JN location
        // named 'US Shingle and Metal LLC'. Available: …") when present.
        if (res.location_lookup_note && !locationId) {
          line += ` ${res.location_lookup_note}`;
        }
        return line;
      }

      // Helper that runs once everything's settled — for retail we
      // ALSO fire process-retail-result for the workflow swap, AFTER
      // photos + cert have been pushed (so the swap is the last thing
      // and the JN job has all attachments before the location change).
      async function fireRetailSwapIfNeeded() {
        if (!isRetail) return null;
        try {
          const r = await fetch("/.netlify/functions/process-retail-result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inspectionId: row.id, skip_cert: true }),
          });
          const j = await r.json().catch(() => ({}));
          return j;
        } catch (e) {
          return { ok: false, error: e.message || "network" };
        }
      }

      // STEP 2: Fire per-photo uploads in parallel batches. Each photo
      // is its own Lambda — ~2s — so 28 photos in batches of 6 finish
      // in ~10s wall time with progress shown to the manager.
      // If photos_to_upload is empty, distinguish "no photos at all"
      // from "all already in JN" (dedup) — VERY different stories.
      if (photos.length === 0) {
        fireCertGeneration(jnJobId);
        const swapResult = await fireRetailSwapIfNeeded();
        const photoStatus = photosAlreadyInJn > 0
          ? `✅ All ${photosAlreadyInJn} photos already in JN`
          : "ℹ No photos on file";
        const swapMsg = !isRetail ? "" : buildSwapMsg(swapResult);
        setPushStatus((s) => ({
          ...s,
          [row.id]: {
            stage: "done",
            ok: true,
            message: isRetail
              ? `${photoStatus}. ${swapMsg} 📄 Cert generating — check JN Documents in ~1 min.`
              : `✅ JN result set to "${d.cf_string_34_set || row.result}". ${photoStatus}. 📄 Cert generating — check JN Documents in ~1 min.`,
          },
        }));
        setRowBusyId(null);
        return;
      }

      let uploaded = 0;
      let failed = 0;
      let firstFailureMsg = null;
      const BATCH = 6;
      const update = (stagePrefix) => {
        const done = uploaded + failed;
        setPushStatus((s) => ({
          ...s,
          [row.id]: {
            stage: "updating",
            message: `${stagePrefix} ${done}/${photos.length}${failed > 0 ? ` (${failed} failed so far)` : ""}…`,
          },
        }));
      };
      update("📤 Uploading photos to JN:");
      for (let i = 0; i < photos.length; i += BATCH) {
        const slice = photos.slice(i, i + BATCH);
        await Promise.all(slice.map(async (p) => {
          try {
            const resp = await fetch("/.netlify/functions/upload-photo-to-jn", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jn_job_id: jnJobId,
                path: p.path,
                bucket: p.bucket,
                label: p.label,
              }),
            });
            const j = await resp.json().catch(() => ({}));
            if (resp.ok && j.ok) {
              uploaded++;
            } else {
              failed++;
              if (!firstFailureMsg) firstFailureMsg = j.error || `HTTP ${resp.status}`;
            }
          } catch (e) {
            failed++;
            if (!firstFailureMsg) firstFailureMsg = e.message || "network error";
          }
          update("📤 Uploading photos to JN:");
        }));
      }

      // STEP 3: Fire the cert generator (fire-and-forget — its own Lambda).
      setPushStatus((s) => ({
        ...s,
        [row.id]: { stage: "updating", message: "📄 Queueing cert generation…" },
      }));
      fireCertGeneration(jnJobId);

      // STEP 4 (retail only): now the JN job has photos + cert
      // queued, do the workflow swap (record_type → Lead, location →
      // US Shingle and Metal LLC, cf_string_34 → Retail).
      let swapResult = null;
      if (isRetail) {
        setPushStatus((s) => ({
          ...s,
          [row.id]: { stage: "updating", message: "🔁 Applying retail workflow swap (record_type + location)…" },
        }));
        swapResult = await fireRetailSwapIfNeeded();
      }

      const parts = [];
      if (isRetail) {
        parts.push(buildSwapMsg(swapResult));
      } else {
        parts.push(`✅ JN result set to "${d.cf_string_34_set || row.result}"`);
      }
      // Photo counts. Mention "already in JN" alongside any new uploads.
      const photoBits = [];
      if (uploaded > 0) photoBits.push(`✅ ${uploaded} newly uploaded`);
      if (failed > 0) photoBits.push(`❌ ${failed} failed`);
      if (photosAlreadyInJn > 0) photoBits.push(`✅ ${photosAlreadyInJn} already in JN`);
      if (photoBits.length === 0) photoBits.push("ℹ no photos");
      parts.push(`Photos: ${photoBits.join(", ")} (of ${d.photos_total ?? photos.length + photosAlreadyInJn} total)`);
      if (firstFailureMsg) parts.push(`First photo error: ${firstFailureMsg}`);
      parts.push("📄 Cert generating — check JN Documents in ~1 min");

      setPushStatus((s) => ({
        ...s,
        [row.id]: {
          stage: "done",
          ok: failed === 0,
          message: parts.join(". "),
        },
      }));
    } catch (e) {
      setPushStatus((s) => ({ ...s, [row.id]: { stage: "error", ok: false, message: `❌ ${e.message || e}` } }));
    } finally {
      setRowBusyId(null);
    }
  };

  // Fire the cert generator for a given JN job. Fire-and-forget —
  // the cert function runs in its own Lambda with its own 10s budget
  // (or 15-min if the user's Netlify plan supports background funcs).
  function fireCertGeneration(jnJobId) {
    if (!jnJobId) return;
    // Use the -background variant — Netlify gives it a 15-minute
    // budget vs. the 10s timeout on the regular function. The cert
    // path (PDFShift + photo downloads + JN upload) routinely runs
    // 10-15s and was returning 502 to the browser when fired against
    // the regular endpoint, so the cert never actually completed.
    fetch("/.netlify/functions/generate-and-upload-insp-report-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jnid: jnJobId }),
    }).catch((e) => console.warn("Cert kickoff failed:", e));
  }

  const submitInspectionResult = async () => {
    if (!resultChoice || !resultInspectorName.trim() || !selectedInspRecord) return;
    setResultSubmitting(true);
    try {
      const certNo = genCertNo(resultCertDate);
      setResultCertNumber(certNo);
      const hasDamage = resultChoice === "damage";

      await supabase.from("inspections").update({
        result: resultChoice,
        result_at: new Date().toISOString(),
        inspector_name: resultInspectorName.trim(),
        cert_number: certNo,
      }).eq("id", selectedInspRecord.id);

      // ── PA Ops Hub Property Damage Notice (PDN) ────────────────────
      // When an inspection is statused as damage, fire a multipart POST
      // to the PA's Ops Hub intake endpoint with the homeowner data,
      // the signed Free Roof Inspection PDF, and any JN photos. Fire-
      // and-forget: failures don't block the main flow (PA can ask for
      // the docs separately if anything is missing). The function
      // gates on result === "damage" on its own end too.
      if (resultChoice === "damage") {
        fetch("/.netlify/functions/send-to-pa-ops-hub", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: selectedInspRecord.id }),
        }).then(async (r) => {
          const txt = await r.text().catch(() => "");
          if (!r.ok) console.warn("PA Ops Hub POST failed:", r.status, txt.slice(0, 300));
          else console.log("PA Ops Hub PDN submitted:", txt.slice(0, 200));
        }).catch(e => console.warn("PA Ops Hub POST error:", e));
      }

      // ── Push result to JobNimbus ───────────────────────────────────
      // Updates the JN job's cf_string_34 to match the result, fires
      // a cert+photos upload to JN Documents, and (for retail) does
      // the record_type/location swap. Fire-and-forget so the rest
      // of submitInspectionResult (email, SMS, PDF) isn't blocked.
      // Previously this only happened when the inspector submitted
      // via the wizard — manager-side result-setting via Record
      // Lookup left JN at "Needs Inspection" forever.
      if (selectedInspRecord.jn_job_id) {
        fetch("/.netlify/functions/push-result-to-jn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: selectedInspRecord.id }),
        }).then(async (r) => {
          const txt = await r.text().catch(() => "");
          if (!r.ok) console.warn("Push result to JN failed:", r.status, txt.slice(0, 300));
          else console.log("Push result to JN:", txt.slice(0, 200));
        }).catch(e => console.warn("Push result to JN error:", e));
      }

      // Generate PDF
      setIsExportingPdf(true);
      await new Promise(r => setTimeout(r, 350));
      let certBase64 = null;
      try {
        const blob = await generatePDF("#inspection-certificate-printable", "Inspection-Certificate.pdf");
        certBase64 = String(await blobToBase64(blob)).split(",")[1];
      } catch(e) { console.warn("Cert PDF failed:", e); }
      setIsExportingPdf(false);

      const homeownerEmail = selectedInspRecord.email || "";
      const repId = selectedInspRecord.sales_rep_id || "";
      const repName = selectedInspRecord.sales_rep_name || "";
      const ownerName = selectedInspRecord.client_name || "Homeowner";
      const propertyAddr = [selectedInspRecord.address, selectedInspRecord.city, selectedInspRecord.state].filter(Boolean).join(", ");

      let repPhone = "";
      if (repId) {
        let repData = null;
        const byJn = await supabase.from("sales_reps").select("phone").eq("jobnimbus_id", repId).maybeSingle();
        if (byJn?.data) repData = byJn.data;
        if (!repData) {
          const byId = await supabase.from("sales_reps").select("phone").eq("id", repId).maybeSingle();
          if (byId?.data) repData = byId.data;
        }
        if (!repData && repName) {
          const byName = await supabase.from("sales_reps").select("phone").ilike("name", repName).maybeSingle();
          if (byName?.data) repData = byName.data;
        }
        repPhone = repData?.phone || "";
      } else if (repName) {
        const { data: repData } = await supabase.from("sales_reps").select("phone").ilike("name", repName).maybeSingle();
        repPhone = repData?.phone || "";
      }
      // Determine PA paperwork signed state (for choosing _insp vs _all templates)
      const addr = (selectedInspRecord.address || "").trim().toLowerCase();
      const zip = (selectedInspRecord.zip || "").trim();
      let paIsSigned = false;
      if (addr && zip) {
        const { data: claimData } = await supabase.from("claims").select("id, docs_signed").ilike("address", addr).eq("zip", zip).order("signed_at", { ascending: false }).limit(1);
        const c = claimData?.[0];
        paIsSigned = c && ((c.docs_signed || "").includes("lor") || (c.docs_signed || "").includes("pac"));
      }

      // Resolve homeowner phone (for SMS)
      const homeownerPhone = selectedInspRecord.mobile || selectedInspRecord.phone || "";

      // Pick template variant: "all" if PA paperwork signed upfront, else "insp"
      const variant = paIsSigned ? "all" : "insp";
      const resultKey = hasDamage ? "damage" : "nodamage";  // manual flow doesn't produce "retail"

      // Template vars used by {placeholders}
      const tvars = {
        client:   ownerName,
        address:  selectedInspRecord.address || "",
        city:     selectedInspRecord.city || "",
        rep:      repName || "your rep",
        repPhone: repPhone || "",
      };

if (!hasDamage) {
        // NO DAMAGE — email homeowner certificate (email stays as-is for rich HTML)
        // ── AUTO-NOTIFICATIONS DISABLED — manager sends manually from Pending list ──
        if (false && homeownerEmail) {
          await fetch("/.netlify/functions/send-email", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: [homeownerEmail],
              bcc: activityEmail ? [activityEmail] : [],
              subject: "Your Roof Inspection Certificate — No Damage Found ✅",
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:#199c2e;padding:24px 32px;border-radius:12px 12px 0 0"><h1 style="color:#fff;margin:0">✅ Good News — No Damage Found!</h1></div><div style="background:#f9fafb;padding:24px 32px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none"><p>Hi ${ownerName},</p><p>Our inspector completed the roof inspection at <strong>${propertyAddr}</strong> and found <strong>no structural damage</strong>.</p><div style="background:#f0fdf4;border:2px solid #199c2e;border-radius:10px;padding:16px 20px;margin:16px 0"><p style="margin:0;font-weight:700;color:#166534">📄 Keep This Certificate Safe!</p><p style="margin:8px 0 0;color:#166534;font-size:14px;line-height:1.6">Your official inspection certificate is attached. <strong>If your insurance company ever sends a notice requiring roof replacement, submit this certified inspection report as evidence that your roof was professionally inspected and found to be in good condition.</strong></p></div><div style="background:#0a0a0a;border-radius:10px;padding:16px 20px;margin:16px 0"><p style="margin:0;font-weight:700;color:#fff">📞 U.S. Shingle &amp; Metal LLC</p><p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Phone: 727-761-5200 | Email: inspection@shingleusa.com</p></div></div></div>`,
              attachments: certBase64 ? [{ filename: "Inspection-Certificate-No-Damage.pdf", content: certBase64 }] : [],
            }),
          }).catch(e => console.warn("No-damage email:", e));
        }
      } else {
        // DAMAGE — email homeowner (content varies based on PA signed status)
        // ── AUTO-NOTIFICATIONS DISABLED — manager sends manually from Pending list ──
        if (false && homeownerEmail) {
          const emailSubject = paIsSigned ? "⚠️ Roof Damage Found — Your Claim Is Being Started" : "⚠️ Roof Inspection Results — Damage Found";
          const emailHtml = paIsSigned
            ? `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:#dc2626;padding:24px 32px;border-radius:12px 12px 0 0"><h1 style="color:#fff;margin:0">⚠️ Damage Found — Healthy Homes Is On It</h1></div><div style="background:#f9fafb;padding:24px 32px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none"><p>Hi ${ownerName},</p><p>Our inspector has completed the roof inspection at <strong>${propertyAddr}</strong> and confirmed <strong>storm damage</strong>.</p><div style="background:#fef2f2;border:2px solid #dc2626;border-radius:10px;padding:16px 20px;margin:16px 0"><p style="margin:0;font-weight:700;color:#991b1b">🚀 Your Claim Is Already In Motion</p><p style="margin:8px 0 0;color:#991b1b;font-size:14px;line-height:1.6">Because you already have your paperwork signed with Healthy Homes Public Adjusting, <strong>your claim is being started right away.</strong> Healthy Homes will be reaching out to you shortly to walk you through the next steps.</p></div><div style="background:#0a0a0a;border-radius:10px;padding:16px 20px;margin:16px 0"><p style="margin:0;font-weight:700;color:#fff">📞 Healthy Homes Public Adjusting</p><p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Phone: 561-283-5674 | Email: Kkeckleradj@gmail.com</p></div><p style="font-size:13px;color:#6b7280">Please do not repair or replace anything until your claim has been reviewed.</p></div></div>`
            : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:#dc2626;padding:24px 32px;border-radius:12px 12px 0 0"><h1 style="color:#fff;margin:0">⚠️ Damage Found — We're On It</h1></div><div style="background:#f9fafb;padding:24px 32px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none"><p>Hi ${ownerName},</p><p>Our inspector has completed the roof inspection at <strong>${propertyAddr}</strong> and identified <strong>storm damage</strong>.</p><div style="background:#fef2f2;border:2px solid #dc2626;border-radius:10px;padding:16px 20px;margin:16px 0"><p style="margin:0;font-weight:700;color:#991b1b">📋 What Happens Next</p><p style="margin:8px 0 0;color:#991b1b;font-size:14px;line-height:1.6">Your representative, <strong>${repName || "our team"}</strong>, will be contacting you soon to get the paperwork started so we can work with your insurance company on your behalf.</p></div><p style="font-size:14px;color:#374151">Your official inspection report is attached. Please do not repair or replace anything until your claim has been reviewed.</p><div style="background:#0a0a0a;border-radius:10px;padding:16px 20px;margin:16px 0"><p style="margin:0;font-weight:700;color:#fff">📞 U.S. Shingle &amp; Metal LLC</p><p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Phone: 727-761-5200 | Email: inspection@shingleusa.com</p></div></div></div>`;
          await fetch("/.netlify/functions/send-email", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: [homeownerEmail],
              bcc: activityEmail ? [activityEmail] : [],
              subject: emailSubject,
              html: emailHtml,
              attachments: certBase64 ? [{ filename: "Inspection-Certificate-Damage.pdf", content: certBase64 }] : [],
            }),
          }).catch(e => console.warn("Damage email:", e));
        }
      }

      // ── SMS — AUTO-NOTIFICATIONS DISABLED — manager sends manually from Pending list
      // Rep + homeowner SMS are fired explicitly via "Notify Rep" / "Notify Homeowner"
      // buttons in the Pending Inspections list. Flip `false` → `true` below to restore.
      if (false) {
        const repMsg = renderSmsTemplate(`${resultKey}_${variant}_rep`, tvars);
        if (repPhone && repMsg) {
          await fetch("/.netlify/functions/ghl-sms", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: repPhone, message: repMsg, name: repName || "Sales Rep" }),
          }).catch(e => console.warn("Rep SMS failed:", e));
        }
        const homeownerMsg = renderSmsTemplate(`${resultKey}_${variant}_homeowner`, tvars);
        if (homeownerPhone && homeownerMsg) {
          await fetch("/.netlify/functions/ghl-sms", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: homeownerPhone, message: homeownerMsg, name: ownerName }),
          }).catch(e => console.warn("Homeowner SMS failed:", e));
        }
      }

      setResultDone(true);
    } catch(err) {
      alert(err?.message || "Something went wrong.");
    } finally {
      setResultSubmitting(false);
      setIsExportingPdf(false);
    }
  };

  if (isLoadingSigningLink) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f1f5f9",
          fontFamily: "'Oswald', Arial, Helvetica, sans-serif",
        }}
      >
        Loading signing request...
      </div>
    );
  }

  // Reusable inline style for the friendly toggle pill button

  const sigSectionLabel = (emoji, title, subtitle) => (
    <div style={{ marginBottom: 12, marginTop: 20 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 28 }}>{emoji}</span>
        <span style={{
          fontSize: 20,
          fontWeight: 700,
          color: "#111827",
          fontFamily: "'Nunito', sans-serif",
        }}>{title}</span>
      </div>
      {subtitle ? (
        <div style={{
          fontSize: 15,
          color: "#6b7280",
          fontFamily: "'Nunito', sans-serif",
          lineHeight: 1.5,
          paddingLeft: 38,
        }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );

  const renderSigningFields = (showSendMode = false) => (
    <div>
      {/* ── Header strip ── */}
      {!showSendMode ? (
        <div
          style={{
            background: "linear-gradient(135deg, #199c2e, #15803d)",
            borderRadius: "24px 24px 0 0",
            padding: "28px 28px 24px",
            color: "#fff",
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 6 }}>✍️</div>
          <div style={{
            fontSize: 30,
            fontWeight: 700,
            fontFamily: "'Oswald', sans-serif",
            marginBottom: 8,
            lineHeight: 1.1,
          }}>
            One Last Step — Sign Here!
          </div>
          <div style={{
            fontSize: 17,
            fontFamily: "'Nunito', sans-serif",
            fontWeight: 600,
            opacity: 0.92,
            lineHeight: 1.6,
            maxWidth: 520,
          }}>
            Use your finger, mouse, or just type your name below. It only takes 30 seconds. 🎉
          </div>
        </div>
      ) : null}

      <Card style={{ borderRadius: showSendMode ? 24 : "0 0 24px 24px", borderTop: showSendMode ? undefined : "none" }}>
        {showSendMode ? (
          <CardHeader>
            <CardTitle>Review & Send for Signing</CardTitle>
            <CardDescription>Review the selected forms, then email one signing link to the homeowner.</CardDescription>
          </CardHeader>
        ) : null}

        <CardContent>
          {!showSendMode ? (
            <>
              {!reviewReady && submitAttempted ? (
                <div style={{
                  background: "#fef9c3",
                  color: "#713f12",
                  border: "1px solid #fde68a",
                  borderRadius: 14,
                  padding: "14px 18px",
                  marginBottom: 20,
                  fontSize: 16,
                  fontWeight: 700,
                  fontFamily: "'Nunito', sans-serif",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}>
                  <span style={{ fontSize: 22 }}>👆</span>
                  Scroll up and tap "Looks Good!" on each document first!
                </div>
              ) : null}

              {/* ── HOW TO SIGN — two big friendly option cards ── */}
              <div style={{ marginBottom: 24 }}>
                <div style={{
                  fontSize: 16,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "#111827",
                  fontFamily: "'Oswald', sans-serif",
                  marginBottom: 12,
                }}>
                  ✏️ Choose How to Sign:
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {/* Option A: Draw */}
                  <button
                    type="button"
                    onClick={() => { setSigMethod1("draw"); setSigMethod2("draw"); }}
                    style={{
                      padding: "18px 14px",
                      borderRadius: 18,
                      border: sigMethod1 === "draw" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                      background: sigMethod1 === "draw" ? "#f0fdf4" : "#fff",
                      cursor: "pointer",
                      textAlign: "center",
                      transition: "all 0.2s",
                    }}
                  >
                    <div style={{ fontSize: 36, marginBottom: 8 }}>👆</div>
                    <div style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#111827",
                      fontFamily: "'Nunito', sans-serif",
                      marginBottom: 4,
                    }}>
                      Draw Your Signature
                    </div>
                    <div style={{
                      fontSize: 13,
                      color: "#6b7280",
                      fontFamily: "'Nunito', sans-serif",
                      lineHeight: 1.4,
                    }}>
                      Use your finger or mouse in the box
                    </div>
                    {sigMethod1 === "draw" ? (
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                    ) : null}
                  </button>

                  {/* Option B: Type */}
                  <button
                    type="button"
                    onClick={() => { setSigMethod1("type"); setSigMethod2("type"); setInitialsMethod1("type"); setInitialsMethod2("type"); }}
                    style={{
                      padding: "18px 14px",
                      borderRadius: 18,
                      border: sigMethod1 === "type" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                      background: sigMethod1 === "type" ? "#f0fdf4" : "#fff",
                      cursor: "pointer",
                      textAlign: "center",
                      transition: "all 0.2s",
                    }}
                  >
                    <div style={{ fontSize: 36, marginBottom: 8 }}>⌨️</div>
                    <div style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#111827",
                      fontFamily: "'Nunito', sans-serif",
                      marginBottom: 4,
                    }}>
                      Type Your Signature
                    </div>
                    <div style={{
                      fontSize: 13,
                      color: "#6b7280",
                      fontFamily: "'Nunito', sans-serif",
                      lineHeight: 1.4,
                    }}>
                      Type your name &amp; pick a style
                    </div>
                    {sigMethod1 === "type" ? (
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                    ) : null}
                  </button>
                </div>
              </div>

              {/* ── Signature field ── */}
              {sigSectionLabel("🖊️", data.homeowner1 ? `${data.homeowner1}'s Signature` : "Your Signature", null)}

              {sigMethod1 === "draw" ? (
                <SignaturePad
                  title=""
                  value={sig1}
                  onChange={setSig1}
                  required
                  missing={submitAttempted && !effectiveSig1}
                />
              ) : (
                <TypedSignatureField
                  title=""
                  value={typedSig1}
                  onChange={setTypedSig1}
                  fontValue={sigFont1}
                  onFontChange={setSigFont1}
                  required
                  missing={submitAttempted && !effectiveSig1}
                  placeholder="Type your full legal name"
                />
              )}

              {hasSecond ? (
                <>
                  {sigSectionLabel("🖊️", data.homeowner2 ? `${data.homeowner2}'s Signature` : "Co-Owner Signature", null)}
                  {sigMethod2 === "draw" ? (
                    <SignaturePad
                      title=""
                      value={sig2}
                      onChange={setSig2}
                      required
                      missing={submitAttempted && !effectiveSig2}
                    />
                  ) : (
                    <TypedSignatureField
                      title=""
                      value={typedSig2}
                      onChange={setTypedSig2}
                      fontValue={sigFont2}
                      onFontChange={setSigFont2}
                      required
                      missing={submitAttempted && !effectiveSig2}
                      placeholder="Type co-owner's full legal name"
                    />
                  )}
                </>
              ) : null}

              {selectedDocs.includes("pac") ? (
                <>
                  {/* ── Initials intro banner ── */}
                  <div style={{
                    marginTop: 28,
                    marginBottom: 20,
                    borderRadius: 20,
                    background: "linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)",
                    border: "2px solid #86efac",
                    padding: "20px 24px",
                    display: "flex",
                    alignItems: "center",
                    gap: 18,
                  }}>
                    <div style={{
                      fontSize: 48,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}>
                      🎉
                    </div>
                    <div>
                      <div style={{
                        fontSize: 22,
                        fontWeight: 800,
                        color: "#15803d",
                        fontFamily: "'Oswald', sans-serif",
                        letterSpacing: "0.02em",
                        marginBottom: 4,
                        lineHeight: 1.1,
                      }}>
                        Almost There — Just Initials!
                      </div>
                      <div style={{
                        fontSize: 16,
                        color: "#166534",
                        fontFamily: "'Nunito', sans-serif",
                        fontWeight: 600,
                        lineHeight: 1.55,
                      }}>
                        One tiny step left — just pop your initials in the box below. Same as before, draw or type! 😊
                      </div>
                    </div>
                  </div>

                  {sigSectionLabel("✏️", data.homeowner1 ? `${data.homeowner1}'s Initials` : "Your Initials", null)}

                  {initialsMethod1 === "draw" ? (
                    <InitialsPad
                      title=""
                      value={data.initials1}
                      onChange={(v) => update("initials1", v)}
                      required
                      missing={submitAttempted && !effectiveInitials1}
                    />
                  ) : (
                    <TypedInitialsField
                      title=""
                      value={initials1Typed}
                      onChange={setInitials1Typed}
                      fontValue={initialsFont1}
                      onFontChange={setInitialsFont1}
                      required
                      missing={submitAttempted && !effectiveInitials1}
                      placeholder="Your initials (e.g. JD)"
                    />
                  )}

                  {hasSecond ? (
                    <>
                      {sigSectionLabel("✏️", data.homeowner2 ? `${data.homeowner2}'s Initials` : "Co-Owner Initials", null)}
                      {initialsMethod2 === "draw" ? (
                        <InitialsPad
                          title=""
                          value={data.initials2}
                          onChange={(v) => update("initials2", v)}
                          required
                          missing={submitAttempted && !effectiveInitials2}
                        />
                      ) : (
                        <TypedInitialsField
                          title=""
                          value={initials2Typed}
                          onChange={setInitials2Typed}
                          fontValue={initialsFont2}
                          onFontChange={setInitialsFont2}
                          required
                          missing={submitAttempted && !effectiveInitials2}
                          placeholder="Co-owner initials (e.g. JD)"
                        />
                      )}
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {!showSendMode && submitAttempted && missingSigningFields.length > 0 ? (
            <div style={{
              marginTop: 16,
              marginBottom: 12,
              padding: "14px 18px",
              background: "#fef2f2",
              borderRadius: 14,
              fontSize: 15,
              color: "#991b1b",
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              Almost there! Still needed: {missingSigningFields.join(", ")}
            </div>
          ) : null}

        <div
          style={{
            display: "flex",
            gap: 12,
            paddingTop: 8,
            flexWrap: "wrap",
          }}
        >
          <Button
            onClick={submitDoc}
            disabled={
              isSubmitting || (showSendMode ? false : !reviewReady || !isSigningComplete)
            }
          >
            {isSubmitting
              ? <><span style={{ display: "inline-block", width: 16, height: 16, border: "2.5px solid rgba(255,255,255,0.4)", borderTop: "2.5px solid #fff", borderRadius: "50%", animation: "ccg-spin 0.8s linear infinite" }} /> Processing...</>
              : <>{showSendMode ? <Send size={16} /> : <Mail size={16} />} {showSendMode ? "Send for Signing" : "Submit & Email Copies"}</>
            }
          </Button>

          <Button
            variant="outline"
            onClick={async () => {
              try {
                const selector = selectedDocs.includes("lor")
                  ? "#lor-printable-document"
                  : "#pac-printable-document";
                const filename = selectedDocs.includes("lor")
                  ? documentFilename("lor")
                  : documentFilename("pac");

                const element = document.querySelector(selector);
                if (!element) {
                  alert("Document not found.");
                  return;
                }

                setIsExportingPdf(true);
                await new Promise((resolve) => setTimeout(resolve, 200));

                await html2pdf()
                  .set({
                    margin: 0,
                    filename,
                    image: { type: "jpeg", quality: 0.98 },
                    html2canvas: {
                      scale: 1.5,
                      useCORS: true,
                      scrollX: 0,
                      scrollY: 0,
                    },
                    jsPDF: {
                      unit: "in",
                      format: "letter",
                      orientation: "portrait",
                    },
                    pagebreak: { mode: ["css"] },
                  })
                  .from(element)
                  .save();
              } catch (err) {
                alert(err?.message || "Failed to download PDF.");
              } finally {
                setIsExportingPdf(false);
              }
            }}
          >
            Download PDF
          </Button>
        </div>
      </CardContent>
    </Card>
    </div>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        padding: 16,
        boxSizing: "border-box",
      }}
    >

      {/* ── Always-rendered hidden USS Welcome PDF ── */}
      <div style={{ position: "fixed", left: "-9999px", top: 0, pointerEvents: "none", zIndex: -1 }}>
        <div id="uss-welcome-printable" style={{ width: "8.5in", fontFamily: "Arial, Helvetica, sans-serif", background: "#fff" }}>
          <div style={{ width: "8.5in", boxSizing: "border-box", padding: "0", background: "#fff", position: "relative" }}>

            {/* Navy header */}
           <div style={{ background: "#0a0a0a", padding: "0.5in 0.6in 0.4in", color: "#fff" }}>
              <img src="/uss-header.png" alt="U.S. Shingle & Metal" style={{ height: 56, objectFit: "contain", marginBottom: 18, filter: "brightness(0) invert(1)" }} />
              <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 8, lineHeight: 1.1 }}>
                Welcome to U.S. Shingle & Metal LLC!
              </div>
              <div style={{ fontSize: 16, opacity: 0.9, lineHeight: 1.5 }}>
                {inspOnlyOpening}
              </div>
            </div>

            <div style={{ padding: "0.2in 0.5in 0.2in" }}>

              {/* Contact info box */}
              <div style={{ background: "#eef1f8", border: "2px solid #0a0a0a", borderRadius: 12, padding: "20px 24px", marginBottom: 24 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0a0a0a", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                  Your Point of Contact
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
                  <div><strong>Company:</strong> U.S. Shingle & Metal LLC</div>
                  <div><strong>License:</strong> CCC1331960</div>
                  <div><strong>Phone:</strong> {ussContactPhone}</div>
                  <div><strong>Email:</strong> {ussContactEmail}</div>
                  <div><strong>Address:</strong> 3845 Gateway Centre Blvd Suite 300, Pinellas Park, FL 33782</div>
                </div>
              </div>

              {/* Inspection details */}
              <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 24px", marginBottom: 24 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                  Your Inspection Details
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, fontSize: 12 }}>
                  <div><strong>Name:</strong> {inspData.clientName || [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</div>
                  <div><strong>Date:</strong> {inspData.date || data.date}</div>
                  <div><strong>Address:</strong> {[inspData.address || data.address, inspData.city || data.city, inspData.state || data.state, inspData.zip || data.zip].filter(Boolean).join(", ")}</div>
                  <div><strong>Phone:</strong> {inspData.mobile || data.phone}</div>
                  {(inspData.email || data.signerEmail) ? <div><strong>Email:</strong> {inspData.email || data.signerEmail}</div> : null}
                  {data.salesRepName ? <div><strong>Rep:</strong> {data.salesRepName}</div> : null}
                </div>
              </div>

              {/* What to expect */}
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 10 }}>
                📋 What Happens Next
              </div>
              {inspOnlySteps.map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 6, padding: "7px 10px", background: "#eef1f8", borderRadius: 8, border: "1px solid #bfdbfe" }}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#0a0a0a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11, flexShrink: 0 }}>{i + 1}</div>
                  <div style={{ fontSize: 12, color: "#1e3a5f", lineHeight: 1.45 }}>{step}</div>
                </div>
              ))}

              {/* Closing */}
              <div style={{ marginTop: 20, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "16px 20px", fontSize: 14, color: "#92400e", fontWeight: 600, textAlign: "center", lineHeight: 1.6 }}>
                {inspOnlyClosing}
              </div>

              {/* Footer */}
              <div style={{ marginTop: 28, borderTop: "2px solid #0a0a0a", paddingTop: 14, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
                U.S. Shingle & Metal LLC • License No: CCC1331960 • {ussContactEmail} • {ussContactPhone} • 3845 Gateway Centre Blvd Suite 300, Pinellas Park, FL 33782
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Nunito:wght@400;500;600;700&display=swap');
        body {
          margin: 0;
          font-family: 'Nunito', Arial, Helvetica, sans-serif;
        }
        input, textarea, select {
          font-family: 'Nunito', Arial, Helvetica, sans-serif;
        }
        button {
          font-family: 'Oswald', Arial, Helvetica, sans-serif;
        }
      `}</style>

      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "grid",
          gap: 24,
        }}
      >
        {showRepHelp ? <RepHelpModal onClose={() => setShowRepHelp(false)} /> : null}

        {view === "input" ? (
          <Card>
            <CardHeader>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <CardTitle>Claim Intake</CardTitle>
                  <CardDescription>
                    Enter the information once, choose sign now or send for signing,
                    choose which forms to include, then continue.
                  </CardDescription>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0, marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => setShowRepHelp(true)}
                    style={{
                      background: "#fffbeb",
                      border: "1px solid #c9a35c",
                      borderRadius: 10,
                      padding: "6px 14px",
                      fontSize: 12,
                      fontFamily: "'Oswald', sans-serif",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      color: "#92400e",
                      cursor: "pointer",
                      textTransform: "uppercase",
                    }}
                  >
                    ❔ Understanding the App
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("manager")}
                    style={{
                      background: "transparent",
                      border: "1px solid #d1d5db",
                      borderRadius: 10,
                      padding: "6px 14px",
                      fontSize: 12,
                      fontFamily: "'Oswald', sans-serif",
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      color: "#6b7280",
                      cursor: "pointer",
                      textTransform: "uppercase",
                    }}
                  >
                    ⚙️ Manager
                  </button>
                </div>
              </div>
            </CardHeader>

            {/* Hard-stop warning so reps don't use this flow for
                retail-only homeowners. Retail appointments go through
                JobNimbus directly — the free-roof flow is for
                inspection sign-ups only. */}
            <div style={{ padding: "0 16px 12px" }}>
              <div style={{
                background: "#dc2626",
                color: "#fff",
                border: "4px solid #7f1d1d",
                borderRadius: 14,
                padding: "18px 20px",
                textAlign: "center",
                boxShadow: "0 4px 16px rgba(220,38,38,0.35)",
              }}>
                <div style={{
                  fontSize: 22,
                  fontWeight: 900,
                  fontFamily: "'Oswald', sans-serif",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  lineHeight: 1.15,
                }}>
                  🚫 DO NOT USE THIS TO CREATE A RETAIL APPOINTMENT!
                </div>
                <div style={{
                  fontSize: 16,
                  fontWeight: 700,
                  marginTop: 10,
                  fontFamily: "'Oswald', sans-serif",
                  letterSpacing: "0.03em",
                  lineHeight: 1.3,
                }}>
                  If they don't want an inspection and want a retail appointment, go through <span style={{ textDecoration: "underline" }}>JobNimbus</span>!
                </div>
              </div>
            </div>

            {/* Mode toggle — Quick (current form) vs Guided (interview).
                Quick is the default for veteran reps; Guided opens an
                overlay-style step-by-step flow for new reps. The Quick
                form stays mounted underneath so falling back is instant. */}
            <div style={{ padding: "0 16px 16px", display: "flex", justifyContent: "center" }}>
              <div style={{ display: "inline-flex", background: "#f1f5f9", borderRadius: 999, padding: 4, gap: 4 }}>
                <button
                  type="button"
                  onClick={() => setIntakeMode("quick")}
                  style={{
                    padding: "8px 18px", borderRadius: 999, border: "none",
                    background: intakeMode === "quick" ? "#0a0a0a" : "transparent",
                    color: intakeMode === "quick" ? "#fff" : "#6b7280",
                    fontSize: 13, fontWeight: 700, fontFamily: "'Oswald', sans-serif",
                    letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >⚡ Quick</button>
                <button
                  type="button"
                  onClick={() => {
                    setIntakeMode("guided");
                    setGuidedStep(0);
                    setGuidedNewVsExisting(null);
                    // Start the interview with inspection-only selected.
                    // The rep explicitly opts into LOR/PA on step 1 — that
                    // matches the most common signing pattern (insp first
                    // visit, LOR/PA later) and avoids the rep accidentally
                    // signing more forms than the homeowner agreed to.
                    setSelectedDocs(["insp"]);
                  }}
                  style={{
                    padding: "8px 18px", borderRadius: 999, border: "none",
                    background: intakeMode === "guided" ? "#0a0a0a" : "transparent",
                    color: intakeMode === "guided" ? "#fff" : "#6b7280",
                    fontSize: 13, fontWeight: 700, fontFamily: "'Oswald', sans-serif",
                    letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >🧭 Guided</button>
              </div>
            </div>

            {/* Quick form — hidden but still mounted when Guided mode is
                active. Keeping it mounted means any in-progress fields
                survive a toggle back to Quick. */}
            <CardContent style={intakeMode === "guided" ? { display: "none" } : {}}>
              <div style={{ display: "grid", gap: 24 }}>
                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Homeowner Info</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <FormField
                      label="Homeowner 1"
                      value={data.homeowner1}
                      onChange={(v) => update("homeowner1", v)}
                    />
                    <FormField
                      label="Homeowner 2"
                      value={data.homeowner2}
                      onChange={(v) => update("homeowner2", v)}
                    />
                    <div>
                      <label style={{
                        display: "block",
                        fontSize: 14,
                        color: "#374151",
                        marginBottom: 8,
                        fontWeight: 600,
                        fontFamily: "'Nunito', sans-serif",
                      }}>Phone</label>
                      <input
                        type="tel"
                        value={data.phone}
                        placeholder="(813) 656-4161"
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
                          let formatted = digits;
                          if (digits.length >= 7) {
                            formatted = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
                          } else if (digits.length >= 4) {
                            formatted = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
                          } else if (digits.length >= 1) {
                            formatted = `(${digits}`;
                          }
                          update("phone", formatted);
                        }}
                        style={{
                          width: "100%",
                          height: 44,
                          borderRadius: 14,
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          fontSize: 14,
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                    <FormField
                      label="Homeowner Email"
                      type="email"
                      value={data.signerEmail}
                      onChange={(v) => update("signerEmail", v)}
                      showError={submitAttempted}
                    />
                    <div style={{ gridColumn: "1 / -1" }}>
                      <Label>Address</Label>
                      <AddressAutocomplete
                        value={data.address}
                        onChange={(v) => update("address", v)}
                        onPlaceSelected={({ address, city, state, zip }) => {
                          // Fill all 4 fields atomically
                          update("address", address);
                          update("city", city);
                          update("state", normalizeStateValue(state));
                          update("zip", zip);
                        }}
                        placeholder="Start typing the property address..."
                      />
                    </div>
                    <FormField
                      label="City"
                      value={data.city}
                      onChange={(v) => update("city", v)}
                    />
                    {/* State — dropdown so we never get "fl"/"FL"/"Florida" inconsistencies */}
                    <div>
                      <Label>State</Label>
                      <select
                        value={normalizeStateValue(data.state)}
                        onChange={(e) => update("state", e.target.value)}
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif", background: "#fff" }}
                      >
                        <option value="">— Select state —</option>
                        {US_STATES.map(([code, name]) => (
                          <option key={code} value={code}>{code} — {name}</option>
                        ))}
                      </select>
                    </div>
                    <FormField
                      label="ZIP"
                      value={data.zip}
                      onChange={(v) => update("zip", v)}
                    />
                  </div>
                </Card>

                {/* Claim Admin section — hidden when PA workflow is off.
                    PA collects insurance/claim info on their own paperwork
                    outside this system; we don't need to capture it on
                    intake. Toggle back on in Manager → Security if you
                    switch PAs later. */}
                {!PA_FORMS_DISABLED && (
                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Claim Admin</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <FormField
                      label="Today's Date"
                      type="date"
                      value={data.date}
                      onChange={(v) => update("date", v)}
                    />
                    <FormField
                      label="Insurance Company"
                      value={data.insuranceCompany}
                      onChange={(v) => update("insuranceCompany", v)}
                    />
                    <FormField
                      label="Policy #"
                      value={data.policyNumber}
                      onChange={(v) => update("policyNumber", v)}
                    />
                    <div>
                      <FormField
                        label="Claim #"
                        value={data.claimNumber}
                        onChange={(v) => update("claimNumber", v)}
                      />
                      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                        Only fill this out if there is an active claim.
                      </div>
                    </div>

                    <div style={{ gridColumn: "1 / -1" }}>
                      <CheckboxField
                        label="Loss location is same as property address"
                        checked={data.lossLocationSameAsAddress}
                        onChange={(checked) => update("lossLocationSameAsAddress", checked)}
                      />
                    </div>

                    <div style={{ gridColumn: "1 / -1" }}>
                      <FormField
                        label="Loss Location"
                        value={data.lossLocation}
                        onChange={(v) => update("lossLocation", v)}
                        disabled={data.lossLocationSameAsAddress}
                      />
                    </div>
                  </div>
                </Card>
                )}

                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Office Info</SectionTitle>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 16,
                    }}
                  >
                    {/* PA Email — hidden when PA workflow is off.
                        PA handles their own paperwork outside the system in
                        that mode, so we don't need a place to enter their
                        notification address. */}
                    {!PA_FORMS_DISABLED && (
                    <FormField
                      label="PA Email"
                      type="email"
                      value={data.paEmail}
                      onChange={(v) => update("paEmail", v)}
                      showError={submitAttempted}
                    />
                    )}

                    {/* Lead Source */}
                    <div>
                      <Label>Lead Source</Label>
                      <div style={{ display: "flex", gap: 10 }}>
                        {[
                          { code: "Inspection", label: "Inspection" },
                          { code: "INS", label: "INS" },
                        ].map((src) => (
                          <button
                            key={src.code}
                            type="button"
                            onClick={() => update("leadSource", src.code)}
                            style={{
                              flex: 1,
                              padding: "10px 8px",
                              borderRadius: 12,
                              border: data.leadSource === src.code ? "2.5px solid #199c2e" : "1.5px solid #d1d5db",
                              background: data.leadSource === src.code ? "#f0fdf4" : "#fff",
                              color: data.leadSource === src.code ? "#166534" : "#374151",
                              fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700,
                              fontSize: 15,
                              cursor: "pointer",
                              letterSpacing: "0.05em",
                            }}
                          >
                            {src.label}
                          </button>
                        ))}
                      </div>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                        {data.leadSource === "Inspection" ? "New lead — will create contact + job in JN" : "Existing lead — will search JN by address"}
                      </div>
                    </div>

                    {/* ── TEST MODE BANNER ── */}
                    {isTestMode && (
                      <div style={{ background: "#fffbeb", border: "2px solid #f59e0b", borderRadius: 14, padding: "16px 18px" }}>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 15, fontWeight: 700, color: "#92400e", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                          🧪 TEST MODE ACTIVE
                          <span style={{ fontSize: 11, fontWeight: 400, color: "#b45309" }}>— last name contains "test"</span>
                        </div>
                        <div style={{ fontSize: 12, color: "#78350f", marginBottom: 12, fontFamily: "'Nunito', sans-serif", lineHeight: 1.5 }}>
                          All emails and SMS will be redirected to the addresses below instead of the actual homeowner/rep.
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div>
                            <Label>Override Email (all emails go here)</Label>
                            <input
                              type="email"
                              value={testOverrideEmail}
                              onChange={e => setTestOverrideEmail(e.target.value)}
                              placeholder="your@email.com"
                              style={{ width: "100%", height: 40, borderRadius: 10, border: "1.5px solid #f59e0b", padding: "0 12px", fontSize: 14, fontFamily: "'Nunito', sans-serif", background: "#fffef7" }}
                            />
                          </div>
                          <div>
                            <Label>Override SMS Phone (all texts go here)</Label>
                            <input
                              type="tel"
                              value={testOverridePhone}
                              onChange={e => setTestOverridePhone(e.target.value)}
                              placeholder="(727) 555-0000"
                              style={{ width: "100%", height: 40, borderRadius: 10, border: "1.5px solid #f59e0b", padding: "0 12px", fontSize: 14, fontFamily: "'Nunito', sans-serif", background: "#fffef7" }}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Sales Rep autocomplete typeahead */}
                    <div style={{ position: "relative" }}>
                      <Label>Sales Rep <span style={{ color: "#dc2626" }}>*</span> {repsLoaded && reps[0]?._fromJN ? <span style={{ fontSize: 11, color: "#16a34a", fontWeight: 400, marginLeft: 6 }}>● Live from JN</span> : null}</Label>
                      <input
                        type="text"
                        value={repSearch}
                        placeholder="Start typing a name..."
                        autoComplete="off"
                        onChange={(e) => {
                          const val = e.target.value;
                          setRepSearch(val);
                          // If cleared, also clear the selected rep
                          if (!val.trim()) {
                            update("salesRepId", "");
                            update("salesRepName", "");
                            update("salesRepEmail", "");
                          }
                          // Filter suggestions
                          if (val.trim().length >= 1) {
                            const lower = val.toLowerCase();
                            const matches = reps
                              .filter(r => r.active !== false && r.name.toLowerCase().includes(lower))
                              .slice(0, 6);
                            setRepSuggestions(matches);
                            setShowRepSuggestions(true);
                          } else {
                            setRepSuggestions([]);
                            setShowRepSuggestions(false);
                          }
                        }}
                        onBlur={() => {
                          // Delay hide so click on suggestion registers first
                          setTimeout(() => setShowRepSuggestions(false), 180);
                          // If what was typed exactly matches a rep name, auto-select
                          if (repSearch.trim()) {
                            const exact = reps.find(r => r.name.toLowerCase() === repSearch.trim().toLowerCase());
                            if (exact) {
                              const jnId = exact.jobnimbus_id || exact.id;
                              update("salesRepId", jnId);
                              update("salesRepName", exact.name);
                              update("salesRepEmail", exact.email || "");
                              setRepSearch(exact.name);
                            }
                          }
                        }}
                        style={{
                          width: "100%",
                          height: 44,
                          borderRadius: 14,
                          border: data.salesRepId ? "1.5px solid #199c2e" : submitAttempted && !data.salesRepName ? "1.5px solid #dc2626" : "1.5px solid #d1d5db",
                          padding: "0 12px",
                          fontSize: 14,
                          boxSizing: "border-box",
                          background: submitAttempted && !data.salesRepName ? "#fef2f2" : "#fff",
                          fontFamily: "'Nunito', sans-serif",
                        }}
                        id="rep-search-field"                      />
                      {/* Selected rep badge */}
                      {data.salesRepId && (
                        <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", marginTop: 11, display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, background: "#dcfce7", color: "#166534", borderRadius: 8, padding: "2px 8px", fontWeight: 700, fontFamily: "'Nunito', sans-serif" }}>✓ Selected</span>
                          <button type="button" onClick={() => { setRepSearch(""); update("salesRepId",""); update("salesRepName",""); update("salesRepEmail",""); }}
                            style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 16, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                        </div>
                      )}
                      {/* Suggestions dropdown */}
                      {showRepSuggestions && repSuggestions.length > 0 && (
                        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1.5px solid #d1d5db", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.10)", zIndex: 999, overflow: "hidden", marginTop: 2 }}>
                          {repSuggestions.map((rep) => (
                            <div
                              key={rep.id}
                              onMouseDown={() => {
                                // Always use the JN ID for syncing — fall back to rep.id if no jn id
                                const jnId = rep.jobnimbus_id || rep.id;
                                update("salesRepId", jnId);
                                update("salesRepName", rep.name);
                                update("salesRepEmail", rep.email || "");
                                setRepSearch(rep.name);
                                setShowRepSuggestions(false);
                              }}
                              style={{ padding: "10px 14px", cursor: "pointer", fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#111827", borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                              onMouseEnter={e => e.currentTarget.style.background = "#f0fdf4"}
                              onMouseLeave={e => e.currentTarget.style.background = "#fff"}
                            >
                              <span style={{ fontWeight: 600 }}>{rep.name}</span>
                              {rep.email ? <span style={{ fontSize: 11, color: "#9ca3af" }}>{rep.email}</span> : null}
                            </div>
                          ))}
                        </div>
                      )}
                      {reps.length === 0 ? (
                        <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          ⚠️ No reps loaded — check JN API connection or go to Manager → Sales Rep Manager to add manually
                        </div>
                      ) : null}

                      {/* Lock-to-JN-list reminder. Shows when the rep has
                          typed text but no JN match is selected (salesRepId
                          empty) — keeps reps from submitting a free-text
                          name that doesn't tie back to a real JN rep. */}
                      {reps.length > 0 && repSearch.trim() && !data.salesRepId ? (
                        <div style={{ fontSize: 12, color: "#b45309", marginTop: 6, fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                          ⚠️ Tap a name from the suggestions to select. Free-typed names won't be saved.
                        </div>
                      ) : null}
                    </div>

                    {/* Rep Email — auto-fills from rep record, saves back if edited */}
                    <div>
                      <Label>Rep Email</Label>
                      <input
                        type="email"
                        value={data.salesRepEmail}
                        placeholder="Rep's email address"
                        onChange={(e) => update("salesRepEmail", e.target.value)}
                        onBlur={async (e) => {
                          const email = e.target.value.trim();
                          if (!email || !data.salesRepId) return;
                          const rep = reps.find(r => r.id === data.salesRepId);
                          if (rep && rep.email !== email) {
                            await supabase.from("sales_reps").update({ email }).eq("id", data.salesRepId);
                            await loadReps();
                          }
                        }}
                        style={{
                          width: "100%",
                          height: 44,
                          borderRadius: 14,
                          border: "1px solid #d1d5db",
                          padding: "0 12px",
                          fontSize: 14,
                          boxSizing: "border-box",
                          background: data.salesRepEmail ? "#fff" : "#fafafa",
                        }}
                      />
                      {data.salesRepId && !data.salesRepEmail ? (
                        <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          ⚠️ No email on file for this rep — type it once and it will be saved
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* ── My Stats Banner — shows once a rep is selected ───────────── */}
                  {data.salesRepId && bannerStats ? (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed #d1d5db" }}>
                      <div style={{ background: "linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%)", borderRadius: 12, padding: "14px 16px", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontSize: 11, opacity: 0.85, letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>This Week (so far)</div>
                          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1.1 }}>
                            {bannerStats.submissions} {bannerStats.submissions === 1 ? "submission" : "submissions"}
                            {bannerStats.resulted > 0 ? <span style={{ fontSize: 13, fontWeight: 400, opacity: 0.85, marginLeft: 8 }}>· {bannerStats.resulted} resulted</span> : null}
                          </div>
                          {bannerStats.rank ? (
                            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                              🏆 Rank #{bannerStats.rank} of {bannerStats.totalReps} active reps
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, fontFamily: "'Nunito', sans-serif", fontStyle: "italic" }}>
                              No submissions this week yet
                            </div>
                          )}
                        </div>
                        <button type="button"
                          onClick={() => setMyStatsOpen(true)}
                          style={{ padding: "8px 16px", borderRadius: 10, border: "1.5px solid rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.15)", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                          📊 View Full Stats
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* ── My Homeowners — only shown after rep selects themselves ─────── */}
                  {/* Lets a rep look up homeowners they've already signed up so they can
                      add additional docs (e.g. LOR/PAC after a Free Inspection found damage)
                      without creating a duplicate inspection record. */}
                  {data.salesRepId ? (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed #d1d5db" }}>
                      {existingClaim ? (
                        <div style={{ background: "#f0fdf4", border: "2px solid #199c2e", borderRadius: 12, padding: "12px 14px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "#166534", fontFamily: "'Oswald', sans-serif" }}>
                                ✏️ Adding docs for: {data.homeowner1}{data.homeowner2 ? ` & ${data.homeowner2}` : ""}
                              </div>
                              <div style={{ fontSize: 11, color: "#166534", fontFamily: "'Nunito', sans-serif", marginTop: 2 }}>
                                Already signed: {alreadySignedDocs.length > 0 ? alreadySignedDocs.map(d => d.toUpperCase()).join(", ") : "none"}
                              </div>
                            </div>
                            <button type="button"
                              onClick={() => {
                                // Clear existing-homeowner mode and reset form
                                setExistingClaim(null);
                                setExistingInsp(null);
                                setAlreadySignedDocs([]);
                                setSelectedDocs(PA_FORMS_DISABLED ? ["insp"] : ["insp", "lor", "pac"]);
                              }}
                              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #166534", background: "#fff", color: "#166534", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", cursor: "pointer" }}>
                              ✕ Clear
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "grid", gap: 8 }}>
                          <button type="button"
                            onClick={() => { setMyHomeownersPendingOnly(false); loadAndOpenMyHomeowners(); }}
                            style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: "2px solid #0a0a0a", background: "#fff", color: "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            📋 My Homeowners — Add Docs to Existing Customer
                          </button>
                          <button type="button"
                            onClick={() => loadAndOpenAwaitingSignature()}
                            style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: "2px solid #ea580c", background: pendingHomeownersCount > 0 ? "#fff7ed" : "#fff", color: "#ea580c", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                            <span>⏳ Awaiting Signature</span>
                            {pendingHomeownersCount > 0 ? (
                              <span style={{ background: "#ea580c", color: "#fff", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
                                {pendingHomeownersCount}
                              </span>
                            ) : null}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </Card>

                {/* Claim Stage selector — hidden when PA workflow is off.
                    The "Roof Was Inspected" branch is a PA flow (damage
                    confirmed → file claim with PA), so without PA it has
                    nowhere to go. With this hidden, claimStage stays at
                    the "pre_inspection" default for every new signing —
                    the email composer + admin notes downstream both
                    branch correctly off that. */}
                {!PA_FORMS_DISABLED && (
                <Card style={{ padding: 20, background: "#f8fafc" }}>
                  <SectionTitle>Claim Stage</SectionTitle>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <button
                      type="button"
                      onClick={() => update("claimStage", "pre_inspection")}
                      style={{
                        padding: "16px 12px",
                        borderRadius: 16,
                        border: data.claimStage === "pre_inspection" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                        background: data.claimStage === "pre_inspection" ? "#f0fdf4" : "#fff",
                        cursor: "pointer",
                        textAlign: "center",
                        transition: "all 0.2s",
                      }}
                    >
                      <div style={{ fontSize: 28, marginBottom: 6 }}>🏠</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>
                        Roof Needs Inspection
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                        Signing before the inspection — next step is scheduling
                      </div>
                      {data.claimStage === "pre_inspection" ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                      ) : null}
                    </button>

                    <button
                      type="button"
                      onClick={() => update("claimStage", "post_inspection")}
                      style={{
                        padding: "16px 12px",
                        borderRadius: 16,
                        border: data.claimStage === "post_inspection" ? "3px solid #199c2e" : "2px solid #e5e7eb",
                        background: data.claimStage === "post_inspection" ? "#f0fdf4" : "#fff",
                        cursor: "pointer",
                        textAlign: "center",
                        transition: "all 0.2s",
                      }}
                    >
                      <div style={{ fontSize: 28, marginBottom: 6 }}>✅</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>
                        Roof Was Inspected
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                        Damage confirmed — filing the claim now
                      </div>
                      {data.claimStage === "post_inspection" ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                      ) : null}
                    </button>
                  </div>
                </Card>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#374151",
                    marginBottom: 12,
                  }}
                >
                  Signing option
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 12,
                  }}
                >
                  <Button
                    variant={signMode === "now" ? "default" : "outline"}
                    onClick={() => setSignMode("now")}
                  >
                    <FileSignature size={16} /> Sign Now
                  </Button>

                  <Button
                    variant={signMode === "send" ? "default" : "outline"}
                    onClick={() => setSignMode("send")}
                  >
                    <Send size={16} /> Send for Signing
                  </Button>
                </div>
              </div>

              <div style={{ marginTop: 20 }}>
                <Separator />
              </div>

              <div style={{ marginTop: 20 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#374151",
                    marginBottom: 12,
                  }}
                >
                  Choose form{selectedDocs.length !== 1 ? "s" : ""}
                </div>

                {/* "PA forms temporarily disabled" banner removed when
                    PA workflow is off — the doc-selection UI just shows
                    the inspection agreement alone, no explanation needed.
                    Toggle it back on in Manager → PA Management to see
                    the LoR + PA Authorization options again. */}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>

                  {/* Free Roof Inspection — U.S. Shingle branding (navy + red,
                      a separate company from the PA — does NOT inherit the
                      Healthy Homes black/gold theme). */}
                  <button type="button" onClick={() => toggleDocSelection("insp")}
                    disabled={alreadySignedDocs.includes("insp")}
                    style={{
                      padding: 0, borderRadius: 16, textAlign: "left", cursor: alreadySignedDocs.includes("insp") ? "not-allowed" : "pointer",
                      border: alreadySignedDocs.includes("insp") ? "2px solid #199c2e" : selectedDocs.includes("insp") ? "3px solid #1a2e5a" : "2px solid #d1d5db",
                      background: "#fff",
                      boxShadow: selectedDocs.includes("insp") ? "0 4px 16px rgba(26,46,90,0.25)" : "0 2px 6px rgba(0,0,0,0.06)",
                      transition: "all 0.15s",
                      overflow: "hidden",
                      opacity: alreadySignedDocs.includes("insp") ? 0.6 : 1,
                    }}>
                    {/* Top third — Navy */}
                    <div style={{ background: "#1a2e5a", padding: "10px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.5)", flexShrink: 0 }} />
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.8)", flexShrink: 0 }} />
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "#fff", letterSpacing: "0.06em", textTransform: "uppercase", marginLeft: 4 }}>
                          U.S. Shingle & Metal
                        </span>
                      </div>
                    </div>
                    {/* Middle third — White */}
                    <div style={{ background: "#fff", padding: "10px 14px" }}>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827" }}>
                        🏠 Free Roof Inspection
                      </div>
                      {alreadySignedDocs.includes("insp") ? (
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#199c2e", fontFamily: "'Nunito', sans-serif", marginTop: 2 }}>✓ Already signed</div>
                      ) : selectedDocs.includes("insp") ? (
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#1a2e5a", fontFamily: "'Nunito', sans-serif", marginTop: 2 }}>✓ Selected</div>
                      ) : null}
                    </div>
                    {/* Bottom third — Red */}
                    <div style={{ background: "#c8392b", padding: "8px 14px" }}>
                      <div style={{ fontSize: 12, color: "#fff", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.3 }}>
                        Homeowner signs inspection agreement
                      </div>
                    </div>
                  </button>

                  {/* LoR + PA Authorization cards — hidden entirely when
                      PA workflow is off (instead of just being disabled
                      with grayscale + ⛔ "temporarily disabled" labels).
                      Cleaner UX: reps see only the inspection card and
                      have no idea PA docs are even an option until admin
                      flips the workflow on from Manager → PA Management. */}
                  {!PA_FORMS_DISABLED && (
                  <>
                  {/* Letter of Representation — Healthy Homes branding
                      (black card, gold stripe on the title to match the USS
                      card's striped layout). */}
                  <button type="button" onClick={() => toggleDocSelection("lor")}
                    disabled={alreadySignedDocs.includes("lor") || PA_FORMS_DISABLED}
                    title={PA_FORMS_DISABLED ? "Temporarily disabled — new PA setup in progress" : undefined}
                    style={{
                      padding: 0, borderRadius: 16, textAlign: "left", cursor: (alreadySignedDocs.includes("lor") || PA_FORMS_DISABLED) ? "not-allowed" : "pointer",
                      border: alreadySignedDocs.includes("lor") ? "2px solid #fff" : selectedDocs.includes("lor") ? "2px solid #c9a35c" : "1px solid #1f1f1f",
                      background: alreadySignedDocs.includes("lor")
                        ? "linear-gradient(135deg, #6ee7b7 0%, #34d399 100%)"
                        : selectedDocs.includes("lor")
                          ? "linear-gradient(135deg, #0a0a0a 0%, #1f1f1f 100%)"
                          : "linear-gradient(135deg, #1f1f1f 0%, #0a0a0a 100%)",
                      boxShadow: selectedDocs.includes("lor") ? "0 4px 16px rgba(201,163,92,0.45)" : "0 2px 8px rgba(0,0,0,0.25)",
                      transition: "all 0.15s",
                      overflow: "hidden",
                      opacity: PA_FORMS_DISABLED ? 0.4 : alreadySignedDocs.includes("lor") ? 0.7 : selectedDocs.includes("lor") ? 1 : 0.85,
                      filter: PA_FORMS_DISABLED ? "grayscale(0.6)" : "none",
                      position: "relative",
                    }}>
                    <div style={{ padding: "12px 14px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.7)", flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)", letterSpacing: "0.06em", textTransform: "uppercase", marginLeft: 4 }}>
                          Healthy Homes Public Adjusting
                        </span>
                      </div>
                    </div>
                    <div style={{ background: "#c9a35c", padding: "10px 14px", borderTop: "1px solid #a17e3f", borderBottom: "1px solid #a17e3f" }}>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#0a0a0a", letterSpacing: "0.02em" }}>
                        📋 Letter of Representation
                      </div>
                    </div>
                    <div style={{ padding: "10px 14px 12px" }}>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                        Authorizes Healthy Homes to represent the client
                      </div>
                      {PA_FORMS_DISABLED ? (
                        <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: "#fbbf24", fontFamily: "'Nunito', sans-serif" }}>⛔ Temporarily disabled</div>
                      ) : alreadySignedDocs.includes("lor") ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#fff", fontFamily: "'Nunito', sans-serif" }}>✓ Already signed</div>
                      ) : selectedDocs.includes("lor") ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#c9a35c", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                      ) : null}
                    </div>
                  </button>

                  {/* PA Authorization — Healthy Homes branding
                      (black card, gold stripe on the title to match the LOR
                      and USS cards' striped layout). */}
                  <button type="button" onClick={() => toggleDocSelection("pac")}
                    disabled={alreadySignedDocs.includes("pac") || PA_FORMS_DISABLED}
                    title={PA_FORMS_DISABLED ? "Temporarily disabled — new PA setup in progress" : undefined}
                    style={{
                      padding: 0, borderRadius: 16, textAlign: "left", cursor: (alreadySignedDocs.includes("pac") || PA_FORMS_DISABLED) ? "not-allowed" : "pointer",
                      border: alreadySignedDocs.includes("pac") ? "2px solid #fff" : selectedDocs.includes("pac") ? "2px solid #c9a35c" : "1px solid #1f1f1f",
                      background: alreadySignedDocs.includes("pac")
                        ? "linear-gradient(135deg, #6ee7b7 0%, #34d399 100%)"
                        : selectedDocs.includes("pac")
                          ? "linear-gradient(135deg, #1f1f1f 0%, #0a0a0a 100%)"
                          : "linear-gradient(135deg, #0a0a0a 0%, #1f1f1f 100%)",
                      boxShadow: selectedDocs.includes("pac") ? "0 4px 16px rgba(201,163,92,0.45)" : "0 2px 8px rgba(0,0,0,0.25)",
                      transition: "all 0.15s",
                      overflow: "hidden",
                      opacity: PA_FORMS_DISABLED ? 0.4 : alreadySignedDocs.includes("pac") ? 0.7 : selectedDocs.includes("pac") ? 1 : 0.85,
                      filter: PA_FORMS_DISABLED ? "grayscale(0.6)" : "none",
                    }}>
                    <div style={{ padding: "12px 14px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.7)", flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "rgba(255,255,255,0.85)", letterSpacing: "0.06em", textTransform: "uppercase", marginLeft: 4 }}>
                          Healthy Homes Public Adjusting
                        </span>
                      </div>
                    </div>
                    <div style={{ background: "#c9a35c", padding: "10px 14px", borderTop: "1px solid #a17e3f", borderBottom: "1px solid #a17e3f" }}>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#0a0a0a", letterSpacing: "0.02em" }}>
                        📄 PA Authorization
                      </div>
                    </div>
                    <div style={{ padding: "10px 14px 12px" }}>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>
                        Public Adjuster Contract
                      </div>
                      {PA_FORMS_DISABLED ? (
                        <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: "#fbbf24", fontFamily: "'Nunito', sans-serif" }}>⛔ Temporarily disabled</div>
                      ) : alreadySignedDocs.includes("pac") ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#fff", fontFamily: "'Nunito', sans-serif" }}>✓ Already signed</div>
                      ) : selectedDocs.includes("pac") ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#c9a35c", fontFamily: "'Nunito', sans-serif" }}>✓ Selected</div>
                      ) : null}
                    </div>
                  </button>
                  </>
                  )}
                </div>

                {selectedDocs.includes("insp") && (selectedDocs.includes("lor") || selectedDocs.includes("pac")) ? (
                  <div style={{ marginTop: 10, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#1e40af", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                    ℹ️ Inspection form first, then PA paperwork — the app will guide you through both in order.
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 10 }}>
                    Select one or more forms to include in this signing session.
                  </div>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <Button onClick={beginDocumentFlow} disabled={!selectedDocs.length}>
                  {signMode === "send"
                    ? "Continue to Send for Signing"
                    : "Continue to Sign"}
                </Button>
              </div>
            </CardContent>

            {/* GUIDED OVERLAY — when active, sits above the Quick form's
                CardContent (which is hidden via display:none below). This is
                a sibling rather than a wrap to avoid unbalancing the existing
                Card markup. */}
            {intakeMode === "guided" ? (
              <div style={{ padding: 16 }}>
                <GuidedIntakeFlow
                  step={guidedStep}
                  setStep={setGuidedStep}
                  newVsExisting={guidedNewVsExisting}
                  setNewVsExisting={setGuidedNewVsExisting}
                  data={data}
                  setData={setData}
                  selectedDocs={selectedDocs}
                  setSelectedDocs={setSelectedDocs}
                  reps={reps}
                  repSearch={repSearch}
                  setRepSearch={setRepSearch}
                  existingInsp={existingInsp}
                  alreadySignedDocs={alreadySignedDocs}
                  openMyHomeowners={() => loadAndOpenMyHomeowners()}
                  myHomeownersOpen={myHomeownersOpen}
                  onFinishToSign={() => {
                    // Hand off to the Quick-mode signing flow with the data
                    // already populated. Quick mode is what currently knows
                    // how to render dialogs and run the submit pipeline.
                    setIntakeMode("quick");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  onCancel={() => setIntakeMode("quick")}
                />
              </div>
            ) : null}
          </Card>
        ) : null}

        {view === "review" ? (
          <>
            {!isSigningFromLink ? (
              <div>
                <Button
                  variant="outline"
                  onClick={() => setView("input")}
                >
                  <ArrowLeft size={16} /> Back
                </Button>
              </div>
            ) : null}

            {/* ── Hero welcome banner ── */}
            <div
              style={{
                background: "linear-gradient(135deg, #199c2e 0%, #14752200 100%), #199c2e",
                borderRadius: 24,
                padding: "36px 32px 32px",
                color: "#fff",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {/* decorative circle */}
              <div style={{ position: "absolute", top: -40, right: -40, width: 180, height: 180, background: "rgba(255,255,255,0.07)", borderRadius: "50%" }} />
              <div style={{ position: "absolute", bottom: -20, right: 60, width: 100, height: 100, background: "rgba(255,255,255,0.05)", borderRadius: "50%" }} />

              <div style={{ fontSize: 44, marginBottom: 10 }}>👋</div>
              <div
                style={{
                  fontSize: 36,
                  fontWeight: 700,
                  fontFamily: "'Oswald', sans-serif",
                  lineHeight: 1.15,
                  marginBottom: 14,
                  letterSpacing: "0.01em",
                }}
              >
                You're Almost Done!
              </div>
              <div
                style={{
                  fontSize: 21,
                  lineHeight: 1.7,
                  opacity: 0.95,
                  maxWidth: 580,
                  fontFamily: "'Nunito', sans-serif",
                  fontWeight: 600,
                }}
              >
                {reviewHeadline}
              </div>
            </div>

            {/* ── Step indicator ── */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "0 4px",
              }}
            >
              {[
                { n: "1", label: "Review Docs" },
                { n: "2", label: "Authorize" },
                { n: "3", label: "Sign & Done!" },
              ].map((step, i) => (
                <React.Fragment key={step.n}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        background: i === 0 ? "#199c2e" : i === 1 ? (reviewReady ? "#199c2e" : "#e5e7eb") : (reviewReady ? "#199c2e" : "#e5e7eb"),
                        color: i === 0 ? "#fff" : (reviewReady ? "#fff" : "#9ca3af"),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: 15,
                        fontFamily: "'Oswald', sans-serif",
                        transition: "background 0.4s",
                      }}
                    >
                      {step.n}
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                      {step.label}
                    </div>
                  </div>
                  {i < 2 ? (
                    <div style={{ flex: 1, height: 3, background: reviewReady && i === 0 ? "#199c2e" : "#e5e7eb", margin: "0 4px", marginBottom: 20, transition: "background 0.4s" }} />
                  ) : null}
                </React.Fragment>
              ))}
            </div>

            {/* ── Document cards ── */}
            <div style={{ display: "grid", gap: 20 }}>

              {selectedDocs.includes("insp") ? (
                /* Free Roof Inspection — U.S. Shingle branded.
                   USS is a separate company from Healthy Homes, so this card
                   stays in USS navy/red regardless of the broader gold/black
                   theme on the rest of the review screen. */
                <div style={{
                  borderRadius: 24,
                  border: inspAgreed ? "3px solid #1a2e5a" : "2px solid #e5e7eb",
                  background: inspAgreed ? "#eef1f8" : "#fff",
                  padding: "0",
                  transition: "border-color 0.3s, background 0.3s",
                  boxShadow: inspAgreed ? "0 0 0 4px rgba(26,46,90,0.08)" : "0 1px 3px rgba(0,0,0,0.06)",
                  overflow: "hidden",
                }}>
                  {/* USS tricolor stripe — navy / white / red */}
                  <div style={{ display: "flex", height: 6 }}>
                    <div style={{ flex: 1, background: "#1a2e5a" }} />
                    <div style={{ flex: 1, background: "#e5e7eb" }} />
                    <div style={{ flex: 1, background: "#c8392b" }} />
                  </div>
                  <div style={{ padding: "24px 28px 20px" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                      <div style={{
                        width: 52, height: 52, borderRadius: 16,
                        background: inspAgreed ? "#1a2e5a" : "#f3f4f6",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 24, flexShrink: 0, transition: "background 0.3s",
                      }}>
                        {inspAgreed ? "✅" : "🏠"}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#1a2e5a", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                          U.S. Shingle & Metal LLC — Document 1 of {selectedDocs.length}
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", lineHeight: 1.2 }}>
                          Free Roof Inspection Agreement
                        </div>
                      </div>
                    </div>
                    <p style={{ fontSize: 14, color: "#374151", fontFamily: "'Nunito', sans-serif", lineHeight: 1.6, margin: "0 0 20px" }}>
                      This authorizes U.S. Shingle & Metal LLC to perform a free roof inspection at your property and share findings with a Public Adjuster for review.
                    </p>
                    {!inspAgreed ? (
                      <div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginBottom: 10 }}>
                          <button type="button"
                            onClick={async () => {
                              try {
                                const blob = await generatePDF("#inspection-printable", "Free-Roof-Inspection-Agreement.pdf");
                                const blobUrl = URL.createObjectURL(blob);
                                window.open(blobUrl, "_blank");
                                setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                              } catch(err) { alert(err?.message || "Failed to preview."); }
                            }}
                            style={{
                              padding: "12px 8px", borderRadius: 12,
                              border: "2px solid #1a2e5a", background: "#fff",
                              color: "#1a2e5a", fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700, fontSize: 13, cursor: "pointer",
                              letterSpacing: "0.04em", textTransform: "uppercase",
                            }}>
                            👁 Preview
                          </button>
                          <button type="button" onClick={() => setInspAgreed(true)}
                          style={{
                            width: "100%", padding: 0, borderRadius: 16, border: "none",
                            background: "transparent", cursor: "pointer",
                            overflow: "hidden", display: "flex", flexDirection: "column",
                            animation: "ccg-pulse 2s infinite",
                          }}>
                          <div style={{ background: "#c8392b", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#fff", letterSpacing: "0.04em", textTransform: "uppercase" }}>👍 Tap Here</span>
                          </div>
                          <div style={{ background: "#fff", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center", borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#1a2e5a", letterSpacing: "0.04em", textTransform: "uppercase" }}>Looks Good!</span>
                          </div>
                          <div style={{ background: "#1a2e5a", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#fff", letterSpacing: "0.04em", textTransform: "uppercase" }}>✅ Authorized</span>
                          </div>
                        </button>
                        </div>
                        <div style={{ textAlign: "center", marginTop: 10, fontSize: 13, color: "#1a2e5a", fontWeight: 600, fontFamily: "'Nunito', sans-serif" }}>
                          ☝️ Please tap the button above to continue
                        </div>
                      </div>
                    ) : (
                      <div style={{ background: "#1a2e5a", borderRadius: 14, padding: "14px 20px", textAlign: "center" }}>
                        <span style={{ fontSize: 20, fontWeight: 700, color: "#fff", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em" }}>
                          ✅ Authorized!
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {selectedDocs.includes("lor") ? (
                /* Letter of Representation — Healthy Homes branded (black + gold). */
                <div
                  style={{
                    borderRadius: 24,
                    border: lorAgreed ? "2px solid #a17e3f" : "2px solid #e5e7eb",
                    background: lorAgreed ? "#faf3e0" : "#fff",
                    padding: "28px 28px 24px",
                    transition: "border-color 0.3s, background 0.3s",
                    boxShadow: lorAgreed ? "0 0 0 4px rgba(201,163,92,0.18)" : "0 1px 3px rgba(0,0,0,0.06)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 16,
                        background: lorAgreed ? "#0a0a0a" : "#f3f4f6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 24,
                        flexShrink: 0,
                        transition: "background 0.3s",
                      }}
                    >
                      {lorAgreed ? "✅" : "📄"}
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#a17e3f",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          fontFamily: "'Oswald', sans-serif",
                          marginBottom: 4,
                        }}
                      >
                        Healthy Homes — Document {selectedDocs.includes("insp") ? "2" : "1"} of {selectedDocs.length}
                      </div>
                      <div
                        style={{
                          fontSize: 26,
                          fontWeight: 700,
                          color: "#111827",
                          fontFamily: "'Oswald', sans-serif",
                          lineHeight: 1.15,
                        }}
                      >
                        Letter of Representation
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 19,
                      lineHeight: 1.75,
                      color: "#374151",
                      marginBottom: 24,
                      paddingLeft: 68,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 500,
                    }}
                  >
                    {reviewLorText}
                  </div>

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", paddingLeft: 68 }}>
                    <button
                      type="button"
                      onClick={() => previewDocument("lor")}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "10px 18px",
                        borderRadius: 12,
                        border: "1.5px solid #d1d5db",
                        background: "#fff",
                        color: "#374151",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 600,
                        fontSize: 14,
                        letterSpacing: "0.03em",
                        cursor: "pointer",
                        textTransform: "uppercase",
                      }}
                    >
                      👁 Preview Document
                    </button>

                    <button
                      type="button"
                      onClick={() => setLorAgreed(true)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        padding: lorAgreed ? "12px 28px" : "14px 32px",
                        borderRadius: 16,
                        border: lorAgreed ? "2px solid #a17e3f" : "3px solid #a17e3f",
                        background: lorAgreed ? "#faf3e0" : "#0a0a0a",
                        color: lorAgreed ? "#a17e3f" : "#c9a35c",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700,
                        fontSize: lorAgreed ? 16 : 18,
                        letterSpacing: "0.04em",
                        cursor: lorAgreed ? "default" : "pointer",
                        textTransform: "uppercase",
                        transition: "all 0.3s",
                        boxShadow: lorAgreed ? "none" : "0 6px 20px rgba(201,163,92,0.45)",
                        animation: lorAgreed ? "none" : "ccg-pulse 2s ease-in-out infinite",
                      }}
                    >
                      {lorAgreed ? "✅ Authorized!" : "👍 Tap Here — Looks Good!"}
                    </button>
                  </div>
                  {!lorAgreed ? (
                    <div style={{
                      marginTop: 10,
                      paddingLeft: 68,
                      fontSize: 13,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 700,
                      color: "#a17e3f",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      animation: "ccg-bounce 1.2s ease-in-out infinite",
                    }}>
                      ☝️ Please tap the gold button above to continue
                    </div>
                  ) : null}
                </div>
              ) : null}

              {selectedDocs.includes("pac") ? (
                /* PA Authorization — Healthy Homes branded (black + gold). */
                <div
                  style={{
                    borderRadius: 24,
                    border: pacAgreed ? "2px solid #a17e3f" : "2px solid #e5e7eb",
                    background: pacAgreed ? "#faf3e0" : "#fff",
                    padding: "28px 28px 24px",
                    transition: "border-color 0.3s, background 0.3s",
                    boxShadow: pacAgreed ? "0 0 0 4px rgba(201,163,92,0.18)" : "0 1px 3px rgba(0,0,0,0.06)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 16,
                        background: pacAgreed ? "#0a0a0a" : "#f3f4f6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 24,
                        flexShrink: 0,
                        transition: "background 0.3s",
                      }}
                    >
                      {pacAgreed ? "✅" : "📋"}
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#a17e3f",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          fontFamily: "'Oswald', sans-serif",
                          marginBottom: 4,
                        }}
                      >
                        Healthy Homes — Document {(selectedDocs.includes("insp") ? 1 : 0) + (selectedDocs.includes("lor") ? 1 : 0) + 1} of {selectedDocs.length}
                      </div>
                      <div
                        style={{
                          fontSize: 26,
                          fontWeight: 700,
                          color: "#111827",
                          fontFamily: "'Oswald', sans-serif",
                          lineHeight: 1.15,
                        }}
                      >
                        Public Adjuster Authorization
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 19,
                      lineHeight: 1.75,
                      color: "#374151",
                      marginBottom: 24,
                      paddingLeft: 68,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 500,
                    }}
                  >
                    {reviewPacText}
                  </div>

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", paddingLeft: 68 }}>
                    <button
                      type="button"
                      onClick={() => previewDocument("pac")}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "10px 18px",
                        borderRadius: 12,
                        border: "1.5px solid #d1d5db",
                        background: "#fff",
                        color: "#374151",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 600,
                        fontSize: 14,
                        letterSpacing: "0.03em",
                        cursor: "pointer",
                        textTransform: "uppercase",
                      }}
                    >
                      👁 Preview Document
                    </button>

                    <button
                      type="button"
                      onClick={() => setPacAgreed(true)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        padding: pacAgreed ? "12px 28px" : "14px 32px",
                        borderRadius: 16,
                        border: pacAgreed ? "2px solid #a17e3f" : "3px solid #a17e3f",
                        background: pacAgreed ? "#faf3e0" : "#0a0a0a",
                        color: pacAgreed ? "#a17e3f" : "#c9a35c",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700,
                        fontSize: pacAgreed ? 16 : 18,
                        letterSpacing: "0.04em",
                        cursor: pacAgreed ? "default" : "pointer",
                        textTransform: "uppercase",
                        transition: "all 0.3s",
                        boxShadow: pacAgreed ? "none" : "0 6px 20px rgba(201,163,92,0.45)",
                        animation: pacAgreed ? "none" : "ccg-pulse 2s ease-in-out infinite",
                      }}
                    >
                      {pacAgreed ? "✅ Authorized!" : "👍 Tap Here — Looks Good!"}
                    </button>
                  </div>
                  {!pacAgreed ? (
                    <div style={{
                      marginTop: 10,
                      paddingLeft: 68,
                      fontSize: 13,
                      fontFamily: "'Nunito', sans-serif",
                      fontWeight: 700,
                      color: "#a17e3f",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}>
                      ☝️ Please tap the gold button above to continue
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* ── Help text ── */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "14px 20px",
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 14,
                fontSize: 15,
                color: "#92400e",
              }}
            >
              <span style={{ fontSize: 20 }}>💡</span>
              <span style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 600, fontSize: 16 }}>{reviewHelpText}</span>
            </div>

            <div id="signature-section" style={{ scrollMarginTop: 20 }}>
              {renderSigningFields(pendingSend)}
            </div>

            <div
              style={{
                position: "absolute",
                left: "-20000px",
                top: 0,
                width: 1100,
                pointerEvents: "none",
              }}
            >
              {selectedDocs.includes("lor") ? (
                <LetterOfRepresentation
                  data={data}
                  sig1={effectiveSig1}
                  sig2={effectiveSig2}
                  auditInfo={auditInfo}
                  claimId={currentClaimId}
                  isExportingPdf={isExportingPdf}
                />
              ) : null}

              {selectedDocs.includes("pac") ? (
                <PublicAdjusterContract
                  data={{
                    ...data,
                    initials1: effectiveInitials1,
                    initials2: effectiveInitials2,
                  }}
                  sig1={effectiveSig1}
                  sig2={effectiveSig2}
                  auditInfo={auditInfo}
                  claimId={currentClaimId}
                  isExportingPdf={isExportingPdf}
                />
              ) : null}
            </div>
          </>
        ) : null}

        {view === "sign" ? (
          <>
            {!isSigningFromLink ? (
              <div>
                <Button
                  variant="outline"
                  onClick={() => setView("input")}
                >
                  <ArrowLeft size={16} /> Back
                </Button>
              </div>
            ) : null}

            <Card>
              <CardContent>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#111827",
                    marginBottom: 10,
                  }}
                >
                  Forms included in this signing session
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {selectedDocs.map((doc) => (
                    <div
                      key={doc}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 999,
                        background: "#eef2ff",
                        border: "1px solid #c7d2fe",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#3730a3",
                      }}
                    >
                      {documentLabel(doc)}
                    </div>
                  ))}
                </div>

                {selectedDocs.length > 1 ? (
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: 13,
                      color: "#6b7280",
                    }}
                  >
                    Review both documents below. Your signatures and initials
                    will apply to all selected forms.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {selectedDocs.includes("lor") ? (
              <LetterOfRepresentation
                data={data}
                sig1={effectiveSig1}
                sig2={effectiveSig2}
                auditInfo={auditInfo}
                claimId={currentClaimId}
                isExportingPdf={isExportingPdf}
              />
            ) : null}

            {selectedDocs.includes("pac") ? (
              <PublicAdjusterContract
                data={{
                  ...data,
                  initials1: effectiveInitials1,
                  initials2: effectiveInitials2,
                }}
                sig1={effectiveSig1}
                sig2={effectiveSig2}
                auditInfo={auditInfo}
                claimId={currentClaimId}
                isExportingPdf={isExportingPdf}
              />
            ) : null}

            <div id="signature-section" style={{ scrollMarginTop: 20 }}>
              {renderSigningFields(pendingSend)}
            </div>
          </>
        ) : null}
        {/* ── DUPLICATE VIEW ── */}
        {view === "duplicate" && duplicateRecord ? (
          <DuplicateScreen
            duplicateRecord={duplicateRecord}
            signMode={signMode}
            signerEmail={data.signerEmail}
            onGoBack={() => { setDuplicateRecord(null); setView("input"); }}
            onProceedAnyway={() => {
              setDuplicateRecord(null);
              setPendingSend(signMode === "send");
              setCurrentClaimId(null);
              setAuditInfo(initialAuditInfo);
              setSig1(""); setSig2(""); setTypedSig1(""); setTypedSig2("");
              setSigMethod1("draw"); setSigMethod2("draw");
              setInitialsMethod1("draw"); setInitialsMethod2("draw");
              setData(prev => ({ ...prev, initials1: "", initials2: "" }));
              setInitials1Typed(""); setInitials2Typed("");
              setLorAgreed(false); setPacAgreed(false); setInspAgreed(false);
              setSubmitAttempted(false); setInspSig(""); setInspTypedSig("");
              setInspSubmitAttempted(false); setInspectionOnly(false);
              window.scrollTo({ top: 0, behavior: "smooth" });
              if (signMode === "send") setView("sending");
              else setView("review");
            }}
            onResend={async () => {
              const rec = duplicateRecord.record;
              if (duplicateRecord.type === "claim" && rec.id) setCurrentClaimId(rec.id);
              setDuplicateRecord(null);
              setPendingSend(true);
              setView("sending");
            }}
          />
        ) : null}

        {/* ── SENDING VIEW — auto-submits when entered ── */}
        {view === "sending" ? (
          <SendingScreen onMount={async () => {
            setIsSubmitting(true);
            try { await submitDoc(); }
            catch(e) { alert(e?.message || "Something went wrong."); setView("input"); setIsSubmitting(false); }
          }} />
        ) : null}

        {/* ── SENT VIEW — confirmation after send-for-signing ── */}
        {view === "sent" ? (
          <div style={{ maxWidth: 540, margin: "0 auto", padding: "48px 20px" }}>
            <div style={{
              background: "linear-gradient(135deg, #199c2e 0%, #15803d 100%)",
              borderRadius: 24, padding: "40px 32px", textAlign: "center", color: "#fff", marginBottom: 24,
            }}>
              <div style={{ fontSize: 64, marginBottom: 12 }}>📨</div>
              <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 10 }}>
                Sent for Signing!
              </div>
              <div style={{ fontSize: 16, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92, lineHeight: 1.6 }}>
                The signing link has been emailed to<br/>
                <strong>{data.signerEmail}</strong>
              </div>
            </div>
            <div style={{ background: "#fff", borderRadius: 20, border: "1px solid #e5e7eb", padding: "24px 26px", marginBottom: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", marginBottom: 14, letterSpacing: "0.02em" }}>
                What happens next:
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>📧</span><span>Homeowner receives an email with a secure signing link</span>
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>✍️</span><span>They review and sign at their own pace</span>
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>📋</span><span>Once signed, you and the PA will be notified automatically</span>
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 14, fontFamily: "'Nunito', sans-serif", color: "#374151", fontWeight: 600 }}>
                  <span>📄</span><span>Signed PDFs emailed to everyone — no follow-up needed</span>
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <button type="button" onClick={() => { setView("input"); setSignMode("now"); setRepSearch(""); }}
                style={{ padding: "14px", borderRadius: 14, border: "2px solid #199c2e", background: "#fff", color: "#199c2e", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                ✚ New Intake
              </button>
              <button type="button" onClick={() => { setView("input"); setSignMode("send"); setRepSearch(""); }}
                style={{ padding: "14px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                📨 Send Another
              </button>
            </div>
          </div>
        ) : null}

        {/* ── THANK YOU VIEW ── */}
        {view === "thankyou" ? (
          <>
          <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 16px" }}>

            {/* ── SIGN NOW: Rep confirmation screen ── */}
            {!isSigningFromLink && !inspectionOnly ? (
              <>
                <div style={{
                  background: "linear-gradient(135deg, #199c2e 0%, #15803d 100%)",
                  borderRadius: 28, padding: "40px 36px", textAlign: "center",
                  marginBottom: 24, color: "#fff",
                }}>
                  <div style={{ fontSize: 72, marginBottom: 16 }}>✅</div>
                  <div style={{ fontSize: 34, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 12 }}>
                    Documents Signed!
                  </div>
                  <div style={{ fontSize: 18, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.93, lineHeight: 1.6 }}>
                    {[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")} has signed. PDFs have been emailed to everyone.
                  </div>
                </div>

                {/* JN reminder */}
                <div style={{ background: "#fffbeb", border: "2px solid #f59e0b", borderRadius: 20, padding: "20px 24px", marginBottom: 20 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#92400e", fontFamily: "'Oswald', sans-serif", marginBottom: 10, letterSpacing: "0.03em" }}>
                    ⚠️ Don't Forget — Update JobNimbus
                  </div>
                  <div style={{ display: "grid", gap: 8, fontSize: 14, color: "#78350f", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                    <div>1. Go to JobNimbus and find or create this contact</div>
                    <div>2. Update all fields (address, insurance, policy #, etc.)</div>
                    <div>3. Upload the signed inspection form from your email</div>
                  </div>
                </div>

                <div style={{ background: "#fff", borderRadius: 20, border: "1px solid #e5e7eb", padding: "24px 28px", marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", marginBottom: 14, letterSpacing: "0.02em" }}>Summary</div>
                  <div style={{ display: "grid", gap: 8, fontSize: 14, fontFamily: "'Nunito', sans-serif" }}>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Homeowner:</span>
                      <span style={{ fontWeight: 700 }}>{[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Address:</span>
                      <span style={{ fontWeight: 600 }}>{[data.address, data.city, data.state].filter(Boolean).join(", ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Rep:</span>
                      <span style={{ fontWeight: 600 }}>{data.salesRepName || "—"}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Docs:</span>
                      <span style={{ fontWeight: 600 }}>{selectedDocs.map(d => documentLabel(d)).join(", ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Email:</span>
                      <span style={{ fontWeight: 600 }}>{data.signerEmail}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <button type="button" onClick={() => { setView("input"); setData(prev => ({ ...prev, homeowner1: "", homeowner2: "", phone: "", signerEmail: "", address: "", city: "", state: "", zip: "" })); setRepSearch(""); window.scrollTo({ top: 0 }); }}
                    style={{ padding: "14px", borderRadius: 14, border: "2px solid #199c2e", background: "#fff", color: "#199c2e", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                    ✚ New Client
                  </button>
                  <button type="button" onClick={() => { setView("input"); window.scrollTo({ top: 0 }); }}
                    style={{ padding: "14px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                    ← Back to Intake
                  </button>
                </div>
              </>
            ) : null}

            {/* ── INSPECTION ONLY (sign now): Rep confirmation ── */}
            {inspectionOnly && !isSigningFromLink ? (
              <>
                <div style={{
                  background: "linear-gradient(135deg, #0a0a0a 0%, #0f1e3d 100%)",
                  borderRadius: 28, padding: "40px 36px", textAlign: "center",
                  marginBottom: 24, color: "#fff",
                }}>
                  <div style={{ fontSize: 72, marginBottom: 16 }}>✅</div>
                  <div style={{ fontSize: 34, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 12 }}>
                    Inspection Signed!
                  </div>
                  <div style={{ fontSize: 18, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.93, lineHeight: 1.6 }}>
                    {inspData.clientName || [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")} has signed. PDFs have been emailed to everyone.
                  </div>
                </div>

                {/* JN reminder */}
                <div style={{ background: "#fffbeb", border: "2px solid #f59e0b", borderRadius: 20, padding: "20px 24px", marginBottom: 20 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#92400e", fontFamily: "'Oswald', sans-serif", marginBottom: 10, letterSpacing: "0.03em" }}>
                    ⚠️ Don't Forget — Update JobNimbus
                  </div>
                  <div style={{ display: "grid", gap: 8, fontSize: 14, color: "#78350f", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                    <div>1. Go to JobNimbus and find or create this contact</div>
                    <div>2. Update all fields (address, phone, email, etc.)</div>
                    <div>3. Upload the signed inspection form from your email</div>
                  </div>
                </div>

                <div style={{ background: "#fff", borderRadius: 20, border: "1px solid #e5e7eb", padding: "24px 28px", marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", marginBottom: 14, letterSpacing: "0.02em" }}>Summary</div>
                  <div style={{ display: "grid", gap: 8, fontSize: 14, fontFamily: "'Nunito', sans-serif" }}>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Client:</span>
                      <span style={{ fontWeight: 700 }}>{inspData.clientName || [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Address:</span>
                      <span style={{ fontWeight: 600 }}>{[inspData.address || data.address, inspData.city || data.city, inspData.state || data.state].filter(Boolean).join(", ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Rep:</span>
                      <span style={{ fontWeight: 600 }}>{data.salesRepName || "—"}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Phone:</span>
                      <span style={{ fontWeight: 600 }}>{inspData.mobile || data.phone || "—"}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: "#6b7280", width: 100, flexShrink: 0 }}>Email:</span>
                      <span style={{ fontWeight: 600 }}>{inspData.email || data.signerEmail || "—"}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <button type="button" onClick={() => { setView("input"); setRepSearch(""); window.scrollTo({ top: 0 }); }}
                    style={{ padding: "14px", borderRadius: 14, border: "2px solid #0a0a0a", background: "#fff", color: "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                    ✚ New Client
                  </button>
                  <button type="button" onClick={() => { setView("input"); setRepSearch(""); window.scrollTo({ top: 0 }); }}
                    style={{ padding: "14px", borderRadius: 14, border: "none", background: "#0a0a0a", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
                    ← Back to Intake
                  </button>
                </div>
              </>
            ) : null}

            {/* ── INSPECTION ONLY (email link): Homeowner USS welcome ── */}
            {inspectionOnly && isSigningFromLink ? (
              <>
                <div style={{
                  background: "linear-gradient(135deg, #0a0a0a 0%, #0f1e3d 100%)",
                  borderRadius: 28, padding: "40px 36px", textAlign: "center",
                  marginBottom: 24, color: "#fff",
                }}>
                  <div style={{ fontSize: 56, marginBottom: 16 }}>🏠</div>
                  <div style={{ fontSize: 32, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 12 }}>
                    {activeTYHeadline}
                  </div>
                  <div style={{ fontSize: 17, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92, lineHeight: 1.6 }}>
                    {activeTYOpening}
                  </div>
                </div>
                <div style={{ background: "#fff", borderRadius: 24, border: "1px solid #e5e7eb", padding: "28px 28px 24px", marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#0a0a0a", fontFamily: "'Oswald', sans-serif", marginBottom: 16 }}>
                    📋 What Happens Next
                  </div>
                  <div style={{ display: "grid", gap: 12 }}>
                    {activeTYSteps.map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "12px 16px", background: "#eef1f8", borderRadius: 14, border: "1px solid #bfdbfe" }}>
                        <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#0a0a0a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>{i + 1}</div>
                        <div style={{ fontSize: 15, color: "#1e3a5f", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.5 }}>{step}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 20, padding: "18px 24px", textAlign: "center", marginBottom: 24 }}>
                  <div style={{ fontSize: 16, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 700, lineHeight: 1.6 }}>{activeTYClosing}</div>
                </div>
                <div style={{ background: "#0a0a0a", borderRadius: 20, padding: "20px 24px", color: "#fff", marginBottom: 24, textAlign: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, fontFamily: "'Oswald', sans-serif" }}>📞 Contact U.S. Shingle & Metal LLC</div>
                  <div style={{ fontSize: 14, fontFamily: "'Nunito', sans-serif", lineHeight: 1.8, opacity: 0.9 }}>
                    {ussContactPhone} &nbsp;|&nbsp; {ussContactEmail}
                  </div>
                </div>
              </>
            ) : null}

            {/* ── EMAIL LINK: Full homeowner welcome screen ── */}
            {isSigningFromLink && !inspectionOnly ? (
              <>
                <div style={{
                  background: "linear-gradient(135deg, #199c2e 0%, #15803d 100%)",
                  borderRadius: 28, padding: "40px 36px 36px", textAlign: "center",
                  marginBottom: 28, position: "relative", overflow: "hidden",
                }}>
                  <div style={{ position: "absolute", top: -30, right: -30, width: 140, height: 140, background: "rgba(255,255,255,0.06)", borderRadius: "50%" }} />
                  <div style={{ fontSize: 72, marginBottom: 16, lineHeight: 1 }}>🎉</div>
                  <div style={{ fontSize: 36, fontWeight: 700, color: "#fff", fontFamily: "'Oswald', sans-serif", lineHeight: 1.1, marginBottom: 16 }}>
                    {activeTYHeadline}
                  </div>
                  <div style={{ fontSize: 18, color: "rgba(255,255,255,0.92)", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.65, maxWidth: 480, margin: "0 auto" }}>
                    {activeTYOpening}
                  </div>
                </div>
                <div style={{ background: "#fff", borderRadius: 24, border: "1px solid #e5e7eb", padding: "28px 28px 24px", marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.03em", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 24 }}>📋</span> What Happens Next
                  </div>
                  <div style={{ display: "grid", gap: 14 }}>
                    {activeTYSteps.map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 16px", background: "#f0fdf4", borderRadius: 16, border: "1px solid #bbf7d0" }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, fontFamily: "'Oswald', sans-serif", flexShrink: 0 }}>{i + 1}</div>
                        <div style={{ fontSize: 16, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.55 }}>{step}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 20, padding: "20px 24px", textAlign: "center", marginBottom: 32 }}>
                  <div style={{ fontSize: 17, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 700, lineHeight: 1.6 }}>{activeTYClosing}</div>
                </div>
                <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 20, padding: "22px 26px", marginBottom: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                    <span style={{ fontSize: 36, flexShrink: 0 }}>📧</span>
                    <div>
                      <div style={{ fontSize: 19, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 6 }}>Check Your Email!</div>
                      <div style={{ fontSize: 15, color: "#374151", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.65 }}>
                        We sent your signed documents and a Welcome Package to <strong>{data.signerEmail}</strong>.
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <img src="/pa-header.png" alt="Healthy Homes Public Adjusting" style={{ maxWidth: 260, opacity: 0.85 }} />
                </div>
              </>
            ) : null}

          </div>
          </>
        ) : null}

        {/* ── INSPECTION FORM VIEW ── */}
        {view === "inspection" ? (
          <>
            <div>
              <Button variant="outline" onClick={() => setView("input")}>
                <ArrowLeft size={16} /> Back
              </Button>
            </div>

            {/* Hero banner */}
            <div style={{
              background: "linear-gradient(135deg, #0a0a0a 0%, #0f1e3d 100%)",
              borderRadius: 24,
              padding: "32px 28px",
              color: "#fff",
              position: "relative",
              overflow: "hidden",
            }}>
              <div style={{ position: "absolute", top: -30, right: -30, width: 160, height: 160, background: "rgba(200,57,43,0.15)", borderRadius: "50%" }} />
              <div style={{ position: "absolute", bottom: -20, left: 40, width: 100, height: 100, background: "rgba(200,57,43,0.1)", borderRadius: "50%" }} />
              <div style={{ fontSize: 36, marginBottom: 8 }}>🏠</div>
              <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>
                Free Roof Inspection Agreement
              </div>
              <div style={{ fontSize: 14, fontFamily: "'Nunito', sans-serif", fontWeight: 700, color: "#c9a35c", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                U.S. Shingle & Metal LLC
              </div>
              <div style={{ fontSize: 15, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.88 }}>
                Fill in the homeowner details and collect their signature below.
              </div>
            </div>

            {/* Form fields */}
            <Card>
              <CardContent>
                <div style={{ display: "grid", gap: 20 }}>
                  <SectionTitle>Client Information</SectionTitle>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                    <div>
                      <Label>Date</Label>
                      <input type="date" value={inspData.date} onChange={e => updateInsp("date", e.target.value)}
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>Client Full Name *</Label>
                      <input type="text" value={inspData.clientName} onChange={e => updateInsp("clientName", e.target.value)}
                        placeholder="Full name"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: inspSubmitAttempted && !inspData.clientName ? "2px solid #ef4444" : "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>Mobile</Label>
                      <input type="tel" value={inspData.mobile}
                        onChange={e => {
                          const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
                          let fmt = digits;
                          if (digits.length >= 7) fmt = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
                          else if (digits.length >= 4) fmt = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
                          else if (digits.length >= 1) fmt = `(${digits}`;
                          updateInsp("mobile", fmt);
                        }}
                        placeholder="(727) 000-0000"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <FormField
                      label="Email"
                      type="email"
                      value={inspData.email}
                      onChange={(v) => updateInsp("email", v)}
                      placeholder="client@email.com"
                      showError={inspSubmitAttempted}
                    />
                    <div>
                      <Label>Address *</Label>
                      <AddressAutocomplete
                        value={inspData.address}
                        onChange={(v) => updateInsp("address", v)}
                        onPlaceSelected={({ address, city, state, zip }) => {
                          updateInsp("address", address);
                          updateInsp("city", city);
                          updateInsp("state", normalizeStateValue(state));
                          updateInsp("zip", zip);
                        }}
                        placeholder="Start typing the property address..."
                        errorBorder={inspSubmitAttempted && !inspData.address}
                      />
                    </div>
                    <div>
                      <Label>City</Label>
                      <input type="text" value={inspData.city} onChange={e => updateInsp("city", e.target.value)}
                        placeholder="City"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <Label>State</Label>
                      <select value={normalizeStateValue(inspData.state)} onChange={e => updateInsp("state", e.target.value)}
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", background: "#fff" }}>
                        <option value="">— Select —</option>
                        {US_STATES.map(([code, name]) => (
                          <option key={code} value={code}>{code} — {name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label>Zip</Label>
                      <input type="text" value={inspData.zip} onChange={e => updateInsp("zip", e.target.value)}
                        placeholder="33782"
                        style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Signature section */}
            <div>
              {!effectiveInspSig ? (
                <div style={{
                  background: "linear-gradient(135deg, #0a0a0a 0%, #0f1e3d 100%)",
                  borderRadius: "24px 24px 0 0",
                  padding: "24px 28px 20px",
                  color: "#fff",
                }}>
                  <div style={{ fontSize: 28, marginBottom: 6 }}>✍️</div>
                  <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 6 }}>
                    Client Signature
                  </div>
                  <div style={{ fontSize: 15, fontFamily: "'Nunito', sans-serif", fontWeight: 600, opacity: 0.92 }}>
                    Use your finger, mouse, or type your name below.
                  </div>
                </div>
              ) : null}

              <Card style={{ borderRadius: effectiveInspSig ? 24 : "0 0 24px 24px", borderTop: effectiveInspSig ? undefined : "none" }}>
                <CardContent>
                  {/* Method selector */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
                    {[["draw", "👆", "Draw It"], ["type", "⌨️", "Type It"]].map(([m, emoji, label]) => (
                      <button key={m} type="button" onClick={() => setInspSigMethod(m)}
                        style={{
                          padding: "14px 12px", borderRadius: 16, textAlign: "center",
                          border: inspSigMethod === m ? "3px solid #0a0a0a" : "2px solid #e5e7eb",
                          background: inspSigMethod === m ? "#eef1f8" : "#fff", cursor: "pointer",
                        }}>
                        <div style={{ fontSize: 28, marginBottom: 6 }}>{emoji}</div>
                        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Nunito', sans-serif", color: "#111827" }}>{label}</div>
                        {inspSigMethod === m ? <div style={{ fontSize: 12, color: "#0a0a0a", fontWeight: 700, fontFamily: "'Nunito', sans-serif", marginTop: 4 }}>✓ Selected</div> : null}
                      </button>
                    ))}
                  </div>

                  {inspSigMethod === "draw" ? (
                    <SignaturePad title="" value={inspSig} onChange={setInspSig} required missing={inspSubmitAttempted && !effectiveInspSig} />
                  ) : (
                    <TypedSignatureField title="" value={inspTypedSig} onChange={setInspTypedSig}
                      fontValue={inspSigFont} onFontChange={setInspSigFont}
                      required missing={inspSubmitAttempted && !effectiveInspSig}
                      placeholder="Type full legal name" />
                  )}

                  {inspSubmitAttempted && !inspData.clientName ? (
                    <div style={{ color: "#ef4444", fontSize: 14, fontFamily: "'Nunito', sans-serif", fontWeight: 700, marginBottom: 12 }}>
                      ⚠️ Please enter the client name above
                    </div>
                  ) : null}
                  {inspSubmitAttempted && !inspData.address ? (
                    <div style={{ color: "#ef4444", fontSize: 14, fontFamily: "'Nunito', sans-serif", fontWeight: 700, marginBottom: 12 }}>
                      ⚠️ Please enter the property address above
                    </div>
                  ) : null}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const blob = await generatePDF("#inspection-printable", "Free-Roof-Inspection-Agreement.pdf");
                          const blobUrl = URL.createObjectURL(blob);
                          window.open(blobUrl, "_blank");
                          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                        } catch(err) {
                          alert(err?.message || "Failed to preview.");
                        }
                      }}
                      style={{
                        padding: "12px 16px", borderRadius: 14,
                        border: "2px solid #0a0a0a", background: "#fff",
                        color: "#0a0a0a", fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700, fontSize: 14, cursor: "pointer",
                        letterSpacing: "0.04em", textTransform: "uppercase",
                      }}
                    >
                      👁 Preview Document
                    </button>
                    <Button onClick={submitInspection} disabled={inspSubmitting}
                      style={{ background: "#0a0a0a", border: "1px solid #0a0a0a" }}>
                      <Mail size={16} /> {inspSubmitting ? "Submitting..." : "Submit & Email to Client"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Hidden printable PDF — moved to always-rendered section below */}
            <div style={{ display: "none" }}>
              <div id="inspection-printable-placeholder" style={{ fontFamily: "Arial, Helvetica, sans-serif", background: "#fff", width: "8.5in", padding: "0.6in 0.7in", boxSizing: "border-box" }}>
                {/* Header */}
                <div style={{ textAlign: "center", marginBottom: 24 }}>

                  <div style={{ fontSize: 20, fontWeight: 700, color: "#0a0a0a", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1.5 }}>
                    Free Roof Inspection Agreement
                  </div>
                  <div style={{ width: 60, height: 3, background: "#c9a35c", margin: "0 auto 10px", borderRadius: 2 }} />
                  <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.7 }}>
                    {INSPECTION_COMPANY.name} &nbsp;|&nbsp; {INSPECTION_COMPANY.address}<br />
                    Phone: {INSPECTION_COMPANY.phone} &nbsp;|&nbsp; Email: {INSPECTION_COMPANY.email} &nbsp;|&nbsp; License #: {INSPECTION_COMPANY.license}
                  </div>
                  <div style={{ borderBottom: "2px solid #0a0a0a", marginTop: 14 }} />
                </div>

                {/* Client info */}
                <div style={{ display: "grid", gap: 6, fontSize: 14, marginBottom: 20 }}>
                  <div><strong>Date:</strong> {inspData.date}</div>
                  <div><strong>Client:</strong> {inspData.clientName}</div>
                  <div><strong>Mobile:</strong> {inspData.mobile}</div>
                  <div><strong>Address:</strong> {inspData.address} &nbsp; <strong>City:</strong> {inspData.city} &nbsp; <strong>St:</strong> {inspData.state} &nbsp; <strong>Zip:</strong> {inspData.zip}</div>
                  <div><strong>Email:</strong> {inspData.email}</div>
                </div>

                {/* Agreement text */}
                <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 28, color: "#111827" }}>
                  <p style={{ margin: "0 0 10px" }}>
                    Client agrees to allow {INSPECTION_COMPANY.name} (Company) to perform a free roof inspection at the above address and to forward all pictures and findings to a Public Adjuster for review. The Company maintains all required licenses and insurance and will not perform repairs during the inspection.
                  </p>
                  <p style={{ margin: "0 0 10px" }}>
                    Client understands that they do not need to be present during the inspection; however, Company personnel will knock on the door upon arrival.
                  </p>
                  <p style={{ margin: "0 0 10px" }}>
                    If a Public Adjuster determines you in fact have storm related damage, they will contact you directly to go over your options. Client agrees to authorize the Public Adjuster they hired to communicate directly with the Company about any and all updates.
                  </p>
                  <p style={{ margin: 0 }}>
                    Client acknowledges that the Company is a licensed roofing contractor and cannot discuss policy coverages, insurance requirements, or statutory guidelines. Any such questions should be directed to the Public Adjuster or the Client's homeowner's insurance carrier.
                  </p>
                </div>

                {/* Signatures */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 20 }}>
                  <div>
                    <div style={{ marginBottom: 4, fontSize: 12 }}>Client:</div>
                    <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                      {effectiveInspSig ? (
                        <img src={effectiveInspSig} alt="Client signature" style={{ maxHeight: 44, objectFit: "contain" }} />
                      ) : null}
                    </div>
                    <div style={{ fontSize: 11, color: "#374151" }}>{inspData.clientName}</div>
                    <div style={{ fontSize: 12, marginTop: 8 }}>Date: {inspData.date}</div>
                  </div>
                  <div>
                    <div style={{ marginBottom: 4, fontSize: 12 }}>Representative:</div>
                    <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                      <img src={REP_FIXED.signatureImage} alt="Rep signature" style={{ maxHeight: 44, objectFit: "contain" }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#374151" }}>{REP_FIXED.name}</div>
                    <div style={{ fontSize: 12, marginTop: 8 }}>Date: {inspData.date}</div>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {/* ── MANAGER VIEW ── */}
        {view === "manager" ? (
          <Card>
            <CardHeader>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <CardTitle>Manager Settings</CardTitle>
                <button
                  type="button"
                  onClick={() => {
                    setManagerUnlocked(false);
                    setManagerPinEntry("");
                    setView("input");
                  }}
                  style={{
                    background: "transparent",
                    border: "1px solid #d1d5db",
                    borderRadius: 10,
                    padding: "6px 14px",
                    fontSize: 12,
                    fontFamily: "'Oswald', sans-serif",
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    color: "#6b7280",
                    cursor: "pointer",
                    textTransform: "uppercase",
                  }}
                >
                  ← Back
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {!managerUnlocked ? (
                <div style={{ maxWidth: 320 }}>
                  <Label>Enter Manager PIN</Label>
                  <input
                    type="password"
                    value={managerPinEntry}
                    onChange={(e) => setManagerPinEntry(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (managerPinEntry === managerPin) {
                          setManagerUnlocked(true);
                          setManagerPinEntry("");
                        } else {
                          alert("Incorrect PIN.");
                          setManagerPinEntry("");
                        }
                      }
                    }}
                    placeholder="Enter PIN and press Enter"
                    style={{
                      width: "100%",
                      height: 44,
                      borderRadius: 14,
                      border: "1px solid #d1d5db",
                      padding: "0 12px",
                      fontSize: 14,
                      boxSizing: "border-box",
                      marginBottom: 12,
                    }}
                  />
                  <Button
                    onClick={() => {
                      if (managerPinEntry === managerPin) {
                        setManagerUnlocked(true);
                        setManagerPinEntry("");
                      } else {
                        alert("Incorrect PIN.");
                        setManagerPinEntry("");
                      }
                    }}
                  >
                    Unlock
                  </Button>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 10 }}>
                    Default PIN: 1234 — change it below once unlocked.
                  </div>
                </div>
              ) : (
                <div>
                  {managerSection === "home" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 8 }}>
                      {[
                        { key: "security", emoji: "⚙️", label: "Security & Notifications", desc: "PIN, activity email" },
                        { key: "pamgmt", emoji: "📋", label: "PA Management", desc: "PA workflow on/off, PA-related settings" },
                        { key: "sms", emoji: "💬", label: "SMS Templates", desc: "Auto-messages for each inspection result" },
                        { key: "review", emoji: "📝", label: "Review Page Text", desc: "Headlines, document descriptions" },
                        { key: "thankyou", emoji: "🎉", label: "Thank You Pages", desc: "Post-inspection, pre-inspection, USS" },
                        { key: "reps", emoji: "👥", label: "Sales Rep Manager", desc: "Add, import, activate reps" },
                        { key: "lookup", emoji: "🔍", label: "Record Lookup & Results", desc: "Find inspections, record damage/no damage" },
                        { key: "report", emoji: "📊", label: "Weekly Report", desc: "View signings by rep and date range" },
                        { key: "analytics", emoji: "📈", label: "Submission Analytics", desc: "Totals, category % and avg days per rep" },
                        { key: "browseall", emoji: "📚", label: "Browse All Records", desc: "Step through every record one-by-one to verify accuracy" },
                        { key: "dupes", emoji: "👯", label: "Find Duplicates", desc: "Address-based deduper — pick which to keep, delete the rest" },
                        { key: "jnreport", emoji: "📄", label: "JN Inspection Report", desc: "Generate insp report PDF with photos and upload to JN" },
                        { key: "bulkreport", emoji: "📦", label: "Bulk Inspection Reports", desc: "Run insp reports across every JN job with a chosen status" },
                        { key: "inspectors", emoji: "🔍", label: "Inspectors", desc: "Roster — sync from JN, edit, activate/deactivate" },
                        { key: "assign_inspections", emoji: "📋", label: "Assign Inspections", desc: "Hand out pending jobs, take them away, release" },
                        { key: "inspector_routes", emoji: "🗺", label: "Inspector Routes", desc: "Optimize the day's route from home or current location" },
                        { key: "inspector_reports", emoji: "📊", label: "Inspector Reports", desc: "Completed this week by status + per-inspector + by day" },
                        { key: "pa_handoff", emoji: "📤", label: "PA Handoff", desc: "Send damage results to the PA (homeowner info + photos + signed PDF). Test the link or retry sends." },
                      ].map(item => (
                        <button key={item.key} type="button" onClick={() => setManagerSection(item.key)}
                          style={{ padding: "24px 20px", borderRadius: 20, border: "2px solid #e5e7eb", background: "#fff", textAlign: "left", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                          <div style={{ fontSize: 36, marginBottom: 10 }}>{item.emoji}</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>{item.label}</div>
                          <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif", lineHeight: 1.4 }}>{item.desc}</div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div>
                      <button type="button" onClick={() => setManagerSection("home")}
                        style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24, padding: "8px 16px", borderRadius: 12, border: "1.5px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", textTransform: "uppercase" }}>
                        ← Back to Manager Home
                      </button>
                  {managerSection === "security" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Security & Notifications</SectionTitle>
                    <div style={{ display: "grid", gap: 16 }}>
                      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div style={{ maxWidth: 300, flex: 1 }}>
                          <Label>Change Manager PIN</Label>
                          <input
                            type="password"
                            value={managerPin}
                            onChange={(e) => setManagerPin(e.target.value)}
                            placeholder="New PIN"
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }}
                          />
                        </div>
                        <div>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm("Reset all text to factory defaults?")) {
                                setReviewHeadline(DEFAULTS.reviewHeadline);
                                setReviewLorText(DEFAULTS.reviewLorText);
                                setReviewPacText(DEFAULTS.reviewPacText);
                                setReviewHelpText(DEFAULTS.reviewHelpText);
                                setThankYouHeadline(DEFAULTS.thankYouHeadline);
                                setThankYouOpening(DEFAULTS.thankYouOpening);
                                try { setThankYouSteps(JSON.parse(DEFAULTS.thankYouSteps)); } catch {}
                                setThankYouClosing(DEFAULTS.thankYouClosing);
                                setPreInspHeadline(DEFAULTS.preInspHeadline);
                                setPreInspOpening(DEFAULTS.preInspOpening);
                                try { setPreInspSteps(JSON.parse(DEFAULTS.preInspSteps)); } catch {}
                                setPreInspClosing(DEFAULTS.preInspClosing);
                              }
                            }}
                            style={{ padding: "10px 18px", borderRadius: 12, border: "1px solid #fca5a5", background: "#fff", color: "#dc2626", fontFamily: "'Oswald', sans-serif", fontWeight: 600, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer", height: 44 }}
                          >
                            ↺ Reset All Text to Defaults
                          </button>
                        </div>
                      </div>
                      <div>
                        <Label>Activity Notification Email</Label>
                        <input
                          type="email"
                          value={activityEmail}
                          onChange={(e) => setActivityEmail(e.target.value)}
                          placeholder="e.g. manager@company.com"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }}
                        />
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          Every signing (PA docs or inspection) will CC this address with a summary. Leave blank to disable.
                        </div>
                        <div style={{ marginTop: 16 }}>
                        <Label>No-Damage SMS — Retail Sales Manager Phone</Label>
                        <input type="tel" value={noDamageManagerPhone} onChange={(e) => setNoDamageManagerPhone(e.target.value)}
                          placeholder="4437973758"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          This number gets an SMS when an inspection comes back with no damage. Currently: {noDamageManagerPhone || "not set"}
                        </div>
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <Label>No-Damage SMS — Message Template</Label>
                        <textarea value={noDamageManagerSms} onChange={(e) => setNoDamageManagerSms(e.target.value)} rows={3}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, fontFamily: "'Nunito', sans-serif" }}>
                          Available placeholders: {"{address}"} {"{client}"} {"{rep}"} {"{city}"}
                        </div>
                      </div>
                      </div>
                    </div>
                  </Card>}

                  {/* ── PA Management section ──
                      One place for everything PA-related. Currently:
                        - PA Workflow on/off toggle (hides Claim Admin,
                          LOR, PA Authorization across the app)
                        - PA notification email default
                      Designed to grow as more PA-specific settings show
                      up (e.g. PA signature image swap, PA branding, etc.). */}
                  {managerSection === "pamgmt" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>PA Management</SectionTitle>
                    <div style={{ display: "grid", gap: 20 }}>
                      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                          <input
                            type="checkbox"
                            id="paWorkflowEnabled"
                            checked={!PA_FORMS_DISABLED}
                            onChange={(e) => {
                              const next = e.target.checked
                              try { localStorage.setItem("ccg_mgr_paWorkflowEnabled", next ? "true" : "false") } catch {}
                              const onMsg = next
                                ? "PA workflow ENABLED. Claim Admin section, PA Email field, and LoR + PA Authorization docs are back. The page will reload to apply."
                                : "PA workflow DISABLED. Claim Admin section, PA Email field, and LoR + PA Authorization docs are hidden. The page will reload to apply."
                              alert(onMsg)
                              window.location.reload()
                            }}
                            style={{ marginTop: 4, width: 18, height: 18, cursor: "pointer" }}
                          />
                          <div style={{ flex: 1 }}>
                            <label htmlFor="paWorkflowEnabled" style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, color: "#111827", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                              PA Workflow {!PA_FORMS_DISABLED ? "(currently ON)" : "(currently OFF)"}
                            </label>
                            <div style={{ fontSize: 13, color: "#374151", marginTop: 4, fontFamily: "'Nunito', sans-serif", lineHeight: 1.5 }}>
                              When <strong>ON</strong>: reps can sign the LoR + PA Authorization, the Claim Admin section (Insurance Co, Policy #, Claim #, Loss Location) appears on the intake form, and the PA Email field is shown in Office Info.
                              <br />
                              When <strong>OFF</strong>: all of those are hidden — useful when the PA is handling their own paperwork outside this system. Toggle back ON if you switch PAs later. Nothing is deleted, just hidden.
                            </div>
                            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6, fontFamily: "'Nunito', sans-serif", fontStyle: "italic" }}>
                              Saving auto-reloads the page so every PA-related UI updates cleanly. Already-signed PA docs are unaffected.
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Card>}

                  {managerSection === "sms" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>SMS Templates</SectionTitle>
                    <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#1e40af", fontFamily: "'Nunito', sans-serif", lineHeight: 1.6 }}>
                      These messages are sent automatically after each inspection result. They override all other SMS rules.<br/>
                      Available placeholders: <code>{"{client}"}</code> <code>{"{address}"}</code> <code>{"{city}"}</code> <code>{"{rep}"}</code> <code>{"{repPhone}"}</code>
                    </div>
                    {!smsTemplatesLoaded ? (
                      <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontFamily: "'Nunito', sans-serif" }}>Loading templates...</div>
                    ) : (
                      <div style={{ display: "grid", gap: 16 }}>
                        {[
                          { key: "damage",   label: "Damage Found",         emoji: "🚨", bg: "#fef2f2", border: "#fca5a5", titleColor: "#991b1b" },
                          { key: "nodamage", label: "No Damage",            emoji: "✅", bg: "#f0fdf4", border: "#bbf7d0", titleColor: "#166534" },
                          { key: "retail",   label: "Retail (Wear & Tear)", emoji: "🏠", bg: "#fffbeb", border: "#fde68a", titleColor: "#92400e" },
                        ].map(group => (
                          <div key={group.key} style={{ background: group.bg, border: `2px solid ${group.border}`, borderRadius: 14, padding: "16px 18px" }}>
                            <div style={{ fontSize: 16, fontWeight: 700, color: group.titleColor, fontFamily: "'Oswald', sans-serif", marginBottom: 14, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                              {group.emoji} {group.label}
                            </div>
                            {[
                              { variant: "insp", label: "Inspection only signed (PA paperwork NOT signed upfront)" },
                              { variant: "all",  label: "Inspection + PA paperwork all signed upfront" },
                            ].map(v => (
                              <div key={v.variant} style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", fontFamily: "'Nunito', sans-serif", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                                  {v.label}
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                                  {[
                                    { to: "rep",       toLabel: "To Sales Rep" },
                                    { to: "homeowner", toLabel: "To Homeowner" },
                                  ].map(r => {
                                    const tKey = `${group.key}_${v.variant}_${r.to}`;
                                    return (
                                      <div key={r.to}>
                                        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginBottom: 4 }}>{r.toLabel}</div>
                                        <textarea
                                          value={smsTemplates[tKey] || ""}
                                          onChange={(e) => saveSmsTemplate(tKey, e.target.value)}
                                          rows={3}
                                          placeholder={`Enter SMS to ${r.to} for ${group.label} — ${v.variant === "insp" ? "insp only" : "all signed"}`}
                                          style={{ width: "100%", borderRadius: 10, border: "1px solid #d1d5db", padding: "8px 10px", fontSize: 13, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", background: "#fff" }}
                                        />
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>}

                  {managerSection === "review" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Review Page Text</SectionTitle>
                    <div style={{ display: "grid", gap: 16 }}>
                      <div>
                        <Label>Headline (shown above the document cards)</Label>
                        <textarea
                          value={reviewHeadline}
                          onChange={(e) => setReviewHeadline(e.target.value)}
                          rows={2}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                      <div>
                        <Label>Letter of Representation description</Label>
                        <textarea
                          value={reviewLorText}
                          onChange={(e) => setReviewLorText(e.target.value)}
                          rows={3}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                      <div>
                        <Label>PA Authorization description</Label>
                        <textarea
                          value={reviewPacText}
                          onChange={(e) => setReviewPacText(e.target.value)}
                          rows={3}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                      <div>
                        <Label>Help text (shown below the document cards)</Label>
                        <textarea
                          value={reviewHelpText}
                          onChange={(e) => setReviewHelpText(e.target.value)}
                          rows={2}
                          style={{
                            width: "100%",
                            borderRadius: 12,
                            border: "1px solid #d1d5db",
                            padding: "10px 12px",
                            fontSize: 14,
                            boxSizing: "border-box",
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                        />
                      </div>
                    </div>
                  </Card>}
                  {managerSection === "thankyou" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Thank You Pages</SectionTitle>
                    <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                      {[
                        { key: "post_inspection", label: "✅ Roof Inspected Flow" },
                        { key: "pre_inspection",  label: "🏠 Pre-Inspection Flow" },
                        { key: "insp_only",       label: "🔧 Inspection Only (USS)" },
                      ].map(tab => (
                        <button
                          key={tab.key}
                          type="button"
                          onClick={() => setManagerTYTab(tab.key)}
                          style={{
                            padding: "8px 16px",
                            borderRadius: 12,
                            border: managerTYTab === tab.key ? "2px solid #0a0a0a" : "1px solid #d1d5db",
                            background: managerTYTab === tab.key ? "#eef1f8" : "#fff",
                            color: managerTYTab === tab.key ? "#0a0a0a" : "#374151",
                            fontFamily: "'Nunito', sans-serif",
                            fontWeight: 700,
                            fontSize: 13,
                            cursor: "pointer",
                          }}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    {managerTYTab === "post_inspection" && (

                    <>
                    <div style={{ display: "grid", gap: 20 }}>

                      {/* Headline */}
                      <div>
                        <Label>Headline</Label>
                        <input
                          type="text"
                          value={thankYouHeadline}
                          onChange={(e) => setThankYouHeadline(e.target.value)}
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }}
                        />
                      </div>

                      {/* Opening statement */}
                      <div>
                        <Label>Opening statement (shown in the green hero banner)</Label>
                        <textarea
                          value={thankYouOpening}
                          onChange={(e) => setThankYouOpening(e.target.value)}
                          rows={3}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
                        />
                      </div>

                      {/* Steps */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <Label>What to expect next (numbered steps)</Label>
                          <button
                            type="button"
                            onClick={() => setThankYouSteps([...thankYouSteps, "✅ New step — click to edit"])}
                            style={{
                              padding: "6px 14px",
                              borderRadius: 10,
                              border: "1.5px solid #199c2e",
                              background: "#fff",
                              color: "#199c2e",
                              fontFamily: "'Oswald', sans-serif",
                              fontWeight: 600,
                              fontSize: 13,
                              cursor: "pointer",
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                            }}
                          >
                            + Add Step
                          </button>
                        </div>
                        <div style={{ display: "grid", gap: 10 }}>
                          {thankYouSteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                              <div style={{
                                width: 28, height: 28, borderRadius: "50%", background: "#199c2e",
                                color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                                fontWeight: 700, fontSize: 13, fontFamily: "'Oswald', sans-serif",
                                flexShrink: 0, marginTop: 8,
                              }}>
                                {i + 1}
                              </div>
                              <textarea
                                value={step}
                                onChange={(e) => {
                                  const next = [...thankYouSteps];
                                  next[i] = e.target.value;
                                  setThankYouSteps(next);
                                }}
                                rows={2}
                                style={{
                                  flex: 1,
                                  borderRadius: 12,
                                  border: "1px solid #d1d5db",
                                  padding: "8px 12px",
                                  fontSize: 14,
                                  boxSizing: "border-box",
                                  resize: "vertical",
                                  fontFamily: "inherit",
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => setThankYouSteps(thankYouSteps.filter((_, idx) => idx !== i))}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: "#ef4444",
                                  fontSize: 18,
                                  cursor: "pointer",
                                  padding: "4px 6px",
                                  marginTop: 6,
                                  flexShrink: 0,
                                }}
                                title="Remove step"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Closing statement */}
                      <div>
                        <Label>Closing statement (shown in amber box at bottom)</Label>
                        <textarea
                          value={thankYouClosing}
                          onChange={(e) => setThankYouClosing(e.target.value)}
                          rows={2}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: 24, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                      <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Live Preview</div>
                      <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 16, padding: "20px 18px" }}>
                        <div style={{ fontSize: 28, marginBottom: 8, textAlign: "center" }}>🎉</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#15803d", fontFamily: "'Oswald', sans-serif", marginBottom: 6, textAlign: "center" }}>{thankYouHeadline}</div>
                        <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>{thankYouOpening}</div>
                        {thankYouSteps.map((step, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8, padding: "8px 12px", background: "#fff", borderRadius: 10, border: "1px solid #bbf7d0" }}>
                            <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                            <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.4 }}>{step}</div>
                          </div>
                        ))}
                        <div style={{ marginTop: 10, padding: "10px 14px", background: "#fffbeb", borderRadius: 10, textAlign: "center", fontSize: 13, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{thankYouClosing}</div>
                      </div>
                    </div>
                    </>
                    )}
                    {managerTYTab === "pre_inspection" && (
                    <div style={{ display: "grid", gap: 20 }}>
                      <div>
                        <Label>Headline</Label>
                        <input type="text" value={preInspHeadline} onChange={(e) => setPreInspHeadline(e.target.value)}
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <Label>Opening statement (shown in the green hero banner)</Label>
                        <textarea value={preInspOpening} onChange={(e) => setPreInspOpening(e.target.value)} rows={3}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                      </div>
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <Label>What to expect next (numbered steps)</Label>
                          <button type="button" onClick={() => setPreInspSteps([...preInspSteps, "✅ New step — click to edit"])}
                            style={{ padding: "6px 14px", borderRadius: 10, border: "1.5px solid #199c2e", background: "#fff", color: "#199c2e", fontFamily: "'Oswald', sans-serif", fontWeight: 600, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                            + Add Step
                          </button>
                        </div>
                        <div style={{ display: "grid", gap: 10 }}>
                          {preInspSteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, fontFamily: "'Oswald', sans-serif", flexShrink: 0, marginTop: 8 }}>{i + 1}</div>
                              <textarea value={step} onChange={(e) => { const n=[...preInspSteps]; n[i]=e.target.value; setPreInspSteps(n); }} rows={2}
                                style={{ flex: 1, borderRadius: 12, border: "1px solid #d1d5db", padding: "8px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                              <button type="button" onClick={() => setPreInspSteps(preInspSteps.filter((_,idx)=>idx!==i))}
                                style={{ background: "transparent", border: "none", color: "#ef4444", fontSize: 18, cursor: "pointer", padding: "4px 6px", marginTop: 6, flexShrink: 0 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label>Closing statement</Label>
                        <textarea value={preInspClosing} onChange={(e) => setPreInspClosing(e.target.value)} rows={2}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                      </div>
                      <div style={{ marginTop: 4, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                        <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Live Preview</div>
                        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 16, padding: "20px 18px" }}>
                          <div style={{ fontSize: 28, marginBottom: 8, textAlign: "center" }}>🎉</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#15803d", fontFamily: "'Oswald', sans-serif", marginBottom: 6, textAlign: "center" }}>{preInspHeadline}</div>
                          <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>{preInspOpening}</div>
                          {preInspSteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8, padding: "8px 12px", background: "#fff", borderRadius: 10, border: "1px solid #bbf7d0" }}>
                              <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#199c2e", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                              <div style={{ fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.4 }}>{step}</div>
                            </div>
                          ))}
                          <div style={{ marginTop: 10, padding: "10px 14px", background: "#fffbeb", borderRadius: 10, textAlign: "center", fontSize: 13, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{preInspClosing}</div>
                        </div>
                      </div>
                    </div>
                    )}
                    {managerTYTab === "insp_only" && (
                    <div style={{ display: "grid", gap: 20 }}>
                      <div style={{ background: "#eef1f8", border: "1px solid #bfdbfe", borderRadius: 12, padding: "12px 16px", fontSize: 13, color: "#1e3a5f", fontFamily: "'Nunito', sans-serif" }}>
                        This content appears on the <strong>thank you screen</strong> shown after an inspection-only signing, and in the <strong>USS Welcome Package PDF</strong> emailed to the homeowner.
                      </div>
                      <div>
                        <Label>Headline</Label>
                        <input type="text" value={inspOnlyHeadline} onChange={(e) => setInspOnlyHeadline(e.target.value)}
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <Label>Opening statement</Label>
                        <textarea value={inspOnlyOpening} onChange={(e) => setInspOnlyOpening(e.target.value)} rows={3}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                      </div>
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <Label>What to expect next (numbered steps)</Label>
                          <button type="button" onClick={() => setInspOnlySteps([...inspOnlySteps, "New step — click to edit"])}
                            style={{ padding: "6px 14px", borderRadius: 10, border: "1.5px solid #0a0a0a", background: "#fff", color: "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 600, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                            + Add Step
                          </button>
                        </div>
                        <div style={{ display: "grid", gap: 10 }}>
                          {inspOnlySteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#0a0a0a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, fontFamily: "'Oswald', sans-serif", flexShrink: 0, marginTop: 8 }}>{i + 1}</div>
                              <textarea value={step} onChange={(e) => { const n=[...inspOnlySteps]; n[i]=e.target.value; setInspOnlySteps(n); }} rows={2}
                                style={{ flex: 1, borderRadius: 12, border: "1px solid #d1d5db", padding: "8px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                              <button type="button" onClick={() => setInspOnlySteps(inspOnlySteps.filter((_,idx)=>idx!==i))}
                                style={{ background: "transparent", border: "none", color: "#ef4444", fontSize: 18, cursor: "pointer", padding: "4px 6px", marginTop: 6, flexShrink: 0 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label>Closing statement</Label>
                        <textarea value={inspOnlyClosing} onChange={(e) => setInspOnlyClosing(e.target.value)} rows={2}
                          style={{ width: "100%", borderRadius: 12, border: "1px solid #d1d5db", padding: "10px 12px", fontSize: 14, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
                      </div>
                      <div style={{ marginTop: 4, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                        <div style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Live Preview</div>
                        <div style={{ background: "#eef1f8", border: "1px solid #bfdbfe", borderRadius: 16, padding: "20px 18px" }}>
                          <div style={{ fontSize: 28, marginBottom: 8, textAlign: "center" }}>🏠</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#0a0a0a", fontFamily: "'Oswald', sans-serif", marginBottom: 6, textAlign: "center" }}>{inspOnlyHeadline}</div>
                          <div style={{ fontSize: 13, color: "#1e3a5f", fontFamily: "'Nunito', sans-serif", marginBottom: 14, textAlign: "center", lineHeight: 1.5 }}>{inspOnlyOpening}</div>
                          {inspOnlySteps.map((step, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8, padding: "8px 12px", background: "#fff", borderRadius: 10, border: "1px solid #bfdbfe" }}>
                              <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#0a0a0a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                              <div style={{ fontSize: 13, color: "#1e3a5f", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.4 }}>{step}</div>
                            </div>
                          ))}
                          <div style={{ marginTop: 10, padding: "10px 14px", background: "#fffbeb", borderRadius: 10, textAlign: "center", fontSize: 13, color: "#92400e", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{inspOnlyClosing}</div>
                        </div>
                      </div>
                    </div>
                    )}
                  </Card>}
                  {managerSection === "reps" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Sales Rep Manager</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginBottom: 16 }}>
                      Reps are pulled live from Job Nimbus on every page load and synced to Supabase as a backup.
                    </div>

                    {/* JN Live Sync status */}
                    <div style={{ background: reps[0]?._fromJN ? "#f0fdf4" : "#fffbeb", border: `1px solid ${reps[0]?._fromJN ? "#86efac" : "#fde68a"}`, borderRadius: 14, padding: "14px 18px", marginBottom: 16 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: reps[0]?._fromJN ? "#166534" : "#92400e", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>
                        {reps[0]?._fromJN ? "✅ Live from Job Nimbus" : "⚠️ Using Supabase fallback"}
                      </div>
                      <div style={{ fontSize: 12, color: "#374151", fontFamily: "'Nunito', sans-serif", marginBottom: 10 }}>
                        {reps[0]?._fromJN
                          ? `${reps.length} active reps loaded from JN. New reps added to JN will appear automatically on the next page load.`
                          : "Could not reach JN API. Using manually managed reps from Supabase. Check your API key."}
                      </div>
                      <button type="button" onClick={loadReps} disabled={jnImporting}
                        style={{ padding: "8px 18px", borderRadius: 10, border: "none", background: "#0a0a0a", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                        {jnImporting ? "Syncing…" : "🔄 Sync from JN Now"}
                      </button>
                      {jnImportError ? <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626", fontFamily: "'Nunito', sans-serif" }}>{jnImportError}</div> : null}
                    </div>

                    <div style={{ background: "#eef1f8", border: "1px solid #bfdbfe", borderRadius: 14, padding: "14px 18px", marginBottom: 16 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#1e40af", fontFamily: "'Oswald', sans-serif", marginBottom: 6 }}>Fallback: Import Known Reps</div>
                      <div style={{ fontSize: 13, color: "#374151", fontFamily: "'Nunito', sans-serif", marginBottom: 10 }}>Use only if JN API is unavailable. Imports 24 known reps with their JN IDs into Supabase.</div>
                      <button type="button" onClick={seedRepsFromList} disabled={repSaving}
                        style={{ padding: "8px 18px", borderRadius: 10, border: "none", background: "#1e40af", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                        {repSaving ? "Importing..." : "⬇️ Import All 24 Reps"}
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, marginBottom: 16, alignItems: "flex-end" }}>
                      <div>
                        <Label>Rep Name</Label>
                        <input type="text" value={newRepName} onChange={e => setNewRepName(e.target.value)} placeholder="Full name"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <Label>Email (optional)</Label>
                        <input type="email" value={newRepEmail} onChange={e => setNewRepEmail(e.target.value)} placeholder="rep@email.com"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <Label>Cell Phone (for SMS)</Label>
                        <input type="tel" value={newRepPhone} onChange={e => setNewRepPhone(e.target.value)} placeholder="(727) 555-0000"
                          style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                      </div>
                      <button type="button" onClick={saveRep} disabled={repSaving || !newRepName.trim()}
                        style={{ height: 44, padding: "0 18px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                        + Add Rep
                      </button>
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", fontFamily: "'Nunito', sans-serif" }}>
                          {reps.filter(r => r.active !== false).length} active rep{reps.filter(r => r.active !== false).length !== 1 ? "s" : ""}
                        </div>
                        <button type="button" onClick={() => setShowInactiveReps(v => !v)}
                          style={{ fontSize: 12, color: "#6b7280", background: "none", border: "none", cursor: "pointer", fontFamily: "'Nunito', sans-serif", textDecoration: "underline" }}>
                          {showInactiveReps ? "Hide inactive" : `Show inactive (${reps.filter(r => r.active === false).length})`}
                        </button>
                      </div>
                      {reps.filter(r => showInactiveReps || r.active !== false).map(rep => (
                        <div key={rep.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 12, background: rep.active === false ? "#f9fafb" : "#fff", border: "1px solid #e5e7eb", gap: 10, opacity: rep.active === false ? 0.6 : 1 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontFamily: "'Nunito', sans-serif" }}>
                              {rep.name}
                              {rep.active === false ? <span style={{ fontSize: 10, background: "#fee2e2", color: "#991b1b", borderRadius: 6, padding: "2px 6px", fontFamily: "'Nunito', sans-serif", fontWeight: 700, marginLeft: 8 }}>INACTIVE</span> : null}
                            </div>
                            {rep.phone ? <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>📞 {rep.phone}</div> : null}
                            {rep.jobnimbus_id ? <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>JN: {rep.jobnimbus_id}</div> : null}
                            {rep.short_code ? (
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12, fontWeight: 700, background: "#0a0a0a", color: "#fff", borderRadius: 6, padding: "2px 8px", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.06em" }}>
                                  Code: {rep.short_code}
                                </span>
                                <a
                                  href={`https://scan.inspectionforyou.com/?rep=${rep.jobnimbus_id}&name=${encodeURIComponent(rep.name)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ fontSize: 11, color: "#2563eb", fontFamily: "'Nunito', sans-serif", textDecoration: "underline" }}
                                >
                                  🔗 QR Link
                                </a>
                              </div>
                            ) : (
                              <button type="button" onClick={async () => {
                                // Generate a unique 4-digit code
                                const existing = reps.map(r => r.short_code).filter(Boolean);
                                let code;
                                do { code = String(Math.floor(1000 + Math.random() * 9000)); }
                                while (existing.includes(code));
                                await supabase.from("sales_reps").update({ short_code: code }).eq("id", rep.id);
                                await loadReps();
                              }} style={{ marginTop: 4, fontSize: 11, color: "#2563eb", background: "none", border: "none", cursor: "pointer", fontFamily: "'Nunito', sans-serif", textDecoration: "underline", padding: 0 }}>
                                + Generate Code
                              </button>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input
                            type="tel"
                            defaultValue={rep.phone || ""}
                            placeholder="Cell phone"
                            id={`phone-${rep.id}`}
                            style={{ height: 32, borderRadius: 8, border: "1px solid #d1d5db", padding: "0 8px", fontSize: 11, width: 120, fontFamily: "'Nunito', sans-serif" }}
                          />
                          <button type="button" onClick={async (e) => {
                            const input = document.getElementById(`phone-${rep.id}`);
                            const phone = input?.value?.trim() || "";
                            const btn = e.currentTarget;
                            btn.textContent = "...";
                            btn.disabled = true;
                            // Try update by jobnimbus_id first, then by id. Use .select()
                            // so we can actually see whether any rows were affected —
                            // without it, RLS-blocked writes silently report success.
                            let result;
                            if (rep.jobnimbus_id) {
                              result = await supabase.from("sales_reps").update({ phone }).eq("jobnimbus_id", rep.jobnimbus_id).select();
                            }
                            if (!rep.jobnimbus_id || result?.error || !result?.data || result.data.length === 0) {
                              result = await supabase.from("sales_reps").update({ phone }).eq("id", rep.id).select();
                            }
                            if (result?.error) {
                              btn.textContent = "❌";
                              console.error("Phone save error:", result.error);
                              alert(`Could not save phone: ${result.error.message}`);
                            } else if (!result?.data || result.data.length === 0) {
                              // HTTP 200 but 0 rows updated — usually means RLS blocked the write
                              btn.textContent = "❌";
                              console.warn("Phone save: 0 rows affected (likely RLS blocking writes on sales_reps)");
                              alert("Save appeared successful but wrote 0 rows. This usually means Row-Level Security is blocking writes on sales_reps.\n\nFix in Supabase SQL Editor:\nALTER TABLE sales_reps DISABLE ROW LEVEL SECURITY;");
                            } else {
                              btn.textContent = "✓";
                              btn.style.background = "#199c2e";
                              btn.style.color = "#fff";
                              setTimeout(() => { btn.textContent = "Save"; btn.style.background = ""; btn.style.color = ""; btn.disabled = false; }, 2000);
                            }
                            await loadReps();
                          }}
                            style={{ height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 11, cursor: "pointer", fontFamily: "'Nunito', sans-serif", fontWeight: 700, whiteSpace: "nowrap" }}>
                            Save
                          </button>
                          </div>
                          <button type="button" onClick={() => toggleRepActive(rep.id, rep.active !== false)}
                            style={{ padding: "4px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 11, cursor: "pointer", fontFamily: "'Nunito', sans-serif", fontWeight: 700 }}>
                            {rep.active === false ? "Activate" : "Deactivate"}
                          </button>
                        </div>
                      ))}
                      {reps.length === 0 ? (
                        <div style={{ fontSize: 13, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", padding: "12px 0" }}>No reps yet — import or add one above.</div>
                      ) : null}
                    </div>
                  </Card>}
                  {managerSection === "lookup" && <Card style={{ padding: 20, background: "#f8fafc" }}>

                    <SectionTitle>Record Lookup & Inspection Results</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginBottom: 16 }}>
                      Search for an inspection record by name, address, or ZIP — then record the result.
                    </div>
                    <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
  <button
    type="button"
    onClick={async () => {
      setListMode("pending");
      setResultFilter("all");
      setCheckNowSummary(null);
      setRecordSearchLoading(true);
      setRecordSearch("");
      try {
        // Pull all candidates for the Pending list. We filter for null result
        // and null cancelled_at, but ALSO need to check that no SIBLING row
        // (same name+zip) elsewhere already has a result — otherwise duplicate
        // inspection records cause the same homeowner to show up as Pending
        // even after one of their rows was resolved.
        const { data: results, error } = await supabase
          .from("inspections")
          .select("id, client_name, address, city, state, zip, mobile, email, sales_rep_name, sales_rep_id, signed_at, result, result_at, last_notified_rep_at, last_notified_homeowner_at, last_notified_pa_at, docs_signed, jn_job_id, cancelled_at, signed_pdfs, pa_status, pa_status_updated_at, jn_status")
          .is("result", null)
          .is("cancelled_at", null)
          .or("jn_status.is.null,jn_status.eq.Needs Inspection,jn_status.eq.New Lead,jn_status.eq.");
        if (!error) {
          // Find homeowner+zip combos that have ANY sibling row already resolved
          // (result set OR cancelled). If so, exclude from Pending.
          const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
          const normKey = (n, zip, addr) => {
            const z = (zip || "").trim();
            if (z) return `${normName(n)}|zip:${z}`;
            const street = (addr || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
            return `${normName(n)}|st:${street}`;
          };

          // Look up sibling rows for these candidates that ARE resolved.
          // If a candidate's name+zip key is in the resolvedKeys set, we drop it.
          const candidateZips = [...new Set((results || []).map(r => (r.zip || "").trim()).filter(Boolean))];
          const resolvedKeys = new Set();
          if (candidateZips.length > 0) {
            const { data: resolvedSiblings } = await supabase
              .from("inspections")
              .select("client_name, zip, address")
              .in("zip", candidateZips)
              .or("result.not.is.null,cancelled_at.not.is.null");
            for (const sib of resolvedSiblings || []) {
              resolvedKeys.add(normKey(sib.client_name, sib.zip, sib.address));
            }
          }

          // Drop any candidate whose name+zip already has a resolved sibling
          const filteredResults = (results || []).filter(r => !resolvedKeys.has(normKey(r.client_name, r.zip, r.address)));
          const bestByKey = new Map();
          for (const r of filteredResults) {
            const k = normKey(r.client_name, r.zip, r.address);
            const existing = bestByKey.get(k);
            if (!existing) { bestByKey.set(k, r); continue; }
            const tNew = r.signed_at ? new Date(r.signed_at).getTime() : 0;
            const tOld = existing.signed_at ? new Date(existing.signed_at).getTime() : 0;
            if (tNew > tOld) bestByKey.set(k, r);
          }
          const deduped = [...bestByKey.values()];

          // Enrich with docs_signed (pending list only: lookup all claims that
          // match these zip+street combos so we can show doc badges).
          // Multi-key matching catches address-spelling differences between
          // inspections and claims tables.
          const zips = [...new Set(deduped.map(r => (r.zip || "").trim()).filter(Boolean))];
          const claimsByZipStreet = new Map();
          if (zips.length > 0) {
            const { data: claimsRows } = await supabase
              .from("claims")
              .select("homeowner1, address, zip, docs_signed")
              .in("zip", zips);
            for (const c of claimsRows || []) {
              const z = (c.zip || "").trim();
              if (!z) continue;
              const fullAddrLower = (c.address || "").toLowerCase().trim();
              const streetCanonical = fullAddrLower.split(",")[0].replace(/\s+/g, " ").trim();
              const streetNumber = (streetCanonical.match(/^\d+/) || [""])[0];
              const docs = c.docs_signed || "";
              claimsByZipStreet.set(`${z}|${streetCanonical}`, docs);
              if (streetNumber) {
                const numKey = `${z}|num:${streetNumber}`;
                if (!claimsByZipStreet.has(numKey)) claimsByZipStreet.set(numKey, docs);
              }
              const lastName = ((c.homeowner1 || "").trim().split(/\s+/).pop() || "").toLowerCase();
              if (lastName) {
                const nameKey = `${z}|name:${lastName}`;
                if (!claimsByZipStreet.has(nameKey)) claimsByZipStreet.set(nameKey, docs);
              }
            }
          }
          const enriched = deduped.map(r => {
            const z = (r.zip || "").trim();
            const fullAddrLower = (r.address || "").toLowerCase().trim();
            const streetCanonical = fullAddrLower.split(",")[0].replace(/\s+/g, " ").trim();
            const streetNumber = (streetCanonical.match(/^\d+/) || [""])[0];
            const lastName = ((r.client_name || "").trim().split(/\s+/).pop() || "").toLowerCase();
            let claimDocs = claimsByZipStreet.get(`${z}|${streetCanonical}`);
            if (!claimDocs && streetNumber) claimDocs = claimsByZipStreet.get(`${z}|num:${streetNumber}`);
            if (!claimDocs && lastName)     claimDocs = claimsByZipStreet.get(`${z}|name:${lastName}`);
            claimDocs = claimDocs || "";
            const combined = [r.docs_signed || "", claimDocs].join(",").toLowerCase();
            const has = (d) => combined.includes(d);
            return { ...r, _docs: { insp: has("insp"), lor: has("lor"), pac: has("pac") } };
          });

          const sorted = enriched.sort((a, b) => {
            const lastName = (name) => {
              const parts = (name || "").trim().split(" ");
              return parts[parts.length - 1].toLowerCase();
            };
            return lastName(a.client_name).localeCompare(lastName(b.client_name));
          });
          setRecordSearchResults(sorted);
        }
      } catch (e) { console.error("Load pending error:", e); }
      finally { setRecordSearchLoading(false); }
    }}
    style={{ padding: "10px 20px", borderRadius: 12, border: listMode === "pending" ? "1.5px solid #0a0a0a" : "1.5px solid #0a0a0a", background: listMode === "pending" ? "#0a0a0a" : "#fff", color: listMode === "pending" ? "#fff" : "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}
  >
    📋 Load Pending Inspections
  </button>
  <button
    type="button"
    onClick={async () => {
      setListMode("last30");
      setResultFilter("all");
      setCheckNowSummary(null);
      setRecordSearchLoading(true);
      setRecordSearch("");
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { data: results, error } = await supabase
          .from("inspections")
          .select("id, client_name, address, city, state, zip, mobile, email, sales_rep_name, sales_rep_id, signed_at, result, result_at, last_notified_rep_at, last_notified_homeowner_at, last_notified_pa_at, docs_signed, jn_job_id, cancelled_at, signed_pdfs, pa_status, pa_status_updated_at")
          .gte("signed_at", thirtyDaysAgo)
          .order("result_at", { ascending: false, nullsFirst: false });
        if (error) throw error;

        // Dedupe by name+zip (same as pending loader)
        const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
        const normKey = (n, zip, addr) => {
          const z = (zip || "").trim();
          if (z) return `${normName(n)}|zip:${z}`;
          const street = (addr || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
          return `${normName(n)}|st:${street}`;
        };
        const bestByKey = new Map();
        for (const r of results || []) {
          const k = normKey(r.client_name, r.zip, r.address);
          const existing = bestByKey.get(k);
          if (!existing) { bestByKey.set(k, r); continue; }
          // Prefer the record that has a result set; if both do, keep most recent result_at
          const existingHasResult = !!existing.result;
          const currentHasResult = !!r.result;
          if (currentHasResult && !existingHasResult) { bestByKey.set(k, r); continue; }
          if (existingHasResult && !currentHasResult) continue;
          const tNew = r.result_at ? new Date(r.result_at).getTime() : (r.signed_at ? new Date(r.signed_at).getTime() : 0);
          const tOld = existing.result_at ? new Date(existing.result_at).getTime() : (existing.signed_at ? new Date(existing.signed_at).getTime() : 0);
          if (tNew > tOld) bestByKey.set(k, r);
        }

        // ── Pull claims in the same window to enrich each row with docs_signed
        // One lookup for the whole list beats per-row queries.
        // Filter by the zips we care about (claims.signed_at can be text type
        // in some installs, so date-based filtering is unreliable. Zip is more reliable.)
        const inspZips = [...new Set([...bestByKey.values()].map(r => (r.zip || "").trim()).filter(Boolean))];
        let claimsRows = [];
        if (inspZips.length > 0) {
          const { data: cr } = await supabase
            .from("claims")
            .select("homeowner1, homeowner2, address, zip, docs_signed")
            .in("zip", inspZips);
          claimsRows = cr || [];
        }
        // Build a multi-key map so we can find matches even when address strings
        // differ slightly between inspections and claims tables.
        // Keys we store: zip|street (full street), zip|streetNumber (just the number),
        // and zip+homeowner-last-name as a final fallback.
        const claimsByZipStreet = new Map();
        for (const c of claimsRows || []) {
          const z = (c.zip || "").trim();
          if (!z) continue;
          const fullAddrLower = (c.address || "").toLowerCase().trim();
          const streetCanonical = fullAddrLower.split(",")[0].replace(/\s+/g, " ").trim();
          const streetNumber = (streetCanonical.match(/^\d+/) || [""])[0];
          const docs = c.docs_signed || "";
          // Multiple keys point to the same docs value — first match wins
          claimsByZipStreet.set(`${z}|${streetCanonical}`, docs);
          if (streetNumber) {
            const numKey = `${z}|num:${streetNumber}`;
            if (!claimsByZipStreet.has(numKey)) claimsByZipStreet.set(numKey, docs);
          }
          // Fallback by zip + last-name token from homeowner1
          const lastName = ((c.homeowner1 || "").trim().split(/\s+/).pop() || "").toLowerCase();
          if (lastName) {
            const nameKey = `${z}|name:${lastName}`;
            if (!claimsByZipStreet.has(nameKey)) claimsByZipStreet.set(nameKey, docs);
          }
        }

        // Merge docs_signed onto each inspection.
        // Priority: inspection's own docs_signed column (set at signing) → fallback to claims lookup.
        // If insp record was created standalone (no claim), docs_signed usually = "insp".
        const enriched = [...bestByKey.values()].map(r => {
          const z = (r.zip || "").trim();
          const fullAddrLower = (r.address || "").toLowerCase().trim();
          const streetCanonical = fullAddrLower.split(",")[0].replace(/\s+/g, " ").trim();
          const streetNumber = (streetCanonical.match(/^\d+/) || [""])[0];
          const lastName = ((r.client_name || "").trim().split(/\s+/).pop() || "").toLowerCase();
          // Try keys in order of specificity
          let claimDocs = claimsByZipStreet.get(`${z}|${streetCanonical}`);
          if (!claimDocs && streetNumber) claimDocs = claimsByZipStreet.get(`${z}|num:${streetNumber}`);
          if (!claimDocs && lastName)     claimDocs = claimsByZipStreet.get(`${z}|name:${lastName}`);
          claimDocs = claimDocs || "";
          // Combine both sides — if either source lists a doc, count it as signed
          const combined = [r.docs_signed || "", claimDocs].join(",").toLowerCase();
          const has = (d) => combined.includes(d);
          return { ...r, _docs: { insp: has("insp"), lor: has("lor"), pac: has("pac") }, _claimDocsRaw: claimDocs };
        });

        // Expose to window for debugging — open dev console and run window.__lastInspections
        if (typeof window !== "undefined") window.__lastInspections = enriched;

        // Sort: records with results first (most recent result_at on top), then pending by signed_at desc
        const sorted = enriched.sort((a, b) => {
          const aHas = !!a.result; const bHas = !!b.result;
          if (aHas && !bHas) return -1;
          if (bHas && !aHas) return 1;
          if (aHas && bHas) {
            const ta = a.result_at ? new Date(a.result_at).getTime() : 0;
            const tb = b.result_at ? new Date(b.result_at).getTime() : 0;
            return tb - ta;
          }
          const sa = a.signed_at ? new Date(a.signed_at).getTime() : 0;
          const sb = b.signed_at ? new Date(b.signed_at).getTime() : 0;
          return sb - sa;
        });
        setRecordSearchResults(sorted);
      } catch (e) {
        console.error("Load last 30 days error:", e);
        alert("Could not load 30-day records: " + (e.message || e));
      }
      finally { setRecordSearchLoading(false); }
    }}
    style={{ padding: "10px 20px", borderRadius: 12, border: "1.5px solid #0a0a0a", background: listMode === "last30" ? "#0a0a0a" : "#fff", color: listMode === "last30" ? "#fff" : "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}
  >
    📂 Load Last 30 Days
  </button>

  {/* ── Load by single date — useful for finding records by signing date ── */}
  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
    <input
      type="date"
      value={lookupDate}
      onChange={(e) => setLookupDate(e.target.value)}
      style={{ height: 40, borderRadius: 10, border: "1.5px solid #0a0a0a", padding: "0 10px", fontSize: 13, fontFamily: "'Nunito', sans-serif", color: "#0a0a0a", boxSizing: "border-box" }}
    />
    <button
      type="button"
      onClick={async () => {
        setListMode("dateLookup");
        setResultFilter("all");
        setCheckNowSummary(null);
        setRecordSearchLoading(true);
        setRecordSearch("");
        try {
          // Build the start/end of the selected day in ISO format. Inspections.signed_at
          // is timestamptz, so we want everything from 00:00:00 to 23:59:59 of that local day.
          // Use the user's local timezone offset so a record signed at 11pm shows up under
          // its correct local date instead of the next UTC day.
          const dayStart = new Date(`${lookupDate}T00:00:00`).toISOString();
          const dayEnd   = new Date(`${lookupDate}T23:59:59.999`).toISOString();
          const { data: results, error } = await supabase
            .from("inspections")
            .select("id, client_name, address, city, state, zip, mobile, email, sales_rep_name, sales_rep_id, signed_at, result, result_at, last_notified_rep_at, last_notified_homeowner_at, last_notified_pa_at, docs_signed, jn_job_id, cancelled_at, signed_pdfs, pa_status, pa_status_updated_at")
            .gte("signed_at", dayStart)
            .lte("signed_at", dayEnd)
            .order("signed_at", { ascending: false });
          if (error) throw error;

          // Same dedup logic as Last 30 Days
          const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
          const normKey = (n, zip, addr) => {
            const z = (zip || "").trim();
            if (z) return `${normName(n)}|zip:${z}`;
            const street = (addr || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
            return `${normName(n)}|st:${street}`;
          };
          const bestByKey = new Map();
          for (const r of results || []) {
            const k = normKey(r.client_name, r.zip, r.address);
            const existing = bestByKey.get(k);
            if (!existing) { bestByKey.set(k, r); continue; }
            const existingHasResult = !!existing.result;
            const currentHasResult = !!r.result;
            if (currentHasResult && !existingHasResult) { bestByKey.set(k, r); continue; }
            if (existingHasResult && !currentHasResult) continue;
            const tNew = r.result_at ? new Date(r.result_at).getTime() : (r.signed_at ? new Date(r.signed_at).getTime() : 0);
            const tOld = existing.result_at ? new Date(existing.result_at).getTime() : (existing.signed_at ? new Date(existing.signed_at).getTime() : 0);
            if (tNew > tOld) bestByKey.set(k, r);
          }

          // Same multi-key claims-table enrichment as Last 30 Days so doc badges work
          const inspZips = [...new Set([...bestByKey.values()].map(r => (r.zip || "").trim()).filter(Boolean))];
          let claimsRows = [];
          if (inspZips.length > 0) {
            const { data: cr } = await supabase
              .from("claims")
              .select("homeowner1, homeowner2, address, zip, docs_signed")
              .in("zip", inspZips);
            claimsRows = cr || [];
          }
          const claimsByZipStreet = new Map();
          for (const c of claimsRows) {
            const z = (c.zip || "").trim();
            if (!z) continue;
            const fullAddrLower = (c.address || "").toLowerCase().trim();
            const streetCanonical = fullAddrLower.split(",")[0].replace(/\s+/g, " ").trim();
            const streetNumber = (streetCanonical.match(/^\d+/) || [""])[0];
            const docs = c.docs_signed || "";
            claimsByZipStreet.set(`${z}|${streetCanonical}`, docs);
            if (streetNumber) {
              const numKey = `${z}|num:${streetNumber}`;
              if (!claimsByZipStreet.has(numKey)) claimsByZipStreet.set(numKey, docs);
            }
            const lastName = ((c.homeowner1 || "").trim().split(/\s+/).pop() || "").toLowerCase();
            if (lastName) {
              const nameKey = `${z}|name:${lastName}`;
              if (!claimsByZipStreet.has(nameKey)) claimsByZipStreet.set(nameKey, docs);
            }
          }
          const enriched = [...bestByKey.values()].map(r => {
            const z = (r.zip || "").trim();
            const fullAddrLower = (r.address || "").toLowerCase().trim();
            const streetCanonical = fullAddrLower.split(",")[0].replace(/\s+/g, " ").trim();
            const streetNumber = (streetCanonical.match(/^\d+/) || [""])[0];
            const lastName = ((r.client_name || "").trim().split(/\s+/).pop() || "").toLowerCase();
            let claimDocs = claimsByZipStreet.get(`${z}|${streetCanonical}`);
            if (!claimDocs && streetNumber) claimDocs = claimsByZipStreet.get(`${z}|num:${streetNumber}`);
            if (!claimDocs && lastName)     claimDocs = claimsByZipStreet.get(`${z}|name:${lastName}`);
            claimDocs = claimDocs || "";
            const combined = [r.docs_signed || "", claimDocs].join(",").toLowerCase();
            const has = (d) => combined.includes(d);
            return { ...r, _docs: { insp: has("insp"), lor: has("lor"), pac: has("pac") } };
          });

          // Sort by signed_at desc
          enriched.sort((a, b) => {
            const ta = a.signed_at ? new Date(a.signed_at).getTime() : 0;
            const tb = b.signed_at ? new Date(b.signed_at).getTime() : 0;
            return tb - ta;
          });
          if (typeof window !== "undefined") window.__lastInspections = enriched;
          setRecordSearchResults(enriched);
        } catch (e) {
          console.error("Load by date error:", e);
          alert("Could not load records for that date: " + (e.message || e));
        }
        finally { setRecordSearchLoading(false); }
      }}
      style={{ padding: "10px 20px", borderRadius: 12, border: "1.5px solid #0a0a0a", background: listMode === "dateLookup" ? "#0a0a0a" : "#fff", color: listMode === "dateLookup" ? "#fff" : "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}
    >
      📅 Load by Date
    </button>
  </div>
  {recordSearchResults.length > 0 && !recordSearch ? (
    <span style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
      {listMode === "pending" ? `${recordSearchResults.length} pending — sorted A→Z by last name`
       : listMode === "dateLookup" ? `${recordSearchResults.length} records on ${new Date(`${lookupDate}T12:00:00`).toLocaleDateString()}`
       : `${recordSearchResults.length} records (last 30 days)`}
    </span>
  ) : null}
</div>

{/* ── Filter chips — shown in Last-30 and Date-Lookup modes to narrow by result ── */}
{(listMode === "last30" || listMode === "dateLookup") && recordSearchResults.length > 0 ? (
  <div style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
    <span style={{ fontSize: 11, fontFamily: "'Oswald', sans-serif", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>Filter:</span>
    {[
      { key: "all",        label: "All",         bg: "#0a0a0a", color: "#fff" },
      { key: "damage",     label: "⚠️ Damage",    bg: "#dc2626", color: "#fff" },
      { key: "no_damage",  label: "✅ No Damage", bg: "#199c2e", color: "#fff" },
      { key: "retail",     label: "🏠 Retail",    bg: "#d97706", color: "#fff" },
      { key: "pending",    label: "Pending",     bg: "#6b7280", color: "#fff" },
      { key: "cancelled",  label: "❌ Cancelled", bg: "#991b1b", color: "#fff" },
    ].map(f => (
      <button
        key={f.key}
        type="button"
        onClick={() => setResultFilter(f.key)}
        style={{ padding: "5px 12px", borderRadius: 16, border: "none", background: resultFilter === f.key ? f.bg : "#e5e7eb", color: resultFilter === f.key ? f.color : "#374151", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}
      >
        {f.label}
      </button>
    ))}
  </div>
) : null}
                    <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                      <input type="text" value={recordSearch} onChange={(e) => { setRecordSearch(e.target.value); searchInspectionRecords(e.target.value); }}
                        placeholder="Search by name, address, or ZIP..."
                        style={{ flex: 1, height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 14px", fontSize: 14, boxSizing: "border-box" }} />
                      {recordSearchLoading ? <div style={{ display: "flex", alignItems: "center", color: "#6b7280", fontSize: 13, fontFamily: "'Nunito', sans-serif" }}>Searching…</div> : null}
                    </div>

                    {recordSearchResults.length > 0 ? (
                      <>
                        {/* ── Check Now button appears once the list is loaded ── */}
                        {!recordSearch ? (
                          <div style={{ background: "#fff8f8", border: "1.5px solid #fecaca", borderRadius: 14, padding: "14px 18px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                            <div>
                              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, fontWeight: 700, color: "#991b1b", marginBottom: 2 }}>
                                🔍 Check JobNimbus for Results
                              </div>
                              <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                                Scans JN for any changes to these pending inspections. Updates the status inline.
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={checkNowLoading}
                              onClick={async () => {
                                setCheckNowLoading(true);
                                setCheckNowSummary(null);
                                try {
                                  // Capture "before" state keyed by id
                                  const beforeById = {};
                                  recordSearchResults.forEach(r => { beforeById[r.id] = r.result || null; });

                                  // Trigger the inspection-checker cron function
                                  const r = await fetch("/.netlify/functions/inspection-checker");
                                  const d = await r.json().catch(() => ({}));
                                  console.log("Check Now result:", d);

                                  // Refetch the current state of ALL rows we just showed
                                  const ids = recordSearchResults.map(r => r.id);
                                  const { data: fresh } = await supabase
                                    .from("inspections")
                                    .select("id, result, result_at")
                                    .in("id", ids);

                                  const freshById = {};
                                  (fresh || []).forEach(r => { freshById[r.id] = r; });

                                  // Apply: for each row, compute checkedStatus
                                  let changedCount = 0;
                                  const updated = recordSearchResults.map(row => {
                                    const before = beforeById[row.id];
                                    const after = freshById[row.id]?.result || null;
                                    let checkedStatus = "no_change";
                                    if (!before && after === "damage")     { checkedStatus = "changed_damage";    changedCount++; }
                                    else if (!before && after === "no_damage"){ checkedStatus = "changed_no_damage"; changedCount++; }
                                    else if (!before && after === "retail") { checkedStatus = "changed_retail";    changedCount++; }
                                    return { ...row, result: after, result_at: freshById[row.id]?.result_at || row.result_at, checkedStatus };
                                  });

                                  setRecordSearchResults(updated);
                                  setCheckNowSummary({
                                    total: recordSearchResults.length,
                                    changed: changedCount,
                                    unchanged: recordSearchResults.length - changedCount,
                                  });
                                } catch (e) {
                                  console.error("Check Now error:", e);
                                  setCheckNowSummary({ error: e.message || "Check failed" });
                                } finally {
                                  setCheckNowLoading(false);
                                }
                              }}
                              style={{ padding: "10px 22px", borderRadius: 10, border: "none", background: checkNowLoading ? "#9ca3af" : "#dc2626", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: checkNowLoading ? "not-allowed" : "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}
                            >
                              {checkNowLoading ? "⏳ Checking..." : "🔍 Check Now"}
                            </button>
                          </div>
                        ) : null}

                        {/* ── Check summary banner ── */}
                        {checkNowSummary ? (
                          <div style={{ background: checkNowSummary.error ? "#fef2f2" : "#f0fdf4", border: `1px solid ${checkNowSummary.error ? "#fca5a5" : "#bbf7d0"}`, borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: checkNowSummary.error ? "#991b1b" : "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                            {checkNowSummary.error ? (
                              <>❌ {checkNowSummary.error}</>
                            ) : (
                              <>✅ Check complete · {checkNowSummary.total} reviewed · {checkNowSummary.changed > 0 ? <strong>{checkNowSummary.changed} changed</strong> : "0 changed"} · {checkNowSummary.unchanged} still pending</>
                            )}
                          </div>
                        ) : null}

                        <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
                        {recordSearchResults
                          .filter(rec => {
                            // Apply free-text search filter (in-memory, preserves _docs enrichment)
                            if (recordSearch && recordSearch.trim().length >= 2) {
                              const q = recordSearch.trim().toLowerCase();
                              const haystack = [rec.client_name, rec.address, rec.city, rec.zip, rec.sales_rep_name].filter(Boolean).join(" ").toLowerCase();
                              if (!haystack.includes(q)) return false;
                            }
                            // Apply result filter for Last-30 and Date-Lookup modes
                            if (listMode !== "last30" && listMode !== "dateLookup") return true;
                            if (resultFilter === "all") return !rec.cancelled_at; // hide cancelled from "all" by default
                            if (resultFilter === "cancelled") return !!rec.cancelled_at;
                            if (resultFilter === "pending") return !rec.result && !rec.cancelled_at;
                            return rec.result === resultFilter && !rec.cancelled_at;
                          })
                          .map((rec) => {
                          // Render the status pill — cancelled overrides everything.
                          // Otherwise prefer the just-checked status, else fall back to result.
                          let pill;
                          if (rec.cancelled_at) {
                            pill = <div style={{ background: "#991b1b", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>❌ Cancelled</div>;
                          } else if (rec.checkedStatus === "changed_damage") {
                            pill = <div style={{ background: "#dc2626", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>→ Damage</div>;
                          } else if (rec.checkedStatus === "changed_no_damage") {
                            pill = <div style={{ background: "#199c2e", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>→ No Damage</div>;
                          } else if (rec.checkedStatus === "changed_retail") {
                            pill = <div style={{ background: "#d97706", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>→ Retail</div>;
                          } else if (rec.checkedStatus === "no_change") {
                            pill = <div style={{ background: "#f3f4f6", color: "#6b7280", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>No change</div>;
                          } else if (rec.result === "no_damage") {
                            pill = <div style={{ background: "#199c2e", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>✅ No Damage</div>;
                          } else if (rec.result === "damage") {
                            pill = <div style={{ background: "#dc2626", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>⚠️ Damage</div>;
                          } else if (rec.result === "retail") {
                            pill = <div style={{ background: "#d97706", color: "#fff", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>🏠 Retail</div>;
                          } else {
                            pill = <div style={{ background: "#f3f4f6", color: "#6b7280", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>Pending</div>;
                          }

                          const signedDate = rec.signed_at ? new Date(rec.signed_at).toLocaleDateString() : "—";
                          const isBusy = rowBusyId === rec.id;

                          // Friendly "last sent" formatter for notify buttons
                          const formatAgo = (iso) => {
                            if (!iso) return "Never sent";
                            const diff = Math.max(0, Date.now() - new Date(iso).getTime());
                            const mins = Math.floor(diff / 60000);
                            if (mins < 1) return "Just now";
                            if (mins < 60) return `${mins}m ago`;
                            const hrs = Math.floor(mins / 60);
                            if (hrs < 24) return `${hrs}h ago`;
                            const days = Math.floor(hrs / 24);
                            if (days < 7) return `${days}d ago`;
                            return new Date(iso).toLocaleDateString();
                          };
                          const resultedLine = rec.result_at
                            ? `Resulted: ${new Date(rec.result_at).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}`
                            : null;
                          const showPaButton = rec.result === "damage";
                          const paAllSigned = rec._docs && rec._docs.insp && rec._docs.lor && rec._docs.pac;
                          const paButtonReady = showPaButton && paAllSigned;
                          const paButtonTooltip = !showPaButton
                            ? ""
                            : paAllSigned
                              ? "Email Kkeckleradj@gmail.com with photos"
                              : "All 3 docs (Insp + LOR + PA) must be signed before PA is notified";

                          return (
                            <div key={rec.id}
                              style={{ background: selectedInspRecord?.id === rec.id ? "#eef1f8" : "#fff", border: selectedInspRecord?.id === rec.id ? "2px solid #0a0a0a" : "1px solid #e5e7eb", borderRadius: 14, padding: "12px 16px" }}>

                              {/* Main row — name/addr, signed date, status pill */}
                              <div
                                onClick={() => { setSelectedInspRecord(rec); setResultDone(false); setResultChoice(""); setResultInspectorName(""); }}
                                style={{ cursor: "pointer", display: "grid", gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: 16 }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontFamily: "'Nunito', sans-serif" }}>{rec.client_name || "—"}</div>
                                  <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>{[rec.address, rec.city, rec.state, rec.zip].filter(Boolean).join(", ")}</div>
                                  <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                                    <span>Rep: {rec.sales_rep_name || "—"}</span>
                                    {rec._docs ? (
                                      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                        <span style={{ background: rec._docs.insp ? "#dbeafe" : "#f3f4f6", color: rec._docs.insp ? "#1e40af" : "#9ca3af", borderRadius: 6, padding: "1px 6px", fontWeight: 700, fontSize: 10, letterSpacing: "0.03em" }}>
                                          {rec._docs.insp ? "✓" : "·"} INSP
                                        </span>
                                        <span style={{ background: rec._docs.lor ? "#dbeafe" : "#f3f4f6", color: rec._docs.lor ? "#1e40af" : "#9ca3af", borderRadius: 6, padding: "1px 6px", fontWeight: 700, fontSize: 10, letterSpacing: "0.03em" }}>
                                          {rec._docs.lor ? "✓" : "·"} LOR
                                        </span>
                                        <span style={{ background: rec._docs.pac ? "#dbeafe" : "#f3f4f6", color: rec._docs.pac ? "#1e40af" : "#9ca3af", borderRadius: 6, padding: "1px 6px", fontWeight: 700, fontSize: 10, letterSpacing: "0.03em" }}>
                                          {rec._docs.pac ? "✓" : "·"} PA
                                        </span>
                                        {rec._docs.insp && rec._docs.lor && rec._docs.pac ? (
                                          <span style={{ background: "#059669", color: "#fff", borderRadius: 6, padding: "1px 6px", fontWeight: 700, fontSize: 10, letterSpacing: "0.03em" }}>ALL SIGNED</span>
                                        ) : null}
                                      </span>
                                    ) : null}
                                    {resultedLine ? <span style={{ color: "#059669", fontWeight: 600 }}>· {resultedLine}</span> : null}
                                  </div>
                                </div>
                                <div style={{ textAlign: "center", padding: "0 10px" }}>
                                  <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>Signed</div>
                                  <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>{signedDate}</div>
                                </div>
                                <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                                  {pill}
                                  {/* PA status pill — only shown for damage records that
                                      we've submitted to the PA Ops Hub. The PA's app flips
                                      this to "signed" / "refused" via the callback webhook. */}
                                  {rec.result === "damage" && rec.pa_status ? (
                                    rec.pa_status === "signed" ? (
                                      <div style={{ background: "#199c2e", color: "#fff", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}
                                        title={rec.pa_status_updated_at ? `PA updated ${new Date(rec.pa_status_updated_at).toLocaleString()}` : undefined}>
                                        🤝 PA: SIGNED
                                      </div>
                                    ) : rec.pa_status === "refused" ? (
                                      <div style={{ background: "#6b7280", color: "#fff", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}
                                        title={rec.pa_status_updated_at ? `PA updated ${new Date(rec.pa_status_updated_at).toLocaleString()}` : undefined}>
                                        🚫 PA: REFUSED
                                      </div>
                                    ) : (
                                      <div style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fbbf24", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}
                                        title={rec.pa_status_updated_at ? `PA updated ${new Date(rec.pa_status_updated_at).toLocaleString()}` : "Sent to PA Ops Hub — waiting on signature outcome"}>
                                        ⏳ PA: PENDING
                                      </div>
                                    )
                                  ) : null}
                                </div>
                              </div>

                              {/* Admin actions — override result + manual notifications. Hidden for cancelled rows. */}
                              {rec.cancelled_at ? (
                                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed #e5e7eb", fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                                  Cancelled {new Date(rec.cancelled_at).toLocaleDateString()} — removed from pending lists &amp; reports.
                                </div>
                              ) : (
                              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed #e5e7eb", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <div style={{ fontSize: 10, fontFamily: "'Oswald', sans-serif", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>Admin:</div>
                                <select
                                  value={rec.result || ""}
                                  disabled={isBusy}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => { e.stopPropagation(); adminSetRowResult(rec.id, e.target.value); }}
                                  style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 12, fontFamily: "'Nunito', sans-serif", fontWeight: 600, background: isBusy ? "#f3f4f6" : "#fff", cursor: isBusy ? "not-allowed" : "pointer" }}>
                                  <option value="">Set result…</option>
                                  <option value="damage">⚠️ Damage</option>
                                  <option value="no_damage">✅ No Damage</option>
                                  <option value="retail">🏠 Retail</option>
                                </select>
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                  <button
                                    type="button"
                                    disabled={isBusy || !rec.result}
                                    onClick={(e) => { e.stopPropagation(); adminNotifyRow(rec, "rep"); }}
                                    title={!rec.result ? "Set a result first" : "Send SMS to the sales rep using current template"}
                                    style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #0a0a0a", background: (isBusy || !rec.result) ? "#f3f4f6" : "#fff", color: (isBusy || !rec.result) ? "#9ca3af" : "#0a0a0a", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: (isBusy || !rec.result) ? "not-allowed" : "pointer" }}>
                                    📱 Notify Rep
                                  </button>
                                  <div style={{ fontSize: 9, color: rec.last_notified_rep_at ? "#059669" : "#9ca3af", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{formatAgo(rec.last_notified_rep_at)}</div>
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                  <button
                                    type="button"
                                    disabled={isBusy || !rec.result}
                                    onClick={(e) => { e.stopPropagation(); adminNotifyRow(rec, "homeowner"); }}
                                    title={!rec.result ? "Set a result first" : "Send SMS to the homeowner using current template"}
                                    style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #0a0a0a", background: (isBusy || !rec.result) ? "#f3f4f6" : "#fff", color: (isBusy || !rec.result) ? "#9ca3af" : "#0a0a0a", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: (isBusy || !rec.result) ? "not-allowed" : "pointer" }}>
                                    📱 Notify Homeowner
                                  </button>
                                  <div style={{ fontSize: 9, color: rec.last_notified_homeowner_at ? "#059669" : "#9ca3af", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{formatAgo(rec.last_notified_homeowner_at)}</div>
                                </div>
                                {showPaButton ? (
                                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                    <button
                                      type="button"
                                      disabled={isBusy || !paButtonReady}
                                      onClick={(e) => { e.stopPropagation(); adminNotifyPA(rec); }}
                                      title={paButtonTooltip}
                                      style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #dc2626", background: (isBusy || !paButtonReady) ? "#f3f4f6" : "#fff", color: (isBusy || !paButtonReady) ? "#9ca3af" : "#dc2626", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: (isBusy || !paButtonReady) ? "not-allowed" : "pointer" }}>
                                      📧 Notify PA
                                    </button>
                                    <div style={{ fontSize: 9, color: rec.last_notified_pa_at ? "#059669" : "#9ca3af", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>{formatAgo(rec.last_notified_pa_at)}</div>
                                  </div>
                                ) : null}

                                {/* Re-send signed documents to any email — works when ANY PA-related doc is signed OR PDFs are already archived */}
                                {(() => {
                                  const hasArchive = !!(rec.signed_pdfs && rec.signed_pdfs.insp);
                                  const hasPaDocs = rec._docs && (rec._docs.lor || rec._docs.pac);
                                  const showButton = hasArchive || hasPaDocs;
                                  if (!showButton) return null;
                                  return (
                                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                      <button
                                        type="button"
                                        disabled={isBusy}
                                        onClick={(e) => { e.stopPropagation(); setResendModal({ rec, to: "", cc: "", recipientType: "pa", customTo: "" }); }}
                                        title={hasArchive ? "Resend archived signed documents to a custom email" : "Regenerate and send signed documents (no archive on file yet — will rebuild from records)"}
                                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #0891b2", background: isBusy ? "#f3f4f6" : "#fff", color: isBusy ? "#9ca3af" : "#0891b2", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: isBusy ? "not-allowed" : "pointer" }}>
                                        📤 Re-send Docs
                                      </button>
                                      <div style={{ fontSize: 9, color: hasArchive ? "#059669" : "#9ca3af", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                                        {hasArchive ? "📁 Archived" : "Will regenerate"}
                                      </div>
                                    </div>
                                  );
                                })()}

                                {/* Manual Mark Lost — for cases when the JN-sync cron didn't catch a Lost status,
                                    or when an admin needs to immediately remove a record from Pending. Marks the
                                    inspection cancelled, hides it from Pending, and shows it under the Cancelled
                                    filter in Last 30 Days / Date Lookup. Only shown for records without a result
                                    set (already-resulted records don't belong as Lost). */}
                                {!rec.result && !rec.cancelled_at ? (
                                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        const reason = window.prompt(`Mark "${rec.client_name}" as Lost?\n\nReason (optional, e.g. "homeowner cancelled", "no longer needed"):`, "");
                                        if (reason === null) return; // user clicked Cancel on the prompt
                                        try {
                                          const { error } = await supabase
                                            .from("inspections")
                                            .update({
                                              cancelled_at: new Date().toISOString(),
                                              cancel_reason: reason || "Manually marked Lost by admin",
                                              jn_status: "Lost",
                                            })
                                            .eq("id", rec.id);
                                          if (error) {
                                            alert("Could not mark Lost: " + error.message);
                                            return;
                                          }
                                          // Remove from current view immediately
                                          setRecordSearchResults(prev => prev.filter(r => r.id !== rec.id));
                                        } catch (err) {
                                          alert("Error: " + (err.message || err));
                                        }
                                      }}
                                      title="Manually mark this inspection as Lost (homeowner cancelled, etc.). Removes it from Pending."
                                      style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #991b1b", background: isBusy ? "#f3f4f6" : "#fff", color: isBusy ? "#9ca3af" : "#991b1b", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: isBusy ? "not-allowed" : "pointer" }}>
                                      ❌ Mark Lost
                                    </button>
                                  </div>
                                ) : null}

                                {/* Orphan detector — only show if record is missing jn_job_id. Opens
                                    the JN match picker first so the manager can link to an existing
                                    JN job instead of silently creating a duplicate (the picker only
                                    fires retry-jn-sync's create flow if the manager confirms
                                    "None match — Create new in JN"). */}
                                {!rec.jn_job_id ? (
                                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      onClick={(e) => { e.stopPropagation(); setJnPickerRow(rec); }}
                                      title="Search JobNimbus for this homeowner first — link an existing job if one's there, or create a new one if not."
                                      style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #ea580c", background: isBusy ? "#f3f4f6" : "#fff7ed", color: isBusy ? "#9ca3af" : "#ea580c", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: isBusy ? "not-allowed" : "pointer" }}>
                                      🔄 Sync to JN
                                    </button>
                                    <div style={{ fontSize: 9, color: "#ea580c", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>Not in JN</div>
                                  </div>                                ) : null}

                                {/* Push result to JN — appears when the record HAS a JN job AND
                                    a local result. Live status appears under the button so
                                    the manager sees progress instead of staring at a frozen
                                    page (the prior alert()-only flow gave no feedback). */}
                                {rec.jn_job_id && rec.result ? (() => {
                                  const status = pushStatus[rec.id];
                                  const inFlight = status && (status.stage === "updating" || status.stage === "queueing");
                                  const label = inFlight
                                    ? "⏳ Pushing…"
                                    : status?.stage === "done"
                                      ? "✓ Pushed"
                                      : "🔄 Push to JN";
                                  return (
                                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, maxWidth: 220 }}>
                                      <button
                                        type="button"
                                        disabled={isBusy || inFlight}
                                        onClick={(e) => { e.stopPropagation(); adminPushResultToJn(rec); }}
                                        title={`Push the local result (${rec.result}) to JN. Updates the JN inspection-result field instantly; cert + photos upload in the background.`}
                                        style={{
                                          padding: "6px 12px",
                                          borderRadius: 8,
                                          border: `1px solid ${status?.ok === false ? "#dc2626" : "#0e7490"}`,
                                          background: (isBusy || inFlight) ? "#f3f4f6" : (status?.ok === true ? "#ecfdf5" : status?.ok === false ? "#fef2f2" : "#ecfeff"),
                                          color: (isBusy || inFlight) ? "#9ca3af" : (status?.ok === false ? "#991b1b" : "#0e7490"),
                                          fontSize: 11,
                                          fontFamily: "'Oswald', sans-serif",
                                          fontWeight: 700,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.04em",
                                          cursor: (isBusy || inFlight) ? "wait" : "pointer",
                                        }}>
                                        {label}
                                      </button>
                                      {status?.message && (
                                        <div style={{
                                          fontSize: 10,
                                          color: status.ok === false ? "#991b1b" : status.ok === true ? "#065f46" : "#475569",
                                          fontFamily: "'Nunito', sans-serif",
                                          fontWeight: 600,
                                          textAlign: "center",
                                          lineHeight: 1.3,
                                          maxWidth: 220,
                                        }}>
                                          {status.message}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })() : null}

                                {/* Photos — opens a modal showing every inspection_photo with its
                                    label (from the inspector's wizard) so the manager can
                                    review what was submitted without bouncing to JN. */}
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={(e) => { e.stopPropagation(); setPhotosModalId(rec.id); }}
                                    title="View the inspector's photos for this record (with labels)."
                                    style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #0e7490", background: isBusy ? "#f3f4f6" : "#ecfeff", color: isBusy ? "#9ca3af" : "#0e7490", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: isBusy ? "not-allowed" : "pointer" }}>
                                    📸 Photos
                                  </button>
                                </div>

                                {/* Edit Record — opens a modal to fix client name, address, sales rep, JN link, result, etc. */}
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditModal({
                                        rec,
                                        draft: {
                                          client_name: rec.client_name || "",
                                          address: rec.address || "",
                                          city: rec.city || "",
                                          state: rec.state || "",
                                          zip: rec.zip || "",
                                          mobile: rec.mobile || "",
                                          email: rec.email || "",
                                          sales_rep_name: rec.sales_rep_name || "",
                                          sales_rep_id: rec.sales_rep_id || "",
                                          jn_job_id: rec.jn_job_id || "",
                                          result: rec.result || "",
                                        },
                                      });
                                    }}
                                    title="Edit this record's details — name, address, sales rep, JN link, result, etc."
                                    style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #6b7280", background: isBusy ? "#f3f4f6" : "#fff", color: isBusy ? "#9ca3af" : "#374151", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: isBusy ? "not-allowed" : "pointer" }}>
                                    ✏️ Edit
                                  </button>
                                </div>

                                {isBusy ? <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>Working…</span> : null}
                              </div>
                              )}
                            </div>
                          );
                        })}
                        </div>
                      </>
                    ) : recordSearch.length >= 2 && !recordSearchLoading ? (
                      <div style={{ fontSize: 13, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", marginBottom: 16 }}>No records found.</div>
                    ) : null}

                    {selectedInspRecord && !resultDone ? (
                      <div style={{ background: "#fff", border: "2px solid #0a0a0a", borderRadius: 18, padding: "20px 22px", marginTop: 8 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#0a0a0a", marginBottom: 14 }}>
                          🏠 Record Result — {selectedInspRecord.client_name}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                          {[{ key: "no_damage", emoji: "✅", label: "No Damage", desc: "Roof is in good condition" }, { key: "damage", emoji: "⚠️", label: "Damage Found", desc: "Storm damage confirmed" }].map(opt => (
                            <button key={opt.key} type="button" onClick={() => setResultChoice(opt.key)}
                              style={{ padding: "18px 12px", borderRadius: 16, textAlign: "center", border: resultChoice === opt.key ? `3px solid ${opt.key === "damage" ? "#dc2626" : "#199c2e"}` : "2px solid #e5e7eb", background: resultChoice === opt.key ? (opt.key === "damage" ? "#fef2f2" : "#f0fdf4") : "#fff", cursor: "pointer" }}>
                              <div style={{ fontSize: 32, marginBottom: 6 }}>{opt.emoji}</div>
                              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827" }}>{opt.label}</div>
                              <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginTop: 4 }}>{opt.desc}</div>
                              {resultChoice === opt.key ? <div style={{ fontSize: 12, fontWeight: 700, color: opt.key === "damage" ? "#dc2626" : "#199c2e", fontFamily: "'Nunito', sans-serif", marginTop: 4 }}>✓ Selected</div> : null}
                            </button>
                          ))}
                        </div>
                        <div style={{ marginBottom: 14 }}>
                          <Label>Inspector Name *</Label>
                          <input type="text" value={resultInspectorName} onChange={(e) => setResultInspectorName(e.target.value)} placeholder="Full name of inspector"
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                        <div style={{ marginBottom: 14 }}>
                          <Label>Inspection Date</Label>
                          <input type="date" value={resultCertDate} onChange={(e) => setResultCertDate(e.target.value)}
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                        {resultChoice === "damage" ? <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, padding: "12px 16px", marginBottom: 14, fontSize: 13, color: "#991b1b", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>⚠️ Will email + SMS homeowner the damage report, and SMS sales rep to get PA paperwork signed ASAP (if not already signed).</div> : null}
                        {resultChoice === "no_damage" ? <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12, padding: "12px 16px", marginBottom: 14, fontSize: 13, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>✅ Will email homeowner their official no-damage certificate with instructions to keep it safe.</div> : null}
                        <button type="button" onClick={submitInspectionResult} disabled={!resultChoice || !resultInspectorName.trim() || resultSubmitting}
                          style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: resultChoice === "damage" ? "#dc2626" : resultChoice === "no_damage" ? "#199c2e" : "#9ca3af", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", textTransform: "uppercase", cursor: (!resultChoice || !resultInspectorName.trim() || resultSubmitting) ? "not-allowed" : "pointer", opacity: (!resultChoice || !resultInspectorName.trim() || resultSubmitting) ? 0.6 : 1 }}>
                          {resultSubmitting ? "Processing..." : resultChoice === "damage" ? "📤 Send Results — Damage" : resultChoice === "no_damage" ? "📤 Send Results — No Damage" : "Select a Result Above"}
                        </button>
                      </div>
                    ) : null}

                    {selectedInspRecord && resultDone ? (
                      <div style={{ background: "#f0fdf4", border: "2px solid #199c2e", borderRadius: 18, padding: "24px 22px", marginTop: 8, textAlign: "center" }}>
                        <div style={{ fontSize: 48, marginBottom: 10 }}>✅</div>
                        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#166534", marginBottom: 8 }}>Result Recorded!</div>
                        <div style={{ fontSize: 15, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600, lineHeight: 1.6 }}>
                          {selectedInspRecord.client_name} — {resultChoice === "damage" ? "Damage reported. Homeowner and rep notified." : "No-damage certificate sent to homeowner."}
                        </div>
                        <button type="button" onClick={() => { setSelectedInspRecord(null); setResultChoice(""); setResultDone(false); setRecordSearch(""); setRecordSearchResults([]); }}
                          style={{ marginTop: 16, padding: "10px 24px", borderRadius: 14, border: "2px solid #199c2e", background: "#fff", color: "#199c2e", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          Search Another
                        </button>
                      </div>
                    ) : null}
                  </Card>}
                  {managerSection === "report" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Weekly Report</SectionTitle>
                    <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                          <Label>From</Label>
                          <input type="date" value={reportStartDate} onChange={e => setReportStartDate(e.target.value)}
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                        <div>
                          <Label>To</Label>
                          <input type="date" value={reportEndDate} onChange={e => setReportEndDate(e.target.value)}
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {[
                          { label: "This Week", fn: () => {
                            const t=new Date();
                            const daysBack=(t.getDay()+6)%7;
                            const s=new Date(t); s.setDate(t.getDate()-daysBack);
                            setReportStartDate(s.toISOString().split("T")[0]);
                            setReportEndDate(t.toISOString().split("T")[0]);
                          } },
                          { label: "Last Week", fn: () => {
                            const t=new Date();
                            const daysBack=(t.getDay()+6)%7;
                            const s=new Date(t); s.setDate(t.getDate()-daysBack-7);
                            const e=new Date(t); e.setDate(t.getDate()-daysBack-1);
                            setReportStartDate(s.toISOString().split("T")[0]);
                            setReportEndDate(e.toISOString().split("T")[0]);
                          } },
                          { label: "Last 30 Days", fn: () => { const t=new Date(); const s=new Date(t); s.setDate(t.getDate()-30); setReportStartDate(s.toISOString().split("T")[0]); setReportEndDate(t.toISOString().split("T")[0]); } },
                          { label: "This Month", fn: () => { const t=new Date(); setReportStartDate(new Date(t.getFullYear(),t.getMonth(),1).toISOString().split("T")[0]); setReportEndDate(t.toISOString().split("T")[0]); } },
                        ].map(({ label, fn }) => (
                          <button key={label} type="button" onClick={fn}
                            style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Nunito', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => fetchReport(reportStartDate, reportEndDate)} disabled={reportLoading}
                        style={{ padding: "10px 24px", borderRadius: 14, border: "none", background: "#199c2e", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", width: "fit-content" }}>
                        {reportLoading ? "Loading..." : "📊 Generate Report"}
                      </button>
                    </div>
                    {reportData ? (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                            {reportData.startDate} → {reportData.endDate} &nbsp;|&nbsp; {reportData.totalRows} signing{reportData.totalRows !== 1 ? "s" : ""} &nbsp;|&nbsp; <strong style={{ color: "#166534" }}>${reportData.totalEarned.toLocaleString()} total</strong>
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              disabled={reportPdfLoading || reportData.totalRows === 0}
                              onClick={async () => {
                                setReportPdfLoading(true);
                                try {
                                  const r = await fetch("/.netlify/functions/generate-weekly-report-pdf", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ reportData }),
                                  });
                                  const d = await r.json();
                                  if (!r.ok || !d.ok || !d.base64) {
                                    alert("PDF generation failed: " + (d.error || "unknown error") + (d.detail ? "\n\n" + d.detail : ""));
                                    return;
                                  }
                                  // Convert base64 to blob and trigger download
                                  const binaryString = atob(d.base64);
                                  const bytes = new Uint8Array(binaryString.length);
                                  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
                                  const blob = new Blob([bytes], { type: "application/pdf" });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement("a");
                                  a.href = url;
                                  a.download = `weekly-report-${reportData.startDate}-to-${reportData.endDate}.pdf`;
                                  document.body.appendChild(a);
                                  a.click();
                                  document.body.removeChild(a);
                                  URL.revokeObjectURL(url);
                                } catch (e) {
                                  alert("PDF download error: " + (e.message || e));
                                } finally {
                                  setReportPdfLoading(false);
                                }
                              }}
                              style={{ padding: "8px 18px", borderRadius: 10, border: (reportPdfLoading || reportData.totalRows === 0) ? "1px solid #d1d5db" : "1px solid #0a0a0a", background: (reportPdfLoading || reportData.totalRows === 0) ? "#f3f4f6" : "#0a0a0a", color: (reportPdfLoading || reportData.totalRows === 0) ? "#9ca3af" : "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: (reportPdfLoading || reportData.totalRows === 0) ? "not-allowed" : "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                              {reportPdfLoading ? "Generating..." : "📄 Download PDF"}
                            </button>
                            {/* Email PDF — opens a small modal with recipient picker (office or custom). */}
                            <button
                              type="button"
                              disabled={reportPdfLoading || reportData.totalRows === 0}
                              onClick={() => setReportEmailModal({ to: "" })}
                              style={{ padding: "8px 18px", borderRadius: 10, border: (reportPdfLoading || reportData.totalRows === 0) ? "1px solid #d1d5db" : "1px solid #166534", background: (reportPdfLoading || reportData.totalRows === 0) ? "#f3f4f6" : "#fff", color: (reportPdfLoading || reportData.totalRows === 0) ? "#9ca3af" : "#166534", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: (reportPdfLoading || reportData.totalRows === 0) ? "not-allowed" : "pointer", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                              📧 Email PDF
                            </button>
                          </div>
                        </div>
                        {reportData.claimsError ? <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>⚠️ Claims error: {reportData.claimsError}</div> : null}
                        {reportData.inspError ? <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>⚠️ Inspections error: {reportData.inspError}</div> : null}
                        {/* Grid columns: when PA forms are disabled, drop the LOR
                            and PA columns since they'd always be ○. Earned column
                            stays but rows with $0 render blank instead of "$0". */}
                        <div style={{ display: "grid", gridTemplateColumns: PA_FORMS_DISABLED ? "1fr 40px 64px" : "1fr 40px 40px 40px 64px", gap: 8, padding: "6px 12px", background: "#f3f4f6", borderRadius: 8, marginBottom: 8, fontSize: 11, fontWeight: 700, color: "#6b7280", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                          <div>Homeowner</div>
                          <div style={{ textAlign: "center" }}>Insp</div>
                          {!PA_FORMS_DISABLED && <div style={{ textAlign: "center" }}>LOR</div>}
                          {!PA_FORMS_DISABLED && <div style={{ textAlign: "center" }}>PA</div>}
                          <div style={{ textAlign: "right" }}>Earned</div>
                        </div>
                        {Object.keys(reportData.byRep).sort((a,b) => reportData.repTotals[b] - reportData.repTotals[a]).map(rep => (
                          <div key={rep} style={{ marginBottom: 16 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontFamily: "'Oswald', sans-serif", padding: "8px 12px", background: "#e0f2fe", borderRadius: 10, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                              <span>👤 {rep}</span>
                              <span style={{ fontSize: 12, color: "#0369a1" }}>
                                {reportData.byRep[rep].length} signing{reportData.byRep[rep].length !== 1 ? "s" : ""}
                                {reportData.repTotals[rep] > 0 ? <> · <strong>${reportData.repTotals[rep].toLocaleString()}</strong></> : null}
                              </span>
                            </div>
                            {reportData.byRep[rep].map((s, i) => {
                              const renderCheck = (status, signedAtHint) => {
                                if (status === "current") return <span style={{ color: "#16a34a", fontSize: 18, fontWeight: 700 }}>✅</span>;
                                if (status === "prior")   return <span style={{ color: "#9ca3af", fontSize: 18 }} title={signedAtHint ? "Signed " + new Date(signedAtHint).toLocaleDateString() : "Signed previously"}>✅</span>;
                                return <span style={{ color: "#d1d5db", fontSize: 16 }}>○</span>;
                              };
                              // Cancelled rows get a faded look, a red CANCELLED tag,
                              // and $0 in the earned column. The row stays visible so
                              // the rep can see what was lost — totals already excluded
                              // it via earned=0 at calc time, so this is purely visual.
                              const rowBg = s.cancelled
                                ? (i % 2 === 0 ? "#fef2f2" : "#fee2e2")
                                : (i % 2 === 0 ? "#fff" : "#f9fafb");
                              const rowOpacity = s.cancelled ? 0.78 : 1;
                              return (
                                <div key={i} style={{ display: "grid", gridTemplateColumns: PA_FORMS_DISABLED ? "1fr 40px 64px" : "1fr 40px 40px 40px 64px", gap: 8, padding: "8px 12px", background: rowBg, opacity: rowOpacity, borderRadius: 8, marginBottom: 4, alignItems: "center", border: s.cancelled ? "1px solid #fecaca" : "1px solid #f3f4f6" }}>
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", fontFamily: "'Nunito', sans-serif", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                      <span style={s.cancelled ? { textDecoration: "line-through", color: "#6b7280" } : null}>{s.name}</span>
                                      {s.cancelled ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#dc2626", color: "#fff", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em" }}>CANCELLED</span> : null}
                                    </div>
                                    <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>{s.address}</div>
                                    <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif" }}>
                                      {s.signedAt ? new Date(s.signedAt).toLocaleString() : ""}
                                      {s.inspStatus === "prior" && s.inspSignedAt ? ` · Insp signed ${new Date(s.inspSignedAt).toLocaleDateString()}` : ""}
                                      {s.cancelled && s.cancelledAt ? ` · Cancelled ${new Date(s.cancelledAt).toLocaleDateString()}` : ""}
                                    </div>
                                  </div>
                                  <div style={{ textAlign: "center" }}>{renderCheck(s.inspStatus, s.inspSignedAt)}</div>
                                  {!PA_FORMS_DISABLED && <div style={{ textAlign: "center" }}>{renderCheck(s.lorStatus)}</div>}
                                  {!PA_FORMS_DISABLED && <div style={{ textAlign: "center" }}>{renderCheck(s.pacStatus)}</div>}
                                  <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: "#166534", fontFamily: "'Nunito', sans-serif" }}>
                                    {s.earned > 0 ? `$${s.earned}` : ""}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                        <div style={{ marginTop: 12, padding: "10px 14px", background: "#f9fafb", borderRadius: 8, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                          <div><span style={{ color: "#16a34a", fontWeight: 700 }}>✅</span> signed this period</div>
                          <div><span style={{ color: "#9ca3af" }}>✅</span> signed previously</div>
                          <div><span style={{ color: "#d1d5db" }}>○</span> not yet signed</div>
                          <div style={{ marginLeft: "auto" }}>
                            {PA_FORMS_DISABLED ? "William Hernandez: $150 per free inspection" : "Insp $100 · LOR+PA $150 · All 3 $250"}
                          </div>
                        </div>
                        {Object.keys(reportData.byRep).length === 0 ? (
                          <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af", fontFamily: "'Nunito', sans-serif", fontSize: 15 }}>No signings recorded this period.</div>
                        ) : null}
                      </div>
                    ) : null}
                  </Card>}
                  {managerSection === "analytics" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Submission Analytics</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginBottom: 16 }}>
                      Inspection submissions by sales rep, based on when the homeowner signed. Avg days measures time from signing to inspection result.
                    </div>
                    <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                          <Label>From (signed date)</Label>
                          <input type="date" value={analyticsStart} onChange={e => setAnalyticsStart(e.target.value)}
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                        <div>
                          <Label>To (signed date)</Label>
                          <input type="date" value={analyticsEnd} onChange={e => setAnalyticsEnd(e.target.value)}
                            style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {[
                          { label: "Last 7 Days", fn: () => { const t=new Date(); const s=new Date(t); s.setDate(t.getDate()-7); setAnalyticsStart(s.toISOString().split("T")[0]); setAnalyticsEnd(t.toISOString().split("T")[0]); } },
                          { label: "Last 30 Days", fn: () => { const t=new Date(); const s=new Date(t); s.setDate(t.getDate()-30); setAnalyticsStart(s.toISOString().split("T")[0]); setAnalyticsEnd(t.toISOString().split("T")[0]); } },
                          { label: "This Month", fn: () => { const t=new Date(); setAnalyticsStart(new Date(t.getFullYear(),t.getMonth(),1).toISOString().split("T")[0]); setAnalyticsEnd(t.toISOString().split("T")[0]); } },
                          { label: "Last Month", fn: () => { const t=new Date(); const s=new Date(t.getFullYear(),t.getMonth()-1,1); const e=new Date(t.getFullYear(),t.getMonth(),0); setAnalyticsStart(s.toISOString().split("T")[0]); setAnalyticsEnd(e.toISOString().split("T")[0]); } },
                          { label: "All Time", fn: () => { setAnalyticsStart("2024-01-01"); setAnalyticsEnd(new Date().toISOString().split("T")[0]); } },
                        ].map(({ label, fn }) => (
                          <button key={label} type="button" onClick={fn}
                            style={{ padding: "6px 14px", borderRadius: 20, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Nunito', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => fetchAnalytics(analyticsStart, analyticsEnd)} disabled={analyticsLoading}
                        style={{ padding: "10px 24px", borderRadius: 14, border: "none", background: "#0a0a0a", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", width: "fit-content" }}>
                        {analyticsLoading ? "Loading..." : "📈 Generate Analytics"}
                      </button>
                    </div>

                    {analyticsData?.error ? (
                      <div style={{ padding: 14, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, color: "#991b1b", fontSize: 13, fontFamily: "'Nunito', sans-serif" }}>
                        ❌ {analyticsData.error}
                      </div>
                    ) : null}

                    {analyticsData && !analyticsData.error ? (
                      <div>
                        <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginBottom: 12 }}>
                          {analyticsData.startDate} → {analyticsData.endDate} &nbsp;|&nbsp; <strong style={{ color: "#111827" }}>{analyticsData.total} submission{analyticsData.total !== 1 ? "s" : ""}</strong>
                        </div>

                        {/* Company-wide summary card */}
                        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                          <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 10 }}>Company-wide</div>
                          <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", marginBottom: 10 }}>
                            Damage / No Damage / Retail percentages are of <strong>{analyticsData.resulted}</strong> resulted inspection{analyticsData.resulted !== 1 ? "s" : ""} · Pending is of <strong>{analyticsData.total}</strong> total submitted
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
                            {[
                              { label: "Damage",     count: analyticsData.counts.damage,    pct: analyticsData.pct.damage,    denom: analyticsData.resulted, bg: "#fef2f2", color: "#dc2626" },
                              { label: "No Damage",  count: analyticsData.counts.no_damage, pct: analyticsData.pct.no_damage, denom: analyticsData.resulted, bg: "#f0fdf4", color: "#199c2e" },
                              { label: "Retail",     count: analyticsData.counts.retail,    pct: analyticsData.pct.retail,    denom: analyticsData.resulted, bg: "#fff7ed", color: "#d97706" },
                              { label: "Pending",    count: analyticsData.counts.pending,   pct: analyticsData.pct.pending,   denom: analyticsData.total,    bg: "#f3f4f6", color: "#6b7280" },
                            ].map(c => (
                              <div key={c.label} style={{ background: c.bg, borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
                                <div style={{ fontSize: 22, fontWeight: 700, color: c.color, fontFamily: "'Oswald', sans-serif" }}>{c.pct}%</div>
                                <div style={{ fontSize: 11, color: c.color, fontFamily: "'Nunito', sans-serif", fontWeight: 700 }}>{c.label}</div>
                                <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>{c.count} of {c.denom}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div style={{ background: "#eef2ff", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
                              <div style={{ fontSize: 22, fontWeight: 700, color: "#0a0a0a", fontFamily: "'Oswald', sans-serif" }}>{analyticsData.meanDays !== null ? analyticsData.meanDays.toFixed(1) : "—"}</div>
                              <div style={{ fontSize: 11, color: "#0a0a0a", fontFamily: "'Nunito', sans-serif", fontWeight: 700 }}>Avg Days to Inspection</div>
                              <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>mean</div>
                            </div>
                            <div style={{ background: "#eef2ff", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
                              <div style={{ fontSize: 22, fontWeight: 700, color: "#0a0a0a", fontFamily: "'Oswald', sans-serif" }}>{analyticsData.medianDays !== null ? analyticsData.medianDays.toFixed(1) : "—"}</div>
                              <div style={{ fontSize: 11, color: "#0a0a0a", fontFamily: "'Nunito', sans-serif", fontWeight: 700 }}>Median Days</div>
                              <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>half above, half below</div>
                            </div>
                          </div>
                        </div>

                        {/* Per-rep breakdown */}
                        <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 8 }}>By Rep (active only)</div>
                        {analyticsData.byRep.length === 0 ? (
                          <div style={{ padding: "24px 0", textAlign: "center", color: "#9ca3af", fontFamily: "'Nunito', sans-serif", fontSize: 15 }}>No submissions in this date range.</div>
                        ) : (
                          <div style={{ display: "grid", gap: 8 }}>
                            {/* Header row */}
                            <div style={{ display: "grid", gridTemplateColumns: "2fr 0.7fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr", gap: 8, padding: "8px 12px", background: "#f3f4f6", borderRadius: 8, fontSize: 11, fontWeight: 700, color: "#6b7280", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                              <div>Rep</div>
                              <div style={{ textAlign: "right" }}>Total</div>
                              <div style={{ textAlign: "center" }}>Damage</div>
                              <div style={{ textAlign: "center" }}>No Dmg</div>
                              <div style={{ textAlign: "center" }}>Retail</div>
                              <div style={{ textAlign: "center" }}>Pending</div>
                              <div style={{ textAlign: "right" }}>Avg Days</div>
                              <div style={{ textAlign: "right" }}>Median</div>
                            </div>
                            {analyticsData.byRep.map(b => (
                              <div key={b.rep} style={{ display: "grid", gridTemplateColumns: "2fr 0.7fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr", gap: 8, padding: "10px 12px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, alignItems: "center", fontSize: 13, fontFamily: "'Nunito', sans-serif" }}>
                                <div style={{ fontWeight: 700, color: "#111827" }}>{b.rep}</div>
                                <div style={{ textAlign: "right", fontWeight: 700, color: "#111827" }}>{b.total}</div>
                                <div style={{ textAlign: "center" }}>
                                  <div style={{ color: "#dc2626", fontWeight: 700 }}>{b.damagePct}%</div>
                                  <div style={{ fontSize: 10, color: "#9ca3af" }}>{b.damage}</div>
                                </div>
                                <div style={{ textAlign: "center" }}>
                                  <div style={{ color: "#199c2e", fontWeight: 700 }}>{b.noDamagePct}%</div>
                                  <div style={{ fontSize: 10, color: "#9ca3af" }}>{b.no_damage}</div>
                                </div>
                                <div style={{ textAlign: "center" }}>
                                  <div style={{ color: "#d97706", fontWeight: 700 }}>{b.retailPct}%</div>
                                  <div style={{ fontSize: 10, color: "#9ca3af" }}>{b.retail}</div>
                                </div>
                                <div style={{ textAlign: "center" }}>
                                  <div style={{ color: "#6b7280", fontWeight: 700 }}>{b.pendingPct}%</div>
                                  <div style={{ fontSize: 10, color: "#9ca3af" }}>{b.pending}</div>
                                </div>
                                <div style={{ textAlign: "right", color: "#0a0a0a", fontWeight: 700 }}>
                                  {b.meanDays !== null ? b.meanDays.toFixed(1) : "—"}
                                </div>
                                <div style={{ textAlign: "right", color: "#0a0a0a", fontWeight: 700 }}>
                                  {b.medianDays !== null ? b.medianDays.toFixed(1) : "—"}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </Card>}

                  {/* ── Browse All Records — paginated full-list audit tool ─────── */}
                  {managerSection === "browseall" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Browse All Records</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14, fontFamily: "'Nunito', sans-serif" }}>
                      Step through every inspection in the system. Click ✏️ Edit on any record to fix data. Use filters to narrow what you see.
                    </div>

                    {/* Top controls: load / status filter / sort / search */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                      <button type="button"
                        onClick={async () => {
                          setBrowseAllLoading(true);
                          setBrowseAllPage(0);
                          try {
                            const { data, error } = await supabase
                              .from("inspections")
                              .select("id, client_name, address, city, state, zip, mobile, email, sales_rep_name, sales_rep_id, signed_at, result, result_at, docs_signed, jn_job_id, cancelled_at, jn_status, signed_pdfs")
                              .order("signed_at", { ascending: false })
                              .limit(2000);
                            if (error) throw error;

                            // Enrich with claim docs_signed via zip lookup
                            const zips = [...new Set((data || []).map(r => (r.zip || "").trim()).filter(Boolean))];
                            const claimsByKey = new Map();
                            if (zips.length > 0) {
                              const { data: claims } = await supabase
                                .from("claims")
                                .select("homeowner1, address, zip, docs_signed")
                                .in("zip", zips);
                              for (const c of claims || []) {
                                const z = (c.zip || "").trim();
                                if (!z) continue;
                                const street = (c.address || "").toLowerCase().trim().split(",")[0].replace(/\s+/g, " ").trim();
                                const num = (street.match(/^\d+/) || [""])[0];
                                claimsByKey.set(`${z}|${street}`, c.docs_signed || "");
                                if (num) {
                                  const numKey = `${z}|num:${num}`;
                                  if (!claimsByKey.has(numKey)) claimsByKey.set(numKey, c.docs_signed || "");
                                }
                                const ln = ((c.homeowner1 || "").trim().split(/\s+/).pop() || "").toLowerCase();
                                if (ln) {
                                  const nk = `${z}|name:${ln}`;
                                  if (!claimsByKey.has(nk)) claimsByKey.set(nk, c.docs_signed || "");
                                }
                              }
                            }
                            const enriched = (data || []).map(r => {
                              const z = (r.zip || "").trim();
                              const street = (r.address || "").toLowerCase().trim().split(",")[0].replace(/\s+/g, " ").trim();
                              const num = (street.match(/^\d+/) || [""])[0];
                              const ln = ((r.client_name || "").trim().split(/\s+/).pop() || "").toLowerCase();
                              let claimDocs = claimsByKey.get(`${z}|${street}`);
                              if (!claimDocs && num) claimDocs = claimsByKey.get(`${z}|num:${num}`);
                              if (!claimDocs && ln)  claimDocs = claimsByKey.get(`${z}|name:${ln}`);
                              const combined = [r.docs_signed || "", claimDocs || ""].join(",").toLowerCase();
                              // signed_pdfs is authoritative — if a PDF was archived for this doc type,
                              // then it was signed (regardless of what docs_signed columns say).
                              // This handles older rows where docs_signed may not have been populated reliably.
                              const sp = r.signed_pdfs || {};
                              return { ...r, _docs: {
                                insp: combined.includes("insp") || !!sp.insp,
                                lor:  combined.includes("lor")  || !!sp.lor,
                                pac:  combined.includes("pac")  || !!sp.pac || !!sp.pa,
                              } };
                            });
                            setBrowseAllRows(enriched);
                          } catch (e) {
                            alert("Could not load: " + (e.message || e));
                          } finally {
                            setBrowseAllLoading(false);
                          }
                        }}
                        style={{ padding: "10px 18px", borderRadius: 12, border: "2px solid #0a0a0a", background: "#0a0a0a", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        🔄 {browseAllRows.length > 0 ? "Reload All" : "Load All Records"}
                      </button>

                      <select value={browseAllStatus} onChange={(e) => { setBrowseAllStatus(e.target.value); setBrowseAllPage(0); }}
                        style={{ height: 40, padding: "0 12px", borderRadius: 12, border: "1.5px solid #d1d5db", fontSize: 13, fontFamily: "'Nunito', sans-serif", background: "#fff" }}>
                        <option value="all">All statuses</option>
                        <option value="pending">⏳ Pending only</option>
                        <option value="resulted">✓ Resulted only</option>
                        <option value="cancelled">❌ Cancelled only</option>
                        <option value="no_jn">⚠️ Missing JN link</option>
                        <option value="no_result">⏳ No result + no cancel</option>
                      </select>

                      <select value={browseAllSort} onChange={(e) => { setBrowseAllSort(e.target.value); setBrowseAllPage(0); }}
                        style={{ height: 40, padding: "0 12px", borderRadius: 12, border: "1.5px solid #d1d5db", fontSize: 13, fontFamily: "'Nunito', sans-serif", background: "#fff" }}>
                        <option value="signed_at_desc">Newest first</option>
                        <option value="signed_at_asc">Oldest first</option>
                        <option value="name_asc">Name A→Z</option>
                      </select>

                      <input type="text" value={browseAllSearch} onChange={(e) => { setBrowseAllSearch(e.target.value); setBrowseAllPage(0); }}
                        placeholder="Search name, address, zip, rep..."
                        style={{ flex: 1, minWidth: 200, height: 40, padding: "0 12px", borderRadius: 12, border: "1.5px solid #d1d5db", fontSize: 13, fontFamily: "'Nunito', sans-serif" }} />
                    </div>

                    {browseAllLoading ? (
                      <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>Loading all records...</div>
                    ) : browseAllRows.length === 0 ? (
                      <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                        Click "Load All Records" to begin.
                      </div>
                    ) : (() => {
                      // Apply filters in-memory
                      let filtered = browseAllRows.filter(r => {
                        if (browseAllStatus === "pending") return !r.result && !r.cancelled_at;
                        if (browseAllStatus === "resulted") return !!r.result;
                        if (browseAllStatus === "cancelled") return !!r.cancelled_at;
                        if (browseAllStatus === "no_jn") return !r.jn_job_id;
                        if (browseAllStatus === "no_result") return !r.result && !r.cancelled_at;
                        return true;
                      });
                      if (browseAllSearch && browseAllSearch.length >= 2) {
                        const q = browseAllSearch.toLowerCase();
                        filtered = filtered.filter(r => {
                          const hay = [r.client_name, r.address, r.city, r.zip, r.sales_rep_name].filter(Boolean).join(" ").toLowerCase();
                          return hay.includes(q);
                        });
                      }
                      filtered = [...filtered].sort((a, b) => {
                        if (browseAllSort === "name_asc") return (a.client_name || "").localeCompare(b.client_name || "");
                        const ta = a.signed_at ? new Date(a.signed_at).getTime() : 0;
                        const tb = b.signed_at ? new Date(b.signed_at).getTime() : 0;
                        return browseAllSort === "signed_at_asc" ? ta - tb : tb - ta;
                      });

                      const totalPages = Math.max(1, Math.ceil(filtered.length / browseAllPageSize));
                      const page = Math.min(browseAllPage, totalPages - 1);
                      const startIdx = page * browseAllPageSize;
                      const pageRows = filtered.slice(startIdx, startIdx + browseAllPageSize);

                      return (
                        <>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
                            <div style={{ fontSize: 13, color: "#374151", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                              Showing {startIdx + 1}–{Math.min(startIdx + browseAllPageSize, filtered.length)} of {filtered.length}
                              {browseAllSearch || browseAllStatus !== "all" ? ` (filtered from ${browseAllRows.length} total)` : ""}
                            </div>
                            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              {/* Download as CSV — exports a JN-reconciliation snapshot. Pulls fresh data from
                                  BOTH inspections and claims tables (the on-screen list only shows inspections,
                                  but for JN reconciliation the manager needs to see claim-only properties too).
                                  Cancelled rows are kept so they can be verified as cancelled in JN as well. */}
                              <button type="button"
                                onClick={async () => {
                                  // CSV-escape — wrap in quotes and double up internal quotes; convert null to empty string
                                  const csvCell = (v) => {
                                    if (v == null) return "";
                                    const s = String(v);
                                    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
                                    return s;
                                  };
                                  // Combine optional address parts so the column is paste-ready for JN search.
                                  const fullAddress = (street, city, state, zip) =>
                                    [street, city, state, zip].filter(Boolean).join(", ");

                                  try {
                                    // Pull fresh data from both tables in parallel — don't rely on the
                                    // currently-loaded browseAllRows (which is inspections-only).
                                    const [inspRes, claimRes] = await Promise.all([
                                      supabase
                                        .from("inspections")
                                        .select("client_name, address, city, state, zip, sales_rep_name, signed_at, result, cancelled_at, docs_signed, signed_pdfs")
                                        .order("signed_at", { ascending: false })
                                        .limit(5000),
                                      supabase
                                        .from("claims")
                                        .select("homeowner1, homeowner2, address, city, state, zip, sales_rep_name, signed_at, docs_signed")
                                        .order("signed_at", { ascending: false })
                                        .limit(5000),
                                    ]);
                                    if (inspRes.error) throw inspRes.error;
                                    if (claimRes.error) throw claimRes.error;

                                    // Project both shapes onto a unified CSV row.
                                    // Status derivation matches the on-screen pill logic.
                                    const inspectionStatus = (r) => {
                                      if (r.cancelled_at) return "cancelled";
                                      if (r.result === "damage") return "damage";
                                      if (r.result === "no_damage") return "no damage";
                                      if (r.result === "retail") return "retail";
                                      return "pending";
                                    };
                                    // For inspections, signed_pdfs is authoritative (an archived PDF means
                                    // it was signed even if docs_signed wasn't populated on older rows).
                                    const inspDocs = (r) => {
                                      const ds = (r.docs_signed || "").toLowerCase();
                                      const sp = r.signed_pdfs || {};
                                      return {
                                        insp: ds.includes("insp") || !!sp.insp,
                                        lor:  ds.includes("lor")  || !!sp.lor,
                                        pac:  ds.includes("pac")  || !!sp.pac || !!sp.pa,
                                      };
                                    };
                                    // Claims has no signed_pdfs / cancelled_at columns — read straight from docs_signed.
                                    const claimDocs = (r) => {
                                      const ds = (r.docs_signed || "").toLowerCase();
                                      return {
                                        insp: ds.includes("insp"),
                                        lor:  ds.includes("lor"),
                                        pac:  ds.includes("pac") || ds.includes("pa"),
                                      };
                                    };

                                    const inspRows = (inspRes.data || []).map(r => {
                                      const d = inspDocs(r);
                                      return {
                                        source: "inspection",
                                        homeowner: r.client_name || "",
                                        address: fullAddress(r.address, r.city, r.state, r.zip),
                                        rep: r.sales_rep_name || "",
                                        status: inspectionStatus(r),
                                        signed_at: r.signed_at,
                                        insp: d.insp ? "yes" : "no",
                                        lor:  d.lor  ? "yes" : "no",
                                        pac:  d.pac  ? "yes" : "no",
                                      };
                                    });
                                    const claimRows = (claimRes.data || []).map(r => {
                                      const d = claimDocs(r);
                                      // Claims uses homeowner1 + optional homeowner2 (joint signers).
                                      const homeowner = [r.homeowner1, r.homeowner2].filter(Boolean).join(" & ") || r.homeowner1 || "";
                                      return {
                                        source: "claim",
                                        homeowner,
                                        address: fullAddress(r.address, r.city, r.state, r.zip),
                                        rep: r.sales_rep_name || "",
                                        status: "signed", // claims rows don't carry a result/cancellation lifecycle
                                        signed_at: r.signed_at,
                                        insp: d.insp ? "yes" : "no",
                                        lor:  d.lor  ? "yes" : "no",
                                        pac:  d.pac  ? "yes" : "no",
                                      };
                                    });

                                    // Combine and sort by signed_at desc so the most recent records are at the top —
                                    // matches the default UI ordering. Empty signed_at (rare) sorts to the bottom.
                                    const combined = [...inspRows, ...claimRows].sort((a, b) => {
                                      const ta = a.signed_at ? Date.parse(a.signed_at) : 0;
                                      const tb = b.signed_at ? Date.parse(b.signed_at) : 0;
                                      return tb - ta;
                                    });

                                    const headers = ["source", "homeowner", "address", "rep", "status", "insp", "lor", "pac"];
                                    const lines = combined.map(r => [
                                      r.source, r.homeowner, r.address, r.rep, r.status,
                                      r.insp, r.lor, r.pac,
                                    ].map(csvCell).join(","));
                                    const csv = [headers.join(","), ...lines].join("\n");

                                    // Trigger download via blob URL
                                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = url;
                                    const dateStr = new Date().toISOString().split("T")[0];
                                    a.download = `jn-reconcile-${dateStr}.csv`;
                                    document.body.appendChild(a);
                                    a.click();
                                    document.body.removeChild(a);
                                    URL.revokeObjectURL(url);
                                  } catch (e) {
                                    alert("Could not export CSV: " + (e.message || e));
                                  }
                                }}
                                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #166534", background: "#f0fdf4", color: "#166534", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                                📥 Download CSV (JN Reconcile)
                              </button>
                              <button type="button" disabled={page === 0} onClick={() => setBrowseAllPage(p => Math.max(0, p - 1))}
                                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: page === 0 ? "#f3f4f6" : "#fff", color: page === 0 ? "#9ca3af" : "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: page === 0 ? "not-allowed" : "pointer" }}>← Prev</button>
                              <span style={{ fontSize: 13, color: "#374151", fontFamily: "'Nunito', sans-serif", padding: "0 8px" }}>Page {page + 1} of {totalPages}</span>
                              <button type="button" disabled={page >= totalPages - 1} onClick={() => setBrowseAllPage(p => Math.min(totalPages - 1, p + 1))}
                                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: page >= totalPages - 1 ? "#f3f4f6" : "#fff", color: page >= totalPages - 1 ? "#9ca3af" : "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: page >= totalPages - 1 ? "not-allowed" : "pointer" }}>Next →</button>
                            </div>
                          </div>

                          <div style={{ display: "grid", gap: 6 }}>
                            {pageRows.map((rec, idx) => {
                              const docs = rec._docs || { insp: false, lor: false, pac: false };
                              let pill = null;
                              if (rec.cancelled_at) {
                                pill = <span style={{ background: "#fef2f2", color: "#991b1b", borderRadius: 12, padding: "2px 9px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>❌ CANCELLED</span>;
                              } else if (rec.result === "damage") {
                                pill = <span style={{ background: "#fef2f2", color: "#dc2626", borderRadius: 12, padding: "2px 9px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>⚠️ DAMAGE</span>;
                              } else if (rec.result === "no_damage") {
                                pill = <span style={{ background: "#f0fdf4", color: "#166534", borderRadius: 12, padding: "2px 9px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>✅ NO DAMAGE</span>;
                              } else if (rec.result === "retail") {
                                pill = <span style={{ background: "#fff7ed", color: "#9a3412", borderRadius: 12, padding: "2px 9px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>🏠 RETAIL</span>;
                              } else {
                                pill = <span style={{ background: "#f3f4f6", color: "#374151", borderRadius: 12, padding: "2px 9px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>⏳ PENDING</span>;
                              }
                              return (
                                <div key={rec.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                                    <div style={{ flex: 1, minWidth: 240 }}>
                                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 2 }}>
                                        <span style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>#{startIdx + idx + 1}</span>
                                        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827" }}>{rec.client_name || "(no name)"}</span>
                                        {pill}
                                      </div>
                                      <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                                        {[rec.address, rec.city, rec.state, rec.zip].filter(Boolean).join(", ")}
                                      </div>
                                      <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", marginTop: 2 }}>
                                        Rep: {rec.sales_rep_name || "—"} · Signed: {rec.signed_at ? new Date(rec.signed_at).toLocaleDateString() : "—"}
                                        {rec.jn_job_id ? <span style={{ color: "#16a34a" }}> · ✓ JN</span> : <span style={{ color: "#dc2626" }}> · ⚠️ NO JN</span>}
                                      </div>
                                      <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: docs.insp ? "#dbeafe" : "#f3f4f6", color: docs.insp ? "#1e40af" : "#9ca3af", fontFamily: "'Oswald', sans-serif" }}>{docs.insp ? "✓" : "○"} INSP</span>
                                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: docs.lor ? "#dcfce7" : "#f3f4f6", color: docs.lor ? "#166534" : "#9ca3af", fontFamily: "'Oswald', sans-serif" }}>{docs.lor ? "✓" : "○"} LOR</span>
                                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: docs.pac ? "#dcfce7" : "#f3f4f6", color: docs.pac ? "#166534" : "#9ca3af", fontFamily: "'Oswald', sans-serif" }}>{docs.pac ? "✓" : "○"} PA</span>
                                        {rec.signed_pdfs?.insp ? <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: "#dcfce7", color: "#166534", fontFamily: "'Oswald', sans-serif" }}>📁 ARCHIVED</span> : null}
                                        {rec.jn_status && rec.jn_status !== "Needs Inspection" && rec.jn_status !== "New Lead" ? <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: "#fef2f2", color: "#991b1b", fontFamily: "'Oswald', sans-serif" }}>JN: {rec.jn_status}</span> : null}
                                      </div>
                                    </div>
                                    <button type="button"
                                      onClick={() => {
                                        setEditModal({
                                          rec,
                                          draft: {
                                            client_name: rec.client_name || "",
                                            address: rec.address || "",
                                            city: rec.city || "",
                                            state: rec.state || "",
                                            zip: rec.zip || "",
                                            mobile: rec.mobile || "",
                                            email: rec.email || "",
                                            sales_rep_name: rec.sales_rep_name || "",
                                            sales_rep_id: rec.sales_rep_id || "",
                                            jn_job_id: rec.jn_job_id || "",
                                            result: rec.result || "",
                                          },
                                        });
                                      }}
                                      style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #6b7280", background: "#fff", color: "#374151", fontSize: 11, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer", whiteSpace: "nowrap" }}>
                                      ✏️ Edit
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {totalPages > 1 ? (
                            <div style={{ display: "flex", justifyContent: "center", gap: 6, alignItems: "center", marginTop: 16 }}>
                              <button type="button" disabled={page === 0} onClick={() => setBrowseAllPage(p => Math.max(0, p - 1))}
                                style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: page === 0 ? "#f3f4f6" : "#fff", color: page === 0 ? "#9ca3af" : "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: page === 0 ? "not-allowed" : "pointer" }}>← Prev</button>
                              <span style={{ fontSize: 13, color: "#374151", fontFamily: "'Nunito', sans-serif", padding: "0 12px" }}>Page {page + 1} of {totalPages}</span>
                              <button type="button" disabled={page >= totalPages - 1} onClick={() => setBrowseAllPage(p => Math.min(totalPages - 1, p + 1))}
                                style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: page >= totalPages - 1 ? "#f3f4f6" : "#fff", color: page >= totalPages - 1 ? "#9ca3af" : "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: page >= totalPages - 1 ? "not-allowed" : "pointer" }}>Next →</button>
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </Card>}

                  {/* ── Find Duplicates — manager dedupe tool ─────────────────── */}
                  {managerSection === "dupes" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Find Duplicates</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14, fontFamily: "'Nunito', sans-serif" }}>
                      Scans BOTH the inspections and claims tables and groups records by property address + zip. Any group with multiple rows is a likely duplicate. Pick which one to KEEP — the others will be permanently deleted. The "best" row is preselected automatically (inspection rows preferred over claim rows; JN-linked rows preferred over un-linked).
                    </div>

                    <button type="button"
                      onClick={async () => {
                        setDupeLoading(true);
                        try {
                          // Pull both tables in parallel. Each row gets tagged with
                          // _table so the merge step knows where to route updates/deletes.
                          // Note: claims has no cancelled_at column — every claim row counts.
                          const [inspRes, claimRes] = await Promise.all([
                            supabase
                              .from("inspections")
                              .select("id, client_name, address, city, state, zip, mobile, email, sales_rep_name, sales_rep_id, signed_at, result, result_at, jn_job_id, signed_pdfs, docs_signed, jn_status")
                              .is("cancelled_at", null)
                              .order("signed_at", { ascending: false })
                              .limit(5000),
                            supabase
                              .from("claims")
                              .select("id, homeowner1, homeowner2, phone, homeowner_email, address, city, state, zip, signed_at, sales_rep_name, sales_rep_id, sales_rep_email, docs_signed")
                              .order("signed_at", { ascending: false })
                              .limit(5000),
                          ]);
                          if (inspRes.error) throw inspRes.error;
                          if (claimRes.error) throw claimRes.error;

                          // Normalize claims to a unified row shape so the rest of the
                          // tool (UI rendering, scoring, merge logic) doesn't need to
                          // care which table a row came from. Any claims-only fields
                          // we want to preserve are stashed under _claim.* for the merge step.
                          // Normalize id to string for app-side use (rendering,
                          // .slice, === comparisons, React keys) but keep the raw
                          // DB-typed value under _rawId so merge-step DB calls send
                          // the right wire type. inspections.id is uuid (string),
                          // claims.id is bigint (JS number) — supabase-js's .in()
                          // filter against a bigint column doesn't reliably accept
                          // string-coerced numbers, so we hand it back its native type.
                          const inspRows = (inspRes.data || []).map(r => ({
                            ...r,
                            id: String(r.id),
                            _rawId: r.id,
                            _table: "inspections",
                          }));
                          const claimRows = (claimRes.data || []).map(r => ({
                            _table: "claims",
                            id: String(r.id),
                            _rawId: r.id,
                            // Project claims fields onto the unified shape used by the UI:
                            client_name: [r.homeowner1, r.homeowner2].filter(Boolean).join(" & ") || r.homeowner1 || "",
                            address: r.address,
                            city: r.city,
                            state: r.state,
                            zip: r.zip,
                            mobile: r.phone || "",
                            email: r.homeowner_email || "",
                            sales_rep_name: r.sales_rep_name,
                            sales_rep_id: r.sales_rep_id,
                            signed_at: r.signed_at,
                            docs_signed: r.docs_signed,
                            // claims has no jn_job_id / signed_pdfs / result — leave undefined
                            // so badges & scoring naturally treat them as missing.
                            _claim: {
                              homeowner1: r.homeowner1,
                              homeowner2: r.homeowner2,
                              phone: r.phone,
                              homeowner_email: r.homeowner_email,
                              sales_rep_email: r.sales_rep_email,
                            },
                          }));

                          // Normalize aggressively so "2529 Clematis Street" and
                          // "2529 Clematis St" bucket together. Expand a known street-
                          // suffix abbreviation only when it appears as the LAST token
                          // of the street portion — this avoids mangling addresses
                          // like "St James Ave" or "Ave of the Americas". A trailing
                          // unit designator (Apt 5, #3, Unit B, Ste 200) is split off
                          // first so it doesn't hide the real suffix.
                          const SUFFIXES = [
                            ["st",   "street"],
                            ["ave",  "avenue"],
                            ["av",   "avenue"],
                            ["rd",   "road"],
                            ["blvd", "boulevard"],
                            ["dr",   "drive"],
                            ["ln",   "lane"],
                            ["ct",   "court"],
                            ["pl",   "place"],
                            ["ter",  "terrace"],
                            ["pkwy", "parkway"],
                            ["hwy",  "highway"],
                            ["cir",  "circle"],
                            ["trl",  "trail"],
                          ];
                          const norm = (s) => {
                            let v = (s || "").toLowerCase().trim().replace(/[.,]/g, "").replace(/\s+/g, " ");
                            const unitMatch = v.match(/\s+(apt|apartment|unit|ste|suite|#\S*)\b.*$/);
                            let unitPart = "";
                            if (unitMatch) {
                              unitPart = " " + v.slice(unitMatch.index).trim();
                              v = v.slice(0, unitMatch.index).trim();
                            }
                            const tokens = v.split(" ");
                            if (tokens.length >= 2) {
                              const last = tokens[tokens.length - 1];
                              const hit = SUFFIXES.find(([abbr]) => abbr === last);
                              if (hit) tokens[tokens.length - 1] = hit[1];
                            }
                            return (tokens.join(" ") + unitPart).trim();
                          };
                          const byKey = new Map();
                          for (const r of [...inspRows, ...claimRows]) {
                            const a = norm(r.address);
                            const z = (r.zip || "").trim();
                            if (!a) continue;
                            const key = z ? `${a}|${z}` : a;
                            if (!byKey.has(key)) byKey.set(key, []);
                            byKey.get(key).push(r);
                          }

                          const groups = [...byKey.entries()]
                            .filter(([_, rows]) => rows.length >= 2)
                            .map(([key, rows]) => {
                              // Score each row to pick the master. Inspections strongly
                              // preferred over claims when both exist for an address —
                              // inspections is the JN-synced table and carries the
                              // richer field set (jn_job_id, signed_pdfs, result).
                              // A claims master is only chosen when the group is claims-only.
                              const scored = rows.map(r => {
                                let score = 0;
                                if (r._table === "inspections") score += 50;  // table preference
                                if (r.jn_job_id) score += 100;                // JN link is decisive
                                if (r.result) score += 5;
                                if (r.signed_pdfs?.insp) score += 3;
                                if (r.email) score += 2;
                                if (r.mobile) score += 1;
                                return { ...r, _score: score };
                              });
                              scored.sort((a, b) => b._score - a._score);
                              return { key, rows: scored, masterId: scored[0].id };
                            })
                            .sort((a, b) => b.rows.length - a.rows.length);

                          setDupeGroups(groups);
                        } catch (e) {
                          alert("Could not load duplicates: " + (e.message || e));
                        } finally {
                          setDupeLoading(false);
                        }
                      }}
                      disabled={dupeLoading}
                      style={{ padding: "10px 18px", borderRadius: 12, border: "2px solid #0a0a0a", background: dupeLoading ? "#9ca3af" : "#0a0a0a", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: dupeLoading ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 16 }}>
                      {dupeLoading ? "Scanning..." : (dupeGroups.length > 0 ? "🔄 Re-scan" : "🔍 Scan for Duplicates")}
                    </button>

                    {dupeGroups.length === 0 && !dupeLoading ? (
                      <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                        Click "Scan for Duplicates" to find inspection and claim records sharing the same address.
                      </div>
                    ) : null}

                    {dupeGroups.length > 0 ? (
                      <>
                        <div style={{ fontSize: 13, color: "#0a0a0a", fontWeight: 700, marginBottom: 12, fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          Found {dupeGroups.length} duplicate {dupeGroups.length === 1 ? "group" : "groups"} ({dupeGroups.reduce((sum, g) => sum + g.rows.length - 1, 0)} extra records will be merged into the master)
                        </div>
                        <div style={{ background: "#dbeafe", border: "1px solid #1e40af", borderRadius: 8, padding: "10px 12px", marginBottom: 14, fontSize: 12, color: "#1e40af", fontFamily: "'Nunito', sans-serif", lineHeight: 1.5 }}>
                          <strong>How merging works:</strong> The 🌟 MASTER row is preserved (we recommend the JN-linked row so the app stays in sync with JobNimbus). Useful data from the other rows — signed PDFs, signed docs, result if missing, contact info — gets <strong>merged into the master</strong>. Then the duplicates are deleted. Nothing is lost; everything consolidates into one clean record.
                        </div>
                        <div style={{ display: "grid", gap: 14 }}>
                          {dupeGroups.map((group, gIdx) => {
                            const sample = group.rows[0];
                            return (
                              <div key={group.key} style={{ background: "#fff", border: "2px solid #fbbf24", borderRadius: 12, padding: "14px 16px" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                                  <div>
                                    <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#92400e" }}>
                                      🏠 {sample.address}{sample.city ? `, ${sample.city}` : ""} {sample.zip ? `· ${sample.zip}` : ""}
                                    </div>
                                    <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                                      {group.rows.length} records at this address
                                    </div>
                                  </div>
                                </div>

                                <div style={{ display: "grid", gap: 6 }}>
                                  {group.rows.map((rec) => {
                                    const isMaster = group.masterId === rec.id;
                                    return (
                                      <label key={`${rec._table}-${rec.id}`}
                                        style={{
                                          display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px",
                                          borderRadius: 8,
                                          border: isMaster ? "2px solid #1e40af" : "1px solid #e5e7eb",
                                          background: isMaster ? "#eff6ff" : "#fafafa",
                                          cursor: "pointer",
                                        }}>
                                        <input type="radio" name={`master-${gIdx}`} checked={isMaster}
                                          onChange={() => setDupeGroups(prev => prev.map((g, i) => i === gIdx ? { ...g, masterId: rec.id } : g))}
                                          style={{ marginTop: 4 }} />
                                        <div style={{ flex: 1 }}>
                                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827" }}>{rec.client_name || "(no name)"}</span>
                                            {rec._table === "inspections"
                                              ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#e0e7ff", color: "#3730a3", fontFamily: "'Oswald', sans-serif" }}>INSP</span>
                                              : <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#fce7f3", color: "#9d174d", fontFamily: "'Oswald', sans-serif" }}>CLAIM</span>}
                                            {isMaster ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#dbeafe", color: "#1e40af", fontFamily: "'Oswald', sans-serif" }}>🌟 MASTER</span> : <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#fef3c7", color: "#92400e", fontFamily: "'Oswald', sans-serif" }}>⮕ MERGE INTO MASTER</span>}
                                            {rec.jn_job_id ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#dcfce7", color: "#166534", fontFamily: "'Oswald', sans-serif" }}>JN ✓</span> : (rec._table === "inspections" ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#fef2f2", color: "#991b1b", fontFamily: "'Oswald', sans-serif" }}>NO JN</span> : null)}
                                            {rec.result ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#fff7ed", color: "#9a3412", fontFamily: "'Oswald', sans-serif" }}>{rec.result.toUpperCase()}</span> : null}
                                            {rec.signed_pdfs?.insp ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#dcfce7", color: "#166534", fontFamily: "'Oswald', sans-serif" }}>📁 INSP</span> : null}
                                            {rec.signed_pdfs?.lor ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#dcfce7", color: "#166534", fontFamily: "'Oswald', sans-serif" }}>📁 LOR</span> : null}
                                            {rec.signed_pdfs?.pac ? <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, fontWeight: 700, background: "#dcfce7", color: "#166534", fontFamily: "'Oswald', sans-serif" }}>📁 PA</span> : null}
                                          </div>
                                          <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginTop: 2 }}>
                                            Rep: {rec.sales_rep_name || "—"} · Signed: {rec.signed_at ? new Date(rec.signed_at).toLocaleString() : "—"}
                                            {rec.jn_job_id ? ` · JN: ${rec.jn_job_id.slice(0, 12)}...` : ""}
                                          </div>
                                          <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", marginTop: 1 }}>
                                            ID: {String(rec.id).slice(0, 8)}… · Score: {rec._score}
                                          </div>
                                        </div>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ position: "sticky", bottom: 0, marginTop: 18, paddingTop: 14, background: "#f8fafc", borderTop: "1px solid #e5e7eb" }}>
                          <button type="button"
                            disabled={dupeBusy}
                            onClick={async () => {
                              const totalToMerge = dupeGroups.reduce((sum, g) => sum + g.rows.length - 1, 0);
                              if (!confirm(`Merge ${totalToMerge} duplicate records into their masters?\n\nFor each group:\n  1. The 🌟 MASTER row will be UPDATED with the union of useful data from siblings (signed_pdfs, docs_signed, result, contact info if missing)\n  2. The ⮕ MERGE rows will then be permanently deleted\n\nThis cannot be undone.`)) return;

                              setDupeBusy(true);
                              try {
                                let mergedCount = 0;
                                let deletedCount = 0;

                                for (const g of dupeGroups) {
                                  // Master is identified by id alone in our state. UUID
                                  // collisions between tables are astronomically unlikely,
                                  // but we still match on (id + _table) at delete time.
                                  const master = g.rows.find(r => r.id === g.masterId);
                                  if (!master) continue;
                                  const siblings = g.rows.filter(r => r.id !== g.masterId);

                                  // ── Build the merged payload ────────────────────────
                                  // Column shape depends on the master's table:
                                  //   inspections: client_name, email, mobile, signed_pdfs, result, etc.
                                  //   claims:      homeowner1, homeowner2, homeowner_email, phone, etc.
                                  // We only write columns that exist on the master's table.
                                  const merged = {};
                                  const masterIsInsp = master._table === "inspections";

                                  // ── Union fields (apply to both tables) ─────────────
                                  // docs_signed — UNION across all rows.
                                  const docsSet = new Set();
                                  for (const r of g.rows) {
                                    (r.docs_signed || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).forEach(d => docsSet.add(d));
                                  }
                                  if (docsSet.size > 0) merged.docs_signed = [...docsSet].join(",");

                                  // signed_at — keep the EARLIEST date.
                                  const allDates = g.rows.map(r => r.signed_at).filter(Boolean).sort();
                                  if (allDates.length > 0 && allDates[0] !== master.signed_at) {
                                    merged.signed_at = allDates[0];
                                  }

                                  if (masterIsInsp) {
                                    // ── Master = inspection ──────────────────────────
                                    // signed_pdfs only exists on inspections, but only
                                    // inspection siblings will have one. claims siblings
                                    // contribute via docs_signed only.
                                    const sigPdfs = { ...(master.signed_pdfs || {}) };
                                    for (const sib of siblings) {
                                      if (sib._table === "inspections" && sib.signed_pdfs) {
                                        for (const [docKey, val] of Object.entries(sib.signed_pdfs)) {
                                          if (val && !sigPdfs[docKey]) sigPdfs[docKey] = val;
                                        }
                                      }
                                    }
                                    if (Object.keys(sigPdfs).length > 0) merged.signed_pdfs = sigPdfs;

                                    // result / result_at — only inspections have these.
                                    if (!master.result) {
                                      const sibWithResult = siblings.find(s => s._table === "inspections" && s.result);
                                      if (sibWithResult) {
                                        merged.result = sibWithResult.result;
                                        merged.result_at = sibWithResult.result_at;
                                      }
                                    }

                                    // Contact info — fill master's blanks. Inspection
                                    // siblings carry email/mobile; claim siblings carry
                                    // homeowner_email/phone (already projected into
                                    // .email/.mobile by the scanner).
                                    if (!master.email) {
                                      const sibWithEmail = siblings.find(s => s.email);
                                      if (sibWithEmail) merged.email = sibWithEmail.email;
                                    }
                                    if (!master.mobile) {
                                      const sibWithMobile = siblings.find(s => s.mobile);
                                      if (sibWithMobile) merged.mobile = sibWithMobile.mobile;
                                    }
                                    if (!master.client_name) {
                                      const sibWithName = siblings.find(s => s.client_name);
                                      if (sibWithName) merged.client_name = sibWithName.client_name;
                                    }
                                  } else {
                                    // ── Master = claim (group is claims-only) ────────
                                    // Fill homeowner1/2/phone/homeowner_email from sibling
                                    // claims using the original column names stashed in _claim.
                                    const masterClaim = master._claim || {};
                                    if (!masterClaim.homeowner1) {
                                      const sib = siblings.find(s => s._claim?.homeowner1);
                                      if (sib) merged.homeowner1 = sib._claim.homeowner1;
                                    }
                                    if (!masterClaim.homeowner2) {
                                      const sib = siblings.find(s => s._claim?.homeowner2);
                                      if (sib) merged.homeowner2 = sib._claim.homeowner2;
                                    }
                                    if (!masterClaim.phone) {
                                      const sib = siblings.find(s => s._claim?.phone);
                                      if (sib) merged.phone = sib._claim.phone;
                                    }
                                    if (!masterClaim.homeowner_email) {
                                      const sib = siblings.find(s => s._claim?.homeowner_email);
                                      if (sib) merged.homeowner_email = sib._claim.homeowner_email;
                                    }
                                  }

                                  // Apply the merge update if anything changed.
                                  // Use _rawId (DB-typed) for the .eq filter so a
                                  // bigint claims.id is sent as a number, not a string.
                                  if (Object.keys(merged).length > 0) {
                                    const { error: updateErr } = await supabase
                                      .from(master._table)
                                      .update(merged)
                                      .eq("id", master._rawId);
                                    if (updateErr) {
                                      console.error("Merge update failed for master", master.id, updateErr);
                                      throw new Error(`Merge failed for ${master.address}: ${updateErr.message}`);
                                    }
                                    mergedCount++;
                                  }

                                  // Delete the siblings — partitioned by their source
                                  // table. Use _rawId so .in() sends each value with
                                  // the wire type the DB column expects. We request
                                  // count: 'exact' so we can verify rows were actually
                                  // removed — RLS policies that block DELETE will
                                  // otherwise silently return 0 rows with no error.
                                  const sibsByTable = siblings.reduce((acc, s) => {
                                    (acc[s._table] = acc[s._table] || []).push(s._rawId);
                                    return acc;
                                  }, {});
                                  for (const [tbl, ids] of Object.entries(sibsByTable)) {
                                    if (ids.length === 0) continue;
                                    const { error: deleteErr, count } = await supabase
                                      .from(tbl)
                                      .delete({ count: "exact" })
                                      .in("id", ids);
                                    if (deleteErr) throw new Error(`Delete failed for ${master.address} (${tbl}): ${deleteErr.message}`);
                                    if ((count ?? 0) < ids.length) {
                                      throw new Error(
                                        `Delete returned ${count ?? 0} rows but expected ${ids.length} for ${master.address} (${tbl}).\n\n` +
                                        `This usually means a Row Level Security policy on the "${tbl}" table is blocking DELETE for the current user. ` +
                                        `Check Supabase → Authentication → Policies → ${tbl} and confirm a DELETE policy exists.`
                                      );
                                    }
                                    deletedCount += count ?? ids.length;
                                  }
                                }

                                alert(`✓ Merged ${mergedCount} groups, deleted ${deletedCount} duplicate records.\n\nApp and JobNimbus should now be in sync — every property has exactly one record, and that record carries the union of data from all duplicates.`);
                                setDupeGroups([]);
                              } catch (e) {
                                alert("Merge failed: " + (e.message || e) + "\n\nSome groups may have been merged before the error. Re-scan to see current state.");
                              } finally {
                                setDupeBusy(false);
                              }
                            }}
                            style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: dupeBusy ? "#9ca3af" : "#1e40af", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, cursor: dupeBusy ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {dupeBusy ? "Merging..." : `🔀 Merge ${dupeGroups.reduce((sum, g) => sum + g.rows.length - 1, 0)} Duplicate Records Into Masters`}
                          </button>
                        </div>
                      </>
                    ) : null}
                  </Card>}

                  {/* JN Inspection Report — manual generator + JN documents upload.
                      For homeowners pre-existing in JN that never went through the
                      app's signing flow but want to see the inspection report
                      before signing PA paperwork. */}
                  {managerSection === "jnreport" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>JN Inspection Report</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14, fontFamily: "'Nunito', sans-serif", lineHeight: 1.5 }}>
                      Generates an inspection report PDF (with photos pulled from JN) and uploads it directly to the JN job's <strong>Documents</strong> tab. Use this for homeowners who already exist in JN with an inspection result set, but never went through the app's signing flow. The rep can then send the PDF to the homeowner from inside JN.
                    </div>
                    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400e", fontFamily: "'Nunito', sans-serif" }}>
                      ⚠️ Requires the JN job to have an <strong>inspection result</strong> set (Damage / No Damage / Retail) and at least one photo attached. Otherwise the function will refuse.
                    </div>

                    <Label>JN Job ID</Label>
                    <input
                      type="text"
                      value={jnReportJnid}
                      onChange={(e) => setJnReportJnid(e.target.value)}
                      placeholder="e.g. mobwvrx48cjft7ah6t9a1nv"
                      disabled={jnReportSending}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      style={{ width: "100%", height: 44, borderRadius: 14, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "monospace", marginBottom: 6 }}
                    />
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16, fontFamily: "'Nunito', sans-serif" }}>
                      Find the JN job ID in the JN URL when viewing the job — the long string after <code>/jobs/</code>.
                    </div>

                    <button
                      type="button"
                      disabled={jnReportSending || !jnReportJnid.trim()}
                      onClick={async () => {
                        const jnid = jnReportJnid.trim();
                        if (!jnid) return;
                        if (!window.confirm(`Generate inspection report PDF and upload it to JN job ${jnid}?\n\nThis will pull photos from JN, render the report, and post it to the job's Documents tab.`)) return;
                        setJnReportSending(true);
                        try {
                          const r = await fetch("/.netlify/functions/generate-and-upload-insp-report", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ jnid }),
                          });
                          const txt = await r.text();
                          let d;
                          try { d = JSON.parse(txt); }
                          catch { d = { ok: false, error: "Non-JSON response: " + txt.slice(0, 200) }; }

                          if (!r.ok || !d.ok) {
                            alert("Report generation failed: " + (d.error || "unknown error") + (d.detail ? "\n\n" + d.detail : ""));
                            return;
                          }
                          alert(
                            `✅ Report uploaded to JN.\n\n` +
                            `Job: ${d.jobName || "—"}\n` +
                            `Homeowner: ${d.clientName || "—"}\n` +
                            `Result: ${d.result || "—"}\n` +
                            `Photos: ${d.photoCount}\n` +
                            `Filename: ${d.filename}\n\n` +
                            `Open the JN job's Documents tab to see it.`
                          );
                          setJnReportJnid("");
                        } catch (e) {
                          alert("Report generation error: " + (e.message || e));
                        } finally {
                          setJnReportSending(false);
                        }
                      }}
                      style={{
                        padding: "12px 24px", borderRadius: 12,
                        border: "none",
                        background: (jnReportSending || !jnReportJnid.trim()) ? "#9ca3af" : "#0a0a0a",
                        color: "#fff",
                        fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14,
                        cursor: (jnReportSending || !jnReportJnid.trim()) ? "not-allowed" : "pointer",
                        textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>
                      {jnReportSending ? "Generating & uploading..." : "📄 Generate & Upload to JN"}
                    </button>
                  </Card>}

                  {/* Bulk Inspection Reports — runs the per-job report
                      generator across every JN job with a chosen status.
                      Two-step UX: load candidates (fast list) → review →
                      kick off the background run. */}
                  {managerSection === "bulkreport" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <SectionTitle>Bulk Inspection Reports</SectionTitle>
                    <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14, fontFamily: "'Nunito', sans-serif", lineHeight: 1.5 }}>
                      Pick a status and we'll find every JN job with that inspection result. Click <strong>Load Candidates</strong> first to review the list before running anything. The real run uploads a PDF to each job's <strong>Documents</strong> tab in JN.
                    </div>
                    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#92400e", fontFamily: "'Nunito', sans-serif" }}>
                      ⚠️ Each report takes ~10–20 seconds. The bulk run uses a background job so you can close this page after starting — progress shows up in JN as PDFs get attached. Check back here and reload candidates to see how many remain.
                    </div>

                    <Label>Status</Label>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
                      {[
                        { key: "Damage", emoji: "⚠️", color: "#dc2626" },
                        { key: "No Damage", emoji: "✅", color: "#16a34a" },
                        { key: "Retail", emoji: "🏠", color: "#d97706" },
                      ].map(s => {
                        const active = bulkResult === s.key;
                        return (
                          <button key={s.key} type="button" onClick={() => { setBulkResult(s.key); setBulkCandidates(null); }}
                            style={{
                              padding: "12px 10px", borderRadius: 12,
                              border: active ? `3px solid ${s.color}` : "1.5px solid #d1d5db",
                              background: active ? "#fff" : "#fff",
                              boxShadow: active ? `0 4px 12px ${s.color}33` : "none",
                              cursor: "pointer", fontFamily: "'Oswald', sans-serif",
                              fontWeight: 700, fontSize: 13, color: active ? s.color : "#374151",
                              textTransform: "uppercase", letterSpacing: "0.04em",
                            }}>
                            {s.emoji} {s.key}
                          </button>
                        );
                      })}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                      <div>
                        <Label>Date range</Label>
                        <select value={bulkSinceDays} onChange={(e) => { setBulkSinceDays(+e.target.value); setBulkCandidates(null); }}
                          style={{ width: "100%", height: 44, borderRadius: 12, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, background: "#fff" }}>
                          <option value={7}>Last 7 days</option>
                          <option value={30}>Last 30 days</option>
                          <option value={90}>Last 90 days</option>
                          <option value={365}>Last year</option>
                          <option value={0}>All time</option>
                        </select>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 8 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#374151", fontFamily: "'Nunito', sans-serif", cursor: "pointer" }}>
                          <input type="checkbox" checked={bulkSkipExisting}
                            onChange={(e) => { setBulkSkipExisting(e.target.checked); setBulkCandidates(null); }} />
                          Skip jobs that already have an Inspection-Report-*.pdf
                        </label>
                      </div>
                    </div>

                    <button type="button"
                      disabled={bulkLoading}
                      onClick={async () => {
                        setBulkLoading(true);
                        setBulkCandidates(null);
                        try {
                          const r = await fetch("/.netlify/functions/bulk-list-insp-report-candidates", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ result: bulkResult, sinceDays: bulkSinceDays, skipExisting: bulkSkipExisting }),
                          });
                          const txt = await r.text();
                          let d;
                          try { d = JSON.parse(txt); } catch { d = { ok: false, error: "Non-JSON: " + txt.slice(0, 200) }; }
                          if (!r.ok || !d.ok) {
                            alert("Could not load candidates: " + (d.error || "unknown"));
                            return;
                          }
                          setBulkCandidates(d.candidates || []);
                        } catch (e) {
                          alert("Could not load candidates: " + (e.message || e));
                        } finally {
                          setBulkLoading(false);
                        }
                      }}
                      style={{
                        padding: "12px 24px", borderRadius: 12, border: "none",
                        background: bulkLoading ? "#9ca3af" : "#0a0a0a",
                        color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14,
                        cursor: bulkLoading ? "not-allowed" : "pointer",
                        textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>
                      {bulkLoading ? "Loading..." : "🔍 Load Candidates"}
                    </button>

                    {bulkCandidates !== null ? (
                      <div style={{ marginTop: 18 }}>
                        {(() => {
                          const eligible = bulkCandidates.filter(c => c.photoCount > 0 && !c.hasExistingReport);
                          const noPhotos = bulkCandidates.filter(c => c.photoCount === 0);
                          const existing = bulkCandidates.filter(c => c.photoCount > 0 && c.hasExistingReport);
                          // Count distinct addresses with more than one matching JN job —
                          // each such cluster is one "possible dupe group" worth flagging.
                          const dupeNorm = (s) => String(s || "").toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
                          const dupeAddrCounts = bulkCandidates.reduce((m, c) => {
                            const a = dupeNorm(c.address);
                            if (a) m[a] = (m[a] || 0) + 1;
                            return m;
                          }, {});
                          const dupeGroups = Object.values(dupeAddrCounts).filter(n => n > 1).length;
                          return (
                            <>
                              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, fontFamily: "'Nunito', sans-serif", fontSize: 13 }}>
                                <div style={{ padding: "6px 12px", borderRadius: 8, background: "#dbeafe", color: "#1e40af", fontWeight: 700 }}>{eligible.length} eligible</div>
                                {noPhotos.length > 0 ? <div style={{ padding: "6px 12px", borderRadius: 8, background: "#f3f4f6", color: "#6b7280" }}>{noPhotos.length} skipped (no photos)</div> : null}
                                {existing.length > 0 ? <div style={{ padding: "6px 12px", borderRadius: 8, background: "#dcfce7", color: "#15803d" }}>{existing.length} already done</div> : null}
                                {dupeGroups > 0 ? <div style={{ padding: "6px 12px", borderRadius: 8, background: "#fed7aa", color: "#9a3412", fontWeight: 700 }}>⚠️ {dupeGroups} possible dupe {dupeGroups === 1 ? "group" : "groups"}</div> : null}
                              </div>

                              {bulkCandidates.length === 0 ? (
                                <div style={{ padding: 14, fontSize: 13, color: "#6b7280", fontStyle: "italic", textAlign: "center" }}>
                                  No JN jobs match those filters.
                                </div>
                              ) : (
                                <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff" }}>
                                  {/* Sort eligible first, then no-photos, then already-done so
                                      the rep can scan top-down. Each row carries an explicit
                                      status pill so there's no guessing why a row is skipped.
                                      Also flag suspected JN-side duplicates: jobs sharing the
                                      same normalized address are tagged with a POSSIBLE DUPE
                                      pill. We don't auto-merge — JN duplicates need manual
                                      cleanup in JN to preserve any signed documents. */}
                                  {(() => {
                                    // Normalize an address for dupe matching: lowercase, drop
                                    // punctuation, collapse whitespace. Cheap but catches the
                                    // common case (same property entered twice with slightly
                                    // different name spellings — e.g. Maerz vs Maertz).
                                    const norm = (s) => String(s || "")
                                      .toLowerCase()
                                      .replace(/[.,#]/g, " ")
                                      .replace(/\s+/g, " ")
                                      .trim();
                                    const addrCounts = {};
                                    bulkCandidates.forEach(c => {
                                      const a = norm(c.address);
                                      if (!a) return;
                                      addrCounts[a] = (addrCounts[a] || 0) + 1;
                                    });
                                    const annotated = bulkCandidates.map(c => ({
                                      ...c,
                                      _status: c.photoCount === 0 ? "no_photos"
                                             : c.hasExistingReport ? "already_done"
                                             : "eligible",
                                      _isDupe: (addrCounts[norm(c.address)] || 0) > 1,
                                    }));
                                    annotated.sort((a, b) => {
                                      // Surface dupes near the top within their status group
                                      // so they're impossible to miss.
                                      const order = { eligible: 0, no_photos: 1, already_done: 2 };
                                      const s = order[a._status] - order[b._status];
                                      if (s !== 0) return s;
                                      return (b._isDupe ? 1 : 0) - (a._isDupe ? 1 : 0);
                                    });
                                    return annotated.map((c) => {
                                      const pill = c._status === "eligible"
                                        ? { bg: "#dbeafe", fg: "#1e40af", label: "ELIGIBLE" }
                                        : c._status === "no_photos"
                                        ? { bg: "#fef3c7", fg: "#92400e", label: "⊘ NO PHOTOS" }
                                        : { bg: "#dcfce7", fg: "#15803d", label: "✓ DONE" };
                                      return (
                                        <div key={c.jnid} style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", fontFamily: "'Nunito', sans-serif", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", opacity: c._status === "eligible" ? 1 : 0.7, background: c._isDupe ? "#fff7ed" : "transparent" }}>
                                          <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{c.clientName}</div>
                                            <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.address}</div>
                                            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>Rep: {c.repName} · Photos: {c.photoCount}</div>
                                          </div>
                                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                                            <div style={{ padding: "3px 8px", borderRadius: 6, background: pill.bg, color: pill.fg, fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{pill.label}</div>
                                            {c._isDupe ? (
                                              <div title="Two or more JN jobs share this address — clean up in JN before the bulk run if needed."
                                                style={{ padding: "3px 8px", borderRadius: 6, background: "#fed7aa", color: "#9a3412", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                                                ⚠️ POSSIBLE DUPE
                                              </div>
                                            ) : null}
                                            <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace" }}>{c.jnid.slice(0, 8)}…</div>
                                          </div>
                                        </div>
                                      );
                                    });
                                  })()}
                                </div>
                              )}

                              {eligible.length > 0 ? (
                                <button type="button"
                                  disabled={bulkRunning}
                                  onClick={async () => {
                                    if (!window.confirm(`Generate inspection reports for all ${eligible.length} eligible ${bulkResult} jobs and upload them to JN?\n\nThis will run in the background and can take ${Math.ceil(eligible.length * 15 / 60)} minutes or so to complete. PDFs appear in each job's Documents tab as they finish.`)) return;
                                    setBulkRunning(true);
                                    try {
                                      const r = await fetch("/.netlify/functions/bulk-generate-insp-reports-background", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ result: bulkResult, sinceDays: bulkSinceDays, skipExisting: bulkSkipExisting }),
                                      });
                                      // Background functions return 202 Accepted with no body —
                                      // we just need to know it was accepted by Netlify.
                                      if (r.status === 202 || r.ok) {
                                        alert(`✅ Started generating ${eligible.length} reports in the background.\n\nReload the candidates list in a few minutes to see progress (completed jobs disappear from "eligible").`);
                                      } else {
                                        const txt = await r.text();
                                        alert("Could not start bulk run: " + r.status + " " + txt.slice(0, 200));
                                      }
                                    } catch (e) {
                                      alert("Could not start bulk run: " + (e.message || e));
                                    } finally {
                                      setBulkRunning(false);
                                    }
                                  }}
                                  style={{
                                    marginTop: 14, padding: "14px 26px", borderRadius: 12, border: "none",
                                    background: bulkRunning ? "#9ca3af" : "#c9a35c",
                                    color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14,
                                    cursor: bulkRunning ? "not-allowed" : "pointer",
                                    textTransform: "uppercase", letterSpacing: "0.04em",
                                  }}>
                                  {bulkRunning ? "Starting..." : `🚀 Run ${eligible.length} Reports for ${bulkResult}`}
                                </button>
                              ) : null}
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                  </Card>}

                  {managerSection === "inspectors" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <InspectorsAdminPanel />
                  </Card>}

                  {managerSection === "assign_inspections" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <InspectionAssignmentsPanel />
                  </Card>}

                  {managerSection === "inspector_routes" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <ManagerRoutePlanner />
                  </Card>}

                  {managerSection === "inspector_reports" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <ManagerInspectorReports />
                  </Card>}

                  {managerSection === "pa_handoff" && <Card style={{ padding: 20, background: "#f8fafc" }}>
                    <PAHandoffPanel />
                  </Card>}

                      <div style={{ marginTop: 24 }}>
                        <Button onClick={() => { setManagerUnlocked(false); setManagerSection("home"); setView("input"); }}>
                          Save & Close
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        {/* ── Inspector mobile flow (rep-facing inspector phone app) ─── */}
        {view === "inspector" ? (
          <InspectorMobileApp />
        ) : null}

        {/* ── My Stats Modal — rep's own performance + leaderboard rank ─── */}
        {myStatsOpen ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20, overflow: "auto" }}
               onClick={() => setMyStatsOpen(false)}>
            <div style={{ background: "#fff", borderRadius: 14, padding: "24px 28px", maxWidth: 600, width: "100%", maxHeight: "90vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#0a0a0a", marginBottom: 4, fontFamily: "'Oswald', sans-serif" }}>
                📊 My Stats
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16, fontFamily: "'Nunito', sans-serif" }}>
                {data.salesRepName} · Submissions and results breakdown
              </div>

              {/* Toggle: This Week / Last Week / All Time */}
              <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
                <button type="button" onClick={() => { setMyStatsRange("thisWeek"); setMyStatsDrilldown(null); }}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1.5px solid #0a0a0a", background: myStatsRange === "thisWeek" ? "#0a0a0a" : "#fff", color: myStatsRange === "thisWeek" ? "#fff" : "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  This Week
                </button>
                <button type="button" onClick={() => { setMyStatsRange("lastWeek"); setMyStatsDrilldown(null); }}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1.5px solid #0a0a0a", background: myStatsRange === "lastWeek" ? "#0a0a0a" : "#fff", color: myStatsRange === "lastWeek" ? "#fff" : "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Last Week
                </button>
                <button type="button" onClick={() => { setMyStatsRange("allTime"); setMyStatsDrilldown(null); }}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1.5px solid #0a0a0a", background: myStatsRange === "allTime" ? "#0a0a0a" : "#fff", color: myStatsRange === "allTime" ? "#fff" : "#0a0a0a", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  All Time
                </button>
              </div>

              {myStatsLoading ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280" }}>Loading...</div>
              ) : !myStatsData ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280" }}>No data</div>
              ) : (() => {
                const period = myStatsRange === "thisWeek" ? myStatsData.thisWeek : myStatsRange === "lastWeek" ? myStatsData.lastWeek : myStatsData.allTime;
                const c = period.counts;
                return (
                  <>
                    {/* Top row — submissions count */}
                    <div style={{ background: "#0a0a0a", borderRadius: 12, padding: "16px 20px", color: "#fff", marginBottom: 14, textAlign: "center" }}>
                      <div style={{ fontSize: 11, opacity: 0.8, textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>
                        {myStatsRange === "allTime" ? "Lifetime Submissions" : "Total Submissions"}
                      </div>
                      <div style={{ fontSize: 36, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1 }}>{c.submissions}</div>
                    </div>

                    {/* 4-stat grid — each tile is clickable to drill down to the homeowner list */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
                      <button type="button" onClick={() => setMyStatsDrilldown(myStatsDrilldown === "damage" ? null : "damage")}
                        style={{ background: "#fef2f2", border: myStatsDrilldown === "damage" ? "2px solid #dc2626" : "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", textAlign: "center", cursor: c.damage > 0 ? "pointer" : "default", boxShadow: myStatsDrilldown === "damage" ? "0 2px 8px rgba(220,38,38,0.2)" : "none" }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: "#dc2626", fontFamily: "'Oswald', sans-serif" }}>{c.damage}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#991b1b", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'Oswald', sans-serif", marginTop: 2 }}>⚠️ Damage</div>
                        {c.resulted > 0 ? <div style={{ fontSize: 10, color: "#7f1d1d", marginTop: 2, fontFamily: "'Nunito', sans-serif" }}>{c.damagePct}% of resulted{c.damage > 0 ? " · tap to view" : ""}</div> : null}
                      </button>
                      <button type="button" onClick={() => setMyStatsDrilldown(myStatsDrilldown === "no_damage" ? null : "no_damage")}
                        style={{ background: "#f0fdf4", border: myStatsDrilldown === "no_damage" ? "2px solid #16a34a" : "1px solid #bbf7d0", borderRadius: 10, padding: "12px 14px", textAlign: "center", cursor: c.no_damage > 0 ? "pointer" : "default", boxShadow: myStatsDrilldown === "no_damage" ? "0 2px 8px rgba(22,163,74,0.2)" : "none" }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: "#16a34a", fontFamily: "'Oswald', sans-serif" }}>{c.no_damage}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'Oswald', sans-serif", marginTop: 2 }}>✅ No Damage</div>
                        {c.resulted > 0 ? <div style={{ fontSize: 10, color: "#14532d", marginTop: 2, fontFamily: "'Nunito', sans-serif" }}>{c.noDamagePct}% of resulted{c.no_damage > 0 ? " · tap to view" : ""}</div> : null}
                      </button>
                      <button type="button" onClick={() => setMyStatsDrilldown(myStatsDrilldown === "retail" ? null : "retail")}
                        style={{ background: "#fff7ed", border: myStatsDrilldown === "retail" ? "2px solid #ea580c" : "1px solid #fed7aa", borderRadius: 10, padding: "12px 14px", textAlign: "center", cursor: c.retail > 0 ? "pointer" : "default", boxShadow: myStatsDrilldown === "retail" ? "0 2px 8px rgba(234,88,12,0.2)" : "none" }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: "#ea580c", fontFamily: "'Oswald', sans-serif" }}>{c.retail}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#9a3412", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'Oswald', sans-serif", marginTop: 2 }}>🏠 Retail</div>
                        {c.resulted > 0 ? <div style={{ fontSize: 10, color: "#7c2d12", marginTop: 2, fontFamily: "'Nunito', sans-serif" }}>{c.retailPct}% of resulted{c.retail > 0 ? " · tap to view" : ""}</div> : null}
                      </button>
                      <button type="button" onClick={() => setMyStatsDrilldown(myStatsDrilldown === "pending" ? null : "pending")}
                        style={{ background: "#f3f4f6", border: myStatsDrilldown === "pending" ? "2px solid #6b7280" : "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px", textAlign: "center", cursor: c.pending > 0 ? "pointer" : "default", boxShadow: myStatsDrilldown === "pending" ? "0 2px 8px rgba(107,114,128,0.2)" : "none" }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: "#6b7280", fontFamily: "'Oswald', sans-serif" }}>{c.pending}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'Oswald', sans-serif", marginTop: 2 }}>⏳ Pending</div>
                        {c.submissions > 0 ? <div style={{ fontSize: 10, color: "#1f2937", marginTop: 2, fontFamily: "'Nunito', sans-serif" }}>{c.pendingPct}% of total{c.pending > 0 ? " · tap to view" : ""}</div> : null}
                      </button>
                    </div>

                    {/* ── Drilldown panel — shows homeowners contributing to the selected stat ── */}
                    {myStatsDrilldown ? (() => {
                      const filtered = (period.rows || []).filter(r => {
                        if (myStatsDrilldown === "pending") return !r.result;
                        return r.result === myStatsDrilldown;
                      });
                      const labels = { damage: "⚠️ Damage", no_damage: "✅ No Damage", retail: "🏠 Retail", pending: "⏳ Pending" };
                      const colors = {
                        damage: { bg: "#fef2f2", border: "#fecaca", text: "#991b1b" },
                        no_damage: { bg: "#f0fdf4", border: "#bbf7d0", text: "#166534" },
                        retail: { bg: "#fff7ed", border: "#fed7aa", text: "#9a3412" },
                        pending: { bg: "#f3f4f6", border: "#e5e7eb", text: "#374151" },
                      };
                      const color = colors[myStatsDrilldown];
                      return (
                        <div style={{ background: color.bg, border: `1px solid ${color.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 18 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: color.text, fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                              {labels[myStatsDrilldown]} · {filtered.length} {filtered.length === 1 ? "homeowner" : "homeowners"}
                            </div>
                            <button type="button" onClick={() => setMyStatsDrilldown(null)}
                              style={{ background: "none", border: "none", color: color.text, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                          </div>

                          {filtered.length === 0 ? (
                            <div style={{ fontSize: 12, color: color.text, fontFamily: "'Nunito', sans-serif", fontStyle: "italic", textAlign: "center", padding: "10px 0" }}>
                              No homeowners in this category for this period.
                            </div>
                          ) : (
                            <div style={{ display: "grid", gap: 6 }}>
                              {filtered.map(r => {
                                const docs = r._docsSigned || { insp: false, lor: false, pac: false };
                                const allSigned = docs.insp && docs.lor && docs.pac;
                                const needsLorPac = !docs.lor || !docs.pac;
                                return (
                                  <div key={r.id} style={{ background: "#fff", borderRadius: 8, padding: "10px 12px", border: `1px solid ${color.border}` }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                                      <div style={{ flex: 1, minWidth: 200 }}>
                                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827" }}>{r.client_name || "(no name)"}</div>
                                        <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Nunito', sans-serif", marginTop: 1 }}>
                                          {[r.address, r.city, r.zip].filter(Boolean).join(", ")}
                                        </div>
                                      </div>
                                      <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: docs.insp ? "#dbeafe" : "#f3f4f6", color: docs.insp ? "#1e40af" : "#9ca3af", fontFamily: "'Oswald', sans-serif" }}>{docs.insp ? "✓" : "○"} INSP</span>
                                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: docs.lor ? "#dcfce7" : "#f3f4f6", color: docs.lor ? "#166534" : "#9ca3af", fontFamily: "'Oswald', sans-serif" }}>{docs.lor ? "✓" : "○"} LOR</span>
                                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, fontWeight: 700, background: docs.pac ? "#dcfce7" : "#f3f4f6", color: docs.pac ? "#166534" : "#9ca3af", fontFamily: "'Oswald', sans-serif" }}>{docs.pac ? "✓" : "○"} PA</span>
                                      </div>
                                    </div>
                                    {/* Action prompt — for damage records missing LOR/PAC, nudge the rep to get them signed */}
                                    {myStatsDrilldown === "damage" && needsLorPac ? (
                                      <div style={{ marginTop: 8, padding: "6px 10px", background: "#fef2f2", borderRadius: 6, fontSize: 11, color: "#991b1b", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                                        ⚠️ Needs PA paperwork — go to <strong>📋 My Homeowners</strong> to add {!docs.lor ? "LOR" : ""}{!docs.lor && !docs.pac ? " + " : ""}{!docs.pac ? "PA" : ""}
                                      </div>
                                    ) : null}
                                    {myStatsDrilldown === "damage" && allSigned ? (
                                      <div style={{ marginTop: 8, padding: "6px 10px", background: "#f0fdf4", borderRadius: 6, fontSize: 11, color: "#166534", fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                                        ✅ All paperwork signed — claim is in motion
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })() : null}

                    {/* Leaderboard — only show on This Week tab since rank is computed for current week */}
                    {myStatsRange === "thisWeek" ? (
                      <>
                        <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16, marginBottom: 12 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#0a0a0a", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'Oswald', sans-serif", marginBottom: 4 }}>
                            🏆 Your Rank This Week
                          </div>
                          {myStatsData.leaderboard.rank ? (
                            <div style={{ fontSize: 14, color: "#374151", fontFamily: "'Nunito', sans-serif" }}>
                              You're <strong>#{myStatsData.leaderboard.rank}</strong> of <strong>{myStatsData.leaderboard.totalReps}</strong> active reps this week.
                            </div>
                          ) : (
                            <div style={{ fontSize: 14, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", fontStyle: "italic" }}>
                              No submissions this week yet — get started!
                            </div>
                          )}
                        </div>

                        {myStatsData.leaderboard.topFive.length > 0 ? (
                          <div style={{ background: "#f8fafc", borderRadius: 10, padding: "14px 16px" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'Oswald', sans-serif", marginBottom: 10 }}>
                              Top 5 Reps This Week
                            </div>
                            {myStatsData.leaderboard.topFive.map((r, i) => {
                              const isMe = r.id === data.salesRepId || r.name === data.salesRepName;
                              return (
                                <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: i === 0 ? "none" : "1px solid #e5e7eb" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: i === 0 ? "#fbbf24" : i === 1 ? "#94a3b8" : i === 2 ? "#d97706" : "#e5e7eb", color: i < 3 ? "#fff" : "#6b7280", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
                                      {i + 1}
                                    </div>
                                    <div style={{ fontSize: 14, fontWeight: isMe ? 700 : 500, color: isMe ? "#0a0a0a" : "#111827", fontFamily: "'Nunito', sans-serif" }}>
                                      {r.name} {isMe ? <span style={{ fontSize: 10, color: "#0a0a0a", marginLeft: 6, fontWeight: 700 }}>← YOU</span> : null}
                                    </div>
                                  </div>
                                  <div style={{ fontSize: 14, fontWeight: 700, color: "#0a0a0a", fontFamily: "'Oswald', sans-serif" }}>
                                    {r.submissions}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </>
                );
              })()}

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
                <button type="button" onClick={() => setMyStatsOpen(false)}
                  style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── My Homeowners Modal — rep picks an existing homeowner to add docs to ── */}
        {myHomeownersOpen ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20, overflow: "auto" }}
               onClick={() => !myHomeownersLoading && !resendingHomeownerKey && setMyHomeownersOpen(false)}>
            <div style={{ background: "#fff", borderRadius: 14, padding: "24px 28px", maxWidth: 720, width: "100%", maxHeight: "90vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
              {/* Header — copy + colors switch when the modal is opened in
                  "Awaiting Signature" mode so the rep knows they're looking at
                  pending links, not their full homeowner list. */}
              <div style={{
                padding: "24px 28px",
                background: myHomeownersPendingOnly
                  ? "linear-gradient(135deg, #ea580c 0%, #9a3412 100%)"
                  : "linear-gradient(135deg, #c9a35c 0%, #a17e3f 100%)",
                borderRadius: 14,
                fontFamily: "'Oswald', sans-serif",
                color: "#fff",
                textAlign: "center",
                boxShadow: "0 6px 20px rgba(200, 57, 43, 0.35)",
                border: "3px solid #fff",
                outline: myHomeownersPendingOnly ? "3px solid #ea580c" : "3px solid #c9a35c",
                marginBottom: 20,
              }}>
                <div style={{
                  fontSize: 28, fontWeight: 800,
                  letterSpacing: "0.04em", textTransform: "uppercase",
                  marginBottom: 8, lineHeight: 1.15,
                }}>
                  {myHomeownersPendingOnly ? "⏳ Awaiting Signature" : "👇 Pick the homeowner"}
                </div>
                <div style={{
                  fontSize: 16, fontWeight: 600, lineHeight: 1.4,
                  fontFamily: "'Nunito', sans-serif",
                  opacity: 0.95,
                }}>
                  {myHomeownersPendingOnly
                    ? <>These homeowners got a signing link but haven't finished. Click <strong>RESEND LINK</strong> to send the same link again.</>
                    : <>Search the customer's name or address. Click <strong>ADD DOCS</strong> on the right row to load them.</>}
                </div>
              </div>

              {/* Search */}
              <input type="text" value={myHomeownersSearch}
                onChange={(e) => setMyHomeownersSearch(e.target.value)}
                placeholder="🔍 Type customer's name or address..."
                autoFocus
                style={{
                  width: "100%", height: 48, borderRadius: 12,
                  border: "2px solid #0a0a0a",
                  padding: "0 16px", fontSize: 15, boxSizing: "border-box",
                  fontFamily: "'Nunito', sans-serif", marginBottom: 16,
                  outline: "none",
                }}
              />

              {myHomeownersLoading ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>Loading your homeowners...</div>
              ) : myHomeownersList.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>No homeowners found for your account yet.</div>
              ) : myHomeownersPendingOnly && myHomeownersList.every(h => h.signed_at) ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12, fontFamily: "'Nunito', sans-serif", fontWeight: 600 }}>
                  ✅ No homeowners awaiting signature — you're all caught up.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {myHomeownersList
                    .filter(h => {
                      // Awaiting-Signature mode hides any row the homeowner already finished.
                      if (myHomeownersPendingOnly && h.signed_at) return false;
                      if (!myHomeownersSearch || myHomeownersSearch.length < 2) return true;
                      const q = myHomeownersSearch.toLowerCase();
                      const hay = [h.name, h.address, h.city, h.zip].filter(Boolean).join(" ").toLowerCase();
                      return hay.includes(q);
                    })
                    .map((h, idx) => {
                      const docsList = (h.docs_signed || "").split(",").map(s => s.trim().toLowerCase());
                      const hasInsp = docsList.includes("insp");
                      const hasLor  = docsList.includes("lor");
                      const hasPac  = docsList.includes("pac");
                      const allDone = hasInsp && hasLor && hasPac;
                      // docs_signed records what was SENT for signing. signed_at is the
                      // homeowner's actual completion timestamp. When signed_at is null
                      // the link went out but the homeowner never finished — show those
                      // rows as "awaiting signature" rather than checked-off.
                      const isPending = !h.signed_at;
                      const docBadge = (label, requested) => {
                        if (!requested) {
                          return { bg: "#f3f4f6", color: "#9ca3af", mark: "○" };
                        }
                        if (isPending) {
                          return { bg: "#fff7ed", color: "#9a3412", mark: "⏳" };
                        }
                        if (label === "INSP") return { bg: "#dbeafe", color: "#1e40af", mark: "✓" };
                        return { bg: "#dcfce7", color: "#166534", mark: "✓" };
                      };
                      const inspBadge = docBadge("INSP", hasInsp);
                      const lorBadge  = docBadge("LOR",  hasLor);
                      const pacBadge  = docBadge("PA",   hasPac);
                      return (
                        <div key={`${h.claim_id || h.insp_id}-${idx}`}
                             style={{ padding: "12px 14px", borderRadius: 12, border: isPending ? "1.5px solid #ea580c" : (allDone ? "1px solid #d1d5db" : "1.5px solid #0a0a0a"), background: isPending ? "#fff7ed" : (allDone ? "#fafafa" : "#fff"), display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <div style={{ fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: "#111827", fontSize: 14 }}>{h.name || "(no name)"}</div>
                            <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>
                              {[h.address, h.city, h.state, h.zip].filter(Boolean).join(", ")}
                            </div>
                            {isPending ? (
                              <div style={{ marginTop: 6, display: "inline-block", padding: "3px 9px", borderRadius: 6, background: "#ea580c", color: "#fff", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                                ⏳ Awaiting Signature
                              </div>
                            ) : null}
                            <div style={{ marginTop: 6, display: "flex", gap: 5, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 6, fontWeight: 700, background: inspBadge.bg, color: inspBadge.color, fontFamily: "'Oswald', sans-serif" }}>{inspBadge.mark} INSP</span>
                              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 6, fontWeight: 700, background: lorBadge.bg, color: lorBadge.color, fontFamily: "'Oswald', sans-serif" }}>{lorBadge.mark} LOR</span>
                              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 6, fontWeight: 700, background: pacBadge.bg, color: pacBadge.color, fontFamily: "'Oswald', sans-serif" }}>{pacBadge.mark} PA</span>
                              {h.signed_at ? <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "'Nunito', sans-serif" }}>· {new Date(h.signed_at).toLocaleDateString()}</span> : null}
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                          {isPending ? (
                            <button type="button"
                              disabled={resendingHomeownerKey === (h.raw_claim?.id)}
                              onClick={() => resendSigningLink(h, docsList)}
                              style={{ padding: "8px 14px", borderRadius: 10, border: "2px solid #ea580c", background: resendingHomeownerKey === (h.raw_claim?.id) ? "#fff7ed" : "#ea580c", color: resendingHomeownerKey === (h.raw_claim?.id) ? "#ea580c" : "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: resendingHomeownerKey === (h.raw_claim?.id) ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                              {resendingHomeownerKey === (h.raw_claim?.id) ? "Sending…" : "📨 Resend Link"}
                            </button>
                          ) : null}
                          <button type="button"
                            disabled={allDone}
                            onClick={() => {
                              // Prefill the signing form with this homeowner's data
                              const c = h.raw_claim;
                              const parts = (h.name || "").split("&").map(s => s.trim());
                              update("homeowner1", c?.homeowner1 || parts[0] || h.name || "");
                              update("homeowner2", c?.homeowner2 || parts[1] || "");
                              update("address", h.address || "");
                              update("city", h.city || "");
                              update("state", h.state || "");
                              update("zip", h.zip || "");
                              update("phone", h.phone || "");
                              update("signerEmail", h.email || "");
                              if (c) {
                                update("insuranceCompany", c.insurance_company || "");
                                update("policyNumber", c.policy_number || "");
                                update("claimNumber", c.claim_number || "");
                                update("dateOfLoss", c.date_of_loss || "");
                                update("lossLocation", c.loss_location || "");
                                update("lossDescription", c.loss_description || "");
                                update("claimType", c.claim_type || "");
                                update("situation", c.situation || "");
                                update("paEmail", c.pa_email || "Kkeckleradj@gmail.com");
                              }
                              // Set existing-mode flags so docs already signed are disabled.
                              // For pending rows (signed_at is null) the link was sent but the
                              // homeowner never completed signing — nothing is actually signed
                              // yet, so don't lock any of the doc toggles. Pre-select the
                              // originally-requested docs so the rep can resend or sign in person.
                              setExistingClaim(c || null);
                              setExistingInsp(h.raw_insp || null);
                              const signedDocs = isPending
                                ? []
                                : docsList.filter(d => ["insp","lor","pac"].includes(d));
                              setAlreadySignedDocs(signedDocs);
                              // Set currentClaimId so saveClaimToSupabase UPDATES the existing
                              // row instead of creating a new one.
                              if (c?.id) setCurrentClaimId(c.id);
                              // Auto-select docs:
                              //  - Pending row → re-select what was originally sent
                              //  - Signed row → select what's still missing
                              const docsToSelect = isPending
                                ? docsList.filter(d => ["insp","lor","pac"].includes(d))
                                : ["insp","lor","pac"].filter(d => !docsList.includes(d));
                              const safeDocsToSelect = PA_FORMS_DISABLED
                                ? docsToSelect.filter(d => d === "insp")
                                : docsToSelect;
                              setSelectedDocs(
                                safeDocsToSelect.length
                                  ? safeDocsToSelect
                                  : (PA_FORMS_DISABLED ? ["insp"] : ["lor","pac"])
                              );
                              setMyHomeownersOpen(false);
                              // Scroll up to the form
                              setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 100);
                            }}
                            style={{ padding: "8px 14px", borderRadius: 10, border: allDone ? "1px solid #d1d5db" : "2px solid #0a0a0a", background: allDone ? "#f3f4f6" : "#0a0a0a", color: allDone ? "#9ca3af" : "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 12, cursor: allDone ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                            {allDone ? "✓ All Signed" : isPending ? "Sign Now →" : "Add Docs →"}
                          </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" onClick={() => setMyHomeownersOpen(false)}
                  style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Resend Signed Documents Modal ────────────────────────────── */}
        {resendModal ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20 }}
               onClick={() => !resendLoading && setResendModal(null)}>
            <div style={{ background: "#fff", borderRadius: 14, padding: "24px 28px", maxWidth: 540, width: "100%", maxHeight: "90vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#0c4a6e", marginBottom: 6, fontFamily: "'Oswald', sans-serif" }}>📤 Re-send Signed Documents</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 16, fontFamily: "'Nunito', sans-serif" }}>
                {resendModal.rec.client_name} · {[resendModal.rec.address, resendModal.rec.city, resendModal.rec.state, resendModal.rec.zip].filter(Boolean).join(", ")}
              </div>

              {!resendModal.rec.signed_pdfs?.insp ? (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#92400e", fontFamily: "'Nunito', sans-serif" }}>
                  ⚠️ This record has no archived PDFs yet. Sending will <strong>regenerate them from claim data</strong>. The regenerated PDFs will include a "REGENERATED FROM RECORDS" stamp showing the original signing date.
                </div>
              ) : (
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#166534", fontFamily: "'Nunito', sans-serif" }}>
                  📁 Archived PDFs available: {Object.keys(resendModal.rec.signed_pdfs).filter(k => k !== "uploaded_at").join(", ")}
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <Label>Send to</Label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  {[
                    { key: "pa",        label: "PA",        email: "Kkeckleradj@gmail.com" },
                    { key: "homeowner", label: "Homeowner", email: resendModal.rec.email || "" },
                    { key: "office",    label: "Office",    email: "" /* user types */ },
                    { key: "custom",    label: "Custom",    email: "" },
                  ].map(opt => (
                    <button key={opt.key} type="button"
                      onClick={() => setResendModal(m => ({ ...m, recipientType: opt.key, to: opt.email || m.customTo || "", customTo: opt.key === "custom" ? m.customTo : "" }))}
                      style={{ padding: "6px 14px", borderRadius: 18, border: "1.5px solid #0891b2", background: resendModal.recipientType === opt.key ? "#0891b2" : "#fff", color: resendModal.recipientType === opt.key ? "#fff" : "#0891b2", fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 700, cursor: "pointer", letterSpacing: "0.03em" }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <input
                  type="email"
                  value={resendModal.recipientType === "custom" ? resendModal.customTo : resendModal.to}
                  onChange={(e) => {
                    if (resendModal.recipientType === "custom") {
                      setResendModal(m => ({ ...m, customTo: e.target.value, to: e.target.value }));
                    } else {
                      setResendModal(m => ({ ...m, to: e.target.value }));
                    }
                  }}
                  placeholder={resendModal.recipientType === "custom" ? "Type email address..." : "Recipient email"}
                  style={{ width: "100%", height: 42, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <Label>CC (optional)</Label>
                <input
                  type="email"
                  value={resendModal.cc}
                  onChange={(e) => setResendModal(m => ({ ...m, cc: e.target.value }))}
                  placeholder="cc@example.com"
                  style={{ width: "100%", height: 42, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                />
              </div>

              {/* Force regenerate — only useful if there are already archived PDFs we'd otherwise reuse */}
              {resendModal.rec.signed_pdfs?.insp ? (
                <div style={{ marginBottom: 18, fontSize: 13, color: "#374151", fontFamily: "'Nunito', sans-serif" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox"
                      checked={!!resendModal.forceRegen}
                      onChange={(e) => setResendModal(m => ({ ...m, forceRegen: e.target.checked }))}
                      style={{ width: 16, height: 16, cursor: "pointer" }} />
                    <span>Re-generate fresh PDFs from current data (overwrites archive)</span>
                  </label>
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => !resendLoading && setResendModal(null)}
                  disabled={resendLoading}
                  style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: resendLoading ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Cancel
                </button>
                <button type="button"
                  disabled={resendLoading || !resendModal.to}
                  onClick={async () => {
                    setResendLoading(true);
                    try {
                      const r = await fetch("/.netlify/functions/resend-signed-docs", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          inspectionId: resendModal.rec.id,
                          to: resendModal.to,
                          cc: resendModal.cc || undefined,
                          forceRegen: !!resendModal.forceRegen,
                        }),
                      });
                      const d = await r.json().catch(() => ({}));
                      if (r.ok && d.ok) {
                        alert(`✅ Sent to ${d.to}${d.cc ? ` (cc: ${d.cc})` : ""}\n\nDocuments: ${d.attachments.join(", ")}`);
                        // Refresh row to show the archive indicator if regenerated
                        if (resendModal.rec.id) {
                          const { data: refreshed } = await supabase.from("inspections").select("signed_pdfs").eq("id", resendModal.rec.id).maybeSingle();
                          if (refreshed?.signed_pdfs) {
                            setRecordSearchResults(prev => prev.map(rr => rr.id === resendModal.rec.id ? { ...rr, signed_pdfs: refreshed.signed_pdfs } : rr));
                          }
                        }
                        setResendModal(null);
                      } else {
                        alert("❌ Send failed: " + (d.error || (await r.text()).slice(0, 200)) + (d.detail ? "\n\n" + JSON.stringify(d.detail).slice(0, 300) : ""));
                      }
                    } catch (e) {
                      alert("Send error: " + (e.message || e));
                    } finally {
                      setResendLoading(false);
                    }
                  }}
                  style={{ padding: "10px 22px", borderRadius: 10, border: "none", background: (resendLoading || !resendModal.to) ? "#9ca3af" : "#0891b2", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: (resendLoading || !resendModal.to) ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {resendLoading ? "Sending..." : "📤 Send Documents"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Email Weekly Report Modal ────────────────────────────────────
            Type an email, click send. PDF is generated fresh on send via the
            same /generate-weekly-report-pdf function the Download button uses,
            then sent as an attachment via /send-email. */}
        {reportEmailModal && reportData ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20 }}
               onClick={() => !reportEmailSending && setReportEmailModal(null)}>
            <div style={{ background: "#fff", borderRadius: 14, padding: "24px 28px", maxWidth: 460, width: "100%" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#0a0a0a", marginBottom: 6, fontFamily: "'Oswald', sans-serif" }}>📧 Email Weekly Report</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 16, fontFamily: "'Nunito', sans-serif" }}>
                {reportData.startDate} → {reportData.endDate} · {reportData.totalRows} signing{reportData.totalRows !== 1 ? "s" : ""} · ${reportData.totalEarned.toLocaleString()}
              </div>

              <div style={{ marginBottom: 14 }}>
                <Label>Send to</Label>
                <input type="email" autoFocus
                  value={reportEmailModal.to}
                  onChange={(e) => setReportEmailModal(m => ({ ...m, to: e.target.value }))}
                  placeholder="recipient@example.com"
                  disabled={reportEmailSending}
                  style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                />
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button"
                  disabled={reportEmailSending}
                  onClick={() => setReportEmailModal(null)}
                  style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: reportEmailSending ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Cancel
                </button>
                <button type="button"
                  // Basic validation: trim + simple pattern. Keeps the user from
                  // hitting send on an obviously-bad address.
                  disabled={reportEmailSending || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((reportEmailModal.to || "").trim())}
                  onClick={async () => {
                    const to = (reportEmailModal.to || "").trim();
                    setReportEmailSending(true);
                    try {
                      // 1) Generate the PDF using the same function as Download.
                      // We read the response as text first so we can give a useful
                      // error if the function returns an empty body (Netlify
                      // timeout, gateway error, etc.) instead of crashing inside
                      // .json() with "Unexpected end of JSON input".
                      const pdfRes = await fetch("/.netlify/functions/generate-weekly-report-pdf", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ reportData }),
                      });
                      const pdfText = await pdfRes.text();
                      if (!pdfText) {
                        alert(
                          "PDF generation failed (empty response, status " + pdfRes.status + ").\n\n" +
                          "This usually means the PDF function timed out. Try again in a moment, " +
                          "or use the Download PDF button first to confirm PDF generation is working."
                        );
                        return;
                      }
                      let pdfData;
                      try { pdfData = JSON.parse(pdfText); }
                      catch { pdfData = { ok: false, error: "Non-JSON response: " + pdfText.slice(0, 200) }; }
                      if (!pdfRes.ok || !pdfData.ok || !pdfData.base64) {
                        alert("PDF generation failed: " + (pdfData.error || "unknown error") + (pdfData.detail ? "\n\n" + pdfData.detail : ""));
                        return;
                      }

                      // 2) Send via the existing send-email function. Attachment
                      //    shape matches what other parts of the app use:
                      //    { filename, content } where content is raw base64.
                      const filename = `weekly-report-${reportData.startDate}-to-${reportData.endDate}.pdf`;
                      const subject = `Weekly Report — ${reportData.startDate} to ${reportData.endDate}`;
                      const html = `
                        <p>Attached is the weekly report for <strong>${reportData.startDate}</strong> through <strong>${reportData.endDate}</strong>.</p>
                        <ul>
                          <li><strong>${reportData.totalRows}</strong> signing${reportData.totalRows !== 1 ? "s" : ""}</li>
                          <li><strong>$${reportData.totalEarned.toLocaleString()}</strong> total earned</li>
                        </ul>
                      `;
                      const sendRes = await fetch("/.netlify/functions/send-email", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          to: [to],
                          subject,
                          html,
                          attachments: [{ filename, content: pdfData.base64 }],
                        }),
                      });
                      if (!sendRes.ok) {
                        const txt = (await sendRes.text()).slice(0, 300);
                        alert("Email send failed: " + txt);
                        return;
                      }
                      alert(`✅ Report sent to ${to}.`);
                      setReportEmailModal(null);
                    } catch (e) {
                      alert("Email error: " + (e.message || e));
                    } finally {
                      setReportEmailSending(false);
                    }
                  }}
                  style={{ padding: "10px 22px", borderRadius: 10, border: "none", background: reportEmailSending ? "#9ca3af" : "#166534", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: reportEmailSending ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {reportEmailSending ? "Sending..." : "📧 Send Email"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Inspection Photos Modal ───────────────────────────────────── */}
        {photosModalId && (
          <InspectionPhotosModal
            inspectionId={photosModalId}
            onClose={() => setPhotosModalId(null)}
          />
        )}

        {/* ── JN Match Picker Modal ─────────────────────────────────────── */}
        <JnMatchPickerModal
          open={!!jnPickerRow}
          row={jnPickerRow}
          onClose={() => setJnPickerRow(null)}
          onLinked={(jobId, source) => {
            // Refresh the row in-place so the orphan badge disappears
            // and the Push to JN button takes over immediately.
            if (jnPickerRow) {
              setRecordSearchResults((prev) => prev.map((rr) => rr.id === jnPickerRow.id
                ? { ...rr, jn_job_id: jobId }
                : rr));
            }
            // Small confirmation toast via alert — short, easy to dismiss.
            alert(source === "linked"
              ? `🔗 Linked to existing JN job ${jobId}. No new JN record created.`
              : `✅ Created new JN job ${jobId}.`);
          }}
        />


        {/* ── Edit Record Modal ─────────────────────────────────────────── */}
        {editModal ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20, overflow: "auto" }}
               onClick={() => !editLoading && setEditModal(null)}>
            <div style={{ background: "#fff", borderRadius: 14, padding: "24px 28px", maxWidth: 620, width: "100%", maxHeight: "90vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#0a0a0a", marginBottom: 6, fontFamily: "'Oswald', sans-serif" }}>✏️ Edit Record</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16, fontFamily: "'Nunito', sans-serif", wordBreak: "break-all" }}>
                Record ID: {editModal.rec.id}
              </div>

              {/* Client name */}
              <div style={{ marginBottom: 12 }}>
                <Label>Client Name</Label>
                <input type="text" value={editModal.draft.client_name}
                  onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, client_name: e.target.value } }))}
                  style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                />
              </div>

              {/* Address - autocomplete */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <Label>Street Address</Label>
                  <AddressAutocomplete
                    value={editModal.draft.address}
                    onChange={(v) => setEditModal(m => ({ ...m, draft: { ...m.draft, address: v } }))}
                    onPlaceSelected={({ address, city, state, zip }) => {
                      setEditModal(m => ({ ...m, draft: { ...m.draft, address, city, state: normalizeStateValue(state), zip } }));
                    }}
                    placeholder="Start typing the property address..."
                    style={{ height: 40, borderRadius: 10 }}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <Label>City</Label>
                  <input type="text" value={editModal.draft.city}
                    onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, city: e.target.value } }))}
                    style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                  />
                </div>
                <div>
                  <Label>State</Label>
                  <select value={normalizeStateValue(editModal.draft.state)}
                    onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, state: e.target.value } }))}
                    style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif", background: "#fff" }}
                  >
                    <option value="">— Select —</option>
                    {US_STATES.map(([code, name]) => (
                      <option key={code} value={code}>{code} — {name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>ZIP</Label>
                  <input type="text" value={editModal.draft.zip}
                    onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, zip: e.target.value } }))}
                    style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                  />
                </div>
              </div>

              {/* Phone + email */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                <div>
                  <Label>Mobile</Label>
                  <input type="tel" value={editModal.draft.mobile}
                    onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, mobile: e.target.value } }))}
                    style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                  />
                </div>
                <div>
                  <Label>Email</Label>
                  <input type="email" value={editModal.draft.email}
                    onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, email: e.target.value } }))}
                    style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif" }}
                  />
                </div>
              </div>

              {/* Sales rep dropdown — uses existing rep list */}
              <div style={{ marginBottom: 12 }}>
                <Label>Sales Rep</Label>
                <select
                  value={editModal.draft.sales_rep_id || ""}
                  onChange={(e) => {
                    const repId = e.target.value;
                    const rep = reps.find(r => String(r.id) === repId || String(r.jobnimbus_id) === repId);
                    setEditModal(m => ({ ...m, draft: { ...m.draft, sales_rep_id: repId, sales_rep_name: rep?.name || "" } }));
                  }}
                  style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif", background: "#fff" }}
                >
                  <option value="">— Select rep —</option>
                  {[...reps].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(r => (
                    <option key={r.id} value={r.jobnimbus_id || r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              {/* JN Job ID */}
              <div style={{ marginBottom: 12 }}>
                <Label>JobNimbus Job ID <span style={{ fontWeight: 400, color: "#6b7280" }}>(re-link to a different JN job)</span></Label>
                <input type="text" value={editModal.draft.jn_job_id}
                  onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, jn_job_id: e.target.value } }))}
                  placeholder="e.g. moajpcaqeztbdyttcymfsdj"
                  style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
                />
              </div>

              {/* Result override */}
              <div style={{ marginBottom: 18 }}>
                <Label>Result <span style={{ fontWeight: 400, color: "#6b7280" }}>(blank = pending)</span></Label>
                <select value={editModal.draft.result || ""}
                  onChange={(e) => setEditModal(m => ({ ...m, draft: { ...m.draft, result: e.target.value } }))}
                  style={{ width: "100%", height: 40, borderRadius: 10, border: "1px solid #d1d5db", padding: "0 12px", fontSize: 14, boxSizing: "border-box", fontFamily: "'Nunito', sans-serif", background: "#fff" }}
                >
                  <option value="">— Pending —</option>
                  <option value="damage">⚠️ Damage Found</option>
                  <option value="no_damage">✅ No Damage</option>
                  <option value="retail">🏠 Retail</option>
                </select>
              </div>

              {/* Save & Cancel buttons */}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginBottom: 22 }}>
                <button type="button" onClick={() => !editLoading && setEditModal(null)} disabled={editLoading}
                  style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: editLoading ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Cancel
                </button>
                <button type="button" disabled={editLoading}
                  onClick={async () => {
                    setEditLoading(true);
                    try {
                      const updates = { ...editModal.draft };
                      // Empty strings → null (so DB has clean values, not empty strings)
                      Object.keys(updates).forEach(k => { if (updates[k] === "") updates[k] = null; });
                      // If result was changed FROM null TO something, set result_at
                      if (updates.result && !editModal.rec.result) updates.result_at = new Date().toISOString();
                      // If result was cleared, clear result_at too
                      if (!updates.result && editModal.rec.result) updates.result_at = null;

                      const { error } = await supabase.from("inspections").update(updates).eq("id", editModal.rec.id);
                      if (error) {
                        alert("Save failed: " + error.message);
                        return;
                      }
                      // Update the row in-place in the displayed list
                      setRecordSearchResults(prev => prev.map(rr => rr.id === editModal.rec.id ? { ...rr, ...updates } : rr));
                      setEditModal(null);
                    } catch (e) {
                      alert("Error: " + (e.message || e));
                    } finally {
                      setEditLoading(false);
                    }
                  }}
                  style={{ padding: "10px 22px", borderRadius: 10, border: "none", background: editLoading ? "#9ca3af" : "#0a0a0a", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: editLoading ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {editLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>

              {/* Danger zone — destructive operations */}
              <div style={{ borderTop: "2px solid #fecaca", paddingTop: 14, marginTop: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#991b1b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>⚠️ Danger Zone</div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {/* Toggle cancelled */}
                  <button type="button" disabled={editLoading}
                    onClick={async () => {
                      const isCancelled = !!editModal.rec.cancelled_at;
                      const action = isCancelled ? "un-cancel" : "cancel";
                      if (!confirm(`${action.toUpperCase()} this record?`)) return;
                      const reason = isCancelled ? null : (window.prompt("Cancellation reason (optional):", "") || "Cancelled by admin");
                      const updates = isCancelled
                        ? { cancelled_at: null, cancel_reason: null, jn_status: null }
                        : { cancelled_at: new Date().toISOString(), cancel_reason: reason, jn_status: "Lost" };
                      setEditLoading(true);
                      try {
                        const { error } = await supabase.from("inspections").update(updates).eq("id", editModal.rec.id);
                        if (error) { alert("Failed: " + error.message); return; }
                        setRecordSearchResults(prev => isCancelled
                          ? prev.map(rr => rr.id === editModal.rec.id ? { ...rr, ...updates } : rr)
                          : prev.filter(rr => rr.id !== editModal.rec.id) // remove from view if newly cancelled
                        );
                        setEditModal(null);
                      } finally {
                        setEditLoading(false);
                      }
                    }}
                    style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #991b1b", background: "#fff", color: "#991b1b", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 11, cursor: editLoading ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {editModal.rec.cancelled_at ? "↩️ Un-cancel" : "❌ Cancel Record"}
                  </button>

                  {/* Permanent delete */}
                  <button type="button" disabled={editLoading}
                    onClick={async () => {
                      const confirmed = window.prompt(`PERMANENTLY DELETE this record?\n\nThis cannot be undone. To confirm, type the client name exactly:\n${editModal.rec.client_name}`);
                      if (confirmed !== editModal.rec.client_name) {
                        if (confirmed !== null) alert("Name didn't match — delete cancelled.");
                        return;
                      }
                      setEditLoading(true);
                      try {
                        const { error } = await supabase.from("inspections").delete().eq("id", editModal.rec.id);
                        if (error) { alert("Delete failed: " + error.message); return; }
                        setRecordSearchResults(prev => prev.filter(rr => rr.id !== editModal.rec.id));
                        setEditModal(null);
                      } finally {
                        setEditLoading(false);
                      }
                    }}
                    style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #7f1d1d", background: "#7f1d1d", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 11, cursor: editLoading ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    🗑️ Delete Record
                  </button>
                </div>
                <div style={{ fontSize: 10, color: "#6b7280", marginTop: 8, fontFamily: "'Nunito', sans-serif" }}>
                  Cancel removes the record from Pending/active views. Delete is permanent and removes all trace of the inspection record (claim records and JN data are NOT deleted).
                </div>
              </div>
            </div>
          </div>
        ) : null}

      </div>

      {/* ── Always-rendered hidden inspection PDF ── */}
      <div style={{ position: "fixed", left: "-9999px", top: 0, pointerEvents: "none", zIndex: -1 }}>
        <div id="inspection-printable" style={{ fontFamily: "Arial, Helvetica, sans-serif", background: "#fff", width: "8.5in", padding: "0.6in 0.7in", boxSizing: "border-box" }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>

            <img src="/uss-header.png" alt="U.S. Shingle & Metal" style={{ height: 70, objectFit: "contain", marginBottom: 10 }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0a0a0a", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1.5 }}>Free Roof Inspection Agreement</div>
            <div style={{ width: 60, height: 3, background: "#c9a35c", margin: "0 auto 10px", borderRadius: 2 }} />
            <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.7 }}>
              {INSPECTION_COMPANY.name} &nbsp;|&nbsp; {INSPECTION_COMPANY.address}<br />
              Phone: {INSPECTION_COMPANY.phone} &nbsp;|&nbsp; Email: {INSPECTION_COMPANY.email} &nbsp;|&nbsp; License #: {INSPECTION_COMPANY.license}
            </div>
            <div style={{ borderBottom: "2px solid #0a0a0a", marginTop: 14 }} />
          </div>
          <div style={{ display: "grid", gap: 6, fontSize: 14, marginBottom: 20 }}>
            <div><strong>Date:</strong> {inspData.date || data.date}</div>
            <div><strong>Client:</strong> {inspData.clientName || [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</div>
            <div><strong>Mobile:</strong> {inspData.mobile || data.phone}</div>
            <div><strong>Address:</strong> {inspData.address || data.address} &nbsp; <strong>City:</strong> {inspData.city || data.city} &nbsp; <strong>St:</strong> {inspData.state || data.state} &nbsp; <strong>Zip:</strong> {inspData.zip || data.zip}</div>
            <div><strong>Email:</strong> {inspData.email || data.signerEmail}</div>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 28, color: "#111827" }}>
            <p style={{ margin: "0 0 10px" }}>Client agrees to allow {INSPECTION_COMPANY.name} (Company) to perform a free roof inspection at the above address and to forward all pictures and findings to a Public Adjuster for review. The Company maintains all required licenses and insurance and will not perform repairs during the inspection.</p>
            <p style={{ margin: "0 0 10px" }}>Client understands that they do not need to be present during the inspection; however, Company personnel will knock on the door upon arrival.</p>
            <p style={{ margin: "0 0 10px" }}>If the Public Adjuster determines that storm damage exists, they may proceed with filing an insurance claim provided the Client has hired them. Client authorizes the Public Adjuster to notify the Company of its findings and to keep the Company updated throughout the claims process.</p>
            <p style={{ margin: 0 }}>Client acknowledges that the Company is a licensed roofing contractor and cannot discuss policy coverages, insurance requirements, or statutory guidelines. Any such questions should be directed to the Public Adjuster or the Client's homeowner's insurance carrier.</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 20 }}>
            <div>
              <div style={{ marginBottom: 4, fontSize: 12 }}>Client:</div>
              <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                {effectiveSig1 ? <img src={effectiveSig1} alt="Client signature" style={{ maxHeight: 44, objectFit: "contain" }} /> : null}
              </div>
              <div style={{ fontSize: 11, color: "#374151" }}>{[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</div>
              <div style={{ fontSize: 12, marginTop: 8 }}>Date: {data.date}</div>
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 12 }}>Representative:</div>
              <div style={{ borderBottom: "1px solid #000", minHeight: 50, display: "flex", alignItems: "flex-end", paddingBottom: 4, marginBottom: 4 }}>
                <img src={REP_FIXED.signatureImage} alt="Rep signature" style={{ maxHeight: 44, objectFit: "contain" }} />
              </div>
              <div style={{ fontSize: 11, color: "#374151" }}>{REP_FIXED.name}</div>
              <div style={{ fontSize: 12, marginTop: 8 }}>Date: {data.date}</div>
            </div>
          </div>

          {/* Audit trail page */}
          <div style={{ marginTop: 40, paddingTop: 24, borderTop: "2px solid #0a0a0a", pageBreakBefore: "always" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0a0a0a", marginBottom: 14, textTransform: "uppercase", letterSpacing: 1 }}>
              Signing Audit Trail
            </div>
            <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
              {[
                ["Document", "Free Roof Inspection Agreement"],
                ["Signed by", inspData.clientName || [data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")],
                ["Signer email", inspData.email || data.signerEmail || "—"],
                ["Signed at", auditInfo?.signedAt || new Date().toISOString()],
                ["IP address", auditInfo?.signedIp || "—"],
                ["City / State", [auditInfo?.signedCity, auditInfo?.signedRegion].filter(Boolean).join(", ") || "—"],
                ["Sign method", auditInfo?.signMethod || "sign_now"],
                ["Browser / device", auditInfo?.signedUserAgent || navigator.userAgent || "—"],
              ].map(([label, value]) => (
                <div key={label} style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 8, padding: "6px 10px", background: "#f8fafc", borderRadius: 6, border: "1px solid #e5e7eb" }}>
                  <div style={{ fontWeight: 700, color: "#374151" }}>{label}</div>
                  <div style={{ color: "#111827", wordBreak: "break-all" }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
              This audit trail is automatically generated and serves as a record of the electronic signing event.
            </div>
          </div>
        </div>
      </div>

      {/* ── Always-rendered hidden welcome PDF (needed for email attachment at submit time) ── */}
      <div style={{ position: "fixed", left: "-9999px", top: 0, pointerEvents: "none", zIndex: -1 }}>
        <div
          id="ty-summary-printable"
          style={{
            width: "8.5in",
            fontFamily: "Arial, Helvetica, sans-serif",
            background: "#fff",
          }}
        >
        <div style={{
          width: "8.5in",
          boxSizing: "border-box",
          padding: "0",
          background: "#fff",
          position: "relative",
        }}>
          {/* Green header */}
          <div style={{
            background: "#199c2e",
            padding: "0.5in 0.6in 0.4in",
            color: "#fff",
          }}>
            <img src="/pa-header.png" alt="Healthy Homes Public Adjusting" style={{ height: 60, marginBottom: 20, filter: "brightness(0) invert(1)" }} />
            <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 8, lineHeight: 1.1 }}>
              Welcome to Healthy Homes Public Adjusting!
            </div>
            <div style={{ fontSize: 16, opacity: 0.9, lineHeight: 1.5 }}>
              {thankYouOpening}
            </div>
          </div>

          {/* Contact info box */}
          <div style={{ padding: "0.2in 0.5in 0.2in" }}>
            <div style={{
              background: "#f0fdf4",
              border: "2px solid #199c2e",
              borderRadius: 12,
              padding: "20px 24px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#166534", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                Your Point of Contact
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
                <div><strong>Company:</strong> Healthy Homes Public Adjusting</div>
                <div><strong>License:</strong> W435195</div>
                <div><strong>Phone:</strong> 561-283-5674</div>
                <div><strong>Email:</strong> Kkeckleradj@gmail.com</div>
                <div><strong>Website:</strong> propertydamageinspection.com</div>
                <div><strong>Address:</strong> 3570 S Ocean Blvd, South Palm Beach, FL 33480</div>
              </div>
            </div>

            {/* Claim details */}
            <div style={{
              background: "#f8fafc",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: "18px 24px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                Your Claim Details
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, fontSize: 12 }}>
                <div><strong>Name:</strong> {[data.homeowner1, data.homeowner2].filter(Boolean).join(" & ")}</div>
                <div><strong>Date:</strong> {data.date}</div>
                <div><strong>Address:</strong> {[data.address, data.city, data.state, data.zip].filter(Boolean).join(", ")}</div>
                <div><strong>Phone:</strong> {data.phone}</div>
                <div><strong>Insurance Co.:</strong> {data.insuranceCompany}</div>
                <div><strong>Policy #:</strong> {data.policyNumber}</div>
                {data.claimNumber ? <div><strong>Claim #:</strong> {data.claimNumber}</div> : null}
                {data.dateOfLoss ? <div><strong>Date of Loss:</strong> {data.dateOfLoss}</div> : null}
              </div>
            </div>

            {/* What to expect */}
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 10 }}>
              📋 What Happens Next
            </div>
            {activeTYSteps.map((step, i) => (
              <div key={i} style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                marginBottom: 6,
                padding: "7px 10px",
                background: "#f0fdf4",
                borderRadius: 8,
                border: "1px solid #bbf7d0",
              }}>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  background: "#199c2e", color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700, fontSize: 11, flexShrink: 0,
                }}>{i + 1}</div>
                <div style={{ fontSize: 12, color: "#166534", lineHeight: 1.45 }}>{step}</div>
              </div>
            ))}

            {/* Closing */}
            <div style={{
              marginTop: 20,
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 12,
              padding: "16px 20px",
              fontSize: 14,
              color: "#92400e",
              fontWeight: 600,
              textAlign: "center",
              lineHeight: 1.6,
            }}>
              {thankYouClosing}
            </div>

            {/* Footer */}
            <div style={{
              marginTop: 28,
              borderTop: "2px solid #199c2e",
              paddingTop: 14,
              fontSize: 11,
              color: "#6b7280",
              textAlign: "center",
            }}>
              Healthy Homes Public Adjusting • License No: W435195 • Kkeckleradj@gmail.com • 561-283-5674 • propertydamageinspection.com
            </div>
          </div>
        </div>
        </div>
      </div>
{/* ── Hidden Inspection Certificate PDF (for result recording) ── */}
      <div style={{ position: "fixed", left: "-9999px", top: 0, pointerEvents: "none", zIndex: -1 }}>
        <InspectionCertificatePDF
          record={selectedInspRecord}
          result={resultChoice}
          inspectorName={resultInspectorName}
          certNumber={resultCertNumber}
          inspectionDate={resultCertDate}
          fmtDateLong={fmtDateLong}
          fmtDateShort={fmtDateShort}
          addOneYearStr={addOneYearStr}
        />
      </div>
      {/* ── Submitting overlay ── */}
      {isSubmitting ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(6px)",
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 28,
              padding: "48px 40px",
              textAlign: "center",
              maxWidth: 420,
              width: "90%",
              boxShadow: "0 32px 80px rgba(0,0,0,0.4)",
            }}
          >
            {/* Big animated spinner */}
            <div style={{ marginBottom: 28, position: "relative", width: 90, height: 90, margin: "0 auto 28px" }}>
              <div style={{
                width: 90,
                height: 90,
                borderRadius: "50%",
                border: "7px solid #d1fae5",
                borderTop: "7px solid #199c2e",
                animation: "ccg-spin 0.85s linear infinite",
              }} />
              <div style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 32,
              }}>📋</div>
            </div>
            <div style={{
              fontSize: 28,
              fontWeight: 800,
              color: "#111827",
              fontFamily: "'Oswald', sans-serif",
              marginBottom: 10,
              lineHeight: 1.2,
              textTransform: "uppercase",
              letterSpacing: "0.02em",
            }}>
              Processing...
            </div>
            <div style={{
              fontSize: 16,
              color: "#4b5563",
              fontFamily: "'Nunito', sans-serif",
              fontWeight: 600,
              lineHeight: 1.7,
              marginBottom: 24,
            }}>
              Saving your signature, generating your documents, and sending email copies. This takes about 15–30 seconds.
            </div>
            <div style={{
              background: "#fef9c3",
              border: "1.5px solid #fde047",
              borderRadius: 14,
              padding: "12px 18px",
              fontSize: 15,
              fontWeight: 700,
              color: "#713f12",
              fontFamily: "'Nunito', sans-serif",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}>
              ⚠️ Please keep this screen open
            </div>
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes ccg-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes ccg-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 6px 20px rgba(25,156,46,0.45); }
          50% { transform: scale(1.04); box-shadow: 0 8px 28px rgba(25,156,46,0.65); }
        }
        @keyframes ccg-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
      `}</style>

    </div>
  );
}