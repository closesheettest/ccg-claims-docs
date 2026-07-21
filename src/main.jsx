import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import InstallPrompt from "./InstallPrompt";

// Remember where THIS user belongs so the installed app icon opens straight to
// their tools (their personal link carries their token). Reps open ?rt=…, the
// office opens ?admin=…; save that URL as the app's "home" the first time.
try {
  const p = new URLSearchParams(window.location.search);
  if (p.get("rt") || p.get("admin") || p.get("manager") || p.get("pa")) {
    localStorage.setItem("pwa_home", window.location.href);
  }
} catch { /* ignore */ }

// Register the service worker (required for install). It's a no-cache passthrough,
// so it never serves a stale build.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* non-fatal */ });
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    <InstallPrompt />
  </React.StrictMode>
);
