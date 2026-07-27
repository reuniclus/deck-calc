/**
 * URL hash serialization (UI_DESIGN.md §6). Hash (#), not query params (?):
 * never hits the server, doesn't trigger navigation via history.replaceState,
 * not subject to the stricter length limits some proxies apply to query
 * strings. Base64url of compact JSON -- a URL is a token to paste, not a
 * document to read (the export textarea, if/when built, is the "I want to
 * read/hand-edit this" path; this is the "just share a link" path).
 *
 * Deliberately excludes target %, turn config, and adviseTurn -- those are
 * session/view preferences (see UI_DESIGN.md §1/§6), not part of what's
 * being shared. Groups get FRESH ids on decode (never trust ids across a
 * serialization boundary); the query text is name-based already, so no id
 * needs to survive the round trip at all.
 */

export interface SharedState {
  deckSize: number;
  groups: Array<{ name: string; count: number }>;
  query: string;
}

const VERSION = 1;

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeShared(deckSize: number, groups: Array<{ name: string; count: number }>, query: string): string {
  const payload = { v: VERSION, deckSize, groups: groups.map((g) => ({ name: g.name, count: g.count })), query };
  return toBase64Url(JSON.stringify(payload));
}

/** `hash` may be the raw fragment or include the leading `#`; returns null
 * for anything empty, malformed, or an unrecognized version -- never throws,
 * since a bad/missing hash should just mean "start with defaults." */
export function decodeShared(hash: string): SharedState | null {
  try {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!raw) return null;
    const parsed = JSON.parse(fromBase64Url(raw));
    if (
      parsed?.v !== VERSION ||
      typeof parsed.deckSize !== 'number' ||
      !Array.isArray(parsed.groups) ||
      !parsed.groups.every((g: unknown) =>
        typeof g === 'object' && g !== null && typeof (g as { name?: unknown }).name === 'string' &&
        typeof (g as { count?: unknown }).count === 'number') ||
      typeof parsed.query !== 'string'
    ) {
      return null;
    }
    return { deckSize: parsed.deckSize, groups: parsed.groups, query: parsed.query };
  } catch {
    return null;
  }
}
