/**
 * Heuristics to skip generated / unstable class names and ids.
 * Goal: never put a CSS-modules / CSS-in-JS / utility-hash class into a selector
 * when there is any alternative.
 */

const CSS_IN_JS_PREFIX = /^(css|sc|jsx|svelte|emotion|jss|makeStyles|mui|chakra|styled|tw)-/i;
/** `Button_primary__a1B2c`, `button__3xQ9z` (CSS modules) */
const CSS_MODULES = /(^|_)_[A-Za-z0-9-]{5,}$|__[A-Za-z0-9-]{5,}$/;
/** A trailing chunk of 5+ chars that mixes letters and digits: `a1b2c3`, `card-x7Kp9q` */
const HASH_CHUNK = /(?:^|[-_])(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{5,}$/;
/** Tailwind variants / arbitrary values: `hover:bg-red`, `w-[13px]`, `!mt-2`, `w-1/2` */
const UTILITY_SYNTAX = /[:[\]/!@()%#.,]/;
/** State classes change at runtime and break selectors. */
const STATE = /^(is-|has-)|^(active|hover|focus|focused|selected|open|opened|closed|disabled|checked|current|visible|hidden|show|shown|in|ng-.*)$/i;

export function isStableClass(cls: string): boolean {
  if (!cls || cls.length > 40) return false;
  if (CSS_IN_JS_PREFIX.test(cls)) return false;
  if (CSS_MODULES.test(cls)) return false;
  if (HASH_CHUNK.test(cls)) return false;
  if (UTILITY_SYNTAX.test(cls)) return false;
  if (STATE.test(cls)) return false;
  if (/^\d/.test(cls)) return false;
  return true;
}

/** React useId (`:r1:`, `«r1»`), framework counters (`ember123`), uuids, pure hashes. */
export function isStableId(id: string): boolean {
  if (!id || id.length > 64) return false;
  if (/^[:«].*[:»]$/.test(id)) return false;
  if (/^(ember|ext-gen|yui_|react-|radix-|headlessui-|mui-|downshift-)/i.test(id)) return false;
  if (/^\d+$/.test(id)) return false;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return false;
  if (/\d{4,}/.test(id)) return false;
  if (HASH_CHUNK.test(id) && !/[-_]/.test(id)) return false;
  return true;
}
