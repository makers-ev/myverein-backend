import PDFDocument from "pdfkit";
import QRCode from "qrcode";

import { pdfText } from "./text.js";

/**
 * PDF engine interface (ADR-010). Documents are described declaratively (blocks), never as template code, so user data
 * can only ever become text. The default implementation is pure Node (pdfkit, no shell, no external process); a render
 * container can replace it later by implementing `PdfEngine` -- callers depend on this file only.
 */

export const PDF_ENGINE_ID = "pdfkit";
/** Bumped whenever the visual output of the engine changes; stored with every generated document. */
export const PDF_ENGINE_VERSION = "pdfkit-1";

export type PdfPageFormat = "a4" | "card";

export interface PdfBranding {
  clubName: string;
  /** `#RRGGBB`. */
  primaryColor: string;
  accentColor: string;
  /** Validated PNG/JPEG bytes (never SVG); omitted = no logo. */
  logo?: Buffer | null;
  /** Letterhead lines (address, register number, representatives, contact), plain text. */
  letterhead: string[];
  footer?: string | null;
}

export type PdfBlock =
  | { type: "heading"; text: string; level?: 1 | 2 }
  | { type: "paragraph"; text: string }
  | { type: "keyValue"; rows: Array<[string, string]> }
  | { type: "table"; columns: Array<{ title: string; width: number }>; rows: string[][]; zebra?: boolean }
  | { type: "qr"; payload: string; size?: number; caption?: string }
  | { type: "photo"; image?: Buffer | null; initials?: string; size?: number }
  | { type: "spacer"; height?: number }
  | { type: "signatureLine"; label: string };

export interface PdfDocumentSpec {
  title: string;
  /** Stored in the PDF info dictionary; makes equal input produce equal metadata. */
  generatedAt: Date;
  format: PdfPageFormat;
  landscape?: boolean;
  branding: PdfBranding;
  blocks: PdfBlock[];
}

export interface PdfLimits {
  maxPages: number;
  maxBytes: number;
  timeoutMs: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = { maxPages: 200, maxBytes: 20 * 1024 * 1024, timeoutMs: 20_000 };

export class PdfRenderError extends Error {
  constructor(
    public readonly code: "timeout" | "page_limit" | "size_limit" | "engine_error",
    message: string,
  ) {
    super(message);
    this.name = "PdfRenderError";
  }
}

export interface PdfEngine {
  readonly id: string;
  readonly version: string;
  render(spec: PdfDocumentSpec, limits?: Partial<PdfLimits>): Promise<Buffer>;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const safeColor = (value: string, fallback: string) => (COLOR_RE.test(value) ? value : fallback);

const CARD_SIZE: [number, number] = [243, 153]; // 85.6 x 54 mm in points (ID-1)

type Doc = InstanceType<typeof PDFDocument>;

class PdfkitEngine implements PdfEngine {
  readonly id = PDF_ENGINE_ID;
  readonly version = PDF_ENGINE_VERSION;

  async render(spec: PdfDocumentSpec, partial: Partial<PdfLimits> = {}): Promise<Buffer> {
    const limits = { ...DEFAULT_PDF_LIMITS, ...partial };
    const started = Date.now();
    const check = (doc?: Doc) => {
      if (Date.now() - started > limits.timeoutMs) throw new PdfRenderError("timeout", "PDF rendering took too long");
      if (doc && doc.bufferedPageRange().count > limits.maxPages) throw new PdfRenderError("page_limit", "PDF exceeds the page limit");
    };
    try {
      return await this.draw(spec, limits, check);
    } catch (err) {
      if (err instanceof PdfRenderError) throw err;
      throw new PdfRenderError("engine_error", "PDF rendering failed");
    }
  }

  private async draw(spec: PdfDocumentSpec, limits: PdfLimits, check: (doc?: Doc) => void): Promise<Buffer> {
    const card = spec.format === "card";
    const primary = safeColor(spec.branding.primaryColor, "#2c4870");
    const accent = safeColor(spec.branding.accentColor, "#2c4870");
    const margin = card ? 10 : 56;
    const doc = new PDFDocument({
      size: card ? CARD_SIZE : "A4",
      layout: spec.landscape && !card ? "landscape" : "portrait",
      margin,
      bufferPages: true,
      compress: true,
      info: {
        Title: pdfText(spec.title, { maxLength: 200 }),
        Producer: "MyVerein",
        Creator: "MyVerein",
        CreationDate: spec.generatedAt,
        ModDate: spec.generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    let total = 0;
    doc.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limits.maxBytes) doc.destroy();
      else chunks.push(chunk);
    });
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on("end", () => (total > limits.maxBytes ? reject(new PdfRenderError("size_limit", "PDF exceeds the size limit")) : resolve(Buffer.concat(chunks))));
      doc.on("error", reject);
      doc.on("close", () => {
        if (total > limits.maxBytes) reject(new PdfRenderError("size_limit", "PDF exceeds the size limit"));
      });
    });

