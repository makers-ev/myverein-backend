import { db } from "../../db/client.js";
import { inventoryDamageReports, inventoryItems, inventoryLoans } from "../../db/schema/inventory.js";
import { locationLinks } from "../../db/schema/location-links.js";
import { locationWifiNetworks } from "../../db/schema/location-wifi.js";
import { locationKeyHistory, locationKeyHolders, locations } from "../../db/schema/locations.js";
import { accountOf, berlinTime, shiftDays, yearsAgo, type DemoCtx } from "./context.js";

interface LocationSpec {
  key: string;
  name: string;
  address: string;
  lat: string;
  lon: string;
  hours: string;
  contact: string;
  access: string;
}

const LOCATIONS: LocationSpec[] = [
  { key: "heim", name: "Vereinsheim", address: "Sportplatzweg 1, 55555 Wiesbach", lat: "50.123400", lon: "8.567800", hours: "Di und Do 17-22 Uhr, Sa 10-18 Uhr", contact: "Marco Vogel (Platzwart), 0151 5550 9001", access: "Schlüsselkasten links neben der Eingangstür. Den Code erfragen Sie beim Vorstand." },
  { key: "platz", name: "Sportplatz Am Mühlbach", address: "Am Mühlbach 12, 55555 Wiesbach", lat: "50.124900", lon: "8.570100", hours: "täglich 8-21 Uhr (Flutlicht bis 21:30 Uhr)", contact: "Ute Hartmann (Abteilungsleitung Fußball)", access: "Das Tor ist tagsüber offen, abends schließt der letzte Trainer ab." },
  { key: "halle", name: "Turnhalle Grundschule Wiesbach", address: "Schulstraße 4, 55555 Wiesbach", lat: "50.121800", lon: "8.564400", hours: "Mo-Fr 16-21 Uhr nach Belegungsplan", contact: "Hausmeister Schulz, 06123 555 0102", access: "Zugang über den Seiteneingang, der Hausmeister schließt auf." },
  { key: "tennis", name: "Tennisanlage Birkenallee", address: "Birkenallee 20, 55555 Wiesbach", lat: "50.126500", lon: "8.572300", hours: "April bis Oktober täglich 8-21 Uhr", contact: "Frank Bergmann (Abteilungsleitung Tennis)", access: "Zahlenschloss am Eingangstor, der Code kommt per Mitgliederinfo." },
  { key: "lager", name: "Geräteschuppen", address: "Sportplatzweg 1 (hinter dem Vereinsheim)", lat: "50.123300", lon: "8.567900", hours: "nach Absprache", contact: "Marco Vogel", access: "Nur mit Schlüssel (Schlüsselinhaber siehe Standort)." },
];

