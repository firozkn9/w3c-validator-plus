// JavaScript checks for .js files and inline <script> blocks, with ESLint's
// Linter used as a library (no ESLint config files are read): syntax errors,
// a set of core rules that catch real bugs, and jquery-unscoped-selector.
import type { Rule } from "eslint";
import type { Linter } from "eslint/universal";
import { defaultContext, ruleSettingFor, type ResolvedConfig, type RuleSetting } from "./config";
import {
  abortError,
  Emitter,
  LineIndex,
  type Engine,
  type EngineStatus,
  type Finding,
  type Fix,
  type Logger,
  type Severity,
  type SourceDocument,
  type ValidationContext,
} from "./core";
import { extractScripts, isJspDocument, maskJsp, type ScriptBlock } from "./jsp";

export const ESLINT_PREFIX = "eslint:";
export const SYNTAX_ERROR_RULE = "eslint:syntax-error";
const ESLINT_SOURCE = "ECMAScript/ESLint";
const PLUGIN = "webvalidator";
const JQUERY_RULE_NAME = "jquery-unscoped-selector";
export const JQUERY_RULE_ID = `${PLUGIN}/${JQUERY_RULE_NAME}`;

// On by default: likely bugs only, nothing stylistic. no-undef and
// no-unused-vars are left out because inline scripts share globals with each
// other and with HTML event attributes.
export const ESLINT_DEFAULT_RULES: Readonly<Record<string, Severity>> = {
  "for-direction": "error",
  "getter-return": "error",
  "no-async-promise-executor": "error",
  "no-compare-neg-zero": "error",
  "no-cond-assign": "error",
  "no-const-assign": "error",
  "no-constant-binary-expression": "error",
  "no-constant-condition": "warning",
  "no-control-regex": "warning",
  "no-debugger": "warning",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-else-if": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-empty-character-class": "error",
  "no-empty-pattern": "error",
  "no-ex-assign": "error",
  "no-fallthrough": "warning",
  "no-func-assign": "error",
  "no-import-assign": "error",
  "no-invalid-regexp": "error",
  "no-irregular-whitespace": "warning",
  "no-loss-of-precision": "error",
  "no-misleading-character-class": "error",
  "no-new-native-nonconstructor": "error",
  "no-obj-calls": "error",
  "no-self-assign": "error",
  "no-setter-return": "error",
  "no-sparse-arrays": "warning",
  "no-unexpected-multiline": "error",
  "no-unreachable": "warning",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-unused-labels": "warning",
  "no-useless-backreference": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
};

// Core rules to run, by ESLint name. "eslint:<rule>" (or "eslint:*") in the
// config changes or turns off a default, and turns on any other core rule.
export function eslintRulesFor(config: ResolvedConfig): Record<string, RuleSetting> {
  const out: Record<string, RuleSetting> = {};
  for (const [name, severity] of Object.entries(ESLINT_DEFAULT_RULES)) {
    const s = ruleSettingFor(config, ESLINT_PREFIX + name) ?? { severity, options: [] };
    if (s.severity !== "off") out[name] = s;
  }
  for (const [id, s] of config.rules) {
    if (!id.startsWith(ESLINT_PREFIX) || id === SYNTAX_ERROR_RULE) continue;
    const name = id.slice(ESLINT_PREFIX.length);
    if (s.severity === "off") delete out[name];
    else out[name] = s;
  }
  return out;
}

// Where JSP put a run-time value into the script (ESLint loc: 1-based line, 0-based column).
export interface DynamicRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface LintUnit {
  block: ScriptBlock;
  dynamicRanges: DynamicRange[];
}

// The whole file for JavaScript, otherwise one unit per inline script.
export function lintUnits(doc: SourceDocument, customTagPrefixes: readonly string[]): LintUnit[] {
  if (doc.languageId === "javascript") {
    const module = /\.mjs$/i.test(doc.uri) || /^\s*(import|export)\s/m.test(doc.text);
    return [{ block: { code: doc.text, offset: 0, line: 0, column: 0, module }, dynamicRanges: [] }];
  }
  if (!isJspDocument(doc.languageId, doc.uri)) {
    return extractScripts(doc.text).map((block) => ({ block, dynamicRanges: [] }));
  }
  // Masking keeps offsets, so scripts come from the masked text; remember where EL and scriptlets were.
  const masked = maskJsp(doc.text, { customTagPrefixes });
  const lines = new LineIndex(doc.text);
  const dynamicRanges = masked.regions
    .filter((r) => r.kind === "el" || r.kind === "expression" || r.kind === "scriptlet" || r.kind === "custom-tag")
    .map((r) => {
      const s = lines.positionAt(r.start);
      const e = lines.positionAt(r.end);
      return { line: s.line + 1, column: s.character, endLine: e.line + 1, endColumn: e.character };
    });
  return extractScripts(masked.text).map((block) => ({ block, dynamicRanges }));
}

