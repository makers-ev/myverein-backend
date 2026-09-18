// Central branding config for this backend, same idea as the website
// templates' `project.config.json` (see ADR-010) -- a plain `.ts` module
// here instead of JSON, since this repo's Node-ESM + tsx runtime needs an
// import attribute for JSON imports that plain TS modules don't.
export const appName = "MyVerein";
export const author = "LPJ IT-Solutions";
export const authorUrl = "https://github.com/lpj-app";
// Vereinsblau -- see the vault's "Product Color - MyVerein" doc and
// myverein-website/src/theme/palettes.ts's "vereinsblau" palette, same hue.
export const primaryColor = "#2c4870";
