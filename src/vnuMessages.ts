// Turns Nu Html Checker JSON output into findings with stable rule ids, and
// adds the few quick fixes that are always safe.
import { LineIndex, type Finding, type Fix, type Position, type Range, type Severity } from "./core";

// vnu JSON output (CLI --format json, HTTP out=json).
export interface VnuMessage {
  type: "error" | "info" | "non-document-error" | string;
  subType?: string;
  message?: string;
  extract?: string;
  url?: string;
  firstLine?: number;
  lastLine?: number;
  firstColumn?: number;
  lastColumn?: number;
  hiliteStart?: number;
  hiliteLength?: number;
}

export interface VnuResponse {
  version?: string;
  url?: string;
  messages: VnuMessage[];
}

export const VNU_SOURCE = "Nu Html Checker";

// “x”, or "x" / 'x' with --asciiquotes.
const Q = String.raw`[“"'][^”"']*[”"']`;

// vnu has no message codes, so ids come from the shape of the message with
// the element and attribute names left out. First match wins.
const RULES: ReadonlyArray<[RegExp, string]> = [
  [/^Cannot recover after last error/, "vnu:fatal-parse-error"],
  [/^CSS: .*\bis not an? .*\bvalue\b/, "vnu:css-invalid-value"],
  [/^CSS: .*Property .* doesn.t exist/, "vnu:css-unknown-property"],
  [/^CSS: .*Parse Error/i, "vnu:css-parse-error"],
  [/^CSS: /, "vnu:css"],
  [new RegExp(`^An ${Q} element must have an ${Q} attribute`), "vnu:img-missing-alt"],
  [new RegExp(`^The ${Q} attribute on the ${Q} element is obsolete`), "vnu:obsolete-attribute"],
  [new RegExp(`^The ${Q} element is obsolete`), "vnu:obsolete-element"],
  [new RegExp(`^Element ${Q} not allowed as child of element ${Q}`), "vnu:element-not-allowed-as-child"],
  [new RegExp(`^Attribute ${Q} not allowed on element ${Q}`), "vnu:attribute-not-allowed"],
  [new RegExp(`^Element ${Q} is missing required attribute ${Q}`), "vnu:missing-required-attribute"],
  [new RegExp(`^Element ${Q} is missing one or more of the following attributes`), "vnu:missing-required-attribute"],
  [new RegExp(`^Element ${Q} is missing a required instance of child element ${Q}`), "vnu:missing-required-child"],
  [new RegExp(`^Element ${Q} is missing a required child element`), "vnu:missing-required-child"],
  [new RegExp(`^Bad value ${Q} for attribute ${Q}`), "vnu:bad-attribute-value"],
  [new RegExp(`^Duplicate ID ${Q}`), "vnu:duplicate-id"],
  [/^The first occurrence of ID/, "vnu:duplicate-id"],
  [/^Duplicate attribute/, "vnu:duplicate-attribute"],
  [/without seeing a doctype first/, "vnu:missing-doctype"],
  [new RegExp(`^Unclosed element ${Q}`), "vnu:unclosed-element"],
  [new RegExp(`^End tag (for\\s+)?${Q} seen, but there were (open|unclosed) elements`), "vnu:end-tag-with-open-elements"],
  [/^End of file (seen|reached).*open elements|^End of file seen when expecting/, "vnu:eof-with-open-elements"],
  [/^Stray end tag/, "vnu:stray-end-tag"],
  [/^Stray start tag/, "vnu:stray-start-tag"],
  [/^Stray doctype/, "vnu:stray-doctype"],
  [new RegExp(`^Start tag ${Q} seen in ${Q}`), "vnu:misplaced-in-table"],
  [/^Misplaced non-space characters inside a table/, "vnu:misplaced-in-table"],
  [new RegExp(`^No ${Q} element in scope but an? ${Q} end tag seen`), "vnu:no-element-in-scope"],
  [/^Consider adding a .lang. attribute/, "vnu:missing-lang"],
  [/^This document appears to be written in/, "vnu:lang-mismatch"],
  [/^This document has heading elements but none of them has a computed heading level of 1/, "vnu:missing-h1"],
  [/^Section lacks heading/, "vnu:section-lacks-heading"],
  [/^Article lacks heading/, "vnu:section-lacks-heading"],
  [/^Trailing slash on void elements/, "vnu:void-trailing-slash"],
  [/^Self-closing syntax .* used on a non-void HTML element/, "vnu:self-closing-non-void"],
  [new RegExp(`^The ${Q} attribute is unnecessary for JavaScript resources`), "vnu:unnecessary-script-type"],
  [new RegExp(`^The ${Q} attribute for the ${Q} element is not needed`), "vnu:unnecessary-attribute"],
];

