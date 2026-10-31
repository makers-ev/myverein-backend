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

  it("filters segments AFTER the first scan too (multi-scan / progressive): APP1 EXIF between scans is removed", () => {
    const seg = (marker: number, data: Buffer) => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(data.length + 2);
      return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
    };
    const scanHeader = seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
    const entropy = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]); // stuffed FF and an RSTn stay inside the scan
    const poc = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xc2, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
      scanHeader, entropy,
      seg(0xe1, Buffer.from(`Exif\0\0${GPS_MARKER}`)), // hidden between the scans
      seg(0xfe, Buffer.from(GPS_MARKER)),
      scanHeader, entropy,
      Buffer.from([0xff, 0xd9]),
    ]);
    const out = stripJpegMetadata(poc);
    expect(out.includes(GPS_MARKER)).toBe(false);
    // both scans and their entropy data survive
    expect(out.indexOf(scanHeader)).toBeGreaterThan(0);
    expect(out.indexOf(scanHeader, out.indexOf(scanHeader) + 1)).toBeGreaterThan(out.indexOf(scanHeader));
    expect(out.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    // the literal PoC from the review: SOI, SOS, APP1 Exif GPS, SOS, EOI (no frame header) is refused instead of passed through
    const reviewPoc = Buffer.concat([Buffer.from([0xff, 0xd8]), scanHeader, entropy, seg(0xe1, Buffer.from(`Exif\0\0${GPS_MARKER}`)), scanHeader, entropy, Buffer.from([0xff, 0xd9])]);
    expect(() => stripJpegMetadata(reviewPoc)).toThrow(MalformedImageError);
  });

  it("drops JFIF thumbnails, non-ICC APP2, unknown segments and PNG/WebP chunks outside the allowlist", () => {
    const seg = (marker: number, data: Buffer) => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(data.length + 2);
      return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
    };
    const jfif = Buffer.concat([Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\x02\x02"), Buffer.from(`THUMB-${GPS_MARKER}`)]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]), seg(0xe0, jfif), seg(0xe2, Buffer.from(`MPF\0${GPS_MARKER}`)), seg(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01abc")),
      seg(0xe5, Buffer.from(GPS_MARKER)), seg(0xdb, Buffer.alloc(65, 1)), seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
      seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([1, 2, 3]), Buffer.from([0xff, 0xd9]),
    ]);
    const out = stripJpegMetadata(jpeg);
    expect(out.includes("THUMB")).toBe(false);
    expect(out.includes(GPS_MARKER)).toBe(false);
    expect(out.includes("ICC_PROFILE")).toBe(true);
    expect(out.includes("JFIF")).toBe(true);

    const chunk = (type: string, data: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const base = makePng(false);
    const withUnknown = Buffer.concat([base.subarray(0, 33), chunk("prVt", Buffer.from(GPS_MARKER)), chunk("iTXt", Buffer.from(GPS_MARKER)), base.subarray(33)]);
    expect(withUnknown.includes(GPS_MARKER)).toBe(true);
    expect(stripPngMetadata(withUnknown).equals(base)).toBe(true);
  });

  it("refuses implausible dimensions and bounds parser work: millions of tiny segments are rejected fast", () => {
    const png = makePng(false);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(0, 16); // width 0
    expect(() => stripPngMetadata(huge)).toThrow(MalformedImageError);
    const wide = Buffer.from(png);
    wide.writeUInt32BE(99_999, 16);
    expect(() => stripPngMetadata(wide)).toThrow(MalformedImageError);

    // 2M empty APP1 segments (8 MB) after a valid header.
    const tiny = Buffer.from([0xff, 0xe1, 0x00, 0x02]);
    const body = Buffer.alloc(tiny.length * 2_000_000);
    for (let i = 0; i < 2_000_000; i++) tiny.copy(body, i * 4);
    const bomb = Buffer.concat([Buffer.from([0xff, 0xd8]), body, Buffer.from([0xff, 0xd9])]);
    const started = Date.now();
    const before = process.memoryUsage().heapUsed;
    expect(() => stripJpegMetadata(bomb)).toThrow(/Too many/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);

    // Same for PNG chunks and WebP chunks.
    const emptyChunk = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("tEXt"), Buffer.alloc(4)]);
    const pngBomb = Buffer.concat([png.subarray(0, 33), ...Array.from({ length: 20_000 }, () => emptyChunk), png.subarray(33)]);
    expect(() => stripPngMetadata(pngBomb)).toThrow(/Too many/);
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
