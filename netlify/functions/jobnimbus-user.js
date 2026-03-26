const JN_API = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const res = await fetch(`${JN_API}/users?size=100`, {
      headers: {
        "Authorization": `Bearer ${JN_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("JN users fetch failed:", txt);
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: "Failed to fetch JN users", detail: txt }),
      };
    }

    const data = await res.json();

    // Map to simple array: { name, jobnimbus_id }
    const members = (data.results || [])
      .filter(u => u.is_active !== false)
      .map(u => ({
        name: [u.first_name, u.last_name].filter(Boolean).join(" "),
        jobnimbus_id: u.jnid,
      }))
      .filter(u => u.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    };
  } catch (err) {
    console.error("jobnimbus-users error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};