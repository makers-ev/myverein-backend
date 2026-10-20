/**
 * Mail language of system messages (G12). Club mails follow `club_settings.mail_language`; mails without a club (account
 * security notices) follow the `Accept-Language` header of the request that caused them. German is the default everywhere;
 * text written by a person (announcement title/body, board notes) is never translated.
 */

export const MAIL_LANGUAGES = ["de", "en"] as const;
export type MailLanguage = (typeof MAIL_LANGUAGES)[number];
export const DEFAULT_MAIL_LANGUAGE: MailLanguage = "de";

export function isMailLanguage(value: unknown): value is MailLanguage {
  return typeof value === "string" && (MAIL_LANGUAGES as readonly string[]).includes(value);
}

/** The best supported language of an `Accept-Language` header (q-values honoured, ties keep header order); `de` if nothing matches. */
export function pickMailLanguage(header: string | null | undefined): MailLanguage {
  if (!header || header.length > 500) return DEFAULT_MAIL_LANGUAGE;
  let best: { lang: MailLanguage; q: number } | null = null;
  for (const part of header.split(",")) {
    const [tag, ...params] = part.trim().split(";");
    const base = tag?.trim().toLowerCase().split("-")[0];
    if (!isMailLanguage(base)) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { lang: base, q };
  }
  return best?.lang ?? DEFAULT_MAIL_LANGUAGE;
}
