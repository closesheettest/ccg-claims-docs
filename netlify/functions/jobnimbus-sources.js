exports.handler = async (event) => {
  const apiKey = process.env.JOBNIMBUS_API_KEY;
  const JN = "https://app.jobnimbus.com/api1";
  const hdrs = { Authorization: `bearer ${apiKey}`, "Content-Type": "application/json" };
  const s = await fetch(`${JN}/account/settings`, { headers: hdrs });
  const data = await s.json();
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: data.sources || [], profiles: data.profiles || [] }, null, 2),
  };
};