    // On the card the QR code sits at the right edge; the text columns leave room for it.
    const cardQr = card ? spec.blocks.find((b): b is Extract<PdfBlock, { type: "qr" }> => b.type === "qr") : undefined;
    const reserveRight = cardQr ? (cardQr.size ?? 70) + 8 : 0;
    const contentWidth = () => doc.page.width - margin * 2 - reserveRight;
    const bottomLimit = () => doc.page.height - margin - (card ? 0 : 24);

    const letterhead = () => {
      const b = spec.branding;
      let logoWidth = 0;
      if (b.logo && !card) {
        try {
          doc.image(b.logo, margin, margin, { fit: [90, 50] });
          logoWidth = 100;
        } catch {
          logoWidth = 0; // an unreadable logo never blocks the document
        }
      }
      const x = margin + logoWidth;
      doc.font("Helvetica-Bold").fontSize(card ? 9 : 14).fillColor(primary).text(pdfText(b.clubName, { maxLength: 120 }), x, margin, { width: contentWidth() - logoWidth });
      if (!card) {
        doc.font("Helvetica").fontSize(8.5).fillColor("#444444");
        for (const line of b.letterhead.slice(0, 8)) doc.text(pdfText(line, { maxLength: 160 }), x, undefined, { width: contentWidth() - logoWidth });
        const lineY = Math.max(doc.y, margin + 54) + 6;
        doc.moveTo(margin, lineY).lineTo(margin + contentWidth(), lineY).lineWidth(1.2).strokeColor(accent).stroke();
        doc.x = margin;
        doc.y = lineY + 14;
      } else {
        doc.x = margin;
      }
      doc.fillColor("#000000");
    };

    letterhead();
    doc.on("pageAdded", () => {
      if (!card) {
        doc.font("Helvetica").fontSize(8.5).fillColor("#666666").text(pdfText(spec.branding.clubName, { maxLength: 120 }), margin, margin - 20, { width: contentWidth() });
        doc.fillColor("#000000");
        doc.x = margin;
        doc.y = margin + 6;
      }
    });

    const ensure = (height: number) => {
      if (doc.y + height > bottomLimit()) {
        doc.addPage();
        check(doc);
      }
    };

