// Custom rules: the API rule authors write against, the DOM they see, and the
// engine that runs built-in, JSON-declared and user-supplied rules.
//
// A rule is an object exported from a .js/.cjs/.mjs file in a rules directory
// or from a webvalidator-rules-* package:
//
//   module.exports = {
//     id: "custom/no-inline-styles",
//     languages: ["html", "jsp"],
//     meta: { description: "Use CSS classes", defaultSeverity: "warning" },
//     create(ctx) {
//       return {
//         element(el) {
//           if (el.attrs.style !== undefined) ctx.report({ node: el, attribute: "style", message: "Move inline styles to CSS" });
//         },
//       };
//     },
//   };
//
// For JSP the DOM is built from the masked page, so positions match the file.
import { defaultContext, ruleSettingFor, type JsonRuleDefinition } from "./config";
import {
  Emitter,
  LineIndex,
  RULE_ERROR_RULE,
  type Engine,
  type EngineStatus,
  type Finding,
  type Fix,
  type Logger,
  type Position,
  type Range,
  type Severity,
  type SourceDocument,
  type ValidationContext,
} from "./core";
import { lintUnits, type EslintEngine, type LintUnit } from "./eslint";
import { isJspDocument, maskJsp } from "./jsp";
import type { RuleStore } from "./ruleLoader";
import { matchesSelector, parseSelector, type SelectableElement } from "./selector";

export type RuleLanguage = "html" | "jsp" | "javascript";

export interface RuleElement extends SelectableElement {
  tagName: string; // lower case
  attrs: Readonly<Record<string, string>>; // lower-case names; "" for valueless attributes
  parent?: RuleElement;
  children: RuleElement[];
  hasText: boolean; // has non-whitespace text directly inside
  textContent: string;
  startTag: Range;
  endTag?: Range;
  range: Range;
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
  code: string;
  range: Range;
  module: boolean;
  // ESTree Program from espree, undefined on syntax errors. Its loc values
  // are document positions (1-based lines, 0-based columns).
  ast?: unknown;
}

export interface ReportDescriptor {
  message: string;
  node?: RuleElement | RuleTextNode | RuleComment; // an element reports its start tag
  attribute?: string; // with an element node: report that attribute instead
  range?: Range;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } }; // astNode.loc
  offset?: number; // into ctx.text
  length?: number;
  severity?: Severity; // a severity set in the config still wins
  fix?: Fix;
  suggestions?: Fix[];
}

export interface RuleContext {
  readonly uri: string;
  readonly fileName: string;
  readonly language: RuleLanguage;
  readonly text: string;
  readonly options: readonly unknown[]; // "rules": { "my/rule": ["warning", { ... }] }
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
  script?(script: RuleScript): void; // each inline <script>, or the whole .js file
  end?(): void;
}

export interface RuleModule {
  id: string; // scope/name
  languages?: RuleLanguage[]; // default html and jsp
  meta?: { description: string; defaultSeverity?: Severity | "off"; docsUrl?: string };
  create(context: RuleContext): RuleVisitors | void;
}

export function defineRule(rule: RuleModule): RuleModule {
  return rule;
}

// --- built-in rules, off unless enabled (or "extends": "strict") ---

export const BUILTIN_RULES: readonly RuleModule[] = [
  defineRule({
    id: "webvalidator/no-inline-styles",
    meta: { description: "Disallow style attributes; use CSS classes instead.", defaultSeverity: "off" },
    create: (ctx) => ({
      element(el) {
        if (el.attrs.style !== undefined) ctx.report({ node: el, attribute: "style", message: "Move this inline style into a CSS class." });
      },
    }),
  }),
  defineRule({
    id: "webvalidator/require-button-type",
    meta: { description: "Require a type on <button>; without it, a button inside a form submits the form.", defaultSeverity: "off" },
    create: (ctx) => ({
      element(el) {
        if (el.tagName !== "button" || el.attrs.type !== undefined) return;
        const at = { line: el.startTag.start.line, character: el.startTag.start.character + "<button".length };
        const insert = (type: string): Fix => ({ title: `Add type="${type}"`, edits: [{ range: { start: at, end: at }, newText: ` type="${type}"` }] });
        ctx.report({
          node: el,
          message: 'Add a type to this <button> ("button", "submit" or "reset"); the default is "submit".',
          fix: insert("button"),
          suggestions: [insert("submit")],
        });
      },
    }),
  }),
];

