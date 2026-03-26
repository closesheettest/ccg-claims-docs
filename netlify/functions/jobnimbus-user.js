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

    const rawText = await res.text();
    console.log("JN users raw response:", rawText.slice(0, 500));

    if (!res.ok) {
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: "Failed to fetch JN users", detail: rawText }),
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Invalid JSON from JN", detail: rawText.slice(0, 200) }),
      };
    }

    console.log("JN users data keys:", Object.keys(data));
    console.log("JN users count:", data.count, "results:", data.results?.length);

    // JN can return results or data array
    const userList = data.results || data.data || data.users || [];

    const members = userList
      .filter(u => u.is_active !== false && u.status !== "inactive")
      .map(u => ({
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.name || u.display_name || "",
        jobnimbus_id: u.jnid || u.id || u.recid,
      }))
      .filter(u => u.name && u.jobnimbus_id)
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log("Mapped members:", members);

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