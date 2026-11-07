import type { Linter } from "eslint/universal";
import {
  abortError,
  defaultContext,
  type Engine,
  type EngineStatus,
  type Finding,
  type Fix,
  type Severity,
  type SourceDocument,
  type ValidationContext,
} from "./Engine";
import { ruleSettingFor, type RuleSetting } from "../config/webValidatorConfig";
import { isJspDocument } from "../preprocess/jspDocument";
import { maskJsp } from "../preprocess/jspMasker";
import { extractScripts, type ScriptBlock } from "../preprocess/scriptExtractor";
import jqueryUnscopedSelector, { JQUERY_UNSCOPED_SELECTOR, type DynamicRange } from "../rules/builtin/jqueryUnscopedSelector";
import { ESLINT_PREFIX, ESLINT_SOURCE, eslintDocsUrl, eslintRulesFor, SYNTAX_ERROR_RULE } from "../rules/registry";
import { Emitter } from "../util/emitter";
import type { Logger } from "../util/logger";

export const RULE_SOURCE = "Web Validator";
const PLUGIN = "webvalidator";
export const JQUERY_RULE_ID = `${PLUGIN}/${JQUERY_UNSCOPED_SELECTOR}`;

export interface EslintEngineDeps {
  logger: Logger;
}

/** A JavaScript unit to lint, positioned in its document. */
export interface LintUnit {
  block: ScriptBlock;
  dynamicRanges: DynamicRange[];
}

/** Splits a document into JavaScript units: the whole file, or its inline scripts. */
export function lintUnits(doc: SourceDocument, customTagPrefixes: readonly string[]): LintUnit[] {
  if (doc.languageId === "javascript") {
    const module = /\.mjs$/i.test(doc.uri) || /^\s*(import|export)\s/m.test(doc.text);
    return [{ block: { code: doc.text, offset: 0, line: 0, column: 0, module }, dynamicRanges: [] }];
  }
  if (!isJspDocument(doc.languageId, doc.uri)) {
    return extractScripts(doc.text).map((block) => ({ block, dynamicRanges: [] }));
  }
  // JSP: extract from the masked text (same offsets) and remember where EL/scriptlets were.
  const masked = maskJsp(doc.text, { customTagPrefixes });
  const starts = [0];
  for (let i = 0; i < doc.text.length; i++) if (doc.text.charCodeAt(i) === 10) starts.push(i + 1);
  const loc = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo]! };
  };
  const dynamicRanges: DynamicRange[] = masked.regions
    .filter((r) => r.kind === "el" || r.kind === "expression" || r.kind === "scriptlet" || r.kind === "custom-tag")
    .map((r) => {
      const s = loc(r.start);
      const e = loc(r.end);
      return { line: s.line, column: s.column, endLine: e.line, endColumn: e.column };
    });
  return extractScripts(masked.text).map((block) => ({ block, dynamicRanges }));
}

/** Padding that makes ESLint's line/column equal positions in the whole document. */
export function paddedCode(block: ScriptBlock): { code: string; prefixLength: number } {
  const prefix = "\n".repeat(block.line) + " ".repeat(block.column);
  return { code: prefix + block.code, prefixLength: prefix.length };
}

/** Converts an offset range in `code` to line/column positions. */
function offsetRange(code: string, [s, e]: [number, number]) {
  const pos = (offset: number) => {
    const before = code.slice(0, offset);
    const line = before.split("\n").length - 1;
    return { line, character: offset - (before.lastIndexOf("\n") + 1) };
  };
  return { start: pos(s), end: pos(e) };
}

/**
 * JavaScript checks for .js files and inline <script> blocks in HTML/JSP,
 * using ESLint's Linter as a library (no ESLint config files are read):
 * syntax errors, a curated set of core rules, and webvalidator rules.
 */
export class EslintEngine implements Engine {
  readonly id = "eslint";
  readonly displayName = "ECMAScript/ESLint";
  readonly status: EngineStatus = { state: "ready" };
  /** Loaded on first use: requiring ESLint costs ~200 ms, which should not delay activation. */
  private linter: Linter | undefined;
  private readonly statusEmitter = new Emitter<EngineStatus>();
  /** Rule names ESLint rejected (e.g. typos in the config), so they are not retried every run. */
  private readonly unknownRules = new Set<string>();

