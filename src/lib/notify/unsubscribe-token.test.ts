import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createUnsubscribeToken, unsubscribeUrlForSubject, verifyUnsubscribeToken } from "./unsubscribe-token.js";

const subject = { clubId: "club-1", userId: "user-1", clubMemberId: "11111111-1111-4111-8111-111111111111", category: "announcements" };

describe("unsubscribe tokens (B9)", () => {
  const original = { secret: process.env.UNSUBSCRIBE_SECRET, url: process.env.BACKEND_URL, ttl: process.env.UNSUBSCRIBE_TOKEN_TTL_DAYS };
  beforeEach(() => {
    process.env.UNSUBSCRIBE_SECRET = "unit-test-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
  });
  afterEach(() => {
    for (const [key, value] of [["UNSUBSCRIBE_SECRET", original.secret], ["BACKEND_URL", original.url], ["UNSUBSCRIBE_TOKEN_TTL_DAYS", original.ttl]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("round-trips person, category and club, preferring the account over the member row", () => {
    const token = createUnsubscribeToken(subject)!;
    expect(verifyUnsubscribeToken(token)).toMatchObject({ s: "u", p: "user-1", c: "announcements", k: "club-1" });
    const accountless = createUnsubscribeToken({ ...subject, userId: null })!;
    expect(verifyUnsubscribeToken(accountless)).toMatchObject({ s: "m", p: subject.clubMemberId });
  });

  it("refuses mandatory classes and subjects without a person", () => {
    expect(createUnsubscribeToken({ ...subject, category: "decisions" })).toBeNull();
    expect(createUnsubscribeToken({ ...subject, category: "anything" })).toBeNull();
    expect(createUnsubscribeToken({ ...subject, userId: null, clubMemberId: null })).toBeNull();
  });

  it("rejects an expired token and honours the TTL setting", () => {
    const now = Date.now();
    const token = createUnsubscribeToken(subject, now, 1000)!;
    expect(verifyUnsubscribeToken(token, now + 500)).not.toBeNull();
    expect(verifyUnsubscribeToken(token, now + 1000)).toBeNull();
    process.env.UNSUBSCRIBE_TOKEN_TTL_DAYS = "1";
    const day = verifyUnsubscribeToken(createUnsubscribeToken(subject)!)!;
    expect(day.e - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it("rejects tampered payloads, tampered signatures, foreign keys and garbage", () => {
    const token = createUnsubscribeToken(subject)!;
    const [payload, sig] = token.split(".") as [string, string];
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    forged.p = "user-2";
    const forgedPayload = Buffer.from(JSON.stringify(forged)).toString("base64url");
    expect(verifyUnsubscribeToken(`${forgedPayload}.${sig}`)).toBeNull();
    forged.p = "user-1";
    forged.c = "events";
    expect(verifyUnsubscribeToken(`${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${payload}.`)).toBeNull();
    expect(verifyUnsubscribeToken(payload)).toBeNull();
    expect(verifyUnsubscribeToken(`${token}.extra`)).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("a".repeat(5000))).toBeNull();
    expect(verifyUnsubscribeToken("%%%.%%%")).toBeNull();
    process.env.UNSUBSCRIBE_SECRET = "another-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("builds the one-click URL on the backend origin", () => {
    process.env.BACKEND_URL = "https://api.example.test/";
    const url = unsubscribeUrlForSubject(subject)!;
    expect(url.startsWith("https://api.example.test/unsubscribe/")).toBe(true);
    expect(verifyUnsubscribeToken(url.split("/unsubscribe/")[1]!)).not.toBeNull();
  });
});
