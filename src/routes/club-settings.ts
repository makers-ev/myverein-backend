import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { eq } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubSettings, NOTICE_MODES } from "../db/schema/club-settings.js";
import { normalizeEmail } from "../lib/audience.js";
import { formatFrom } from "../lib/email.js";
import { LOGO_CID } from "../lib/emailTemplate.js";
import { NOTIFY_TEMPLATES, renderNotifyEmail, unsubscribeBaseUrl } from "../lib/notify/index.js";
import { cleanText } from "../lib/text-policy.js";
import { isValidTimezone } from "../lib/club-time.js";
import { loadClubSettings } from "../lib/club-settings.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Club-wide parameters (Wave 7 B6). Every member reads the values that concern them (notice period/mode for the
 * cancellation hint, member number prefix, self loans for the inventory UI); only `members:write` changes anything.
 * The club mail template (Wave 9 B15: sender name, signature, reply-to, text blocks) is read and changed with
 * `announcements:write` only; the sender ADDRESS is always `EMAIL_FROM`.
 */
export const clubSettingsRoutes = new Hono<ClubEnv>();

clubSettingsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubSettingsRoutes.use("*", sessionGuard);
clubSettingsRoutes.use("*", clubGuard);

const MAIL_FIELDS = ["senderName", "signature", "replyTo", "textBlocks"] as const;

clubSettingsRoutes.get("/", async (c) => {
  const settings = await loadClubSettings(db, c.get("clubId"));
  // The mail template is configuration for the people who write announcements; other members never see it.
  if (!hasClubPermission(c.get("clubRoleTypes"), "announcements:write")) return c.json({ data: { ...settings, senderName: null, signature: null, replyTo: null, textBlocks: [] } });
  return c.json({ data: settings });
});

/** Optional single-line / multi-line plain text; an empty string clears the value. */
const optionalText = (max: number, multiline: boolean) =>
  z
    .union([cleanText(z.string().trim().max(max), multiline), z.null()])
    .transform((v) => (v === null || v === "" ? null : v));

const textBlockSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, { message: "key must be 1-40 lower case letters, digits, '-' or '_'" }),
  title: cleanText(z.string().trim().min(1).max(80)),
  text: cleanText(z.string().trim().min(1).max(2000), true),
});

const updateSettingsSchema = z.object({
  noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
  noticeMode: z.enum(NOTICE_MODES).nullable().optional(),
  // Becomes the part before the running number ("TSV-0001"): letters and digits only, stored upper case.
  memberNumberPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, { message: "memberNumberPrefix must be 1-10 letters or digits" })
    .nullable()
    .optional(),
  allowSelfLoans: z.boolean().optional(),
  // Time zone of the club's reminders and sweeps (IANA name, e.g. "Europe/Berlin").
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimezone, { message: "timezone must be a valid IANA time zone" })
    .optional(),
  reminderEventEnabled: z.boolean().optional(),
  reminderEventLeadHours: z.number().int().min(1).max(168).optional(),
  reminderLoanEnabled: z.boolean().optional(),
  reminderLoanLeadDays: z.number().int().min(0).max(30).optional(),
  reminderMaintenanceEnabled: z.boolean().optional(),
  reminderMaintenanceLeadDays: z.number().int().min(0).max(90).optional(),
  reminderRsvpEnabled: z.boolean().optional(),
  reminderRsvpLeadDays: z.number().int().min(1).max(30).optional(),
  reminderInvitationEnabled: z.boolean().optional(),
  reminderInvitationLeadDays: z.number().int().min(1).max(30).optional(),
  reminderCredentialEnabled: z.boolean().optional(),
  reminderCredentialLeadDays: z.number().int().min(1).max(365).optional(),
  ageTransitionAuto: z.boolean().optional(),
  notifyBoardRequests: z.boolean().optional(),
  notifyMeetingInvites: z.boolean().optional(),
  notifyHandover: z.boolean().optional(),
  // Club mail template (B15).
  senderName: optionalText(80, false).optional(),
  signature: optionalText(1000, true).optional(),
  replyTo: z
    .union([z.string().trim().max(254), z.null()])
    .transform((v, ctx) => {
      if (v === null || v === "") return null;
      const email = normalizeEmail(v);
      if (!email) ctx.addIssue({ code: "custom", message: "replyTo must be a valid e-mail address" });
      return email;
    })
    .optional(),
  textBlocks: z
    .array(textBlockSchema)
    .max(20)
    .refine((blocks) => new Set(blocks.map((b) => b.key)).size === blocks.length, { message: "text block keys must be unique" })
    .optional(),
});

