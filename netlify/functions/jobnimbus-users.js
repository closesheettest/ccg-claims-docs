exports.handler = async (event) => {
  const apiKey = process.env.JOBNIMBUS_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "JOBNIMBUS_API_KEY not set" }),
    };
  }

  try {
    const response = await fetch("https://app.jobnimbus.com/api1/account/users", {
      method: "GET",
      headers: {
        Authorization: `bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    console.log("JN /account/users status:", response.status);

    if (!response.ok) {
      const text = await response.text();
      console.error("JN error response:", text);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `JN API returned ${response.status}`, detail: text }),
      };
    }

    const data = await response.json();
    console.log("JN users raw count:", data.users?.length);

    if (!data.users || !Array.isArray(data.users)) {
      return {
        statusCode: 200,
        body: JSON.stringify({ members: [] }),
      };
    }

    // Map to our standard format, filter active only
    const members = data.users
      .filter((u) => u.is_active !== false)
      .map((u) => ({
        name: `${u.first_name || ""} ${u.last_name || ""}`.trim(),
        jobnimbus_id: u.id,
        email: u.email || "",
      }))
      .filter((u) => u.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log("Filtered active members:", members.length);

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