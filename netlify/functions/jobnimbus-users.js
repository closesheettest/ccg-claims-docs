const JN_API = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    // Try multiple possible endpoints for team members
    const endpoints = [
      `${JN_API}/team_members?size=100`,
      `${JN_API}/salesreps?size=100`,
      `${JN_API}/contacts?type=rep&size=100`,
    ];

    let members = [];

    for (const url of endpoints) {
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${JN_KEY}`,
          "Content-Type": "application/json",
        },
      });

      console.log(`Tried ${url} — status: ${res.status}`);

      if (res.ok) {
        const data = await res.json();
        console.log("Response keys:", Object.keys(data));
        const list = data.results || data.data || data.members || [];
        if (list.length > 0) {
          // Log first user to see all available fields for filtering
          console.log("Sample user fields:", JSON.stringify(list[0], null, 2));
          console.log("All user names+roles:", list.map(u => `${u.first_name} ${u.last_name} | role:${u.role} | group:${u.group} | type:${u.type} | division:${u.division} | team:${u.team} | location:${u.location} | access_profile:${u.access_profile} | acl:${JSON.stringify(u.acl)}`).join("\n"));
          
          // Show all active users for now — filter by location once field names confirmed
          const useList = list.filter(u => u.is_active !== false);
          
          members = useList
            .map(u => ({
              name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.name || u.display_name || "",
              jobnimbus_id: u.jnid || u.id || u.recid || "",
              role: u.access_profile || u.role || "",
              group: u.location || u.group || "",
            }))
            .filter(u => u.name && u.jobnimbus_id)
            .sort((a, b) => a.name.localeCompare(b.name));
          console.log("Filtered members:", members.length, "of", list.length);
          break;
        }
      }
    }

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