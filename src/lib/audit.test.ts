import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { AUDIT_EVENTS, auditContext, auditKindOf, whitelistPayload, writeAudit } from "./audit.js";

afterAll(async () => {
  await closeDatabase();
});

describe("audit payload whitelist", () => {
  it("never whitelists a key that could carry a secret or free text", () => {
    const forbidden = /password|passwort|token(?!Id)|secret|apikey|authorization|cookie|diagnos/i;
    for (const [eventType, entry] of Object.entries(AUDIT_EVENTS)) {
      for (const key of entry.keys) expect(key, `${eventType}.${key}`).not.toMatch(forbidden);
    }
  });

  it("keeps whitelisted keys, drops undefined and refuses unknown keys under test", () => {
    expect(whitelistPayload("club_settings.update", { clubId: "c", changedFields: ["a"], changedBy: undefined })).toEqual({ clubId: "c", changedFields: ["a"] });
    expect(() => whitelistPayload("club_settings.update", { clubId: "c", password: "x" })).toThrow(/not whitelisted: password/);
  });

  it("classifies reads, exports and downloads as read, everything else as change", () => {
    for (const t of ["club_member.sensitive_read", "club_member.export", "form_submission.file_access", "club_registration.document_access", "media.sensitive_access", "audit_log.export"]) expect(auditKindOf(t), t).toBe("read");
    for (const t of ["club_member.update", "session.create", "club_role.assign"]) expect(auditKindOf(t), t).toBe("change");
  });
});

describe("writeAudit", () => {
  const clubId = `audit-unit-club-${Date.now()}`;
  const memberId = "11111111-1111-4111-8111-111111111111";

  it("takes club from the payload, the actor from the request context and the member from the registry", async () => {
    await auditContext.run({ userId: "actor-1", clubId: "ignored-club" }, () => writeAudit(db, { eventType: "club_member.update", subjectId: memberId, payload: { clubId, changedFields: ["city"] } }));
    const [row] = await db.select().from(auditLog).where(eq(auditLog.clubId, clubId));
    expect(row).toMatchObject({ eventType: "club_member.update", clubId, actorUserId: "actor-1", subjectMemberId: memberId, payload: { clubId, changedFields: ["city"] } });
  });

  it("falls back to the club of the request, and writes null club and actor for system events", async () => {
    const requestClub = `audit-unit-req-${Date.now()}`;
    await auditContext.run({ userId: "actor-2", clubId: requestClub }, () => writeAudit(db, { eventType: "admin.job_retry", subjectId: "j1", payload: { type: "t" } }));
    const [viaRequest] = await db.select().from(auditLog).where(eq(auditLog.clubId, requestClub));
    expect(viaRequest).toMatchObject({ clubId: requestClub, actorUserId: "actor-2" });

    const systemClub = `audit-unit-sys-${Date.now()}`;
    await writeAudit(db, { eventType: "calendar.default_create", subjectId: "cal", payload: { clubId: systemClub, calendarId: "cal" } });
    const [system] = await db.select().from(auditLog).where(eq(auditLog.clubId, systemClub));
    expect(system).toMatchObject({ clubId: systemClub, actorUserId: null, subjectMemberId: null });

    await auditContext.run({ userId: "actor-3", clubId: requestClub }, () => writeAudit(db, { eventType: "session.create", subjectId: "u9", clubId: null, actorUserId: null, payload: { sessionId: "s9" } }));
    const platform = await db.select().from(auditLog).where(eq(auditLog.subjectId, "u9"));
    expect(platform[0]).toMatchObject({ clubId: null, actorUserId: null });
  });
});