/** Locations with wifi networks, links per visibility level, key holders and a key handover history. No photos (uploads are skipped). */
export async function seedLocations(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "vorsitz");
  for (const l of LOCATIONS) {
    const [row] = await db
      .insert(locations)
      .values({ clubId: ctx.clubId, name: l.name, address: l.address, latitude: l.lat, longitude: l.lon, openingHours: l.hours, contactPerson: l.contact, accessNote: l.access })
      .returning({ id: locations.id });
    ctx.loc[l.key] = row!.id;
  }
  const L = ctx.loc;
  await db.insert(locationWifiNetworks).values([
    { locationId: L.heim!, label: "Gäste-WLAN", ssid: "SVW-Gast", password: "Sportfreunde2026", security: "wpa", visibility: "gast" },
    { locationId: L.heim!, label: "Mitglieder-WLAN", ssid: "SVW-Mitglieder", password: "Vereinsleben!2026", security: "wpa3", visibility: "mitglied" },
    { locationId: L.heim!, label: "Vorstandsbüro", ssid: "SVW-Vorstand", password: "Nur-Für-Den-Vorstand-1", security: "wpa", visibility: "vorstand" },
    { locationId: L.platz!, label: "Offenes Netz Sportplatz", ssid: "SVW-Platz", password: "", security: "open", visibility: "mitglied" },
  ]);
  await db.insert(locationLinks).values([
    { locationId: L.heim!, title: "Belegungskalender Vereinsheim", url: "https://example.org/belegung", icon: "calendar", visibility: "mitglied" },
    { locationId: L.platz!, title: "Webcam Sportplatz", url: "https://example.org/webcam", icon: "camera", visibility: "gast" },
    { locationId: L.tennis!, title: "Platzreservierung online", url: "https://example.org/tennis-buchen", icon: "calendar", visibility: "gast" },
    { locationId: L.heim!, title: "Notdienst Haustechnik", url: "https://example.org/notdienst", icon: "phone", visibility: "vorstand" },
  ]);

  const holders: Array<{ loc: string; who: string; label: string; daysAgo: number }> = [
    { loc: "heim", who: "trainer", label: "Schlüssel Nr. 1 (Haupteingang)", daysAgo: 700 },
    { loc: "heim", who: "abtleit", label: "Schlüssel Nr. 2 (Haupteingang)", daysAgo: 500 },
    { loc: "heim", who: "schrift", label: "Schlüssel Nr. 3 (Vorstandsbüro)", daysAgo: 300 },
    { loc: "tennis", who: "abtleit2", label: "Zahlenschloss-Code Tor", daysAgo: 400 },
    { loc: "halle", who: "beisitz", label: "Hallenschlüssel", daysAgo: 200 },
    { loc: "lager", who: "trainer", label: "Schuppenschlüssel", daysAgo: 650 },
  ];
  for (const h of holders) {
    const person = accountOf(ctx, h.who);
    await db.insert(locationKeyHolders).values({ locationId: L[h.loc]!, memberId: person.memberId, keyLabel: h.label });
    await db.insert(locationKeyHistory).values({
      locationId: L[h.loc]!,
      action: "issued",
      memberId: person.memberId,
      memberName: person.name,
      keyLabel: h.label,
      note: "Übergabe gegen Unterschrift",
      recordedBy: board.memberId,
      recordedByName: board.name,
      createdAt: new Date(ctx.now.getTime() - h.daysAgo * 86_400_000),
    });
  }
  // A key that came back: the former holder is gone from the member list, the log keeps the name.
  await db.insert(locationKeyHistory).values([
    { locationId: L.heim!, action: "issued", memberId: null, memberName: "Rainer Winter", keyLabel: "Schlüssel Nr. 4", note: "Übergabe gegen Unterschrift", recordedBy: board.memberId, recordedByName: board.name, createdAt: new Date(ctx.now.getTime() - 900 * 86_400_000) },
    { locationId: L.heim!, action: "returned", memberId: null, memberName: "Rainer Winter", keyLabel: "Schlüssel Nr. 4", note: "Nach Ausschluss zurückgegeben, Schloss unverändert", recordedBy: board.memberId, recordedByName: board.name, createdAt: new Date(ctx.now.getTime() - 55 * 86_400_000) },
  ]);
  ctx.log(`${LOCATIONS.length} Standorte mit WLAN, Links, Schlüsselinhabern und Schlüsselverlauf`);
}

interface ItemSpec {
  key: string;
  name: string;
  category: string;
  condition: "gut" | "beschaedigt" | "defekt";
  loc: string;
  valueCents: number;
  acquiredYearsAgo: number;
  interval?: number;
  lastMaintenanceDaysAgo?: number;
}

const ITEMS: ItemSpec[] = [
  { key: "baelle", name: "Spielbälle Größe 5 (12 Stück)", category: "Sportgerät", condition: "gut", loc: "platz", valueCents: 36000, acquiredYearsAgo: 1 },
  { key: "trikots", name: "Trikotsatz Heim (16 Stück)", category: "Textilien", condition: "beschaedigt", loc: "heim", valueCents: 64000, acquiredYearsAgo: 2 },
  { key: "beamer", name: "Beamer Epson EB-W49", category: "Technik", condition: "gut", loc: "heim", valueCents: 54900, acquiredYearsAgo: 3, interval: 365, lastMaintenanceDaysAgo: 300 },
  { key: "maeher", name: "Aufsitzrasenmäher", category: "Platzpflege", condition: "beschaedigt", loc: "lager", valueCents: 189000, acquiredYearsAgo: 5, interval: 180, lastMaintenanceDaysAgo: 200 },
  { key: "zelt", name: "Festzelt 6 x 12 m", category: "Veranstaltung", condition: "gut", loc: "lager", valueCents: 240000, acquiredYearsAgo: 4, interval: 365, lastMaintenanceDaysAgo: 100 },
  { key: "ballmaschine", name: "Tennis-Ballmaschine", category: "Sportgerät", condition: "defekt", loc: "tennis", valueCents: 120000, acquiredYearsAgo: 6 },
  { key: "matten", name: "Turnmatten (8 Stück)", category: "Sportgerät", condition: "gut", loc: "halle", valueCents: 76000, acquiredYearsAgo: 7 },
  { key: "ersthilfe", name: "Erste-Hilfe-Koffer (3 Stück)", category: "Sicherheit", condition: "gut", loc: "heim", valueCents: 9000, acquiredYearsAgo: 2, interval: 365, lastMaintenanceDaysAgo: 380 },
  { key: "pokale", name: "Wanderpokale (Set)", category: "Vereinsbesitz", condition: "gut", loc: "heim", valueCents: 25000, acquiredYearsAgo: 20 },
  { key: "mikro", name: "Mikrofonanlage", category: "Technik", condition: "gut", loc: "heim", valueCents: 42000, acquiredYearsAgo: 4, interval: 730, lastMaintenanceDaysAgo: 400 },
];

