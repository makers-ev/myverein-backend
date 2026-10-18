import { randomUUID } from "node:crypto";

import { and, eq, like, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
} from "./club-registration-notify.js";
import { EMAIL_JOB_TYPE } from "./notify/index.js";

const applicant = { name: "Erika <b>Muster</b>", email: "erika@example.com" };
const refId = `reg-${randomUUID()}`;
const prefix = `reg-${randomUUID()}`;

/** The mail as the e-mail job sends it: address of the delivery row, pre-rendered subject and html. */
async function queuedMail(kind: string): Promise<{ to: string; subject: string; html: string }> {
  const rows = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, `club_registration.${kind}`), eq(messageDeliveries.refId, refId)));
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
  const rows = await db.select({ id: messageDeliveries.id }).from(messageDeliveries).where(or(eq(messageDeliveries.refId, refId), like(messageDeliveries.refId, `${prefix}%`)));
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
    await sendRegistrationReceivedMail(applicant, "TV Test", refId);
    mails.push(await queuedMail("received"));
    await sendRegistrationReviewNotifyMail(applicant, "TV Test", refId);
    mails.push(await queuedMail("review-notify"));
    await sendRegistrationNeedsInfoMail(applicant, "TV Test", "Bitte Satzung\nnachreichen", refId);
    mails.push(await queuedMail("needs-info"));
    await sendRegistrationRejectedMail(applicant, "TV Test", "Nicht gemeinnützig", refId);
    mails.push(await queuedMail("rejected"));
    await sendRegistrationApprovedMail(applicant, "TV Test", "tv-test", refId);
    mails.push(await queuedMail("approved"));
    expect(mails).toMatchSnapshot();
  });

  it("queues one mail per configured reviewer, none when unset, and never throws", async () => {
    process.env.CLUB_REVIEW_NOTIFY_EMAIL = "a@example.com, b@example.com";
    const ref = `${prefix}-${randomUUID()}`;
    await sendRegistrationReviewNotifyMail(applicant, "TV Test", ref);
    const rows = await db.select().from(messageDeliveries).where(eq(messageDeliveries.refId, ref));
    expect(rows.map((r) => r.address).sort()).toEqual(["a@example.com", "b@example.com"]);
    delete process.env.CLUB_REVIEW_NOTIFY_EMAIL;
    await expect(sendRegistrationReviewNotifyMail(applicant, "TV Test", `${prefix}-${randomUUID()}`)).resolves.toBeUndefined();
  });

  it("escapes user-supplied text in the HTML body", async () => {
    const ref = `${prefix}-${randomUUID()}`;
    await sendRegistrationNeedsInfoMail(applicant, "<script>x</script>", "Zeile 1\n<img src=x>", ref);
    const [row] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.refId, ref));
    const html = (row!.content as { rendered: { html: string } }).rendered.html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Zeile 1<br />");
  });
});
