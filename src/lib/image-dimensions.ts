/**
 * Pixel size of a PNG or JPEG read from the headers (no decoding), so a logo can be bounded before it is stored. `null` for
 * anything that is not a well-formed PNG/JPEG header. JPEG: the first start-of-frame marker; markers are walked with their
 * declared lengths and a hard step limit, so a crafted file cannot make this loop.
 */
export function imageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png") {
    if (buffer.length < 24 || buffer.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    for (let steps = 0; steps < 10_000 && offset + 4 <= buffer.length; steps++) {
      if (buffer[offset] !== 0xff) return null;
      const marker = buffer[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return offset + 9 <= buffer.length ? { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) } : null;
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** WCAG relative luminance of `#RRGGBB`. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio of a colour against white (1 = none, 21 = black). */
export function contrastAgainstWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}
