/**
 * Public API for custom rules.
 *
 * A rule is a plain object (or `defineRule({...})`) exported from a `.js`,
 * `.cjs` or `.mjs` file in one of the `rulesDirectories`, or from an npm
 * package named `webvalidator-rules-*`:
 *
 * ```js
 * module.exports = {
 *   id: "custom/no-inline-styles",
 *   languages: ["html", "jsp"],
 *   meta: { description: "Use CSS classes instead of style attributes", defaultSeverity: "warning" },
 *   create(ctx) {
 *     return {
 *       element(el) {
 *         if (el.attrs.style !== undefined) ctx.report({ node: el, attribute: "style", message: "Move inline styles to CSS" });
 *       },
 *     };
 *   },
 * };
 * ```
 *
 * Positions are zero-based (line, character), like VS Code. In JSP files the
 * DOM is built from the masked page (JSP constructs replaced by filler of the
 * same length), so element positions match the original file.
 */
import type { Fix, Position, Range, Severity } from "../engines/Engine";
import type { SelectableElement } from "./selector";

export type { Fix, Position, Range, Severity };

export type RuleLanguage = "html" | "jsp" | "javascript";

export interface RuleElement extends SelectableElement {
  /** Lower-case tag name, e.g. `img`. */
  tagName: string;
  /** Attributes by lower-case name; valueless attributes have the value `""`. */
  attrs: Readonly<Record<string, string>>;
  parent?: RuleElement;
  children: RuleElement[];
  /** True when the element contains non-whitespace text directly. */
  hasText: boolean;
  /** Concatenated text content of the element and its descendants. */
  textContent: string;
  /** Range of the start tag (`<img …>`). */
  startTag: Range;
  /** Range of the end tag, when present in the source. */
  endTag?: Range;
  /** Range of the whole element. */
  range: Range;
  /** Ranges of attributes (`name="value"`) by lower-case name. */
  attrRanges: Readonly<Record<string, Range>>;
}

export interface RuleTextNode {
  value: string;
  range: Range;
  parent?: RuleElement;
}

export interface RuleComment {
  value: string;
  range: Range;
}

export interface RuleScript {
  /** Script source (an inline `<script>` body, or the whole `.js` file). */
  code: string;
  /** Range of `code` in the document. */
  range: Range;
  module: boolean;
  /**
   * ESTree `Program` parsed by ESLint's parser (espree), or `undefined` when
   * the script has syntax errors. Node `loc` values are document positions
   * with 1-based lines and 0-based columns (ESTree convention).
   */
  ast?: unknown;
}

export interface ReportDescriptor {
  message: string;
  /** Element, text node or comment to report on (an element reports its start tag). */
  node?: RuleElement | RuleTextNode | RuleComment;
  /** With an element `node`: report on this attribute instead of the whole start tag. */
  attribute?: string;
  /** Explicit zero-based range. */
  range?: Range;
  /** ESTree location (1-based line, 0-based column), e.g. `astNode.loc`. */
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  /** Offset and length in `ctx.text`. */
  offset?: number;
  length?: number;
  /** Overrides `meta.defaultSeverity` (a severity set in the config still wins). */
  severity?: Severity;
  fix?: Fix;
  suggestions?: Fix[];
}

export interface RuleContext {
  readonly uri: string;
  readonly fileName: string;
  /** `html`, `jsp` or `javascript`. */
  readonly language: RuleLanguage;
  /** Original document text. */
  readonly text: string;
  /** Options from the config: `"rules": { "my/rule": ["warning", { ... }] }`. */
  readonly options: readonly unknown[];
  /** All elements in document order (empty for JavaScript files). */
  readonly elements: readonly RuleElement[];
  /** Elements matching a CSS selector (see the README for supported syntax). */
  querySelectorAll(selector: string): RuleElement[];
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
  report(descriptor: ReportDescriptor): void;
}

export interface RuleVisitors {
  element?(element: RuleElement): void;
  text?(node: RuleTextNode): void;
  comment?(node: RuleComment): void;
  /** Called for each inline `<script>` and for whole `.js` files. */
  script?(script: RuleScript): void;
  /** Called after all other visitors. */
  end?(): void;
}

export interface RuleMeta {
  description: string;
  /** Default `warning`. `off` makes the rule opt-in via the config. */
  defaultSeverity?: Severity | "off";
  docsUrl?: string;
}

export interface RuleModule {
  /** Unique id, conventionally `scope/name`, e.g. `custom/no-inline-styles`. */
  id: string;
  /** Default `["html", "jsp"]`. */
  languages?: RuleLanguage[];
  meta?: RuleMeta;
  create(context: RuleContext): RuleVisitors | void;
}

/** Identity helper that gives editors type information. */
export function defineRule(rule: RuleModule): RuleModule {
  return rule;
}
