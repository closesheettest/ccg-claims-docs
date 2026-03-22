exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};

    const {
      signMethod = "",
      signedByEmail = "",
      signedByName = "",
    } = body;

    const headers = event.headers || {};

    const rawIp =
      headers["x-nf-client-connection-ip"] ||
      headers["client-ip"] ||
      headers["x-forwarded-for"] ||
      headers["x-real-ip"] ||
      "";

    const signedIp = String(rawIp).split(",")[0].trim();
    const signedUserAgent = headers["user-agent"] || "";
    const signedAt = new Date().toISOString();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signedAt,
        signedIp,
        signedUserAgent,
        signMethod,
        signedByEmail,
        signedByName,
        signedCity: "",
        signedRegion: "",
      }),
    };
  } catch (error) {
    console.error("sign-audit error:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Failed to capture signing audit trail.",
      }),
    };
  }
};