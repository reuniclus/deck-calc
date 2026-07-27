import { describe, it, expect } from 'vitest';
import { computeRailWidthFromDrag } from './App';

describe('computeRailWidthFromDrag (the actual reported bug: dragging moved the rail way out of position)', () => {
  it('at zoom=1, tracks the mouse 1:1 (baseline sanity check)', () => {
    expect(computeRailWidthFromDrag(230, 0, 1)).toBe(230);
    expect(computeRailWidthFromDrag(300, 0, 1)).toBe(300);
  });

  it('at zoom=1.5, divides out the zoom factor -- the actual fix', () => {
    // clientX/gridLeft are REAL (post-zoom) pixels; a real-pixel delta of 300
    // corresponds to 200 "unzoomed" CSS px, which is what must be stored,
    // since it feeds back into a CSS px value inside the SAME zoomed ancestor.
    expect(computeRailWidthFromDrag(300, 0, 1.5)).toBeCloseTo(200, 5);
  });

  it('reproduces the exact reported symptom: WITHOUT dividing by zoom, a real drag of 200px would have moved the rail 300px (1.5x too far)', () => {
    // this is what the buggy code did: (clientX - gridLeft) with no zoom division
    const buggyResult = 300 - 0; // e.g. dragging 300 real px with gridLeft=0
    // that raw value (300), fed into a CSS px on a 1.5x-zoomed ancestor,
    // would RENDER as 450 real px -- 1.5x the actual 300px the mouse moved.
    // The fix must NOT reproduce this: it should already be pre-divided.
    const fixedResult = computeRailWidthFromDrag(300, 0, 1.5);
    expect(fixedResult).not.toBe(buggyResult);
    expect(fixedResult * 1.5).toBeCloseTo(300, 5); // renders back to the real 300px, correctly
  });

  it('clamps to RAIL_MIN/RAIL_MAX after converting, not before', () => {
    expect(computeRailWidthFromDrag(1, 0, 1.5)).toBe(180); // clamped to RAIL_MIN
    expect(computeRailWidthFromDrag(10000, 0, 1.5)).toBe(450); // clamped to RAIL_MAX
  });

  it('a zero or negative zoom factor falls back to treating it as 1 (never divides by zero or a negative)', () => {
    expect(computeRailWidthFromDrag(230, 0, 0)).toBe(230);
    expect(computeRailWidthFromDrag(230, 0, -1)).toBe(230);
  });

  it('accounts for gridLeft being non-zero (grid not flush against the viewport edge)', () => {
    expect(computeRailWidthFromDrag(830, 500, 1.5)).toBeCloseTo((830 - 500) / 1.5, 5);
  });
});
