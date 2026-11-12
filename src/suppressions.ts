// Suppression comments, in any comment syntax:
//
//   <!-- webvalidator-disable-next-line vnu:img-missing-alt -->
//   <%-- webvalidator-disable vnu:obsolete-element --%>     until enable or end of file
//   <%-- webvalidator-enable vnu:obsolete-element --%>
//   $(".x"); // webvalidator-disable-line webvalidator/jquery-unscoped-selector
//   /* webvalidator-disable */                              no ids: every rule
//
// Ids are separated by commas or spaces, may use * like the config, and can be
// followed by " -- reason".
import { wildcardToRegExp } from "./config";
import { LineIndex, type Finding, type Fix } from "./core";
import { extractScripts, isJspDocument } from "./jsp";

export type DirectiveKind = "disable" | "enable" | "disable-line" | "disable-next-line";

export interface Directive {
  kind: DirectiveKind;
  line: number;
  ruleIds: string[]; // empty: every rule
}

const DIRECTIVE_RE = /(?:<!--|<%--|\/\/|\/\*)[ \t]*webvalidator-(disable-next-line|disable-line|disable|enable)(?=[\s,]|-->|--%>|\*\/|$)([^\r\n]*)/g;

export function parseDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  text.split("\n").forEach((lineText, line) => {
    for (const m of lineText.matchAll(DIRECTIVE_RE)) {
      let rest = m[2] ?? "";
      const close = rest.search(/--%>|-->|\*\//);
      if (close >= 0) rest = rest.slice(0, close);
      rest = rest.split(/\s--\s/)[0] ?? "";
      const ruleIds = rest
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      out.push({ kind: m[1] as DirectiveKind, line, ruleIds });
    }
  });
  return out;
}

function covers(ids: readonly string[], ruleId: string): boolean {
  return ids.length === 0 || ids.some((p) => (p.includes("*") ? wildcardToRegExp(p).test(ruleId) : p === ruleId));
}

function isSuppressed(f: Finding, sorted: readonly Directive[]): boolean {
  const line = f.range.start.line;
  let disabled = false;
  for (const d of sorted) {
    if (d.line > line) break;
    if (d.kind === "disable" && covers(d.ruleIds, f.ruleId)) disabled = true;
    else if (d.kind === "enable" && covers(d.ruleIds, f.ruleId)) disabled = false;
  }
  if (disabled) return true;
  return sorted.some(
    (d) => ((d.kind === "disable-line" && d.line === line) || (d.kind === "disable-next-line" && d.line === line - 1)) && covers(d.ruleIds, f.ruleId),
  );
}

export function applySuppressions(findings: readonly Finding[], text: string): Finding[] {
  const directives = parseDirectives(text);
  if (directives.length === 0) return [...findings];
  directives.sort((a, b) => a.line - b.line);
  return findings.filter((f) => !isSuppressed(f, directives));
}

// --- the "Disable ... for this line / file" quick fixes ---

export type CommentStyle = "html" | "jsp" | "js";

function fileCommentStyle(languageId: string, uri: string): CommentStyle {
  if (languageId === "javascript") return "js";
  return isJspDocument(languageId, uri) ? "jsp" : "html";
}

// JavaScript comments inside scripts, otherwise the page's own syntax.
export function commentStyleAt(text: string, languageId: string, uri: string, offset: number): CommentStyle {
  if (languageId !== "javascript" && extractScripts(text).some((b) => offset >= b.offset && offset <= b.offset + b.code.length)) return "js";
  return fileCommentStyle(languageId, uri);
}

function directiveComment(style: CommentStyle, directive: string, ruleId: string): string {
  const body = `webvalidator-${directive} ${ruleId}`;
  if (style === "js") return directive === "disable" ? `/* ${body} */` : `// ${body}`;
  return style === "jsp" ? `<%-- ${body} --%>` : `<!-- ${body} -->`;
}

function insertion(title: string, line: number, character: number, newText: string): Fix {
  const at = { line, character };
  return { title, edits: [{ range: { start: at, end: at }, newText }] };
}

// Puts a disable-next-line comment above `line`, indented like it.
export function disableForLineFix(text: string, languageId: string, uri: string, line: number, ruleId: string): Fix {
  const lineStart = new LineIndex(text).offsetAt({ line, character: 0 });
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
  const style = commentStyleAt(text, languageId, uri, lineStart + indent.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return insertion(`Disable ${ruleId} for this line`, line, 0, `${indent}${directiveComment(style, "disable-next-line", ruleId)}${eol}`);
}

// Puts a disable comment at the top, after a "#!" line or a BOM.
export function disableForFileFix(text: string, languageId: string, uri: string, ruleId: string): Fix {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = text.startsWith("#!") ? 1 : 0;
  const character = line === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const comment = directiveComment(fileCommentStyle(languageId, uri), "disable", ruleId);
  return insertion(`Disable ${ruleId} for this file`, line, character, `${comment}${eol}`);
}
