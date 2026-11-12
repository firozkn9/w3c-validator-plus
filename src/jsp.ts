// JSP support. maskJsp() replaces every JSP construct with filler of the same
// length and keeps every line break, so a line/column reported on the masked
// text is the same line/column in the JSP file.
//
// Filler:
// - comments, directives, scriptlets and custom-tag markup produce no output
//   and become spaces;
// - output (<%= %>, ${}, #{}) and custom tags inside an attribute value become
//   a unique placeholder (xxxa, xxxb, ...) so the value stays non-empty and
//   ids stay distinct;
// - output in text becomes a placeholder where text is allowed (<td>,
//   <title>) and spaces where it is not (<table>, <ul>, top level).
import type { Finding } from "./core";

export type JspDocumentStructure = "ignore" | "validate";

export interface JspOptions {
  // "ignore": doctype/html/head/body are blanked and every file is a fragment.
  // "validate": full pages are checked as they are.
  documentStructure: JspDocumentStructure;
  customTagPrefixes: readonly string[];
}

export type MaskKind = "jsp-comment" | "directive" | "declaration" | "scriptlet" | "expression" | "el" | "custom-tag" | "html-structure";

export interface MaskedRegion {
  start: number;
  end: number;
  kind: MaskKind;
  placeholder: boolean; // letters rather than spaces
}

// An attribute whose value is only known at run time.
export interface MaskedAttribute {
  name: string; // lower case
  tagStart: number;
  valueStart: number;
  valueEnd: number;
}

export interface JspMaskOptions {
  customTagPrefixes?: readonly string[]; // added to "jsp" and taglib prefixes
  stripDocumentStructure?: boolean;
}

export interface JspMaskResult {
  text: string;
  regions: MaskedRegion[];
  maskedAttributes: MaskedAttribute[];
  taglibPrefixes: string[];
  hasDoctype: boolean;
  hasHtmlElement: boolean;
  hasTitle: boolean;
  hasMetaCharset: boolean;
}

export const DEFAULT_CUSTOM_TAG_PREFIXES: readonly string[] = ["c", "fmt", "fn", "sql", "x", "spring", "form", "sec", "tiles", "s", "t"];

export const DEFAULT_JSP_OPTIONS: JspOptions = {
  documentStructure: "ignore",
  customTagPrefixes: DEFAULT_CUSTOM_TAG_PREFIXES,
};

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"]);
const STRUCTURE_ELEMENTS = new Set(["html", "head", "body"]);
// Text is not allowed directly inside these, so output there becomes spaces.
const TEXT_FORBIDDEN = new Set([
  "html", "head", "table", "thead", "tbody", "tfoot", "tr", "colgroup", "ul", "ol", "menu", "dl", "select",
  "optgroup", "datalist", "hgroup", "picture", "audio", "video", "frameset",
]);
const RAW_TEXT = new Set(["script", "style"]);
const RCDATA = new Set(["title", "textarea"]);
const XML_SCRIPTING = new Set(["jsp:scriptlet", "jsp:declaration", "jsp:expression"]);

