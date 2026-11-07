/**
 * Runs custom rules (RuleModule) against one document. A rule that throws is
 * reported once as `webvalidator/rule-error` and does not affect other rules.
 */
import type { Finding, Range, Severity, SourceDocument } from "../engines/Engine";
import type { LintUnit } from "../engines/eslintEngine";
import type { Logger } from "../util/logger";

import { buildDom, LineIndex, type RuleDom } from "./dom";
import { RULE_ERROR_RULE } from "./registry";
import type { ReportDescriptor, RuleContext, RuleElement, RuleLanguage, RuleModule, RuleScript, RuleVisitors } from "./RuleApi";
import { matchesSelector, parseSelector } from "./selector";

export const CUSTOM_RULE_SOURCE = "Custom rule";

export interface ActiveRule {
  rule: RuleModule;
  /** Where it came from (file path, package name, "built-in", "config"), for error messages. */
  origin: string;
  severity: Severity;
  /** True when the severity came from the config (then it beats `report({ severity })`). */
  explicitSeverity: boolean;
  options: unknown[];
  source?: string;
}

export interface RunRulesInput {
  doc: SourceDocument;
  language: RuleLanguage;
  /** HTML used to build the DOM (the masked page for JSP); same offsets as `doc.text`. */
  htmlText?: string;
  units: LintUnit[];
  rules: ActiveRule[];
  /** Parses a script unit to an ESTree Program (undefined on syntax errors). */
  parse?(unit: LintUnit): Promise<unknown>;
  logger: Logger;
}

const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

export function ruleApplies(rule: RuleModule, language: RuleLanguage): boolean {
  return (rule.languages ?? ["html", "jsp"]).includes(language);
}

export async function runRules(input: RunRulesInput, signal: AbortSignal): Promise<Finding[]> {
  const { doc, language, logger } = input;
  const rules = input.rules.filter((r) => ruleApplies(r.rule, language));
  if (rules.length === 0) return [];

  const lines = new LineIndex(doc.text);
  const dom: RuleDom = input.htmlText !== undefined && language !== "javascript" ? await buildDom(input.htmlText) : { elements: [], texts: [], comments: [] };

  // Parse scripts once, only if some rule wants them.
  let scripts: RuleScript[] | undefined;
  const getScripts = async (): Promise<RuleScript[]> => {
    if (!scripts) {
      scripts = [];
      for (const unit of input.units) {
        const { block } = unit;
        const start = { line: block.line, character: block.column };
        scripts.push({
          code: block.code,
          range: { start, end: lines.positionAt(block.offset + block.code.length) },
          module: block.module,
          ast: input.parse ? await input.parse(unit) : undefined,
        });
      }
    }
    return scripts;
  };

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
      range: ZERO,
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
    if (d.node) {
      if ("tagName" in d.node) {
        const el = d.node as RuleElement;
        return (d.attribute && el.attrRanges[d.attribute.toLowerCase()]) || el.startTag;
      }
      return d.node.range;
    }
    return ZERO;
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
      const visitors = active.rule.create(ctx) ?? {};
      instances.push({ active, visitors });
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

  if (instances.some((i) => i.visitors.element)) for (const el of dom.elements) call("element", el);
  if (instances.some((i) => i.visitors.text)) for (const t of dom.texts) call("text", t);
  if (instances.some((i) => i.visitors.comment)) for (const c of dom.comments) call("comment", c);
  if (signal.aborted) return [];
  if (instances.some((i) => i.visitors.script)) for (const s of await getScripts()) call("script", s);
  call("end");
  return findings;
}

