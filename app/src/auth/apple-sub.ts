// Reads the Apple user id (`sub`) out of an identity token's payload (CAP-28, decided 2026-11-02 by the architect):
// shown on the sign-in screen when the API refuses the Apple ID (403), so the single allowed `sub` can be added to
// the server allow-list the first time. Decoding only — the token is never verified, trusted or logged here; the API
// is the only judge (ADR-008 §4).

function base64UrlDecode(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** `sub` of a JWT (`header.payload.signature`), or null when the token is not a decodable JWT with a string `sub`. */
export function appleSubFromIdentityToken(identityToken: string): string | null {
  const parts = identityToken.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload === '') return null;
  try {
    const claims: unknown = JSON.parse(base64UrlDecode(payload));
    if (typeof claims !== 'object' || claims === null || !('sub' in claims)) return null;
    const { sub } = claims;
    return typeof sub === 'string' && sub !== '' ? sub : null;
  } catch {
    return null;
  }
}
