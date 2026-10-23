import { readdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { formSubmissionFiles, formSubmissions } from "../db/schema/forms.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { sweepRejectedFormFiles, sweepStaleFormDrafts } from "../lib/form-sweeper.js";
import { makePng, PDF_BYTES } from "../lib/media-fixtures.js";
import { signMediaKey, verifyMediaSignature } from "../lib/media-url.js";
import { UPLOADS_DIR } from "../lib/storage.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { memberCustomFieldRoutes } from "./club-member-custom-fields.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { mediaRoutes } from "./media.js";

/**
 * Media gate of the forms area (Wave 8 BM, on top of the media layer of Wave 7 B18).
 *
 * Part 1 is a static scan: no source file serves, redirects to or persists a raw file URL outside the media layer, and the
 * forms area (submissions, applications, review) neither mints URLs itself nor puts a storage key into a response shape.
 * (`src/lib/media-gate.test.ts` holds the layer-wide grep gate: storage imports, filesystem access, static serving.)
 *
 * Part 2 is behavioural: a real application with an image (photo) and a document (ID proof) is filed and then read through
 * EVERY endpoint that returns submission/application/review/member data. Rules asserted for every response body:
 *   - no `http(s)`/`data:`/`blob:`/`file:` URL except a short-lived signed media URL of a NON-sensitive image, and only on
 *     endpoints that issue them after their own permission check (submitter's submission, member shape);
 *   - never a storage key, key basename, storage prefix or upload path -- also not inside a signed URL for the document;
 *   - documents only through the authenticated stream, with an audit entry; callers without the right get 401/403/404 and
 *     no URL; rejected/withdrawn/expired submissions lose their files in the registry and on disk; acceptance re-owns the
 *     photo in the registry (`club_members.photo_key`), it is not copied.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Part 1: static scan
// ---------------------------------------------------------------------------------------------------------------------

const SRC = path.resolve("src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" ? [] : sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith("media-fixtures.ts") && !full.endsWith("scratch-db.ts") && !full.endsWith("forms-test-support.ts") ? [full] : [];
  });
}

/** Source with comments removed, so explanations in comments do not trip the gate. */
const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const sources = sourceFiles(SRC).map((f) => ({ file: rel(f), source: code(f) }));
const offenders = (pattern: RegExp, allowed: string[] = [], scope: (file: string) => boolean = () => true) =>
  sources.filter((f) => scope(f.file) && pattern.test(f.source) && !allowed.includes(f.file)).map((f) => f.file);

/** Everything that handles form submissions, applications, their review and the member data derived from them. */
const FORMS_AREA = new Set([
  "routes/form-submissions.ts",
  "routes/club-applications.ts",
  "routes/forms.ts",
  "routes/club-forms.ts",
  "routes/club-exit-requests.ts",
  "routes/club-member-custom-fields.ts",
  "lib/application-review.ts",
  "lib/form-acceptance.ts",
  "lib/form-applications.ts",
  "lib/form-children.ts",
  "lib/form-defaults.ts",
  "lib/form-exit.ts",
  "lib/form-mapping.ts",
  "lib/form-retention.ts",
  "lib/form-review.ts",
  "lib/form-schema.ts",
  "lib/form-sweeper.ts",
  "lib/forms.ts",
]);
const inFormsArea = (file: string) => FORMS_AREA.has(file);
const FORMS_ROUTES = [...FORMS_AREA].filter((f) => f.startsWith("routes/"));

describe("media gate (static scan)", () => {
  it("knows the forms area (a renamed file must not silently leave the gate)", () => {
    for (const file of FORMS_AREA) expect(sources.map((s) => s.file), file).toContain(file);
  });

  it("nothing redirects to a file, builds a raw Response from bytes or serves with a hand-made Content-Disposition", () => {
    expect(offenders(/\b(?:c|ctx|res)\.redirect\s*\(|\bResponse\.redirect\s*\(/)).toEqual([]);
    expect(offenders(/\bnew Response\s*\(/)).toEqual([]);
    expect(offenders(/Content-Disposition/i, ["lib/media.ts", "lib/privacy/respond.ts", "routes/audit-log.ts", "routes/club-members.ts", "routes/dpa.ts", "routes/media.ts", "routes/meeting-assembly.ts"])).toEqual([]);
  });

  it("only the media layer streams bytes: `c.body(new Uint8Array(...))` of a file exists only in lib/media.ts", () => {
    expect(offenders(/c\.body\(\s*new Uint8Array\(/, ["lib/media.ts"])).toEqual([]);
  });

  it("only known response shapes carry a `url`/`photoUrl` field (each issues a signed URL after its own permission check)", () => {
    // location links hold external links the board typed in (not files); the e-mail/auth/notify files build links to the web app.
    const urlAllowed = ["auth/auth.ts", "db/schema/location-links.ts", "lib/club-registration-notify.ts", "lib/emailTemplate.ts", "lib/media-url.ts", "lib/member-invites.ts", "lib/notify/templates.ts", "lib/notify/unsubscribe.ts", "routes/club-members.ts", "routes/form-submissions.ts", "routes/locations.ts", "routes/media.ts"];
    expect(offenders(/\burl\s*:/, urlAllowed)).toEqual([]);
    expect(offenders(/\bphotoUrl\b/, ["routes/club-info.ts", "routes/club-members.ts", "routes/inventory-items.ts", "routes/locations.ts"])).toEqual([]);
    // the board-facing review of an application never carries a URL, only the authenticated stream path
    expect(sources.find((s) => s.file === "lib/application-review.ts")!.source).not.toMatch(/\burl\s*:|signedMediaUrl|buildMediaUrl/);
  });

  it("the forms area never mints URLs, hard-codes links or touches storage paths", () => {
    expect(offenders(/\b(buildMediaUrl|signMediaKey|verifyMediaSignature)\b/, [], inFormsArea)).toEqual([]);
    expect(offenders(/["'`]\/media\/|\/media\/\$\{|UPLOADS_DIR|https?:\/\//, [], inFormsArea)).toEqual([]);
    // the only way to a URL is the media layer's `signedMediaUrls` (non-sensitive images, submitter's own routes)
    expect(offenders(/\bsignedMediaUrls?\s*\(/, ["routes/form-submissions.ts"], inFormsArea)).toEqual([]);
  });

  it("form routes use `storageKey` only to read/insert rows, never as a key of a response object", () => {
    for (const file of FORMS_ROUTES) {
      const lines = sources.find((s) => s.file === file)!.source.split("\n");
      for (const line of lines) {
        if (!/(?<![.\w])storageKey\s*[:,}]/.test(line)) continue; // property keys / shorthand; `row.storageKey` reads are fine
        // `{ storageKey: x }` is fine for the media layer calls and inserts; a bare shorthand in a response is not.
        expect(line, `${file}: ${line.trim()}`).toMatch(/attachUploadedImage|\.values\(|\.select\(|reassignMediaOwner/);
      }
    }
  });

  it("feature tables hold keys, never URLs: no column named url/*_url/*Url for files in the forms/media/member schemas", () => {
    // meetings.online_url is the join link of a video conference the board typed in (not a file), like the location links.
    const schema = sources.filter((s) => s.file.startsWith("db/schema/"));
    const bad = schema.filter((s) => !["db/schema/location-links.ts", "db/schema/club-info-pages.ts", "db/schema/club-registrations.ts", "db/schema/calendars.ts", "db/schema/meetings.ts"].includes(s.file) && /text\(\s*["'`][a-z_]*url["'`]/i.test(s.source)).map((s) => s.file);
    expect(bad).toEqual([]);
    for (const file of ["db/schema/forms.ts", "db/schema/media-files.ts", "db/schema/club-members.ts", "db/schema/club-applications.ts"]) {
      expect(sources.find((s) => s.file === file)!.source, file).not.toMatch(/["'`][a-z_]*(?:photo|image|file|document|media)[a-z_]*_url["'`]/i);
    }
    // the file columns that exist hold keys
    expect(sources.find((s) => s.file === "db/schema/club-members.ts")!.source).toMatch(/photo_key/);
    expect(sources.find((s) => s.file === "db/schema/forms.ts")!.source).toMatch(/storage_key/);
  });

  it("every multipart upload in the forms area goes through the media layer's storeUpload (or claims a registered key)", () => {
    const source = sources.find((s) => s.file === "routes/form-submissions.ts")!.source;
    expect(source).toMatch(/\bstoreUpload\(/);
    expect(source).toMatch(/attachUploadedImage\(/);
    expect(source).toMatch(/visibility:\s*"private"/);
    expect(source).toMatch(/sensitive:\s*!isImage/);
    expect(source).toMatch(/streamSensitiveMedia\(/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 2: behavioural
// ---------------------------------------------------------------------------------------------------------------------

vi.mock("../lib/email.js", () => ({ sendEmail: async () => undefined }));

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-members", memberCustomFieldRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.route("/forms", formRoutes);
app.route("/club-forms", clubFormRoutes);
app.route("/form-submissions", formSubmissionRoutes);
app.route("/media", mediaRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const ANONYMOUS: Account = { userId: "", cookie: "" };
const DAY = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

const FIELDS = [
  { key: "first_name", type: "text", label: "Vorname", required: true, mapsTo: "firstName" },
  { key: "last_name", type: "text", label: "Nachname", required: true, mapsTo: "lastName" },
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", mapsTo: "birthDate" },
  { key: "photo", type: "image", label: "Foto", mapsTo: "photo" },
  { key: "id_doc", type: "file", label: "Nachweis" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutz" },
  { key: "privacy_consent", type: "consent", label: "Ich willige ein.", required: false },
];
const answers = (over: Record<string, unknown> = {}) => ({ first_name: "Medi", last_name: "Agate", category: "aktiv", birth_date: "1990-04-02", privacy_consent: true, ...over });

const UUID_FILE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|pdf)/i;
const URL_RE = /\b(?:https?:\/\/|data:[a-z-]+\/|blob:|file:\/\/|ftp:\/\/)[^\s"'\\]*/gi;

type Filed = { submissionId: string; applicationId: string; photoKey: string; docKey: string; photoFileId: string; docFileId: string; photoMediaId: string };

describe("media gate (forms area, behavioural)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let otherClub: Awaited<ReturnType<typeof createClub>>;
  const accounts: Account[] = [];
  /** Every key registered during the test: none of them may ever appear in a response body. */
  const knownKeys = new Set<string>();

  const newUser = async (label: string) => {
    const acc = await signUpAndVerify(`gate-${label}-${suffix}@example.com`, `Gate ${label}`);
    accounts.push(acc);
    return acc;
  };
  const upload = (who: Account, submissionId: string, fieldKey: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("fieldKey", fieldKey);
    return call(who, `/form-submissions/${submissionId}/files`, { method: "POST", form: fd });
  };
  const png = () => new File([new Uint8Array(makePng())], "foto.png", { type: "image/png" });
  const pdf = () => new File([new Uint8Array(PDF_BYTES)], "ausweis.pdf", { type: "application/pdf" });

  /** Draft with photo + document, optionally already filed as an application. */
  const draftWithFiles = async (who: Account, over: { guardian?: boolean; answers?: Record<string, unknown> } = {}) => {
    const created = await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, ...(over.guardian ? { onBehalfOf: "guardian" } : {}), answers: over.answers ?? answers() } });
    expect(created.status, await created.clone().text()).toBe(201);
    const submissionId = (await body(created)).data.submission.id as string;
    const up1 = await upload(who, submissionId, "photo", png());
    expect(up1.status, await up1.clone().text()).toBe(201);
    const up2 = await upload(who, submissionId, "id_doc", pdf());
    expect(up2.status, await up2.clone().text()).toBe(201);
    return { submissionId, photoUpload: await body(up1), docUpload: await body(up2) };
  };
  const filesOf = async (submissionId: string) => {
    const rows = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, submissionId));
    for (const r of rows) knownKeys.add(r.storageKey);
    return rows;
  };
  const file = async (who: Account, over: { guardian?: boolean; answers?: Record<string, unknown> } = {}): Promise<Filed> => {
    const { submissionId } = await draftWithFiles(who, over);
    const rows = await filesOf(submissionId);
    const photo = rows.find((r) => r.fieldKey === "photo")!;
    const doc = rows.find((r) => r.fieldKey === "id_doc")!;
    const applied = await call(who, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, submissionId, ...(over.guardian ? { onBehalfOf: "guardian" } : {}) } });
    expect(applied.status, await applied.clone().text()).toBe(201);
    const photoMedia = (await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, photo.storageKey) }))!;
    return { submissionId, applicationId: (await body(applied)).data.application.id, photoKey: photo.storageKey, docKey: doc.storageKey, photoFileId: photo.id, docFileId: doc.id, photoMediaId: photoMedia.id };
  };

  const isSignedNonSensitiveImage = async (raw: string) => {
    const url = new URL(raw);
    if (url.origin !== new URL(process.env.BACKEND_URL ?? "http://localhost:3000").origin) return false;
    if (!url.pathname.startsWith("/media/")) return false;
    const key = url.pathname.slice("/media/".length).split("/").map(decodeURIComponent).join("/");
    if (!verifyMediaSignature(key, url.searchParams.get("exp") ?? undefined, url.searchParams.get("sig") ?? undefined)) return false;
    // short-lived: a few hours at most, never an open-ended link
    if (Number(url.searchParams.get("exp")) - Date.now() > 24 * 60 * 60 * 1000) return false;
    const row = await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, key) });
    return !!row && !row.sensitive && row.kind === "image" && row.deletedAt === null;
  };

  /**
   * The gate applied to one response body (text of JSON or CSV). `signed: "image"` = the endpoint may carry short-lived signed
   * URLs of non-sensitive images (everything else is a violation); `"none"` = no URL of any kind.
   */
  const inspect = async (text: string, signed: "none" | "image", where: string) => {
    let rest = text;
    for (const found of text.match(URL_RE) ?? []) {
      expect(signed, `${where}: unexpected URL ${found}`).toBe("image");
      expect(await isSignedNonSensitiveImage(found), `${where}: not a valid signed image URL: ${found}`).toBe(true);
      rest = rest.replace(found, "");
    }
    for (const key of knownKeys) {
      expect(rest, `${where}: storage key ${key}`).not.toContain(key);
      expect(rest, `${where}: key basename ${key}`).not.toContain(key.split("/").pop()!);
    }
    expect(rest, `${where}: storage prefix`).not.toContain(`forms/${club.clubId}`);
    expect(rest, `${where}: storage prefix`).not.toContain(`forms\\/${club.clubId}`);
    expect(rest, `${where}: upload path`).not.toContain(UPLOADS_DIR);
    expect(rest, `${where}: stored file name`).not.toMatch(UUID_FILE_RE);
    expect(rest, `${where}: raw key field`).not.toMatch(/"(?:storageKey|storage_key|photoKey|photo_key|mediaKey)"/);
  };
  /** Requests `path`, expects `status`, runs the gate on the body and returns the parsed JSON (or the text for CSV). */
  const read = async (who: Account, path: string, expected: number | number[], signed: "none" | "image", init: { clubId?: string } = {}) => {
    const res = await call(who, path, init);
    const text = await res.text();
    expect(Array.isArray(expected) ? expected : [expected], `${path}: ${res.status} ${text.slice(0, 200)}`).toContain(res.status);
    await inspect(text, signed, `${who === ANONYMOUS ? "anonymous" : who.userId} ${path}`);
    return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : null };
  };
  const decide = (who: Account, id: string, action: "approve" | "reject", payload?: unknown) => call(who, `/club-applications/${id}/${action}`, { method: "POST", clubId: club.clubId, body: payload });
  const auditCount = async (eventType: string, subjectId: string) => (await db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.eventType, eventType), eq(auditLog.subjectId, subjectId))))[0]!.n;
  const onDisk = (key: string) => stat(path.join(UPLOADS_DIR, key)).then(() => true, () => false);
  const mediaUrl = (key: string, exp = Date.now() + 60_000, sig = signMediaKey(key, exp)) => `/media/${key.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;

  beforeAll(async () => {
    club = await createClub("gate", suffix, { plain: null });
    otherClub = await createClub("gateo", suffix);
    const list = (await body(await call(club.founder, "/forms", { clubId: club.clubId }))).data as Array<{ id: string; purpose: string }>;
    const formId = list.find((f) => f.purpose === "aufnahme")!.id;
    expect((await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: FIELDS } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${formId}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await dropClubs([club.clubId, otherClub.clubId], [...club.userIds, ...otherClub.userIds, ...accounts.map((a) => a.userId)]);
    await closeDatabase();
  });

  it("registers photo and document privately: image non-sensitive, document sensitive, both owned by the submission", async () => {
    const who = await newUser("register");
    const { submissionId, photoUpload, docUpload } = await draftWithFiles(who);
    const rows = await filesOf(submissionId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const media = (await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, row.storageKey) }))!;
      expect(media).toMatchObject({ clubId: club.clubId, ownerType: "form_submission", ownerId: submissionId, visibility: "private", deletedAt: null });
      expect(media.sensitive).toBe(row.fieldKey === "id_doc");
      expect(media.kind).toBe(row.fieldKey === "id_doc" ? "document" : "image");
      expect(row.storageKey.startsWith(`forms/${club.clubId}/${submissionId}/`)).toBe(true);
      expect(await onDisk(row.storageKey)).toBe(true);
    }
    // upload responses: the image gets a short-lived signed URL, the document none; no key in either
    await inspect(JSON.stringify(photoUpload), "image", "upload response (photo)");
    await inspect(JSON.stringify(docUpload), "none", "upload response (document)");
    expect(photoUpload.data.file.url).toMatch(/\/media\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect(docUpload.data.file.url).toBeNull();
    expect(photoUpload.data.file).not.toHaveProperty("storageKey");
  });

  it("the applicant's own views carry signed URLs for the image only, never for the document, never a key", async () => {
    const who = await newUser("own");
    const f = await file(who);
    for (const p of [`/form-submissions/${f.submissionId}`, "/form-submissions/mine"]) {
      const { json } = await read(who, p, 200, "image");
      const files = (p.endsWith("mine") ? json.data.find((s: { id: string }) => s.id === f.submissionId) : json.data.submission).files as Array<{ fieldKey: string; url: string | null; kind: string }>;
      expect(files.find((x) => x.fieldKey === "photo")!.url).toMatch(/^http.*\/media\//);
      expect(files.find((x) => x.fieldKey === "id_doc")!.url).toBeNull();
    }
    // the applicant's own member shape does not exist yet (not accepted): applying created no other file-bearing record
    expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.lastUserId, who.userId) })).toBeUndefined();
  });

  it("review API (list + detail) for the board: no URL at all, files only as authenticated stream paths; outsiders get 401/403/404 without URLs", async () => {
    const who = await newUser("review");
    const f = await file(who);

    const list = await read(club.founder, "/club-applications", 200, "none", { clubId: club.clubId });
    expect(list.json.data.some((a: { id: string }) => a.id === f.applicationId)).toBe(true);
    const detail = await read(club.founder, `/club-applications/${f.applicationId}`, 200, "none", { clubId: club.clubId });
    const files = detail.json.data.files as Array<{ id: string; kind: string; path: string; sensitive: boolean }>;
    expect(files).toHaveLength(2);
    for (const entry of files) expect(entry.path).toBe(`/form-submissions/${f.submissionId}/files/${entry.id}`);
    expect(files.find((x) => x.id === f.docFileId)).toMatchObject({ kind: "document", sensitive: true });
    expect(files.find((x) => x.id === f.photoFileId)).toMatchObject({ kind: "image", sensitive: false });
    expect(JSON.stringify(detail.json)).not.toMatch(/"url"|photoUrl/);

    // callers without the right: nothing but a refusal
    const plain = club.members["plain"]!;
    await read(ANONYMOUS, `/club-applications/${f.applicationId}`, 401, "none", { clubId: club.clubId });
    await read(ANONYMOUS, "/club-applications", 401, "none", { clubId: club.clubId });
    await read(plain, `/club-applications/${f.applicationId}`, 403, "none", { clubId: club.clubId });
    await read(plain, "/club-applications", 403, "none", { clubId: club.clubId });
    await read(otherClub.founder, `/club-applications/${f.applicationId}`, 404, "none", { clubId: otherClub.clubId }); // own club, foreign id
    await read(otherClub.founder, `/club-applications/${f.applicationId}`, [403, 404], "none", { clubId: club.clubId }); // not a member of that club
    await read(otherClub.founder, "/club-applications", [403, 404], "none", { clubId: club.clubId });
    // the applicant is no member of the club at all
    await read(who, `/club-applications/${f.applicationId}`, 404, "none", { clubId: club.clubId });
  });

  it("documents are only streamed with authentication, the right and an audit entry; everyone else gets 401/404 and no audit entry", async () => {
    const who = await newUser("stream");
    const stranger = await newUser("stream-stranger");
    const f = await file(who);
    const docPath = `/form-submissions/${f.submissionId}/files/${f.docFileId}`;
    const photoPath = `/form-submissions/${f.submissionId}/files/${f.photoFileId}`;
    const before = await auditCount("media.sensitive_access", f.submissionId);

    // refused: no session, a stranger, another club's board, a plain member of the same club -- all without audit entry
    for (const [label, caller, status] of [["anonymous", ANONYMOUS, 401], ["stranger", stranger, 404], ["other club board", otherClub.founder, 404], ["plain member", club.members["plain"]!, 404]] as const) {
      const res = await call(caller, docPath);
      expect(res.status, label).toBe(status);
      await inspect(await res.text(), "none", `stream ${label}`);
    }
    expect(await auditCount("media.sensitive_access", f.submissionId)).toBe(before);

    // the board streams it: attachment, private, audited with who/why (no content)
    const board = await call(club.founder, docPath);
    expect(board.status).toBe(200);
    expect(board.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(board.headers.get("cache-control")).toMatch(/private/);
    expect(board.headers.get("cache-control")).toMatch(/no-store/);
    expect(Buffer.from(await board.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
    expect(await auditCount("media.sensitive_access", f.submissionId)).toBe(before + 1);
    // ... and the submitter their own
    expect((await call(who, docPath)).status).toBe(200);
    expect(await auditCount("media.sensitive_access", f.submissionId)).toBe(before + 2);
    const entries = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "media.sensitive_access"), eq(auditLog.subjectId, f.submissionId)));
    expect(entries.map((e) => (e.payload as { accessedBy: string }).accessedBy).sort()).toEqual([club.founder.userId, who.userId].sort());
    expect(JSON.stringify(entries)).not.toContain(f.docKey);

    // the photo is a non-sensitive image: authenticated stream (private, no-store) with its own audit event; same refusals
    expect((await call(ANONYMOUS, photoPath)).status).toBe(401);
    expect((await call(stranger, photoPath)).status).toBe(404);
    const photoBefore = await auditCount("form_submission.file_access", f.submissionId);
    const photo = await call(club.founder, photoPath);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("cache-control")).toMatch(/private/);
    expect(await auditCount("form_submission.file_access", f.submissionId)).toBe(photoBefore + 1);
  });

  it("/media/<key> never serves the document (not even with a valid signature) and never an unsigned, expired or forged photo", async () => {
    const who = await newUser("media");
    const f = await file(who);
    // the signature is valid but the registry says sensitive: 404, indistinguishable from a missing file
    expect((await call(ANONYMOUS, mediaUrl(f.docKey))).status).toBe(404);
    expect((await call(who, mediaUrl(f.docKey))).status).toBe(404);
    // unsigned / expired / forged / other-key signature: 403
    expect((await call(ANONYMOUS, `/media/${f.photoKey}`)).status).toBe(403);
    expect((await call(who, `/media/${f.photoKey}`)).status).toBe(403);
    expect((await call(ANONYMOUS, mediaUrl(f.photoKey, Date.now() - 1000))).status).toBe(403);
    expect((await call(ANONYMOUS, mediaUrl(f.photoKey, Date.now() + 60_000, "0".repeat(64)))).status).toBe(403);
    expect((await call(ANONYMOUS, mediaUrl(f.photoKey, Date.now() + 60_000, signMediaKey(f.docKey, Date.now() + 60_000)))).status).toBe(403);
    expect((await call(ANONYMOUS, mediaUrl(f.docKey, Date.now() + 60_000, "not-hex"))).status).toBe(403);
    // the URL the submitter was given works, is private and short-lived
    const { json } = await read(who, `/form-submissions/${f.submissionId}`, 200, "image");
    const url = new URL(json.data.submission.files.find((x: { fieldKey: string }) => x.fieldKey === "photo").url);
    const served = await call(ANONYMOUS, `${url.pathname}${url.search}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toMatch(/private/);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  it("the other file endpoints refuse everyone but submitter and board without leaking a URL", async () => {
    const who = await newUser("idor");
    const f = await file(who);
    const other = await newUser("idor-other");
    await read(other, `/form-submissions/${f.submissionId}`, 404, "none");
    await read(ANONYMOUS, `/form-submissions/${f.submissionId}`, 401, "none");
    await read(club.founder, `/form-submissions/${f.submissionId}`, 404, "none"); // the board uses the review API, not the applicant's view
    await read(otherClub.founder, `/form-submissions/${f.submissionId}`, 404, "none");
    const mine = await read(other, "/form-submissions/mine", 200, "none");
    expect(JSON.stringify(mine.json)).not.toContain(f.submissionId);
  });

  it("approve re-owns the photo in the registry (same row, same key, no copy, no URL stored); the document stays with the submission", async () => {
    const who = await newUser("accept");
    const f = await file(who);
    const filesBefore = await db.select({ n: count() }).from(mediaFiles).where(and(eq(mediaFiles.clubId, club.clubId), eq(mediaFiles.ownerType, "form_submission")));
    const totalBefore = (await db.select({ n: count() }).from(mediaFiles).where(eq(mediaFiles.clubId, club.clubId)))[0]!.n;
    expect(filesBefore[0]!.n).toBeGreaterThanOrEqual(2);

    const approved = await decide(club.founder, f.applicationId, "approve");
    expect(approved.status, await approved.clone().text()).toBe(200);
    await inspect(await approved.text(), "image", "approve response");
    const clubMemberId = (await db.query.clubApplications.findFirst({ where: (t, { eq: same }) => same(t.id, f.applicationId) }))!.clubMemberId!;

    const member = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, clubMemberId) }))!;
    expect(member.photoKey).toBe(f.photoKey);
    const photo = (await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, f.photoKey) }))!;
    expect(photo).toMatchObject({ id: f.photoMediaId, ownerType: "club_member", ownerId: clubMemberId, deletedAt: null, sensitive: false });
    expect((await db.select({ n: count() }).from(mediaFiles).where(eq(mediaFiles.storageKey, f.photoKey)))[0]!.n).toBe(1);
    expect((await db.select({ n: count() }).from(mediaFiles).where(eq(mediaFiles.clubId, club.clubId)))[0]!.n).toBe(totalBefore); // nothing copied
    expect(await onDisk(f.photoKey)).toBe(true);
    // the submission no longer lists the photo; the document is still the submission's own sensitive file
    expect((await filesOf(f.submissionId)).map((r) => r.fieldKey)).toEqual(["id_doc"]);
    expect(await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, f.docKey) })).toMatchObject({ ownerType: "form_submission", ownerId: f.submissionId, sensitive: true, deletedAt: null });

    // every member-facing read: a signed image URL for those who may see the photo, null for the rest; never a key or the document
    const asBoard = await read(club.founder, `/club-members/${clubMemberId}`, 200, "image", { clubId: club.clubId });
    expect(asBoard.json.data.photoUrl).toMatch(/\/media\//);
    expect(asBoard.json.data).not.toHaveProperty("photoKey");
    const list = await read(club.founder, "/club-members?pageSize=100", 200, "image", { clubId: club.clubId });
    expect(JSON.stringify(list.json)).toMatch(/\/media\//);
    const own = await read(who, "/club-members/me", 200, "image", { clubId: club.clubId });
    expect(own.json.data.photoUrl).toMatch(/\/media\//);
    for (const p of ["/club-members/export", "/club-members/export.csv"]) {
      const csv = await read(club.founder, `${p}?columns=displayName,category,street`, 200, "none", { clubId: club.clubId });
      expect(csv.text).toContain("Medi Agate");
    }
    const plain = club.members["plain"]!;
    const asPlain = await read(plain, `/club-members/${clubMemberId}`, [200, 404], "none", { clubId: club.clubId });
    if (asPlain.status === 200) expect(asPlain.json.data.photoUrl ?? null).toBeNull();
    await read(plain, "/club-members?pageSize=100", [200, 403], "none", { clubId: club.clubId });
    await read(plain, "/club-members/export", 403, "none", { clubId: club.clubId });
    await read(otherClub.founder, `/club-members/${clubMemberId}`, 404, "none", { clubId: otherClub.clubId });
    await read(ANONYMOUS, `/club-members/${clubMemberId}`, 401, "none", { clubId: club.clubId });
    // the photo stream is authenticated too
    expect((await call(club.founder, `/club-members/${clubMemberId}/photo`, { clubId: club.clubId })).status).toBe(200);
    expect((await call(ANONYMOUS, `/club-members/${clubMemberId}/photo`, { clubId: club.clubId })).status).toBe(401);
    expect((await call(plain, `/club-members/${clubMemberId}/photo`, { clubId: club.clubId })).status).toBe(404);
    expect((await call(otherClub.founder, `/club-members/${clubMemberId}/photo`, { clubId: otherClub.clubId })).status).toBe(404);

    // the decided application: review shows the (now gone) photo no more and the document only as stream path
    const decided = await read(club.founder, `/club-applications/${f.applicationId}`, 200, "none", { clubId: club.clubId });
    expect((decided.json.data.files as Array<{ kind: string }>).map((x) => x.kind)).toEqual(["document"]);
    expect((await call(club.founder, `/form-submissions/${f.submissionId}/files/${f.docFileId}`)).status).toBe(200);
    // the submitter's view of the accepted submission lists the document only (no URL)
    await read(who, `/form-submissions/${f.submissionId}`, 200, "none");
  });

  it("a child application by a parent: parent and board see the child's data without keys; plain members see no photo", async () => {
    const parent = await newUser("parent");
    const f = await file(parent, { guardian: true, answers: answers({ first_name: "Kinder", last_name: "Lein", category: "jugend", birth_date: "2016-03-04" }) });
    await read(club.founder, `/club-applications/${f.applicationId}`, 200, "none", { clubId: club.clubId });
    const approved = await decide(club.founder, f.applicationId, "approve");
    expect(approved.status, await approved.clone().text()).toBe(200);
    await inspect(await approved.text(), "image", "approve response (child)");
    const childId = (await db.query.clubApplications.findFirst({ where: (t, { eq: same }) => same(t.id, f.applicationId) }))!.clubMemberId!;
    expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, childId) }))!.photoKey).toBe(f.photoKey);

    const children = await read(parent, "/club-members/me/children", 200, "image", { clubId: club.clubId });
    expect(JSON.stringify(children.json)).toContain(childId);
    const asParent = await read(parent, `/club-members/${childId}`, [200, 404], "image", { clubId: club.clubId });
    if (asParent.status === 200) expect(asParent.json.data.photoUrl).toMatch(/\/media\//); // the guardian of a ward may see the photo, if the member is readable at all
    await read(parent, `/club-members/${childId}/custom-fields`, [200, 403, 404], "none", { clubId: club.clubId });
    const asPlain = await read(club.members["plain"]!, `/club-members/${childId}`, [200, 404], "none", { clubId: club.clubId });
    if (asPlain.status === 200) expect(asPlain.json.data.photoUrl ?? null).toBeNull();
    expect((await call(club.members["plain"]!, `/club-members/${childId}/photo`, { clubId: club.clubId })).status).toBe(404);
    await read(otherClub.founder, `/club-members/${childId}`, 404, "none", { clubId: otherClub.clubId });
    await read(ANONYMOUS, "/club-members/me/children", 401, "none", { clubId: club.clubId });
    // the parent's document stays behind the audited stream
    const docPath = `/form-submissions/${f.submissionId}/files/${f.docFileId}`;
    expect((await call(parent, docPath)).status).toBe(200);
    expect((await call(club.members["plain"]!, docPath)).status).toBe(404);
  });

  it("a rejected application loses its files (registry tombstone + bytes) after the retention window; links and streams die with them", async () => {
    const who = await newUser("reject");
    const f = await file(who);
    const rejected = await decide(club.founder, f.applicationId, "reject", { applicantMessage: "Leider kein Platz." });
    expect(rejected.status).toBe(200);
    // within the window the files remain (the board may need them for an appeal) -- still only through the layer
    await sweepRejectedFormFiles();
    for (const key of [f.photoKey, f.docKey]) expect((await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, key) }))!.deletedAt).toBeNull();
    await read(club.founder, `/club-applications/${f.applicationId}`, 200, "none", { clubId: club.clubId });
    await read(who, `/form-submissions/${f.submissionId}`, 200, "image");

    expect(await sweepRejectedFormFiles(Date.now() + 31 * DAY, { clubId: club.clubId })).toBeGreaterThanOrEqual(2);
    for (const key of [f.photoKey, f.docKey]) {
      expect((await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, key) }))!.deletedAt).not.toBeNull();
      expect(await onDisk(key)).toBe(false);
    }
    expect(await filesOf(f.submissionId)).toHaveLength(0);
    expect((await call(ANONYMOUS, mediaUrl(f.photoKey))).status).toBe(404); // a still-valid signed URL is dead
    expect((await call(club.founder, `/form-submissions/${f.submissionId}/files/${f.docFileId}`)).status).toBe(404);
    const review = await read(club.founder, `/club-applications/${f.applicationId}`, 200, "none", { clubId: club.clubId });
    expect(review.json.data.files).toEqual([]);
    const own = await read(who, `/form-submissions/${f.submissionId}`, 200, "none");
    expect(own.json.data.submission.files).toEqual([]);
  });

  it("withdrawing removes the files at once; an abandoned draft's files go with the draft sweep", async () => {
    const who = await newUser("withdraw");
    const f = await file(who);
    expect((await call(who, `/form-submissions/${f.submissionId}/withdraw`, { method: "POST" })).status).toBe(200);
    for (const key of [f.photoKey, f.docKey]) {
      expect((await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, key) }))!.deletedAt).not.toBeNull();
      expect(await onDisk(key)).toBe(false);
    }
    await read(club.founder, `/club-applications/${f.applicationId}`, 200, "none", { clubId: club.clubId });
    expect((await call(ANONYMOUS, mediaUrl(f.photoKey))).status).toBe(404);

    const drafter = await newUser("draft");
    const { submissionId } = await draftWithFiles(drafter);
    const keys = (await filesOf(submissionId)).map((r) => r.storageKey);
    expect(keys).toHaveLength(2);
    await sweepStaleFormDrafts(Date.now() + 31 * DAY, { userId: drafter.userId });
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) })).toBeUndefined();
    for (const key of keys) {
      expect((await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, key) }))!.deletedAt).not.toBeNull();
      expect(await onDisk(key)).toBe(false);
      expect((await call(ANONYMOUS, mediaUrl(key))).status).toBe(404);
    }
  });

  it("discarding a draft or deleting a single file also tombstones the registry entry", async () => {
    const who = await newUser("discard");
    const { submissionId } = await draftWithFiles(who);
    const rows = await filesOf(submissionId);
    const doc = rows.find((r) => r.fieldKey === "id_doc")!;
    expect((await call(who, `/form-submissions/${submissionId}/files/${doc.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, doc.storageKey) }))!.deletedAt).not.toBeNull();
    expect(await onDisk(doc.storageKey)).toBe(false);
    expect((await call(who, `/form-submissions/${submissionId}`, { method: "DELETE" })).status).toBe(204);
    const photo = rows.find((r) => r.fieldKey === "photo")!;
    expect((await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, photo.storageKey) }))!.deletedAt).not.toBeNull();
    expect(await onDisk(photo.storageKey)).toBe(false);
  });
});
