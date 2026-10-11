import { describe, expect, it } from "vitest";

import { MalformedImageError, stripImageMetadata, stripJpegMetadata, stripPngMetadata, stripWebpMetadata } from "./image-sanitize.js";
import { GPS_MARKER, makeJpeg, makePng, makeWebp } from "./media-fixtures.js";

describe("image metadata stripping", () => {
  it("removes EXIF/XMP/IPTC/comments and trailing data from a JPEG, keeps JFIF and the image data", () => {
    const input = makeJpeg(true);
    expect(input.includes(GPS_MARKER)).toBe(true);
    const out = stripJpegMetadata(input);
    expect(out.includes(GPS_MARKER)).toBe(false);
    expect(out.includes("Exif")).toBe(false);
    expect(out.includes("JFIF")).toBe(true);
    expect(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(out.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    // Idempotent and identical to a file that never had metadata.
    expect(stripJpegMetadata(out).equals(out)).toBe(true);
    expect(out.equals(makeJpeg(false))).toBe(true);
  });

  it("removes tEXt/eXIf chunks from a PNG and keeps IHDR/IDAT/IEND", () => {
    const out = stripPngMetadata(makePng(true));
    expect(out.includes(GPS_MARKER)).toBe(false);
    expect(out.includes("eXIf")).toBe(false);
    expect(out.equals(makePng(false))).toBe(true);
  });

  it("removes EXIF/XMP chunks from a WebP, clears the VP8X flags and fixes the RIFF size", () => {
    const out = stripWebpMetadata(makeWebp(true));
    expect(out.includes(GPS_MARKER)).toBe(false);
    expect(out.readUInt32LE(4) + 8).toBe(out.length);
    expect(out.equals(makeWebp(false))).toBe(true);
  });

  it("rejects truncated or inconsistent files instead of passing them through", () => {
    expect(() => stripJpegMetadata(makeJpeg().subarray(0, 40))).toThrow(MalformedImageError);
    expect(() => stripJpegMetadata(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toThrow(MalformedImageError);
    expect(() => stripPngMetadata(makePng().subarray(0, 50))).toThrow(MalformedImageError);
    expect(() => stripWebpMetadata(makeWebp().subarray(0, 30))).toThrow(MalformedImageError);
    expect(() => stripPngMetadata(Buffer.from("not a png at all"))).toThrow(MalformedImageError);
  });

  it("dispatches by content type and leaves other types untouched", () => {
    const pdf = Buffer.from("%PDF-1.4");
    expect(stripImageMetadata(pdf, "application/pdf")).toBe(pdf);
    expect(stripImageMetadata(makePng(), "image/png").includes(GPS_MARKER)).toBe(false);
  });
});
