import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { documents } from "../db/schema/documents.js";
import { PDF_BYTES } from "../lib/media-fixtures.js";
import { storageUsage } from "../lib/media-quota.js";
import { createClub, dropClubs, installErrorHandler, requester, type Account } from "./forms-test-support.js";
import { memberDocumentRoutes } from "./member-documents.js";

/** Wave 13 review: byte cap and document cap of the personal storage (race free) and the quota reserve for the board. */
const app = new Hono();
app.route("/member-documents", memberDocumentRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;
const pdf = (kb: number, tag: string) => new File([new Uint8Array(Buffer.concat([PDF_BYTES, Buffer.from(tag), Buffer.alloc(kb * 1024, 65)]))], "x.pdf", { type: "application/pdf" });
const form = (f: File) => {
  const d = new FormData();
  d.set("file", f);
  return d;
};

describe("personal storage limits", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let cm = "";
  const id = () => club.clubId;
  const upload = (who: Account, memberId: string, f: File) => call(who, `/member-documents/${memberId}`, { method: "POST", clubId: id(), form: form(f) });
  const previous = process.env.MEMBER_DOCUMENT_MAX_BYTES;

  beforeAll(async () => {
    club = await createClub("mlim", suffix, { plain: null, other: null });
    const account = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, id()), e(m.userId, club.members.plain!.userId)) });
    cm = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account!.id) }))!.id;
  }, 60_000);
  afterAll(async () => {
    if (previous === undefined) delete process.env.MEMBER_DOCUMENT_MAX_BYTES;
    else process.env.MEMBER_DOCUMENT_MAX_BYTES = previous;
    await dropClubs([club.clubId], club.userIds);
    await closeDatabase();
  });

  it("caps the bytes per member, also under parallel uploads, and the board is bound by it too", async () => {
    process.env.MEMBER_DOCUMENT_MAX_BYTES = String(1_000_000);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => upload(club.members.plain!, "me", pdf(400, `par-${i}`))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const refused = results.find((r) => r.status === 409)!;
    expect((await body(refused)).error.details).toMatchObject({ code: "member_document_bytes", limitBytes: 1_000_000 });
    expect((await upload(club.founder, cm, pdf(400, "board"))).status).toBe(409);
    // A small file still fits into the rest.
    expect((await upload(club.members.plain!, "me", pdf(10, "small"))).status).toBe(201);
  });

  it("caps the number of documents without a race", async () => {
    delete process.env.MEMBER_DOCUMENT_MAX_BYTES;
    const [other] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Viele Dokumente", joinedAt: "2020-01-01" }).returning();
    await db.insert(documents).values(Array.from({ length: 498 }, (_, i) => ({ clubId: id(), scope: "person", ownerClubMemberId: other!.id, kind: "hochgeladen", docType: "upload", title: `d${i}` })));
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => upload(club.founder, other!.id, pdf(1, `cnt-${i}`))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect((await body(results.find((r) => r.status === 409)!)).error.details.code).toBe("member_document_limit");
    expect((await db.select().from(documents).where(eq(documents.ownerClubMemberId, other!.id))).length).toBe(500);
  });

  it("keeps a reserve of the club quota for the board: members stop at 95 percent, the board can still write", async () => {
    const file = pdf(50, "reserve");
    const used = (await storageUsage(id())).usedBytes;
    const quota = Math.ceil((used + file.size) / 0.97);
    await db.update(clubSettings).set({ storageQuotaBytes: quota }).where(eq(clubSettings.clubId, id()));
    try {
      const member = await upload(club.members.plain!, "me", file);
      expect(member.status).toBe(422);
      expect((await body(member)).error.code).toBe("QUOTA_EXCEEDED");
      const board = await upload(club.founder, cm, file);
      expect(board.status).toBe(201);
      expect((await storageUsage(id())).usedBytes).toBeLessThanOrEqual(quota);
    } finally {
      await db.update(clubSettings).set({ storageQuotaBytes: null }).where(eq(clubSettings.clubId, id()));
    }
  });
});
