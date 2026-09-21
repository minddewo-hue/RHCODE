export type AssistantContentBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "code"; language: string; content: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "rule" };

export type AssistantInlineSpan =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; url: string };

const fencePattern = /^ {0,3}```([^`]*)$/;
const headingPattern = /^ {0,3}(#{1,6})\s+(.+)$/;
const listPattern = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/;
const quotePattern = /^\s*>\s?(.*)$/;
const rulePattern = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const tableDividerPattern = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function parseAssistantContent(content: string): AssistantContentBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: AssistantContentBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] || "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(fencePattern);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !fencePattern.test(lines[index] || "")) {
        codeLines.push(lines[index] || "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: (fence[1] || "").trim(),
        content: codeLines.join("\n"),
      });
      continue;
    }

    const heading = line.match(headingPattern);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]?.length || 1, text: heading[2] || "" });
      index += 1;
      continue;
    }

    if (rulePattern.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && tableDividerPattern.test(lines[index + 1] || "")) {
      const headers = parseTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] || "").includes("|") && (lines[index] || "").trim()) {
        rows.push(parseTableRow(lines[index] || ""));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const quote = line.match(quotePattern);
    if (quote) {
      const quoteLines = [quote[1] || ""];
      index += 1;
      while (index < lines.length) {
        const nextQuote = (lines[index] || "").match(quotePattern);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1] || "");
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n").trim() });
      continue;
    }

    const list = line.match(listPattern);
    if (list) {
      const ordered = Boolean(list[1]);
      const items = [list[2] || ""];
      index += 1;
      while (index < lines.length) {
        const nextList = (lines[index] || "").match(listPattern);
        if (!nextList || Boolean(nextList[1]) !== ordered) break;
        items.push(nextList[2] || "");
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && (lines[index] || "").trim() && !startsBlock(lines, index)) {
      paragraphLines.push((lines[index] || "").trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

export function parseAssistantInline(text: string): AssistantInlineSpan[] {
  const spans: AssistantInlineSpan[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const offset = match.index ?? 0;
    if (offset > cursor) spans.push({ type: "text", text: text.slice(cursor, offset) });
    if (match[1] !== undefined) spans.push({ type: "code", text: match[1] });
    else if (match[2] !== undefined || match[3] !== undefined) {
      spans.push({ type: "strong", text: match[2] || match[3] || "" });
    } else {
      spans.push({ type: "link", text: match[4] || match[5] || "", url: match[5] || "" });
    }
    cursor = offset + match[0].length;
  }
  if (cursor < text.length) spans.push({ type: "text", text: text.slice(cursor) });
  return spans.length ? spans : [{ type: "text", text }];
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] || "";
  return fencePattern.test(line)
    || headingPattern.test(line)
    || rulePattern.test(line)
    || quotePattern.test(line)
    || listPattern.test(line)
    || (index + 1 < lines.length && tableDividerPattern.test(lines[index + 1] || ""));
}

function parseTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] || "";
    const next = normalized[index + 1];
    if (character === "\\" && (next === "|" || next === "\\")) {
      cell += next;
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}