const TAGLIB_RE = /<%@\s*taglib\b[\s\S]*?%>/g;
const PREFIX_ATTR_RE = /\bprefix\s*=\s*["']([^"']+)["']/;
const CUSTOM_TAG_RE = /<\/?([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)/y;
const TAG_NAME_RE = /[A-Za-z][^\s/>]*/y;
const JSP_PATH_RE = /\.(jsp|jspf|tag)$/i;

type State = "text" | "tag" | "comment" | "raw" | "rcdata";

interface TagState {
  name: string;
  start: number;
  isEnd: boolean;
  quote: string | null;
  unquoted: boolean;
  afterEquals: boolean;
  attrName: string;
  attrBoundary: boolean; // the next name character starts a new attribute
  attrs: Set<string>;
  valueStart: number;
  valueMasked: boolean;
}

// Users often map *.jsp to the html language, so look at the file name too.
export function isJspDocument(languageId: string, uri: string): boolean {
  return languageId === "jsp" || JSP_PATH_RE.test(uri.replace(/[?#].*$/, ""));
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

// 0 -> a, 25 -> z, 26 -> aa ...
function toLetters(n: number): string {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function declaredTaglibPrefixes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAGLIB_RE)) {
    const p = PREFIX_ATTR_RE.exec(m[0]);
    if (p?.[1] && !out.includes(p[1])) out.push(p[1]);
  }
  return out;
}

// Index just past the "}" closing an EL expression whose body starts at
// `from`, or -1. Nested braces and quoted strings are skipped.
export function scanElEnd(text: string, from: number): number {
  let depth = 1;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'") {
      for (j++; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j + 1;
  }
  return -1;
}

export function maskJsp(source: string, options: JspMaskOptions = {}): JspMaskResult {
  const n = source.length;
  const out = source.split("");
  const taglibPrefixes = declaredTaglibPrefixes(source);
  const prefixes = new Set(["jsp", ...(options.customTagPrefixes ?? DEFAULT_CUSTOM_TAG_PREFIXES), ...taglibPrefixes]);
  const strip = options.stripDocumentStructure ?? false;

  const regions: MaskedRegion[] = [];
  const maskedAttributes: MaskedAttribute[] = [];
  const stack: string[] = [];
  // Widened on purpose: finishTag() changes it inside a closure, which narrowing can't see.
  let state = "text" as State;
  let rawEnd = "";
  let tag: TagState | undefined;
  let counter = 0;
  let hasDoctype = false;
  let hasHtmlElement = false;
  let hasTitle = false;
  let hasMetaCharset = false;

  const blank = (s: number, e: number) => {
    for (let k = s; k < e; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const fillPlaceholder = (s: number, e: number) => {
    let len = 0;
    for (let k = s; k < e; k++) if (source[k] !== "\n" && source[k] !== "\r") len++;
    const token = ("x".repeat(len) + toLetters(counter++)).slice(-len);
    let t = 0;
    for (let k = s; k < e; k++) if (source[k] !== "\n" && source[k] !== "\r") out[k] = token[t++] ?? "x";
  };

  const outputIsPlaceholder = (at: number): boolean => {
    if (state === "tag" && tag) {
      if (tag.afterEquals && !tag.quote && !tag.unquoted) {
        // href=${x}: the expression starts an unquoted value
        tag.unquoted = true;
        tag.afterEquals = false;
        tag.valueStart = at;
      }
      return tag.quote !== null || tag.unquoted;
    }
    if (state === "rcdata") return true;
    if (state === "text") {
      const top = stack[stack.length - 1];
      return top !== undefined && !TEXT_FORBIDDEN.has(top);
    }
    return false;
  };

  const mask = (s: number, e: number, kind: MaskKind, output: boolean) => {
    if (output && state === "raw" && rawEnd === "</script") {
      // var n = ${count};  ->  var n = 0       ;  so the script still parses
      blank(s, e);
      const k = out.indexOf(" ", s);
      if (k >= 0 && k < e) out[k] = "0";
      regions.push({ start: s, end: e, kind, placeholder: false });
      return;
    }
    const placeholder = output && outputIsPlaceholder(s);
    if (placeholder) {
      fillPlaceholder(s, e);
      if (state === "tag" && tag) tag.valueMasked = true;
    } else {
      blank(s, e);
    }
    regions.push({ start: s, end: e, kind, placeholder });
  };

  // End of the custom tag whose "<" is at `from`; quotes, scriptlets and EL inside are skipped.
  const customTagEnd = (from: number): number => {
    let quote: string | null = null;
    for (let j = from + 1; j < n; ) {
      if (source.startsWith("<%", j)) {
        const k = source.indexOf("%>", j + 2);
        j = k < 0 ? n : k + 2;
        continue;
      }
      if ((source[j] === "$" || source[j] === "#") && source[j + 1] === "{") {
        const e = scanElEnd(source, j + 2);
        if (e > 0) {
          j = e;
          continue;
        }
      }
      const c = source[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        return j + 1;
      }
      j++;
    }
    return n;
  };

  const endValue = (at: number) => {
    if (!tag) return;
    if (tag.valueMasked && tag.attrName) {
      maskedAttributes.push({ name: tag.attrName.toLowerCase(), tagStart: tag.start, valueStart: tag.valueStart, valueEnd: at });
    }
    tag.quote = null;
    tag.unquoted = false;
    tag.valueMasked = false;
  };

  const closeImplied = (name: string) => {
    const top = stack[stack.length - 1];
    if ((name === "li" || name === "option" || name === "p") && top === name) {
      stack.pop();
    } else if ((name === "td" || name === "th") && (top === "td" || top === "th")) {
      stack.pop();
    } else if (name === "tr") {
      while (stack.length && ["td", "th", "tr"].includes(stack[stack.length - 1]!)) stack.pop();
    }
  };

  const finishTag = (end: number) => {
    const t = tag!;
    tag = undefined;
    state = "text";
    const name = t.name;
    if (STRUCTURE_ELEMENTS.has(name)) {
      if (name === "html" && !t.isEnd) hasHtmlElement = true;
      if (strip) {
        blank(t.start, end);
        regions.push({ start: t.start, end, kind: "html-structure", placeholder: false });
        return;
      }
    }
    if (t.isEnd) {
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) stack.length = idx;
      return;
    }
    if (name === "title") hasTitle = true;
    if (name === "meta" && (t.attrs.has("charset") || t.attrs.has("http-equiv"))) hasMetaCharset = true;
    if (VOID_ELEMENTS.has(name)) return;
    closeImplied(name);
    stack.push(name);
    if (RAW_TEXT.has(name)) {
      state = "raw";
      rawEnd = `</${name}`;
    } else if (RCDATA.has(name)) {
      state = "rcdata";
      rawEnd = `</${name}`;
    }
  };

  let i = 0;
  while (i < n) {
    const c = source[i]!;

    // JSP constructs are recognised in every HTML state.
    if (c === "<" && source[i + 1] === "%") {
      if (source.startsWith("<%--", i)) {
        const k = source.indexOf("--%>", i + 4);
        const e = k < 0 ? n : k + 4;
        mask(i, e, "jsp-comment", false);
        i = e;
        continue;
      }
      const k = source.indexOf("%>", i + 2);
      const e = k < 0 ? n : k + 2;
      const marker = source[i + 2];
      const kind: MaskKind = marker === "@" ? "directive" : marker === "!" ? "declaration" : marker === "=" ? "expression" : "scriptlet";
      mask(i, e, kind, kind === "expression");
      i = e;
      continue;
    }
    if ((c === "$" || c === "#") && source[i + 1] === "{" && source[i - 1] !== "\\" && state !== "comment") {
      const e = scanElEnd(source, i + 2);
      if (e > 0) {
        mask(i, e, "el", true);
        i = e;
        continue;
      }
    }
    if (c === "<") {
      CUSTOM_TAG_RE.lastIndex = i;
      const m = CUSTOM_TAG_RE.exec(source);
      if (m && prefixes.has(m[1]!)) {
        let e = customTagEnd(i);
        const full = `${m[1]}:${m[2]}`.toLowerCase();
        if (source[i + 1] !== "/" && XML_SCRIPTING.has(full) && source[e - 2] !== "/") {
          // <jsp:scriptlet>java</jsp:scriptlet>: the body is code, not HTML
          const close = source.toLowerCase().indexOf(`</${full}`, e);
          e = close < 0 ? n : customTagEnd(close);
        }
        mask(i, e, "custom-tag", state === "tag");
        i = e;
        continue;
      }
    }

    // A rough HTML tokenizer: just enough to know where we are.
    switch (state) {
      case "text": {
        if (c !== "<") {
          i++;
          break;
        }
        if (source.startsWith("<!--", i)) {
          state = "comment";
          i += 4;
          break;
        }
        if (source[i + 1] === "!" || source[i + 1] === "?") {
          const k = source.indexOf(">", i);
          const e = k < 0 ? n : k + 1;
          if (/^<!doctype/i.test(source.slice(i, i + 9))) {
            hasDoctype = true;
            if (strip) {
              blank(i, e);
              regions.push({ start: i, end: e, kind: "html-structure", placeholder: false });
            }
          }
          i = e;
          break;
        }
        const isEnd = source[i + 1] === "/";
        TAG_NAME_RE.lastIndex = i + (isEnd ? 2 : 1);
        const nm = TAG_NAME_RE.exec(source);
        if (!nm) {
          i++;
          break;
        }
        tag = {
          name: nm[0].toLowerCase(),
          start: i,
          isEnd,
          quote: null,
          unquoted: false,
          afterEquals: false,
          attrName: "",
          attrBoundary: true,
          attrs: new Set(),
          valueStart: 0,
          valueMasked: false,
        };
        state = "tag";
        i = TAG_NAME_RE.lastIndex;
        break;
      }
      case "tag": {
        const t = tag!;
        if (t.quote) {
          if (c === t.quote) endValue(i);
          i++;
          break;
        }
        if (t.unquoted) {
          if (isSpace(c) || c === ">") {
            endValue(i);
            t.attrBoundary = true;
            if (c === ">") break; // finished on the next pass
          }
          i++;
          break;
        }
        if (c === ">") {
          finishTag(i + 1);
          i++;
          break;
        }
        if (c === "=") {
          t.afterEquals = true;
        } else if ((c === '"' || c === "'") && t.afterEquals) {
          t.quote = c;
          t.afterEquals = false;
          t.valueStart = i + 1;
        } else if (isSpace(c) || c === "/") {
          t.attrBoundary = true;
        } else if (t.afterEquals) {
          t.unquoted = true;
          t.afterEquals = false;
          t.valueStart = i;
        } else {
          if (t.attrBoundary) {
            t.attrName = "";
            t.attrBoundary = false;
          }
          t.attrName += c;
          t.attrs.add(t.attrName.toLowerCase());
        }
        i++;
        break;
      }
      case "comment":
        if (source.startsWith("-->", i)) {
          state = "text";
          i += 3;
        } else {
          i++;
        }
        break;
      case "raw":
      case "rcdata":
        if (c === "<" && source.slice(i, i + rawEnd.length).toLowerCase() === rawEnd) {
          const after = source[i + rawEnd.length];
          if (after === undefined || isSpace(after) || after === ">" || after === "/") {
            state = "text"; // the end tag itself is read in text state
            break;
          }
        }
        i++;
        break;
    }
  }

  return { text: out.join(""), regions, maskedAttributes, taglibPrefixes, hasDoctype, hasHtmlElement, hasTitle, hasMetaCharset };
}

export interface PreparedJsp {
  text: string; // what the HTML checker sees
  lineOffset: number; // lines of synthetic wrapper before the original content
  fragment: boolean;
  mask: JspMaskResult;
}

export function prepareJsp(source: string, options: JspOptions = DEFAULT_JSP_OPTIONS): PreparedJsp {
  const mask = maskJsp(source, {
    customTagPrefixes: options.customTagPrefixes,
    stripDocumentStructure: options.documentStructure === "ignore",
  });
  const fragment = options.documentStructure === "ignore" || !(mask.hasDoctype || mask.hasHtmlElement);
  if (!fragment) return { text: mask.text, lineOffset: 0, fragment, mask };

  // A fragment gets one extra line that opens a document. <head> is left open
  // so meta/link/title/style in the fragment land in the head and the first
  // flow content implies <body>, the same way browsers parse it.
  const prefix =
    '<!DOCTYPE html><html lang="en"><head>' +
    (mask.hasMetaCharset ? "" : '<meta charset="utf-8">') +
    (mask.hasTitle ? "" : "<title>JSP fragment</title>") +
    "\n";
  return { text: prefix + mask.text, lineOffset: 1, fragment, mask };
}

// Only caused by the wrapper, or by a fragment not being a whole page.
const FRAGMENT_ONLY_RULES = new Set(["vnu:missing-doctype", "vnu:missing-lang", "vnu:lang-mismatch", "vnu:missing-h1"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Moves findings from the prepared text back onto the JSP, and drops the ones
// caused by the wrapper or by placeholders (type="${t}" reported as a bad
// value, for="${id}" not matching an element, ...).
export function mapJspFindings(findings: readonly Finding[], prepared: PreparedJsp, originalText: string): Finding[] {
  const starts = [0];
  for (let i = 0; i < originalText.length; i++) if (originalText.charCodeAt(i) === 10) starts.push(i + 1);
  const offsetOf = (line: number, character: number) => Math.min((starts[Math.min(line, starts.length - 1)] ?? 0) + character, originalText.length);
  const lineEnd = (line: number) => (starts[line + 1] ?? originalText.length + 1) - 1;
  const outputRegions = prepared.mask.regions.filter((r) => r.kind === "el" || r.kind === "expression" || r.kind === "custom-tag" || r.kind === "scriptlet");

  const out: Finding[] = [];
  for (const f of findings) {
    let start = { line: f.range.start.line - prepared.lineOffset, character: f.range.start.character };
    const end = { line: f.range.end.line - prepared.lineOffset, character: f.range.end.character };
    if (end.line < 0) continue; // inside the wrapper
    if (start.line < 0) start = { line: 0, character: 0 };

    if (prepared.fragment) {
      if (FRAGMENT_ONLY_RULES.has(f.ruleId)) continue;
      if (f.ruleId === "vnu:missing-required-child" && /[“"']head[”"']/.test(f.message)) continue;
    }

    const from = offsetOf(start.line, start.character);
    const to = offsetOf(end.line, end.character);
    const aboutPlaceholder = prepared.mask.maskedAttributes.some((a) => {
      if (a.valueStart < from || a.valueEnd > to) return false;
      if (f.message.startsWith("CSS:") && a.name === "style") return true;
      return new RegExp(`[“"']${escapeRegExp(a.name)}[”"']`, "i").test(f.message);
    });
    if (aboutPlaceholder) continue;

    // CSS errors on a line where EL output was blanked, e.g. `color: ${c};` in <style>.
    if (f.message.startsWith("CSS:")) {
      const lo = starts[start.line] ?? 0;
      const hi = lineEnd(end.line);
      if (outputRegions.some((r) => r.start <= hi && r.end >= lo)) continue;
    }

    out.push({ ...f, range: { start, end } });
  }
  return out;
}

// --- inline <script> blocks (HTML, or masked JSP which has the same offsets) ---

export interface ScriptBlock {
  code: string;
  offset: number; // of the first character of `code`
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

  for (const m of html.matchAll(SCRIPT_RE)) {
    const start = m.index;
    if (comments.some(([s, e]) => start >= s && start < e)) continue;
    const attrs = m[1] ?? "";
    const t = TYPE_RE.exec(attrs);
    const type = (t ? (t[1] ?? t[2] ?? t[3] ?? "") : "").trim().toLowerCase();
    if (!JS_TYPES.has(type)) continue; // templates, JSON, import maps
    const code = m[2] ?? "";
    if (!code.trim()) continue;
    const offset = start + "<script".length + attrs.length + 1;
    for (; scanned < offset; scanned++) {
      if (html.charCodeAt(scanned) === 10) {
        line++;
        lineStart = scanned + 1;
      }
    }
    blocks.push({ code, offset, line, column: offset - lineStart, module: type === "module" });
  }
  return blocks;
}
