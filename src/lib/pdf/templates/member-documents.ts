import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../../db/client.js";
import { clubApplications } from "../../../db/schema/club-applications.js";
import { clubExitRequests } from "../../../db/schema/club-exit-requests.js";
import { clubMembers, memberCategories } from "../../../db/schema/club-members.js";
import { forms, formSubmissions, formVersions } from "../../../db/schema/forms.js";
import { hasClubPermission } from "../../club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../errors.js";
import { consentTextSha256 } from "../../form-applications.js";
import { renderAnswers } from "../../form-review.js";
import type { FormField } from "../../form-schema.js";
import { isLeftStatus, todayBerlin } from "../../member-lifecycle.js";
import { defineTemplate } from "../registry.js";
import { dateDe, dateTimeDe, memberWithCategory, paragraphChunks, requireMembersWrite, requireRelation } from "./shared.js";

/** Member documents (Wave 13 B9): receipt of the admission application, membership confirmation, confirmation of a cancellation. All land in the personal storage of the person. */

const yesNo = (v: boolean) => (v ? "Ja" : "Nein");
const display = (v: string | string[] | boolean | number | null): string => (v === null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? yesNo(v) : String(v));

interface ReceiptData {
  memberName: string;
  memberNumber: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  formName: string | null;
  formVersion: number | null;
  onBehalfOf: "self" | "guardian";
  answers: Array<[string, string]>;
  withheld: number;
  consents: Array<{ label: string; text: string }>;
  privacyNotice: string | null;
  consentHash: string | null;
}

