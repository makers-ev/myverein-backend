import { eq } from "drizzle-orm";
import { z } from "zod";

import { MEMBER_STATUSES } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import type { DbExecutor } from "./club-members.js";

/**
 * Statute parameters of the general assembly (Wave 11 B1). They live as ONE validated jsonb document in
 * `club_settings.assembly_rules`.
 *
 * Deliberately NO defaults for the legal parameters (invitation period, quorum, majorities, ...): `null` means "not stated
 * yet" and `missingAssemblyRules` lists what the club still has to state before the first invitation. Only the switches that
 * switch features ON default to the closed state (`onlineAllowed: none`, `circularAllowed: false`,
 * `secretBallotDigitalAllowed: false`). Nothing here is legal advice; the values are the club's reading of its own statute.
 */

export const INVITATION_FORMS = ["textform", "schriftlich"] as const;
export const QUORUM_MODES = ["none", "fraction", "absolute"] as const;
export const MAJORITY_KINDS = ["einfach", "absolut", "zwei_drittel", "drei_viertel", "einstimmig"] as const;
export const MAJORITY_TOPICS = ["allgemein", "satzungsaenderung", "zweckaenderung", "wahl", "entlastung", "aufloesung"] as const;
export const ABSTAIN_RULES = ["not_counted", "against"] as const;
export const ONLINE_MODES = ["none", "hybrid", "virtual"] as const;
export const TERM_EXPIRY_EFFECTS = ["none", "suspend_permissions"] as const;

export type InvitationForm = (typeof INVITATION_FORMS)[number];
export type QuorumMode = (typeof QUORUM_MODES)[number];
export type MajorityKind = (typeof MAJORITY_KINDS)[number];
export type MajorityTopic = (typeof MAJORITY_TOPICS)[number];
export type AbstainRule = (typeof ABSTAIN_RULES)[number];

const nullableInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable();
const majority = z.enum(MAJORITY_KINDS).nullable();
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === "" ? null : v));

/** The complete document as stored and returned. Every legal field is nullable (= not stated). */
export const assemblyRulesSchema = z
  .object({
    /** Days between sending the invitation and the assembly (statute). */
    invitationMinDays: nullableInt(0, 365),
    /** Extra days added for delivery (post, e-mail), counted on top of `invitationMinDays`. */
    invitationDeliveryBufferDays: nullableInt(0, 30),
    invitationForm: z.enum(INVITATION_FORMS).nullable(),
    /** Whether the agenda has to be part of the invitation (resolutions only on announced items). */
    agendaRequiredInInvitation: z.boolean().nullable(),
    quorumMode: z.enum(QUORUM_MODES).nullable(),
    /** `fraction`: share of the eligible members (0 < v <= 1); `absolute`: number of eligible members present. */
    quorumValue: z.number().positive().nullable(),
    majorityByTopic: z.object({ allgemein: majority, satzungsaenderung: majority, zweckaenderung: majority, wahl: majority, entlastung: majority, aufloesung: majority }).strict(),
    abstainCountsAs: z.enum(ABSTAIN_RULES).nullable(),
    proxyAllowed: z.boolean().nullable(),
    /** How many proxies one person may hold (only meaningful with `proxyAllowed`). */
    maxProxiesPerPerson: nullableInt(1, 20),
    onlineAllowed: z.enum(ONLINE_MODES),
    circularAllowed: z.boolean(),
    /** Share of the eligible members that has to take part in a circular resolution (0 < v <= 1). */
    circularMinParticipation: z.number().gt(0).max(1).nullable(),
    circularUnanimity: z.boolean().nullable(),
    secretBallotDigitalAllowed: z.boolean(),
    votingMinAge: nullableInt(0, 30),
    /** Member statuses that carry the right to vote (on top of the category flag). */
    votingStatuses: z.array(z.enum(MEMBER_STATUSES)).max(MEMBER_STATUSES.length).nullable(),
    /** Days before the end of a term (descending, 0 = on the day) a reminder is sent. */
    termWarningDays: z.array(z.number().int().min(0).max(730)).max(6).nullable(),
    termExpiryEffect: z.enum(TERM_EXPIRY_EFFECTS),
    satzungReference: nullableText(300),
    /** Slug of the club info page that carries the statute. */
    satzungPageSlug: nullableText(100),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.quorumMode === "fraction" && r.quorumValue !== null && r.quorumValue > 1) ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "quorumValue of a fraction must be greater than 0 and at most 1" });
    if (r.quorumMode === "absolute" && r.quorumValue !== null && !Number.isInteger(r.quorumValue)) ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "quorumValue of an absolute quorum must be a whole number" });
    if (r.quorumMode === "none" && r.quorumValue !== null) ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "quorumValue must be empty without a quorum" });
    if (r.proxyAllowed === false && r.maxProxiesPerPerson !== null) ctx.addIssue({ code: "custom", path: ["maxProxiesPerPerson"], message: "maxProxiesPerPerson must be empty while proxies are not allowed" });
    if (r.termWarningDays && new Set(r.termWarningDays).size !== r.termWarningDays.length) ctx.addIssue({ code: "custom", path: ["termWarningDays"], message: "termWarningDays must not repeat a value" });
    if (r.votingStatuses && new Set(r.votingStatuses).size !== r.votingStatuses.length) ctx.addIssue({ code: "custom", path: ["votingStatuses"], message: "votingStatuses must not repeat a status" });
  });

