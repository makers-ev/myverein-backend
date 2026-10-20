import { randomUUID } from "node:crypto";

import { and, eq, like, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { user } from "../auth/auth-schema.js";
import { notification } from "../db/schema/notifications.js";
import { logger } from "./logger.js";

import { db } from "../db/client.js";
import { SITE_URL } from "./emailTemplate.js";
import { jobs } from "../db/schema/jobs.js";
import { messageDeliveries } from "../db/schema/communication.js";
import {
  sendRegistrationApprovedMail,
  sendRegistrationNeedsInfoMail,
  sendRegistrationReceivedMail,
  sendRegistrationRejectedMail,
  sendRegistrationReviewNotifyMail,
  transitionOf,
} from "./club-registration-notify.js";
import { EMAIL_JOB_TYPE } from "./notify/index.js";

const applicant = { name: "Erika <b>Muster</b>", email: "erika@example.com" };
const refId = `reg-${randomUUID()}`;
const T = 1_700_000_000_000; // the status transition the mails belong to (ref_id = `<registration>#<ms>`)
const prefix = `reg-${randomUUID()}`;

/** The mail as the e-mail job sends it: address of the delivery row, pre-rendered subject and html. */
async function queuedMail(kind: string): Promise<{ to: string; subject: string; html: string }> {
  const rows = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, `club_registration.${kind}`), eq(messageDeliveries.refId, `${refId}#${T}`)));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.clubId).toBeNull();
  expect(rows[0]!.channel).toBe("email");
  const rendered = (rows[0]!.content as { class: string; rendered: { subject: string; html: string } });
  expect(rendered.class).toBe("mandatory");
  // the snapshot was recorded with the default site URL; WEB_ORIGIN differs per environment
  return { to: rows[0]!.address!, subject: rendered.rendered.subject, html: rendered.rendered.html.replaceAll(SITE_URL, "http://localhost:3011") };
}

// The expected output is the snapshot recorded from the former ad-hoc club-registration-mail.ts (Wave 6): the content
// must not change when the mails move onto the dispatcher.
afterAll(async () => {
  // keep the shared queue free of the mails of this file (the worker test of the dispatcher drains all notify.email jobs)
  const rows = await db.select({ id: messageDeliveries.id }).from(messageDeliveries).where(or(like(messageDeliveries.refId, `${refId}#%`), like(messageDeliveries.refId, `${prefix}%`)));
  for (const r of rows) {
    await db.delete(jobs).where(like(jobs.dedupeKey, `${EMAIL_JOB_TYPE}:${r.id}`));
    await db.delete(messageDeliveries).where(eq(messageDeliveries.id, r.id));
  }
});

describe("club registration mail content snapshot (pre-dispatcher)", () => {
  beforeEach(() => {
    process.env.CLUB_REVIEW_NOTIFY_EMAIL = "review@example.com";
  });

  it("keeps subject and html of all five mails", async () => {
    const mails = [];
    await sendRegistrationReceivedMail(applicant, "TV Test", refId, T);
    mails.push(await queuedMail("received"));
    await sendRegistrationReviewNotifyMail(applicant, "TV Test", refId, T);
    mails.push(await queuedMail("review-notify"));
    await sendRegistrationNeedsInfoMail(applicant, "TV Test", "Bitte Satzung\nnachreichen", refId, T);
    mails.push(await queuedMail("needs-info"));
    await sendRegistrationRejectedMail(applicant, "TV Test", "Nicht gemeinnützig", refId, T);
    mails.push(await queuedMail("rejected"));
    await sendRegistrationApprovedMail(applicant, "TV Test", "tv-test", refId, T);
    mails.push(await queuedMail("approved"));
    expect(mails).toMatchSnapshot();
  });

  it("queues one mail per configured reviewer, none when unset, and never throws", async () => {
    process.env.CLUB_REVIEW_NOTIFY_EMAIL = "a@example.com, b@example.com";
    const ref = `${prefix}-${randomUUID()}`;
    await sendRegistrationReviewNotifyMail(applicant, "TV Test", ref, T);
    const rows = await db.select().from(messageDeliveries).where(eq(messageDeliveries.refId, `${ref}#${T}`));
    expect(rows.map((r) => r.address).sort()).toEqual(["a@example.com", "b@example.com"]);
    delete process.env.CLUB_REVIEW_NOTIFY_EMAIL;
    await expect(sendRegistrationReviewNotifyMail(applicant, "TV Test", `${prefix}-${randomUUID()}`, T)).resolves.toBeUndefined();
  });

  it("escapes user-supplied text in the HTML body", async () => {
    const ref = `${prefix}-${randomUUID()}`;
    await sendRegistrationNeedsInfoMail(applicant, "<script>x</script>", "Zeile 1\n<img src=x>", ref, T);
    const [row] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.refId, `${ref}#${T}`));
    const html = (row!.content as { rendered: { html: string } }).rendered.html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Zeile 1<br />");
  });
});

