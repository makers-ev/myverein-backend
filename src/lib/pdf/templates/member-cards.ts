import { z } from "zod";

import { db } from "../../../db/client.js";
import { ForbiddenError, NotFoundError } from "../../errors.js";
import { hasClubPermission } from "../../club-permissions.js";
import { MAX_PHOTO_BYTES, readRegisteredFile } from "../../media.js";
import { categoryNameOf, cardState, ensureCard, findCardOf, initialsOf, loadMemberRow, photoConsentGranted, signCardToken } from "../../member-cards.js";
import { defineTemplate, type TemplateLayout } from "../registry.js";
import { dateDe } from "./shared.js";

/**
 * Printable membership cards (Wave 13 B12). Both templates are `ephemeral`: the PDF carries a live QR token, so it is rendered
 * on demand by `GET .../card.pdf` / `POST /member-cards/print` (no storage, no quota, `Cache-Control: no-store`) and never filed.
 * Who may ask is decided by those routes; the registry entry only describes the layout.
 */

interface CardData {
  name: string;
  memberNumber: string | null;
  category: string | null;
  validUntil: string | null;
  token: string;
  initials: string;
  photo: Buffer | null;
  layout: "card" | "a4";
}

async function photoOf(clubId: string, row: { id: string; photoKey: string | null }): Promise<Buffer | null> {
  if (!row.photoKey || !(await photoConsentGranted(clubId, row.id))) return null;
  const file = await readRegisteredFile(clubId, row.photoKey, MAX_PHOTO_BYTES);
  return file && (file.mimeType === "image/png" || file.mimeType === "image/jpeg") ? file.buffer : null;
}

const cardParams = z.object({ clubMemberId: z.uuid(), layout: z.enum(["card", "a4"]).default("card") }).strict();

export const mitgliedsausweisTemplate = defineTemplate({
  id: "mitgliedsausweis",
  version: 1,
  label: "Mitgliedsausweis (druckbar)",
  description: "Der Ausweis als Karte (85,6 x 54 mm) oder auf A4 mit QR-Code. Wird nicht gespeichert, der QR-Code ist ein signierter Token.",
  destination: "ephemeral",
  permission: "member_cards:manage",
  docType: "mitgliedsausweis",
  sensitive: true,
  sync: true,
  paramsSchema: cardParams,
  authorize: async (actor) => {
    if (actor.isGuest || !hasClubPermission(actor.roleTypes, "member_cards:manage")) throw new ForbiddenError("Missing member_cards:manage permission");
  },
  build: async (clubId, params) => {
    const row = await loadMemberRow(clubId, params.clubMemberId);
    if (!row) throw new NotFoundError("Member not found");
    const card = await findCardOf(row.id);
    if (!card || cardState(card, row).state !== "gueltig") throw new NotFoundError("No valid card");
    const data: CardData = {
      name: row.displayName,
      memberNumber: row.memberNumber,
      category: await categoryNameOf(row.categoryId),
      validUntil: card.validUntil,
      token: signCardToken(card).token,
      initials: initialsOf(row.displayName),
      photo: await photoOf(clubId, row),
      layout: params.layout,
    };
    return { data, title: "Mitgliedsausweis", filename: "mitgliedsausweis.pdf" };
  },
  layout: (built): TemplateLayout => {
    const d = built.data as CardData;
    const rows: Array<[string, string]> = [["Name", d.name], ["Mitglieds-Nr.", d.memberNumber ?? "-"], ["Kategorie", d.category ?? "-"], ...(d.validUntil ? ([["Gültig bis", dateDe(d.validUntil)]] as Array<[string, string]>) : [])];
    if (d.layout === "card") {
      return { format: "card", title: built.title, blocks: [{ type: "keyValue", rows }, { type: "qr", payload: d.token }, { type: "photo", image: d.photo, initials: d.initials }] };
    }
    return {
      format: "a4",
      title: built.title,
      blocks: [
        { type: "heading", text: "Mitgliedsausweis" },
        { type: "photo", image: d.photo, initials: d.initials, size: 90 },
        { type: "keyValue", rows },
        { type: "qr", payload: d.token, size: 170, caption: "Zur Kontrolle vorzeigen" },
        { type: "paragraph", text: "Der Ausweis gilt nur, solange die Mitgliedschaft besteht. Die Gültigkeit wird bei der Kontrolle online geprüft; ein Ausdruck oder Screenshot ersetzt das nicht." },
      ],
    };
  },
});

interface SheetData {
  cards: Array<{ name: string; memberNumber: string | null; category: string | null; token: string }>;
  skipped: number;
}

export const MAX_SHEET_CARDS = 40;

export const ausweisSammeldruckTemplate = defineTemplate({
  id: "ausweis-sammeldruck",
  version: 1,
  label: "Ausweise Sammeldruck",
  description: "Mehrere Ausweise mit QR-Code auf A4 zum Ausschneiden (ohne Foto). Fehlende Ausweise werden ausgestellt, Personen ohne gültige Mitgliedschaft übersprungen.",
  destination: "ephemeral",
  permission: "member_cards:manage",
  docType: "ausweis_sammeldruck",
  sensitive: true,
  sync: true,
  paramsSchema: z.object({ clubMemberIds: z.array(z.uuid()).min(1).max(MAX_SHEET_CARDS) }).strict(),
  authorize: async (actor) => {
    if (actor.isGuest || !hasClubPermission(actor.roleTypes, "member_cards:manage")) throw new ForbiddenError("Missing member_cards:manage permission");
  },
  build: async (clubId, params) => {
    const cards: SheetData["cards"] = [];
    let skipped = 0;
    for (const id of [...new Set(params.clubMemberIds)]) {
      const row = await loadMemberRow(clubId, id);
      if (!row) {
        skipped += 1;
        continue;
      }
      const card = await db.transaction((tx) => ensureCard(tx, clubId, row.id, null));
      if (cardState(card, row).state !== "gueltig") {
        skipped += 1;
        continue;
      }
      cards.push({ name: row.displayName, memberNumber: row.memberNumber, category: await categoryNameOf(row.categoryId), token: signCardToken(card).token });
    }
    if (cards.length === 0) throw new NotFoundError("No valid card to print");
    const data: SheetData = { cards, skipped };
    return { data, title: "Mitgliedsausweise", filename: "mitgliedsausweise.pdf" };
  },
  layout: (built): TemplateLayout => {
    const d = built.data as SheetData;
    return {
      format: "a4",
      title: built.title,
      blocks: [
        { type: "heading", text: "Mitgliedsausweise" },
        { type: "paragraph", text: `${d.cards.length} Ausweise${d.skipped > 0 ? `, ${d.skipped} ohne gültige Mitgliedschaft übersprungen` : ""}. Die Gültigkeit wird bei der Kontrolle online geprüft.` },
        ...d.cards.flatMap((c): TemplateLayout["blocks"] => [
          { type: "keyValue", rows: [["Name", c.name], ["Mitglieds-Nr.", c.memberNumber ?? "-"], ["Kategorie", c.category ?? "-"]] },
          { type: "qr", payload: c.token, size: 100 },
          { type: "spacer", height: 6 },
        ]),
      ],
    };
  },
});
