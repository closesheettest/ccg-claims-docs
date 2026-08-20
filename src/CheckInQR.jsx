// src/CheckInQR.jsx
//
// THE DOOR POSTER  (/?mode=checkinqr)
//
// A printable sign for the wall by the door: people scan it on the way in and
// it checks them in. The QR points at /timecard?checkin=1 — the time card
// honours that flag by checking them in the moment it loads (see Today in
// TimeCard.jsx), so a scan is one action, not "open app, find button, tap".
//
// Anyone who isn't signed in yet lands on the sign-in screen with the flag
// still in the URL, so they check in as soon as they finish signing in.
//
// Styled to print: A4/Letter portrait, no chrome, black on white.

import React, { useEffect, useState } from "react";
import QRCode from "qrcode";

const NAVY = "#0f2a4a", INK = "#16233b", MUTE = "#5b6b8c";

// The code must carry the TIME CARD's own address, never window.location.origin.
// This page is also served through the internal dashboard's /payroll/* proxy, and
// building the code from that origin produced https://ussm-dashboards…/timecard,
// which doesn't exist there — a printed sign that scanned to a 404.
const APP_ORIGIN = "https://free-roof-inspections.netlify.app";

export default function CheckInQR() {
  const origin = APP_ORIGIN;
  const link = `${origin}/checkin`;
  const [qr, setQr] = useState("");
  const [size, setSize] = useState(900);

  useEffect(() => {
    let live = true;
    // High error correction: this gets printed, taped to a wall, and scanned
    // from a few feet away in bad light.
    QRCode.toDataURL(link, { width: size, margin: 1, errorCorrectionLevel: "H" })
      .then((u) => { if (live) setQr(u); })
      .catch(() => {});
    return () => { live = false; };
  }, [link, size]);

  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: INK, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 12mm; }
        }
      `}</style>

      <div className="no-print" style={{ display: "flex", gap: 10, justifyContent: "center", padding: "14px 12px", flexWrap: "wrap", background: "#f4f7fb", borderBottom: "1px solid #e2e8f2" }}>
        <button onClick={() => window.print()} style={{ background: NAVY, color: "#fff", border: "none", borderRadius: 10, padding: "11px 20px", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
          🖨️ Print this sign
        </button>
        <a href={qr || "#"} download="ussm-checkin-qr.png" style={{ background: "#fff", color: NAVY, border: "1.5px solid #e2e8f2", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
          ⬇ Download the QR only
        </a>
        <select value={size} onChange={(e) => setSize(Number(e.target.value))}
          style={{ borderRadius: 10, border: "1.5px solid #e2e8f2", padding: "10px 12px", fontSize: 14, background: "#fff" }}>
          <option value={600}>Small QR</option>
          <option value={900}>Medium QR</option>
          <option value={1400}>Large QR</option>
        </select>
        <div style={{ fontSize: 12.5, color: MUTE, alignSelf: "center", maxWidth: 460 }}>
          Scanning checks the person in straight away. First time, they'll sign in with their mobile number first — then it checks them in.
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "34px 24px 40px", textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 2, color: MUTE, textTransform: "uppercase" }}>U.S. Shingle &amp; Metal</div>
        <div style={{ fontSize: 46, fontWeight: 900, color: NAVY, lineHeight: 1.05, margin: "8px 0 4px" }}>Scan to check in</div>
        <div style={{ fontSize: 18, color: MUTE, marginBottom: 22 }}>Point your phone camera at the code when you arrive.</div>

        {qr ? (
          <img src={qr} alt="Check-in QR code" style={{ width: "min(78vw, 420px)", height: "auto", display: "block", margin: "0 auto" }} />
        ) : (
          <div style={{ height: 300, display: "flex", alignItems: "center", justifyContent: "center", color: MUTE }}>Generating…</div>
        )}

        <div style={{ marginTop: 20, fontSize: 16, color: INK, lineHeight: 1.6 }}>
          <div><b>First time?</b> It asks for your mobile number, then you pick your own 4–8 digit passcode.</div>
          <div style={{ marginTop: 6 }}>At the end of your shift, open it again and say what you got done.</div>
        </div>

        <div style={{ marginTop: 22, fontSize: 14, color: MUTE }}>
          No camera? Go to <b style={{ color: INK }}>{origin.replace(/^https?:\/\//, "")}/checkin</b>
        </div>
      </div>
    </div>
  );
}
