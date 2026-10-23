import { createHash } from "node:crypto";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { dpaAcceptances, dpaVersions, type DpaVersionRow } from "../db/schema/privacy.js";
import type { DbExecutor } from "./club-members.js";
import { addDays, daysBetween } from "./club-time.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { isOwnerRole } from "./member-protection.js";
import { todayBerlin } from "./member-lifecycle.js";
import { notify } from "./notify/dispatcher.js";
import { formatIsoDay } from "./notify/i18n.js";
import { BOARD_CATEGORY } from "./notify/types.js";

/**
 * Processor agreement (AV-Vertrag, Art. 28 GDPR) between the platform and a club (Wave 10 B10).
 *
 * The platform admin publishes versions (`dpa_versions`, immutable once published, SHA-256 over the content); the OWNER of a club
 * accepts the current version for the club (`dpa_acceptances`: who, name, authorisation confirmed, when). `DPA_REQUIRED=true`
 * switches the gate on (default off until the contract text is released, K4): a club without acceptance of the current version
 * may keep working for `DPA_GRACE_DAYS` (default 30) after the later of the version's `required_from` date and the day the club
 * was created, with a banner (`GET /dpa/current`); after that all WRITING routes of the club answer `403 DPA_REQUIRED`
 * (`middleware/dpa-gate.ts`). Reading, `/dpa/*` and the rights of data subjects (export, erasure requests, revoking a consent) stay open.
 */

export const DPA_NOTIFY_JOB_TYPE = "dpa_version_notify";

export function dpaRequired(): boolean {
  return process.env.DPA_REQUIRED === "true";
}

export function dpaGraceDays(): number {
  const n = Number(process.env.DPA_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= 365 ? Math.floor(n) : 30;
}

export interface DpaContent {
  title: string;
  body: string;
  subprocessors: Array<{ name: string; purpose: string; location: string }>;
  tomAnnex: string | null;
}

/** Checksum of the exact content a club agrees to. */
export function dpaChecksum(content: DpaContent): string {
  return createHash("sha256").update(JSON.stringify([content.title, content.body, content.subprocessors, content.tomAnnex ?? null]), "utf8").digest("hex");
}

/** The newest published version, or null while none is published. */
export async function currentDpaVersion(executor: DbExecutor = db): Promise<DpaVersionRow | null> {
  const [row] = await executor.select().from(dpaVersions).where(isNotNull(dpaVersions.publishedAt)).orderBy(desc(dpaVersions.version)).limit(1);
  return row ?? null;
}

export interface DpaStatus {
  /** The gate is switched on (`DPA_REQUIRED=true`) and a version is published. */
  required: boolean;
  version: number | null;
  accepted: boolean;
  acceptedAt: Date | null;
  signerName: string | null;
  /** First day the version is mandatory for this club (ISO date). */
  mandatoryFrom: string | null;
  /** Last day of the grace period; writing stops the day after. */
  deadline: string | null;
  daysLeft: number | null;
  /** Writing routes are locked (`DPA_REQUIRED`). */
  blocked: boolean;
}

export async function dpaStatusOf(clubId: string, now: Date = new Date(), executor: DbExecutor = db): Promise<{ status: DpaStatus; version: DpaVersionRow | null }> {
  const version = await currentDpaVersion(executor);
  const empty: DpaStatus = { required: false, version: null, accepted: false, acceptedAt: null, signerName: null, mandatoryFrom: null, deadline: null, daysLeft: null, blocked: false };
  if (!version) return { status: empty, version: null };
  const [acceptance] = await executor.select().from(dpaAcceptances).where(and(eq(dpaAcceptances.clubId, clubId), eq(dpaAcceptances.dpaVersionId, version.id)));
  const [club] = await executor.select({ createdAt: organization.createdAt }).from(organization).where(eq(organization.id, clubId));
  const published = version.publishedAt!.toISOString().slice(0, 10);
  const created = club ? club.createdAt.toISOString().slice(0, 10) : published;
  const requiredFrom = version.requiredFrom ?? published;
  const mandatoryFrom = requiredFrom > created ? requiredFrom : created;
  const deadline = addDays(mandatoryFrom, dpaGraceDays());
  const today = todayBerlin(now);
  const required = dpaRequired();
  return {
    version,
    status: {
      required,
      version: version.version,
      accepted: acceptance !== undefined,
      acceptedAt: acceptance?.acceptedAt ?? null,
      signerName: acceptance?.signerName ?? null,
      mandatoryFrom,
      deadline,
      daysLeft: acceptance ? null : daysBetween(today, deadline),
      blocked: required && acceptance === undefined && today > deadline,
    },
  };
}

/** Owners of a club: the accounts that may accept the agreement. */
export async function clubOwners(clubId: string): Promise<Array<{ userId: string; name: string; email: string }>> {
  const rows = await db
    .select({ role: member.role, userId: user.id, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, clubId));
  return rows.filter((r) => isOwnerRole(r.role)).map(({ userId, name, email }) => ({ userId, name, email }));
}

/** Job `dpa_version_notify`: tells the owners of every club that has not accepted a freshly published version (payload: the version id, optionally one club). */
export async function handleDpaVersionNotify(job: JobContext): Promise<void> {
  const versionId = job.payload.dpaVersionId;
  if (typeof versionId !== "string") return;
  const [version] = await db.select().from(dpaVersions).where(and(eq(dpaVersions.id, versionId), isNotNull(dpaVersions.publishedAt)));
  if (!version) return;
  const only = typeof job.payload.clubId === "string" ? job.payload.clubId : null;
  const clubs = await db.select({ id: organization.id }).from(organization).where(only ? eq(organization.id, only) : undefined);
  for (const club of clubs) {
    try {
      const { status } = await dpaStatusOf(club.id);
      if (status.version !== version.version || status.accepted) continue;
      const owners = await clubOwners(club.id);
      if (owners.length === 0) continue;
      await notify({
        clubId: club.id,
        class: "optional",
        eventKey: "dpa.version_published",
        refId: `${version.id}`,
        recipients: owners.map((o) => ({ userId: o.userId, name: o.name, email: o.email })),
        content: {
          title: "Neuer Auftragsverarbeitungsvertrag (AV-Vertrag)",
          body: `Für euren Verein liegt die Version ${version.version} des AV-Vertrags vor. Bitte als Inhaber:in lesen und bestätigen (Vereinseinstellungen > Datenschutz > AV-Vertrag)${status.deadline ? `, spätestens bis zum ${formatIsoDay(status.deadline)}` : ""}. Danach sind nur noch lesende Zugriffe möglich.`,
          template: "reminder",
          category: BOARD_CATEGORY,
        },
        channels: ["in_app", "email"],
      });
    } catch (err) {
      // One club must not stop the others; the queue retries the job (deliveries are idempotent).
      logger.error({ errName: (err as Error)?.name, clubId: club.id }, "[dpa] could not notify the owners");
      throw err;
    }
  }
}
