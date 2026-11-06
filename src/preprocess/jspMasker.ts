/**
 * JSP → HTML masking with identical offsets.
 *
 * Every JSP-only construct is replaced by characters of the same length and
 * every line break is kept, so a (line, column) reported on the masked text is
 * the same (line, column) in the original file. Standard HTML is left
 * untouched, except `<!DOCTYPE>`, `<html>`, `<head>` and `<body>` tags when
 * `stripDocumentStructure` is set.
 *
 * Fill rules:
 * - Code and markup that produce no output (comments, directives, scriptlets,
 *   custom-tag markup) become spaces.
 * - Output expressions (`<%= %>`, `${}`, `#{}`) and custom tags used inside an
 *   attribute value become a unique letter placeholder (`xxxa`, `xxxb`, …) so
 *   the attribute stays non-empty and ids stay distinct.
 * - Output expressions in text become a placeholder where text is allowed
 *   (e.g. `<title>`, `<td>`), and spaces where it is not (`<table>`, `<ul>`,
 *   top level, `<script>`, `<style>`).
 */

export type MaskKind =
  | "jsp-comment"
  | "directive"
  | "declaration"
  | "scriptlet"
  | "expression"
  | "el"
  | "custom-tag"
  | "html-structure";

export interface MaskedRegion {
  start: number;
  end: number;
  kind: MaskKind;
  /** True when filled with placeholder letters rather than spaces. */
  placeholder: boolean;
}

/** An HTML attribute whose value contains a placeholder (its real value is only known at run time). */
export interface MaskedAttribute {
  /** Lower-case attribute name. */
  name: string;
  tagStart: number;
  valueStart: number;
  valueEnd: number;
}

export interface JspMaskOptions {
  /** Prefixes treated as custom tags in addition to `jsp` and taglib-declared prefixes. */
  customTagPrefixes?: readonly string[];
  /** Blank out `<!DOCTYPE>`, `<html>`, `<head>`, `<body>` (start and end tags). */
  stripDocumentStructure?: boolean;
}

export interface JspMaskResult {
  text: string;
  regions: MaskedRegion[];
  maskedAttributes: MaskedAttribute[];
  /** Prefixes declared with `<%@ taglib prefix="…" %>`. */
  taglibPrefixes: string[];
  hasDoctype: boolean;
  hasHtmlElement: boolean;
  hasTitle: boolean;
  hasMetaCharset: boolean;
}

export const DEFAULT_CUSTOM_TAG_PREFIXES: readonly string[] = [
  "c", "fmt", "fn", "sql", "x", "spring", "form", "sec", "tiles", "s", "t",
];

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen",
]);
const STRUCTURE_ELEMENTS = new Set(["html", "head", "body"]);
/** Elements in which text content is not allowed (output there is masked with spaces). */
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

type State = "text" | "tag" | "comment" | "raw" | "rcdata";

interface TagState {
  name: string;
  start: number;
  isEnd: boolean;
  quote: string | null;
  unquoted: boolean;
  afterEquals: boolean;
  attrName: string;
  /** True right after whitespace/tag name, i.e. the next name char starts a new attribute. */
  attrBoundary: boolean;
  attrs: Set<string>;
  valueStart: number;
  valueMasked: boolean;
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

function toLetters(n: number): string {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Collects taglib prefixes declared anywhere in the file. */
export function declaredTaglibPrefixes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAGLIB_RE)) {
    const p = PREFIX_ATTR_RE.exec(m[0]);
    if (p?.[1] && !out.includes(p[1])) out.push(p[1]);
  }
  return out;
}

/**
 * Returns the index just after the `}` that closes an EL expression whose
 * body starts at `from`, honouring nested braces and quoted strings, or -1.
 */
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
  // `as State`: finishTag() (a closure) switches to raw/rcdata, which TS's narrowing cannot see.
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

  /** Whether output written at the current position should become a placeholder. */
  const outputIsPlaceholder = (at: number): boolean => {
    if (state === "tag" && tag) {
      if (tag.afterEquals && !tag.quote && !tag.unquoted) {
        // `href=${x}`: the expression starts an unquoted value
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
    const placeholder = output && outputIsPlaceholder(s);
    if (placeholder) {
      fillPlaceholder(s, e);
      if (state === "tag" && tag) tag.valueMasked = true;
    } else {
      blank(s, e);
    }
    regions.push({ start: s, end: e, kind, placeholder });
  };

  /** End of a custom tag starting at `from` (`<`), skipping quotes, scriptlets and EL. */
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
    if ((name === "li" && top === "li") || (name === "option" && top === "option") || (name === "p" && top === "p")) {
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

    // ---- JSP-level constructs: recognised in every HTML state ----
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
      const kind: MaskKind =
        marker === "@" ? "directive" : marker === "!" ? "declaration" : marker === "=" ? "expression" : "scriptlet";
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
        const isEnd = source[i + 1] === "/";
        if (!isEnd && XML_SCRIPTING.has(full) && source[e - 2] !== "/") {
          // <jsp:scriptlet>java</jsp:scriptlet>: the body is code, not HTML
          const close = source.toLowerCase().indexOf(`</${full}`, e);
          e = close < 0 ? n : customTagEnd(close);
        }
        mask(i, e, "custom-tag", state === "tag");
        i = e;
        continue;
      }
    }

    // ---- HTML tokenizer (approximate, enough to know the context) ----
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
            if (c === ">") break; // handled on the next iteration
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
            state = "text"; // the end tag itself is parsed in text state
            break;
          }
        }
        i++;
        break;
    }
  }

  return {
    text: out.join(""),
    regions,
    maskedAttributes,
    taglibPrefixes,
    hasDoctype,
    hasHtmlElement,
    hasTitle,
    hasMetaCharset,
  };
}