    for (const block of spec.blocks) {
      check(doc);
      switch (block.type) {
        case "heading": {
          const size = block.level === 2 ? 11.5 : 16;
          ensure(size + 18);
          doc.font("Helvetica-Bold").fontSize(size).fillColor(primary).text(pdfText(block.text, { maxLength: 200 }), margin, undefined, { width: contentWidth() });
          doc.fillColor("#000000").moveDown(0.4);
          break;
        }
        case "paragraph": {
          const text = pdfText(block.text, { maxLength: 8000, multiline: true });
          doc.font("Helvetica").fontSize(card ? 7 : 10);
          for (const para of text.split("\n")) {
            ensure(doc.heightOfString(para || " ", { width: contentWidth() }) + 4);
            doc.text(para || " ", margin, undefined, { width: contentWidth(), align: "left" });
          }
          doc.moveDown(0.5);
          break;
        }
        case "keyValue": {
          const keyWidth = Math.min(160, contentWidth() * 0.38);
          for (const [key, value] of block.rows.slice(0, 200)) {
            const k = pdfText(key, { maxLength: 80 });
            const v = pdfText(value, { maxLength: 400, multiline: true }) || "-";
            doc.font("Helvetica").fontSize(card ? 7 : 10);
            const h = Math.max(doc.heightOfString(v, { width: contentWidth() - keyWidth - 8 }), 12);
            ensure(h + 4);
            const y = doc.y;
            doc.font("Helvetica-Bold").fillColor("#444444").text(k, margin, y, { width: keyWidth, lineBreak: false, ellipsis: true });
            doc.font("Helvetica").fillColor("#000000").text(v, margin + keyWidth + 8, y, { width: contentWidth() - keyWidth - 8 });
            doc.y = y + h + 4;
          }
          doc.moveDown(0.4);
          break;
        }
        case "table": {
          const weight = block.columns.reduce((s, c) => s + Math.max(1, c.width), 0);
          const widths = block.columns.map((c) => (Math.max(1, c.width) / weight) * contentWidth());
          const rowHeight = 15;
          const drawRow = (cells: string[], header: boolean, index: number) => {
            const y = doc.y;
            if (header) doc.rect(margin, y - 2, contentWidth(), rowHeight).fill(primary);
            else if (block.zebra !== false && index % 2 === 1) doc.rect(margin, y - 2, contentWidth(), rowHeight).fill("#f1f3f6");
            doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(header ? "#ffffff" : "#000000");
            let x = margin;
            widths.forEach((w, i) => {
              doc.text(pdfText(cells[i] ?? "", { maxLength: 120 }), x + 3, y + 1, { width: w - 6, height: rowHeight - 2, lineBreak: false, ellipsis: true });
              x += w;
            });
            doc.fillColor("#000000");
            doc.y = y + rowHeight;
          };
          ensure(rowHeight * 3);
          drawRow(block.columns.map((c) => c.title), true, 0);
          block.rows.forEach((row, i) => {
            if (doc.y + rowHeight > bottomLimit()) {
              doc.addPage();
              check(doc);
              drawRow(block.columns.map((c) => c.title), true, 0);
            }
            drawRow(row, false, i);
            if (i % 50 === 0) check(doc);
          });
          doc.moveDown(0.6);
          break;
        }
        case "qr": {
          const size = block.size ?? (card ? 70 : 120);
          if (!card) ensure(size + (block.caption ? 18 : 6));
          const qr = QRCode.create(block.payload.slice(0, 1000), { errorCorrectionLevel: "M" });
          const modules = qr.modules;
          const count = modules.size;
          const quiet = 2;
          const unit = size / (count + quiet * 2);
          const x0 = card ? doc.page.width - margin - size : margin;
          const y0 = card ? margin + 14 : doc.y;
          const resumeY = doc.y;
          doc.rect(x0, y0, size, size).fill("#ffffff");
          for (let r = 0; r < count; r++) {
            for (let c = 0; c < count; c++) {
              if (modules.get(r, c)) doc.rect(x0 + (c + quiet) * unit, y0 + (r + quiet) * unit, unit + 0.2, unit + 0.2).fill("#000000");
            }
          }
          doc.fillColor("#000000");
          if (card) {
            doc.y = resumeY;
            doc.x = margin;
            break;
          }
          doc.y = y0 + size + 4;
          if (block.caption) doc.font("Helvetica").fontSize(8).fillColor("#444444").text(pdfText(block.caption, { maxLength: 120 }), x0, undefined, { width: Math.max(size, 120) });
          doc.fillColor("#000000").x = margin;
          break;
        }
        case "photo": {
          // A validated PNG/JPEG, or the initials in a plain box when there is no photo (or it cannot be drawn). On the card it
          // sits in the lower left corner without moving the text flow; on a page it takes its place in the flow.
          const size = block.size ?? (card ? 44 : 80);
          const x0 = margin;
          const y0 = card ? doc.page.height - margin - size : doc.y;
          if (!card) ensure(size + 8);
          const yy = card ? y0 : doc.y;
          let drawn = false;
          if (block.image && block.image.length > 0 && block.image.length <= 2 * 1024 * 1024) {
            try {
              doc.image(block.image, x0, yy, { fit: [size, size] });
              drawn = true;
            } catch {
              drawn = false;
            }
          }
          if (!drawn) {
            doc.rect(x0, yy, size, size).fill("#e8ecf2");
            doc.font("Helvetica-Bold").fontSize(size / 2.6).fillColor(primary).text(pdfText(block.initials ?? "", { maxLength: 3 }), x0, yy + size / 2 - size / 5.2, { width: size, align: "center", lineBreak: false });
            doc.fillColor("#000000");
          }
          if (!card) {
            doc.y = yy + size + 8;
            doc.x = margin;
          }
          break;
        }
        case "spacer":
          doc.y += block.height ?? 12;
          break;
        case "signatureLine": {
          ensure(40);
          doc.y += 24;
          const y = doc.y;
          doc.moveTo(margin, y).lineTo(margin + 200, y).lineWidth(0.6).strokeColor("#000000").stroke();
          doc.font("Helvetica").fontSize(8).fillColor("#444444").text(pdfText(block.label, { maxLength: 120 }), margin, y + 3, { width: 260 });
          doc.fillColor("#000000");
          break;
        }
      }
    }

    // Footer with page numbers on every page (A4 only).
    if (!card) {
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font("Helvetica").fontSize(8).fillColor("#666666");
        const footer = spec.branding.footer ? `${pdfText(spec.branding.footer, { maxLength: 160 })}  |  ` : "";
        doc.text(`${footer}Seite ${i + 1} von ${range.count}`, margin, doc.page.height - margin + 6, { width: contentWidth(), align: "center", lineBreak: false });
        doc.page.margins.bottom = savedBottom;
      }
    }
    check(doc);
    doc.end();
    return done;
  }
}

let engine: PdfEngine = new PdfkitEngine();

/** The active engine. Tests and a future render container swap it through `setPdfEngine`. */
export function getPdfEngine(): PdfEngine {
  return engine;
}

export function setPdfEngine(next: PdfEngine | null): void {
  engine = next ?? new PdfkitEngine();
}

/** Checks the output really is a PDF (magic bytes) -- the engine result is never trusted blindly. */
export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.toString("latin1", 0, 5) === "%PDF-";
}
