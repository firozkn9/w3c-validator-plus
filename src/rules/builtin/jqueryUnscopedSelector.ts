/**
 * ESLint rule: warn about jQuery selectors that match the whole page instead
 * of the current process/tab.
 *
 * In single-page applications the same JSP/HTML partial can be loaded into
 * several tabs at once, so `$(".name")` finds elements in every tab.
 *
 * Flagged:   $(".name")  $("input")  $("[name=x]")  $(".row-" + id)  $(".name", $tab)
 *            $(document).find(".name")  $("body").find(".name")
 * Scoped:    $(tabSelector + " .name")  $(`${tab} .name`)  $tab.find(".name")
 *            $(this).find(".name")  $("#saveBtn")  $("#" + id)  $("<div>")
 */
import type { Rule } from "eslint";
import { DYNAMIC, isPageWideReceiverSelector, unscopedSegments } from "./jquerySelector";

export const JQUERY_UNSCOPED_SELECTOR = "jquery-unscoped-selector";

/** Source range (ESLint loc: 1-based line, 0-based column) whose text is a run-time value, e.g. masked JSP EL. */
export interface DynamicRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface JqueryUnscopedSelectorOptions {
  /** Names jQuery is called by. Default: `$`, `jQuery`. */
  functionNames?: string[];
  /** Treat `$(selector, context)` as scoped. Default: false. */
  allowContextArgument?: boolean;
  dynamicRanges?: DynamicRange[];
}

// Minimal structural view of the ESTree nodes we inspect.
type Node = {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null;
  [key: string]: unknown;
};

const str = (n: Node | undefined): string | undefined =>
  n && n.type === "Literal" && typeof n.value === "string" ? n.value : undefined;

const rule: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require jQuery selectors to be scoped to the current process/tab",
    },
    schema: [
      {
        type: "object",
        properties: {
          functionNames: { type: "array", items: { type: "string" } },
          allowContextArgument: { type: "boolean" },
          dynamicRanges: { type: "array" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unscoped:
        'Add current process / tab selector before {{selectors}}: it matches the whole page. Example: $(tabSelector + " {{first}}") or $tab.find("{{first}}").',
      unscopedFind:
        'Add current process / tab selector before {{selectors}}: {{receiver}}.find() searches the whole page. Example: $tab.find("{{first}}").',
    },
  },

  create(context) {
    const opts = (context.options[0] ?? {}) as JqueryUnscopedSelectorOptions;
    const names = new Set(opts.functionNames ?? ["$", "jQuery"]);
    const dynamic = opts.dynamicRanges ?? [];
    const source = context.sourceCode;

    /** String value of a literal with masked (dynamic) characters marked. */
    const literalValue = (n: Node): string | undefined => {
      const value = str(n);
      if (value === undefined || !n.loc || dynamic.length === 0) return value;
      const { start, end } = n.loc;
      if (start.line !== end.line) return value;
      const chars = value.split("");
      const first = start.column + 1; // after the opening quote
      for (const r of dynamic) {
        if (r.line > start.line || r.endLine < start.line) continue;
        const from = r.line === start.line ? r.column : 0;
        const to = r.endLine === start.line ? r.endColumn : end.column;
        for (let c = Math.max(from, first); c < Math.min(to, end.column - 1); c++) {
          if (c - first < chars.length) chars[c - first] = DYNAMIC;
        }
      }
      return chars.join("");
    };

    /** Selector text with DYNAMIC for expressions, or undefined if the argument is not built from strings. */
    const selectorOf = (n: Node | undefined): string | undefined => {
      if (!n) return undefined;
      if (n.type === "Literal") return literalValue(n);
      if (n.type === "TemplateLiteral") {
        const quasis = n.quasis as Array<{ value: { cooked: string | null; raw: string } }>;
        return quasis.map((q) => q.value.cooked ?? q.value.raw).join(DYNAMIC);
      }
      if (n.type === "BinaryExpression" && n.operator === "+") {
        const parts: string[] = [];
        let hasString = false;
        const walk = (e: Node) => {
          if (e.type === "BinaryExpression" && e.operator === "+") {
            walk(e.left as Node);
            walk(e.right as Node);
            return;
          }
          const s = e.type === "Literal" || e.type === "TemplateLiteral" ? selectorOf(e) : undefined;
          if (s !== undefined && (e.type === "TemplateLiteral" || str(e) !== undefined)) {
            hasString = true;
            parts.push(s);
          } else {
            parts.push(DYNAMIC);
          }
        };
        walk(n);
        return hasString ? parts.join("") : undefined;
      }
      return undefined;
    };

    const isJQueryCall = (n: Node): boolean =>
      n.type === "CallExpression" &&
      (n.callee as Node).type === "Identifier" &&
      names.has((n.callee as Node).name as string) &&
      (n.arguments as Node[]).length > 0;

    const isPageObject = (n: Node): boolean =>
      (n.type === "Identifier" && (n.name === "document" || n.name === "window")) ||
      (n.type === "MemberExpression" &&
        (n.object as Node).type === "Identifier" &&
        (n.object as Node).name === "document" &&
        ["body", "documentElement"].includes(((n.property as Node).name as string) ?? ""));

    /** "global": searches the whole page; "flagged": an unscoped $() already reported; "scoped": anything else. */
    const receiverKind = (n: Node): "global" | "flagged" | "scoped" => {
      if (isJQueryCall(n)) {
        const arg = (n.arguments as Node[])[0]!;
        if (isPageObject(arg)) return "global";
        const sel = selectorOf(arg);
        if (sel === undefined) return "scoped";
        if (isPageWideReceiverSelector(sel)) return "global";
        return unscopedSegments(sel).length > 0 ? "flagged" : "scoped";
      }
      // $tab.children().first().find(...): look through the chain
      if (n.type === "CallExpression" && (n.callee as Node).type === "MemberExpression") {
        return receiverKind((n.callee as Node).object as Node);
      }
      if (isPageObject(n)) return "global";
      return "scoped";
    };

    const quoteList = (segments: string[]) => segments.map((s) => `"${s}"`).join(", ");

    return {
      CallExpression(node) {
        const n = node as unknown as Node;
        const args = n.arguments as Node[];

        if (isJQueryCall(n)) {
          const arg = args[0]!;
          if (args.length > 1 && opts.allowContextArgument) return;
          const sel = selectorOf(arg);
          if (sel === undefined || isPageWideReceiverSelector(sel)) return;
          const segments = unscopedSegments(sel);
          if (segments.length === 0) return;
          context.report({
            node: arg as unknown as Rule.Node,
            messageId: "unscoped",
            data: { selectors: quoteList(segments), first: segments[0]! },
          });
          return;
        }

        const callee = n.callee as Node;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          (callee.property as Node).name === "find" &&
          args.length > 0 &&
          receiverKind(callee.object as Node) === "global"
        ) {
          const sel = selectorOf(args[0]);
          if (sel === undefined) return;
          const segments = unscopedSegments(sel);
          if (segments.length === 0) return;
          context.report({
            node: args[0] as unknown as Rule.Node,
            messageId: "unscopedFind",
            data: {
              selectors: quoteList(segments),
              first: segments[0]!,
              receiver: source.getText(callee.object as unknown as Rule.Node),
            },
          });
        }
      },
    };
  },
};

export default rule;
