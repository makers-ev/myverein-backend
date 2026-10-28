import { requestRenderSafely, type RenderRequest } from "./pdf/render.js";
import { registerBuiltinTemplates } from "./pdf/templates/index.js";

/**
 * Business actions that produce a document for the person (Wave 13 B9). Called AFTER the business transaction committed; a
 * failure to even schedule the render is only logged (by id and code) and never reaches the caller. The render itself runs in
 * the worker with retries; the idempotency key makes a repeated call (or a retried request) create the document only once.
 */

/** The registry is filled by the entry points; registering is idempotent, so a trigger also works in a process that only serves a few routes. */
async function schedule(req: RenderRequest): Promise<void> {
  registerBuiltinTemplates();
  await requestRenderSafely(req);
}

export async function scheduleAdmissionReceipt(input: { clubId: string; applicationId: string }): Promise<void> {
  await schedule({ clubId: input.clubId, templateId: "aufnahme-beleg", params: { applicationId: input.applicationId }, actor: null, idempotencyKey: `aufnahme-beleg:${input.applicationId}` });
}

export async function scheduleCancellationConfirmation(input: { clubId: string; exitRequestId: string }): Promise<void> {
  await schedule({ clubId: input.clubId, templateId: "kuendigungsbestaetigung", params: { exitRequestId: input.exitRequestId }, actor: null, idempotencyKey: `kuendigung:${input.exitRequestId}` });
}

/** The approved minutes are filed in the archive as soon as the approval is committed (immutable snapshot, one per version). */
export async function scheduleMinutesPdf(input: { clubId: string; meetingId: string; version: number }): Promise<void> {
  await schedule({ clubId: input.clubId, templateId: "versammlung-protokoll", params: { meetingId: input.meetingId, version: input.version }, actor: null, idempotencyKey: `protokoll:${input.meetingId}:${input.version}` });
}

/** The sent invitation (or Nachtrag) is filed as the proof of what went out. */
export async function scheduleInvitationPdf(input: { clubId: string; meetingId: string; version: number }): Promise<void> {
  await schedule({ clubId: input.clubId, templateId: "versammlung-einladung", params: { meetingId: input.meetingId, version: input.version }, actor: null, idempotencyKey: `einladung:${input.meetingId}:${input.version}` });
}
