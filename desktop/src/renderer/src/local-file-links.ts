export type LocalFileLinkSpan =
  | { type: "text"; text: string }
  | { type: "file"; text: string; path: string };

export function localFileLinkPath(destination: string): string | null {
  let path = destination.trim();
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1);
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = (url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : "") + url.pathname;
    } catch {
      return null;
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // Literal percent signs are valid in local file names.
  }
  path = path.replace(/^\/([a-z]:[\\/])/i, "$1")
    .replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?)$/, "");
  if (/[\u0000-\u001f]/.test(path)) return null;
  return /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path) ? path : null;
}

export function parseLocalFileLinks(content: string): LocalFileLinkSpan[] {
  const spans: LocalFileLinkSpan[] = [];
  // Keep examples in code intact; link destinations may contain spaces or parentheses.
  const pattern = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*`+|\[([^\]\n]+)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g;
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    if (match[1] === undefined || match[2] === undefined) continue;
    const path = localFileLinkPath(match[2]);
    if (!path) continue;
    const offset = match.index!;
    if (offset > cursor) spans.push({ type: "text", text: content.slice(cursor, offset) });
    spans.push({ type: "file", text: match[1], path });
    cursor = offset + match[0].length;
  }
  if (cursor < content.length) spans.push({ type: "text", text: content.slice(cursor) });
  return spans;
}
