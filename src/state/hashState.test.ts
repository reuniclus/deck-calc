import { describe, it, expect } from 'vitest';
import { encodeShared, decodeShared } from './hashState';

describe('hashState encode/decode round trip', () => {
  it('round-trips a basic state', () => {
    const encoded = encodeShared(40, [{ name: 'Blink ETB', count: 4 }, { name: 'Blink Spell', count: 3 }],
      '"Blink ETB">=1 & "Blink Spell">=1');
    const decoded = decodeShared(encoded);
    expect(decoded).toEqual({
      deckSize: 40,
      groups: [{ name: 'Blink ETB', count: 4 }, { name: 'Blink Spell', count: 3 }],
      query: '"Blink ETB">=1 & "Blink Spell">=1',
    });
  });

  it('round-trips through a leading # (as window.location.hash provides it)', () => {
    const encoded = encodeShared(40, [{ name: 'A', count: 4 }], 'A>=1');
    expect(decodeShared('#' + encoded)).toEqual({ deckSize: 40, groups: [{ name: 'A', count: 4 }], query: 'A>=1' });
  });

  it('round-trips names with quotes, unicode, and query text with negation/OR', () => {
    const encoded = encodeShared(99, [{ name: 'land', count: 38 }, { name: 'ramp', count: 6 }],
      '!land>=4 | (!land>=3 & !ramp>=1)');
    expect(decodeShared(encoded)).toEqual({
      deckSize: 99,
      groups: [{ name: 'land', count: 38 }, { name: 'ramp', count: 6 }],
      query: '!land>=4 | (!land>=3 & !ramp>=1)',
    });
  });

  it('round-trips non-ASCII group names correctly (real UTF-8 handling, not just ASCII)', () => {
    const encoded = encodeShared(40, [{ name: 'Ashes of the Fallen \u2694\ufe0f', count: 2 }], '"Ashes of the Fallen \u2694\ufe0f">=1');
    const decoded = decodeShared(encoded);
    expect(decoded?.groups[0]!.name).toBe('Ashes of the Fallen \u2694\ufe0f');
  });

  it('returns null (not throws) for empty, garbage, or wrong-version input', () => {
    expect(decodeShared('')).toBeNull();
    expect(decodeShared('#')).toBeNull();
    expect(decodeShared('not-valid-base64!!!')).toBeNull();
    expect(decodeShared(btoa('{"v":999,"deckSize":1,"groups":[],"query":"x"}'))).toBeNull();
  });

  it('returns null for structurally malformed payloads (missing fields, wrong types)', () => {
    const bad1 = btoa(JSON.stringify({ v: 1, deckSize: 'not-a-number', groups: [], query: 'x' }));
    const bad2 = btoa(JSON.stringify({ v: 1, deckSize: 40, groups: [{ name: 'A' }], query: 'x' })); // missing count
    const bad3 = btoa(JSON.stringify({ v: 1, deckSize: 40, groups: [] })); // missing query
    expect(decodeShared(bad1)).toBeNull();
    expect(decodeShared(bad2)).toBeNull();
    expect(decodeShared(bad3)).toBeNull();
  });
});
