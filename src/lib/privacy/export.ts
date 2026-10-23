import { eq } from "drizzle-orm";

import { organization } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { AppError } from "../errors.js";
import { listFilesOf } from "./contributors.js";
import { contributors } from "./index.js";
import { loadSubject } from "./subject.js";

/** Upper bound of an export document (JSON bytes); the lists inside are bounded already, this is the safety net. */
export const EXPORT_MAX_BYTES = 5 * 1024 * 1024;

export interface MemberExport {
  generatedAt: string;
  club: { id: string; name: string };
  clubMemberId: string;
  /** One entry per contributor (see `lib/privacy/registry.ts`). */
  sections: Record<string, Record<string, unknown>>;
  /** Files registered for the person (name, type, size) -- the files themselves are fetched through the media layer. */
  files: Array<{ kind: string; filename: string; mimeType: string; sizeBytes: number; uploadedAt: string }>;
  note: string;
}

/** Everything the club holds about one member (Art. 15 GDPR), assembled from the registered contributors. */
export async function buildMemberExport(clubId: string, clubMemberId: string): Promise<MemberExport> {
  const { subject } = await loadSubject(clubId, clubMemberId);
  const [club] = await db.select({ id: organization.id, name: organization.name }).from(organization).where(eq(organization.id, clubId));
  const sections: MemberExport["sections"] = {};
  for (const c of contributors()) sections[c.key] = await c.exportSubject(db, subject);
  const out: MemberExport = {
    generatedAt: new Date().toISOString(),
    club: { id: clubId, name: club?.name ?? "" },
    clubMemberId,
    sections,
    files: await listFilesOf(db, subject),
    note: "Audit log entries (who accessed or changed data) and legally required records of the club are not part of this document.",
  };
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > EXPORT_MAX_BYTES) throw new AppError("BAD_REQUEST", 413, "The export is too large to be delivered in one document");
  return out;
}

const escapeHtml = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function renderValue(value: unknown, depth: number): string {
  if (value === null || value === undefined || value === "") return "<span class=\"empty\">&ndash;</span>";
  if (typeof value === "boolean") return value ? "ja" : "nein";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return escapeHtml(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "<span class=\"empty\">&ndash;</span>";
    return `<ol>${value.map((v) => `<li>${renderValue(v, depth + 1)}</li>`).join("")}</ol>`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "<span class=\"empty\">&ndash;</span>";
  return `<dl>${entries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${renderValue(v, depth + 1)}</dd>`).join("")}</dl>`;
}

/** Readable HTML version (all values escaped; no scripts, no external resources). */
export function renderExportHtml(data: MemberExport): string {
  const sections = Object.entries(data.sections)
    .map(([key, body]) => `<section><h2>${escapeHtml(key)}</h2>${renderValue(body, 0)}</section>`)
    .join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Datenauskunft</title><style>body{font-family:system-ui,sans-serif;max-width:50rem;margin:2rem auto;padding:0 1rem;line-height:1.4}dt{font-weight:600;margin-top:.5rem}dd{margin:0 0 0 1rem}.empty{color:#777}</style></head><body><h1>Datenauskunft: ${escapeHtml(data.club.name)}</h1><p>Erstellt am ${escapeHtml(data.generatedAt)}</p>${sections}<section><h2>files</h2>${renderValue(data.files, 0)}</section><p>${escapeHtml(data.note)}</p></body></html>`;
}
