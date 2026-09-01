import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// Points at the mailhog container by default - zero credentials needed for
// a full demo of the notification path (inbox at http://localhost:8025).
// Swapping to a real provider (SES, Postmark, etc.) is a one-file change.
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: false,
});

export async function sendEmail(to: string, subject: string, html: string) {
  try {
    await transport.sendMail({ from: env.SMTP_FROM, to, subject, html });
  } catch (err) {
    // Email delivery failure should not crash the job queue - BullMQ will
    // still retry the job per its backoff policy since we rethrow.
    logger.error({ err, to, subject }, "failed to send email");
    throw err;
  }
}
