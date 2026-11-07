import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeLayer, resolveConfig } from "../../src/config/webValidatorConfig";
import { defaultContext, type Finding, type ValidationContext } from "../../src/engines/Engine";
import { EslintEngine } from "../../src/engines/eslintEngine";
import { RulesEngine } from "../../src/engines/rulesEngine";
import { buildDom } from "../../src/rules/dom";
import { loadRulePacks, loadRulesFromDirectories, RuleStore, rulesFromExports } from "../../src/rules/ruleLoader";
import { nullLogger } from "../../src/util/logger";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-rules-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, content: string): string {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const store = new RuleStore();
const engine = new RulesEngine({ logger: nullLogger, eslint: new EslintEngine({ logger: nullLogger }), store });

function ctx(raw: Record<string, unknown> = {}, trusted = true): ValidationContext {
  const { layer, errors } = normalizeLayer(raw, "test", tmp);
  if (errors.length) throw new Error(errors.join("\n"));
  return { ...defaultContext(), config: resolveConfig([layer]), trusted, workspaceRoot: tmp };
}
async function run(text: string, c: ValidationContext, languageId = "html", uri = "file:///page.html"): Promise<Finding[]> {
  return engine.validate({ uri, languageId, text, version: 1 }, new AbortController().signal, c);
}
const at = (f: Finding) => `${f.range.start.line + 1}:${f.range.start.character + 1}`;

describe("buildDom", () => {
  it("exposes elements, attributes and exact positions (also with CRLF)", async () => {
    const html = '<div class="a">\r\n  <img src="x.png" alt="">\r\n  <p>Hi <b>there</b></p>\r\n</div>';
    const dom = await buildDom(html);
    expect(dom.elements.map((e) => e.tagName)).toEqual(["div", "img", "p", "b"]);
    const img = dom.elements[1]!;
    expect(img.attrs).toEqual({ src: "x.png", alt: "" });
    expect(img.startTag).toEqual({ start: { line: 1, character: 2 }, end: { line: 1, character: 26 } });
    expect(img.attrRanges.src).toEqual({ start: { line: 1, character: 7 }, end: { line: 1, character: 18 } });
    expect(dom.elements[2]!.textContent).toBe("Hi there");
    expect(dom.elements[2]!.hasText).toBe(true);
    expect(img.parent?.tagName).toBe("div");
  });

  it("skips elements implied by the parser", async () => {
    const dom = await buildDom("<p>fragment</p>");
    expect(dom.elements.map((e) => e.tagName)).toEqual(["p"]);
    expect(dom.elements[0]!.parent?.tagName).toBe("body");
  });
});

describe("built-in example rules", () => {
  it("are off by default and enabled by config or the strict preset", async () => {
    const html = '<form><button>Go</button><p style="color:red">x</p></form>';
    expect(await run(html, ctx())).toEqual([]);
    const fs1 = await run(html, ctx({ extends: "strict" }));
    expect(fs1.map((f) => [f.ruleId, at(f)])).toEqual([
      ["webvalidator/require-button-type", "1:7"],
      ["webvalidator/no-inline-styles", "1:29"],
    ]);
    const button = fs1[0]!;
    expect(button.fix?.edits[0]).toEqual({ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 13 } }, newText: ' type="button"' });
  });
});

describe("JSON-declared rules", () => {
  const rules = {
    customRules: [
      { id: "custom/img-alt", selector: "img:not([alt])", message: "Images need alt text", severity: "error" },
      { id: "custom/no-todo", pattern: "TODO", flags: "i", message: "Resolve TODOs", languages: ["html", "jsp", "javascript"] },
    ],
  };

  it("match elements by selector and text by pattern", async () => {
    const fs1 = await run('<img src="a.png">\n<!-- todo: x -->\n<img src="b.png" alt="">', ctx(rules));
    expect(fs1.map((f) => [f.ruleId, f.severity, at(f)])).toEqual([
      ["custom/img-alt", "error", "1:1"],
      ["custom/no-todo", "warning", "2:6"],
    ]);
  });

  it("can have their severity changed or turned off like any rule", async () => {
    const c = ctx({ ...rules, rules: { "custom/img-alt": "info", "custom/no-todo": "off" } });
    expect((await run('<img src="a.png"> TODO', c)).map((f) => [f.ruleId, f.severity])).toEqual([["custom/img-alt", "info"]]);
  });

  it("run selector rules but not regex rules in untrusted workspaces", async () => {
    expect((await run('<img src="a.png"> TODO', ctx(rules, false))).map((f) => f.ruleId)).toEqual(["custom/img-alt"]);
  });
});

