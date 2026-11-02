/** CSS.escape with a small fallback for environments without it. */
export function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css && typeof css.escape === 'function') return css.escape(value);
  // Minimal spec-compliant-enough fallback (https://drafts.csswg.org/cssom/#serialize-an-identifier)
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    if (code === 0) out += '�';
    else if ((code >= 1 && code <= 31) || code === 127 || (i === 0 && code >= 48 && code <= 57) ||
      (i === 1 && code >= 48 && code <= 57 && value.charCodeAt(0) === 45)) out += `\\${code.toString(16)} `;
    else if (i === 0 && ch === '-' && value.length === 1) out += `\\${ch}`;
    else if (code >= 128 || ch === '-' || ch === '_' || /[a-zA-Z0-9]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/** Escape a value for use inside a double-quoted attribute selector. */
export function attrValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
}