// --- rules declared in JSON ---

const MAX_PATTERN_MATCHES = 500;

export function jsonRuleModule(def: JsonRuleDefinition): RuleModule {
  const meta = { description: def.message, defaultSeverity: def.severity, ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}) };
  const base = { id: def.id, languages: def.languages as RuleLanguage[], meta };
  if (def.selector !== undefined) {
    const selector = parseSelector(def.selector);
    return {
      ...base,
      create: (ctx) => ({
        element(el) {
          if (matchesSelector(el, selector)) ctx.report({ node: el, message: def.message });
        },
      }),
    };
  }
  const flags = `${(def.flags ?? "").replace(/g/g, "")}g`;
  return {
    ...base,
    create: (ctx) => ({
      end() {
        const re = new RegExp(def.pattern ?? "(?!)", flags);
        let count = 0;
        for (let m = re.exec(ctx.text); m && count < MAX_PATTERN_MATCHES; m = re.exec(ctx.text), count++) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          ctx.report({ offset: m.index, length: m[0].length, message: def.message });
        }
      },
    }),
  };
}

// --- the DOM (parse5 with source locations) ---

export interface RuleDom {
  elements: RuleElement[]; // only elements written in the source, in document order
  texts: RuleTextNode[];
  comments: RuleComment[];
}

interface P5Location {
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}

interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: P5Node; // <template>
  value?: string;
  data?: string;
  sourceCodeLocation?: P5Location | null;
}

const NO_RANGE: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

// Elements the parser adds on its own (<html>, <body> around a fragment) stay
// in the tree as parents but are not visited and have no positions.
export async function buildDom(html: string): Promise<RuleDom> {
  const { parse } = await import("parse5");
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const lines = new LineIndex(html);
  const dom: RuleDom = { elements: [], texts: [], comments: [] };

  // Returns the text content of the children.
  const walk = (node: P5Node, parent: RuleElement | undefined): string => {
    let text = "";
    for (const child of [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])]) {
      const loc = child.sourceCodeLocation ?? undefined;
      if (child.nodeName === "#text") {
        const value = child.value ?? "";
        text += value;
        if (loc) dom.texts.push({ value, range: lines.range(loc.startOffset, loc.endOffset), ...(parent ? { parent } : {}) });
        if (parent && /\S/.test(value)) parent.hasText = true;
        continue;
      }
      if (child.nodeName === "#comment") {
        if (loc) dom.comments.push({ value: child.data ?? "", range: lines.range(loc.startOffset, loc.endOffset) });
        continue;
      }
      if (!child.tagName) continue;
      const attrs: Record<string, string> = {};
      for (const a of child.attrs ?? []) attrs[a.name.toLowerCase()] = a.value;
      const attrRanges: Record<string, Range> = {};
      for (const [name, l] of Object.entries(loc?.attrs ?? {})) attrRanges[name.toLowerCase()] = lines.range(l.startOffset, l.endOffset);
      const el: RuleElement = {
        tagName: child.tagName.toLowerCase(),
        attrs,
        children: [],
        hasText: false,
        textContent: "",
        startTag: loc?.startTag ? lines.range(loc.startTag.startOffset, loc.startTag.endOffset) : NO_RANGE,
        range: loc ? lines.range(loc.startOffset, loc.endOffset) : NO_RANGE,
        attrRanges,
        ...(parent ? { parent } : {}),
      };
      if (loc?.endTag) el.endTag = lines.range(loc.endTag.startOffset, loc.endTag.endOffset);
      parent?.children.push(el);
      if (loc?.startTag) dom.elements.push(el);
      el.textContent = walk(child, el);
      text += el.textContent;
    }
    return text;
  };
  walk(document, undefined);
  return dom;
}

// --- running rules against one document ---

const CUSTOM_RULE_SOURCE = "Custom rule";

export interface ActiveRule {
  rule: RuleModule;
  origin: string; // file, package, "built-in" or "config", for error messages
  severity: Severity;
  explicitSeverity: boolean; // set in the config, so it beats report({ severity })
  options: unknown[];
  source?: string;
}

