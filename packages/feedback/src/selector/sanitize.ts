import type { FeedbackPayload } from '../types';
import { buildSelector } from './index';

export const DEFAULT_IGNORE_SELECTOR = '[data-feedback-ignore]';
export const SNIPPET_MAX = 120;

/** Elements whose content is user input and must never leave the page. */
const FORM_FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'DATALIST']);
const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT']);

/** Attributes we copy. `data-*` is handled separately. Never `value`. */
const ALLOWED_ATTRIBUTES = ['id', 'class', 'aria-label', 'role', 'href', 'type', 'name', 'alt'];
/** For private elements only identifying attributes are kept. */
const PRIVATE_ALLOWED = new Set(['id', 'class', 'role', 'type', 'name', 'data-testid', 'data-feedback-id']);

function matchesSafe(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function closestSafe(el: Element, selector: string): Element | null {
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

function isEditable(el: Element): boolean {
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce !== 'false';
}

/**
 * True if the element's own content is private: a form field, contenteditable,
 * or inside an ignored subtree.
 */
export function isPrivateElement(el: Element, ignoreSelector = DEFAULT_IGNORE_SELECTOR): boolean {
  if (FORM_FIELD_TAGS.has(el.tagName)) return true;
  if ((el as HTMLElement).isContentEditable || closestSafe(el, '[contenteditable]:not([contenteditable="false"])')) return true;
  if (ignoreSelector && closestSafe(el, ignoreSelector)) return true;
  return false;
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const view = el.ownerDocument?.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
}

/** Up to `max` chars of visible text, skipping form fields, contenteditable and ignored subtrees. */
export function getTextSnippet(el: Element, ignoreSelector = DEFAULT_IGNORE_SELECTOR, max = SNIPPET_MAX): string {
  if (isPrivateElement(el, ignoreSelector)) return '';
  const doc = el.ownerDocument ?? document;
  const NF = (doc.defaultView as (Window & typeof globalThis) | null)?.NodeFilter ?? NodeFilter;
  let text = '';
  const walker = doc.createTreeWalker(el, NF.SHOW_ELEMENT | NF.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === 3) return NF.FILTER_ACCEPT;
      const child = node as Element;
      if (
        FORM_FIELD_TAGS.has(child.tagName) ||
        NON_TEXT_TAGS.has(child.tagName.toUpperCase()) ||
        isEditable(child) ||
        (ignoreSelector && matchesSafe(child, ignoreSelector)) ||
        isHidden(child)
      ) {
        return NF.FILTER_REJECT; // skips the whole subtree
      }
      return NF.FILTER_SKIP;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    text += ` ${node.nodeValue ?? ''}`;
    if (text.length > max * 3) break;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

/** Copy safe, identifying attributes. Never copies `value` or anything from private elements' data. */
export function getSafeAttributes(el: Element, ignoreSelector = DEFAULT_IGNORE_SELECTOR): Record<string, string> {
  const priv = isPrivateElement(el, ignoreSelector);
  const out: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const allowed = ALLOWED_ATTRIBUTES.includes(name) || (name.startsWith('data-') && !/value/.test(name));
    if (!allowed) continue;
    if (priv && !PRIVATE_ALLOWED.has(name) && !name.startsWith('data-feedback-')) continue;
    out[name] = attr.value.length > 500 ? attr.value.slice(0, 500) : attr.value;
  }
  return out;
}

export function describeTarget(el: Element, ignoreSelector = DEFAULT_IGNORE_SELECTOR): FeedbackPayload['target'] {
  const r = el.getBoundingClientRect();
  const view = el.ownerDocument?.defaultView;
  const sx = view?.scrollX ?? 0;
  const sy = view?.scrollY ?? 0;
  return {
    selector: buildSelector(el),
    tag: el.tagName.toLowerCase(),
    textSnippet: getTextSnippet(el, ignoreSelector),
    rect: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) },
    attributes: getSafeAttributes(el, ignoreSelector),
  };
}