// Padding in front of the code makes ESLint's line/column the document's line/column.
function paddedCode(block: ScriptBlock): string {
  return "\n".repeat(block.line) + " ".repeat(block.column) + block.code;
}

export class EslintEngine implements Engine {
  readonly id = "eslint";
  readonly displayName = "ECMAScript/ESLint";
  readonly status: EngineStatus = { state: "ready" };
  private linter: Linter | undefined; // loading ESLint takes ~200 ms, so not at activation
  private readonly statusEmitter = new Emitter<EngineStatus>();
  private readonly unknownRules = new Set<string>(); // typos in the config, reported once

  constructor(private readonly deps: { logger: Logger }) {}

  onStatusChange(listener: (status: EngineStatus) => void) {
    return this.statusEmitter.event(listener);
  }

  supports(languageId: string): boolean {
    return languageId === "javascript" || languageId === "html" || languageId === "jsp";
  }

  // The ESTree program for custom rules, or undefined on a syntax error.
  async parse(unit: LintUnit, ecmaVersion: "latest" | number): Promise<unknown> {
    const linter = await this.getLinter();
    const messages = linter.verify(paddedCode(unit.block), [this.baseConfig(unit, ecmaVersion, {})], { filename: "script.js" });
    if (messages.some((m) => m.fatal)) return undefined;
    return linter.getSourceCode()?.ast;
  }

  async validate(doc: SourceDocument, signal: AbortSignal, ctx: ValidationContext = defaultContext()): Promise<Finding[]> {
    const units = lintUnits(doc, ctx.jsp.customTagPrefixes);
    if (units.length === 0) return [];
    const linter = await this.getLinter();
    const findings: Finding[] = [];
    for (const unit of units) {
      if (signal.aborted) throw abortError();
      findings.push(...this.lint(linter, doc.uri, unit, ctx));
      // let other work run between blocks of a big page
      await new Promise((r) => setImmediate(r));
    }
    return findings;
  }

  private async getLinter(): Promise<Linter> {
    if (!this.linter) {
      const { Linter } = await import("eslint/universal");
      this.linter = new Linter({ configType: "flat" });
    }
    return this.linter;
  }

  private baseConfig(unit: LintUnit, ecmaVersion: "latest" | number, rules: Linter.RulesRecord): Linter.Config {
    return {
      files: ["**/*.js"],
      plugins: { [PLUGIN]: { rules: { [JQUERY_RULE_NAME]: jqueryUnscopedSelector } } },
      languageOptions: {
        ecmaVersion: ecmaVersion as Linter.EcmaVersion,
        sourceType: unit.block.module ? "module" : "script",
        parserOptions: { ecmaFeatures: { globalReturn: !unit.block.module } },
      },
      linterOptions: { reportUnusedDisableDirectives: "off" },
      rules,
    };
  }

