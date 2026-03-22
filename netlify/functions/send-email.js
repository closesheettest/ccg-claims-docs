const { Resend } = require("resend");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const { to, subject, html } = JSON.parse(event.body || "{}");

    const resend = new Resend(process.env.RESEND_API_KEY);

    const result = await resend.emails.send({
      from: process.env.EMAIL_FROM || "Inspection For You <noreply@inspectionforyou.com>",
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

    console.log("RESEND RESULT:", result);

    if (result.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: result.error.message }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error("FUNCTION ERROR:", err);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};