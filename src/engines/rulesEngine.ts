import { ruleSettingFor } from "../config/webValidatorConfig";
import { defaultContext, type Engine, type EngineStatus, type Finding, type SourceDocument, type ValidationContext } from "./Engine";
import { lintUnits, type EslintEngine } from "./eslintEngine";
import { isJspDocument } from "../preprocess/jspDocument";
import { maskJsp } from "../preprocess/jspMasker";
import { BUILTIN_RULES } from "../rules/builtin/exampleRules";
import { jsonRuleModule } from "../rules/jsonRules";
import type { RuleLanguage, RuleModule } from "../rules/RuleApi";
import type { RuleStore } from "../rules/ruleLoader";
import { ruleApplies, runRules, type ActiveRule } from "../rules/ruleRunner";
import { Emitter } from "../util/emitter";
import type { Logger } from "../util/logger";

export interface RulesEngineDeps {
  logger: Logger;
  eslint: EslintEngine;
  store: RuleStore;
  /** Called once per distinct load error (e.g. to show it in the output). */
  onLoadErrors?(errors: string[]): void;
}

/**
 * Runs built-in example rules, JSON-declared rules and, in trusted workspaces
 * only, custom rule code from `rulesDirectories` and `webvalidator-rules-*` packs.
 */
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

  /** All rule modules available for a context, with their origin. */
  async availableRules(ctx: ValidationContext): Promise<Array<{ rule: RuleModule; origin: string }>> {
    const out: Array<{ rule: RuleModule; origin: string }> = BUILTIN_RULES.map((rule) => ({ rule, origin: "built-in" }));
    for (const def of ctx.config.customRules) {
      // Regular expressions from an untrusted workspace could hang the editor (ReDoS).
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
    // Later definitions of the same id win (code rules over JSON over built-in).
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
    return runRules(
      {
        doc,
        language,
        htmlText: language === "javascript" ? undefined : jsp ? maskJsp(doc.text, { customTagPrefixes: prefixes }).text : doc.text,
        units: lintUnits(doc, prefixes),
        rules: active,
        parse: (unit) => this.deps.eslint.parse(unit, ctx.ecmaVersion),
        logger: this.deps.logger,
      },
      signal,
    );
  }

  /** Forget reported load errors (after rules are reloaded). */
  resetErrors(): void {
    this.reportedErrors.clear();
  }

  dispose(): void {
    this.statusEmitter.dispose();
  }
}
