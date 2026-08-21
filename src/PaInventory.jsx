// src/PaInventory.jsx
//
// ?mode=painventory — PA Deal Inventory (New). Damage deals, columns from the
// shared BTPA classifier. The board itself is DealBoard, shared with the BTR
// inventory so the two can't drift apart.
import React from "react";
import DealBoard from "./DealBoard";

export default function PaInventory() {
  return (
    <DealBoard
      feed="pa-inventory"
      title="🗂️ PA Deal Inventory"
      tag="(New)"
      blurb="Every damage deal, in the column it's actually in. Columns come from the same classifier the master report uses."
      stats={(t) => [
        { n: t.deals, l: "live deals" },
        { n: t.unsigned, l: "not signed", c: "#b45309" },
        { n: t.no_pa, l: "no PA assigned", c: "#b91c1c" },
        { n: t.appt_open, l: "appt not closed out", c: "#c2410c" },
      ]}
    />
  );
}
