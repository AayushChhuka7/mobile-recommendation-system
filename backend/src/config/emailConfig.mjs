import nodemailer from "nodemailer";
import "dotenv/config";

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

//   transporter.verify((error, success) => {
//     if (error) {
//       console.error(error);
//     } else {
//       console.log("SMTP server is ready");
//     }
//   });


