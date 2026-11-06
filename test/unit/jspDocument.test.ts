import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/engines/Engine";
import { isJspDocument, mapJspFindings, prepareJsp, type JspOptions } from "../../src/preprocess/jspDocument";

const ignore: JspOptions = { documentStructure: "ignore", customTagPrefixes: ["c"] };
const validate: JspOptions = { documentStructure: "validate", customTagPrefixes: ["c"] };

const finding = (ruleId: string, message: string, sl: number, sc: number, el: number, ec: number): Finding => ({
  ruleId,
  message,
  source: "Nu Html Checker",
  severity: "error",
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
});

describe("isJspDocument", () => {
  it("recognises the jsp language id and JSP file extensions", () => {
    expect(isJspDocument("jsp", "untitled:Untitled-1")).toBe(true);
    expect(isJspDocument("html", "file:///a/index.jsp")).toBe(true);
    expect(isJspDocument("html", "file:///a/part.JSPF")).toBe(true);
    expect(isJspDocument("html", "file:///WEB-INF/tags/box.tag")).toBe(true);
    expect(isJspDocument("html", "file:///a/index.html")).toBe(false);
    expect(isJspDocument("html", "file:///a/index.jsp.html")).toBe(false);
  });
});

describe("prepareJsp", () => {
  it("wraps fragments in a one-line synthetic document", () => {
    const p = prepareJsp("<div>${x}</div>", ignore);
    expect(p.fragment).toBe(true);
    expect(p.lineOffset).toBe(1);
    const [wrapper, content] = p.text.split("\n");
    expect(wrapper).toBe('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>JSP fragment</title>');
    expect(content).toMatch(/^<div>[a-z]{4}<\/div>$/);
  });

  it("does not add a second title or meta charset", () => {
    const p = prepareJsp('<meta charset="utf-8"><title>T</title><p>x</p>', ignore);
    expect(p.text.split("\n")[0]).toBe('<!DOCTYPE html><html lang="en"><head>');
  });

  it("validates full pages as-is in validate mode", () => {
    const src = "<!DOCTYPE html>\n<html><head><title>t</title></head><body></body></html>";
    const p = prepareJsp(src, validate);
    expect([p.fragment, p.lineOffset, p.text]).toEqual([false, 0, src]);
  });

  it("still wraps files without <html>/<!DOCTYPE> in validate mode", () => {
    expect(prepareJsp("<footer>x</footer>\n</body>\n</html>", validate).fragment).toBe(true);
  });
});

describe("mapJspFindings", () => {
  it("shifts findings back past the wrapper line and drops wrapper findings", () => {
    const src = "<div>\n<img src=a.png>\n</div>";
    const p = prepareJsp(src, ignore);
    const mapped = mapJspFindings(
      [
        finding("vnu:img-missing-alt", "An “img” element must have an “alt” attribute", 2, 0, 2, 15),
        finding("vnu:something", "In the wrapper", 0, 15, 0, 30),
        finding("vnu:missing-lang", "Consider adding a “lang” attribute", 1, 0, 1, 5),
      ],
      p,
      src,
    );
    expect(mapped.map((f) => [f.ruleId, f.range.start.line, f.range.start.character])).toEqual([["vnu:img-missing-alt", 1, 0]]);
  });

  it("drops findings about attributes whose value is a placeholder, keeps others in the same tag", () => {
    const src = '<img src="${u}" width="${w}" height="abc">';
    const p = prepareJsp(src, ignore);
    const tag = (msg: string, id = "vnu:bad-attribute-value") => finding(id, msg, 1, 0, 1, src.length);
    const mapped = mapJspFindings(
      [
        tag("Bad value “xxxb” for attribute “width” on element “img”: Expected a digit."),
        tag("Bad value “abc” for attribute “height” on element “img”: Expected a digit."),
        tag("An “img” element must have an “alt” attribute", "vnu:img-missing-alt"),
      ],
      p,
      src,
    );
    expect(mapped.map((f) => f.message.slice(0, 30))).toEqual([
      "Bad value “abc” for attribute ",
      "An “img” element must have an ",
    ]);
  });

  it("drops reference errors for placeholder ids (for=, aria-*)", () => {
    const src = '<label for="${id}">Name</label>';
    const p = prepareJsp(src, ignore);
    const f = finding("vnu:x", "The “for” attribute of the “label” element must refer to a non-hidden form control.", 1, 0, 1, 19);
    expect(mapJspFindings([f], p, src)).toEqual([]);
  });

  it("drops CSS errors caused by EL in style attributes and <style> blocks", () => {
    const src = '<p style="color: ${c}">x</p>\n<style>\np { color: ${c}; }\nh1 { colr: red; }\n</style>';
    const p = prepareJsp(src, ignore);
    const mapped = mapJspFindings(
      [
        finding("vnu:css-invalid-value", "CSS: “color”: “xxxa” is not a “color” value.", 1, 0, 1, 23),
        finding("vnu:css-parse-error", "CSS: Parse Error.", 3, 4, 3, 14),
        finding("vnu:css-unknown-property", "CSS: “colr”: Property “colr” doesn't exist.", 4, 5, 4, 9),
      ],
      p,
      src,
    );
    expect(mapped.map((f) => f.ruleId)).toEqual(["vnu:css-unknown-property"]);
    expect(mapped[0]?.range.start.line).toBe(3);
  });
});
