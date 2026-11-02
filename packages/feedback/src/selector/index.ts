import { attrValue, cssEscape } from './escape';
import { isStableClass, isStableId } from './heuristics';

export { isStableClass, isStableId } from './heuristics';
export { cssEscape } from './escape';

/** Attributes that are put in by developers specifically to identify elements. */
export const STABLE_ATTRIBUTES = ['data-testid', 'data-feedback-id'] as const;

const MAX_CLASSES_PER_SEGMENT = 2;

function isUnique(root: ParentNode, selector: string, el: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** Selector that identifies `el` on its own (stable attribute or unique stable id), if any. */
function anchorFor(el: Element, root: ParentNode): string | null {
  for (const attr of STABLE_ATTRIBUTES) {
    const v = el.getAttribute(attr);
    if (v) {
      const sel = `[${attr}=${attrValue(v)}]`;
      if (isUnique(root, sel, el)) return sel;
    }
  }
  const id = el.id;
  if (id && isStableId(id)) {
    const sel = `#${cssEscape(id)}`;
    if (isUnique(root, sel, el)) return sel;
  }
  return null;
}

function segmentFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  let seg = cssEscape(tag);
  const classes = Array.from(el.classList).filter(isStableClass).slice(0, MAX_CLASSES_PER_SEGMENT);
  for (const c of classes) seg += `.${cssEscape(c)}`;
  const parent = el.parentElement;
  if (parent) {
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }
  return seg;
}

/** Last-resort, always-unique path from the root using :nth-child. */
function absolutePath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.parentElement) {
    const idx = Array.from(cur.parentElement.children).indexOf(cur) + 1;
    parts.unshift(`${cssEscape(cur.tagName.toLowerCase())}:nth-child(${idx})`);
    cur = cur.parentElement;
  }
  parts.unshift(cur ? cssEscape(cur.tagName.toLowerCase()) : 'html');
  return parts.join(' > ');
}

/**
 * Build a CSS selector that matches exactly `el`.
 *
 * Priority:
 *   1. `[data-testid]` / `[data-feedback-id]`
 *   2. `#id` (if unique and does not look generated)
 *   3. `tag.class:nth-of-type(n)` path up to the closest ancestor with a stable anchor
 *      (or the document root), stopping as soon as the path is unique.
 */
export function buildSelector(el: Element, root: Document | ParentNode = el.ownerDocument ?? document): string {
  const doc = el.ownerDocument ?? document;
  if (el === doc.documentElement) return 'html';
  if (el === doc.body) return 'body';

  const own = anchorFor(el, root);
  if (own) return own;

  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== doc.documentElement) {
    if (cur !== el) {
      const anchor = anchorFor(cur, root);
      if (anchor) {
        const sel = `${anchor} > ${parts.join(' > ')}`;
        if (isUnique(root, sel, el)) return sel;
        break;
      }
    }
    parts.unshift(segmentFor(cur));
    const sel = parts.join(' > ');
    if (isUnique(root, sel, el)) return sel;
    cur = cur.parentElement;
  }

  const rooted = `html > ${parts.join(' > ')}`;
  if (cur === doc.documentElement && isUnique(root, rooted, el)) return rooted;
  return absolutePath(el);
}

/** Resolve a selector to exactly one element, or null. */
export function resolveSelector(selector: string, root: ParentNode = document): Element | null {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 ? found[0] : found[0] ?? null;
  } catch {
    return null;
  }
}
