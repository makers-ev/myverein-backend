/** Removes control characters (incl. NUL, which Postgres rejects in text values) from user-typed search text. */
// eslint-disable-next-line no-control-regex
export const stripControlChars = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
