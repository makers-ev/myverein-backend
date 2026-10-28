import { getTemplate, registerTemplate } from "../registry.js";
import { bestaetigungsprotokollTemplate } from "./acknowledgements.js";
import { versammlungEinladungTemplate, versammlungProtokollTemplate } from "./assembly-documents.js";
import { brandingTestTemplate } from "./branding-test.js";
import { anwesenheitslisteTemplate, teilnehmerlisteTemplate } from "./event-lists.js";
import { aufnahmeBelegTemplate, kuendigungsbestaetigungTemplate, mitgliedsbestaetigungTemplate } from "./member-documents.js";
import { ausweisSammeldruckTemplate, mitgliedsausweisTemplate } from "./member-cards.js";
import { jahresberichtTemplate, mitgliederlisteTemplate } from "./reports.js";

/** Registers the built-in templates once (called by the entry points via `registerAllJobs` and by the generation routes). */
export function registerBuiltinTemplates(): void {
  for (const template of [brandingTestTemplate, aufnahmeBelegTemplate, mitgliedsbestaetigungTemplate, kuendigungsbestaetigungTemplate, mitgliederlisteTemplate, jahresberichtTemplate, versammlungEinladungTemplate, versammlungProtokollTemplate, anwesenheitslisteTemplate, teilnehmerlisteTemplate, bestaetigungsprotokollTemplate, mitgliedsausweisTemplate, ausweisSammeldruckTemplate]) {
    if (!getTemplate(template.id)) registerTemplate(template);
  }
}
