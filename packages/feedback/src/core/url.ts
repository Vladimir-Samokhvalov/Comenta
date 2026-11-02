/** Page identity for pins: URL without the hash. */
export function normalizeUrl(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}
