// netlify/functions/ghl-sms.js
const GHL_API_KEY = "pit-9c582cb2-5898-4ee6-af39-866eeb0360b8";
const GHL_FROM_NUMBER = "+17273493584";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { to, message } = body;
  if (!to || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields: to, message" }) };
  }

  const normalizePhone = (phone) => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return `+${digits}`;
  };

  try {
    const response = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GHL_API_KEY}`,
        "Version": "2021-04-15",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "SMS",
        message,
        fromNumber: GHL_FROM_NUMBER,
        toNumber: normalizePhone(to),
      }),
    });

    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { raw: text }; }

    if (!response.ok) {
      console.error("GHL SMS error:", response.status, text);
      return { statusCode: response.status, body: JSON.stringify({ error: "GHL API error", details: result }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, result }) };
  } catch (err) {
    console.error("GHL SMS fetch error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};