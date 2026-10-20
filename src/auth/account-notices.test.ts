import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { symmetricDecrypt } from "better-auth/crypto";

import { twoFactor, user } from "./auth-schema.js";
import { db } from "../db/client.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { composeAccountNotice, notifyAccountChange } from "../lib/account-notify.js";
import { pickMailLanguage } from "../lib/notify/i18n.js";
import { handleEmailDelivery, setMailSender, renderNotifyEmail } from "../lib/notify/index.js";

const mails = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string }>);
vi.mock("../lib/email.js", () => ({
  sendEmail: async (mail: { to: string; subject: string; html: string }) => {
    mails.push(mail);
  },
}));

process.env.BACKEND_URL ??= "http://localhost:3000";
const { auth } = await import("./auth.js");

/** G8: security notices (password, e-mail, two-factor) through the dispatcher, platform context, mandatory, no secrets. */

const sfx = randomUUID().slice(0, 8);
const password = "old-password-123!";
const userIds: string[] = [];

async function account(label: string, extra: Record<string, unknown> = {}) {
  const email = `acn-${label}-${sfx}@example.test`;
  const { user: created } = await auth.api.createUser({ body: { email, password, name: `Acn ${label}`, ...extra } as never });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { id: created.id, email, headers: (extra2: Record<string, string> = {}) => new Headers({ cookie, ...extra2 }) };
}

const notices = (userId: string, kind: string) =>
  db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, `account.${kind}`), eq(messageDeliveries.userId, userId)));

beforeAll(() => {
  process.env.MAIL_SEND_RATE = "0";
});
afterAll(async () => {
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await db.delete(messageDeliveries).where(like(messageDeliveries.eventKey, "account.%"));
});

describe("security notices", () => {
  it("password change while signed in queues one mandatory platform mail, without the password", async () => {
    const a = await account("pw");
    await auth.api.changePassword({ body: { currentPassword: password, newPassword: "new-password-456!" }, headers: a.headers() });
    const rows = await notices(a.id, "password_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clubId: null, channel: "email", status: "queued", address: a.email });
    expect(rows[0]!.content).toMatchObject({ class: "mandatory", template: "notice", lang: "de" });
    const wire = JSON.stringify(rows[0]!.content);
    expect(wire).not.toContain("new-password-456");
    expect(wire).not.toContain(password);

    // the mail goes out without an unsubscribe link and without a club signature
    mails.length = 0;
    setMailSender(null);
    await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: rows[0]!.id }, attempt: 1, maxAttempts: 3 });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(a.email);
    expect(mails[0]!.subject).toBe("Dein Passwort wurde geändert");
    expect(mails[0]!.html).not.toContain("abbestellen");
  });

  it("a rejected password change sends nothing", async () => {
    const a = await account("pw-bad");
    await expect(auth.api.changePassword({ body: { currentPassword: "wrong-password!", newPassword: "new-password-456!" }, headers: a.headers() })).rejects.toThrow();
    expect(await notices(a.id, "password_changed")).toHaveLength(0);
  });

  it("uses the Accept-Language of the request (English) for the notice", async () => {
    const a = await account("pw-en");
    await auth.api.changePassword({ body: { currentPassword: password, newPassword: "new-password-456!" }, headers: a.headers({ "accept-language": "en-US,en;q=0.9,de;q=0.5" }) });
    const [row] = await notices(a.id, "password_changed");
    expect(row!.content).toMatchObject({ lang: "en", title: "Your password was changed" });
    const rendered = renderNotifyEmail({ template: "notice", title: "x", body: "y", recipientName: "Ann", clubName: null, ctaLabel: null, ctaUrl: null, signature: null, unsubscribeUrl: null, lang: "en" });
    expect(rendered.html).toContain("Hello Ann,");
    expect(rendered.html).toContain("Imprint");
  });

  it("password reset completion sends the notice (the reset mail itself stays a Better Auth mail)", async () => {
    const a = await account("reset");
    mails.length = 0;
    await auth.api.requestPasswordReset({ body: { email: a.email } });
    await vi.waitFor(() => expect(mails.length).toBeGreaterThan(0));
    const url = /href="([^"]*reset-password\/[^"]+)"/.exec(mails.at(-1)!.html)![1]!.replace(/&amp;/g, "&");
    const token = new URL(url).pathname.split("/").pop()!;
    await auth.api.resetPassword({ body: { newPassword: "reset-password-789!", token } });
    const rows = await notices(a.id, "password_changed");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.content)).not.toContain(token);
  });

  it("e-mail change by a platform admin warns the OLD address only", async () => {
    const admin = await account("admin", { role: "admin" });
    const a = await account("mail");
    const next = `acn-mail-new-${sfx}@example.test`;
    await auth.api.adminUpdateUser({ body: { userId: a.id, data: { email: next } }, headers: admin.headers() });
    const rows = await notices(a.id, "email_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(a.email);
    expect(JSON.stringify(rows[0]!.content)).not.toContain(next);
    // an update that does not touch the address sends nothing
    await auth.api.adminUpdateUser({ body: { userId: a.id, data: { name: "Other Name" } }, headers: admin.headers() });
    expect(await notices(a.id, "email_changed")).toHaveLength(1);
  });

  it("two-factor enable (after the first valid code) and disable are announced", async () => {
    const a = await account("2fa");
    const enabled = await auth.api.enableTwoFactor({ body: { password }, headers: a.headers() });
    expect(await notices(a.id, "two_factor_enabled")).toHaveLength(0); // not enabled until the code is verified
    void enabled;
    const [stored] = await db.select().from(twoFactor).where(eq(twoFactor.userId, a.id));
    const secret = await symmetricDecrypt({ key: (await auth.$context).secretConfig, data: stored!.secret });
    const { code } = await auth.api.generateTOTP({ body: { secret } });
    const verified = await auth.api.verifyTOTP({ body: { code }, headers: a.headers(), asResponse: true });
    const fresh = (verified.headers.get("set-cookie") ?? "").split(";")[0]!; // enabling replaces the session
    expect(await notices(a.id, "two_factor_enabled")).toHaveLength(1);
    expect(JSON.stringify((await notices(a.id, "two_factor_enabled"))[0]!.content)).not.toContain(secret);

    await auth.api.disableTwoFactor({ body: { password }, headers: new Headers({ cookie: fresh }) });
    expect(await notices(a.id, "two_factor_disabled")).toHaveLength(1);
  });
});