export type AssemblyRules = z.infer<typeof assemblyRulesSchema>;

/** Nothing stated yet: legal fields null, feature switches closed. */
export function emptyAssemblyRules(): AssemblyRules {
  return {
    invitationMinDays: null,
    invitationDeliveryBufferDays: null,
    invitationForm: null,
    agendaRequiredInInvitation: null,
    quorumMode: null,
    quorumValue: null,
    majorityByTopic: { allgemein: null, satzungsaenderung: null, zweckaenderung: null, wahl: null, entlastung: null, aufloesung: null },
    abstainCountsAs: null,
    proxyAllowed: null,
    maxProxiesPerPerson: null,
    onlineAllowed: "none",
    circularAllowed: false,
    circularMinParticipation: null,
    circularUnanimity: null,
    secretBallotDigitalAllowed: false,
    votingMinAge: null,
    votingStatuses: null,
    termWarningDays: null,
    termExpiryEffect: "none",
    satzungReference: null,
    satzungPageSlug: null,
  };
}

/**
 * The input of a PATCH: every key optional, a topic map may carry single topics. `null` clears a legal field again;
 * the closed switches (`onlineAllowed`, `circularAllowed`, ...) are plain values.
 */
export const assemblyRulesPatchSchema = z
  .object({
    invitationMinDays: nullableInt(0, 365),
    invitationDeliveryBufferDays: nullableInt(0, 30),
    invitationForm: z.enum(INVITATION_FORMS).nullable(),
    agendaRequiredInInvitation: z.boolean().nullable(),
    quorumMode: z.enum(QUORUM_MODES).nullable(),
    quorumValue: z.number().positive().nullable(),
    majorityByTopic: z
      .object({ allgemein: majority, satzungsaenderung: majority, zweckaenderung: majority, wahl: majority, entlastung: majority, aufloesung: majority })
      .partial()
      .strict(),
    abstainCountsAs: z.enum(ABSTAIN_RULES).nullable(),
    proxyAllowed: z.boolean().nullable(),
    maxProxiesPerPerson: nullableInt(1, 20),
    onlineAllowed: z.enum(ONLINE_MODES),
    circularAllowed: z.boolean(),
    circularMinParticipation: z.number().gt(0).max(1).nullable(),
    circularUnanimity: z.boolean().nullable(),
    secretBallotDigitalAllowed: z.boolean(),
    votingMinAge: nullableInt(0, 30),
    votingStatuses: z.array(z.enum(MEMBER_STATUSES)).max(MEMBER_STATUSES.length).nullable(),
    termWarningDays: z.array(z.number().int().min(0).max(730)).max(6).nullable(),
    termExpiryEffect: z.enum(TERM_EXPIRY_EFFECTS),
    satzungReference: nullableText(300),
    satzungPageSlug: nullableText(100),
  })
  .partial()
  .strict();

