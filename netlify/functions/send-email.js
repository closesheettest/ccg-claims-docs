const { Resend } = require("resend");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const { to, subject, html, attachments } = JSON.parse(event.body || "{}");

    if (!to || !subject || !html) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing to, subject, or html" }),
      };
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    const result = await resend.emails.send({
      from:
        process.env.EMAIL_FROM ||
        "Inspection For You <noreply@inspectionforyou.com>",
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      attachments: (attachments || []).map((file) => ({
        filename: file.filename,
        content: file.content,
      })),
    });

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