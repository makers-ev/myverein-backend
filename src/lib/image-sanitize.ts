/**
 * Pure, dependency-free metadata stripping for uploaded images (Wave 7 B18). Works with ALLOWLISTS: only the structural
 * parts needed to decode the image (plus colour profiles) are copied into a pre-allocated output buffer, everything else
 * -- EXIF (GPS, serials, timestamps), XMP, IPTC, comments, JFIF thumbnails, vendor/unknown segments, trailing data -- is
 * dropped. The pixel data is never decoded or re-encoded. Structural problems (truncated, implausible, too many
 * segments) throw `MalformedImageError`; callers turn that into a 422.
 *
 * Note: the EXIF orientation flag disappears with the rest of EXIF. Clients should send an already upright image.
 */

export class MalformedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedImageError";
  }
}

/** A real photo has at most a few hundred segments/chunks; this bounds parser work per file. */
export const MAX_SEGMENTS = 10_000;
const MAX_DIMENSION = 30_000;
const MAX_PIXELS = 120_000_000;

function assertPlausibleSize(width: number, height: number): void {
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new MalformedImageError(`Implausible image dimensions ${width}x${height}`);
  }
}

// --- JPEG ----------------------------------------------------------------------------------------

/** SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) are frame headers. */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Structural segments copied verbatim: DHT, DAC, DQT, DNL, DRI. */
const COPIED_JPEG_MARKERS = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd]);

export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw new MalformedImageError("Not a JPEG");
  const out = Buffer.allocUnsafe(input.length);
  let o = input.copy(out, 0, 0, 2);
  let pos = 2;
  let segments = 0;
  let sawFrame = false;
  let sawScan = false;

  while (true) {
    if (pos >= input.length) throw new MalformedImageError("JPEG has no end marker");
    if (input[pos] !== 0xff) throw new MalformedImageError("Corrupt JPEG segment marker");
    while (pos < input.length && input[pos] === 0xff) pos += 1; // fill bytes
    if (pos >= input.length) throw new MalformedImageError("Truncated JPEG");
    const marker = input[pos]!;
    pos += 1;

    if (marker === 0xd9) {
      if (!sawFrame || !sawScan) throw new MalformedImageError("JPEG has no image data");
      o += input.copy(out, o, pos - 2, pos); // EOI; everything after it is dropped
      return Buffer.from(out.subarray(0, o));
    }
    if (marker === 0x00 || marker === 0xd8) throw new MalformedImageError("Corrupt JPEG segment marker");
    segments += 1;
    if (segments > MAX_SEGMENTS) throw new MalformedImageError("Too many JPEG segments");
    // Standalone markers (TEM, RSTn) carry no length and no meaning outside a scan: drop.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (pos + 2 > input.length) throw new MalformedImageError("Truncated JPEG");
    const length = input.readUInt16BE(pos);
    if (length < 2 || pos + length > input.length) throw new MalformedImageError("Truncated JPEG");
    const data = input.subarray(pos + 2, pos + length);
    const segmentEnd = pos + length;

    if (isSof(marker)) {
      if (data.length < 6) throw new MalformedImageError("Corrupt JPEG frame header");
      assertPlausibleSize(data.readUInt16BE(3), data.readUInt16BE(1));
      sawFrame = true;
      o += input.copy(out, o, pos - 2, segmentEnd);
    } else if (COPIED_JPEG_MARKERS.has(marker)) {
      o += input.copy(out, o, pos - 2, segmentEnd);
    } else if (marker === 0xe0 && data.length >= 14 && data.toString("latin1", 0, 5) === "JFIF\0") {
      // JFIF header without the embedded thumbnail (thumbnail size 0x0).
      out[o++] = 0xff;
      out[o++] = 0xe0;
      out.writeUInt16BE(16, o);
      o += 2;
      o += data.copy(out, o, 0, 12);
      out[o++] = 0;
      out[o++] = 0;
    } else if (marker === 0xe2 && data.toString("latin1", 0, 12) === "ICC_PROFILE\0") {
      o += input.copy(out, o, pos - 2, segmentEnd);
    } else if (marker === 0xee && data.length >= 12 && data.toString("latin1", 0, 5) === "Adobe") {
      o += input.copy(out, o, pos - 2, segmentEnd); // colour transform flag, needed to decode CMYK/YCCK
    } else if (marker === 0xda) {
      if (!sawFrame) throw new MalformedImageError("JPEG scan before frame header");
      sawScan = true;
      // Scan header + entropy-coded data up to the next REAL marker: inside the data 0xFF is stuffed (FF00) or an RSTn.
      let end = segmentEnd;
      while (end < input.length) {
        if (input[end] === 0xff) {
          const next = input[end + 1];
          if (next === undefined) break;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      o += input.copy(out, o, pos - 2, end);
      pos = end;
      continue; // later scans (progressive / multi-scan) and trailing segments are filtered by the same rules
    }
    // else: APPn (EXIF, XMP, IPTC, vendor), COM, JFXX, unknown markers -> dropped
    pos = segmentEnd;
  }
}

// --- PNG -----------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks needed to decode / colour-manage the image. eXIf, tEXt, zTXt, iTXt, tIME and anything unknown are dropped. */
const KEPT_PNG_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "pHYs", "sBIT", "bKGD"]);

