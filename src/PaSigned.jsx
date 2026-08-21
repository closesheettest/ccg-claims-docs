// src/PaSigned.jsx
//
// ?mode=pasigned — PA Signed Status (New). Every claim a PA has actually signed,
// in the column matching how far it's got since. The PA Deal Inventory stops at
// "signed"; this board is what happens after.
//
// Same DealBoard as the other two, so the three can't drift apart.
import React from "react";
import DealBoard from "./DealBoard";

export default function PaSigned() {
  return (
    <DealBoard
      feed="pa-signed"
      title="✍️ PA Signed Status"
      tag="(New)"
      blurb="Claims the PA has signed, by how far they've got: filed → coverage opened → settlement → closed. Signed means the Five Star rule, not the optimistic “Sit Sold PA” status."
      stats={(t) => [
        { n: t.deals, l: "signed claims" },
        { n: t.in_flight, l: "still in flight", c: "#0e7490" },
        { n: t.stalled, l: "signed 14+ days, nothing filed", c: "#b45309" },
      ]}
    />
  );
}
