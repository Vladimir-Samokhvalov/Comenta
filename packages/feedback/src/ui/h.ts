type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Tiny element factory. Text is always set via textContent (no innerHTML). */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Speech-bubble icon (static markup, built with DOM APIs). */
export function commentIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('stroke-width', '1.8');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5z');
  svg.append(path);
  return svg;
}

function icon(doc: Document, viewBox: string, d: string, width = '1.6'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': width,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(k, v);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export const chevronIcon = (doc: Document) => icon(doc, '0 0 12 12', 'M3 4.5 6 7.5 9 4.5');
export const listIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M2.5 4h11M2.5 8h11M2.5 12h7', '1.5');
export const eyeOffIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM4.1 11.9l7.8-7.8', '1.5');
export const eyeIcon = (doc: Document) =>
  icon(doc, '0 0 16 16', 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', '1.5');
export const closeIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M4 4l8 8M12 4l-8 8', '1.5');

export const micIcon = (doc: Document) =>
  icon(doc, '0 0 20 20', 'M10 2.5a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5zM5 9.5a5 5 0 0 0 10 0M10 14.5v3', '1.6');
export const screenIcon = (doc: Document) =>
  icon(doc, '0 0 20 20', 'M3 4.5h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM7 17.5h6M10 14.5v3', '1.6');
export const stopIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M4.5 4.5h7v7h-7z', '1.8');
export const redoIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3', '1.5');
export const trashIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.6 8.5h6.8l.6-8.5', '1.5');
export const checkIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M3 8.5 6.5 12 13 4.5', '1.7');
export const reopenIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3', '1.5');
export const pencilIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M10.5 2.5l3 3L6 13H3v-3z', '1.5');
export const signOutIcon = (doc: Document) => icon(doc, '0 0 16 16', 'M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11 13.5 8l-3-3M13.5 8H6', '1.5');
