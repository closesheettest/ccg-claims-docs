exports.handler = async (event) => {
  const apiKey = process.env.JOBNIMBUS_API_KEY;
  const JN = "https://app.jobnimbus.com/api1";
  const hdrs = { Authorization: `bearer ${apiKey}`, "Content-Type": "application/json" };

  const s = await fetch(`${JN}/account/settings`, { headers: hdrs });
  const data = await s.json();

  // Show all job workflow statuses
  const jobWorkflows = (data.workflows || []).filter(w => w.object_type === "job");
  const result = jobWorkflows.map(w => ({
    id: w.id,
    name: w.name,
    statuses: (w.status || []).map(s => `${s.id}:${s.name}`)
  }));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result, null, 2),
  };
};