import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.fn().mockResolvedValue(undefined);
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

const resendSendMock = vi.fn().mockResolvedValue(undefined);
const resendCtorMock = vi.fn().mockImplementation(function () {
  return { emails: { send: resendSendMock } };
});
vi.mock("resend", () => ({
  Resend: resendCtorMock,
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn() },
}));

const originalEnv = { ...process.env };

async function loadSendEmail() {
  vi.resetModules();
  const mod = await import("./email.js");
  return mod.sendEmail;
}

describe("sendEmail", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SMTP_HOST;
    delete process.env.RESEND_API_KEY;
    sendMailMock.mockClear();
    resendSendMock.mockClear();
    createTransportMock.mockClear();
    resendCtorMock.mockClear();
  });

  it("uses SMTP when SMTP_HOST is set, even if RESEND_API_KEY is also set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "noreply@example.com";
    const sendEmail = await loadSendEmail();

    await sendEmail({ to: "a@b.com", subject: "s", html: "<p>hi</p>" });

    expect(sendMailMock).toHaveBeenCalledWith({
      from: "noreply@example.com",
      to: "a@b.com",
      subject: "s",
      html: "<p>hi</p>",
    });
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("passes SMTP_PORT/SMTP_SECURE/SMTP_USER through to createTransport", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASSWORD = "pass";

    await loadSendEmail();

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "user", pass: "pass" },
    });
  });

  it("defaults SMTP_PORT to 587 and leaves auth undefined without SMTP_USER", async () => {
    process.env.SMTP_HOST = "smtp.example.com";

    await loadSendEmail();

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: undefined,
    });
  });

  it("uses Resend when only RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "noreply@example.com";
    const sendEmail = await loadSendEmail();

    await sendEmail({ to: "a@b.com", subject: "s", html: "<p>hi</p>" });

    expect(resendSendMock).toHaveBeenCalledWith({
      from: "noreply@example.com",
      to: "a@b.com",
      subject: "s",
      html: "<p>hi</p>",
    });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("falls back to logging when neither SMTP_HOST nor RESEND_API_KEY is set", async () => {
    const sendEmail = await loadSendEmail();
    const { logger } = await import("./logger.js");

    await sendEmail({ to: "a@b.com", subject: "s", html: "<p>hi</p>" });

    expect(logger.info).toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});