export const aufnahmeBelegTemplate = defineTemplate({
  id: "aufnahme-beleg",
  version: 1,
  label: "Beleg zum Aufnahmeantrag",
  description: "Momentaufnahme der Angaben und der erteilten Einwilligungen im Aufnahmeantrag. Wird bei der Annahme automatisch in der persönlichen Ablage abgelegt.",
  destination: "person",
  permission: "documents:generate",
  docType: "aufnahmebeleg",
  sensitive: true,
  sync: true,
  paramsSchema: z.object({ applicationId: z.uuid() }).strict(),
  authorize: async (actor, params) => {
    requireMembersWrite(actor);
    const [found] = await db.select({ id: clubApplications.id }).from(clubApplications).where(and(eq(clubApplications.id, params.applicationId), eq(clubApplications.clubId, actor.clubId))).limit(1);
    if (!found) throw new NotFoundError("Application not found");
  },
  build: async (clubId, params): Promise<{ data: ReceiptData; title: string; filename: string; subjectClubMemberId: string }> => {
    const [application] = await db.select().from(clubApplications).where(and(eq(clubApplications.id, params.applicationId), eq(clubApplications.clubId, clubId))).limit(1);
    if (!application || application.status !== "approved" || !application.clubMemberId) throw new NotFoundError("Application not found");
    const { row, categoryName } = await memberWithCategory(clubId, application.clubMemberId);
    const base = { memberName: row.displayName, memberNumber: row.memberNumber, decidedAt: application.decidedAt?.toISOString() ?? null, onBehalfOf: application.onBehalfOf === "guardian" ? ("guardian" as const) : ("self" as const) };
    const title = "Beleg zum Aufnahmeantrag";
    const filename = "aufnahmeantrag-beleg.pdf";

    if (!application.formSubmissionId) {
      // Applications from before the form builder: category and birth date are all there is.
      const answers: Array<[string, string]> = [["Mitgliedskategorie", categoryName ?? application.category]];
      return { data: { ...base, submittedAt: application.createdAt.toISOString(), formName: null, formVersion: null, answers, withheld: 0, consents: [], privacyNotice: null, consentHash: null }, title, filename, subjectClubMemberId: row.id };
    }

    const [found] = await db
      .select({ sub: formSubmissions, version: formVersions, form: forms })
      .from(formSubmissions)
      .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
      .innerJoin(forms, eq(forms.id, formSubmissions.formId))
      .where(and(eq(formSubmissions.id, application.formSubmissionId), eq(formSubmissions.clubId, clubId)))
      .limit(1);
    if (!found) throw new NotFoundError("Application form not found");
    const fields = found.version.fields as FormField[];
    const categories = await db.select({ key: memberCategories.key, name: memberCategories.name }).from(memberCategories).where(eq(memberCategories.clubId, clubId));
    // The person's own copy contains their own data; fields the form marks as sensitive stay out of the receipt (named, not shown).
    const rendered = renderAnswers(fields, found.sub.answers, { categories, canReadSensitive: true });
    const shown = rendered.filter((a) => a.type !== "consent" && a.answered && !fields.find((f) => f.key === a.key)?.sensitive);
    const withheld = rendered.filter((a) => a.type !== "consent" && a.answered && fields.find((f) => f.key === a.key)?.sensitive).length;
    const answers = shown.map((a): [string, string] => [a.label, display(a.display)]);
    const given = new Set(rendered.filter((a) => a.type === "consent" && a.value === true).map((a) => a.key));
    const consents = fields.filter((f) => f.type === "consent" && given.has(f.key)).map((f) => ({ label: f.label, text: f.helpText ?? "" }));
    const privacy = fields.filter((f) => f.type === "info" && f.infoKind === "privacy_notice").map((f) => `${f.label}\n${f.text ?? ""}`.trim());
    const notice = [found.version.privacyNotice, ...privacy].filter((t): t is string => !!t && t.trim() !== "").join("\n\n") || null;
    return {
      data: {
        ...base,
        submittedAt: found.sub.submittedAt?.toISOString() ?? null,
        formName: found.form.name,
        formVersion: found.version.version,
        answers,
        withheld,
        consents,
        privacyNotice: notice,
        consentHash: consentTextSha256(found.version),
      },
      title,
      filename,
      subjectClubMemberId: row.id,
    };
  },
  layout: (built, branding) => {
    const d = built.data as ReceiptData;
    return {
      format: "a4" as const,
      title: built.title,
      blocks: [
        { type: "heading", text: "Beleg zum Aufnahmeantrag" },
        { type: "paragraph", text: `Dieser Beleg hält fest, welche Angaben im Aufnahmeantrag an ${branding.clubName} gemacht wurden und welchen Einwilligungen dabei zugestimmt wurde. Er ist eine Momentaufnahme und ändert sich nicht, wenn Stammdaten später angepasst werden.` },
        {
          type: "keyValue",
          rows: [
            ["Name", d.memberName],
            ["Mitgliedsnummer", d.memberNumber ?? "-"],
            ["Antrag eingereicht", dateTimeDe(d.submittedAt ? new Date(d.submittedAt) : null) || "-"],
            ["Antrag angenommen", dateDe(d.decidedAt ? todayBerlin(new Date(d.decidedAt)) : null) || "-"],
            ["Antrag gestellt", d.onBehalfOf === "guardian" ? "durch eine erziehungsberechtigte Person für das Kind" : "durch die Person selbst"],
            ...(d.formName ? ([["Formular", `${d.formName}, Version ${d.formVersion}`]] as Array<[string, string]>) : []),
          ],
        },
        { type: "heading", text: "Angaben im Antrag", level: 2 },
        d.answers.length > 0 ? { type: "keyValue", rows: d.answers } : { type: "paragraph", text: "Im Antrag wurden keine weiteren Angaben gemacht." },
        ...(d.withheld > 0 ? [{ type: "paragraph" as const, text: `${d.withheld} als vertraulich markierte Angabe(n) sind aus Datenschutzgründen nicht in diesem Beleg enthalten.` }] : []),
        { type: "heading", text: "Erteilte Einwilligungen", level: 2 },
        ...(d.consents.length > 0
          ? d.consents.flatMap((c) => [{ type: "paragraph" as const, text: `Zugestimmt: ${c.label}${c.text ? `\n${c.text}` : ""}` }])
          : [{ type: "paragraph" as const, text: "Im Antrag wurde keiner Einwilligung zugestimmt." }]),
        ...(d.privacyNotice
          ? [{ type: "heading" as const, text: "Datenschutzhinweis zum Zeitpunkt des Antrags", level: 2 as const }, ...paragraphChunks(d.privacyNotice).map((text) => ({ type: "paragraph" as const, text }))]
          : []),
        ...(d.consentHash ? [{ type: "keyValue" as const, rows: [["Prüfsumme der Texte (SHA-256)", d.consentHash]] as Array<[string, string]> }] : []),
        { type: "paragraph", text: "Einfache elektronische Dokumentation, keine qualifizierte elektronische Signatur." },
      ],
    };
  },
});