export const VNU_RULE_IDS: readonly string[] = [...new Set(RULES.map(([, id]) => id))];

const DOCS: Readonly<Record<string, string>> = {
  "vnu:img-missing-alt": "https://html.spec.whatwg.org/multipage/images.html#alt",
  "vnu:obsolete-element": "https://html.spec.whatwg.org/multipage/obsolete.html#non-conforming-features",
  "vnu:obsolete-attribute": "https://html.spec.whatwg.org/multipage/obsolete.html#non-conforming-features",
  "vnu:element-not-allowed-as-child": "https://html.spec.whatwg.org/multipage/dom.html#content-models",
  "vnu:missing-required-child": "https://html.spec.whatwg.org/multipage/dom.html#content-models",
  "vnu:missing-lang": "https://html.spec.whatwg.org/multipage/dom.html#the-lang-and-xml:lang-attributes",
  "vnu:missing-doctype": "https://html.spec.whatwg.org/multipage/syntax.html#the-doctype",
  "vnu:duplicate-id": "https://html.spec.whatwg.org/multipage/dom.html#the-id-attribute",
  "vnu:fatal-parse-error": "https://html.spec.whatwg.org/multipage/parsing.html#parse-errors",
  "vnu:unclosed-element": "https://html.spec.whatwg.org/multipage/parsing.html#parse-errors",
  "vnu:stray-end-tag": "https://html.spec.whatwg.org/multipage/parsing.html#parse-errors",
  "vnu:stray-start-tag": "https://html.spec.whatwg.org/multipage/parsing.html#parse-errors",
  "vnu:end-tag-with-open-elements": "https://html.spec.whatwg.org/multipage/parsing.html#parse-errors",
  "vnu:eof-with-open-elements": "https://html.spec.whatwg.org/multipage/parsing.html#parse-errors",
  "vnu:misplaced-in-table": "https://html.spec.whatwg.org/multipage/parsing.html#unexpected-markup-in-tables",
};

