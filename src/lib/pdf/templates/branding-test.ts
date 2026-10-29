import { z } from "zod";

import { hasClubPermission } from "../../club-permissions.js";
import { ForbiddenError } from "../../errors.js";
import { defineTemplate } from "../registry.js";

/** Test page of the branding (Wave 13 B7): shows letterhead, colours, a table and a QR code with dummy data; nothing is stored. */
export const brandingTestTemplate = defineTemplate({
  id: "branding-test",
  version: 1,
  label: "Testseite für das Vereins-Branding",
  description: "Zeigt Logo, Farben und Briefkopf des Vereins mit Beispieldaten. Wird nicht gespeichert.",
  destination: "ephemeral",
  permission: "branding:write",
  docType: "branding_test",
  sensitive: false,
  sync: true,
  paramsSchema: z.object({}).strict(),
  authorize: async (actor) => {
    if (!hasClubPermission(actor.roleTypes, "branding:write")) throw new ForbiddenError("Missing branding:write permission");
  },
  build: async () => ({ data: { sample: true }, title: "Testseite", filename: "branding-testseite.pdf" }),
  layout: (built) => ({
    format: "a4" as const,
    title: built.title,
    blocks: [
      { type: "heading", text: "Testseite für Ihr Vereins-Branding" },
      { type: "paragraph", text: "So sehen Dokumente aus, die MyVerein für Ihren Verein erzeugt: Briefkopf mit Logo oben, Ihre Farben in Überschriften und Tabellen, Fußzeile mit Seitenzahl. Die Angaben unten sind Beispieldaten." },
      { type: "keyValue", rows: [["Name", "Erika Mustermann"], ["Mitgliedsnummer", "M-0001"], ["Eintritt", "01.01.2024"], ["Sonderzeichen", "Müller-Lüdenscheidt, Straße, Café, Ærø"]] },
      { type: "heading", text: "Beispieltabelle", level: 2 },
      {
        type: "table",
        columns: [{ title: "Nr.", width: 1 }, { title: "Name", width: 3 }, { title: "Abteilung", width: 2 }],
        rows: [["M-0001", "Erika Mustermann", "Fußball"], ["M-0002", "Max Beispiel", "Tennis"], ["M-0003", "Jörg Schröder", "Turnen"]],
      },
      { type: "qr", payload: "https://example.org/myverein-test", caption: "Beispiel-QR-Code" },
      { type: "signatureLine", label: "Ort, Datum, Unterschrift" },
    ],
  }),
});
