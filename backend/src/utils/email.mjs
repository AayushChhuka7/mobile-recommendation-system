import { transporter } from "../config/emailConfig.mjs";
import { internal } from "./ApiError.mjs";

// sendEmail — wrapper around nodemailer that never leaks the raw SMTP
// error reply (e.g. Gmail's "535-5.7.8 Username and Password not
// accepted") to the client. The original error is logged server-side
// for debugging; the caller receives a generic 500 with a stable
// `EMAIL_SEND_FAILED` code so the FE can show a friendly banner.
export const sendEmail = async (userEmail, otp) => {
  try {
    return await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: userEmail,
      subject: "OTP Verification",
      html: `<h2>Your OTP: ${otp}</h2>`,
    });
  } catch (err) {
    // Log the full SMTP error server-side so devs can debug. Never
    // include this text in the response — it leaks provider
    // internals (Gmail reply codes, App Password hints, etc.).
    // eslint-disable-next-line no-console
    console.error("[sendEmail] SMTP failure:", {
      to: userEmail,
      code: err?.code,
      responseCode: err?.responseCode,
      command: err?.command,
      message: err?.message,
    });
    throw internal(
      "We couldn't send the verification email right now. Please try again later.",
      { reason: "email_send_failed", smtpCode: err?.code || null },
    );
  }
};
