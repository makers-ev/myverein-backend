import { crc32 } from "node:zlib";

/**
 * Structurally valid (not necessarily decodable) image files for the media layer tests, each carrying a recognisable
 * metadata marker so tests can assert it is gone after the upload. Test support only -- not imported by production code.
 */

export const GPS_MARKER = "GPS-LAT-52.5200N-LON-13.4050E";

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export function makePng(withMetadata = true, size: { width: number; height: number } = { width: 1, height: 1 }): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size.width, 0);
  ihdr.writeUInt32BE(size.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(withMetadata ? [pngChunk("tEXt", Buffer.from(`Comment\0${GPS_MARKER}`)), pngChunk("eXIf", Buffer.from(`Exif\0\0${GPS_MARKER}`))] : []),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

export function makeJpeg(withMetadata = true, size: { width: number; height: number } = { width: 1, height: 1 }): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...(withMetadata
      ? [jpegSegment(0xe1, Buffer.from(`Exif\0\0${GPS_MARKER}`)), jpegSegment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${GPS_MARKER}`)), jpegSegment(0xed, Buffer.from(`Photoshop 3.0\0${GPS_MARKER}`)), jpegSegment(0xfe, Buffer.from(GPS_MARKER))]
      : []),
    jpegSegment(0xdb, Buffer.alloc(65, 1)),
    jpegSegment(0xc0, Buffer.from([8, size.height >> 8, size.height & 0xff, size.width >> 8, size.width & 0xff, 1, 1, 0x11, 0])),
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), // entropy-coded data incl. a stuffed 0xFF
    Buffer.from([0xff, 0xd9]),
    ...(withMetadata ? [Buffer.from(`TRAILER-${GPS_MARKER}`)] : []),
  ]);
}

function webpChunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export function makeWebp(withMetadata = true): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = withMetadata ? 0x08 | 0x04 : 0; // EXIF + XMP flags
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    webpChunk("VP8X", vp8x),
    webpChunk("VP8 ", Buffer.from([1, 2, 3, 4, 5, 6, 7])),
    ...(withMetadata ? [webpChunk("EXIF", Buffer.from(`Exif\0\0${GPS_MARKER}`)), webpChunk("XMP ", Buffer.from(`<x:xmpmeta>${GPS_MARKER}</x:xmpmeta>`))] : []),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
