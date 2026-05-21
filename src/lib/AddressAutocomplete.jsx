// Google Places Autocomplete — shared component + loader.
//
// Extracted from App.jsx so it can be imported by both App.jsx and
// InspectorViews.jsx (avoiding a circular import). The component
// surface is unchanged: callers that pass `onPlaceSelected` receive
// `{ address, city, state, zip, formatted }` as before. We additionally
// emit `lat` and `lng` (when Google returns them on the selected place)
// so callers can save coordinates without a second geocode round-trip.
//
// The legacy google.maps.places.Autocomplete class was deprecated for
// new customers in March 2025
// (https://developers.google.com/maps/documentation/javascript/places-migration-overview),
// so we use the newer PlaceAutocompleteElement Web Component here.

import React from "react";

const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_PLACES_API_KEY || "";
let googlePlacesLoadPromise = null;

export const loadGooglePlaces = () => {
  if (typeof window === "undefined") return Promise.reject(new Error("not in browser"));
  if (window.google?.maps?.places?.PlaceAutocompleteElement) return Promise.resolve(window.google);
  if (googlePlacesLoadPromise) return googlePlacesLoadPromise;
  if (!GOOGLE_API_KEY) {
    return Promise.reject(new Error("VITE_GOOGLE_PLACES_API_KEY is not set in environment variables"));
  }
  googlePlacesLoadPromise = new Promise((resolve, reject) => {
    document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]').forEach((s) => s.remove());
    if (window.google?.maps && !window.google.maps.importLibrary) {
      try { delete window.google.maps; } catch (_) { window.google.maps = undefined; }
    }
    // Google's official bootstrap loader pattern.
    (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({
      key: GOOGLE_API_KEY,
      v: "weekly",
    });
    window.google.maps
      .importLibrary("places")
      .then(() => resolve(window.google))
      .catch(reject);
  });
  return googlePlacesLoadPromise;
};

export function AddressAutocomplete({ value, onChange, onPlaceSelected, placeholder, style, errorBorder, id }) {
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
        const el = new google.maps.places.PlaceAutocompleteElement({
          includedRegionCodes: ["us"],
        });
        el.style.width = "100%";
        elementRef.current = el;
        el.addEventListener("gmp-select", async (event) => {
          try {
            const place = event.placePrediction.toPlace();
            // Fetch the fields we care about — address breakdown PLUS
            // lat/lng so callers can save coordinates directly.
            await place.fetchFields({
              fields: ["addressComponents", "formattedAddress", "location"],
            });
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
            // Google's `location` is a LatLng — extract numeric values.
            const loc = place.location;
            const lat = loc && typeof loc.lat === "function" ? loc.lat() : loc?.lat;
            const lng = loc && typeof loc.lng === "function" ? loc.lng() : loc?.lng;
            setVerified(true);
            onPlaceSelected?.({
              address: fullAddr,
              city,
              state,
              zip,
              formatted: place.formattedAddress || fullAddr,
              lat: typeof lat === "number" ? lat : null,
              lng: typeof lng === "number" ? lng : null,
            });
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

  React.useEffect(() => {
    if (!elementRef.current) return;
    try {
      if (typeof elementRef.current.value !== "undefined") {
        elementRef.current.value = value || "";
      }
    } catch (_) { /* ignore */ }
    if (!value) setVerified(false);
  }, [value]);

  return (
    <div style={{ position: "relative" }}>
      {loadError ? (
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
