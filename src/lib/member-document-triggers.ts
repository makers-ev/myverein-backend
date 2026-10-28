import { requestRenderSafely } from "./pdf/render.js";

/**
 * Business actions that produce a document for the person (Wave 13 B9). Called AFTER the business transaction committed; a
 * failure to even schedule the render is only logged (by id and code) and never reaches the caller. The render itself runs in
 * the worker with retries; the idempotency key makes a repeated call (or a retried request) create the document only once.
 */

export async function scheduleAdmissionReceipt(input: { clubId: string; applicationId: string }): Promise<void> {
  await requestRenderSafely({ clubId: input.clubId, templateId: "aufnahme-beleg", params: { applicationId: input.applicationId }, actor: null, idempotencyKey: `aufnahme-beleg:${input.applicationId}` });
}

export async function scheduleCancellationConfirmation(input: { clubId: string; exitRequestId: string }): Promise<void> {
  await requestRenderSafely({ clubId: input.clubId, templateId: "kuendigungsbestaetigung", params: { exitRequestId: input.exitRequestId }, actor: null, idempotencyKey: `kuendigung:${input.exitRequestId}` });
}
