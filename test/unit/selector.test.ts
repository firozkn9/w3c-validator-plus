import { describe, expect, it } from "vitest";
import { matchesSelector, parseSelector, type SelectableElement } from "../../src/rules/selector";

function el(tagName: string, attrs: Record<string, string> = {}, children: SelectableElement[] = [], hasText = false): SelectableElement {
  const e: SelectableElement = { tagName, attrs, children, hasText };
  for (const c of children) c.parent = e;
  return e;
}

// <form id="f"><div class="row a"><img src="x.png"><input type="text" name="q"></div><button></button></form>
const img = el("img", { src: "x.png" });
const input = el("input", { type: "text", name: "q" });
const row = el("div", { class: "row a" }, [img, input]);
const button = el("button");
const form = el("form", { id: "f" }, [row, button]);
void form;

const m = (e: SelectableElement, s: string) => matchesSelector(e, parseSelector(s));

describe("selector engine", () => {
  it.each([
    [img, "img", true],
    [img, "*", true],
    [img, "IMG", true],
    [img, "img:not([alt])", true],
    [img, "img[alt]", false],
    [img, 'img[src$=".png"]', true],
    [img, "img[src^=x]", true],
    [img, "img[src*='.p']", true],
    [row, ".row.a", true],
    [row, "div.row:not(.b)", true],
    [row, ".b", false],
    [form, "#f", true],
    [input, "form input[type=text]", true],
    [input, "form > input", false],
    [input, "#f > .row > input", true],
    [input, "input[type=TEXT i]", true],
    [input, "input[type=TEXT]", false],
    [img, ":first-child", true],
    [input, ":first-child", false],
    [input, ":last-child", true],
    [button, "button:empty", true],
    [row, "div:empty", false],
    [button, "button:not([type])", true],
    [img, "a, img", true],
    [img, ":not(div, span)", true],
  ])("%#: %s", (element, selector, expected) => {
    expect(m(element as SelectableElement, selector as string)).toBe(expected);
  });

  it.each(["div[", "img:hover", ":not(", ">", "a,", ""])("rejects %j", (s) => {
    expect(() => parseSelector(s)).toThrow(/Invalid selector/);
  });
});