/** Inventory with maintenance cycles (due soon, overdue), loans (open, due soon, overdue, returned) and damage reports in every state. */
export async function seedInventory(ctx: DemoCtx): Promise<void> {
  const ids: Record<string, string> = {};
  for (const it of ITEMS) {
    const [row] = await db
      .insert(inventoryItems)
      .values({
        clubId: ctx.clubId,
        name: it.name,
        category: it.category,
        condition: it.condition,
        locationId: ctx.loc[it.loc]!,
        acquisitionValueCents: it.valueCents,
        acquiredAt: yearsAgo(ctx.today, it.acquiredYearsAgo),
        maintenanceIntervalDays: it.interval ?? null,
        lastMaintenanceAt: it.lastMaintenanceDaysAgo === undefined ? null : shiftDays(ctx.today, -it.lastMaintenanceDaysAgo),
      })
      .returning({ id: inventoryItems.id });
    ids[it.key] = row!.id;
  }
  const at = (days: number, hhmm = "18:00") => berlinTime(shiftDays(ctx.today, days), hhmm);
  await db.insert(inventoryLoans).values([
    { itemId: ids.beamer!, memberId: accountOf(ctx, "schrift").memberId, borrowedAt: at(-3), dueAt: at(4), status: "ausgeliehen" },
    { itemId: ids.zelt!, memberId: accountOf(ctx, "abtleit").memberId, borrowedAt: at(-30), dueAt: at(-5), status: "ausgeliehen" },
    { itemId: ids.mikro!, memberId: accountOf(ctx, "mitglied").memberId, borrowedAt: at(-10), dueAt: at(1), status: "ausgeliehen" },
    // Lukas has a second loan that is overdue: "Heute" shows one due soon and one overdue.
    { itemId: ids.baelle!, memberId: accountOf(ctx, "mitglied").memberId, borrowedAt: at(-12), dueAt: at(-2), status: "ausgeliehen" },
    { itemId: ids.ballmaschine!, memberId: accountOf(ctx, "trainer2").memberId, borrowedAt: at(-60), dueAt: at(-50), returnedAt: at(-51), status: "zurueckgegeben" },
    { itemId: ids.baelle!, memberId: accountOf(ctx, "trainer").memberId, borrowedAt: at(-14), dueAt: at(-8), returnedAt: at(-7), status: "zurueckgegeben" },
    { itemId: ids.pokale!, memberId: accountOf(ctx, "stellv").memberId, borrowedAt: at(-120), dueAt: at(-100), returnedAt: at(-99), status: "zurueckgegeben" },
  ]);
  await db.insert(inventoryDamageReports).values([
    { itemId: ids.maeher!, reportedBy: accountOf(ctx, "trainer").memberId, description: "Messer stumpf, Motor stottert im Leerlauf.", status: "in_bearbeitung", createdAt: at(-12) },
    { itemId: ids.ballmaschine!, reportedBy: accountOf(ctx, "abtleit2").memberId, description: "Motor läuft nicht mehr an, vermutlich Kondensator.", status: "gemeldet", createdAt: at(-4) },
    { itemId: ids.trikots!, reportedBy: accountOf(ctx, "abtleit").memberId, description: "Zwei Trikots sind eingerissen.", status: "gemeldet", createdAt: at(-20) },
    { itemId: ids.beamer!, reportedBy: accountOf(ctx, "schrift").memberId, description: "HDMI-Kabel hatte einen Wackelkontakt, wurde ersetzt.", status: "behoben", createdAt: at(-90), resolvedAt: at(-80) },
  ]);
  ctx.log(`${ITEMS.length} Inventargegenstände, 7 Ausleihen (offen/fällig/überfällig/zurückgegeben), 4 Schadensmeldungen`);
}
