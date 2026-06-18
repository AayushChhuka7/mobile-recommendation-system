import "dotenv/config";
import { transporter } from "../config/emailConfig.mjs";

export const sendEmail = async (userEmail, otp) => {
  return transporter.sendMail({
    from: process.env.SMTP_USER,
    to: userEmail,
    subject: "OTP Verification",
    html: `<h2>Your OTP: ${otp}</h2>`,
  });
};