clubSettingsRoutes.patch(
  "/",
  zValidator("json", updateSettingsSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const changes = Object.fromEntries(Object.entries(c.req.valid("json")).filter(([, v]) => v !== undefined));
    const touchesMail = MAIL_FIELDS.some((f) => f in changes);
    const touchesOther = Object.keys(changes).some((k) => !(MAIL_FIELDS as readonly string[]).includes(k));
    // Deny by default: members:write for the club parameters (also for an empty body), announcements:write for the mail template.
    if ((touchesOther || !touchesMail) && !hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
    if (touchesMail && !hasClubPermission(c.get("clubRoleTypes"), "announcements:write")) throw new ForbiddenError("Missing announcements:write permission");

    await db.transaction(async (tx) => {
      await tx
        .insert(clubSettings)
        .values({ clubId, ...changes })
        .onConflictDoUpdate({ target: clubSettings.clubId, set: { ...changes, updatedAt: new Date() } });
      await tx.insert(auditLog).values({ eventType: "club_settings.update", subjectId: clubId, payload: { clubId, changedFields: Object.keys(changes), changedBy: c.get("membership").id } });
    });

    return c.json({ data: await loadClubSettings(db, clubId) });
  },
);

// --- Mail preview (B15) ---------------------------------------------------------------------------------------------

const SAMPLE_TITLE = "Beispiel: Training fällt aus";
const SAMPLE_BODY = "Hallo zusammen,\n\nam Donnerstag fällt das Training wegen der Hallensperrung aus. Details findet ihr in der App: https://example.org/beispiel\n\nSportliche Grüße";

const previewSchema = z.object({
  template: z.enum(NOTIFY_TEMPLATES).default("announcement"),
  // Unsaved edits of the form: override the stored values for this preview only.
  senderName: optionalText(80, false).optional(),
  signature: optionalText(1000, true).optional(),
  replyTo: updateSettingsSchema.shape.replyTo,
  // Use the text of a stored block as the body (defaults to the sample text).
  textBlockKey: z.string().trim().max(40).optional(),
});

const previewLimit = rateLimit({ windowMs: 60_000, max: 30, key: (c) => `mail-preview:${c.get("user")?.id ?? "anon"}` });

/**
 * Renders a club mail with SAMPLE data (fixed sample recipient and text, no real member, nothing is sent or stored).
 * Needs `announcements:write`. The response `html` is a full mail document: clients show it in a sandboxed iframe.
 */
clubSettingsRoutes.post("/mail-preview", previewLimit, zValidator("json", previewSchema, (result) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
}), async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "announcements:write")) throw new ForbiddenError("Missing announcements:write permission");
  const clubId = c.get("clubId");
  const input = c.req.valid("json");
  const settings = await loadClubSettings(db, clubId);
  const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  const clubName = club?.name ?? null;

  let body = SAMPLE_BODY;
  if (input.textBlockKey !== undefined) {
    const block = settings.textBlocks.find((b) => b.key === input.textBlockKey);
    if (!block) throw new ValidationError("Unknown text block", { details: { textBlockKey: input.textBlockKey } });
    body = block.text;
  }
  const senderName = input.senderName !== undefined ? input.senderName : settings.senderName;
  const signature = input.signature !== undefined ? input.signature : settings.signature;
  const replyTo = input.replyTo !== undefined ? input.replyTo : settings.replyTo;

  const { subject, html } = renderNotifyEmail({
    template: input.template,
    title: SAMPLE_TITLE,
    body,
    recipientName: "Max",
    clubName,
    ctaLabel: null,
    ctaUrl: null,
    signature,
    unsubscribeUrl: input.template === "decision" ? null : `${unsubscribeBaseUrl()}/unsubscribe/beispiel`,
  });
  const from = formatFrom(process.env.EMAIL_FROM ?? "", senderName?.trim() || clubName);
  c.header("Cache-Control", "private, no-store");
  return c.json({
    data: {
      sample: true,
      subject,
      // The real mail attaches the logo as a cid image; the preview has no attachment, so the image is left out.
      html: html.replace(new RegExp(`<img[^>]*src="cid:${LOGO_CID}"[^>]*>`, "g"), ""),
      from,
      replyTo,
    },
  });
});
