import type { Linter } from "eslint/universal";
import type { Engine, EngineStatus, Finding, Severity, SourceDocument } from "./Engine";
import { abortError } from "./Engine";
import { isJspDocument, type JspOptions } from "../preprocess/jspDocument";
import { maskJsp } from "../preprocess/jspMasker";
import { extractScripts, type ScriptBlock } from "../preprocess/scriptExtractor";
import jqueryUnscopedSelector, { JQUERY_UNSCOPED_SELECTOR, type DynamicRange } from "../rules/builtin/jqueryUnscopedSelector";
import { Emitter } from "../util/emitter";
import type { Logger } from "../util/logger";

export const RULE_SOURCE = "Web Validator";
const PLUGIN = "webvalidator";

export interface EslintEngineOptions {
  ecmaVersion: "latest" | number;
  /** Severity of `webvalidator/jquery-unscoped-selector`, or off. */
  jqueryUnscopedSelector: Severity | "off";
  jsp: JspOptions;
}

export interface EslintEngineDeps {
  logger: Logger;
  options(uri: string): EslintEngineOptions;
}

interface LintUnit {
  block: ScriptBlock;
  dynamicRanges: DynamicRange[];
}

/**
 * JavaScript checks for .js files and inline <script> blocks in HTML/JSP,
 * using ESLint's Linter as a library (no ESLint config files are read).
 */
export class EslintEngine implements Engine {
  readonly id = "eslint";
  readonly displayName = "ECMAScript/ESLint";
  readonly status: EngineStatus = { state: "ready" };
  /** Loaded on first use: requiring ESLint costs ~200 ms, which should not delay activation. */
  private linter: Linter | undefined;
  private readonly statusEmitter = new Emitter<EngineStatus>();

  constructor(private readonly deps: EslintEngineDeps) {}

  onStatusChange(listener: (status: EngineStatus) => void) {
    return this.statusEmitter.event(listener);
  }

  supports(languageId: string): boolean {
    return languageId === "javascript" || languageId === "html" || languageId === "jsp";
  }

  async validate(doc: SourceDocument, signal: AbortSignal): Promise<Finding[]> {
    const opts = this.deps.options(doc.uri);
    if (opts.jqueryUnscopedSelector === "off") return [];
    const units = this.units(doc, opts);
    if (units.length === 0) return [];
    if (!this.linter) {
      const { Linter: LinterClass } = await import("eslint/universal");
      this.linter = new LinterClass({ configType: "flat" });
    }
    const findings: Finding[] = [];
    for (const unit of units) {
      if (signal.aborted) throw abortError();
      findings.push(...this.lint(this.linter, doc.uri, unit, opts));
      // Yield between blocks so a large page does not block the extension host.
      await new Promise((r) => setImmediate(r));
    }
    return findings;
  }

  private units(doc: SourceDocument, opts: EslintEngineOptions): LintUnit[] {
    if (doc.languageId === "javascript") {
      const module = /\.mjs$/i.test(doc.uri) || /^\s*(import|export)\s/m.test(doc.text);
      return [{ block: { code: doc.text, offset: 0, line: 0, column: 0, module }, dynamicRanges: [] }];
    }
    if (!isJspDocument(doc.languageId, doc.uri)) {
      return extractScripts(doc.text).map((block) => ({ block, dynamicRanges: [] }));
    }
    // JSP: extract from the masked text (same offsets) and remember where EL/scriptlets were.
    const masked = maskJsp(doc.text, { customTagPrefixes: opts.jsp.customTagPrefixes });
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

  private lint(linter: Linter, uri: string, unit: LintUnit, opts: EslintEngineOptions): Finding[] {
    const { block } = unit;
    // Pad so ESLint's line/column equal positions in the whole document.
    const code = "\n".repeat(block.line) + " ".repeat(block.column) + block.code;
    const severity = opts.jqueryUnscopedSelector as Severity;
    const messages = linter.verify(
      code,
      [
        {
          files: ["**/*.js"],
          plugins: { [PLUGIN]: { rules: { [JQUERY_UNSCOPED_SELECTOR]: jqueryUnscopedSelector } } },
          languageOptions: {
            ecmaVersion: opts.ecmaVersion as Linter.EcmaVersion,
            sourceType: block.module ? "module" : "script",
            parserOptions: { ecmaFeatures: { globalReturn: !block.module } },
          },
          linterOptions: { reportUnusedDisableDirectives: "off" },
          rules: {
            [`${PLUGIN}/${JQUERY_UNSCOPED_SELECTOR}`]: ["warn", { dynamicRanges: unit.dynamicRanges }],
          },
        },
      ],
      { filename: "script.js" },
    );

    const out: Finding[] = [];
    for (const m of messages) {
      if (m.fatal || !m.ruleId) {
        // Syntax errors are reported by the JavaScript checks planned for Phase 3.
        this.deps.logger.verbose(`Could not parse a script in ${uri} at ${m.line}:${m.column}: ${m.message}`);
        continue;
      }
      out.push({
        ruleId: m.ruleId,
        source: RULE_SOURCE,
        severity,
        message: m.message,
        range: {
          start: { line: m.line - 1, character: m.column - 1 },
          end: { line: (m.endLine ?? m.line) - 1, character: (m.endColumn ?? m.column) - 1 },
        },
      });
    }
    return out;
  }

  dispose(): void {
    this.statusEmitter.dispose();
  }
}
