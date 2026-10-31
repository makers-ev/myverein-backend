import { describe, expect, it } from "vitest";

import { CsvLimitError, buildCsv, CSV_BOM, csvCell, detectDelimiter, escapeFormula, parseCsv, parseFlexibleDate, unescapeFormula } from "./member-csv.js";
import { createImportToken, importFingerprint, importTokenDuplicates, importTokenId, isPlausibleEmail, mapColumns, verifyImportToken } from "./member-import.js";
import { wifiQrPayload } from "./wifi-qr.js";

describe("csv parsing", () => {
  it("detects ; , and tab delimiters outside of quotes", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
    expect(detectDelimiter('"a;b;c",d,e\n')).toBe(",");
    expect(detectDelimiter("single")).toBe(";");
  });

  it("parses quotes, embedded delimiters and newlines, escaped quotes, CRLF, BOM and blank lines", () => {
    const text = `${CSV_BOM}Name;Notiz\r\n"Muster; Max";"Zeile1\nZeile2"\r\n\r\n"Sagt ""Hallo""";x\r\n`;
    expect(parseCsv(text, ";")).toEqual([["Name", "Notiz"], ["Muster; Max", "Zeile1\nZeile2"], ['Sagt "Hallo"', "x"]]);
  });

  it("keeps empty cells and handles a missing trailing newline", () => {
    expect(parseCsv("a;b;c\n1;;3", ";")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a;b\n"open;x', ";")).toThrow();
  });

  it("parses German and ISO dates strictly", () => {
    expect(parseFlexibleDate("1.2.1990")).toBe("1990-02-01");
    expect(parseFlexibleDate("31.12.2000")).toBe("2000-12-31");
    expect(parseFlexibleDate("2000-02-29")).toBe("2000-02-29");
    expect(parseFlexibleDate("2001-02-29")).toBeNull();
    expect(parseFlexibleDate("31.02.2000")).toBeNull();
    expect(parseFlexibleDate("morgen")).toBeNull();
  });
});

describe("csv writing", () => {
  it("neutralises formula starters and round-trips them on import", () => {
    for (const bad of ["=1+1", "+49 170 1234", "-5", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(escapeFormula(bad)).toBe(`'${bad}`);
      expect(unescapeFormula(escapeFormula(bad))).toBe(bad);
    }
    expect(escapeFormula("Max")).toBe("Max");
    expect(escapeFormula("a=b")).toBe("a=b");
    expect(unescapeFormula("'Hallo")).toBe("'Hallo");
  });

  it("quotes cells with delimiter, quote or line break and escapes formulas before quoting", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('say "x"')).toBe('"say ""x"""');
    expect(csvCell("l1\nl2")).toBe('"l1\nl2"');
    expect(csvCell("=HYPERLINK(\"http://evil\";\"x\")")).toBe(`"'=HYPERLINK(""http://evil"";""x"")"`);
    expect(csvCell(null)).toBe("");
    expect(csvCell(7)).toBe("7");
  });

  it("builds an Excel-DE file: BOM, semicolons, CRLF", () => {
    const csv = buildCsv(["Name", "Ort"], [["Max", "Köln"], ["=evil", null]]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1)).toBe("Name;Ort\r\nMax;Köln\r\n'=evil;\r\n");
  });
});

describe("column mapping", () => {
  it("recognises German and English headers and maps each field once", () => {
    const cols = mapColumns(["Vorname", "Nachname", "Straße", "PLZ", "E-Mail", "Geburtsdatum", "Eintritt", "Kategorie", "Unbekannt", "Email"]);
    expect(cols.map((c) => c.field)).toEqual(["firstName", "lastName", "street", "postalCode", "contactEmail", "birthDate", "joinedAt", "category", null, null]);
  });

  it("lets an explicit mapping override detection and ignore columns", () => {
    const cols = mapColumns(["Name", "Spalte X", "Ort"], { "Spalte X": "phone", Ort: "ignore" });
    expect(cols.map((c) => c.field)).toEqual(["displayName", "phone", null]);
  });
});

