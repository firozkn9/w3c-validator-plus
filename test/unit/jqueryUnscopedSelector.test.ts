import { describe, expect, it } from "vitest";
import { EslintEngine, JQUERY_RULE_ID } from "../../src/engines/eslintEngine";
import { defaultContext, type Finding } from "../../src/engines/Engine";
import { normalizeLayer, resolveConfig } from "../../src/config/webValidatorConfig";
import { extractScripts } from "../../src/preprocess/scriptExtractor";
import { DYNAMIC, unscopedSegments } from "../../src/rules/builtin/jquerySelector";
import { nullLogger } from "../../src/util/logger";

const engine = new EslintEngine({ logger: nullLogger });

/** Lints and returns only jQuery-rule findings (unless `all`). */
async function lint(code: string, languageId = "javascript", uri = "file:///app/a.js", rules?: Record<string, unknown>, all = false) {
  const ctx = { ...defaultContext(), config: resolveConfig([normalizeLayer({ rules: rules ?? {} }, "test", undefined).layer]) };
  const fs = await engine.validate({ uri, languageId, text: code, version: 1 }, new AbortController().signal, ctx);
  return all ? fs : fs.filter((f) => f.ruleId === JQUERY_RULE_ID);
}
const flagged = async (code: string) => (await lint(code)).length > 0;

describe("unscopedSegments", () => {
  it.each([
    [".name", [".name"]],
    ["input", ["input"]],
    ["[name=x]", ["[name=x]"]],
    [":checked", [":checked"]],
    [".a .b", [".a .b"]],
    ["#save", []],
    ["#tab .name", []],
    ["html", []],
    ["body", []],
    ["<div class='x'>", []],
    ["#a, .b", [".b"]],
    [".a, .b", [".a", ".b"]],
    ["[data-x='a,b'], #y", ["[data-x='a,b']"]], // the comma inside [] does not split
    [`${DYNAMIC} .name`, []],
    [`${DYNAMIC} .a, .b`, [".b"]],
    [`.row-${DYNAMIC}`, [".row-${…}"]],
    [`#${DYNAMIC}`, []],
  ])("%j → %j", (selector, expected) => {
    expect(unscopedSegments(selector)).toEqual(expected);
  });
});

