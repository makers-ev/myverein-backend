// Central branding config for this backend, same idea as the website
// templates' `project.config.json` (see ADR-010) -- a plain `.ts` module
// here instead of JSON, since this repo's Node-ESM + tsx runtime needs an
// import attribute for JSON imports that plain TS modules don't.
export const appName = "<app-name>";
export const author = "LPJ IT-Solutions";
export const authorUrl = "https://github.com/lpj-app";
export const primaryColor = "#1e293b";