describe("import confirmation token", () => {
  const fp = importFingerprint("a;b\n1;2", {});
  it("verifies only for the same club, user, file and before expiry", () => {
    const now = 1_000_000;
    const { token } = createImportToken("club1", "user1", fp, now);
    expect(verifyImportToken(token, "club1", "user1", fp, now + 1000)).toBe(true);
    expect(verifyImportToken(token, "club2", "user1", fp, now + 1000)).toBe(false);
    expect(verifyImportToken(token, "club1", "user2", fp, now + 1000)).toBe(false);
    expect(verifyImportToken(token, "club1", "user1", importFingerprint("a;b\n1;3", {}), now + 1000)).toBe(false);
    expect(verifyImportToken(token, "club1", "user1", importFingerprint("a;b\n1;2", { defaultCategoryKey: "passiv" }), now + 1000)).toBe(false);
    expect(verifyImportToken(token, "club1", "user1", fp, now + 31 * 60_000)).toBe(false);
  });

  it("rejects tampered and garbage tokens without throwing", () => {
    const { token } = createImportToken("club1", "user1", fp);
    const [payload] = token.split(".");
    for (const bad of ["", "x", "a.b", `${payload}.AAAA`, `${token}.extra`, `${payload}x.${token.split(".")[1]}`]) {
      expect(verifyImportToken(bad, "club1", "user1", fp)).toBe(false);
    }
  });
});

describe("wifi QR payload", () => {
  it("maps the security type to the WIFI: scheme and escapes special characters", () => {
    expect(wifiQrPayload({ ssid: "Vereinsheim", password: "geheim", security: "wpa" })).toBe("WIFI:T:WPA;S:Vereinsheim;P:geheim;;");
    expect(wifiQrPayload({ ssid: "Heim", password: "pw", security: "wpa3" })).toBe("WIFI:T:SAE;S:Heim;P:pw;;");
    expect(wifiQrPayload({ ssid: "Alt", password: "12345", security: "wep" })).toBe('WIFI:T:WEP;S:Alt;P:"12345";;');
    // all-hex SSIDs / passwords are quoted so scanners read them as text, not as raw hex keys
    expect(wifiQrPayload({ ssid: "CAFE", password: "deadBEEF", security: "wpa" })).toBe('WIFI:T:WPA;S:"CAFE";P:"deadBEEF";;');
    expect(wifiQrPayload({ ssid: "Gast", password: "ignored", security: "open" })).toBe("WIFI:T:nopass;S:Gast;;");
    expect(wifiQrPayload({ ssid: String.raw`a;b:c,d"e\f`, password: "p;w", security: "wpa" })).toBe(String.raw`WIFI:T:WPA;S:a\;b\:c\,d\"e\\f;P:p\;w;;`);
  });
});

describe("hardening", () => {
  it("checks e-mail plausibility in linear time (no ReDoS)", () => {
    for (const evil of [`a@${".".repeat(200_000)}@`, `${"a@".repeat(100_000)}`, `a@${"a.".repeat(100_000)}`, `${" ".repeat(100_000)}@a.b`]) {
      const started = Date.now();
      expect(isPlausibleEmail(evil)).toBe(false);
      expect(Date.now() - started).toBeLessThan(200);
    }
    expect(isPlausibleEmail("max.muster@example.com")).toBe(true);
    for (const bad of ["", "a@b", "a@.b", "a@b.", "@b.de", "a b@c.de", "a@@b.de", "a@b..de", `${"a".repeat(320)}@b.de`]) expect(isPlausibleEmail(bad), bad).toBe(false);
  });

  it("stops parsing at the row, column and cell limits", () => {
    expect(() => parseCsv("h\n1\n2\n3\n4", ";", { maxRows: 3 })).toThrow(CsvLimitError);
    expect(parseCsv("h\n1\n2", ";", { maxRows: 3 })).toHaveLength(3);
    expect(() => parseCsv("a;b;c;d", ";", { maxColumns: 3 })).toThrow(CsvLimitError);
    expect(() => parseCsv(`h\n${"x".repeat(50)}`, ";", { maxCell: 10 })).toThrow(CsvLimitError);
    expect(() => parseCsv(`h\n"${"x".repeat(50)}`, ";", { maxCell: 10 })).toThrow(CsvLimitError);
  });

  it("ignores prototype keys in an explicit mapping", () => {
    const cols = mapColumns(["__proto__", "constructor", "toString", "Name"], { phone: "ignore" });
    expect(cols.map((c) => c.field)).toEqual([null, null, null, "displayName"]);
    expect(mapColumns(["hasOwnProperty"], { hasOwnProperty: "bogus" as "ignore" })[0]!.field).toBeNull();
  });

  it("gives every dry run its own token and carries the dry-run duplicate count", () => {
    const fp = importFingerprint("a", {});
    const a = createImportToken("c", "u", fp, Date.now(), 4);
    const b = createImportToken("c", "u", fp, Date.now(), 4);
    expect(a.token).not.toBe(b.token);
    expect(importTokenId(a.token)).not.toBe(importTokenId(b.token));
    expect(importTokenDuplicates(a.token)).toBe(4);
    expect(importTokenDuplicates("garbage")).toBe(0);
  });
});
