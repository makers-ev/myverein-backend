import { APP_NAME, BRAND, escapeHtml, layout, SITE_URL } from "../emailTemplate.js";
import type { NotifyTemplate } from "./types.js";

export interface RenderMailInput {
  template: NotifyTemplate;
  title: string;
  body: string;
  recipientName: string | null;
  clubName: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  /** Club signature / footer (plain text). */
  signature: string | null;
  /** Visible unsubscribe link for optional messages (B9). */
  unsubscribeUrl: string | null;
}

/** Single-line header-safe text. */
export const oneLine = (value: string): string => value.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/** Escapes plain text, turns http(s) URLs into links and line breaks into `<br />`. */
export function textToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (match) => {
    const trailing = /(?:[.,:!?)]|(?<!&[a-z0-9#]{1,8});)+$/.exec(match)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `<a href="${url}" style="color:${BRAND.primary};">${url}</a>${trailing}`;
  });
  return linked.replace(/\r?\n/g, "<br />");
}

function safeUrl(url: string | null): string {
  return url && /^https?:\/\/[^\s<>"']+$/.test(url) ? escapeHtml(url) : escapeHtml(SITE_URL);
}

const DEFAULT_CTA: Record<NotifyTemplate, string> = {
  announcement: "Mitteilung ansehen",
  urgent: "Mitteilung ansehen",
  reminder: "Details ansehen",
  decision: `Zu ${APP_NAME}`,
};

const INTRO: Record<NotifyTemplate, (club: string | null) => string> = {
  announcement: (club) => (club ? `Neue Mitteilung von <strong>${escapeHtml(club)}</strong>:` : "Neue Mitteilung:"),
  urgent: (club) => (club ? `Wichtige Mitteilung von <strong>${escapeHtml(club)}</strong>:` : "Wichtige Mitteilung:"),
  reminder: (club) => (club ? `Eine Erinnerung von <strong>${escapeHtml(club)}</strong>:` : "Eine Erinnerung:"),
  decision: (club) => (club ? `Eine Entscheidung von <strong>${escapeHtml(club)}</strong>:` : "Eine Entscheidung:"),
};

/** Subject and HTML of a club message in the layout of `emailTemplate.ts` (announcement, urgent, reminder, decision). */
export function renderNotifyEmail(input: RenderMailInput): { subject: string; html: string } {
  const title = oneLine(input.title);
  const subject = input.template === "urgent" ? `[Dringend] ${title}` : title;
  const banner =
    input.template === "urgent"
      ? `<p style="margin:0 0 16px; padding:8px 12px; border-radius:8px; background-color:#fee2e2; color:#991b1b; font-size:13px; font-weight:700; letter-spacing:0.04em;">DRINGEND</p>`
      : "";
  const bodyHtml = `${INTRO[input.template](input.clubName)}<br /><br /><strong>${escapeHtml(title)}</strong><br /><br />${textToHtml(input.body)}`;
  const extra: string[] = [];
  if (input.signature?.trim()) {
    extra.push(
      `<p style="margin:24px 0 0; padding-top:16px; border-top:1px solid ${BRAND.border}; font-size:14px; line-height:1.5; color:${BRAND.mutedForeground};">${textToHtml(input.signature.trim())}</p>`,
    );
  }
  if (input.unsubscribeUrl) {
    const club = input.clubName ? ` als Mitglied von ${escapeHtml(input.clubName)}` : "";
    extra.push(
      `<p style="margin:16px 0 0; font-size:12px; color:${BRAND.mutedForeground};">Du erhältst diese E-Mail${club}. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${BRAND.primary};">Benachrichtigungen abbestellen</a></p>`,
    );
  }
  const html = layout({
    greeting: input.recipientName?.trim() ? `Hallo ${escapeHtml(input.recipientName.trim())},` : "Hallo,",
    bodyHtml,
    ctaLabel: escapeHtml(input.ctaLabel?.trim() || DEFAULT_CTA[input.template]),
    ctaUrl: safeUrl(input.ctaUrl),
    bannerHtml: banner,
    extraHtml: extra.join(""),
  });
  return { subject, html };
}
