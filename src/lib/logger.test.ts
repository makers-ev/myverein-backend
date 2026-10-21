import { describe, expect, it } from "vitest";

import { serializeError } from "./logger.js";

/** Review L1: errors of the database layer must not carry the bound values (absence notes, proof sources) into the logs. */
describe("serializeError", () => {
  it("drops bound parameters, also from the message, the stack and the cause", () => {
    const cause = Object.assign(new Error("connection terminated"), { params: ["Grippe seit Montag"] });
    const err = Object.assign(new Error('Failed query: insert into "absence_reports" ("note") values ($1)\nparams: Grippe seit Montag', { cause }), { query: 'insert into "absence_reports" ("note") values ($1)', params: ["Grippe seit Montag"] });
    const out = serializeError(err);
    const text = JSON.stringify(out);
    expect(text).not.toContain("Grippe");
    expect(out).not.toHaveProperty("params");
    expect(out).not.toHaveProperty("query");
    expect(String(out.message)).toContain("Failed query: insert into");
  });

  it("keeps ordinary errors readable", () => {
    const out = serializeError(new TypeError("boom"));
    expect(out).toMatchObject({ type: "TypeError", message: "boom" });
  });
});