interface ConfirmationData {
  memberName: string;
  memberNumber: string | null;
  category: string | null;
  joinedAt: string;
  leftAt: string | null;
  asOf: string;
}

const confirmationParams = z.object({ clubMemberId: z.uuid(), asOf: z.string().date().optional() }).strict();

export const mitgliedsbestaetigungTemplate = defineTemplate({
  id: "mitgliedsbestaetigung",
  version: 1,
  label: "Mitgliedsbestätigung",
  description: "Bescheinigung über die Mitgliedschaft zu einem Stichtag. Mitglieder (und Erziehungsberechtigte) erstellen sie selbst, der Vorstand auch für andere.",
  destination: "person",
  // Members request it for themselves: the right on the person is decided in `authorize`.
  permission: null,
  docType: "mitgliedsbestaetigung",
  sensitive: true,
  sync: true,
  paramsSchema: confirmationParams,
  authorize: async (actor, params) => {
    const relation = await requireRelation(actor, params.clubMemberId, ["self", "guardian", "board"]);
    if (relation === "board" && !hasClubPermission(actor.roleTypes, "documents:generate")) throw new ForbiddenError("Missing documents:generate permission");
    const today = todayBerlin();
    const asOf = params.asOf ?? today;
    if (asOf > today) throw new ConflictError("The reference date must not be in the future", { details: { code: "as_of_in_future" } });
    const { row } = await memberWithCategory(actor.clubId, params.clubMemberId);
    if (row.status === "interessent" || row.joinedAt > asOf) throw new ConflictError("The person was not a member on this date", { details: { code: "not_a_member_on_date" } });
  },
  build: async (clubId, params): Promise<{ data: ConfirmationData; title: string; filename: string; subjectClubMemberId: string }> => {
    const asOf = params.asOf ?? todayBerlin();
    const { row, categoryName } = await memberWithCategory(clubId, params.clubMemberId);
    if (row.status === "interessent" || row.joinedAt > asOf) throw new NotFoundError("Member not found");
    const left = (isLeftStatus(row.status) || row.leftAt !== null) && row.leftAt !== null && row.leftAt <= asOf ? row.leftAt : null;
    return {
      data: { memberName: row.displayName, memberNumber: row.memberNumber, category: categoryName, joinedAt: row.joinedAt, leftAt: left, asOf },
      title: "Mitgliedsbestätigung",
      filename: "mitgliedsbestaetigung.pdf",
      subjectClubMemberId: row.id,
    };
  },
  layout: (built, branding) => {
    const d = built.data as ConfirmationData;
    const statement = d.leftAt
      ? `Wir bestätigen, dass ${d.memberName}${d.memberNumber ? ` (Mitgliedsnummer ${d.memberNumber})` : ""} vom ${dateDe(d.joinedAt)} bis zum ${dateDe(d.leftAt)} Mitglied im Verein ${branding.clubName} war.`
      : `Wir bestätigen, dass ${d.memberName}${d.memberNumber ? ` (Mitgliedsnummer ${d.memberNumber})` : ""} seit dem ${dateDe(d.joinedAt)} Mitglied im Verein ${branding.clubName} ist.`;
    return {
      format: "a4" as const,
      title: built.title,
      blocks: [
        { type: "heading", text: "Mitgliedsbestätigung" },
        { type: "paragraph", text: statement },
        { type: "keyValue", rows: [["Name", d.memberName], ["Mitgliedsnummer", d.memberNumber ?? "-"], ["Mitgliedskategorie", d.category ?? "-"], ["Mitglied seit", dateDe(d.joinedAt)], ...(d.leftAt ? ([["Austritt zum", dateDe(d.leftAt)]] as Array<[string, string]>) : []), ["Stand", dateDe(d.asOf)]] },
        { type: "paragraph", text: "Diese Bestätigung wurde maschinell erstellt und ist ohne Unterschrift gültig, solange sie nicht verändert wurde." },
      ],
    };
  },
});

