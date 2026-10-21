import type { Context } from "hono";

import { dpaRequired, dpaStatusOf } from "../lib/dpa.js";
import { AppError } from "../lib/errors.js";

/**
 * `dpaGate` (Wave 10 B10), run by `clubGuard` right after it resolved the club. With `DPA_REQUIRED=true` a club that has not accepted
 * the current processor agreement within the grace period gets `403 DPA_REQUIRED` on every WRITING request. Reading, the `/dpa/*`
 * routes and the rights of data subjects (export, erasure requests, revoking a consent) are never locked.
 */
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const EXEMPT: RegExp[] = [
  /^(?:POST|GET|PUT|PATCH|DELETE) \/dpa(?:\/|$)/,
  /\/data-export$/,
  /\/erasure(?:-request|\/plan|\/execute)$/,
  /^(?:POST|PATCH) \/data-subject-requests/,
  /^DELETE \/club-members\/[^/]+\/consents\/[^/]+$/,
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
