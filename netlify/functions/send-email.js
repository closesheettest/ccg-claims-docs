import { Resend } from "resend";

export async function handler(event) {
  try {
    console.log("FUNCTION HIT");

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    const body = JSON.parse(event.body || "{}");
    const { to, subject, html } = body;

    console.log("Sending email to:", to);
    console.log("Subject:", subject);

    if (!process.env.RESEND_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing RESEND_API_KEY" }),
      };
    }

    if (!process.env.FROM_EMAIL) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing FROM_EMAIL" }),
      };
    }

    if (!to || !Array.isArray(to) || to.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing recipient list" }),
      };
    }

    if (!subject) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing subject" }),
      };
    }

    if (!html) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing html body" }),
      };
    }

    const data = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to,
      subject,
      html,
    });

    console.log("Email result:", data);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        data,
      }),
    };
  } catch (error) {
    console.error("SEND EMAIL FUNCTION ERROR:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Unknown server error",
      }),
    };
  }
}
