import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { findMediaByKey, IMAGE_TYPES, MAX_IMAGE_BYTES, serveSignedMedia, storeUpload } from "../lib/media.js";
import { buildMediaUrl, mediaUrlTtlMs, verifyMediaSignature } from "../lib/media-url.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Media endpoints (Wave 7 B18). Two very different halves:
 *
 * - `GET /media/<key>?exp=&sig=` is registered FIRST and needs no session: it only checks the HMAC signature (minted by
 *   a feature route after ITS permission check) and the registry row. Plain `<img src>` and the native app `Image` can
 *   load it without cookies. Rate limited per IP (keyed by `x-forwarded-for`, see README "Operations": only meaningful behind a proxy that overwrites it).
 * - Everything registered after the `use(...)` calls (the upload) needs session + club membership.
 */
export const mediaRoutes = new Hono<ClubEnv>();

const servePerIp = rateLimit({ windowMs: 60_000, max: 600 });

// Key contains slashes (`<clubId>/<uuid>.<ext>`), so the param captures the rest of the path.
mediaRoutes.get("/:key{.+}", servePerIp, async (c) => {
  const key = c.req.param("key");
  const exp = c.req.query("exp");
  const sig = c.req.query("sig");

  // Signature first. Only a valid one reaches the registry as an authorisation; only a MISS looks for an explicit
  // public_opt_in (the one file kind that needs no signature). Unsigned requests for unknown keys get the same 403.
  if (verifyMediaSignature(key, exp, sig)) {
    const row = await findMediaByKey(key);
    if (!row) throw new NotFoundError("File not found");
    const maxAge = Math.min(Math.floor((Number(exp) - Date.now()) / 1000), Math.floor(mediaUrlTtlMs() / 1000));
    return serveSignedMedia(c, row, maxAge);
  }
  const candidate = await findMediaByKey(key);
  if (candidate && candidate.visibility === "public_opt_in" && !candidate.sensitive) return serveSignedMedia(c, candidate, 300);
  throw new ForbiddenError("Invalid or expired media link");
});

mediaRoutes.use("*", sessionGuard);
mediaRoutes.use("*", clubGuard);
mediaRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30, key: (c) => `media-upload:${c.get("user").id}` }));

/**
 * Generic image upload (e.g. damage report photos). Returns the storage `key` to put into the feature request
 * (`photoKey`) and a signed preview URL. The file is stored `unattached`; the feature route claims it exactly once.
 */
mediaRoutes.post(
  "/",
  bodyLimit({
    maxSize: MAX_IMAGE_BYTES + 64 * 1024, // multipart framing overhead on top of the file itself
    onError: () => {
      throw new ValidationError(`File exceeds maximum size of ${MAX_IMAGE_BYTES} bytes`);
    },
  }),
  async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      throw new ValidationError("Missing file upload (field name: file)");
    }

    const row = await storeUpload({
      file,
      clubId: c.get("clubId"),
      kind: "image",
      allowedTypes: IMAGE_TYPES,
      maxBytes: MAX_IMAGE_BYTES,
      visibility: "club",
      uploadedBy: c.get("user").id,
    });

    return c.json({ data: { key: row.storageKey, url: buildMediaUrl(row.storageKey), mimeType: row.mimeType, sizeBytes: row.sizeBytes } }, 201);
  },
);
