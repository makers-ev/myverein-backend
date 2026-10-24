import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { ballotOptions, ballotVotesOpen, ballotVotesSecret, ballots } from "../db/schema/assembly.js";

/** Migration 0052: a vote can only point at an option of its own ballot. */
let club: string;
let userId: string;
let ballotA: string;
let ballotB: string;
let optionOfB: string;

beforeAll(async () => {
  const email = `w11i-${Date.now()}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: "W11I" } });
  userId = created.id;
  club = (await auth.api.createOrganization({ body: { name: `Integrity ${Date.now()}`, slug: `w11i-${Date.now()}`, userId } }))!.id;
  const make = async () => {
    const [b] = await db.insert(ballots).values({ clubId: club, title: "B", status: "open", mode: "circular", kind: "resolution", topic: "allgemein", maxChoices: 1, createdBy: userId }).returning({ id: ballots.id });
    return b!.id;
  };
  ballotA = await make();
  ballotB = await make();
  [{ id: optionOfB }] = (await db.insert(ballotOptions).values({ ballotId: ballotB, position: 1, label: "Ja", kind: "yes" }).returning({ id: ballotOptions.id })) as [{ id: string }];
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(user).where(eq(user.id, userId));
  await closeDatabase();
});

describe("votes and options", () => {
  it("refuses an open or secret vote for an option of another ballot", async () => {
    await expect(db.insert(ballotVotesSecret).values({ ballotId: ballotA, optionId: optionOfB })).rejects.toThrow();
    await expect(db.insert(ballotVotesOpen).values({ ballotId: ballotA, optionId: optionOfB })).rejects.toThrow();
    await db.insert(ballotVotesSecret).values({ ballotId: ballotB, optionId: optionOfB });
  });
});
