import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { NotFoundError, ValidationError } from "../lib/errors.js";
import { getObject, putObject } from "../lib/storage.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const mediaRoutes = new Hono<ClubEnv>();

mediaRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
mediaRoutes.use("*", sessionGuard);
mediaRoutes.use("*", clubGuard);

export const ALLOWED_IMAGE_CONTENT_TYPES: string[] = ["image/jpeg", "image/png", "image/webp"];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** Content-type/size gate. Pure so it's unit-testable without a live server. */
export function assertValidImage(contentType: string, sizeBytes: number): void {
  if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new ValidationError(`Unsupported content type: ${contentType}`);
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new ValidationError(`File exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`);
  }
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

mediaRoutes.post(
  "/",
  bodyLimit({
    maxSize: MAX_UPLOAD_BYTES,
    onError: () => {
      throw new ValidationError(`File exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`);
    },
  }),
  async (c) => {
    const clubId = c.get("clubId");

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      throw new ValidationError("Missing file upload (field name: file)");
    }

    assertValidImage(file.type, file.size);

    const buffer = Buffer.from(await file.arrayBuffer());
    const { key } = await putObject({ clubId, filename: file.name, buffer });

    return c.json({ data: { key } }, 201);
  },
);

// Key contains a slash (`${clubId}/${uuid}-${filename}`), so the param needs
// a regex capturing the rest of the path, not a plain `:key`.
mediaRoutes.get("/:key{.+}", async (c) => {
  const clubId = c.get("clubId");
  const key = c.req.param("key");

  // The key's club-id prefix must match the caller's club -- never 403, same
  // "don't leak existence" convention as the rest of this backend.
  const [keyClubId] = key.split("/", 1);
  if (keyClubId !== clubId) {
    throw new NotFoundError("File not found");
  }

  let buffer: Buffer;
  try {
    buffer = await getObject(key);
  } catch {
    throw new NotFoundError("File not found");
  }

  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";

  c.header("Content-Type", contentType);
  return c.body(new Uint8Array(buffer));
});
