exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      body = {};
    }

    const headers = event.headers || {};

    const forwardedFor =
      headers["x-forwarded-for"] ||
      headers["client-ip"] ||
      headers["x-nf-client-connection-ip"] ||
      "";

    const signedIp = String(forwardedFor).split(",")[0].trim() || "Unavailable";
    const signedUserAgent = headers["user-agent"] || "Unavailable";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signedAt: new Date().toISOString(),
        signedIp,
        signedUserAgent,
        signMethod: body.signMethod || "unknown",
        signedByEmail: body.signedByEmail || "",
        signedByName: body.signedByName || "",
        claimId: body.claimId || null,
        docType: body.docType || "",
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: error?.message || "Failed to capture audit info",
      }),
    };
  }
};
