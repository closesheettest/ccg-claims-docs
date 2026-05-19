# PA Ops Hub ↔ CCG Claims Docs — bidirectional integration

This doc covers everything the PA's dev team needs to wire up the status
callback. The first half (our app → your app) is already live. The
second half (your app → our app) is what's new.

---

## 1. What we already send you (already live)

When the manager at U.S. Shingle & Metal records an inspection as
"Damage" in our app, we automatically POST a Property Damage Notice
(PDN) submission to your intake endpoint.

**Endpoint we POST to (yours):**
```
POST https://bgeovgtzwgtcyfemnsvh.supabase.co/functions/v1/submit-intake
Content-Type: multipart/form-data
```

**Required fields we always send:**
- `source` = `field_partner_hub`
- `submitter_type` = `partner`
- `consent_intake` = `true`
- `consent_disclaimer_acknowledged` = `true`
- `damage_type_slug` = `roof`

**Homeowner + property:**
- `homeowner_name`
- `property_address`, `property_city`, `property_state`, `property_zip`
- `homeowner_phone`, `homeowner_email`

**Cross-link references (use these to tie back to our system):**
- `partner_inspection_id` — **THIS is the ID you'll need to send back in the callback.** It's a UUID, e.g. `5b13e428-1234-...`. Store it on your PDN record so your "Signed/Refused" buttons can reference it.
- `partner_jn_job_id` — JobNimbus job ID (extra cross-link, not required to use)
- `inspector_name`, `cert_number`, `sales_rep_name`, `damage_recorded_at`

**File attachments:**
- `signed_inspection_pdf` — the signed Free Roof Inspection Agreement PDF
- `photo_1`, `photo_2`, ... up to ~20 inspection photos pulled from JobNimbus

---

## 2. What you need to build — status callback

Your team mentioned you'd like two buttons on each PDN in your app:
- **"Customer signed PA forms"** → POST `pa_status: "signed"` to our callback
- **"Refused to sign"** → POST `pa_status: "refused"` to our callback

Until either button is clicked, our app shows the PDN as **"⏳ PA: PENDING"**
(default — we stamp it the moment we send you the PDN). When you fire
the callback, our app immediately updates to **"🤝 PA: SIGNED"** or
**"🚫 PA: REFUSED"**.

### Our callback endpoint (POST to this)

```
POST https://ccg-claims-docs.netlify.app/.netlify/functions/pa-ops-hub-status-callback
Content-Type: application/json
Authorization: Bearer <PA_OPS_HUB_CALLBACK_SECRET>
```

### Request body (JSON)

```json
{
  "partner_inspection_id": "5b13e428-1234-4321-abcd-1234567890ab",
  "pa_status": "signed",
  "notes": "Customer signed both LoR and PAC on 2026-05-19. Optional context."
}
```

**Fields:**
| Field | Required | Allowed values | Notes |
|---|---|---|---|
| `partner_inspection_id` | yes | UUID string | The exact value we sent you in the original PDN. Use it to identify which inspection this status update is for. |
| `pa_status` | yes | `"signed"`, `"refused"`, `"pending"` | Lowercase. Sending `"pending"` reverts to the default "we're working on it" state. |
| `notes` | no | free text, max 2000 chars | Optional context shown in the admin tooltip — useful for "customer wanted to think about it" type notes. |

### Auth — shared secret