  constructor(private readonly deps: EslintEngineDeps) {}

  onStatusChange(listener: (status: EngineStatus) => void) {
    return this.statusEmitter.event(listener);
  }

  supports(languageId: string): boolean {
    return languageId === "javascript" || languageId === "html" || languageId === "jsp";
  }

  /** The parsed program of a unit (used by custom rules), or undefined on syntax errors. */
  async parse(unit: LintUnit, ecmaVersion: "latest" | number): Promise<unknown> {
    const linter = await this.getLinter();
    const { code } = paddedCode(unit.block);
    const messages = linter.verify(code, [this.baseConfig(unit, ecmaVersion, {})], { filename: "script.js" });
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
      // Yield between blocks so a large page does not block the extension host.
      await new Promise((r) => setImmediate(r));
    }
    return findings;
  }

  private async getLinter(): Promise<Linter> {
    if (!this.linter) {
      const { Linter: LinterClass } = await import("eslint/universal");
      this.linter = new LinterClass({ configType: "flat" });
    }
    return this.linter;
  }

  private baseConfig(unit: LintUnit, ecmaVersion: "latest" | number, rules: Linter.RulesRecord): Linter.Config {
    return {
      files: ["**/*.js"],
      plugins: { [PLUGIN]: { rules: { [JQUERY_UNSCOPED_SELECTOR]: jqueryUnscopedSelector } } },
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
    const { block } = unit;
    const { code } = paddedCode(block);

    const settings = new Map<string, { id: string; setting: RuleSetting; source: string; docsUrl?: string }>();
    const rules: Linter.RulesRecord = {};
    for (const [name, setting] of Object.entries(eslintRulesFor(ctx.config))) {
      if (this.unknownRules.has(name)) continue;
      rules[name] = ["warn", ...setting.options] as Linter.RuleEntry; // real severity comes from the config
      settings.set(name, { id: ESLINT_PREFIX + name, setting, source: ESLINT_SOURCE, docsUrl: eslintDocsUrl(name) });
    }
    const jquery = ruleSettingFor(ctx.config, JQUERY_RULE_ID) ?? { severity: "warning" as const, options: [] };
    if (jquery.severity !== "off") {
      const opts = (jquery.options[0] ?? {}) as Record<string, unknown>;
      rules[JQUERY_RULE_ID] = ["warn", { ...opts, dynamicRanges: unit.dynamicRanges }];
      settings.set(JQUERY_RULE_ID, { id: JQUERY_RULE_ID, setting: jquery, source: RULE_SOURCE });
    }

    let messages: Linter.LintMessage[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        messages = linter.verify(code, [this.baseConfig(unit, ctx.ecmaVersion, rules)], { filename: "script.js" });
        break;
      } catch (err) {
        // An unknown rule name in the config: drop it, report once, retry.
        const m = /Could not find "([^"]+)" in plugin "@"/.exec(String((err as Error).message));
        if (!m?.[1] || !(m[1] in rules)) throw err;
        this.unknownRules.add(m[1]);
        this.deps.logger.warn(`Unknown ESLint rule "${ESLINT_PREFIX}${m[1]}" in the configuration; it is ignored.`);
        delete rules[m[1]];
      }
    }

    const toPos = (line: number, column: number) => ({ line: line - 1, character: column - 1 });
    /** ESLint fix ranges are offsets in the padded code, whose line/column equal the document's. */
    const toFix = (title: string, fix: { range: [number, number]; text: string }): Fix => ({
      title,
      edits: [{ range: offsetRange(code, fix.range), newText: fix.text }],
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
          range: { start: toPos(m.line, m.column), end: toPos(m.endLine ?? m.line, (m.endColumn ?? m.column) + (m.endColumn ? 0 : 1)) },
        });
        this.deps.logger.verbose(`Syntax error in a script of ${uri} at ${m.line}:${m.column}: ${m.message}`);
        continue;
      }
      const info = settings.get(m.ruleId);
      if (!info) continue;
      const finding: Finding = {
        ruleId: info.id,
        source: info.source,
        severity: info.setting.severity as Severity,
        message: m.message,
        range: { start: toPos(m.line, m.column), end: toPos(m.endLine ?? m.line, m.endColumn ?? m.column) },
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
