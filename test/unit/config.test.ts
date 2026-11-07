import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JsoncError, parseJsonc } from "../../src/config/jsonc";
import { normalizeLayer, resolveConfig, ruleSettingFor } from "../../src/config/webValidatorConfig";
import type { Finding } from "../../src/engines/Engine";
import { applyRuleConfig, eslintRulesFor, RULE_ERROR_RULE } from "../../src/rules/registry";

const base = path.resolve("/work/app");
const layer = (raw: unknown, source = "file") => normalizeLayer(raw, source, base);
const finding = (ruleId: string, severity: Finding["severity"] = "error", message = "m"): Finding => ({
  ruleId,
  severity,
  message,
  source: "s",
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
});

describe("parseJsonc", () => {
  it("accepts comments and trailing commas", () => {
    expect(parseJsonc('{\n  // comment\n  "a": [1, 2,], /* block */\n  "b": "// not a comment",\n}')).toEqual({ a: [1, 2], b: "// not a comment" });
  });

  it("treats an empty file as an empty object", () => {
    expect(parseJsonc("  \n")).toEqual({});
  });

  it("reports the line of syntax errors", () => {
    try {
      parseJsonc('{\n  "a": 1\n  "b": 2\n}');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(JsoncError);
      expect((e as JsoncError).line).toBe(2);
    }
  });
});

describe("normalizeLayer", () => {
  it("normalizes severities, aliases and options", () => {
    const { layer: l, errors } = layer({ rules: { a: "off", b: "warn", c: 2, d: ["error", { x: 1 }] } });
    expect(errors).toEqual([]);
    expect(l.rules).toEqual({
      a: { severity: "off", options: [] },
      b: { severity: "warning", options: [] },
      c: { severity: "error", options: [] },
      d: { severity: "error", options: [{ x: 1 }] },
    });
  });

  it("resolves rulesDirectories against the config folder", () => {
    expect(layer({ rulesDirectories: [".webvalidator/rules"] }).layer.rulesDirectories).toEqual([path.join(base, ".webvalidator", "rules")]);
  });

  it("collects readable errors and keeps the valid parts", () => {
    const { layer: l, errors } = layer({
      extends: ["recommended", "nope"],
      rules: { ok: "info", bad: "loud" },
      ignoreMessages: ["(unclosed", "fine"],
      customRules: [{ id: "x" }, { id: "custom/a", message: "m", pattern: "a", selector: "b" }, { id: "custom/ok", message: "m", selector: "img:not([alt])" }],
      typo: true,
    });
    expect(errors.map((e) => e.replace(/^file: /, ""))).toEqual([
      '"extends" has unknown preset "nope" (known: recommended, strict)',
      '"rules.bad" must be "off", "info", "warning", "error" or [severity, options]',
      expect.stringMatching(/^"ignoreMessages" has an invalid regular expression "\(unclosed"/),
      '"customRules[0]" needs a "message"',
      '"customRules[1]" needs exactly one of "pattern" or "selector"',
      '"typo" is not a known setting',
    ]);
    expect(l.rules).toEqual({ ok: { severity: "info", options: [] } });
    expect(l.ignoreMessages).toEqual(["fine"]);
    expect(l.customRules?.map((r) => r.id)).toEqual(["custom/ok"]);
  });

  it("rejects invalid selectors in JSON rules", () => {
    expect(layer({ customRules: [{ id: "c/x", message: "m", selector: "div[" }] }).errors[0]).toMatch(/Invalid selector/);
  });
});

describe("resolveConfig", () => {
  it("lets later layers win and merges lists", () => {
    const settings = layer({ rules: { a: "error", b: "warning" }, jsp: { customTagPrefixes: ["x"] }, exclude: ["gen/**"] }, "settings").layer;
    const file = layer({ rules: { a: "off" }, jsp: { customTagPrefixes: ["y"], documentStructure: "validate" }, exclude: ["dist/**"] }).layer;
    const c = resolveConfig([settings, file]);
    expect(ruleSettingFor(c, "a")?.severity).toBe("off");
    expect(ruleSettingFor(c, "b")?.severity).toBe("warning");
    expect(c.customTagPrefixes).toEqual(["x", "y"]);
    expect(c.documentStructure).toBe("validate");
    expect(c.exclude.map((e) => e.glob)).toEqual(["gen/**", "dist/**"]);
  });

  it("matches wildcard rule ids, most specific first, exact ids winning", () => {
    const c = resolveConfig([layer({ rules: { "vnu:*": "warning", "vnu:css-*": "off", "vnu:css-invalid-value": "info" } }).layer]);
    expect(ruleSettingFor(c, "vnu:img-missing-alt")?.severity).toBe("warning");
    expect(ruleSettingFor(c, "vnu:css-parse-error")?.severity).toBe("off");
    expect(ruleSettingFor(c, "vnu:css-invalid-value")?.severity).toBe("info");
    expect(ruleSettingFor(c, "eslint:no-debugger")).toBeUndefined();
  });

  it("applies the strict preset", () => {
    const c = resolveConfig([layer({ extends: "strict" }).layer]);
    expect(ruleSettingFor(c, "eslint:no-unused-vars")?.severity).toBe("warning");
    expect(ruleSettingFor(resolveConfig([]), "eslint:no-unused-vars")).toBeUndefined();
  });
});

describe("applyRuleConfig", () => {
  const c = resolveConfig([
    layer({ rules: { "vnu:missing-lang": "off", "vnu:obsolete-element": "warning", "vnu:css-*": "off" }, ignoreMessages: ["^Section lacks"] }).layer,
  ]);

  it("drops rules set to off (exact and wildcard) and ignored messages, and overrides severities", () => {
    const out = applyRuleConfig(
      [
        finding("vnu:missing-lang", "warning"),
        finding("vnu:obsolete-element", "error"),
        finding("vnu:css-invalid-value"),
        finding("vnu:section-lacks-heading", "warning", "Section lacks heading."),
        finding("vnu:img-missing-alt"),
      ],
      c,
    );
    expect(out.map((f) => [f.ruleId, f.severity])).toEqual([
      ["vnu:obsolete-element", "warning"],
      ["vnu:img-missing-alt", "error"],
    ]);
  });

  it("never hides rule-error findings with wildcards", () => {
    const all = resolveConfig([layer({ rules: { "*": "off" } }).layer]);
    expect(applyRuleConfig([finding(RULE_ERROR_RULE), finding("a")], all).map((f) => f.ruleId)).toEqual([RULE_ERROR_RULE]);
  });
});

describe("eslintRulesFor", () => {
  it("starts from defaults and applies eslint: settings", () => {
    const rules = eslintRulesFor(resolveConfig([layer({ rules: { "eslint:no-debugger": "off", "eslint:eqeqeq": ["error", "smart"] } }).layer]));
    expect(rules["no-debugger"]).toBeUndefined();
    expect(rules["no-dupe-keys"]?.severity).toBe("error");
    expect(rules.eqeqeq).toEqual({ severity: "error", options: ["smart"] });
  });
});