  private lint(linter: Linter, uri: string, unit: LintUnit, ctx: ValidationContext): Finding[] {
    const code = paddedCode(unit.block);
    const lines = new LineIndex(code);

    const active = new Map<string, { id: string; setting: RuleSetting; source: string; docsUrl?: string }>();
    const rules: Linter.RulesRecord = {};
    for (const [name, setting] of Object.entries(eslintRulesFor(ctx.config))) {
      if (this.unknownRules.has(name)) continue;
      rules[name] = ["warn", ...setting.options] as Linter.RuleEntry; // the real severity comes from the config
      active.set(name, { id: ESLINT_PREFIX + name, setting, source: ESLINT_SOURCE, docsUrl: `https://eslint.org/docs/latest/rules/${name}` });
    }
    const jquery = ruleSettingFor(ctx.config, JQUERY_RULE_ID) ?? { severity: "warning" as const, options: [] };
    if (jquery.severity !== "off") {
      const opts = (jquery.options[0] ?? {}) as Record<string, unknown>;
      rules[JQUERY_RULE_ID] = ["warn", { ...opts, dynamicRanges: unit.dynamicRanges }];
      active.set(JQUERY_RULE_ID, { id: JQUERY_RULE_ID, setting: jquery, source: "Web Validator" });
    }

    let messages: Linter.LintMessage[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        messages = linter.verify(code, [this.baseConfig(unit, ctx.ecmaVersion, rules)], { filename: "script.js" });
        break;
      } catch (err) {
        // An unknown rule in the config: drop it, say so once, and try again.
        const m = /Could not find "([^"]+)" in plugin "@"/.exec(String((err as Error).message));
        if (!m?.[1] || !(m[1] in rules)) throw err;
        this.unknownRules.add(m[1]);
        this.deps.logger.warn(`Unknown ESLint rule "${ESLINT_PREFIX}${m[1]}" in the configuration; it is ignored.`);
        delete rules[m[1]];
      }
    }

    const pos = (line: number, column: number) => ({ line: line - 1, character: column - 1 });
    // Fix ranges are offsets into the padded code, whose positions are document positions.
    const toFix = (title: string, fix: { range: [number, number]; text: string }): Fix => ({
      title,
      edits: [{ range: lines.range(fix.range[0], fix.range[1]), newText: fix.text }],
    });

    const out: Finding[] = [];
    for (const m of messages) {
      if (m.fatal || !m.ruleId) {
        const syntax = ruleSettingFor(ctx.config, SYNTAX_ERROR_RULE);
        if (syntax?.severity === "off") continue;
        out.push({
          ruleId: SYNTAX_ERROR_RULE,
          source: ESLINT_SOURCE,
          severity: (syntax?.severity ?? "error") as Severity,
          message: m.message.replace(/^Parsing error: /, "Syntax error: "),
          range: { start: pos(m.line, m.column), end: pos(m.endLine ?? m.line, (m.endColumn ?? m.column) + (m.endColumn ? 0 : 1)) },
        });
        this.deps.logger.verbose(`Syntax error in a script of ${uri} at ${m.line}:${m.column}: ${m.message}`);
        continue;
      }
      const info = active.get(m.ruleId);
      if (!info) continue;
      const finding: Finding = {
        ruleId: info.id,
        source: info.source,
        severity: info.setting.severity as Severity,
        message: m.message,
        range: { start: pos(m.line, m.column), end: pos(m.endLine ?? m.line, m.endColumn ?? m.column) },
      };
      if (info.docsUrl) finding.docsUrl = info.docsUrl;
      if (m.fix) finding.fix = toFix(`Fix: ${m.message}`, m.fix);
      if (m.suggestions?.length) finding.suggestions = m.suggestions.map((s) => toFix(s.desc, s.fix));
      out.push(finding);
    }
    return out;
  }

  dispose(): void {
    this.statusEmitter.dispose();
  }
}

// --- jquery-unscoped-selector ---
//
// In single-page apps the same partial can be loaded into several tabs, so
// $(".name") finds elements in every tab.
//
//   flagged: $(".name")  $("input")  $(".row-" + id)  $(".name", $tab)  $(document).find(".name")
//   fine:    $(tab + " .name")  $(`${tab} .name`)  $tab.find(".name")  $(this).find(".name")  $("#id")  $("<div>")

// Marks a run-time value inside a selector string.
export const DYNAMIC = "\u0000";

const UNIQUE_TAGS = /^(html|body|head)$/i;

