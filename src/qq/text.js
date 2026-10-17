// Plain-text chunking for QQ messages: the platform rejects overly long text
// content, and line boundaries keep a split readable.
export const TEXT_CHUNK = 1500;

export function chunks(text) {
  const parts = [];
  let rest = text;
  while (rest.length > TEXT_CHUNK) {
    const cut = rest.lastIndexOf('\n', TEXT_CHUNK);
    const at = cut > 0 ? cut + 1 : TEXT_CHUNK;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) parts.push(rest);
  return parts;
}
