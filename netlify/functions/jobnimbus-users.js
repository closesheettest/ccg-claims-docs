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
    console.log("Raw response (first 2000):", rawText.slice(0, 2000));

    if (!res.ok) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: [], debug: { status: res.status, raw: rawText.slice(0, 500) } }),
      };
    }

    let data;
    try { data = JSON.parse(rawText); } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: "Invalid JSON", raw: rawText.slice(0, 200) }) };
    }

    console.log("Data keys:", Object.keys(data));
    const list = data.results || data.users || data.data || data.members || [];
    console.log("Total users:", list.length);
    if (list.length > 0) {
      console.log("First user sample:", JSON.stringify(list[0], null, 2));
    }

    // Filter to Insurance Sales Reps at U.S. Shingle location
    const filtered = list.filter(u => {
      const everything = JSON.stringify(u).toLowerCase();
      return everything.includes("insurance sales rep") ||
             everything.includes("u.s. shingle") ||
             everything.includes("shingle") ||
             everything.includes("insurance (ins)");
    });

    const useList = filtered.length > 0 ? filtered : list;
    console.log(`Using ${useList.length} of ${list.length} users`);

    const members = useList
      .filter(u => u.is_active !== false && u.status !== "inactive" && u.is_disabled !== true)
      .map(u => ({
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") ||
              u.name || u.display_name || u.username || u.email || "",
        jobnimbus_id: u.jnid || u.id || u.recid || u.user_id || "",
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};