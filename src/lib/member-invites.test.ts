import { afterEach, describe, expect, it } from "vitest";

import { buildMemberInviteEmail } from "./emailTemplate.js";
import { hashInviteToken, inviteTtlDays, maskEmail, maskName } from "./member-invites.js";

describe("invite helpers", () => {
  afterEach(() => {
    delete process.env.MEMBER_INVITE_TTL_DAYS;
  });

  it("masks names and e-mail addresses", () => {
    expect(maskName("Max Mustermann")).toBe("Max M.");
    expect(maskName("Anna Maria Schmidt")).toBe("Anna M. S.");
    expect(maskName("Max")).toBe("M***");
    expect(maskName("   ")).toBe("***");
    expect(maskEmail("max.muster@example.com")).toBe("m***@example.com");
    expect(maskEmail("nonsense")).toBe("***");
  });

  it("hashes deterministically with a secret-keyed HMAC (no plain token, no bare SHA-256)", () => {
    expect(hashInviteToken("abc")).toBe(hashInviteToken("abc"));
    expect(hashInviteToken("abc")).not.toBe(hashInviteToken("abd"));
    expect(hashInviteToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken("abc")).not.toContain("abc");
  });

  it("TTL defaults to 14 days and is configurable within 1-60", () => {
    expect(inviteTtlDays()).toBe(14);
    process.env.MEMBER_INVITE_TTL_DAYS = "3";
    expect(inviteTtlDays()).toBe(3);
    process.env.MEMBER_INVITE_TTL_DAYS = "500";
    expect(inviteTtlDays()).toBe(60);
    process.env.MEMBER_INVITE_TTL_DAYS = "0";
    expect(inviteTtlDays()).toBe(14);
    process.env.MEMBER_INVITE_TTL_DAYS = "abc";
    expect(inviteTtlDays()).toBe(14);
  });

  it("the invite mail is German and HTML-escapes user-supplied text", () => {
    const html = buildMemberInviteEmail({ name: "<b>Max</b>", clubName: 'Club "<script>alert(1)</script>"', url: "http://x/einladung?token=a&b=c", expiresOn: "25.10.2026" });
    expect(html).toContain("lädt dich ein");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Max</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("token=a&amp;b=c");
    expect(html).toContain("Einladung annehmen");
  });
});
