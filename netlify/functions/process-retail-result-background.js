// netlify/functions/process-retail-result-background.js
//
// Background variant of process-retail-result. The -background filename
// suffix tells Netlify to run this as a Background Function:
//   • Returns 202 to the caller immediately
//   • Runs up to 15 minutes (vs. 10 seconds for regular functions)
//
// Used by confirm-inspection-result so a RETAIL confirm doesn't block on the
// slow retail transition (PDFShift cert + JN record_type swap + file upload).
// Before this, that await could exceed the request timeout → the browser got
// a 502 even though the work completed (a false "confirm failed"). Now the
// confirm returns immediately and the retail work finishes in the background.
//
// Same input contract as the regular function: { inspectionId, skip_cert }.

const { handler: regularHandler } = require("./process-retail-result.js");

exports.handler = regularHandler;
