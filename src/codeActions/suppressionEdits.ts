/**
 * Builds the text edits behind "Disable rule for this line / this file".
 */
import type { Fix } from "../engines/Engine";
import { isJspDocument } from "../preprocess/jspDocument";
import { extractScripts } from "../preprocess/scriptExtractor";
import { LineIndex } from "../rules/dom";

export type CommentStyle = "html" | "jsp" | "js";

/** Comment syntax valid at a position: JS inside scripts and .js files, else HTML or JSP. */
export function commentStyleAt(text: string, languageId: string, uri: string, offset: number): CommentStyle {
  if (languageId === "javascript") return "js";
  const inScript = extractScripts(text).some((b) => offset >= b.offset && offset <= b.offset + b.code.length);
  if (inScript) return "js";
  return isJspDocument(languageId, uri) ? "jsp" : "html";
}

export function directiveComment(style: CommentStyle, directive: string, ruleId: string): string {
  const body = `webvalidator-${directive} ${ruleId}`;
  switch (style) {
    case "js":
      return directive === "disable" ? `/* ${body} */` : `// ${body}`;
    case "jsp":
      return `<%-- ${body} --%>`;
    case "html":
      return `<!-- ${body} -->`;
  }
}

/** Inserts `webvalidator-disable-next-line <rule>` above `line`, with the same indentation. */
export function disableForLineFix(text: string, languageId: string, uri: string, line: number, ruleId: string): Fix {
  const lines = new LineIndex(text);
  const lineStart = lines.offsetAt({ line, character: 0 });
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
  const style = commentStyleAt(text, languageId, uri, lineStart + indent.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return {
    title: `Disable ${ruleId} for this line`,
    edits: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText: `${indent}${directiveComment(style, "disable-next-line", ruleId)}${eol}` }],
  };
}

/** Inserts `webvalidator-disable <rule>` at the top of the file. */
export function disableForFileFix(text: string, languageId: string, uri: string, ruleId: string): Fix {
  const style: CommentStyle = languageId === "javascript" ? "js" : isJspDocument(languageId, uri) ? "jsp" : "html";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Keep a "#!" line or a BOM first.
  let line = 0;
  if (text.startsWith("#!")) line = 1;
  const character = line === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  return {
    title: `Disable ${ruleId} for this file`,
    edits: [{ range: { start: { line, character }, end: { line, character } }, newText: `${directiveComment(style, "disable", ruleId)}${eol}` }],
  };
}
