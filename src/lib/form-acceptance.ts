import { z } from "zod";

import { isMappingTarget, mappingAcceptsType, type MappingTarget } from "./form-mapping.js";
import { visibleFieldKeys, type FormField } from "./form-schema.js";
import { isCleanText } from "./text-policy.js";

/**
 * What happens to an application's answers when the board accepts it (Wave 8 B6, ADR-005): a PURE function from the
 * pinned field definition + the stored answers to a plan. Nothing here reads or writes the database and the plan can
 * only ever name the allowlisted targets of `form-mapping.ts` -- a field definition (which is data) can never name a
 * column, so mass assignment is impossible by construction.
 *
 * The plan is tolerant by design: a value that does not fit its target anymore is SKIPPED with a reason (reported to the
 * board), it never fails the approval. The reasons carry field KEYS only, never answer values.
 */

/** Targets that are plain text/date columns of `club_members` (everything in the allowlist except category and photo). */
export const MASTER_TARGETS = ["firstName", "lastName", "birthDate", "street", "postalCode", "city", "phone", "contactEmail", "emergencyContactName", "emergencyContactPhone"] as const;
export type MasterTarget = (typeof MASTER_TARGETS)[number];

/** Same limits as `PATCH /club-members/:id`, re-checked at acceptance (the stored answers are only as old as the form). */
const MASTER_SCHEMAS: Record<MasterTarget, z.ZodType<string>> = {
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  birthDate: z.iso.date(),
  street: z.string().trim().min(1).max(200),
  postalCode: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(50),
  contactEmail: z.string().trim().max(320).pipe(z.email()),
  emergencyContactName: z.string().trim().min(1).max(200),
  emergencyContactPhone: z.string().trim().min(1).max(50),
};

export type SkipReason = "invalid_value" | "unknown_target" | "type_mismatch" | "not_a_text";

export interface CustomFieldAssignment {
  /** Key of the form field the value came from. */
  fieldKey: string;
  /** Key of the member custom field definition it is written to. */
  customKey: string;
  type: FormField["type"];
  sensitive: boolean;
  value: unknown;
}

export interface AcceptancePlan {
  master: Partial<Record<MasterTarget, string>>;
  /** Category KEY the applicant chose (the board may override it); null when the form has no category field or it is unanswered. */
  categoryKey: string | null;
  /** Key of the visible `image` field mapped to `photo` (the file itself is resolved by the caller). */
  photoFieldKey: string | null;
  custom: CustomFieldAssignment[];
  skipped: Array<{ fieldKey: string; reason: SkipReason }>;
}

export function isMasterTarget(target: MappingTarget): target is MasterTarget {
  return (MASTER_TARGETS as readonly string[]).includes(target);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

export function planAcceptance(fields: readonly FormField[], answers: unknown): AcceptancePlan {
  const source: Record<string, unknown> = typeof answers === "object" && answers !== null && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const plan: AcceptancePlan = { master: {}, categoryKey: null, photoFieldKey: null, custom: [], skipped: [] };
  // Fields hidden by `visibleIf` (and their dependants) are not part of the application and never mapped.
  const visible = visibleFieldKeys(fields, source);
  const usedTargets = new Set<string>();

  for (const field of fields) {
    if (field.type === "info" || !visible.has(field.key)) continue;
    const raw = Object.hasOwn(source, field.key) ? source[field.key] : undefined;

    if (field.mapsTo !== undefined) {
      const target: unknown = field.mapsTo;
      // Defence in depth: definitions are validated on save, but they are JSON in the database.
      if (!isMappingTarget(target) || usedTargets.has(target)) {
        plan.skipped.push({ fieldKey: field.key, reason: "unknown_target" });
        continue;
      }
      if (!mappingAcceptsType(target, field.type)) {
        plan.skipped.push({ fieldKey: field.key, reason: "type_mismatch" });
        continue;
      }
      usedTargets.add(target);
      if (target === "photo") {
        plan.photoFieldKey = field.key;
        continue;
      }
      if (isEmpty(raw)) continue;
      if (typeof raw !== "string") {
        plan.skipped.push({ fieldKey: field.key, reason: "not_a_text" });
        continue;
      }
      if (target === "category") {
        plan.categoryKey = raw.trim().toLowerCase();
        continue;
      }
      if (!isMasterTarget(target)) continue;
      const parsed = MASTER_SCHEMAS[target].safeParse(raw);
      if (!parsed.success || !isCleanText(parsed.data)) plan.skipped.push({ fieldKey: field.key, reason: "invalid_value" });
      else plan.master[target] = parsed.data;
      continue;
    }

    if (field.customField !== undefined && !["file", "image"].includes(field.type) && !isEmpty(raw)) {
      plan.custom.push({ fieldKey: field.key, customKey: field.customField, type: field.type, sensitive: field.sensitive === true, value: raw });
    }
  }
  return plan;
}
