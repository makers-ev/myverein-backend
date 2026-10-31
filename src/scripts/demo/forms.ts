import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { clubApplications } from "../../db/schema/club-applications.js";
import { clubExitRequests } from "../../db/schema/club-exit-requests.js";
import { clubMemberInvites } from "../../db/schema/club-member-invites.js";
import { clubPrivacyNotices } from "../../db/schema/club-privacy-notices.js";
import { forms, formSubmissions, formVersions } from "../../db/schema/forms.js";
import { writeAudit } from "../../lib/audit.js";
import { DEFAULT_PRIVACY_NOTICE } from "../../lib/form-defaults.js";
import { formFieldsSchema } from "../../lib/form-schema.js";
import { createInvite, hashInviteToken } from "../../lib/member-invites.js";
import { accountOf, clubMemberOf, emailOf, shiftDays, yearsAgo, type DemoCtx } from "./context.js";

const SHIRT = ["s", "m", "l", "xl"].map((v) => ({ value: v, label: v.toUpperCase() }));

/** The club's application form after the board customized it: names, address, interest, shirt size (custom field), photo consent. */
const APPLICATION_FIELDS = formFieldsSchema.parse([
  { key: "first_name", type: "text", label: "Vorname", required: true, mapsTo: "firstName" },
  { key: "last_name", type: "text", label: "Nachname", required: true, mapsTo: "lastName" },
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", required: true, mapsTo: "birthDate" },
  { key: "street", type: "text", label: "Straße und Hausnummer", required: false, mapsTo: "street" },
  { key: "postal_code", type: "text", label: "Postleitzahl", required: false, mapsTo: "postalCode" },
  { key: "city", type: "text", label: "Ort", required: false, mapsTo: "city" },
  { key: "phone", type: "text", label: "Telefon", required: false, mapsTo: "phone" },
  {
    key: "interest",
    type: "select",
    label: "Interesse an Abteilung",
    required: false,
    options: [
      { value: "fussball", label: "Fußball" },
      { value: "tennis", label: "Tennis" },
      { value: "turnen", label: "Turnen" },
      { value: "schwimmen", label: "Schwimmen" },
    ],
  },
  { key: "shirt_size", type: "select", label: "T-Shirt-Größe", required: false, options: SHIRT, customField: "shirt_size" },
  { key: "photo_consent", type: "consent", label: "Ich bin mit Fotos und Videos aus dem Vereinsleben einverstanden.", required: false, purposeKey: "foto_video" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutzhinweis" },
]);

/** Application form: v1 (the standard) archived, v2 published, v3 an open draft. Returns the ids needed for submissions. */
async function seedApplicationForm(ctx: DemoCtx): Promise<{ formId: string; versionId: string; exitFormId: string; exitVersionId: string }> {
  const schrift = accountOf(ctx, "schrift");
  const [form] = await db.select().from(forms).where(and(eq(forms.clubId, ctx.clubId), eq(forms.purpose, "aufnahme")));
  const [exitForm] = await db.select().from(forms).where(and(eq(forms.clubId, ctx.clubId), eq(forms.purpose, "austritt")));
  if (!form || !exitForm) throw new Error("The default forms are missing");
  await db.update(formVersions).set({ status: "archived", updatedAt: new Date() }).where(and(eq(formVersions.formId, form.id), eq(formVersions.status, "published")));
  const [v2] = await db
    .insert(formVersions)
    .values({ formId: form.id, version: 2, status: "published", fields: APPLICATION_FIELDS, privacyNotice: DEFAULT_PRIVACY_NOTICE, publishedAt: new Date(ctx.now.getTime() - 45 * 86_400_000), publishedBy: schrift.memberId })
    .returning({ id: formVersions.id });
  await db.insert(formVersions).values({
    formId: form.id,
    version: 3,
    status: "draft",
    fields: formFieldsSchema.parse([...APPLICATION_FIELDS.filter((f) => f.key !== "phone"), { key: "referral", type: "text", label: "Wie hast du von uns erfahren?", required: false }]),
    privacyNotice: DEFAULT_PRIVACY_NOTICE,
  });
  const [exitVersion] = await db.select().from(formVersions).where(and(eq(formVersions.formId, exitForm.id), eq(formVersions.status, "published")));
  await writeAudit(db, { eventType: "form.publish", subjectId: form.id, actorUserId: schrift.userId, payload: { clubId: ctx.clubId, previousVersion: 1, publishedBy: schrift.memberId, purpose: "aufnahme", version: 2 } });
  return { formId: form.id, versionId: v2!.id, exitFormId: exitForm.id, exitVersionId: exitVersion!.id };
}

/** Admission applications (pending self, pending for a child, approved, rejected, a draft) and exit requests in every status, plus member invitations. */
export async function seedRequests(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "vorsitz");
  const f = await seedApplicationForm(ctx);
  const notice = await db.query.clubPrivacyNotices.findFirst({ where: eq(clubPrivacyNotices.clubId, ctx.clubId), orderBy: (n, { desc }) => [desc(n.version)] });
  const days = (n: number) => new Date(ctx.now.getTime() + n * 86_400_000);

  const submission = async (v: { user: string | null; subject?: string; status: string; answers: Record<string, unknown>; onBehalfOf?: "self" | "guardian"; ageDays: number; decidedBy?: string; note?: string; internal?: string }) =>
    (
      await db
        .insert(formSubmissions)
        .values({
          formId: f.formId,
          formVersionId: f.versionId,
          clubId: ctx.clubId,
          submittedByUserId: v.user ? accountOf(ctx, v.user).userId : null,
          subjectClubMemberId: v.subject ? clubMemberOf(ctx, v.subject) : null,
          onBehalfOf: v.onBehalfOf ?? "self",
          answers: v.answers,
          status: v.status,
          submittedAt: v.status === "draft" ? null : days(-v.ageDays),
          decidedAt: ["accepted", "rejected"].includes(v.status) ? days(-v.ageDays + 1) : null,
          decidedBy: v.decidedBy ? accountOf(ctx, v.decidedBy).memberId : null,
          decisionNote: v.note ?? null,
          decisionInternalNote: v.internal ?? null,
          createdAt: days(-v.ageDays - 1),
          updatedAt: days(-v.ageDays),
        })
        .returning({ id: formSubmissions.id })
    )[0]!.id;

  const application = async (v: { user: string; category: string; birth: string; status: "pending" | "approved" | "rejected"; onBehalfOf?: "self" | "guardian"; submissionId: string; ageDays: number; clubMember?: string }) => {
    await db.insert(clubApplications).values({
      userId: accountOf(ctx, v.user).userId,
      clubId: ctx.clubId,
      category: v.category,
      birthDate: v.birth,
      status: v.status,
      onBehalfOf: v.onBehalfOf ?? "self",
      createdAt: days(-v.ageDays),
      decidedAt: v.status === "pending" ? null : days(-v.ageDays + 1),
      decidedBy: v.status === "pending" ? null : board.memberId,
      formSubmissionId: v.submissionId,
      clubMemberId: v.clubMember ? clubMemberOf(ctx, v.clubMember) : null,
      privacyNoticeVersionId: notice?.id ?? null,
      privacyNoticeAcknowledgedAt: days(-v.ageDays),
    });
  };

  const daniel = { first_name: "Daniel", last_name: "Roth", category: "aktiv", birth_date: yearsAgo(ctx.today, 29, 40), street: "Gartenweg 5", postal_code: "55555", city: "Wiesbach", phone: "0151 5550 7001", interest: "fussball", shirt_size: "l", photo_consent: true };
  const rejected = await submission({ user: "bewerber", status: "rejected", answers: { ...daniel, interest: "schwimmen", photo_consent: false }, ageDays: 70, decidedBy: "vorsitz", note: "Die Abteilung Schwimmen hat aktuell keine freien Plätze. Du kannst dich gern für eine andere Abteilung bewerben.", internal: "Warteliste Schwimmen voll." });
  await application({ user: "bewerber", category: "aktiv", birth: daniel.birth_date, status: "rejected", submissionId: rejected, ageDays: 70 });
  const pending = await submission({ user: "bewerber", status: "submitted", answers: daniel, ageDays: 2 });
  await application({ user: "bewerber", category: "aktiv", birth: daniel.birth_date, status: "pending", submissionId: pending, ageDays: 2 });

  const emilia = { first_name: "Emilia", last_name: "Sander", category: "kind", birth_date: yearsAgo(ctx.today, 7, 90), city: "Wiesbach", interest: "turnen", shirt_size: "s", photo_consent: true };
  const childApp = await submission({ user: "bewerber_eltern", status: "submitted", onBehalfOf: "guardian", answers: emilia, ageDays: 4 });
  await application({ user: "bewerber_eltern", category: "kind", birth: emilia.birth_date, status: "pending", onBehalfOf: "guardian", submissionId: childApp, ageDays: 4 });

  const lukasApp = await submission({ user: "mitglied", subject: "mitglied", status: "accepted", answers: { first_name: "Lukas", last_name: "Fischer", category: "aktiv", birth_date: yearsAgo(ctx.today, 38, 120) }, ageDays: 2200, decidedBy: "vorsitz" });
  await application({ user: "mitglied", category: "aktiv", birth: yearsAgo(ctx.today, 38, 120), status: "approved", submissionId: lukasApp, ageDays: 2200, clubMember: "mitglied" });

  await submission({ user: "gast", status: "draft", answers: { first_name: "Katrin", last_name: "Meyer" }, ageDays: 5 });

  // --- exit requests ---
  const exitSubmission = async (who: string, answers: Record<string, unknown>, ageDays: number) =>
    (
      await db
        .insert(formSubmissions)
        .values({ formId: f.exitFormId, formVersionId: f.exitVersionId, clubId: ctx.clubId, submittedByUserId: null, subjectClubMemberId: clubMemberOf(ctx, who), answers, status: "submitted", submittedAt: days(-ageDays) })
        .returning({ id: formSubmissions.id })
    )[0]!.id;
  const exit = (who: string, v: { kind: "cancellation" | "exclusion"; status: "pending" | "approved" | "rejected" | "withdrawn"; requestedDaysAgo: number; desiredInDays?: number; effectiveInDays?: number; reason?: string; note?: string; requestedBy?: string; submissionId?: string }) =>
    db.insert(clubExitRequests).values({
      clubMemberId: clubMemberOf(ctx, who),
      kind: v.kind,
      requestedBy: v.requestedBy ? accountOf(ctx, v.requestedBy).memberId : null,
      requestedOn: shiftDays(ctx.today, -v.requestedDaysAgo),
      desiredEffectiveOn: v.desiredInDays === undefined ? null : shiftDays(ctx.today, v.desiredInDays),
      effectiveOn: v.effectiveInDays === undefined ? null : shiftDays(ctx.today, v.effectiveInDays),
      reason: v.reason ?? null,
      status: v.status,
      decidedBy: v.status === "pending" ? null : board.memberId,
      decidedAt: v.status === "pending" ? null : days(-v.requestedDaysAgo + 1),
      decisionNote: v.note ?? null,
      formSubmissionId: v.submissionId ?? null,
      createdAt: days(-v.requestedDaysAgo),
    });
  await exit("oliver", { kind: "cancellation", status: "approved", requestedDaysAgo: 25, desiredInDays: 40, effectiveInDays: 40, reason: "Wegzug in eine andere Stadt", note: "Zum Quartalsende bestätigt." });
  await exit("nadine", { kind: "cancellation", status: "pending", requestedDaysAgo: 2, desiredInDays: 60, reason: "Zeitmangel", submissionId: await exitSubmission("nadine", { reason: "Zeitmangel", confirm: true }, 2) });
  await exit("christian", { kind: "exclusion", status: "pending", requestedDaysAgo: 5, reason: "Wiederholter Verstoß gegen die Hausordnung", requestedBy: "vorsitz" });
  await exit("anja", { kind: "cancellation", status: "withdrawn", requestedDaysAgo: 70, desiredInDays: -30, reason: "Wollte kündigen, bleibt nun doch." });
  await exit("melanie", { kind: "cancellation", status: "rejected", requestedDaysAgo: 100, reason: "Elternzeit", note: "Wir haben Ihre Mitgliedschaft auf ruhend gestellt statt zu beenden." });
  await exit("uwe", { kind: "cancellation", status: "approved", requestedDaysAgo: 120, effectiveInDays: -85, reason: "Kündigung zum Quartalsende" });
  await exit("svenja", { kind: "cancellation", status: "approved", requestedDaysAgo: 430, effectiveInDays: -400, reason: "Kündigung zum Jahresende" });
  await exit("rainer", { kind: "exclusion", status: "approved", requestedDaysAgo: 80, effectiveInDays: -60, reason: "Vereinsschädigendes Verhalten", note: "Vorstandsbeschluss nach Anhörung.", requestedBy: "vorsitz" });

  // --- invitations of members without an account ---
  await createInvite(ctx.clubId, clubMemberOf(ctx, "walter"), emailOf(ctx.opts, "walter.krueger"), board.memberId);
  const julia = await createInvite(ctx.clubId, clubMemberOf(ctx, "julia"), emailOf(ctx.opts, "julia.schwarz"), board.memberId);
  await db.update(clubMemberInvites).set({ expiresAt: days(-2), createdAt: days(-16) }).where(eq(clubMemberInvites.id, julia.invite.id));
  await db.insert(clubMemberInvites).values({
    clubMemberId: clubMemberOf(ctx, "mitglied"),
    email: accountOf(ctx, "mitglied").email,
    tokenHash: hashInviteToken(randomBytes(32).toString("base64url")),
    expiresAt: days(-2000),
    acceptedAt: days(-2190),
    createdBy: board.memberId,
    createdAt: days(-2200),
  });
  ctx.log("Anträge: 2 offen (einer für ein Kind), 1 genehmigt, 1 abgelehnt, 1 Entwurf; 8 Austrittsanträge in allen Status; 3 Einladungen (offen/abgelaufen/angenommen)");
}