export type AssemblyRulesPatch = z.infer<typeof assemblyRulesPatchSchema>;

/** Merges a patch into the current rules (topics merge one by one). Validate the result with `assemblyRulesSchema`. */
export function mergeAssemblyRules(current: AssemblyRules, patch: AssemblyRulesPatch): unknown {
  const { majorityByTopic, ...rest } = patch;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const topics = Object.fromEntries(Object.entries(majorityByTopic ?? {}).filter(([, v]) => v !== undefined));
  return { ...current, ...defined, majorityByTopic: { ...current.majorityByTopic, ...topics } };
}

/** Reads a stored document; missing keys fall back to "not stated", an unreadable document counts as empty. */
export function parseStoredAssemblyRules(stored: unknown): AssemblyRules {
  const base = emptyAssemblyRules();
  if (!stored || typeof stored !== "object") return base;
  const raw = stored as Record<string, unknown>;
  const merged = { ...base, ...raw, majorityByTopic: { ...base.majorityByTopic, ...((raw.majorityByTopic as object | undefined) ?? {}) } };
  const parsed = assemblyRulesSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

export async function loadAssemblyRules(executor: DbExecutor, clubId: string): Promise<AssemblyRules> {
  const row = await executor.query.clubSettings.findFirst({ where: eq(clubSettings.clubId, clubId), columns: { assemblyRules: true } });
  return parseStoredAssemblyRules(row?.assemblyRules);
}

/**
 * The parameters the club has to state before the first invitation (keys of `AssemblyRules`, topics as
 * `majorityByTopic.<topic>`). Empty = ready. Conditional ones: the quorum value with a quorum, the proxy limit with proxies.
 */
export function missingAssemblyRules(rules: AssemblyRules): string[] {
  const missing: string[] = [];
  if (rules.invitationMinDays === null) missing.push("invitationMinDays");
  if (rules.invitationDeliveryBufferDays === null) missing.push("invitationDeliveryBufferDays");
  if (rules.invitationForm === null) missing.push("invitationForm");
  if (rules.agendaRequiredInInvitation === null) missing.push("agendaRequiredInInvitation");
  if (rules.quorumMode === null) missing.push("quorumMode");
  else if (rules.quorumMode !== "none" && rules.quorumValue === null) missing.push("quorumValue");
  if (rules.majorityByTopic.allgemein === null) missing.push("majorityByTopic.allgemein");
  if (rules.abstainCountsAs === null) missing.push("abstainCountsAs");
  if (rules.proxyAllowed === null) missing.push("proxyAllowed");
  else if (rules.proxyAllowed && rules.maxProxiesPerPerson === null) missing.push("maxProxiesPerPerson");
  if (rules.votingStatuses === null || rules.votingStatuses.length === 0) missing.push("votingStatuses");
  if (rules.votingMinAge === null) missing.push("votingMinAge");
  if (rules.circularAllowed) {
    if (rules.circularUnanimity === null) missing.push("circularUnanimity");
    if (rules.circularUnanimity === false && rules.circularMinParticipation === null) missing.push("circularMinParticipation");
  }
  return missing;
}

/** The majority a topic needs; a topic without its own entry falls back to `allgemein` (null while that is not stated either). */
export function majorityFor(rules: AssemblyRules, topic: MajorityTopic): MajorityKind | null {
  return rules.majorityByTopic[topic] ?? rules.majorityByTopic.allgemein;
}