// Splits on commas that are not inside (), [] or quotes.
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
    } else if ((ch === ")" || ch === "]") && depth > 0) {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// For messages: runs of DYNAMIC become ${…}.
function displaySelector(selector: string): string {
  return selector
    .split(DYNAMIC)
    .reduce((acc, part, i) => (i > 0 && !acc.endsWith("${…}") ? acc + "${…}" : acc) + part, "")
    .trim();
}

// Selector-list parts that start with neither an #id nor a variable.
// HTML strings like "<div>" create elements and are never flagged.
export function unscopedSegments(selector: string): string[] {
  if (selector.trimStart().startsWith("<")) return [];
  const out: string[] = [];
  for (const raw of splitSelectorList(selector)) {
    const s = raw.trim();
    if (!s || s.startsWith(DYNAMIC) || s.startsWith("#") || UNIQUE_TAGS.test(s)) continue;
    out.push(displaySelector(s));
  }
  return out;
}

function isPageWideSelector(selector: string): boolean {
  return /^\s*(html|body|document|:root)\s*$/i.test(selector);
}

interface JqueryRuleOptions {
  functionNames?: string[]; // default $ and jQuery
  allowContextArgument?: boolean; // accept $(selector, context)
  dynamicRanges?: DynamicRange[];
}

// Just the parts of ESTree nodes this rule looks at.
type Node = {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null;
  [key: string]: unknown;
};

const stringLiteral = (n: Node | undefined): string | undefined => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : undefined);

const jqueryUnscopedSelector: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Require jQuery selectors to be scoped to the current process/tab" },
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
    const opts = (context.options[0] ?? {}) as JqueryRuleOptions;
    const names = new Set(opts.functionNames ?? ["$", "jQuery"]);
    const dynamic = opts.dynamicRanges ?? [];

    // The literal's value, with characters that were JSP EL replaced by DYNAMIC.
    const literalValue = (n: Node): string | undefined => {
      const value = stringLiteral(n);
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

    // undefined when the argument is not built from strings
    const selectorOf = (n: Node | undefined): string | undefined => {
      if (!n) return undefined;
      if (n.type === "Literal") return literalValue(n);
      if (n.type === "TemplateLiteral") {
        const quasis = n.quasis as Array<{ value: { cooked: string | null; raw: string } }>;
        return quasis.map((q) => q.value.cooked ?? q.value.raw).join(DYNAMIC);
      }
      if (n.type !== "BinaryExpression" || n.operator !== "+") return undefined;
      const parts: string[] = [];
      let hasString = false;
      const walk = (e: Node) => {
        if (e.type === "BinaryExpression" && e.operator === "+") {
          walk(e.left as Node);
          walk(e.right as Node);
          return;
        }
        const s = e.type === "Literal" || e.type === "TemplateLiteral" ? selectorOf(e) : undefined;
        if (s !== undefined && (e.type === "TemplateLiteral" || stringLiteral(e) !== undefined)) {
          hasString = true;
          parts.push(s);
        } else {
          parts.push(DYNAMIC);
        }
      };
      walk(n);
      return hasString ? parts.join("") : undefined;
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

    // "flagged" means an unscoped $() that is reported on its own already.
    const receiverKind = (n: Node): "global" | "flagged" | "scoped" => {
      if (isJQueryCall(n)) {
        const arg = (n.arguments as Node[])[0]!;
        if (isPageObject(arg)) return "global";
        const sel = selectorOf(arg);
        if (sel === undefined) return "scoped";
        if (isPageWideSelector(sel)) return "global";
        return unscopedSegments(sel).length > 0 ? "flagged" : "scoped";
      }
      // $tab.children().first().find(...): follow the chain
      if (n.type === "CallExpression" && (n.callee as Node).type === "MemberExpression") {
        return receiverKind((n.callee as Node).object as Node);
      }
      return isPageObject(n) ? "global" : "scoped";
    };

    const quoteList = (segments: string[]) => segments.map((s) => `"${s}"`).join(", ");

    return {
      CallExpression(node) {
        const n = node as unknown as Node;
        const args = n.arguments as Node[];

        if (isJQueryCall(n)) {
          if (args.length > 1 && opts.allowContextArgument) return;
          const sel = selectorOf(args[0]);
          if (sel === undefined || isPageWideSelector(sel)) return;
          const segments = unscopedSegments(sel);
          if (segments.length === 0) return;
          context.report({
            node: args[0] as unknown as Rule.Node,
            messageId: "unscoped",
            data: { selectors: quoteList(segments), first: segments[0]! },
          });
          return;
        }

        const callee = n.callee as Node;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          (callee.property as Node).name !== "find" ||
          args.length === 0 ||
          receiverKind(callee.object as Node) !== "global"
        ) {
          return;
        }
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
            receiver: context.sourceCode.getText(callee.object as unknown as Rule.Node),
          },
        });
      },
    };
  },
};
