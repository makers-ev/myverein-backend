import { Resend } from "resend";
import nodemailer from "nodemailer";

import { logger } from "./logger.js";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// SMTP takes priority over Resend when both are set -- anyone who explicitly
// configures SMTP_HOST has deliberately opted into their own mail server.
const smtpTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      // 465 = implicit TLS from connection start, 587/25 = STARTTLS
      // (connection starts unencrypted, then upgrades) -- both are common in
      // practice, so this is explicit rather than guessed.
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    })
  : null;

interface EmailAttachment {
  filename: string;
  /** Local filesystem path, relative to the process's cwd. */
  path: string;
  /** Reference this via `cid:<cid>` in an `<img src>` inside `html` to embed it inline instead of as a download. */
  cid: string;
}

export async function sendEmail({
  to,
  subject,
  html,
  attachments,
}: {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}) {
  if (smtpTransport) {
    await smtpTransport.sendMail({ from: process.env.EMAIL_FROM!, to, subject, html, attachments });
    return;
  }
  if (resend) {
    await resend.emails.send({
      from: process.env.EMAIL_FROM!,
      to,
      subject,
      html,
      attachments: attachments?.map(({ filename, path, cid }) => ({ filename, path, contentId: cid })),
    });
    return;
  }
  // Dev fallback: neither SMTP nor Resend configured -> log instead of
  // sending, so the template works out of the box with zero external accounts.
  logger.info({ to, subject }, "[email:dev] sending skipped, no SMTP_HOST/RESEND_API_KEY -- logging instead");
  logger.info(html);
}
