// src/BackBar.jsx
//
// "← Back" for a full-screen tool page.
//
// Report tiles used to open in a new tab, which left people stranded: no back
// button, no way home, and a pile of tabs. The tiles are proper links now, so
// browser Back works — but a page can still be opened cold (a texted link, the
// installed app, a bookmark), and on a phone the browser chrome is often hidden
// anyway. So every tool page carries its own way out (Neal, 2026-08-21).
//
// Goes back through history when there is history to go back through; otherwise
// falls back to wherever this person came from, and finally to the front door.
import React from "react";

export default function BackBar({ label = "Back", home = "/?mode=mytools", style }) {
  const go = () => {
    try {
      if (window.history.length > 1) { window.history.back(); return; }
      const ref = document.referrer;
      if (ref && new URL(ref).origin === window.location.origin) { window.location.href = ref; return; }
    } catch { /* fall through to home */ }
    window.location.href = home;
  };
  return (
    <button type="button" onClick={go} title="Back to where you came from"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 9,
        border: "1px solid #cbd5e1", background: "#fff", color: "#334155", fontWeight: 800,
        fontSize: 12.5, cursor: "pointer", fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        ...style,
      }}>
      ← {label}
    </button>
  );
}
