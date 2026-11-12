import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  contributes: { grammars: { scopeName: string; path: string; injectTo?: string[] }[]; languages: { id: string; extensions?: string[] }[] };
};

function regexesIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => regexesIn(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "match" || k === "begin" || k === "end") && typeof v === "string") out.push(v);
      else regexesIn(v, out);
    }
  }
  return out;
}

describe("JSP grammars", () => {
  it("does not claim .jsp as its own language (VS Code's HTML support keeps it)", () => {
    const claimed = pkg.contributes.languages.flatMap((l) => l.extensions ?? []);
    expect(claimed).not.toContain(".jsp");
    expect(claimed).not.toContain(".tag");
    expect(pkg.contributes.languages.find((l) => l.id === "jsp")).toBeUndefined();
  });

  for (const g of pkg.contributes.grammars) {
    describe(g.path, () => {
      const file = join(root, g.path);
      it("exists and matches package.json", () => {
        expect(existsSync(file)).toBe(true);
        const grammar = JSON.parse(readFileSync(file, "utf8")) as { scopeName: string; injectionSelector?: string };
        expect(grammar.scopeName).toBe(g.scopeName);
        expect(grammar.injectionSelector).toMatch(/^L:text\.html\.derivative\b/);
        expect(g.injectTo).toEqual(["text.html.derivative"]);
      });

      it("has regular expressions that compile", () => {
        const grammar = JSON.parse(readFileSync(file, "utf8")) as unknown;
        const res = regexesIn(grammar);
        expect(res.length).toBeGreaterThan(3);
        for (const re of res) expect(() => new RegExp(re), re).not.toThrow();
      });
    });
  }

  it("matches EL and JSP tags as intended", () => {
    const el = JSON.parse(readFileSync(join(root, "syntaxes/jsp-el.injection.tmLanguage.json"), "utf8"));
    const begin = new RegExp(el.repository.el.begin);
    expect(begin.test("${order.total}")).toBe(true);
    expect(begin.test("#{bean.value}")).toBe(true);
    expect(begin.test("\\${literal}")).toBe(false);
    const tags = JSON.parse(readFileSync(join(root, "syntaxes/jsp-tags.injection.tmLanguage.json"), "utf8"));
    const m = new RegExp(tags.repository.directive.begin).exec('<%@ taglib prefix="c" %>');
    expect(m?.[2]).toBe("taglib");
  });
});
