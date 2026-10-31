import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { buildXlsx, columnLetter, xmlEscape } from "./xlsx.js";

const sheetOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);

describe("buildXlsx", () => {
  it("builds a valid workbook without rows", () => {
    const files = unzipSync(buildXlsx("Stundenbericht", []));
    expect(Object.keys(files)).toContain("xl/worksheets/sheet1.xml");
    expect(strFromU8(files["xl/worksheets/sheet1.xml"]!)).toContain("<sheetData></sheetData>");
  });

  it("strips characters XML cannot carry, keeps unicode, escapes markup and neutralises formulas", () => {
    const sheet = sheetOf(buildXlsx("S", [["a\u0000b\u0008c￾d￿", "Ünïcödé \u{1F600} ß 日本", "<b>&\"x\"</b>", "=1+1", "@SUM(1)", "+1", "-1", { text: "lone\uD800", bold: true }, 1.5, null, ""]]));
    expect(sheet).toContain("abcd");
    expect(sheet).toContain("Ünïcödé \u{1F600} ß 日本");
    expect(sheet).toContain("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
    for (const text of ["'=1+1", "'@SUM(1)", "'+1", "'-1"]) expect(sheet).toContain(text);
    expect(sheet).not.toMatch(/<f>/);
    expect(sheet).toContain("lone</t>");
    expect(sheet).toContain("<v>1.5</v>");
    // eslint-disable-next-line no-control-regex
    expect(sheet).not.toMatch(/[\u0000-\u0008￾￿]/);
  });

  it("names columns past Z and escapes the sheet name", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(xmlEscape("a\"<")).toBe("a&quot;&lt;");
    expect(strFromU8(unzipSync(buildXlsx('A"B', []))["xl/workbook.xml"]!)).toContain('name="A&quot;B"');
  });
});
