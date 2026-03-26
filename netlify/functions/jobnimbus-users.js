const JN_API = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    // JN actual users endpoint
    const res = await fetch(`${JN_API}/users?size=200`, {
      headers: {
        "Authorization": `Bearer ${JN_KEY}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`/users status: ${res.status}`);
    const rawText = await res.text();
    console.log("Raw response (first 1000):", rawText.slice(0, 1000));

    if (!res.ok) {
      // Try alternate endpoint
      const res2 = await fetch(`${JN_API}/team?size=200`, {
        headers: {
          "Authorization": `Bearer ${JN_KEY}`,
          "Content-Type": "application/json",
        },
      });
      console.log(`/team status: ${res2.status}`);
      const raw2 = await res2.text();
      console.log("Team raw (first 1000):", raw2.slice(0, 1000));

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          members: [],
          debug: {
            usersStatus: res.status,
            teamStatus: res2.status,
            usersRaw: rawText.slice(0, 500),
            teamRaw: raw2.slice(0, 500)
          }
        }),
      };
    }

    let data;
    try { data = JSON.parse(rawText); } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: "Invalid JSON", raw: rawText.slice(0, 200) }) };
    }

    console.log("Data keys:", Object.keys(data));
    const list = data.results || data.users || data.data || [];
    console.log("List length:", list.length);
    if (list.length > 0) {
      console.log("First user:", JSON.stringify(list[0], null, 2));
    }

    // Filter to Insurance Sales Reps at U.S. Shingle location
    const filtered = list.filter(u => {
      const profile = (u.access_profile || u.acl?.name || u.role_name || u.role || "").toLowerCase();
      const location = (u.location || u.location_name || u.office || "").toLowerCase();
      return profile.includes("insurance") ||
             location.includes("shingle") ||
             location.includes("insurance");
    });

    const useList = filtered.length > 0 ? filtered : list;

    const members = useList
      .filter(u => u.is_active !== false && u.status !== "inactive")
      .map(u => ({
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") ||
              u.name || u.display_name || u.username || "",
        jobnimbus_id: u.jnid || u.id || u.recid || "",
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