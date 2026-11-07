import { describe, expect, it } from "vitest";
import { normalizeLayer, resolveConfig } from "../../src/config/webValidatorConfig";
import { defaultContext, type Finding } from "../../src/engines/Engine";
import { EslintEngine } from "../../src/engines/eslintEngine";
import { applyRuleConfig } from "../../src/rules/registry";
import { nullLogger } from "../../src/util/logger";

const engine = new EslintEngine({ logger: nullLogger });

async function lint(text: string, opts: { languageId?: string; uri?: string; rules?: Record<string, unknown>; ecmaVersion?: number | "latest" } = {}) {
  const config = resolveConfig([normalizeLayer({ rules: opts.rules ?? {} }, "test", undefined).layer]);
  const ctx = { ...defaultContext(), config, ecmaVersion: opts.ecmaVersion ?? "latest" };
  const fs = await engine.validate(
    { uri: opts.uri ?? "file:///a.js", languageId: opts.languageId ?? "javascript", text, version: 1 },
    new AbortController().signal,
    ctx,
  );
  return applyRuleConfig(fs, config);
}
const ids = (fs: Finding[]) => fs.map((f) => f.ruleId);
const pos = (f: Finding | undefined) => f && `${f.range.start.line + 1}:${f.range.start.character + 1}`;

describe("JavaScript syntax errors", () => {
  it("reports them with the ECMAScript/ESLint source at the right position", async () => {
    const [f] = await lint("function a() {\n  var x = ;\n}");
    expect(f).toMatchObject({ ruleId: "eslint:syntax-error", source: "ECMAScript/ESLint", severity: "error" });
    expect(pos(f)).toBe("2:11");
    expect(f!.message).toMatch(/^Syntax error: /);
  });

  it("reports them inside HTML <script> blocks at document positions", async () => {
    const [f] = await lint('<p>x</p>\n<script>\n  if (a {\n</script>', { languageId: "html", uri: "file:///a.html" });
    expect(f?.ruleId).toBe("eslint:syntax-error");
    expect(pos(f)).toBe("3:9");
  });

  it("respects the configured ecmaVersion", async () => {
    expect(ids(await lint("const a = 1;", { ecmaVersion: 5 }))).toEqual(["eslint:syntax-error"]);
    expect(await lint("const a = 1;", { ecmaVersion: 2015 })).toEqual([]);
  });

  it("does not report JSP EL used as a JavaScript value", async () => {
    const jsp = '<script>\nvar count = ${items.size()};\nvar data = <%= json %>;\nvar name = "${user.name}";\n<c:if test="${x}">init();</c:if>\n</script>';
    expect(await lint(jsp, { languageId: "jsp", uri: "file:///a.jsp" })).toEqual([]);
  });

  it("can be turned off", async () => {
    expect(await lint("var x = ;", { rules: { "eslint:syntax-error": "off" } })).toEqual([]);
  });
});

describe("ESLint core rules", () => {
  it("runs the default bug-finding rules", async () => {
    const fs = await lint("var o = { a: 1, a: 2 };\nif (x = y) {}\ndebugger;");
    expect(ids(fs).sort()).toEqual(["eslint:no-cond-assign", "eslint:no-debugger", "eslint:no-dupe-keys"]);
    const dupe = fs.find((f) => f.ruleId === "eslint:no-dupe-keys")!;
    expect(dupe).toMatchObject({ source: "ECMAScript/ESLint", severity: "error", docsUrl: "https://eslint.org/docs/latest/rules/no-dupe-keys" });
    expect(fs.find((f) => f.ruleId === "eslint:no-debugger")!.severity).toBe("warning");
  });

  it("does not run stylistic or cross-script rules by default", async () => {
    expect(await lint("var unused = 1; undefinedFn(); if (a == b) {}")).toEqual([]);
  });

  it("enables extra core rules from the config and changes severities", async () => {
    const fs = await lint("var unused = 1;\nif (a == b) {}\ndebugger;", {
      rules: { "eslint:no-unused-vars": "warning", "eslint:eqeqeq": ["error", "always"], "eslint:no-debugger": "off" },
    });
    expect(fs.map((f) => [f.ruleId, f.severity])).toEqual([
      ["eslint:no-unused-vars", "warning"],
      ["eslint:eqeqeq", "error"],
    ]);
  });

  it("turns all ESLint rules off with a wildcard", async () => {
    expect(await lint("var o = { a: 1, a: 2 };", { rules: { "eslint:*": "off" } })).toEqual([]);
  });

  it("ignores unknown rule names instead of failing", async () => {
    expect(ids(await lint("var o = { a: 1, a: 2 };", { rules: { "eslint:no-such-rule": "error" } }))).toEqual(["eslint:no-dupe-keys"]);
  });

  it("exposes ESLint fixes and suggestions with document positions", async () => {
    const code = "<p>x</p>\n<script>\nif (a == b) {}\nif (x === NaN) {}\n</script>";
    const fs = await lint(code, { languageId: "html", uri: "file:///a.html", rules: { "eslint:eqeqeq": "warning" } });
    const eq = fs.find((f) => f.ruleId === "eslint:eqeqeq")!;
    // eqeqeq offers a suggestion to use ===
    expect(eq.suggestions?.[0]?.edits[0]).toEqual({ range: { start: { line: 2, character: 6 }, end: { line: 2, character: 8 } }, newText: "===" });
    const nan = fs.find((f) => f.ruleId === "eslint:use-isnan")!;
    expect(nan.suggestions?.length).toBeGreaterThan(0);
  });
});
