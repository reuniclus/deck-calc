import { describe, it, expect } from 'vitest';
import { unzoomedPosition } from './zoom';

describe('unzoomedPosition', () => {
  it('REGRESSION: dividing by the zoom factor cancels the double-application that caused the chart tooltip to render ~1.5x further from the cursor than it should. Confirmed directly in a real browser before this fix: mouse at real screen position 684.5 produced a tooltip at 1041 (offset 356.5) using the raw clientX; with this correction the offset dropped to ~14.5 (matching the tooltip\'s own intentional 10px CSS translate, itself correctly zoom-scaled since it is a static value, not derived from clientX).', () => {
    const { left, top } = unzoomedPosition(684.5, 614.59375, 1.5);
    expect(left).toBeCloseTo(456.333, 2);
    expect(top).toBeCloseTo(409.729, 2);
    // The whole point: multiplying back by zoom (what the browser's own
    // CSS zoom rendering does to a `left`/`top` value) must reproduce the
    // real clientX/clientY exactly -- this IS the bug's fix, stated as an
    // invariant rather than just a spot-check of one number.
    expect(left * 1.5).toBeCloseTo(684.5, 6);
    expect(top * 1.5).toBeCloseTo(614.59375, 6);
  });

  it('at zoom=1 (no zoom), position is unchanged', () => {
    const { left, top } = unzoomedPosition(300, 200, 1);
    expect(left).toBe(300);
    expect(top).toBe(200);
  });

  it('a zero or negative zoom factor is treated as 1 (never divides by zero or flips sign)', () => {
    expect(unzoomedPosition(300, 200, 0)).toEqual({ left: 300, top: 200 });
    expect(unzoomedPosition(300, 200, -1)).toEqual({ left: 300, top: 200 });
  });
});
