import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { NotFoundError } from "./errors.js";
import { discardStoredFile, IMAGE_TYPES, MAX_PHOTO_BYTES, markMediaDeleted, purgeMediaFile, signedMediaUrls, storeUpload } from "./media.js";
import { ageOn, todayBerlin } from "./member-lifecycle.js";
import { writeAudit } from "./audit.js";
import { liveWardIds } from "./guardian-scope.js";

/**
 * Member profile photos (Wave 7 B13) on top of the central media layer.
 *
 * Privacy defaults (a photo is personal data, E6; consent management follows in Wave 10):
 * - visible to the person itself, to `members:write` / `members:read_sensitive`, and to the guardians linked to a ward;
 *   NOT to other plain members. The only wider exposure is the board list of `GET /club-info`, and never for minors.
 * - minors (known birth date < 18) cannot set their own photo; the board (`members:write`) does it after having the
 *   guardians' consent.
 * - the URL is a short-lived signed media URL, only minted after those checks.
 */

export const PHOTO_ALLOWED_TYPES = IMAGE_TYPES;

/** True if the birth date is known and the person is under 18. Unknown birth date counts as adult (cannot be decided). */
export function isMinor(birthDate: string | null, today = todayBerlin()): boolean {
  return birthDate !== null && ageOn(birthDate, today) < 18;
}

export interface PhotoCaller {
  memberId: string;
  canReadSensitive: boolean;
  canWrite?: boolean;
}

/** Ids of the given club members that the caller is a (live, confirmed) guardian of -- see `guardianScope`. */
export async function guardedWardIds(callerMemberId: string, clubMemberIds: string[]): Promise<Set<string>> {
  return liveWardIds(callerMemberId, clubMemberIds);
}

/** May `caller` see the photo of `row`? (own / members:write / members:read_sensitive / guardian of the ward) */
export async function canSeeMemberPhoto(row: ClubMemberRow, caller: PhotoCaller): Promise<boolean> {
  if (row.memberId !== null && row.memberId === caller.memberId) return true;
  if (caller.canWrite || caller.canReadSensitive) return true;
  return (await guardedWardIds(caller.memberId, [row.id])).has(row.id);
}

/**
 * Signed photo URLs for a batch of member rows, keyed by `club_members.id`. `alreadyVisible(row)` marks rows the
 * caller may see for other reasons (own row / sensitive); guardian links are looked up for the rest in one query.
 */
export async function memberPhotoUrls(
  clubId: string,
  rows: ClubMemberRow[],
  caller: PhotoCaller,
  alreadyVisible: (row: ClubMemberRow) => boolean,
): Promise<Map<string, string>> {
  const withPhoto = rows.filter((r) => r.photoKey !== null);
  const result = new Map<string, string>();
  if (withPhoto.length === 0) return result;

  const open = caller.canWrite || caller.canReadSensitive ? withPhoto : withPhoto.filter(alreadyVisible);
  const hidden = withPhoto.filter((r) => !open.includes(r));
  const wards = hidden.length > 0 ? await guardedWardIds(caller.memberId, hidden.map((r) => r.id)) : new Set<string>();
  const visible = [...open, ...hidden.filter((r) => wards.has(r.id))];

  const urls = await signedMediaUrls(clubId, visible.map((r) => r.photoKey), "club_member");
  for (const r of visible) {
    const url = urls.get(r.photoKey!);
    if (url) result.set(r.id, url);
  }
  return result;
}

/**
 * Board list photos for `GET /club-info`. Same default as everywhere else (E6, until the Wave 10 consent management):
 * only for `members:write` / `members:read_sensitive` and for the person themselves -- NOT for other members, whether
 * adult or minor, and independent of a (possibly unknown) birth date. Keyed by the Better Auth `member.id`.
 */
export async function boardPhotoUrls(clubId: string, accountMemberIds: string[], caller: PhotoCaller): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const allowed = caller.canWrite || caller.canReadSensitive ? accountMemberIds : accountMemberIds.filter((id) => id === caller.memberId);
  if (allowed.length === 0) return result;
  const rows = await db.select().from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.memberId, allowed)));
  const withPhoto = rows.filter((r) => r.photoKey !== null);
  const urls = await signedMediaUrls(clubId, withPhoto.map((r) => r.photoKey), "club_member");
  for (const r of withPhoto) {
    const url = urls.get(r.photoKey!);
    if (url && r.memberId) result.set(r.memberId, url);
  }
  return result;
}

/** Stores a new photo and swaps it in atomically; the previous photo is deleted (registry tombstone + file). */
export async function replaceMemberPhoto(input: { row: ClubMemberRow; file: File; uploadedBy: string; changedBy: string }): Promise<ClubMemberRow> {
  const { row } = input;
  let newKey: string | null = null;
  let oldKey: string | null = null;
  let oldRemoved = false;
  try {
    const updated = await db.transaction(async (tx) => {
      // Serialise concurrent replace/delete of the same member's photo.
      const [locked] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, row.id), eq(clubMembers.clubId, row.clubId))).for("update");
      if (!locked) throw new NotFoundError("Member not found");
      oldKey = locked.photoKey;
      const media = await storeUpload({
        file: input.file,
        clubId: row.clubId,
        kind: "image",
        allowedTypes: PHOTO_ALLOWED_TYPES,
        maxBytes: MAX_PHOTO_BYTES,
        visibility: "private",
        owner: { type: "club_member", id: row.id },
        uploadedBy: input.uploadedBy,
        executor: tx,
      });
      newKey = media.storageKey;
      const [saved] = await tx.update(clubMembers).set({ photoKey: media.storageKey, updatedAt: new Date() }).where(eq(clubMembers.id, row.id)).returning();
      if (oldKey) oldRemoved = await markMediaDeleted(oldKey, tx, row.clubId);
      await writeAudit(tx, { eventType: "club_member.photo_set", subjectId: row.id, payload: { clubId: row.clubId, changedBy: input.changedBy, replaced: oldKey !== null } });
      return saved!;
    });
    if (oldKey && oldRemoved) await purgeMediaFile(oldKey);
    return updated;
  } catch (err) {
    if (newKey) await discardStoredFile(newKey);
    throw err;
  }
}

/** Removes the photo (idempotent). */
export async function removeMemberPhoto(input: { row: ClubMemberRow; changedBy: string }): Promise<void> {
  const { row } = input;
  let removedKey: string | null = null;
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, row.id), eq(clubMembers.clubId, row.clubId))).for("update");
    if (!locked || !locked.photoKey) return;
    await tx.update(clubMembers).set({ photoKey: null, updatedAt: new Date() }).where(eq(clubMembers.id, row.id));
    if (await markMediaDeleted(locked.photoKey, tx, row.clubId)) removedKey = locked.photoKey;
    await writeAudit(tx, { eventType: "club_member.photo_remove", subjectId: row.id, payload: { clubId: row.clubId, changedBy: input.changedBy } });
  });
  if (removedKey) await purgeMediaFile(removedKey);
}

/** The live registry row of a member's photo (club-scoped), for the authenticated stream. */
export async function findMemberPhotoMedia(row: ClubMemberRow) {
  if (!row.photoKey) return null;
  const [media] = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.storageKey, row.photoKey), eq(mediaFiles.clubId, row.clubId), isNull(mediaFiles.deletedAt)))
    .limit(1);
  return media ?? null;
}
