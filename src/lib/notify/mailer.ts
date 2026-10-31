import { sendEmail } from "../email.js";

/** Transport seam: production uses `sendEmail` (SMTP -> Resend -> dev log), tests inject a recording double. */
export type MailSender = typeof sendEmail;

let sender: MailSender = sendEmail;

export function setMailSender(next: MailSender | null): void {
  sender = next ?? sendEmail;
}

export function getMailSender(): MailSender {
  return sender;
}

/** Mails per second and process (`MAIL_SEND_RATE`, default 5, `0` = unthrottled). */
export function mailSendRate(): number {
  const raw = process.env.MAIL_SEND_RATE;
  if (raw === undefined || raw === "") return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 5;
}

let nextSlotAt = 0;

/** Reserves the next send slot and waits for it, so concurrent handlers of one process stay under `MAIL_SEND_RATE`. */
export async function waitForMailSlot(now: () => number = Date.now): Promise<void> {
  const rate = mailSendRate();
  if (rate === 0) return;
  const interval = 1000 / rate;
  const slot = Math.max(now(), nextSlotAt);
  nextSlotAt = slot + interval;
  const delay = slot - now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/** Test helper: forget reserved slots. */
export function resetMailThrottle(): void {
  nextSlotAt = 0;
}
