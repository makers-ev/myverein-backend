import { z } from "zod";

import type { ClubPermission } from "../club-permissions.js";
import type { DocumentPrincipal } from "../document-access.js";
import { PDF_ENGINE_VERSION, type PdfBlock, type PdfBranding, type PdfPageFormat } from "./engine.js";

/**
 * Template registry of the render pipeline (Wave 13 B8): a fixed, versioned whitelist of document types. Clubs cannot add
 * templates; only the branding changes the look. A template is TypeScript that turns source data into declarative blocks
 * (see `engine.ts`), so user data can only ever become text.
 *
 * Two phases keep the permission model honest although rendering may run later in the worker:
 *   `authorize`  runs at request time with the CALLER's rights (same checks as reading the source data directly),
 *   `build`      runs at execution time, trusted, reads the source data of exactly the club of the job.
 */

export type TemplateDestination = "archive" | "person" | "ephemeral";

export interface BuiltDocument<D> {
  data: D;
  /** Title of the document in the archive / personal storage (plain text, will be cut and escaped). */
  title: string;
  /** File name without path, ends with `.pdf`. */
  filename: string;
  /** Person the document is about: its personal storage receives it (`destination = person`). */
  subjectClubMemberId?: string | null;
}

export interface TemplateLayout {
  format: PdfPageFormat;
  landscape?: boolean;
  title: string;
  blocks: PdfBlock[];
}

export interface TemplateDefinition<P, D> {
  /** Stable machine name, `^[a-z0-9-]+$`. */
  id: string;
  /** Bumped with every visible change of the layout or the data; stored with each generated document. */
  version: number;
  /** German label shown to users. */
  label: string;
  description: string;
  /** `archive`: club archive, `person`: personal storage of the subject, `ephemeral`: returned directly, nothing stored. */
  destination: TemplateDestination;
  /** Right needed to see the template in the list and to request it at all (`null`: only `authorize` decides, e.g. a member asking for their own). */
  permission: ClubPermission | null;
  /** `doc_type` of the stored document (drives retention and display). */
  docType: string;
  /** Sensitive documents are only streamed authenticated with an audit entry (reports, personal documents). */
  sensitive: boolean;
  /** System folder of the archive that receives the document (created on first use). */
  folder?: { systemKey: string; name: string };
  /** Short document: the request waits for the result; otherwise it only answers `202` and the worker renders. */
  sync: boolean;
  paramsSchema: z.ZodType<P>;
  authorize(actor: DocumentPrincipal, params: P): Promise<void>;
  build(clubId: string, params: P): Promise<BuiltDocument<D>>;
  layout(built: BuiltDocument<D>, branding: PdfBranding, params: P): TemplateLayout;
}

export type AnyTemplate = TemplateDefinition<unknown, unknown>;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const templates = new Map<string, AnyTemplate>();

/** Declares a template with its parameter and data types and returns it in the registry's uniform shape. */
export function defineTemplate<P, D>(definition: TemplateDefinition<P, D>): AnyTemplate {
  if (!ID_RE.test(definition.id)) throw new Error(`invalid template id: ${definition.id}`);
  if (!Number.isInteger(definition.version) || definition.version < 1) throw new Error("template version must be a positive integer");
  return definition as unknown as AnyTemplate;
}

export function registerTemplate(template: AnyTemplate): void {
  if (templates.has(template.id)) throw new Error(`template already registered: ${template.id}`);
  templates.set(template.id, template);
}

export function unregisterTemplate(id: string): void {
  templates.delete(id);
}

export function getTemplate(id: string): AnyTemplate | null {
  return templates.get(id) ?? null;
}

export function listTemplates(): AnyTemplate[] {
  return [...templates.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Engine version recorded with every generated document. */
export const RENDER_ENGINE_VERSION = PDF_ENGINE_VERSION;
