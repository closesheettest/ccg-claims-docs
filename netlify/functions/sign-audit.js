exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
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

    let signedCity = "";
    let signedRegion = "";

    const isLocalIp =
      !signedIp ||
      signedIp === "::1" ||
      signedIp === "127.0.0.1" ||
      signedIp.startsWith("192.168.") ||
      signedIp.startsWith("10.") ||
      signedIp.startsWith("172.16.") ||
      signedIp.startsWith("172.17.") ||
      signedIp.startsWith("172.18.") ||
      signedIp.startsWith("172.19.") ||
      signedIp.startsWith("172.20.") ||
      signedIp.startsWith("172.21.") ||
      signedIp.startsWith("172.22.") ||
      signedIp.startsWith("172.23.") ||
      signedIp.startsWith("172.24.") ||
      signedIp.startsWith("172.25.") ||
      signedIp.startsWith("172.26.") ||
      signedIp.startsWith("172.27.") ||
      signedIp.startsWith("172.28.") ||
      signedIp.startsWith("172.29.") ||
      signedIp.startsWith("172.30.") ||
      signedIp.startsWith("172.31.") ||
      signedIp.startsWith("100.64.");

    async function lookupWithIpapi(ip) {
      const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) return { city: "", region: "" };

      const geo = await res.json();
      return {
        city: geo?.city || "",
        region: geo?.region || "",
      };
    }

    async function lookupWithIpwho(ip) {
      const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) return { city: "", region: "" };

      const geo = await res.json();
      return {
        city: geo?.city || "",
        region: geo?.region || "",
      };
    }

    if (!isLocalIp) {
      try {
        let geo = await lookupWithIpapi(signedIp);

        if (!geo.city && !geo.region) {
          geo = await lookupWithIpwho(signedIp);
        }

        signedCity = geo.city || "";
        signedRegion = geo.region || "";
      } catch (geoError) {
        console.log("Geolocation lookup failed:", geoError?.message || geoError);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signedAt,
        signedIp,
        signedUserAgent,
        signMethod,
        signedByEmail,
        signedByName,
        signedCity,
        signedRegion,
      }),
    };
  } catch (error) {
    console.error("sign-audit error:", error);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to capture signing audit trail.",
      }),
    };
  }
};