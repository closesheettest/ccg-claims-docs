// netlify/functions/ghl-sms.js
// Sends an SMS via GoHighLevel API v2
// Looks up or creates contact by phone, then sends SMS via conversation

const GHL_API_KEY = "pit-9c582cb2-5898-4ee6-af39-866eeb0360b8";
const GHL_FROM_NUMBER = "+17273493584";

// Set GHL_LOCATION_ID in Netlify environment variables
// Find it in GHL → Settings → Business Profile, or in the URL:
// app.gohighlevel.com/location/YOUR_LOCATION_ID/dashboard
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

const GHL_HEADERS = {
  "Authorization": `Bearer ${GHL_API_KEY}`,
  "Version": "2021-04-15",
  "Content-Type": "application/json",
};

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function findOrCreateContact(phone, name) {
  const normalized = normalizePhone(phone);

  // Search for existing contact
  const searchRes = await fetch(
    `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(normalized)}`,
    { headers: GHL_HEADERS }
  );

  if (searchRes.ok) {
    const data = await searchRes.json();
    const contacts = data.contacts || [];
    if (contacts.length > 0) {
      console.log("GHL: found existing contact", contacts[0].id);
      return contacts[0].id;
    }
  }

  // Create contact
  const nameParts = (name || "Unknown").split(" ");
  const createRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
    method: "POST",
    headers: GHL_HEADERS,
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      phone: normalized,
      firstName: nameParts[0] || "Unknown",
      lastName: nameParts.slice(1).join(" ") || "",
      name: name || "Unknown",
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`GHL create contact failed: ${err}`);
  }

  const createData = await createRes.json();
  const contactId = createData.contact?.id;
  if (!contactId) throw new Error("No contactId from GHL");
  console.log("GHL: created contact", contactId);
  return contactId;
}

async function getOrCreateConversation(contactId) {
  // Search for existing conversation
  const searchRes = await fetch(
    `https://services.leadconnectorhq.com/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`,
    { headers: GHL_HEADERS }
  );

  if (searchRes.ok) {
    const data = await searchRes.json();
    const convs = data.conversations || [];
    if (convs.length > 0) {
      console.log("GHL: found existing conversation", convs[0].id);
      return convs[0].id;
    }
  }

  // Create conversation
  const createRes = await fetch("https://services.leadconnectorhq.com/conversations/", {
    method: "POST",
    headers: GHL_HEADERS,
    body: JSON.stringify({ locationId: GHL_LOCATION_ID, contactId }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`GHL create conversation failed: ${err}`);
  }

  const data = await createRes.json();
  const conversationId = data.conversation?.id || data.id;
  if (!conversationId) throw new Error("No conversationId from GHL");
  console.log("GHL: created conversation", conversationId);
  return conversationId;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { to, message, name } = body;

  if (!to || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing: to, message" }) };
  }

  if (!GHL_LOCATION_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "GHL_LOCATION_ID env var not set. Add it in Netlify → Site settings → Environment variables." }) };
  }

  try {
    const contactId = await findOrCreateContact(to, name);
    const conversationId = await getOrCreateConversation(contactId);

    const sendRes = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
      method: "POST",
      headers: GHL_HEADERS,
      body: JSON.stringify({
        type: "SMS",
        conversationId,
        contactId,
        fromNumber: GHL_FROM_NUMBER,
        toNumber: normalizePhone(to),
        message,
      }),
    });

    const sendText = await sendRes.text();
    let result;
    try { result = JSON.parse(sendText); } catch { result = { raw: sendText }; }

    if (!sendRes.ok) {
      console.error("GHL SMS send failed:", sendRes.status, sendText);
      return { statusCode: sendRes.status, body: JSON.stringify({ error: "GHL send failed", details: result }) };
    }

    console.log("GHL SMS sent:", result);
    return { statusCode: 200, body: JSON.stringify({ success: true, result }) };

  } catch (err) {
    console.error("GHL SMS error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};