describe("custom rule files", () => {
  let dir: string;
  beforeAll(() => {
    dir = path.join(tmp, "rules");
    write(
      "rules/no-inline-styles.js",
      `module.exports = {
        id: "custom/no-inline-styles",
        languages: ["html", "jsp"],
        meta: { description: "no style", defaultSeverity: "warning", docsUrl: "https://example.test/rule" },
        create(ctx) {
          return { element(node) { if (node.attrs.style !== undefined) ctx.report({ node, attribute: "style", message: "Inline style " + JSON.stringify(ctx.options) }); } };
        },
      };`,
    );
    write(
      "rules/js-rules.cjs",
      `module.exports = [{
        id: "custom/no-alert",
        languages: ["javascript", "html", "jsp"],
        create(ctx) {
          return { script(s) {
            const walk = (n) => { if (!n || typeof n.type !== "string") return;
              if (n.type === "CallExpression" && n.callee.name === "alert") ctx.report({ loc: n.loc, message: "No alert()" });
              for (const k of Object.keys(n)) { const v = n[k]; if (k === "parent") continue;
                if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v); } };
            walk(s.ast);
          } };
        },
      }];`,
    );
    write(
      "rules/esm-rule.mjs",
      `export default { id: "custom/esm", meta: { description: "esm" }, create(ctx) { return { end() { if (ctx.text.includes("ESM")) ctx.report({ offset: ctx.text.indexOf("ESM"), length: 3, message: "esm works" }); } }; } };`,
    );
    write("rules/broken.js", `module.exports = { id: "custom/broken", create() { return { element() { throw new Error("boom"); } }; } };`);
    write("rules/invalid.js", `module.exports = { name: "missing id" };`);
    write("rules/typed.ts", `export default {}`);
    write("rules/notes.txt", `ignored`);
  });

  it("load .js, .cjs and .mjs files and report invalid ones", async () => {
    const r = await loadRulesFromDirectories([dir, path.join(tmp, "missing")]);
    expect(r.rules.map((x) => x.rule.id).sort()).toEqual(["custom/broken", "custom/esm", "custom/no-alert", "custom/no-inline-styles"]);
    expect(r.errors.join("\n")).toMatch(/invalid\.js: .*needs a string "id"/);
    expect(r.errors.join("\n")).toMatch(/typed\.ts: TypeScript rules must be compiled/);
    expect(r.errors.join("\n")).toMatch(/Rules directory not found/);
  });

  it("run with options, docs links, AST access, and isolate a crashing rule", async () => {
    store.invalidate();
    const c = ctx({ rulesDirectories: ["rules"], rules: { "custom/no-inline-styles": ["error", { max: 1 }] } });
    const html = '<p style="x">ESM</p>\n<script>\n  alert(1);\n</script>';
    const found = await run(html, c);
    const by = (id: string) => found.find((f) => f.ruleId === id);
    expect(by("custom/no-inline-styles")).toMatchObject({ severity: "error", message: 'Inline style [{"max":1}]', docsUrl: "https://example.test/rule", source: "Custom rule" });
    expect(at(by("custom/no-inline-styles")!)).toBe("1:4");
    expect(at(by("custom/no-alert")!)).toBe("3:3");
    expect(at(by("custom/esm")!)).toBe("1:14");
    expect(by("webvalidator/rule-error")?.message).toMatch(/Custom rule "custom\/broken" failed: boom/);
    // the crash did not stop the other rules
    expect(found.filter((f) => f.ruleId === "webvalidator/rule-error")).toHaveLength(1);
  });

  it("apply to .js files when the rule lists javascript", async () => {
    store.invalidate();
    const found = await run("function f() {\n  alert('x');\n}", ctx({ rulesDirectories: ["rules"] }), "javascript", "file:///a.js");
    expect(found.map((f) => [f.ruleId, at(f)])).toEqual([["custom/no-alert", "2:3"]]);
  });

  it("are never executed in untrusted workspaces", async () => {
    store.invalidate();
    const found = await run('<p style="x">ESM</p>', ctx({ rulesDirectories: ["rules"] }, false));
    expect(found).toEqual([]);
  });

  it("pick up edits after the store is invalidated", async () => {
    write("rules2/r.js", `module.exports = { id: "custom/v", create(ctx) { return { end() { ctx.report({ message: "v1" }); } }; } };`);
    const c = ctx({ rulesDirectories: ["rules2"] });
    store.invalidate();
    expect((await run("<p>x</p>", c)).map((f) => f.message)).toEqual(["v1"]);
    write("rules2/r.js", `module.exports = { id: "custom/v", create(ctx) { return { end() { ctx.report({ message: "v2" }); } }; } };`);
    store.invalidate();
    expect((await run("<p>x</p>", c)).map((f) => f.message)).toEqual(["v2"]);
  });
});

describe("rule packs", () => {
  it("load webvalidator-rules-* packages listed in package.json", async () => {
    const root = path.join(tmp, "packs");
    write("packs/package.json", JSON.stringify({ dependencies: { "webvalidator-rules-acme": "1.0.0", "left-pad": "1", "webvalidator-rules-missing": "1" } }));
    write("packs/node_modules/webvalidator-rules-acme/package.json", JSON.stringify({ name: "webvalidator-rules-acme", main: "index.js" }));
    write(
      "packs/node_modules/webvalidator-rules-acme/index.js",
      `exports.rules = [{ id: "acme/no-marquee", meta: { description: "x" }, create(ctx) { return { element(e) { if (e.tagName === "marquee") ctx.report({ node: e, message: "no marquee" }); } }; } }];`,
    );
    const r = await loadRulePacks(root);
    expect(r.rules.map((x) => [x.rule.id, x.origin])).toEqual([["acme/no-marquee", "webvalidator-rules-acme"]]);
    expect(r.errors).toEqual(['Rule pack "webvalidator-rules-missing" is listed in package.json but not installed (run npm install)']);
  });
});

describe("rulesFromExports", () => {
  it("accepts single rules, arrays, { rules } and default exports", () => {
    const rule = { id: "a/b", create: () => ({}) };
    expect(rulesFromExports(rule, "x")).toHaveLength(1);
    expect(rulesFromExports([rule, { ...rule, id: "a/c" }], "x")).toHaveLength(2);
    expect(rulesFromExports({ rules: [rule] }, "x")).toHaveLength(1);
    expect(rulesFromExports({ default: rule }, "x")).toHaveLength(1);
    expect(() => rulesFromExports({ id: "a", create: 1 }, "x")).toThrow(/create\(context\)/);
    expect(() => rulesFromExports({ id: "a", create() {}, languages: ["css"] }, "x")).toThrow(/invalid languages/);
  });
});
