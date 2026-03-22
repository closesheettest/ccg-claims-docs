exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const forwardedFor =
      event.headers["x-forwarded-for"] || event.headers["client-ip"] || "";
    const ip = String(forwardedFor).split(",")[0].trim() || "Unknown";
    const userAgent = event.headers["user-agent"] || "Unknown";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signedAt: new Date().toISOString(),
        signedIp: ip,
        signedUserAgent: userAgent,
        signMethod: body.signMethod || "unknown",
        signedByEmail: body.signedByEmail || "",
        signedByName: body.signedByName || "",
        signedCity: event.headers["x-geo-city"] || "",
        signedRegion: event.headers["x-geo-region"] || event.headers["x-geo-country"] || "",
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: error?.message || "Failed to build sign audit",
      }),
    };
  }
};