export interface RunRulesInput {
  doc: SourceDocument;
  language: RuleLanguage;
  htmlText?: string; // what the DOM is built from (the masked page for JSP)
  units: LintUnit[];
  rules: ActiveRule[];
  parse?(unit: LintUnit): Promise<unknown>;
  logger: Logger;
}

export function ruleApplies(rule: RuleModule, language: RuleLanguage): boolean {
  return (rule.languages ?? ["html", "jsp"]).includes(language);
}

// A rule that throws is reported once as webvalidator/rule-error; the others keep running.
export async function runRules(input: RunRulesInput, signal: AbortSignal): Promise<Finding[]> {
  const { doc, language, logger } = input;
  const rules = input.rules.filter((r) => ruleApplies(r.rule, language));
  if (rules.length === 0) return [];

  const lines = new LineIndex(doc.text);
  const dom: RuleDom =
    input.htmlText !== undefined && language !== "javascript" ? await buildDom(input.htmlText) : { elements: [], texts: [], comments: [] };

  const findings: Finding[] = [];
  const failed = new Set<string>();
  const fail = (active: ActiveRule, err: unknown) => {
    if (failed.has(active.rule.id)) return;
    failed.add(active.rule.id);
    logger.error(`Custom rule "${active.rule.id}" (${active.origin}) failed on ${doc.uri}`, err);
    findings.push({
      ruleId: RULE_ERROR_RULE,
      source: CUSTOM_RULE_SOURCE,
      severity: "warning",
      message: `Custom rule "${active.rule.id}" failed: ${err instanceof Error ? err.message : String(err)} (details in the Web Validator output)`,
      range: NO_RANGE,
    });
  };

  const rangeOf = (d: ReportDescriptor): Range => {
    if (d.range) return d.range;
    if (d.loc) {
      return {
        start: { line: d.loc.start.line - 1, character: d.loc.start.column },
        end: { line: d.loc.end.line - 1, character: d.loc.end.column },
      };
    }
    if (d.offset !== undefined) return lines.range(d.offset, d.offset + (d.length ?? 0));
    if (!d.node) return NO_RANGE;
    if ("tagName" in d.node) return (d.attribute && d.node.attrRanges[d.attribute.toLowerCase()]) || d.node.startTag;
    return d.node.range;
  };

  const instances: Array<{ active: ActiveRule; visitors: RuleVisitors }> = [];
  for (const active of rules) {
    const ctx: RuleContext = {
      uri: doc.uri,
      fileName: decodeURIComponent(doc.uri.replace(/^.*[\\/]/, "")),
      language,
      text: doc.text,
      options: active.options,
      elements: dom.elements,
      querySelectorAll: (selector) => {
        const sel = parseSelector(selector);
        return dom.elements.filter((e) => matchesSelector(e, sel));
      },
      positionAt: (o) => lines.positionAt(o),
      offsetAt: (p) => lines.offsetAt(p),
      report: (d) => {
        if (!d || typeof d.message !== "string") throw new TypeError("report() needs an object with a message");
        const f: Finding = {
          ruleId: active.rule.id,
          source: active.source ?? CUSTOM_RULE_SOURCE,
          severity: active.explicitSeverity ? active.severity : (d.severity ?? active.severity),
          message: d.message,
          range: rangeOf(d),
        };
        if (active.rule.meta?.docsUrl) f.docsUrl = active.rule.meta.docsUrl;
        if (d.fix) f.fix = d.fix;
        if (d.suggestions?.length) f.suggestions = d.suggestions;
        findings.push(f);
      },
    };
    try {
      instances.push({ active, visitors: active.rule.create(ctx) ?? {} });
    } catch (err) {
      fail(active, err);
    }
  }

  const call = <T>(name: keyof RuleVisitors, arg?: T) => {
    for (const { active, visitors } of instances) {
      const fn = visitors[name] as ((a?: T) => void) | undefined;
      if (!fn || failed.has(active.rule.id)) continue;
      try {
        fn.call(visitors, arg);
      } catch (err) {
        fail(active, err);
      }
    }
  };
  const wants = (name: keyof RuleVisitors) => instances.some((i) => i.visitors[name]);

  if (wants("element")) for (const el of dom.elements) call("element", el);
  if (wants("text")) for (const t of dom.texts) call("text", t);
  if (wants("comment")) for (const c of dom.comments) call("comment", c);
  if (signal.aborted) return [];
  if (wants("script")) {
    // Parsing is the expensive part, so only when some rule asks for scripts.
    for (const unit of input.units) {
      const { block } = unit;
      call<RuleScript>("script", {
        code: block.code,
        range: { start: { line: block.line, character: block.column }, end: lines.positionAt(block.offset + block.code.length) },
        module: block.module,
        ast: input.parse ? await input.parse(unit) : undefined,
      });
    }
  }
  call("end");
  return findings;
}

