// A friendly "install this app" prompt so reps don't have to be walked through
// the hidden Add-to-Home-Screen menu. On Android/Chrome/Edge (phone + desktop)
// it captures the native install event and installs in one tap. On iPhone/iPad
// (which has no install button) it shows the exact Share → Add to Home Screen steps.
import React, { useEffect, useState } from "react";

const OSWALD = "'Oswald', sans-serif";

function isStandalone() {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  } catch { return false; }
}
function isIOS() {
  const ua = navigator.userAgent || "";
  const iDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as Mac; catch it via touch.
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iDevice || iPadOS;
}
// On iOS, "Add to Home Screen" ONLY exists in real Safari — not Chrome (CriOS),
// Firefox (FxiOS), the Google app (GSA), or an in-app browser (Instagram/FB/Gmail
// webviews, which lack the Safari/Version tokens). Detect the wrong browser so we
// can tell the user to open the link in Safari first.
function isIOSSafari() {
  if (!isIOS()) return false;
  const ua = navigator.userAgent || "";
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|mercury|GSA|DuckDuckGo|Brave/i.test(ua);
  const looksLikeSafari = /Safari/i.test(ua) && /Version\//i.test(ua);
  return looksLikeSafari && !otherBrowser;
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null); // Android/desktop native prompt event
  const [show, setShow] = useState(false);
  const [helpMode, setHelpMode] = useState(null); // null | "add" (iOS Safari steps) | "safari" (wrong browser)

  useEffect(() => {
    if (isStandalone()) return;                    // already installed → nothing to do
    try { if (localStorage.getItem("pwa_install_dismissed") === "1") return; } catch { /* ignore */ }

    const onBip = (e) => { e.preventDefault(); setDeferred(e); setShow(true); };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", () => { setShow(false); setDeferred(null); });

    // iOS never fires beforeinstallprompt — show the manual hint after a beat.
    let t;
    if (isIOS()) t = setTimeout(() => setShow(true), 1200);

    return () => { window.removeEventListener("beforeinstallprompt", onBip); if (t) clearTimeout(t); };
  }, []);

  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem("pwa_install_dismissed", "1"); } catch { /* ignore */ }
  };
  const install = async () => {
    if (deferred) {
      deferred.prompt();
      try { await deferred.userChoice; } catch { /* ignore */ }
      setDeferred(null); setShow(false);
    } else if (isIOS()) {
      // In Safari → show Add-to-Home-Screen steps. In Chrome / an in-app browser
      // (where Add-to-Home-Screen doesn't exist) → tell them to open in Safari.
      setHelpMode(isIOSSafari() ? "add" : "safari");
    }
  };

  if (!show) return null;
  const iosNonSafari = isIOS() && !isIOSSafari();
  const gotIt = { width: "100%", background: "rgba(255,255,255,.15)", color: "#fff", border: "none", borderRadius: 10, padding: "9px", fontSize: 13, fontWeight: 700, cursor: "pointer" };
  const title = { fontFamily: OSWALD, fontWeight: 800, fontSize: 15, marginBottom: 6 };
  const ol = { margin: "0 0 10px 18px", padding: 0, fontSize: 13.5, lineHeight: 1.6 };

  return (
    <div style={{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 100000, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ pointerEvents: "auto", background: "#13294b", color: "#fff", borderRadius: 14, boxShadow: "0 6px 24px rgba(0,0,0,.35)", padding: "12px 14px", width: "min(440px, 100%)", boxSizing: "border-box" }}>
        {helpMode === "safari" ? (
          <div>
            <div style={title}>🧭 Open this in Safari first</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, marginBottom: 10 }}>
              To add the app to your iPhone it has to be in <b>Safari</b> — Chrome and in-app browsers can't do it.
            </div>
            <ol style={ol}>
              <li>Tap the <b>⋯</b> menu or the <b>Share</b> button.</li>
              <li>Choose <b>"Open in Safari."</b></li>
              <li>In Safari, tap <b>Share ↑ → "Add to Home Screen" → Add.</b></li>
            </ol>
            <button type="button" onClick={dismiss} style={gotIt}>Got it</button>
          </div>
        ) : helpMode === "add" ? (
          <div>
            <div style={title}>📲 Add to your Home Screen</div>
            <ol style={ol}>
              <li>Tap the <b>Share</b> button (the square with an ↑ arrow at the bottom).</li>
              <li>Scroll down and tap <b>"Add to Home Screen."</b></li>
              <li>Tap <b>Add</b> — the U.S. Shingle icon lands on your home screen.</li>
            </ol>
            <button type="button" onClick={dismiss} style={gotIt}>Got it</button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img src="/icon-192.png" alt="" width={40} height={40} style={{ borderRadius: 9, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: OSWALD, fontWeight: 800, fontSize: 14.5 }}>Install the U.S. Shingle app</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 1 }}>
                {iosNonSafari
                  ? "Open in Safari, then add it to your home screen."
                  : `Add it to your ${isIOS() ? "home screen" : "phone or desktop"} — opens right to your tools.`}
              </div>
            </div>
            <button type="button" onClick={install} style={{ flexShrink: 0, background: iosNonSafari ? "#f59e0b" : "#16a34a", color: iosNonSafari ? "#111827" : "#fff", border: "none", borderRadius: 10, padding: "9px 14px", fontSize: 13.5, fontWeight: 800, fontFamily: OSWALD, cursor: "pointer" }}>
              {isIOS() ? (iosNonSafari ? "Open in Safari" : "How?") : "Install"}
            </button>
            <button type="button" onClick={dismiss} aria-label="Dismiss" style={{ flexShrink: 0, background: "transparent", color: "#fff", border: "none", fontSize: 18, fontWeight: 800, cursor: "pointer", padding: "0 2px", opacity: 0.8 }}>✕</button>
          </div>
        )}
      </div>
    </div>
  );
}
