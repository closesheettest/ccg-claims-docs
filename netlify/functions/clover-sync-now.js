// netlify/functions/clover-sync-now.js
//
// Manual, on-demand trigger for the 🍀 Clover Leaf sync. The real worker
// (cron-install-blitz) is a SCHEDULED function, and Netlify 403s any direct HTTP
// call to a scheduled function — so the "Sync now" button (and a human wanting to
// run it off-cycle) can't hit it. This thin, NON-scheduled wrapper invokes the
// same handler with commit=1 so it actually writes.
//
//   GET/POST /.netlify/functions/clover-sync-now
//
// Both files are ESM (package type:module), so importing the handler is safe.

import { handler as blitz } from "./cron-install-blitz.js";

export const handler = async (event) => {
  // Force a committing run regardless of how we were called.
  return blitz({ httpMethod: (event && event.httpMethod) || "POST", queryStringParameters: { commit: "1" } });
};
