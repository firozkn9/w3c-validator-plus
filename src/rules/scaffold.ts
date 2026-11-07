/**
 * Files written by "Web Validator: Create Custom Rule".
 */
import type { RuleLanguage } from "./RuleApi";

export const RULE_ID_PATTERN = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i;

export function ruleFileName(ruleId: string): string {
  return `${ruleId.split("/").pop()!.replace(/[^\w.-]/g, "-")}.js`;
}

export function ruleTemplate(ruleId: string, languages: RuleLanguage[]): string {
  const html = languages.includes("html") || languages.includes("jsp");
  const js = languages.includes("javascript");
  return `// @ts-check
// Custom rule for the Web Standards Validator extension.
// Rules in this folder run only in trusted workspaces. Save the file to reload it.
// Turn the rule off or change its severity in .webvalidator.json:
//   "rules": { "${ruleId}": "error" }          or  ["warning", { ...options }]
// Suppress it on one line with a comment:
//   <!-- webvalidator-disable-next-line ${ruleId} -->

/** @param {import("./webvalidator").RuleModule} rule */
const defineRule = (rule) => rule;

module.exports = defineRule({
  id: ${JSON.stringify(ruleId)},
  languages: ${JSON.stringify(languages)},
  meta: {
    description: "Describe what this rule checks",
    defaultSeverity: "warning", // "error" | "warning" | "info" | "off"
    // docsUrl: "https://wiki.example.com/web-rules#my-rule",
  },

  create(ctx) {
    // ctx.text      original document text      ctx.options  options from the config
    // ctx.language  "html" | "jsp" | "javascript"
    // ctx.querySelectorAll("img:not([alt])")   CSS selector over the document's elements
    // ctx.report({ node | range | loc | offset+length, message, attribute?, fix?, suggestions? })
    return {
${
  html
    ? `      // Called for every element written in the page (JSP tags and EL are already masked).
      element(el) {
        // el.tagName, el.attrs (lower-case names), el.parent, el.children, el.textContent,
        // el.startTag / el.endTag / el.range, el.attrRanges[name]
        if (el.tagName === "a" && el.attrs.target === "_blank" && !/\\bnoopener\\b/.test(el.attrs.rel ?? "")) {
          ctx.report({
            node: el,
            attribute: "target",
            message: 'Add rel="noopener" to links that open a new tab',
          });
        }
      },
`
    : ""
}${
  js
    ? `
      // Called for every inline <script> and for whole .js files.
      script(script) {
        // script.code, script.range, script.ast (ESTree Program; undefined on syntax errors)
        // AST nodes have .loc with 1-based lines: ctx.report({ loc: node.loc, message })
        if (/\\bconsole\\.log\\(/.test(script.code)) {
          const offset = ctx.offsetAt(script.range.start) + script.code.indexOf("console.log(");
          ctx.report({ offset, length: "console.log".length, message: "Remove console.log before release" });
        }
      },
`
    : ""
}    };
  },
});
`;
}

/** Type declarations next to the rules, for editor IntelliSense in plain JavaScript. */
export const RULE_TYPES_DTS = `// Types for Web Standards Validator custom rules (generated; safe to overwrite).
export type Severity = "error" | "warning" | "info";
export type RuleLanguage = "html" | "jsp" | "javascript";
export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface TextEdit { range: Range; newText: string }
export interface Fix { title: string; edits: TextEdit[] }

export interface RuleElement {
  tagName: string;
  attrs: Readonly<Record<string, string>>;
  parent?: RuleElement;
  children: RuleElement[];
  hasText: boolean;
  textContent: string;
  startTag: Range;
  endTag?: Range;
  range: Range;
  attrRanges: Readonly<Record<string, Range>>;
}
export interface RuleTextNode { value: string; range: Range; parent?: RuleElement }
export interface RuleComment { value: string; range: Range }
export interface RuleScript { code: string; range: Range; module: boolean; ast?: any }

export interface ReportDescriptor {
  message: string;
  node?: RuleElement | RuleTextNode | RuleComment;
  attribute?: string;
  range?: Range;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  offset?: number;
  length?: number;
  severity?: Severity;
  fix?: Fix;
  suggestions?: Fix[];
}

export interface RuleContext {
  readonly uri: string;
  readonly fileName: string;
  readonly language: RuleLanguage;
  readonly text: string;
  readonly options: readonly unknown[];
  readonly elements: readonly RuleElement[];
  querySelectorAll(selector: string): RuleElement[];
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
  report(descriptor: ReportDescriptor): void;
}

export interface RuleVisitors {
  element?(element: RuleElement): void;
  text?(node: RuleTextNode): void;
  comment?(node: RuleComment): void;
  script?(script: RuleScript): void;
  end?(): void;
}

export interface RuleModule {
  id: string;
  languages?: RuleLanguage[];
  meta?: { description: string; defaultSeverity?: Severity | "off"; docsUrl?: string };
  create(context: RuleContext): RuleVisitors | void;
}
`;
