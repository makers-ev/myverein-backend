import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { dpaAcceptances } from "../db/schema/privacy.js";
import { writeAudit } from "../lib/audit.js";
import { currentDpaVersion, dpaStatusOf } from "../lib/dpa.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { isOwnerRole } from "../lib/member-protection.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Processor agreement of the caller's club (Wave 10 B10). Every member of the club may read the current version and the status
 * (the website shows the banner to the owner); only the OWNER accepts. These routes are never locked by the DPA gate.
 */
export const dpaRoutes = new Hono<ClubEnv>();

dpaRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
dpaRoutes.use("*", sessionGuard);
dpaRoutes.use("*", clubGuard);

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

dpaRoutes.get("/current", async (c) => {
  const { status, version } = await dpaStatusOf(c.get("clubId"));
  return c.json({
    data: {
      version: version
        ? { id: version.id, version: version.version, title: version.title, body: version.body, subprocessors: version.subprocessors, tomAnnex: version.tomAnnex, sha256: version.sha256, requiredFrom: version.requiredFrom, publishedAt: version.publishedAt }
        : null,
      status,
      canAccept: isOwnerRole(c.get("membership").role),
    },
  });
});

/** The agreement as a download (`format=markdown|html`); the HTML is escaped text in a plain page. */
dpaRoutes.get("/current/document", async (c) => {
  const version = await currentDpaVersion();
  if (!version) throw new NotFoundError("No agreement published");
  const markdown = [`# ${version.title}`, `Version ${version.version}, Prüfsumme (SHA-256): ${version.sha256}`, version.body, "## Unterauftragnehmer", ...version.subprocessors.map((s) => `- ${s.name}: ${s.purpose} (${s.location})`), ...(version.tomAnnex ? ["## Technische und organisatorische Maßnahmen", version.tomAnnex] : [])].join("\n\n");
  c.header("Cache-Control", "private, no-store");
  if (c.req.query("format") === "html") {
    const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    c.header("Content-Disposition", 'attachment; filename="av-vertrag.html"');
    return c.html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${version.title.replace(/[<>&"]/g, "")}</title><style>body{font-family:system-ui,sans-serif;max-width:50rem;margin:2rem auto;padding:0 1rem;white-space:pre-wrap;line-height:1.5}</style></head><body>${escaped}</body></html>`);
  }
  c.header("Content-Type", "text/markdown; charset=UTF-8");
  c.header("Content-Disposition", 'attachment; filename="av-vertrag.md"');
  return c.body(markdown);
});

const acceptSchema = z.object({
  dpaVersionId: z.uuid(),
  signerName: cleanText(z.string().trim().min(2).max(200)),
  // The signer confirms to be authorised to conclude the agreement for the club.
  authorized: z.literal(true),
});

dpaRoutes.post("/accept", zValidator("json", acceptSchema, validationHook), async (c) => {
  if (!isOwnerRole(c.get("membership").role)) throw new ForbiddenError("Only the owner of the club can accept the agreement");
  const body = c.req.valid("json");
  const clubId = c.get("clubId");
  const current = await currentDpaVersion();
  if (!current) throw new NotFoundError("No agreement published");
  if (current.id !== body.dpaVersionId) throw new ConflictError("A newer version of the agreement is current: read and accept that one", { details: { code: "dpa_version_outdated", currentVersionId: current.id } });
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(dpaAcceptances).where(and(eq(dpaAcceptances.clubId, clubId), eq(dpaAcceptances.dpaVersionId, current.id)));
    if (existing) return { acceptance: existing, created: false };
    const [created] = await tx
      .insert(dpaAcceptances)
      .values({ clubId, dpaVersionId: current.id, acceptedByUserId: c.get("user").id, signerName: body.signerName, authorizedConfirmed: true })
      .onConflictDoNothing()
      .returning();
    if (!created) return { acceptance: (await tx.select().from(dpaAcceptances).where(and(eq(dpaAcceptances.clubId, clubId), eq(dpaAcceptances.dpaVersionId, current.id))))[0]!, created: false };
    await writeAudit(tx, { eventType: "dpa.accept", subjectId: created.id, payload: { clubId, dpaVersionId: current.id, version: current.version } });
    return { acceptance: created, created: true };
  });
  const { status } = await dpaStatusOf(clubId);
  return c.json({ data: { acceptedAt: row.acceptance.acceptedAt, signerName: row.acceptance.signerName, version: current.version, status } }, row.created ? 201 : 200);
});
