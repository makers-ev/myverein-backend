import type { Context } from "hono";

import { dpaRequired, dpaStatusOf } from "../lib/dpa.js";
import { AppError } from "../lib/errors.js";

/**
 * `dpaGate` (Wave 10 B10), run by `clubGuard` right after it resolved the club. With `DPA_REQUIRED=true` a club that has not accepted
 * the current processor agreement within the grace period gets `403 DPA_REQUIRED` on every WRITING request. Reading, the `/dpa/*`
 * routes and the rights of data subjects (export, erasure requests, revoking a consent) and the self-service writes of the person themself (see `EXEMPT`) are never locked.
 */
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const EXEMPT: RegExp[] = [
  /^(?:POST|GET|PUT|PATCH|DELETE) \/dpa(?:\/|$)/,
  /\/data-export$/,
  /\/erasure(?:-request|\/plan|\/execute)$/,
  /^(?:POST|PATCH) \/data-subject-requests/,
  /^DELETE \/club-members\/[^/]+\/consents\/[^/]+$/,
  // Self-service of the person themself (and their guardian) never depends on the club's contract with us:
  /^PATCH \/club-members\/me$/, // own master data (rectification, Art. 16)
  /^PUT \/club-members\/[^/]+\/visibility$/, // who may see the own contact data
  /^DELETE \/club-members\/me\/photo$/, // own photo removal
  /^POST \/club-exit-requests$/, // the own cancellation (Kuendigung must always reach the club)
  /^POST \/club-exit-requests\/[^/]+\/withdraw$/, // withdrawing it again
  /^DELETE \/absences\/[^/]+$/, // withdrawing an own absence report
  /^DELETE \/guardian\/wards\/[^/]+\/absences\/[^/]+$/, // ... by the guardian
  /^(?:PUT|PATCH|POST|DELETE) \/notification-preferences/, // own notification settings
  /^(?:POST|DELETE) \/push-tokens/, // own devices
];

export async function dpaGate(c: Context, clubId: string): Promise<void> {
  if (!dpaRequired() || !WRITE_METHODS.has(c.req.method)) return;
  const key = `${c.req.method} ${c.req.path}`;
  if (EXEMPT.some((re) => re.test(key))) return;
  const { status } = await dpaStatusOf(clubId);
  if (status.blocked) {
    throw new AppError("FORBIDDEN", 403, "The processor agreement (AV-Vertrag) has to be accepted by the club owner before data can be changed", {
      code: "DPA_REQUIRED",
      details: { code: "dpa_required", version: status.version, deadline: status.deadline },
    });
  }
}
