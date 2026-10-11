import type { WifiSecurity } from "../db/schema/location-wifi.js";

/** Escapes the characters that have a meaning in the `WIFI:` QR payload (backslash, semicolon, comma, colon, quote). */
function escapeWifiField(value: string): string {
  const escaped = value.replace(/([\\;,:"])/g, "\\$1");
  // An all-hex value would be read as a raw hex key/SSID by the scanner; the spec wants it quoted to mean literal text.
  return /^[0-9a-fA-F]+$/.test(value) ? `"${escaped}"` : escaped;
}

/**
 * Payload of the de-facto standard WLAN QR code (`WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;;`) scanned by iOS and
 * Android cameras. WPA3 is announced as `SAE` (Android 10+ / iOS 16+); an open network carries no password.
 */
export function wifiQrPayload(network: { ssid: string; password: string; security: string }): string {
  const security = network.security as WifiSecurity;
  const ssid = escapeWifiField(network.ssid);
  if (security === "open") return `WIFI:T:nopass;S:${ssid};;`;
  const type = security === "wep" ? "WEP" : security === "wpa3" ? "SAE" : "WPA";
  return `WIFI:T:${type};S:${ssid};P:${escapeWifiField(network.password)};;`;
}