describe("jquery-unscoped-selector", () => {
  describe("flags selectors that match the whole page", () => {
    it.each([
      '$(".name")',
      'jQuery(".name")',
      '$("input")',
      '$("[name=email]")',
      '$(".a .b")',
      '$(".row-" + id)',
      "$(`.row-${id}`)",
      '$(".name", $tab)', // the context argument is not accepted as scoping
      '$(document).find(".name")',
      '$(window).find(".name")',
      '$("body").find(".name")',
      '$(document.body).find(".name")',
      '$("#a, .b")',
    ])("%s", async (code) => {
      expect(await flagged(code)).toBe(true);
    });
  });

  describe("accepts scoped selectors", () => {
    it.each([
      '$(tabSelector + " .name")',
      '$(currentProcess.selector + " .name")',
      '$(getTab() + " .name")',
      "$(`${tab} .name`)",
      '$tab.find(".name")',
      '$(currentTab).find(".name")',
      '$(this).find(".name")',
      'this.$el.find(".name")',
      '$tab.children(".x").first().find(".name")',
      '$("#saveBtn")',
      '$("#" + id)',
      '$("#tab-" + n + " .name")',
      '$("<div class=\\"x\\">")',
      "$(document)",
      "$(this)",
      "$(el)",
      "$(function () {})",
      '$("body").addClass("busy")',
      '$(".x".concat(y))', // not analysable: not reported
      'other(".name")',
    ])("%s", async (code) => {
      expect(await flagged(code)).toBe(false);
    });
  });

  it("does not report the same problem twice for $(\".a\").find(\".b\")", async () => {
    const fs = await lint('$(".a").find(".b")');
    expect(fs).toHaveLength(1);
    expect(fs[0]!.message).toContain('".a"');
  });

  it("reports at the selector with a helpful message", async () => {
    const [f] = await lint('function init() {\n  var x = $(".name").val();\n}');
    expect(f).toMatchObject({
      ruleId: "webvalidator/jquery-unscoped-selector",
      source: "Web Validator",
      severity: "warning",
      range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } },
    } satisfies Partial<Finding>);
    expect(f!.message).toBe(
      'Add current process / tab selector before ".name": it matches the whole page. Example: $(tabSelector + " .name") or $tab.find(".name").',
    );
  });

  it("uses the configured severity and can be turned off", async () => {
    expect((await lint('$(".x")', "javascript", "file:///a.js", { [JQUERY_RULE_ID]: "error" }))[0]?.severity).toBe("error");
    expect(await lint('$(".x")', "javascript", "file:///a.js", { [JQUERY_RULE_ID]: "off" })).toEqual([]);
  });

  it("can be suppressed per line with ESLint disable comments", async () => {
    const code = [
      "// eslint-disable-next-line webvalidator/jquery-unscoped-selector",
      '$(".a");',
      '$(".b"); // eslint-disable-line webvalidator/jquery-unscoped-selector',
      '$(".c");',
    ].join("\n");
    expect((await lint(code)).map((f) => f.range.start.line)).toEqual([3]);
  });

  it("reports a syntax error (not a selector warning) for files that do not parse", async () => {
    expect((await lint('$(".x"', "javascript", "file:///a.js", undefined, true)).map((f) => f.ruleId)).toEqual(["eslint:syntax-error"]);
  });

  it("accepts the context argument when allowContextArgument is set", async () => {
    expect(await lint('$(".name", $tab)', "javascript", "file:///a.js", { [JQUERY_RULE_ID]: ["warning", { allowContextArgument: true }] })).toEqual([]);
  });

  it("supports ES modules", async () => {
    expect(await flagged('import $ from "jquery";\nexport const a = $(".x");')).toBe(true);
  });
});

describe("inline scripts", () => {
  it("extracts JavaScript blocks only, with their positions", () => {
    const html = [
      "<p>x</p>",
      '<script type="text/template"><div class="t"></div></script>',
      '<!-- <script>$(".commented")</script> -->',
      '<script data-x="a>b">  $(".a");</script>',
      '<script type="module">$(".m")</script>',
    ].join("\n");
    expect(extractScripts(html).map((b) => [b.line, b.column, b.module, b.code.trim()])).toEqual([
      [3, 21, false, '$(".a");'],
      [4, 22, true, '$(".m")'],
    ]);
  });

  it("reports selectors in HTML <script> blocks at document positions", async () => {
    const html = '<!DOCTYPE html>\n<p>x</p>\n<script>\n  $(".name").hide();\n</script>';
    const fs = await lint(html, "html", "file:///app/a.html");
    expect(fs.map((f) => [f.range.start.line, f.range.start.character])).toEqual([[3, 4]]);
  });

  it("treats JSP EL at the start of a selector as the tab/process scope", async () => {
    const jsp = [
      '<%@ page contentType="text/html" %>',
      "<script>",
      '  $("${tabSel} .name").hide();', // scoped by EL
      '  $("<%= processSelector %> .name").show();', // scoped by an expression
      '  $(".row-${id}").remove();', // EL later in the selector: still page-wide
      '  $(".name").val("${value}");', // EL elsewhere does not matter
      "</script>",
    ].join("\n");
    const fs = await lint(jsp, "jsp", "file:///app/page.jsp");
    expect(fs.map((f) => f.range.start.line + 1)).toEqual([5, 6]);
    expect(fs[0]!.message).toContain('".row-${…}"');
  });

  it("finds scripts in .jsp files mapped to the html language", async () => {
    const fs = await lint('<c:if test="${x}"><script>$(".a")</script></c:if>', "html", "file:///app/p.jsp");
    expect(fs).toHaveLength(1);
  });
});
