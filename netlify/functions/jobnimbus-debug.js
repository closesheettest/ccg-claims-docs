exports.handler = async (event) => {
  const apiKey = process.env.JOBNIMBUS_API_KEY;
  if (!apiKey) return { statusCode: 500, body: "No API key" };

  const results = {};
  const JN = "https://app.jobnimbus.com/api1";
  const hdrs = { Authorization: `bearer ${apiKey}`, "Content-Type": "application/json" };

  try {
    // 1. Get full account settings
    const s1 = await fetch(`${JN}/account/settings`, { headers: hdrs });
    const s1data = await s1.json();
    results.settings_keys = Object.keys(s1data);
    results.custom_fields_job = s1data.custom_fields_job || [];
    results.custom_fields_job_raw = JSON.stringify(s1data.custom_fields_job).slice(0, 2000);
    results.workflows_names = (s1data.workflows || []).map(w => `${w.id}:${w.name}:${w.object_type}`);

    // 2. Get the Super Man job we created - full fields
    const jobId = "mnrrzc5w9p954fzslvukjca";
    const j1 = await fetch(`${JN}/jobs/${jobId}`, { headers: hdrs });
    const j1data = await j1.json();
    results.job_all_keys = Object.keys(j1data);
    results.job_full = JSON.stringify(j1data);

    // 3. Get most recently updated job (may have manually set fields)
    const j2 = await fetch(`${JN}/jobs?size=3&sort=-date_updated`, { headers: hdrs });
    const j2data = await j2.json();
    results.recent_jobs = (j2data.results || []).map(j => ({
      name: j.name,
      jnid: j.jnid,
      keys: Object.keys(j),
      sales_rep: j.sales_rep,
      assigned: j.assigned,
      date_start: j.date_start,
      custom_fields: j.custom_fields,
    }));

  } catch(e) { results.error = e.message; }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(results, null, 2),
  };
};