const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const res = await fetch("https://app.jobnimbus.com/api1/accounts/users?size=200", {
      headers: {
        "Authorization": `Bearer ${JN_KEY}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`/accounts/users status: ${res.status}`);
    const rawText = await res.text();

    if (!res.ok) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: [], debug: { status: res.status, raw: rawText.slice(0, 300) } }),
      };
    }

    let data;
    try { data = JSON.parse(rawText); } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const list = data.results || data.users || data.data || data.members || [];
    console.log("Total users from JN:", list.length);
    if (list.length > 0) console.log("Sample:", JSON.stringify(list[0], null, 2));

    const members = list
      .filter(u => u.is_active !== false && u.is_disabled !== true && u.status !== "inactive")
      .map(u => ({
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.name || u.display_name || "",
        jobnimbus_id: u.jnid || u.id || u.recid || u.user_id || "",
        email: u.email || u.email_address || "",
      }))
      .filter(u => u.name && u.jobnimbus_id)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    };

  } catch (err) {
    console.error("jobnimbus-users error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};