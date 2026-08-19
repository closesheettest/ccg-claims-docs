const { Resend } = require("resend");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const { to, cc, bcc, subject, html, attachments, fromName } = JSON.parse(event.body || "{}");

    if (!to || !subject || !html) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing to, subject, or html" }),
      };
    }

    console.log("ATTACHMENTS RECEIVED:", attachments?.length || 0);
    console.log("TO:", to);
    console.log("BCC:", bcc);
    console.log(
      "FIRST ATTACHMENT:",
      attachments?.[0]
        ? {
            filename: attachments[0].filename,
            contentLength: attachments[0].content?.length || 0,
          }
        : null
    );

    const resend = new Resend(process.env.RESEND_API_KEY);

    // The sending ADDRESS is fixed (it's the domain verified with Resend), but a
    // caller may set the display NAME — so a time-card email reads as "U.S.
    // Shingle Time Cards" rather than "Inspection For You", which means nothing
    // to an employee being asked to sign off hours.
    const fromAddress = (process.env.EMAIL_FROM || "Inspection For You <noreply@inspectionforyou.com>");
    const addressOnly = (fromAddress.match(/<([^>]+)>/) || [null, fromAddress])[1];
    const cleanName = String(fromName || "").replace(/["<>\r\n]/g, "").trim().slice(0, 60);

    const emailPayload = {
      from: cleanName ? `${cleanName} <${addressOnly}>` : fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      attachments: (attachments || []).map((file) => ({
        filename: file.filename,
        content: file.content,
      })),
    };

    if (cc && cc.length > 0) emailPayload.cc = Array.isArray(cc) ? cc : [cc];
    if (bcc && bcc.length > 0) emailPayload.bcc = Array.isArray(bcc) ? bcc : [bcc];

    const result = await resend.emails.send(emailPayload);

    console.log("RESEND RESULT:", JSON.stringify(result, null, 2));

    if (result.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: result.error.message || "Resend send failed",
          details: result.error,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        id: result.data?.id || null,
      }),
    };
  } catch (error) {
    console.error("FUNCTION ERROR:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error?.message || "Failed to send email",
      }),
    };
  }
};