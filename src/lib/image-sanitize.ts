/**
 * Pure, dependency-free metadata stripping for uploaded images (Wave 7 B18). Removes everything that can carry
 * personal data -- EXIF (incl. GPS position, camera serial, timestamps), XMP, IPTC, comments -- WITHOUT touching or
 * re-encoding the pixel data. Colour profiles (ICC) stay. Structural problems (truncated / inconsistent file) throw
 * `MalformedImageError`; callers turn that into a 422.
 *
 * Note: the EXIF orientation flag is removed with the rest of EXIF. Clients should send an already upright image
 * (the mobile/web pickers bake the rotation in when they resize/crop).
 */

export class MalformedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedImageError";
  }
}

/** JPEG segments that stay: JFIF (APP0), ICC profile (APP2) and Adobe colour transform (APP14). */
const KEPT_JPEG_APP_MARKERS = new Set([0xe0, 0xe2, 0xee]);

export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw new MalformedImageError("Not a JPEG");
  const parts: Buffer[] = [input.subarray(0, 2)];
  let pos = 2;

  while (pos < input.length) {
    if (input[pos] !== 0xff) throw new MalformedImageError("Corrupt JPEG segment marker");
    // Fill bytes: any number of 0xFF may precede the marker byte.
    while (pos < input.length && input[pos] === 0xff) pos += 1;
    if (pos >= input.length) throw new MalformedImageError("Truncated JPEG");
    const marker = input[pos]!;
    pos += 1;

    // Standalone markers (no length): TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (marker === 0xd9) {
      // EOI -- everything after it is ignored (and dropped: trailing data is a classic hiding place).
      parts.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(parts);
    }
    if (pos + 2 > input.length) throw new MalformedImageError("Truncated JPEG");
    const length = input.readUInt16BE(pos);
    if (length < 2 || pos + length > input.length) throw new MalformedImageError("Truncated JPEG");

    if (marker === 0xda) {
      // Start of scan: copy the SOS header and the entropy-coded data up to the FIRST EOI (inside entropy data 0xFF is
      // always stuffed or an RSTn marker, so FF D9 is the real end). Anything after EOI is dropped.
      const eoi = input.indexOf(Buffer.from([0xff, 0xd9]), pos + length);
      if (eoi < 0) throw new MalformedImageError("JPEG has no end marker");
      parts.push(Buffer.from([0xff, marker]), input.subarray(pos, eoi + 2));
      return Buffer.concat(parts);
    }

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const drop = marker === 0xfe || (isApp && !KEPT_JPEG_APP_MARKERS.has(marker));
    if (!drop) parts.push(Buffer.from([0xff, marker]), input.subarray(pos, pos + length));
    pos += length;
  }
  throw new MalformedImageError("JPEG has no image data");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DROPPED_PNG_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

export function stripPngMetadata(input: Buffer): Buffer {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) throw new MalformedImageError("Not a PNG");
  const parts: Buffer[] = [PNG_SIGNATURE];
  let pos = 8;
  let sawEnd = false;

  while (pos < input.length) {
    if (pos + 12 > input.length) throw new MalformedImageError("Truncated PNG");
    const length = input.readUInt32BE(pos);
    const type = input.toString("latin1", pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > input.length) throw new MalformedImageError("Truncated PNG");
    if (!DROPPED_PNG_CHUNKS.has(type)) parts.push(input.subarray(pos, end));
    pos = end;
    if (type === "IEND") {
      sawEnd = true;
      break; // trailing bytes after IEND are dropped
    }
  }
  if (!sawEnd) throw new MalformedImageError("PNG has no end chunk");
  return Buffer.concat(parts);
}

const WEBP_VP8X_EXIF_FLAG = 0x08;
const WEBP_VP8X_XMP_FLAG = 0x04;

export function stripWebpMetadata(input: Buffer): Buffer {
  if (input.length < 12 || input.toString("latin1", 0, 4) !== "RIFF" || input.toString("latin1", 8, 12) !== "WEBP") {
    throw new MalformedImageError("Not a WebP");
  }
  const declared = input.readUInt32LE(4) + 8;
  if (declared > input.length) throw new MalformedImageError("Truncated WebP");

  const chunks: Buffer[] = [];
  let pos = 12;
  while (pos < declared) {
    if (pos + 8 > declared) throw new MalformedImageError("Truncated WebP");
    const fourcc = input.toString("latin1", pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const padded = size + (size % 2);
    const end = pos + 8 + padded;
    if (end > declared) throw new MalformedImageError("Truncated WebP");
    if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      const chunk = Buffer.from(input.subarray(pos, end));
      if (fourcc === "VP8X" && size >= 1) chunk[8] = chunk[8]! & ~(WEBP_VP8X_EXIF_FLAG | WEBP_VP8X_XMP_FLAG);
      chunks.push(chunk);
    }
    pos = end;
  }
  if (chunks.length === 0) throw new MalformedImageError("WebP has no image data");
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}

/** Strips metadata for one of the allowed image types; other content types are returned untouched. */
export function stripImageMetadata(buffer: Buffer, mimeType: string): Buffer {
  if (mimeType === "image/jpeg") return stripJpegMetadata(buffer);
  if (mimeType === "image/png") return stripPngMetadata(buffer);
  if (mimeType === "image/webp") return stripWebpMetadata(buffer);
  return buffer;
}