describe("admin password set and idempotency", () => {
  it("a password set by a platform admin is announced to the account owner", async () => {
    const admin = await account("admin-pw", { role: "admin" });
    const a = await account("admin-target");
    await auth.api.setUserPassword({ body: { userId: a.id, newPassword: "admin-set-password-1!" }, headers: admin.headers() });
    expect(await notices(a.id, "password_changed")).toHaveLength(1);
  });

  it("announcing the same change twice in one minute is one delivery", async () => {
    const a = await account("idem");
    const target = { id: a.id, name: "Idem", email: a.email };
    const now = new Date();
    await notifyAccountChange("two_factor_enabled", target, { now });
    await notifyAccountChange("two_factor_enabled", target, { now });
    expect(await notices(a.id, "two_factor_enabled")).toHaveLength(1);
    await notifyAccountChange("two_factor_enabled", target, { now: new Date(now.getTime() + 120_000) });
    expect(await notices(a.id, "two_factor_enabled")).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("picks the mail language from Accept-Language and defaults to German", () => {
    expect(pickMailLanguage("en-GB,en;q=0.8")).toBe("en");
    expect(pickMailLanguage("fr-FR,fr;q=0.9,en;q=0.5")).toBe("en");
    expect(pickMailLanguage("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(pickMailLanguage("en;q=0")).toBe("de");
    expect(pickMailLanguage("fr")).toBe("de");
    expect(pickMailLanguage(null)).toBe("de");
  });

  it("every notice exists in both languages and tells what to do if it was not the owner", () => {
    for (const kind of ["password_changed", "email_changed", "two_factor_enabled", "two_factor_disabled"] as const) {
      const de = composeAccountNotice(kind, "de");
      const en = composeAccountNotice(kind, "en");
      expect(de.title).not.toBe(en.title);
      expect(de.body).toContain("Passwort vergessen");
      expect(en.body).toContain("Forgot password");
    }
  });
});
