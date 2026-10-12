import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { forms, formVersions } from "../db/schema/forms.js";
import type { DbExecutor } from "./club-members.js";

/**
 * Standard forms every club starts with (Wave 8 B2, ADR-005). They reproduce the behaviour before the form builder:
 * the application asks for the category and an optional birth date, plus an optional photo and the privacy notice with
 * a mandatory consent. The migration `0022` seeds exactly these definitions for existing clubs
 * (`form-defaults.test.ts` keeps both in sync); new clubs get them lazily via `ensureDefaultForms`.
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
 * Idempotently gives a club its published standard forms (v1). A purpose that already has an active form is left
 * untouched, so this is safe to call on every access and under concurrency (the partial unique index decides).
 */
export async function ensureDefaultForms(clubId: string, executor: DbExecutor = db): Promise<void> {
  for (const def of DEFAULT_FORMS) {
    const [existing] = await executor
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.clubId, clubId), eq(forms.purpose, def.purpose), isNull(forms.archivedAt)))
      .limit(1);
    if (existing) continue;
    const [form] = await executor
      .insert(forms)
      .values({ clubId, purpose: def.purpose, name: def.name })
      .onConflictDoNothing()
      .returning({ id: forms.id });
    if (!form) continue; // lost the race against a parallel call; the winner inserts the version
    await executor.insert(formVersions).values({
      formId: form.id,
      version: 1,
      status: "published",
      fields: def.fields,
      privacyNotice: def.privacyNotice,
      publishedAt: new Date(),
    });
  }
}