export function stripPngMetadata(input: Buffer): Buffer {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) throw new MalformedImageError("Not a PNG");
  const out = Buffer.allocUnsafe(input.length);
  let o = input.copy(out, 0, 0, 8);
  let pos = 8;
  let chunks = 0;
  let sawData = false;
  let sawEnd = false;

  while (pos < input.length) {
    chunks += 1;
    if (chunks > MAX_SEGMENTS) throw new MalformedImageError("Too many PNG chunks");
    if (pos + 12 > input.length) throw new MalformedImageError("Truncated PNG");
    const length = input.readUInt32BE(pos);
    const type = input.toString("latin1", pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > input.length) throw new MalformedImageError("Truncated PNG");
    if (chunks === 1) {
      if (type !== "IHDR" || length !== 13) throw new MalformedImageError("PNG must start with an IHDR chunk");
      assertPlausibleSize(input.readUInt32BE(pos + 8), input.readUInt32BE(pos + 12));
    }
    if (type === "IDAT") sawData = true;
    if (KEPT_PNG_CHUNKS.has(type)) o += input.copy(out, o, pos, end);
    pos = end;
    if (type === "IEND") {
      sawEnd = true;
      break; // trailing bytes after IEND are dropped
    }
  }
  if (!sawEnd || !sawData) throw new MalformedImageError("PNG has no image data or end chunk");
  return Buffer.from(out.subarray(0, o));
}

// --- WebP ----------------------------------------------------------------------------------------

/** Image data, alpha, animation frames/parameters, colour profile and the extended header. EXIF, XMP and unknown chunks go. */
const KEPT_WEBP_CHUNKS = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);
const WEBP_VP8X_EXIF_FLAG = 0x08;
const WEBP_VP8X_XMP_FLAG = 0x04;

export function stripWebpMetadata(input: Buffer): Buffer {
  if (input.length < 12 || input.toString("latin1", 0, 4) !== "RIFF" || input.toString("latin1", 8, 12) !== "WEBP") {
    throw new MalformedImageError("Not a WebP");
  }
  const declared = input.readUInt32LE(4) + 8;
  if (declared > input.length) throw new MalformedImageError("Truncated WebP");

  const out = Buffer.allocUnsafe(input.length);
  let o = 12;
  let pos = 12;
  let chunks = 0;
  let sawImage = false;
  while (pos < declared) {
    chunks += 1;
    if (chunks > MAX_SEGMENTS) throw new MalformedImageError("Too many WebP chunks");
    if (pos + 8 > declared) throw new MalformedImageError("Truncated WebP");
    const fourcc = input.toString("latin1", pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size % 2);
    if (end > declared) throw new MalformedImageError("Truncated WebP");
    if (KEPT_WEBP_CHUNKS.has(fourcc)) {
      const start = o;
      o += input.copy(out, o, pos, end);
      if (fourcc === "VP8X") {
        if (size < 10) throw new MalformedImageError("Corrupt WebP header");
        out[start + 8] = out[start + 8]! & ~(WEBP_VP8X_EXIF_FLAG | WEBP_VP8X_XMP_FLAG);
        assertPlausibleSize(input.readUIntLE(pos + 12, 3) + 1, input.readUIntLE(pos + 15, 3) + 1);
      }
      if (fourcc === "VP8 " || fourcc === "VP8L" || fourcc === "ANMF") sawImage = true;
    }
    pos = end;
  }
  if (!sawImage) throw new MalformedImageError("WebP has no image data");
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(o - 8, 4);
  out.write("WEBP", 8, "latin1");
  return Buffer.from(out.subarray(0, o));
}

/** Strips metadata for one of the allowed image types; other content types are returned untouched. */
export function stripImageMetadata(buffer: Buffer, mimeType: string): Buffer {
  if (mimeType === "image/jpeg") return stripJpegMetadata(buffer);
  if (mimeType === "image/png") return stripPngMetadata(buffer);
  if (mimeType === "image/webp") return stripWebpMetadata(buffer);
  return buffer;
}
