import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendRegistrationApprovedMail, sendRegistrationNeedsInfoMail, sendRegistrationReviewNotifyMail } from "./club-registration-mail.js";
import { sendEmail } from "./email.js";

vi.mock("./email.js", () => ({ sendEmail: vi.fn(async () => undefined) }));

const applicant = { name: "Erika <b>Muster</b>", email: "erika@example.com" };

describe("club registration mails", () => {
  const original = process.env.CLUB_REVIEW_NOTIFY_EMAIL;

  beforeEach(() => vi.mocked(sendEmail).mockClear());
  afterEach(() => {
    if (original === undefined) delete process.env.CLUB_REVIEW_NOTIFY_EMAIL;
    else process.env.CLUB_REVIEW_NOTIFY_EMAIL = original;
  });

  it("sends no reviewer mail (and does not throw) when CLUB_REVIEW_NOTIFY_EMAIL is unset", async () => {
    delete process.env.CLUB_REVIEW_NOTIFY_EMAIL;
    await expect(sendRegistrationReviewNotifyMail(applicant, "TV Test", "reg-1")).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("notifies every configured reviewer address", async () => {
    process.env.CLUB_REVIEW_NOTIFY_EMAIL = "a@example.com, b@example.com";
    await sendRegistrationReviewNotifyMail(applicant, "TV Test", "reg-1");
    expect(vi.mocked(sendEmail).mock.calls.map(([m]) => m.to)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("swallows send failures", async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendRegistrationApprovedMail(applicant, "TV Test", "tv-test", "reg-1")).resolves.toBeUndefined();
  });

  it("escapes user-supplied text in the HTML body", async () => {
    await sendRegistrationNeedsInfoMail(applicant, "<script>x</script>", "Zeile 1\n<img src=x>", "reg-1");
    const html = vi.mocked(sendEmail).mock.calls[0]![0].html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Zeile 1<br />");
    expect(html).not.toContain("<b>Muster</b>");
  });
});
