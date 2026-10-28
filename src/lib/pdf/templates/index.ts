import { getTemplate, registerTemplate } from "../registry.js";
import { brandingTestTemplate } from "./branding-test.js";

/** Registers the built-in templates once (called by the entry points via `registerAllJobs` and by the generation routes). */
export function registerBuiltinTemplates(): void {
  for (const template of [brandingTestTemplate]) {
    if (!getTemplate(template.id)) registerTemplate(template);
  }
}
