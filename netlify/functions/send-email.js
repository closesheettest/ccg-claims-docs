import { Resend } from "resend";

export async function handler(event) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    const body = JSON.parse(event.body);

    const { to, subject, html } = body;

    const response = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to,
      subject,
      html,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, response }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