describe("delivery-level dedupe (G9)", () => {
  const rowsOf = (ref: string) => db.select().from(messageDeliveries).where(like(messageDeliveries.refId, `${ref}#%`));

  it("the same transition is one delivery per mail kind, with and without an account id", async () => {
    const ref = `${prefix}-dup-${randomUUID()}`;
    const withUser = { ...applicant, userId: undefined as string | undefined };
    await sendRegistrationReceivedMail(withUser, "TV Test", ref, T);
    await sendRegistrationReceivedMail(withUser, "TV Test", ref, T);
    expect(await rowsOf(ref)).toHaveLength(1);

    const ref2 = `${prefix}-dup2-${randomUUID()}`;
    const [u] = await db.insert(user).values({ id: `reg-dup-${randomUUID()}`, name: "Dup", email: `dup-${randomUUID()}@example.test`, emailVerified: true }).returning();
    try {
      const account = { name: u!.name, email: u!.email, userId: u!.id };
      await sendRegistrationApprovedMail(account, "TV Test", "tv-test", ref2, T);
      await sendRegistrationApprovedMail(account, "TV Test", "tv-test", ref2, T);
      const rows = await rowsOf(ref2);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(u!.id);
    } finally {
      await db.delete(user).where(eq(user.id, u!.id));
    }
  });

  it("a later transition (re-submit after needs_info) is a new delivery", async () => {
    const ref = `${prefix}-again-${randomUUID()}`;
    await sendRegistrationReceivedMail(applicant, "TV Test", ref, T);
    await sendRegistrationReceivedMail(applicant, "TV Test", ref, T + 60_000);
    expect(await rowsOf(ref)).toHaveLength(2);
  });

  it("review notifications to the configured addresses are deduplicated per address", async () => {
    process.env.CLUB_REVIEW_NOTIFY_EMAIL = "Rev@example.com, rev@example.com, other@example.com";
    const ref = `${prefix}-rev-${randomUUID()}`;
    await sendRegistrationReviewNotifyMail(applicant, "TV Test", ref, T);
    await sendRegistrationReviewNotifyMail(applicant, "TV Test", ref, T);
    expect((await rowsOf(ref)).map((r) => r.address).sort()).toEqual(["other@example.com", "rev@example.com"]);
  });
});

describe("no CLUB_REVIEW_NOTIFY_EMAIL (G9)", () => {
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) await db.delete(user).where(eq(user.id, id));
  });
  const mkUser = async (label: string, extra: Partial<typeof user.$inferInsert>) => {
    const id = `reg-${label}-${randomUUID()}`;
    ids.push(id);
    await db.insert(user).values({ id, name: label, email: `${id}@example.test`, emailVerified: true, ...extra });
    return id;
  };
  const bell = (userId: string) => db.select().from(notification).where(eq(notification.targetUserId, userId));

  it("tells every active platform admin in the app (de + en), once per transition, and logs a warning", async () => {
    delete process.env.CLUB_REVIEW_NOTIFY_EMAIL;
    const admin = await mkUser("admin", { role: "admin" });
    const banned = await mkUser("banned-admin", { role: "admin", banned: true });
    const plain = await mkUser("plain", { role: "user" });
    const warn = vi.spyOn(logger, "warn");
    const ref = `${prefix}-bell-${randomUUID()}`;
    await sendRegistrationReviewNotifyMail(applicant, "TV Glocke", ref, T);
    await sendRegistrationReviewNotifyMail(applicant, "TV Glocke", ref, T);
    expect(warn.mock.calls.some((call) => String(call[1]).includes("CLUB_REVIEW_NOTIFY_EMAIL"))).toBe(true);
    warn.mockRestore();

    const rows = await bell(admin);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "admin", deletable: true, createdByAdminId: null });
    expect(rows[0]!.translations?.de?.title).toBe("Neuer Vereinsantrag: TV Glocke");
    expect(rows[0]!.translations?.en?.title).toBe("New club registration: TV Glocke");
    // no applicant address in the bell text
    expect(JSON.stringify(rows[0]!.translations)).not.toContain(applicant.email);
    expect(await bell(banned)).toHaveLength(0);
    expect(await bell(plain)).toHaveLength(0);

    // re-submit after needs_info = new transition = new entry
    await sendRegistrationReviewNotifyMail(applicant, "TV Glocke", ref, T + 60_000);
    expect(await bell(admin)).toHaveLength(2);
  });

  it("does not use the bell when reviewer addresses are configured", async () => {
    process.env.CLUB_REVIEW_NOTIFY_EMAIL = "review@example.com";
    const admin = await mkUser("admin-env", { role: "admin" });
    await sendRegistrationReviewNotifyMail(applicant, "TV Env", `${prefix}-env-${randomUUID()}`, T);
    expect(await bell(admin)).toHaveLength(0);
  });
});

describe("transition timestamp (idempotency of the ref_id)", () => {
  it("uses the committed DB timestamp and never invents a 'now' (a missing one fails closed and is logged)", () => {
    const stamped = new Date(T);
    expect(transitionOf("reg-1", stamped, "reviewedAt")).toBe(stamped);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect(transitionOf("reg-2", null, "submittedAt")).toBeNull();
      expect(transitionOf("reg-3", undefined, "reviewedAt")).toBeNull();
      expect(transitionOf("reg-4", new Date(Number.NaN), "reviewedAt")).toBeNull();
      expect(error).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(error.mock.calls)).not.toContain("@"); // ids and field names only, no address
    } finally {
      error.mockRestore();
    }
  });
});
