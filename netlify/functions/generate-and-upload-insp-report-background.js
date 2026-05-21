// netlify/functions/generate-and-upload-insp-report-background.js
//
// Background variant of generate-and-upload-insp-report. The -background
// filename suffix tells Netlify to run this as a Background Function:
//   • Returns 202 to the caller immediately
//   • Runs up to 15 minutes (vs. 10 seconds for regular functions)
//
// This is the path used by push-result-to-jn, process-retail-result, and
// inspector-submit-result — anywhere we want the cert to upload without
// blocking the user-facing request. The regular -insp-report.js file
// still exists for callers that need a synchronous response (like the
// bulk-generate batch runner).
//
// Same input contract as the regular function: { jnid }.

const { handler: regularHandler } = require("./generate-and-upload-insp-report.js");

exports.handler = regularHandler;
