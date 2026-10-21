import { BUILT_IN_CONTRIBUTORS } from "./contributors.js";
import { privacyContributors, registerContributor } from "./registry.js";

/**
 * Registers the built-in contributors once. A later wave adds its contributor to `BUILT_IN_CONTRIBUTORS` (or calls
 * `registerContributor` itself before the first export / erasure) when it introduces a table with a personal reference.
 */
let ready = false;
export function ensureContributors(): void {
  if (ready) return;
  ready = true;
  for (const c of BUILT_IN_CONTRIBUTORS) registerContributor(c);
}

export function contributors() {
  ensureContributors();
  return privacyContributors();
}