function slug(text: string): string {
  return text
    .replace(new RegExp(Q, "g"), " ")
    .replace(/\(.*?\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

// Unknown messages get an id made from their words.
export function vnuRuleId(messageText: string | undefined): string {
  const text = (messageText ?? "").trim();
  for (const [pattern, id] of RULES) {
    if (pattern.test(text)) return id;
  }
  const s = slug(text);
  return s ? `vnu:${s}` : "vnu:unknown";
}

export function vnuSeverity(m: VnuMessage): Severity {
  if (m.type === "error" || m.type === "non-document-error") return "error";
  if (m.type === "info" && m.subType === "warning") return "warning";
  return "info";
}

type Pos = Position;

function before(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

// When `end` is just after a ">", the "<" that opened that tag.
function findTagStart(lines: readonly string[], end: Pos): Pos | undefined {
  const endLine = lines[end.line];
  if (endLine === undefined || end.character < 1 || endLine[end.character - 1] !== ">") return undefined;
  let line = end.line;
  let col = end.character - 2;
  for (let scanned = 0; line >= 0 && scanned < 20_000; ) {
    const text = lines[line] ?? "";
    for (; col >= 0; col--, scanned++) {
      const ch = text[col];
      if (ch === "<") return { line, character: col };
      if (ch === ">") return undefined;
    }
    line--;
    col = (lines[line]?.length ?? 0) - 1;
  }
  return undefined;
}

// vnu positions are 1-based and inclusive. firstLine/firstColumn are left out
// when equal to the last ones, and in --no-stream mode they are often stale
// (the end of an earlier token) while lastLine/lastColumn are right. So with
// the document lines at hand, a suspicious start is rebuilt from the "<" of
// the tag that ends at the reported end.
export function vnuRange(m: VnuMessage, lines?: readonly string[]): Range {
  if (m.lastLine === undefined) {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  }
  const lastLine = m.lastLine;
  const lastColumn = m.lastColumn ?? 1;
  const firstLine = m.firstLine ?? lastLine;
  const firstColumn = m.firstColumn ?? lastColumn;

  let start: Pos = { line: firstLine - 1, character: Math.max(firstColumn - 1, 0) };
  let end: Pos = { line: lastLine - 1, character: Math.max(lastColumn, 0) };

  if (lines && lines.length > 0) {
    const clamp = (p: Pos): Pos => {
      const line = Math.min(Math.max(p.line, 0), lines.length - 1);
      return { line, character: Math.min(p.character, lines[line]?.length ?? 0) };
    };
    start = clamp(start);
    end = clamp(end);
    const suspicious = start.line !== end.line || !before(start, end);
    if (suspicious) {
      const tagStart = findTagStart(lines, end);
      if (tagStart) {
        start = tagStart;
      } else if (start.line < end.line && start.character >= (lines[start.line]?.length ?? 0)) {
        // starts on a line break: use the start of the next line
        start = { line: start.line + 1, character: 0 };
      }
    }
  }
  if (!before(start, end) && !(start.line === end.line && start.character === end.character)) {
    start = { ...end };
  }
  if (start.line === end.line && start.character === end.character && start.character > 0) {
    start = { line: start.line, character: start.character - 1 };
  }
  return { start, end };
}

export function isFatalParseError(m: VnuMessage): boolean {
  return m.type === "error" && m.subType === "fatal";
}

// undefined for messages that are not about the document (I/O errors and such).
export function vnuMessageToFinding(m: VnuMessage, lines?: readonly string[]): Finding | undefined {
  if (m.type === "non-document-error") return undefined;
  const ruleId = vnuRuleId(m.message);
  const finding: Finding = {
    ruleId,
    source: VNU_SOURCE,
    severity: vnuSeverity(m),
    message: (m.message ?? "Unknown problem").replace(/\s+/g, " ").trim(),
    range: vnuRange(m, lines),
  };
  const docsUrl = DOCS[ruleId];
  if (docsUrl) finding.docsUrl = docsUrl;
  return finding;
}

export function parseVnuResponse(body: string): VnuResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Nu Html Checker returned invalid JSON: ${body.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as VnuResponse).messages)) {
    throw new Error("Nu Html Checker response has no `messages` array");
  }
  return parsed as VnuResponse;
}

export function vnuResponseToFindings(response: VnuResponse, text: string): Finding[] {
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = [];
  for (const m of response.messages) {
    const f = vnuMessageToFinding(m, lines);
    if (f) findings.push(f);
  }
  return findings;
}

export interface HtmlFixOptions {
  locale: string; // for lang="…"
  fragment: boolean; // no doctype fix for includes and partials
}

function insertAt(lines: LineIndex, offset: number, text: string, title: string): Fix {
  const p = lines.positionAt(offset);
  return { title, edits: [{ range: { start: p, end: p }, newText: text }] };
}

export function addHtmlFixes(findings: readonly Finding[], text: string, opts: HtmlFixOptions): Finding[] {
  const lines = new LineIndex(text);
  return findings.map((f) => {
    if (f.fix) return f;
    const start = lines.offsetAt(f.range.start);
    const end = lines.offsetAt(f.range.end);
    switch (f.ruleId) {
      case "vnu:img-missing-alt": {
        // the range is the <img ...> start tag
        if (!/^<img\b/i.test(text.slice(start, start + 4)) || text[end - 1] !== ">") return f;
        const at = text[end - 2] === "/" ? end - 2 : end - 1;
        const space = /\s/.test(text[at - 1] ?? "") ? "" : " ";
        return { ...f, fix: insertAt(lines, at, `${space}alt=""`, 'Add alt="" (decorative image)') };
      }
      case "vnu:missing-lang": {
        if (!/^<html\b/i.test(text.slice(start, start + 5))) return f;
        const lang = opts.locale.split(/[-_]/)[0]?.toLowerCase() || "en";
        return { ...f, fix: insertAt(lines, start + 5, ` lang="${lang}"`, `Add lang="${lang}"`) };
      }
      case "vnu:missing-doctype": {
        if (opts.fragment) return f;
        const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
        return { ...f, fix: insertAt(lines, bom, "<!DOCTYPE html>\n", "Add <!DOCTYPE html>") };
      }
      default:
        return f;
    }
  });
}