We'll send you a secret string out-of-band (separate channel, not in
this doc). On every callback request, send it as a Bearer token in the
`Authorization` header. Missing or wrong = 401.

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true,
  "updated": 1,
  "inspection_id": "5b13e428-1234-4321-abcd-1234567890ab",
  "pa_status": "signed",
  "pa_status_updated_at": "2026-05-19T18:23:14.000Z"
}
```

### Error responses

| HTTP | Body `error` | Cause |
|---|---|---|
| 400 | `Invalid JSON body` | Body wasn't valid JSON |
| 400 | `partner_inspection_id required` | Missing field |
| 400 | `pa_status must be one of: signed, refused, pending` | Bad status value |
| 401 | `Invalid or missing Authorization bearer token` | Auth failed |
| 404 | `No inspection found with that partner_inspection_id` | UUID doesn't match any record we have |
| 405 | `Method not allowed` | Used GET, PUT, etc instead of POST |
| 500 | `Supabase update <status>` + detail | Our DB write failed; retry later |

### Idempotency

Re-sending the same status is harmless. Each call also updates the
`pa_status_updated_at` timestamp, so re-firing also serves as "we
re-confirmed at this time" which is fine.

If you want to revert a button click (e.g., the customer was a no-show
and you marked refused but they later signed), just fire the callback
again with the new status. We'll just overwrite.

### Example: curl

```bash
curl -X POST https://ccg-claims-docs.netlify.app/.netlify/functions/pa-ops-hub-status-callback \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer THE_SHARED_SECRET" \
  -d '{
    "partner_inspection_id": "5b13e428-1234-4321-abcd-1234567890ab",
    "pa_status": "signed",
    "notes": "Customer signed both LoR + PAC in person at the property."
  }'
```

### Example: fetch (browser / Node)

```javascript
async function reportStatusToPartner(partnerInspectionId, status, notes) {
  const res = await fetch(
    'https://ccg-claims-docs.netlify.app/.netlify/functions/pa-ops-hub-status-callback',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CCG_CALLBACK_SECRET}`,
      },
      body: JSON.stringify({
        partner_inspection_id: partnerInspectionId,
        pa_status: status,
        notes: notes || undefined,
      }),
    }
  )
  if (!res.ok) {
    const errBody = await res.text()
    console.error('Callback failed', res.status, errBody)
    return false
  }
  return true
}

// In your button handlers:
async function onSignedClick(pdn) {
  await reportStatusToPartner(pdn.partner_inspection_id, 'signed')
  // ... update your local UI ...
}
async function onRefusedClick(pdn) {
  await reportStatusToPartner(pdn.partner_inspection_id, 'refused')
}
```

---

## 3. Quick test plan

Once you've wired up the buttons:

1. **End-to-end test:** Wait for a real damage record to come through.
   - Our manager records damage → we POST PDN to your `/submit-intake` → status shows **⏳ PA: PENDING** in our app
   - You click **"Customer signed PA forms"** in your app → callback fires → our app updates to **🤝 PA: SIGNED**
2. **Or hit the curl example above with a real `partner_inspection_id`** from a recent PDN. Should get a 200 OK with the updated status.

If anything 4xx/5xxs, share the response body and we can dig in.

---

## 4. UI on our side (what your team will see in our app)

Each damage record in our **Record Lookup → Last 30 Days / Search /
Pending** views shows two pills stacked vertically:

```
⚠️ Damage           ← inspection result (our existing pill)
⏳ PA: PENDING      ← waiting for your team's button click
```

After you fire the callback:

```
⚠️ Damage
🤝 PA: SIGNED       ← or 🚫 PA: REFUSED
```

Hovering the PA pill shows the timestamp + notes. Helps our manager see
at a glance who's done and who's stuck.

---

## 5. What to send us

Out-of-band (Signal / email / phone), please share:
- Confirmation you've received this doc
- Any pushback on field names (e.g. if you'd rather we call it
  `client_name` instead of `homeowner_name` in our outbound PDN — we
  can rename in one quick commit)
- The shared secret you want to use (or we generate one and send to you)

Then we both flip our respective env vars (`PA_OPS_HUB_CALLBACK_SECRET`
on our side; whatever you call it on yours) to the same value, redeploy,
and you're good to test.

---

## 6. Contact

Neal Scoppettuolo — CCG Claims Docs side of the integration.

Tech stack on our end (in case it matters for debugging):
- Netlify Functions (Node 18+ runtime)
- Supabase Postgres + Storage (`signed-documents` bucket)
- JobNimbus API (we pull inspection photos from there)