interface CancellationData {
  memberName: string;
  memberNumber: string | null;
  receivedOn: string;
  effectiveOn: string;
  decidedAt: string | null;
  note: string | null;
}

export const kuendigungsbestaetigungTemplate = defineTemplate({
  id: "kuendigungsbestaetigung",
  version: 1,
  label: "Kündigungsbestätigung",
  description: "Bestätigt den Eingang der Kündigung und den Tag, an dem die Mitgliedschaft endet. Wird bei der Annahme der Kündigung automatisch in der persönlichen Ablage abgelegt.",
  destination: "person",
  permission: "documents:generate",
  docType: "kuendigungsbestaetigung",
  sensitive: true,
  sync: true,
  paramsSchema: z.object({ exitRequestId: z.uuid() }).strict(),
  authorize: async (actor, params) => {
    requireMembersWrite(actor);
    const [found] = await db
      .select({ id: clubExitRequests.id })
      .from(clubExitRequests)
      .innerJoin(clubMembers, eq(clubMembers.id, clubExitRequests.clubMemberId))
      .where(and(eq(clubExitRequests.id, params.exitRequestId), eq(clubMembers.clubId, actor.clubId)))
      .limit(1);
    if (!found) throw new NotFoundError("Exit request not found");
  },
  build: async (clubId, params): Promise<{ data: CancellationData; title: string; filename: string; subjectClubMemberId: string }> => {
    const [request] = await db.select().from(clubExitRequests).where(eq(clubExitRequests.id, params.exitRequestId)).limit(1);
    if (!request || request.kind !== "cancellation" || request.status !== "approved" || !request.effectiveOn) throw new NotFoundError("Exit request not found");
    // The request has no club column: the club of the person decides.
    const { row } = await memberWithCategory(clubId, request.clubMemberId);
    return {
      data: { memberName: row.displayName, memberNumber: row.memberNumber, receivedOn: request.requestedOn, effectiveOn: request.effectiveOn, decidedAt: request.decidedAt?.toISOString() ?? null, note: request.decisionNote },
      title: "Kündigungsbestätigung",
      filename: "kuendigungsbestaetigung.pdf",
      subjectClubMemberId: row.id,
    };
  },
  layout: (built, branding) => {
    const d = built.data as CancellationData;
    return {
      format: "a4" as const,
      title: built.title,
      blocks: [
        { type: "heading", text: "Bestätigung der Kündigung" },
        { type: "paragraph", text: `Wir bestätigen den Eingang der Kündigung der Mitgliedschaft von ${d.memberName}${d.memberNumber ? ` (Mitgliedsnummer ${d.memberNumber})` : ""} im Verein ${branding.clubName} vom ${dateDe(d.receivedOn)}. Die Mitgliedschaft endet zum ${dateDe(d.effectiveOn)}.` },
        { type: "keyValue", rows: [["Name", d.memberName], ["Mitgliedsnummer", d.memberNumber ?? "-"], ["Eingang der Kündigung", dateDe(d.receivedOn)], ["Mitgliedschaft endet zum", dateDe(d.effectiveOn)], ["Bestätigt am", dateDe(d.decidedAt ? todayBerlin(new Date(d.decidedAt)) : null) || "-"]] },
        ...(d.note ? [{ type: "paragraph" as const, text: `Hinweis des Vereins: ${d.note}` }] : []),
        { type: "paragraph", text: "Diese Bestätigung wurde maschinell erstellt und ist ohne Unterschrift gültig." },
      ],
    };
  },
});
