/**
 * Stub interface for the abmelde link (B9 installs the HMAC token implementation). Until then no link and no
 * `List-Unsubscribe` header is produced, which is the safe default.
 */
export interface UnsubscribeSubject {
  clubId: string | null;
  userId: string | null;
  clubMemberId: string | null;
  category: string;
}

export type UnsubscribeUrlProvider = (subject: UnsubscribeSubject) => string | null;

let provider: UnsubscribeUrlProvider = () => null;

export function setUnsubscribeUrlProvider(next: UnsubscribeUrlProvider | null): void {
  provider = next ?? (() => null);
}

/** `https://` URL (or NULL). A provider error or a non-https/http result never breaks a send. */
export function unsubscribeUrlFor(subject: UnsubscribeSubject): string | null {
  try {
    const url = provider(subject);
    return url && /^https?:\/\/[^\s<>"]+$/.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Headers for RFC 8058 one-click unsubscribe. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
