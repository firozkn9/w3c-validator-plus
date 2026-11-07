/**
 * Extracts inline JavaScript from HTML (or masked JSP, which has identical offsets).
 */

export interface ScriptBlock {
  code: string;
  /** Offset of the first character of `code` in the document. */
  offset: number;
  /** Zero-based line and column of `offset`. */
  line: number;
  column: number;
  module: boolean;
}

const SCRIPT_RE = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
const TYPE_RE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const JS_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "application/x-javascript",
  "text/jscript",
]);

function commentRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = html.indexOf("<!--"); i >= 0; i = html.indexOf("<!--", i)) {
    const end = html.indexOf("-->", i + 4);
    const e = end < 0 ? html.length : end + 3;
    ranges.push([i, e]);
    i = e;
  }
  return ranges;
}

export function extractScripts(html: string): ScriptBlock[] {
  const comments = commentRanges(html);
  const blocks: ScriptBlock[] = [];
  let line = 0;
  let lineStart = 0;
  let scanned = 0;
  const advance = (to: number) => {
    for (; scanned < to; scanned++) {
      if (html.charCodeAt(scanned) === 10) {
        line++;
        lineStart = scanned + 1;
      }
    }
  };

  for (const m of html.matchAll(SCRIPT_RE)) {
    const start = m.index;
    if (comments.some(([s, e]) => start >= s && start < e)) continue;
    const attrs = m[1] ?? "";
    const t = TYPE_RE.exec(attrs);
    const type = (t ? (t[1] ?? t[2] ?? t[3] ?? "") : "").trim().toLowerCase();
    if (!JS_TYPES.has(type)) continue; // templates, JSON, importmaps…
    const code = m[2] ?? "";
    if (!code.trim()) continue;
    const offset = start + "<script".length + attrs.length + 1; // just after the start tag's ">"
    advance(offset);
    blocks.push({ code, offset, line, column: offset - lineStart, module: type === "module" });
  }
  return blocks;
}
