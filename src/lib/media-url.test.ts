import { afterEach, describe, expect, it } from "vitest";

import { buildMediaUrl, mediaUrlTtlMs, signMediaKey, verifyMediaSignature } from "./media-url.js";

describe("signed media URLs", () => {
  const key = "club-1/3f2b8f0e.jpg";
  const exp = Date.now() + 60_000;
  const original = { ttl: process.env.MEDIA_URL_TTL_SECONDS, url: process.env.BACKEND_URL };

  afterEach(() => {
    if (original.ttl === undefined) delete process.env.MEDIA_URL_TTL_SECONDS;
    else process.env.MEDIA_URL_TTL_SECONDS = original.ttl;
    if (original.url === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = original.url;
  });

  it("accepts a valid signature until it expires", () => {
    const sig = signMediaKey(key, exp);
    expect(verifyMediaSignature(key, String(exp), sig)).toBe(true);
    expect(verifyMediaSignature(key, String(exp), sig, exp + 1)).toBe(false);
    expect(verifyMediaSignature(key, String(exp), sig, exp)).toBe(true);
  });

  it("rejects missing, tampered and malformed input without throwing", () => {
    const sig = signMediaKey(key, exp);
    expect(verifyMediaSignature(key, undefined, sig)).toBe(false);
    expect(verifyMediaSignature(key, String(exp), undefined)).toBe(false);
    expect(verifyMediaSignature("club-2/other.jpg", String(exp), sig)).toBe(false); // other key
    expect(verifyMediaSignature(key, String(exp + 1000), sig)).toBe(false); // extended expiry
    expect(verifyMediaSignature(key, String(exp), sig.slice(0, -2) + (sig.endsWith("00") ? "11" : "00"))).toBe(false);
    expect(verifyMediaSignature(key, String(exp), sig.slice(0, 10))).toBe(false); // length mismatch
    expect(verifyMediaSignature(key, String(exp), "zz".repeat(32))).toBe(false); // not hex
    expect(verifyMediaSignature(key, "abc", sig)).toBe(false);
    expect(verifyMediaSignature(key, "-5", sig)).toBe(false);
    expect(verifyMediaSignature(key, "9".repeat(30), sig)).toBe(false);
  });

  it("namespaces the signed input (a signature over the bare key:exp does not verify)", () => {
    expect(signMediaKey(key, exp)).not.toBe(signMediaKey(`media-url:${key}`, exp));
  });

  it("builds an absolute URL with exp and sig, encoding each path segment", () => {
    process.env.BACKEND_URL = "https://api.example.com/";
    const url = new URL(buildMediaUrl("club 1/a b.jpg", 60_000, 1_000_000));
    expect(url.origin).toBe("https://api.example.com");
    expect(url.pathname).toBe("/media/club%201/a%20b.jpg");
    expect(url.searchParams.get("exp")).toBe("1060000");
    expect(verifyMediaSignature("club 1/a b.jpg", url.searchParams.get("exp")!, url.searchParams.get("sig")!, 1_000_001)).toBe(true);
  });

  it("uses a configurable TTL, clamped to 30 s .. 24 h", () => {
    delete process.env.MEDIA_URL_TTL_SECONDS;
    expect(mediaUrlTtlMs()).toBe(30 * 60_000);
    process.env.MEDIA_URL_TTL_SECONDS = "120";
    expect(mediaUrlTtlMs()).toBe(120_000);
    process.env.MEDIA_URL_TTL_SECONDS = "1";
    expect(mediaUrlTtlMs()).toBe(30_000);
    process.env.MEDIA_URL_TTL_SECONDS = "999999999";
    expect(mediaUrlTtlMs()).toBe(24 * 60 * 60_000);
    process.env.MEDIA_URL_TTL_SECONDS = "nonsense";
    expect(mediaUrlTtlMs()).toBe(30 * 60_000);
  });
});
