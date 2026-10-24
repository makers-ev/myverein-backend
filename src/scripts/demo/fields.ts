import { db } from "../../db/client.js";
import { memberFieldDefinitions } from "../../db/schema/forms.js";
import { memberFieldVisibility } from "../../db/schema/privacy.js";
import { writeAudit } from "../../lib/audit.js";
import { writeValues } from "../../lib/custom-fields.js";
import { accountOf, clubMemberOf, shiftDays, yearsAgo, type DemoCtx } from "./context.js";

const SIZES = ["116", "128", "140", "152", "XS", "S", "M", "L", "XL", "XXL"].map((v) => ({ value: v.toLowerCase(), label: v }));

interface DefSpec {
  key: string;
  label: string;
  fieldType: string;
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
  visibleTo: "vorstand" | "funktionstraeger" | "mitglied";
  editableBy: "vorstand" | "self";
  sensitive?: boolean;
  sortOrder: number;
}

const DEFINITIONS: DefSpec[] = [
  { key: "shirt_size", label: "Trikot-/T-Shirt-Größe", fieldType: "select", options: SIZES, helpText: "Für Vereinskleidung und Trikots.", visibleTo: "funktionstraeger", editableBy: "self", sortOrder: 10 },
  { key: "allergies", label: "Allergien und Unverträglichkeiten", fieldType: "textarea", helpText: "Nur das Nötigste, keine Diagnosen. Sichtbar nur für den Vorstand.", visibleTo: "vorstand", editableBy: "self", sensitive: true, sortOrder: 20 },
  {
    key: "trainer_license",
    label: "Trainerlizenz",
    fieldType: "credential",
    options: [
      { value: "c", label: "C-Lizenz" },
      { value: "b", label: "B-Lizenz" },
      { value: "a", label: "A-Lizenz" },
    ],
    helpText: "Qualifikation mit Gültigkeit; der Verein erinnert vor Ablauf.",
    visibleTo: "funktionstraeger",
    editableBy: "vorstand",
    sortOrder: 30,
  },
  { key: "first_aid", label: "Erste-Hilfe-Kurs", fieldType: "credential", helpText: "Gültig laut Kursbescheinigung.", visibleTo: "funktionstraeger", editableBy: "vorstand", sortOrder: 40 },
  {
    key: "swim_badge",
    label: "Schwimmabzeichen",
    fieldType: "select",
    options: [
      { value: "seepferdchen", label: "Seepferdchen" },
      { value: "bronze", label: "Bronze" },
      { value: "silber", label: "Silber" },
      { value: "gold", label: "Gold" },
    ],
    visibleTo: "mitglied",
    editableBy: "vorstand",
    sortOrder: 50,
  },
  { key: "driver_ready", label: "Fahrdienst für Auswärtsspiele", fieldType: "checkbox", visibleTo: "mitglied", editableBy: "self", sortOrder: 60 },
  {
    key: "volunteer_interest",
    label: "Ich helfe gern bei ...",
    fieldType: "multiselect",
    options: [
      { value: "events", label: "Veranstaltungen" },
      { value: "jugend", label: "Jugendarbeit" },
      { value: "technik", label: "Technik und Platzpflege" },
      { value: "kasse", label: "Kasse und Verwaltung" },
    ],
    visibleTo: "vorstand",
    editableBy: "self",
    sortOrder: 70,
  },
];

const cred = (today: string, level: string | undefined, obtainedYearsAgo: number, validUntilDays: number) => ({
  valid: true,
  ...(level ? { level } : {}),
  obtainedOn: yearsAgo(today, obtainedYearsAgo),
  validUntil: shiftDays(today, validUntilDays),
});

