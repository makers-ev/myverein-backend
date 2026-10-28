import { describe, expect, it } from "vitest";

import { getPdfEngine, looksLikePdf, PdfRenderError, type PdfBranding, type PdfDocumentSpec } from "./engine.js";
import { pdfText } from "./text.js";

const branding: PdfBranding = { clubName: "TSV Test", primaryColor: "#2c4870", accentColor: "#c0392b", letterhead: ["Straße 1"], footer: null };
const spec = (blocks: PdfDocumentSpec["blocks"], extra: Partial<PdfDocumentSpec> = {}): PdfDocumentSpec => ({ title: "Test", generatedAt: new Date("2026-01-01T00:00:00Z"), format: "a4", branding, blocks, ...extra });

describe("pdfText", () => {
  it("keeps German text and replaces what the standard font cannot show", () => {
    expect(pdfText("Jörg Müller-Lüdenscheidt, Straße 5 – 10 €")).toBe("Jörg Müller-Lüdenscheidt, Straße 5 – 10 €");
    expect(pdfText("a😀b")).toBe("a?b");
    expect(pdfText("Łukasz")).toBe("Lukasz");
    expect(pdfText("中文")).toBe("??");
  });

  it("removes control and bidi characters and never throws", () => {
    expect(pdfText("a\u0000b\u202ec\u200fd\u0007")).toBe("abcd");
    expect(pdfText("x\ud800y")).toBe("x?y");
    expect(pdfText(null)).toBe("");
    expect(pdfText(42)).toBe("42");
  });

  it("limits the length and handles line breaks", () => {
    expect(pdfText("a".repeat(1000), { maxLength: 10 })).toBe("aaaaaaaaa…");
    expect(pdfText("a\nb")).toBe("a b");
    expect(pdfText("a\r\nb", { multiline: true })).toBe("a\nb");
    expect(pdfText("x".repeat(5_000_000), { maxLength: 20 }).length).toBeLessThanOrEqual(20);
  });

  it("treats typesetting-injection corpus as plain text", () => {
    for (const hostile of ["\\input{/etc/passwd}", "\\immediate\\write18{id}", "%", "}}}{{{", "\\catcode`\\{=12", "<script>alert(1)</script>", "$(id)"]) {
      expect(pdfText(hostile)).toContain(hostile.replace(/[^\x20-\x7e]/g, "?").slice(0, 1));
    }
  });
});

describe("pdf engine", () => {
  it("renders a PDF with every block type and embeds hostile text only as text", async () => {
    const buffer = await getPdfEngine().render(
      spec([
        { type: "heading", text: "\\input{/etc/passwd}" },
        { type: "paragraph", text: "\\immediate\\write18{id} 😀 \u202e" },
        { type: "keyValue", rows: [["Name", "Max"], ["%", "}}}"]] },
        { type: "table", columns: [{ title: "A", width: 1 }, { title: "B", width: 2 }], rows: [["1", "x".repeat(10_000)]] },
        { type: "qr", payload: "token" },
        { type: "signatureLine", label: "Unterschrift" },
      ]),
    );
    expect(looksLikePdf(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("renders a one-page card", async () => {
    const buffer = await getPdfEngine().render(spec([{ type: "keyValue", rows: [["Name", "Max"]] }, { type: "qr", payload: "mv1.x" }], { format: "card" }));
    expect(buffer.toString("latin1").match(/\/Type \/Page\b/g)?.length).toBe(1);
  });

  it("enforces the page limit, the size limit and the timeout", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [String(i), "x"]);
    const big = spec([{ type: "table", columns: [{ title: "A", width: 1 }, { title: "B", width: 1 }], rows }]);
    await expect(getPdfEngine().render(big, { maxPages: 2 })).rejects.toMatchObject({ code: "page_limit" });
    await expect(getPdfEngine().render(big, { timeoutMs: -1 })).rejects.toMatchObject({ code: "timeout" });
    await expect(getPdfEngine().render(big, { maxBytes: 100 })).rejects.toBeInstanceOf(PdfRenderError);
  });

  it("is deterministic for equal input apart from the document id", async () => {
    const a = await getPdfEngine().render(spec([{ type: "paragraph", text: "gleich" }]));
    const b = await getPdfEngine().render(spec([{ type: "paragraph", text: "gleich" }]));
    expect(a.length).toBe(b.length);
  });

  it("ignores an unreadable logo", async () => {
    const buffer = await getPdfEngine().render(spec([{ type: "paragraph", text: "x" }], { branding: { ...branding, logo: Buffer.from("not an image") } }));
    expect(looksLikePdf(buffer)).toBe(true);
  });
});
