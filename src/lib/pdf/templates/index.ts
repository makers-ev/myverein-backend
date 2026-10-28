import { getTemplate, registerTemplate } from "../registry.js";
import { brandingTestTemplate } from "./branding-test.js";
import { aufnahmeBelegTemplate, kuendigungsbestaetigungTemplate, mitgliedsbestaetigungTemplate } from "./member-documents.js";

/** Registers the built-in templates once (called by the entry points via `registerAllJobs` and by the generation routes). */
export function registerBuiltinTemplates(): void {
  for (const template of [brandingTestTemplate, aufnahmeBelegTemplate, mitgliedsbestaetigungTemplate, kuendigungsbestaetigungTemplate]) {
    if (!getTemplate(template.id)) registerTemplate(template);
  }
}
