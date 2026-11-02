import { describe, expect, it } from 'vitest';
import { placePopover } from '../../src/core/position';

const vp = { width: 1000, height: 800 };
const size = { width: 320, height: 200 };

describe('placePopover', () => {
  it('places below the element when there is room', () => {
    const p = placePopover({ top: 100, left: 100, width: 200, height: 40 }, size, vp);
    expect(p).toEqual({ top: 148, left: 100, side: 'below' });
  });

  it('flips above near the bottom edge', () => {
    const p = placePopover({ top: 700, left: 100, width: 200, height: 40 }, size, vp);
    expect(p.side).toBe('above');
    expect(p.top).toBe(700 - 8 - 200);
  });

  it('clamps to the bottom edge when neither fits (element taller than the screen)', () => {
    const p = placePopover({ top: -300, left: 0, width: 1000, height: 2000 }, size, vp);
    expect(p.side).toBe('clamped');
    expect(p.top).toBe(800 - 8 - 200);
  });

  it('never leaves the top edge', () => {
    const p = placePopover({ top: 10, left: 10, width: 50, height: 700 }, size, { width: 1000, height: 300 });
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it('clamps horizontally on the right and left edges', () => {
    expect(placePopover({ top: 100, left: 950, width: 40, height: 20 }, size, vp).left).toBe(1000 - 8 - 320);
    expect(placePopover({ top: 100, left: -50, width: 40, height: 20 }, size, vp).left).toBe(8);
  });
});
