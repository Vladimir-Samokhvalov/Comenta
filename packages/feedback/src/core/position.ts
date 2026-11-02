export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  side: 'below' | 'above' | 'clamped';
}

/**
 * Place a popover of `size` next to `anchor` (viewport coordinates):
 *   1. below the anchor, if it fits;
 *   2. otherwise above it, if it fits;
 *   3. otherwise pinned to the bottom edge of the viewport (e.g. the anchor is taller than the screen).
 * Horizontally aligned to the anchor's left edge and clamped into the viewport.
 */
export function placePopover(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 8,
): Placement {
  const maxTop = viewport.height - margin - size.height;
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - size.height;
  let top: number;
  let side: Placement['side'];
  if (below <= maxTop && below >= margin) {
    top = below;
    side = 'below';
  } else if (above >= margin && above <= maxTop) {
    top = above;
    side = 'above';
  } else {
    top = maxTop;
    side = 'clamped';
  }
  top = Math.max(margin, top);

  const maxLeft = viewport.width - margin - size.width;
  const left = Math.max(margin, Math.min(anchor.left, maxLeft));
  return { top: Math.round(top), left: Math.round(left), side };
}
