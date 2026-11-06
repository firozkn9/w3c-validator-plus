import type { Finding } from "../engines/Engine";
import { DEFAULT_CUSTOM_TAG_PREFIXES, maskJsp, type JspMaskResult } from "./jspMasker";

export type JspDocumentStructure = "ignore" | "validate";

export interface JspOptions {
  /**
   * `ignore`: `<!DOCTYPE>`, `<html>`, `<head>`, `<body>` are blanked and the
   * file is always validated as a fragment (includes, SPA partials, split
   * header/footer files).
   * `validate`: full pages are validated as-is; files without `<html>` or
   * `<!DOCTYPE>` are still validated as fragments.
   */
  documentStructure: JspDocumentStructure;
  customTagPrefixes: readonly string[];
}

export const DEFAULT_JSP_OPTIONS: JspOptions = {
  documentStructure: "ignore",
  customTagPrefixes: DEFAULT_CUSTOM_TAG_PREFIXES,
};

export interface PreparedJsp {
  /** Text sent to the HTML validator. */
  text: string;
  /** Lines added before the original content (the synthetic wrapper). */
  lineOffset: number;
  fragment: boolean;
  mask: JspMaskResult;
}

const JSP_PATH_RE = /\.(jsp|jspf|tag)$/i;

/** True for JSP documents, whatever language id the editor gave them (users often map *.jsp to html). */
export function isJspDocument(languageId: string, uri: string): boolean {
  if (languageId === "jsp") return true;
  const path = uri.replace(/[?#].*$/, "");
  return JSP_PATH_RE.test(path);
}

export function prepareJsp(source: string, options: JspOptions = DEFAULT_JSP_OPTIONS): PreparedJsp {
  const mask = maskJsp(source, {
    customTagPrefixes: options.customTagPrefixes,
    stripDocumentStructure: options.documentStructure === "ignore",
  });
  const fragment = options.documentStructure === "ignore" || !(mask.hasDoctype || mask.hasHtmlElement);
  if (!fragment) return { text: mask.text, lineOffset: 0, fragment, mask };

  // One synthetic line that opens a complete document. The head is left open so
  // metadata content (meta, link, title, style) in the fragment stays in the head
  // and the first flow content implies <body>, exactly as browsers parse it.
  const prefix =
    '<!DOCTYPE html><html lang="en"><head>' +
    (mask.hasMetaCharset ? "" : '<meta charset="utf-8">') +
    (mask.hasTitle ? "" : "<title>JSP fragment</title>") +
    "\n";
  return { text: prefix + mask.text, lineOffset: 1, fragment, mask };
}

/** Findings that only arise from the synthetic wrapper or from a missing page structure. */
const FRAGMENT_ONLY_RULES = new Set(["vnu:missing-doctype", "vnu:missing-lang", "vnu:lang-mismatch", "vnu:missing-h1"]);

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Maps findings on the prepared text back to the original JSP and drops
 * findings caused by the wrapper or by placeholders (e.g. `type="${t}"`
 * reported as a bad value, or `for="${id}"` not pointing at a real element).
 */
export function mapJspFindings(findings: readonly Finding[], prepared: PreparedJsp, originalText: string): Finding[] {
  const starts = lineStartsOf(originalText);
  const offsetOf = (line: number, character: number) =>
    Math.min((starts[Math.min(line, starts.length - 1)] ?? 0) + character, originalText.length);
  const lineEnd = (line: number) => (starts[line + 1] ?? originalText.length + 1) - 1;
  const outputRegions = prepared.mask.regions.filter((r) => r.kind === "el" || r.kind === "expression" || r.kind === "custom-tag" || r.kind === "scriptlet");

  const out: Finding[] = [];
  for (const f of findings) {
    let { start, end } = f.range;
    start = { line: start.line - prepared.lineOffset, character: start.character };
    end = { line: end.line - prepared.lineOffset, character: end.character };
    if (end.line < 0) continue; // entirely inside the wrapper
    if (start.line < 0) start = { line: 0, character: 0 };

    if (prepared.fragment) {
      if (FRAGMENT_ONLY_RULES.has(f.ruleId)) continue;
      if (f.ruleId === "vnu:missing-required-child" && /[“"']head[”"']/.test(f.message)) continue;
    }

    const from = offsetOf(start.line, start.character);
    const to = offsetOf(end.line, end.character);

    // A placeholder value inside this tag, and the message is about that attribute.
    const aboutPlaceholder = prepared.mask.maskedAttributes.some((a) => {
      if (a.valueStart < from || a.valueEnd > to) return false;
      if (f.message.startsWith("CSS:") && a.name === "style") return true;
      return new RegExp(`[“"']${escapeRegExp(a.name)}[”"']`, "i").test(f.message);
    });
    if (aboutPlaceholder) continue;

    // CSS errors on a line where EL/scriptlet output was blanked (e.g. `color: ${c};` in <style>).
    if (f.message.startsWith("CSS:")) {
      const lo = starts[start.line] ?? 0;
      const hi = lineEnd(end.line);
      if (outputRegions.some((r) => r.start <= hi && r.end >= lo)) continue;
    }

    out.push({ ...f, range: { start, end } });
  }
  return out;
}
