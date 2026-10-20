import { APP_NAME, BRAND, escapeHtml, layout, SITE_URL } from "../emailTemplate.js";
import { DEFAULT_MAIL_LANGUAGE, type MailLanguage } from "./i18n.js";
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
  /** Language of the chrome around the text; default German. */
  lang?: MailLanguage;
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

const DEFAULT_CTA: Record<MailLanguage, Record<NotifyTemplate, string>> = {
  de: { announcement: "Mitteilung ansehen", urgent: "Mitteilung ansehen", reminder: "Details ansehen", decision: `Zu ${APP_NAME}`, notice: `Zu ${APP_NAME}` },
  en: { announcement: "View message", urgent: "View message", reminder: "View details", decision: `Go to ${APP_NAME}`, notice: `Go to ${APP_NAME}` },
};

const INTRO: Record<MailLanguage, Record<NotifyTemplate, (club: string | null) => string>> = {
  de: {
    announcement: (club) => (club ? `Neue Mitteilung von <strong>${escapeHtml(club)}</strong>:` : "Neue Mitteilung:"),
    urgent: (club) => (club ? `Wichtige Mitteilung von <strong>${escapeHtml(club)}</strong>:` : "Wichtige Mitteilung:"),
    reminder: (club) => (club ? `Eine Erinnerung von <strong>${escapeHtml(club)}</strong>:` : "Eine Erinnerung:"),
    decision: (club) => (club ? `Eine Entscheidung von <strong>${escapeHtml(club)}</strong>:` : "Eine Entscheidung:"),
    notice: (club) => (club ? `Ein Hinweis von <strong>${escapeHtml(club)}</strong>:` : "Ein Hinweis zu deinem Konto:"),
  },
  en: {
    announcement: (club) => (club ? `New message from <strong>${escapeHtml(club)}</strong>:` : "New message:"),
    urgent: (club) => (club ? `Important message from <strong>${escapeHtml(club)}</strong>:` : "Important message:"),
    reminder: (club) => (club ? `A reminder from <strong>${escapeHtml(club)}</strong>:` : "A reminder:"),
    decision: (club) => (club ? `A decision from <strong>${escapeHtml(club)}</strong>:` : "A decision:"),
    notice: (club) => (club ? `A notice from <strong>${escapeHtml(club)}</strong>:` : "A notice about your account:"),
  },
};

const CHROME: Record<MailLanguage, { urgentPrefix: string; urgentBanner: string; hello: (name: string) => string; helloAnon: string; footer: (club: string | null) => string; unsubscribe: string }> = {
  de: {
    urgentPrefix: "[Dringend]",
    urgentBanner: "DRINGEND",
    hello: (name) => `Hallo ${name},`,
    helloAnon: "Hallo,",
    footer: (club) => `Du erhältst diese E-Mail${club ? ` als Mitglied von ${club}` : ""}.`,
    unsubscribe: "Benachrichtigungen abbestellen",
  },
  en: {
    urgentPrefix: "[Urgent]",
    urgentBanner: "URGENT",
    hello: (name) => `Hello ${name},`,
    helloAnon: "Hello,",
    footer: (club) => `You receive this e-mail${club ? ` as a member of ${club}` : ""}.`,
    unsubscribe: "Unsubscribe from these notifications",
  },
};

/** Subject and HTML of a club message in the layout of `emailTemplate.ts` (announcement, urgent, reminder, decision). */
export function renderNotifyEmail(input: RenderMailInput): { subject: string; html: string } {
  const lang = input.lang ?? DEFAULT_MAIL_LANGUAGE;
  const chrome = CHROME[lang];
  const title = oneLine(input.title);
  const subject = input.template === "urgent" ? `${chrome.urgentPrefix} ${title}` : title;
  const banner =
    input.template === "urgent"
      ? `<p style="margin:0 0 16px; padding:8px 12px; border-radius:8px; background-color:#fee2e2; color:#991b1b; font-size:13px; font-weight:700; letter-spacing:0.04em;">${chrome.urgentBanner}</p>`
      : "";
  const bodyHtml = `${INTRO[lang][input.template](input.clubName)}<br /><br /><strong>${escapeHtml(title)}</strong><br /><br />${textToHtml(input.body)}`;
  const extra: string[] = [];
  if (input.signature?.trim()) {
    extra.push(
      `<p style="margin:24px 0 0; padding-top:16px; border-top:1px solid ${BRAND.border}; font-size:14px; line-height:1.5; color:${BRAND.mutedForeground};">${textToHtml(input.signature.trim())}</p>`,
    );
  }
  if (input.unsubscribeUrl) {
    extra.push(
      `<p style="margin:16px 0 0; font-size:12px; color:${BRAND.mutedForeground};">${chrome.footer(input.clubName ? escapeHtml(input.clubName) : null)} <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${BRAND.primary};">${chrome.unsubscribe}</a></p>`,
    );
  }
  const html = layout({
    greeting: input.recipientName?.trim() ? chrome.hello(escapeHtml(input.recipientName.trim())) : chrome.helloAnon,
    bodyHtml,
    ctaLabel: escapeHtml(input.ctaLabel?.trim() || DEFAULT_CTA[lang][input.template]),
    ctaUrl: safeUrl(input.ctaUrl),
    bannerHtml: banner,
    extraHtml: extra.join(""),
    lang,
  });
  return { subject, html };
}