/** Custom fields (member data the club defines itself), qualifications as credentials with valid / expiring / expired dates, and per-member visibility. */
export async function seedCustomFields(ctx: DemoCtx): Promise<Record<string, string>> {
  const board = accountOf(ctx, "vorsitz");
  const ids: Record<string, string> = {};
  for (const d of DEFINITIONS) {
    const [row] = await db
      .insert(memberFieldDefinitions)
      .values({ clubId: ctx.clubId, key: d.key, label: d.label, fieldType: d.fieldType, options: d.options ?? null, helpText: d.helpText ?? null, visibleTo: d.visibleTo, editableBy: d.editableBy, sensitive: d.sensitive ?? false, sortOrder: d.sortOrder })
      .returning({ id: memberFieldDefinitions.id });
    ids[d.key] = row!.id;
    await writeAudit(db, { eventType: "member_field.create", subjectId: row!.id, actorUserId: board.userId, payload: { clubId: ctx.clubId, createdBy: board.memberId, key: d.key, sensitive: d.sensitive ?? false } });
  }

  const t = ctx.today;
  const values: Array<[string, string, unknown, ("guardian" | null)?]> = [
    ["trainer", "shirt_size", "l"],
    ["trainer2", "shirt_size", "m"],
    ["abtleit", "shirt_size", "m"],
    ["stefan", "shirt_size", "xl"],
    ["julia", "shirt_size", "s"],
    ["murat", "shirt_size", "l"],
    ["noah", "shirt_size", "140", "guardian"],
    ["mia", "shirt_size", "128", "guardian"],
    ["finn", "shirt_size", "128", "guardian"],
    ["hannah", "shirt_size", "s"],
    ["noah", "allergies", "Erdnussallergie, Notfallspray liegt im Rucksack.", "guardian"],
    ["leon", "allergies", "Laktoseintoleranz."],
    ["lina", "allergies", "Heuschnupfen im Frühjahr.", "guardian"],
    // Qualifications: valid, expiring soon, expired
    ["trainer", "trainer_license", cred(t, "b", 6, 420)],
    ["trainer2", "trainer_license", cred(t, "c", 3, 38)],
    ["abtleit", "trainer_license", cred(t, "a", 9, -20)],
    ["peter", "trainer_license", cred(t, "c", 2, 400)],
    ["trainer", "first_aid", cred(t, undefined, 1, 270)],
    ["anja", "first_aid", cred(t, undefined, 2, 25)],
    ["schrift", "first_aid", cred(t, undefined, 3, -100)],
    ["beisitz", "first_aid", cred(t, undefined, 1, 500)],
    ["noah", "swim_badge", "bronze", "guardian"],
    ["mia", "swim_badge", "seepferdchen", "guardian"],
    ["finn", "swim_badge", "seepferdchen", "guardian"],
    ["leon", "swim_badge", "silber"],
    ["hannah", "swim_badge", "gold"],
    ["sophie", "swim_badge", "bronze"],
    ["stefan", "driver_ready", true],
    ["julia", "driver_ready", true],
    ["peter", "driver_ready", true],
    ["mitglied", "driver_ready", true],
    ["mitglied", "volunteer_interest", ["jugend", "events"]],
    ["julia", "volunteer_interest", ["events"]],
    ["stefan", "volunteer_interest", ["technik", "kasse"]],
  ];
  for (const [who, field, value, via] of values) {
    await writeValues(db, clubMemberOf(ctx, who), board.memberId, [{ fieldId: ids[field]!, value }], via ?? null);
  }
  await writeAudit(db, { eventType: "member_field.write", subjectId: ctx.clubId, actorUserId: board.userId, payload: { clubId: ctx.clubId, changedBy: board.memberId, fieldIds: Object.values(ids), via: "board" } });

  // Per-member visibility of contact data: the default (no row) is "nur_vorstand".
  type Level = "nur_vorstand" | "trainer" | "mitglieder";
  const visibility: Array<[string, Partial<Record<"phone" | "email" | "address" | "photo", Level>>]> = [
    ["vorsitz", { phone: "mitglieder", email: "mitglieder" }],
    ["trainer", { phone: "mitglieder", email: "mitglieder" }],
    ["mitglied", { phone: "mitglieder", email: "trainer", address: "nur_vorstand", photo: "mitglieder" }],
    ["stefan", { phone: "trainer", email: "trainer" }],
    ["julia", { phone: "mitglieder", email: "mitglieder", address: "nur_vorstand" }],
    ["anja", { phone: "trainer", address: "nur_vorstand" }],
    ["jugend", { phone: "nur_vorstand", email: "nur_vorstand", address: "nur_vorstand", photo: "nur_vorstand" }],
  ];
  for (const [who, fields] of visibility) {
    for (const [field, level] of Object.entries(fields)) {
      await db.insert(memberFieldVisibility).values({ clubMemberId: clubMemberOf(ctx, who), field, level: level!, updatedBy: board.userId });
    }
    await writeAudit(db, { eventType: "member_field_visibility.update", subjectId: clubMemberOf(ctx, who), actorUserId: board.userId, payload: { clubId: ctx.clubId, changedBy: board.memberId, fields: Object.keys(fields) } });
  }
  ctx.log(`${DEFINITIONS.length} Zusatzfelder, ${values.length} Werte (inkl. Qualifikationen), ${visibility.length} Sichtbarkeitseinstellungen`);
  return ids;
}
