import { isDeepStrictEqual } from "node:util";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { forms, formVersions } from "../db/schema/forms.js";
import { type DbExecutor, ensureDefaultCategories } from "./club-members.js";

/**
 * Standard forms every club starts with (Wave 8 B2, ADR-005): the application asks for the category and an optional birth date,
 * plus an optional photo and shows the privacy notice. Since Wave 10 B11 there is NO consent in it: the privacy notice is
 * information (Art. 13/14 GDPR), the applicant takes note of it (`privacyNoticeAcknowledged` on submit, stored on the application as
 * `privacy_notice_acknowledged_at` / `privacy_notice_version_id`) and nothing about the application depends on it. A consent
 * must be voluntary (Art. 7(4)), so it can never be a condition of an application; optional, purpose-bound consent blocks
 * stay available in the form builder. The migration `0022` seeded the older definition (`LEGACY_DEFAULT_APPLICATION_FIELDS`, with a
 * mandatory consent); `ensureDefaultForms` replaces an untouched legacy standard form by the current one (a new version).
 */

export const DEFAULT_PRIVACY_NOTICE =
  "Wir verarbeiten deine Angaben, um über deinen Aufnahmeantrag zu entscheiden und dich als Mitglied des Vereins zu verwalten. " +
  "Verantwortlich ist der Verein. Deine Daten sind nur für die zuständigen Vorstandsmitglieder sichtbar. " +
  "Auskunft, Berichtigung und Löschung kannst du beim Vorstand verlangen.";

export const DEFAULT_APPLICATION_FIELDS = [
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", required: false, mapsTo: "birthDate" },
  { key: "photo", type: "image", label: "Profilfoto (optional)", required: false, mapsTo: "photo" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutzhinweis", required: false },
] as const;

/** The standard application form as seeded by migration `0022` (with a mandatory consent); only used to recognise an untouched one. */
export const LEGACY_DEFAULT_APPLICATION_FIELDS = [
  ...DEFAULT_APPLICATION_FIELDS,
  {
    key: "privacy_consent",
    type: "consent",
    label: "Ich habe den Datenschutzhinweis gelesen und willige in die Verarbeitung meiner Angaben ein.",
    required: true,
  },
] as const;

export const DEFAULT_EXIT_FIELDS = [
  { key: "reason", type: "textarea", label: "Grund (optional)", required: false, validation: { maxLength: 1000 } },
  { key: "confirm", type: "checkbox", label: "Ich möchte meine Mitgliedschaft beenden.", required: true },
] as const;

export const DEFAULT_FORMS = [
  { purpose: "aufnahme", name: "Aufnahmeantrag", fields: DEFAULT_APPLICATION_FIELDS, privacyNotice: DEFAULT_PRIVACY_NOTICE },
  { purpose: "austritt", name: "Austritt", fields: DEFAULT_EXIT_FIELDS, privacyNotice: null },
] as const;

/**
 * Idempotently gives a club its published standard forms (v1), atomically: runs in one transaction under an advisory
 * lock per club, so parallel callers serialise and a crash never leaves a form without its version. A purpose with an
 * active form is left untouched -- except an active form WITHOUT a published version (a broken state: applicants would
 * get "no form"), which is repaired by publishing the standard definition as the next version (an open draft moves up
 * by one number). Without a transaction handle this opens one.
 */
export async function ensureDefaultForms(clubId: string, executor: DbExecutor = db): Promise<void> {
  if (executor === db) return db.transaction((tx) => ensureDefaultForms(clubId, tx));
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`form-defaults:${clubId}`}, 0))`);
  for (const def of DEFAULT_FORMS) {
    const [existing] = await executor
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.clubId, clubId), eq(forms.purpose, def.purpose), isNull(forms.archivedAt)))
      .limit(1);
    if (existing) {
      const versions = await executor.select({ id: formVersions.id, version: formVersions.version, status: formVersions.status, fields: formVersions.fields, privacyNotice: formVersions.privacyNotice }).from(formVersions).where(eq(formVersions.formId, existing.id));
      const published = versions.find((v) => v.status === "published");
      if (published) {
        // Wave 10 B11: an untouched legacy standard application form (mandatory consent) is replaced by the current standard.
        if (def.purpose === "aufnahme" && isDeepStrictEqual(published.fields, JSON.parse(JSON.stringify(LEGACY_DEFAULT_APPLICATION_FIELDS))) && published.privacyNotice === DEFAULT_PRIVACY_NOTICE) {
          const openDraft = versions.find((v) => v.status === "draft");
          // The new standard takes the number an open draft has (the draft moves up by one), else the next free one.
          const upgrade = openDraft ? openDraft.version : Math.max(...versions.map((v) => v.version)) + 1;
          if (openDraft) await executor.update(formVersions).set({ version: upgrade + 1 }).where(eq(formVersions.id, openDraft.id));
          await executor.update(formVersions).set({ status: "archived", updatedAt: new Date() }).where(eq(formVersions.id, published.id));
          await executor.insert(formVersions).values({ formId: existing.id, version: upgrade, status: "published", fields: def.fields, privacyNotice: def.privacyNotice, publishedAt: new Date() });
        }
        continue;
      }
      const next = Math.max(0, ...versions.map((v) => v.version)) + 1;
      const draft = versions.find((v) => v.status === "draft");
      if (draft) await executor.update(formVersions).set({ version: next + 1 }).where(eq(formVersions.id, draft.id));
      await executor.insert(formVersions).values({ formId: existing.id, version: next, status: "published", fields: def.fields, privacyNotice: def.privacyNotice, publishedAt: new Date() });
      continue;
    }
    const [form] = await executor.insert(forms).values({ clubId, purpose: def.purpose, name: def.name }).returning({ id: forms.id });
    await executor.insert(formVersions).values({ formId: form!.id, version: 1, status: "published", fields: def.fields, privacyNotice: def.privacyNotice, publishedAt: new Date() });
  }
}

/** Standard categories AND standard forms of a club in one transaction (the form references the categories). */
export async function ensureClubFormDefaults(clubId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await ensureDefaultCategories(clubId, tx);
    await ensureDefaultForms(clubId, tx);
  });
}
