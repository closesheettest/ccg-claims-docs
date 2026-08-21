// src/BtrInventory.jsx
//
// ?mode=btrinventory — BTR Deal Inventory. Back-to-retail deals, columns from
// the shared _retail classifier. Same board as the PA inventory.
//
// Read it knowing the classifier trusts a RECORDED OUTCOME over the JobNimbus
// status: the office often leaves a deal at "Sit Sold Insp" long after the rep
// recorded what happened, so reading JN alone would show worked deals as
// never-worked.
import React from "react";
import DealBoard from "./DealBoard";

export default function BtrInventory() {
  return (
    <DealBoard
      feed="btr-inventory"
      title="🏠 BTR Deal Inventory"
      blurb="Every back-to-retail deal, in the column it's actually in. Columns come from the same classifier the BTR reports use."
      stats={(t) => [
        { n: t.deals, l: "live deals" },
        { n: t.open, l: "still open", c: "#b45309" },
        { n: t.sold, l: "sold", c: "#16a34a" },
        { n: t.appt_open, l: "appt not closed out", c: "#c2410c" },
      ]}
    />
  );
}
