// netlify/functions/inspection-checker.js
// Polls JN for jobs where cf_string_34 changed to "Damage"
// If only insp was signed → texts the sales rep via GHL
// No other notifications — reps only, damage only

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY  = process.env.JOBNIMBUS_API_KEY;
const SB_URL  = process.env.VITE_SUPABASE_URL;
const SB_KEY  = process.env.VITE_SUPABASE_ANON_KEY;

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  console.log("=== Inspection Checker Start ===");

  try {
    // ── 1. Fetch recently updated JN jobs ──────────────────────
    // Get jobs updated in the last 7 days, large enough batch
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const jnRes = await fetch(
      `${JN_BASE}/jobs?size=100&sort=-date_updated&date_updated_after=${since}`,
      { headers: jnHeaders }
    );

    if (!jnRes.ok) {
      const err = await jnRes.text();
      console.error("JN fetch failed:", jnRes.status, err);
      return { statusCode: 500, body: JSON.stringify({ error: "JN fetch failed" }) };
    }

    const jnData = await jnRes.json();
    const allJobs = jnData.results || jnData.jobs || [];
    console.log("JN jobs fetched:", allJobs.length);

    // Filter to only jobs where cf_string_34 === "Damage"
    const damageJobs = allJobs.filter(j => j.cf_string_34 === "Damage");
    console.log("Damage jobs found:", damageJobs.length);

    if (damageJobs.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No damage jobs found", checked: allJobs.length, damage: 0 }),
      };
    }

    const results = [];

    for (const job of damageJobs) {
      const jnJobId = job.jnid || job.id;
      console.log("Checking job:", jnJobId, job.name);

      // ── 2. Find matching Supabase inspection record ──────────
      const sbRes = await fetch(
        `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${jnJobId}&select=id,client_name,address,sales_rep_id,inspection_result,inspection_notified_at,docs_signed&limit=1`,
        { headers: sbHeaders }
      );

      if (!sbRes.ok) {
        console.warn("Supabase lookup failed for job:", jnJobId);
        continue;
      }

      const sbData = await sbRes.json();
      if (!sbData || sbData.length === 0) {
        console.log("No Supabase record for JN job:", jnJobId);
        continue;
      }

      const record = sbData[0];
      console.log("Found record:", record.id, "| result:", record.inspection_result, "| docs:", record.docs_signed);

      // Skip if already notified about damage
      if (record.inspection_result === "Damage") {
        console.log("Already notified — skipping:", jnJobId);
        continue;
      }

      // Skip if not insp-only (must have only signed insp, not lor or pac)
      const docsSigned = record.docs_signed || "";
      const hasLor = docsSigned.includes("lor");
      const hasPac = docsSigned.includes("pac");
      if (hasLor || hasPac) {
        console.log("LOR or PA already signed — no SMS needed for:", jnJobId);
        // Still update the result silently
        await updateInspectionResult(record.id, "Damage", false);
        results.push({ job: jnJobId, action: "updated_no_sms", reason: "lor_or_pac_signed" });
        continue;
      }

      // ── 3. Get rep phone from sales_reps table ───────────────
      let repPhone = null;
      let repName  = null;
      if (record.sales_rep_id) {
        const repRes = await fetch(
          `${SB_URL}/rest/v1/sales_reps?jobnimbus_id=eq.${record.sales_rep_id}&select=name,phone&limit=1`,
          { headers: sbHeaders }
        );
        if (repRes.ok) {
          const repData = await repRes.json();
          if (repData && repData.length > 0) {
            repPhone = repData[0].phone;
            repName  = repData[0].name;
          }
        }
      }

      console.log("Rep:", repName, "| Phone:", repPhone);

      if (!repPhone) {
        console.warn("No rep phone found for job:", jnJobId, "rep_id:", record.sales_rep_id);
        // Still update result so we don't keep checking
        await updateInspectionResult(record.id, "Damage", false);
        results.push({ job: jnJobId, action: "updated_no_sms", reason: "no_rep_phone" });
        continue;
      }

      // ── 4. Send SMS via GHL ──────────────────────────────────
      const clientName = record.client_name || "Your homeowner";
      const address    = record.address || "their address";
      const message    = `🚨 ${clientName} at ${address} has DAMAGE — call them immediately and get them to sign PA paperwork!`;

      console.log("Sending SMS to:", repPhone, "| Message:", message);

      const baseUrl = process.env.URL || "https://ccg-claims-docs.netlify.app";
      const smsRes = await fetch(`${baseUrl}/.netlify/functions/ghl-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: repPhone,
          message,
          name: repName || "Sales Rep",
        }),
      });

      const smsText = await smsRes.text();
      console.log("SMS result:", smsRes.status, smsText);

      // ── 5. Update Supabase record ────────────────────────────
      await updateInspectionResult(record.id, "Damage", smsRes.ok);

      results.push({
        job: jnJobId,
        client: clientName,
        rep: repName,
        action: smsRes.ok ? "sms_sent" : "sms_failed",
        sms_status: smsRes.status,
      });
    }

    console.log("=== Inspection Checker Complete ===", JSON.stringify(results));
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Check complete",
        checked: allJobs.length,
        damage_found: damageJobs.length,
        results,
      }),
    };

  } catch (err) {
    console.error("=== Inspection Checker ERROR ===", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Helper: update inspection_result in Supabase ─────────────────
async function updateInspectionResult(recordId, result, notified) {
  const payload = { inspection_result: result };
  if (notified) payload.inspection_notified_at = new Date().toISOString();

  const res = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${recordId}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    }
  );
  console.log("Supabase update:", res.status, "for record:", recordId);
}