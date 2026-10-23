import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { NotFoundError } from "../lib/errors.js";
import { selfOnlineAttendance } from "../lib/meeting-online.js";
import type { ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { loadClubMeeting } from "../lib/meeting-access.js";

/**
 * Online part of a hybrid / virtual meeting (Wave 11 B10), mounted into `/meetings`. An invited account joins and leaves by itself
 * (`check_in_method = self_online`); everything else (members without an account, the room) stays with `PATCH /meetings/:id/attendance`.
 */
export const meetingOnlineRoutes = new Hono<ClubEnv>();

const limit = rateLimit({ windowMs: 60_000, max: 30, key: (c) => `meeting-online:${c.get("user")?.id ?? "anonymous"}` });

async function run(c: Context<ClubEnv>, join: boolean) {
  const id = c.req.param("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) throw new NotFoundError("Meeting not found");
  await loadClubMeeting(c, id);
  const result = await selfOnlineAttendance({ clubId: c.get("clubId"), meetingId: id, accountMemberId: c.get("membership").id, userId: c.get("user").id, join });
  return c.json({ data: result });
}

meetingOnlineRoutes.post("/:id/online/join", limit, (c) => run(c, true));
meetingOnlineRoutes.post("/:id/online/leave", limit, (c) => run(c, false));