// --- the engine ---

export interface RulesEngineDeps {
  logger: Logger;
  eslint: EslintEngine;
  store: RuleStore;
  onLoadErrors?(errors: string[]): void; // called once per distinct error
}

export class RulesEngine implements Engine {
  readonly id = "rules";
  readonly displayName = "Custom rules";
  readonly status: EngineStatus = { state: "ready" };
  private readonly statusEmitter = new Emitter<EngineStatus>();
  private readonly reportedErrors = new Set<string>();

  constructor(private readonly deps: RulesEngineDeps) {}

  onStatusChange(listener: (status: EngineStatus) => void) {
    return this.statusEmitter.event(listener);
  }

  supports(languageId: string): boolean {
    return languageId === "html" || languageId === "jsp" || languageId === "javascript";
  }

  async availableRules(ctx: ValidationContext): Promise<Array<{ rule: RuleModule; origin: string }>> {
    const out = BUILTIN_RULES.map((rule) => ({ rule, origin: "built-in" }));
    for (const def of ctx.config.customRules) {
      // A regex from an untrusted workspace could hang the editor (ReDoS).
      if (def.pattern !== undefined && !ctx.trusted) continue;
      out.push({ rule: jsonRuleModule(def), origin: "config" });
    }
    if (ctx.trusted) {
      const loaded = await this.deps.store.get(ctx.config.rulesDirectories, ctx.workspaceRoot);
      const fresh = loaded.errors.filter((e) => !this.reportedErrors.has(e));
      for (const e of fresh) {
        this.reportedErrors.add(e);
        this.deps.logger.warn(`Custom rules: ${e}`);
      }
      if (fresh.length) this.deps.onLoadErrors?.(fresh);
      out.push(...loaded.rules);
    }
    // Same id: code rules beat JSON rules beat built-ins.
    const byId = new Map<string, { rule: RuleModule; origin: string }>();
    for (const r of out) byId.set(r.rule.id, r);
    return [...byId.values()];
  }

  async validate(doc: SourceDocument, signal: AbortSignal, ctx: ValidationContext = defaultContext()): Promise<Finding[]> {
    const jsp = isJspDocument(doc.languageId, doc.uri);
    const language: RuleLanguage = jsp ? "jsp" : doc.languageId === "javascript" ? "javascript" : "html";

    const active: ActiveRule[] = [];
    for (const { rule, origin } of await this.availableRules(ctx)) {
      if (!ruleApplies(rule, language)) continue;
      const configured = ruleSettingFor(ctx.config, rule.id);
      const severity = configured?.severity ?? rule.meta?.defaultSeverity ?? "warning";
      if (severity === "off") continue;
      active.push({ rule, origin, severity, explicitSeverity: !!configured, options: configured?.options ?? [] });
    }
    if (active.length === 0) return [];

    const prefixes = ctx.jsp.customTagPrefixes;
    let htmlText: string | undefined;
    if (language === "html") htmlText = doc.text;
    else if (language === "jsp") htmlText = maskJsp(doc.text, { customTagPrefixes: prefixes }).text;
    return runRules(
      {
        doc,
        language,
        htmlText,
        units: lintUnits(doc, prefixes),
        rules: active,
        parse: (unit) => this.deps.eslint.parse(unit, ctx.ecmaVersion),
        logger: this.deps.logger,
      },
      signal,
    );
  }

  resetErrors(): void {
    this.reportedErrors.clear();
  }

  dispose(): void {
    this.statusEmitter.dispose();
  }
}
