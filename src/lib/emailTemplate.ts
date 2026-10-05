import { appName, primaryColor } from "../project.config.js";

// Site the logo links to and the footer's Imprint/Contact point at -- the
// first entry of WEB_ORIGIN (same convention as auth.ts's password-reset
// callbackURL fallback), since that's already this backend's one source of
// truth for "where the web client lives".
export const SITE_URL = (process.env.WEB_ORIGIN ?? "").split(",")[0]?.trim() || "http://localhost:3011";
export const LOGO_CID = "app-logo";
export const LOGO_PATH = "./assets/myverein-logo.png";

// Rest of the generic template palette (matches the website/admin templates'
// default `--border`/etc tokens in globals.css) -- this backend has no theme
// system of its own, so the colors are duplicated rather than shared across
// repos; only `primary` comes from project.config.ts, the rest are fixed
// neutrals. Backend transactional mail (reset password, verify email) is
// fixed to German -- there's no language on the user record to pick from,
// and German is this template suite's default (see the website/mobile
// templates' LanguageContext).
const BRAND = {
  primary: primaryColor,
  background: "#f8fafc",
  card: "#ffffff",
  foreground: "#0f172a",
  mutedForeground: "#64748b",
  border: "#e2e8f0",
};

// Exported so auth.ts's welcome-notification hook uses the same name as
// these emails.
export const APP_NAME = appName;

function layout({ greeting, bodyHtml, ctaLabel, ctaUrl }: { greeting: string; bodyHtml: string; ctaLabel: string; ctaUrl: string }): string {
  return `<!doctype html>
<html lang="de">
  <body style="margin:0; padding:0; background-color:${BRAND.background}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.background}; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:${BRAND.card}; border:1px solid ${BRAND.border}; border-radius:16px; overflow:hidden;">
            <tr>
              <td style="padding:28px 32px; border-bottom:1px solid ${BRAND.border};">
                <a href="${SITE_URL}" style="text-decoration:none;">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-right:10px;">
                        <img src="cid:${LOGO_CID}" width="36" height="36" alt="${APP_NAME}" style="display:block; border-radius:9px;" />
                      </td>
                      <td style="font-size:19px; font-weight:700; color:${BRAND.foreground};">${APP_NAME}</td>
                    </tr>
                  </table>
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px; font-size:16px; font-weight:600; color:${BRAND.foreground};">${greeting}</p>
                <p style="margin:0 0 24px; font-size:15px; line-height:1.6; color:${BRAND.foreground};">${bodyHtml}</p>
                <a href="${ctaUrl}" style="display:inline-block; background-color:${BRAND.primary}; color:#ffffff; font-size:14px; font-weight:600; text-decoration:none; padding:12px 24px; border-radius:10px;">${ctaLabel}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px; background-color:${BRAND.background}; border-top:1px solid ${BRAND.border};">
                <p style="margin:0; font-size:12px; color:${BRAND.mutedForeground};">
                  <a href="${SITE_URL}" style="color:${BRAND.primary}; text-decoration:none;">${APP_NAME}</a>
                  &middot;
                  <a href="${SITE_URL}/imprint" style="color:${BRAND.primary}; text-decoration:none;">Impressum</a>
                  &middot;
                  <a href="${SITE_URL}/contact" style="color:${BRAND.primary}; text-decoration:none;">Kontakt</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildResetPasswordEmail({ name, url }: { name: string; url: string }): string {
  return layout({
    greeting: `Hallo ${name},`,
    bodyHtml:
      "du hast angefordert, dein Passwort zurückzusetzen. Klicke auf den Button unten, um ein neues Passwort zu vergeben. Falls du das nicht warst, kannst du diese E-Mail ignorieren.",
    ctaLabel: "Passwort zurücksetzen",
    ctaUrl: url,
  });
}

export function buildVerifyEmailEmail({ name, url }: { name: string; url: string }): string {
  return layout({
    greeting: `Hallo ${name},`,
    bodyHtml: "bitte bestätige deine E-Mail-Adresse, indem du auf den Button unten klickst.",
    ctaLabel: "E-Mail-Adresse bestätigen",
    ctaUrl: url,
  });
}

/** User-supplied text (club names, review notes) ends up inside HTML mail bodies -- always escape it. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escapes and keeps line breaks of a multi-line note. */
function noteHtml(note: string): string {
  return escapeHtml(note).replace(/\r?\n/g, "<br />");
}

// --- Wave 6: Vereinserstellung ----------------------------------------

export function buildRegistrationReceivedEmail({ name, clubName, url }: { name: string; clubName: string; url: string }): string {
  return layout({
    greeting: `Hallo ${escapeHtml(name)},`,
    bodyHtml: `wir haben deinen Antrag zur Gründung des Vereins <strong>${escapeHtml(clubName)}</strong> erhalten. Wir prüfen die Angaben und Nachweise und melden uns per E-Mail bei dir.`,
    ctaLabel: "Zu MyVerein",
    ctaUrl: url,
  });
}

export function buildRegistrationReviewNotifyEmail({
  clubName,
  applicantName,
  applicantEmail,
  url,
}: {
  clubName: string;
  applicantName: string;
  applicantEmail: string;
  url: string;
}): string {
  return layout({
    greeting: "Hallo,",
    bodyHtml: `es liegt ein neuer Antrag zur Vereinsgründung zur Prüfung vor: <strong>${escapeHtml(clubName)}</strong>, eingereicht von ${escapeHtml(applicantName)} (${escapeHtml(applicantEmail)}).`,
    ctaLabel: "Antrag prüfen",
    ctaUrl: url,
  });
}

export function buildRegistrationNeedsInfoEmail({ name, clubName, note, url }: { name: string; clubName: string; note: string; url: string }): string {
  return layout({
    greeting: `Hallo ${escapeHtml(name)},`,
    bodyHtml: `zu deinem Antrag für <strong>${escapeHtml(clubName)}</strong> haben wir eine Rückfrage:<br /><br />${noteHtml(note)}<br /><br />Bitte ergänze deine Angaben oder Nachweise und sende den Antrag erneut ab.`,
    ctaLabel: "Antrag bearbeiten",
    ctaUrl: url,
  });
}

export function buildRegistrationRejectedEmail({ name, clubName, note, url }: { name: string; clubName: string; note: string; url: string }): string {
  return layout({
    greeting: `Hallo ${escapeHtml(name)},`,
    bodyHtml: `leider konnten wir deinen Antrag für <strong>${escapeHtml(clubName)}</strong> nicht freigeben.<br /><br />Begründung:<br />${noteHtml(note)}<br /><br />Du kannst bei Bedarf einen neuen Antrag stellen.`,
    ctaLabel: "Zu MyVerein",
    ctaUrl: url,
  });
}

export function buildRegistrationApprovedEmail({ name, clubName, slug, url }: { name: string; clubName: string; slug: string; url: string }): string {
  return layout({
    greeting: `Hallo ${escapeHtml(name)},`,
    bodyHtml: `dein Verein <strong>${escapeHtml(clubName)}</strong> ist freigeschaltet. Die Vereinskennung lautet <strong>${escapeHtml(slug)}</strong> – damit können Mitglieder per Aufnahmeantrag beitreten. Du bist als Vorstand eingetragen und kannst den Verein ab sofort verwalten.`,
    ctaLabel: "Zum Verein",
    ctaUrl: url,
  });
}
