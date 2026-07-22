// netlify/functions/_jn.js
//
// Shared JobNimbus fetch with transient-retry, imported by every function that
// talks to JN. Files whose name begins with "_" are NOT deployed as their own
// endpoint — they're helper modules (same convention as _appt-conversion.js).
//
// jnFetch is a DROP-IN for `fetch(`${JN_BASE}/${path}`, opts)` — it returns the
// raw Response so each caller keeps its own .ok / .json / .catch handling. It
// only adds the auth headers and a retry loop, so behavior is otherwise
// identical to the inline fetch it replaces.
//
// Why: a single transient JobNimbus blip (network drop, gateway/timeout,
// rate-limit) used to surface to a human as a scary "didn't sync" / "no results"
// and make them redo the action by hand (which is how duplicates get created).
// We retry the classic transient statuses + network throws, 3x with backoff.
// A 500 is deliberately NOT retried, so a POST retry can never duplicate a
// just-created record (a 500 might mean the write partially applied).

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_RETRY_STATUS = new Set([429, 502, 503, 504]);

// key: the JOBNIMBUS_API_KEY the caller already has in scope.
// path: everything after the base, e.g. `jobs/${id}` or `contacts?filter=...`.
// opts: { method?, body?, headers? } — same shape you'd pass to fetch().
async function jnFetch(key, path, opts = {}, tries = 3) {
  const headers = {
    Authorization: `bearer ${key}`,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  // 500 is only unsafe to retry on POST (a create might have partially applied →
  // retrying could duplicate). PUT / GET / DELETE are idempotent: the same call
  // yields the same result, so a transient JN 500 there is safe to retry — which
  // is what was surfacing as a scary "500 Internal Server Error" on reschedules.
  const method = (opts.method || "GET").toUpperCase();
  const retryStatus = method === "POST" ? JN_RETRY_STATUS : new Set([...JN_RETRY_STATUS, 500]);
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${JN_BASE}/${path}`, { ...opts, headers });
      // Success, or a non-transient error the caller will report itself.
      if (r.ok || !retryStatus.has(r.status)) return r;
      last = new Error(`JN ${path} ${r.status}`);
    } catch (e) {
      last = e; // network error / timeout — retry
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 350 * (i + 1)));
  }
  throw last;
}

// Assign a rep to a CONTACT (not just the job). JobNimbus only shows a contact's
// phone/email to reps who OWN the contact — so if we set the rep on the job but not
// the contact, the rep sees the deal on their board but can't call the homeowner.
// Setting sales_rep at the contact level sometimes throws a Couchbase key error, so
// we try owners+sales_rep first, then fall back to owners alone. Best-effort: never
// throws (a failed contact-assign must not sink the booking/signing it rides along).
async function assignContactOwner(key, contactId, ownerId) {
  if (!contactId || !ownerId) return false;
  try {
    let r = await jnFetch(key, `contacts/${contactId}`, { method: "PUT", body: JSON.stringify({ owners: [{ id: ownerId }], sales_rep: ownerId }) });
    if (!r.ok) r = await jnFetch(key, `contacts/${contactId}`, { method: "PUT", body: JSON.stringify({ owners: [{ id: ownerId }] }) });
    return r.ok;
  } catch { return false; }
}

export { JN_BASE, JN_RETRY_STATUS, jnFetch, assignContactOwner };
