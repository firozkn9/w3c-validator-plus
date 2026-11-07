/**
 * Rule metadata and applying the configuration (severity overrides, "off",
 * ignored messages) to findings from every engine.
 */
import type { Finding, Severity } from "../engines/Engine";
import { ruleSettingFor, type ResolvedConfig, type RuleSetting } from "../config/webValidatorConfig";

export const ESLINT_PREFIX = "eslint:";
export const ESLINT_SOURCE = "ECMAScript/ESLint";
export const SYNTAX_ERROR_RULE = "eslint:syntax-error";
export const RULE_ERROR_RULE = "webvalidator/rule-error";

/**
 * ESLint core rules that run by default: likely bugs only, nothing stylistic.
 * `no-undef` and `no-unused-vars` are left out because inline scripts share
 * globals across <script> blocks and HTML event attributes.
 */
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

/**
 * ESLint core rules to run for a configuration, keyed by ESLint rule name.
 * Defaults can be changed or turned off with `eslint:<rule>` (or `eslint:*`),
 * and any other core rule can be enabled the same way.
 */
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

export function eslintDocsUrl(ruleName: string): string {
  return `https://eslint.org/docs/latest/rules/${ruleName}`;
}

/**
 * Applies severity overrides, "off" and `ignoreMessages` to findings.
 * Rule-error findings (a custom rule that crashed) are never hidden by wildcards.
 */
export function applyRuleConfig(findings: readonly Finding[], config: ResolvedConfig): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    if (f.ruleId !== RULE_ERROR_RULE) {
      const setting = ruleSettingFor(config, f.ruleId);
      if (setting?.severity === "off") continue;
      if (config.ignoreMessages.some((re) => re.test(f.message))) continue;
      out.push(setting && setting.severity !== f.severity ? { ...f, severity: setting.severity } : f);
    } else {
      out.push(f);
    }
  }
  return out;
}
