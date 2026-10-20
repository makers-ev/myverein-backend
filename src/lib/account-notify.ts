import { APP_NAME, SITE_URL } from "./emailTemplate.js";
import { DEFAULT_MAIL_LANGUAGE, type MailLanguage } from "./notify/i18n.js";
import { notifySafely } from "./notify/dispatcher.js";

/**
 * Security notices about the account (G8): password changed, e-mail address changed, two-factor sign-in switched on/off.
 * Delivered by the dispatcher as platform-context mails (no club), class `mandatory` (cannot be switched off, no unsubscribe
 * link), e-mail only. They never contain a token, a code, the new address or any other secret, only the fact of the change
 * and what to do if it was not the owner. The e-mail change notice goes to the OLD address (the new one is not proven yet).
 * Verification and password-reset mails stay on Better Auth on purpose: they must work before an account has a verified address.
 */

export type AccountNoticeKind = "password_changed" | "email_changed" | "two_factor_enabled" | "two_factor_disabled";

const WHAT_IF_NOT_YOU: Record<MailLanguage, string> = {
  de: "Wenn du das nicht warst, setze dein Passwort sofort über „Passwort vergessen“ zurück, melde dich überall ab und nutze die Kontaktseite, um uns zu informieren.",
  en: "If this was not you, reset your password right away via “Forgot password”, sign out everywhere and use the contact page to let us know.",
};

const NOTICES: Record<AccountNoticeKind, Record<MailLanguage, { title: string; body: string }>> = {
  password_changed: {
    de: { title: "Dein Passwort wurde geändert", body: `Das Passwort deines ${APP_NAME}-Kontos wurde soeben geändert. Wenn du das warst, musst du nichts tun.` },
    en: { title: "Your password was changed", body: `The password of your ${APP_NAME} account was just changed. If this was you, you do not need to do anything.` },
  },
  email_changed: {
    de: { title: "Die E-Mail-Adresse deines Kontos wurde geändert", body: `Die E-Mail-Adresse deines ${APP_NAME}-Kontos wurde geändert. Diese Nachricht geht an die bisherige Adresse. Wenn du das warst, musst du nichts tun.` },
    en: { title: "The e-mail address of your account was changed", body: `The e-mail address of your ${APP_NAME} account was changed. This message goes to the previous address. If this was you, you do not need to do anything.` },
  },
  two_factor_enabled: {
    de: { title: "Zwei-Faktor-Anmeldung aktiviert", body: `Für dein ${APP_NAME}-Konto wurde die Zwei-Faktor-Anmeldung aktiviert. Wenn du das warst, musst du nichts tun.` },
    en: { title: "Two-factor sign-in enabled", body: `Two-factor sign-in was enabled for your ${APP_NAME} account. If this was you, you do not need to do anything.` },
  },
  two_factor_disabled: {
    de: { title: "Zwei-Faktor-Anmeldung deaktiviert", body: `Für dein ${APP_NAME}-Konto wurde die Zwei-Faktor-Anmeldung deaktiviert. Wenn du das warst, musst du nichts tun.` },
    en: { title: "Two-factor sign-in disabled", body: `Two-factor sign-in was disabled for your ${APP_NAME} account. If this was you, you do not need to do anything.` },
  },
};

const CTA: Record<MailLanguage, string> = { de: "Kontoeinstellungen öffnen", en: "Open account settings" };

export function composeAccountNotice(kind: AccountNoticeKind, lang: MailLanguage): { title: string; body: string } {
  const notice = NOTICES[kind][lang];
  return { title: notice.title, body: `${notice.body}\n\n${WHAT_IF_NOT_YOU[lang]}` };
}

export interface AccountNoticeTarget {
  id: string;
  name: string | null;
  /** Address the notice goes to (for an e-mail change: the previous address). */
  email: string;
}

/**
 * Queues one notice. `ref_id` = user id + minute: the dispatcher's unique index makes a repeated hook call of the same change
 * a no-op, while a later, separate change is a new notice. Never throws.
 */
export async function notifyAccountChange(kind: AccountNoticeKind, target: AccountNoticeTarget, options: { lang?: MailLanguage; now?: Date } = {}): Promise<void> {
  const lang = options.lang ?? DEFAULT_MAIL_LANGUAGE;
  const minute = Math.floor((options.now ?? new Date()).getTime() / 60_000);
  const { title, body } = composeAccountNotice(kind, lang);
  await notifySafely({
    clubId: null,
    class: "mandatory",
    eventKey: `account.${kind}`,
    refId: `${target.id}#${minute}`,
    recipients: [{ userId: target.id, name: target.name, email: target.email }],
    content: { title, body, template: "notice", lang, ctaLabel: CTA[lang], ctaUrl: `${SITE_URL}/settings` },
    channels: ["email"],
  });
}
