import { eq } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { MAX_LOGO_BYTES, readRegisteredFile } from "./media.js";
import type { PdfBranding } from "./pdf/engine.js";

/** Neutral look of a club that has not set any branding (the product blue). */
export const DEFAULT_PRIMARY_COLOR = "#2c4870";
export const DEFAULT_ACCENT_COLOR = "#2c4870";

/**
 * Branding of generated documents (Wave 13 B7): colours, letterhead lines and the logo of the club. The logo is read through
 * the media layer and only used if it is a PNG or JPEG (never anything else); an unreadable logo is skipped, never an error.
 */
export async function loadBranding(clubId: string): Promise<PdfBranding> {
  const [[club], [settings]] = await Promise.all([
    db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId)).limit(1),
    db.select().from(clubSettings).where(eq(clubSettings.clubId, clubId)).limit(1),
  ]);
  let logo: Buffer | null = null;
  if (settings?.brandLogoKey) {
    const file = await readRegisteredFile(clubId, settings.brandLogoKey, MAX_LOGO_BYTES);
    if (file && (file.mimeType === "image/png" || file.mimeType === "image/jpeg")) logo = file.buffer;
  }
  const lines = [settings?.letterheadAddress, settings?.letterheadRegister, settings?.letterheadRepresentatives, settings?.letterheadContact].flatMap((v) => (v ? v.split("\n") : [])).map((l) => l.trim()).filter((l) => l !== "");
  return {
    clubName: club?.name ?? "",
    primaryColor: settings?.brandPrimaryColor ?? DEFAULT_PRIMARY_COLOR,
    accentColor: settings?.brandAccentColor ?? DEFAULT_ACCENT_COLOR,
    logo,
    letterhead: lines,
    footer: settings?.letterheadFooter ?? null,
  };
}
