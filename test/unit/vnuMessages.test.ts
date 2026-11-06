import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isFatalParseError,
  parseVnuResponse,
  vnuRange,
  vnuResponseToFindings,
  vnuRuleId,
  vnuSeverity,
  type VnuResponse,
} from "../../src/engines/vnu/vnuMessages";

const fixtures = join(__dirname, "..", "fixtures", "html");
const invalidHtml = readFileSync(join(fixtures, "invalid.html"), "utf8");
/** Real output of `vnu --format json --no-stream -` for invalid.html (vnu 26.11.4). */
const invalidVnu = JSON.parse(readFileSync(join(fixtures, "invalid.vnu.json"), "utf8")) as VnuResponse;

describe("vnuRuleId", () => {
  it.each([
    ["An “img” element must have an “alt” attribute, except under certain conditions.", "vnu:img-missing-alt"],
    ["The “center” element is obsolete. Use CSS instead.", "vnu:obsolete-element"],
    ["The “align” attribute on the “div” element is obsolete. Use CSS instead.", "vnu:obsolete-attribute"],
    ["Element “li” not allowed as child of element “body” in this context.", "vnu:element-not-allowed-as-child"],
    ["Attribute “foo” not allowed on element “div” at this point.", "vnu:attribute-not-allowed"],
    ["Element “img” is missing required attribute “src”.", "vnu:missing-required-attribute"],
    ["Element “head” is missing a required instance of child element “title”.", "vnu:missing-required-child"],
    ["Bad value “x” for attribute “width” on element “img”: Expected a digit.", "vnu:bad-attribute-value"],
    ["Duplicate ID “a”.", "vnu:duplicate-id"],
    ["The first occurrence of ID “a” was here.", "vnu:duplicate-id"],
    ["Start tag seen without seeing a doctype first. Expected “<!DOCTYPE html>”.", "vnu:missing-doctype"],
    ["Unclosed element “div”.", "vnu:unclosed-element"],
    ["End tag for  “body” seen, but there were unclosed elements.", "vnu:end-tag-with-open-elements"],
    ["Stray end tag “div”.", "vnu:stray-end-tag"],
    ["Start tag “div” seen in “table”.", "vnu:misplaced-in-table"],
    ["Misplaced non-space characters inside a table.", "vnu:misplaced-in-table"],
    ["No “p” element in scope but a “p” end tag seen.", "vnu:no-element-in-scope"],
    ["Consider adding a “lang” attribute to the “html” start tag.", "vnu:missing-lang"],
    ["CSS: “color”: “nonsense” is not a “color” value.", "vnu:css-invalid-value"],
    ["Cannot recover after last error. Any further errors will be ignored.", "vnu:fatal-parse-error"],
    // ASCII quotes (asciiquotes=yes) map to the same ids
    ["An 'img' element must have an 'alt' attribute, except under certain conditions.", "vnu:img-missing-alt"],
  ])("%s → %s", (message, id) => {
    expect(vnuRuleId(message)).toBe(id);
  });

  it("derives a stable fallback id with element names removed", () => {
    expect(vnuRuleId("Element “title” must not be empty.")).toBe("vnu:element-must-not-be-empty");
    expect(vnuRuleId("Element “h1” must not be empty.")).toBe("vnu:element-must-not-be-empty");
    expect(vnuRuleId(undefined)).toBe("vnu:unknown");
  });
});

describe("vnuSeverity", () => {
  it("maps types and subtypes", () => {
    expect(vnuSeverity({ type: "error" })).toBe("error");
    expect(vnuSeverity({ type: "info", subType: "warning" })).toBe("warning");
    expect(vnuSeverity({ type: "info" })).toBe("info");
  });
});

describe("vnuRange", () => {
  it("converts 1-based inclusive columns to a 0-based exclusive range", () => {
    expect(vnuRange({ type: "error", lastLine: 3, firstColumn: 5, lastColumn: 9 })).toEqual({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 9 },
    });
  });

  it("uses a document-start range when there is no location", () => {
    expect(vnuRange({ type: "error" })).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  });

  it("keeps legitimate multi-line tag ranges", () => {
    const lines = ["<p>", "<img", '  src="x">'];
    expect(vnuRange({ type: "error", firstLine: 2, lastLine: 3, firstColumn: 1, lastColumn: 10 }, lines)).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 2, character: 10 },
    });
  });
});

describe("vnuResponseToFindings on real vnu output", () => {
  const findings = vnuResponseToFindings(invalidVnu, invalidHtml);
  const at = (ruleId: string) => findings.filter((f) => f.ruleId === ruleId).map((f) => f.range);
  const r = (sl: number, sc: number, el: number, ec: number) => ({
    start: { line: sl, character: sc },
    end: { line: el, character: ec },
  });

  it("reports missing alt on the img tag (line 8)", () => {
    expect(at("vnu:img-missing-alt")).toEqual([r(7, 2, 7, 22)]);
  });

  it("reports the obsolete center element (line 9)", () => {
    expect(at("vnu:obsolete-element")).toEqual([r(8, 2, 8, 10)]);
  });

  it("reports div inside table at the <div> tag, fixing vnu's stale start", () => {
    // vnu buffered mode says firstLine 1 / firstColumn 1 here.
    expect(at("vnu:misplaced-in-table")).toContainEqual(r(9, 9, 9, 14));
  });

  it("reports li outside a list (line 11)", () => {
    expect(at("vnu:element-not-allowed-as-child")).toEqual([r(10, 2, 10, 6)]);
  });

  it("reports invalid inline CSS (line 12)", () => {
    expect(at("vnu:css-invalid-value")).toEqual([r(11, 2, 11, 29)]);
  });

  it("reports the duplicate id on the second span, with the first occurrence as a warning", () => {
    const dup = findings.filter((f) => f.ruleId === "vnu:duplicate-id");
    expect(dup.map((f) => [f.severity, f.range])).toEqual([
      ["error", r(12, 22, 12, 35)],
      ["warning", r(12, 2, 12, 15)],
    ]);
  });

  it("reports unclosed elements at their start tags (line 14)", () => {
    expect(at("vnu:unclosed-element")).toEqual([r(13, 11, 13, 16), r(13, 2, 13, 11)]);
  });

  it("reports the end-tag problem at </body> (line 15)", () => {
    expect(at("vnu:end-tag-with-open-elements")).toEqual([r(14, 0, 14, 7)]);
  });

  it("puts the lang warning on <html> instead of the end of line 1", () => {
    const lang = findings.find((f) => f.ruleId === "vnu:missing-lang");
    expect(lang?.severity).toBe("warning");
    expect(lang?.range).toEqual(r(1, 0, 1, 6));
  });

  it("attaches docs links and the source label", () => {
    const alt = findings.find((f) => f.ruleId === "vnu:img-missing-alt");
    expect(alt?.source).toBe("Nu Html Checker");
    expect(alt?.docsUrl).toMatch(/^https:\/\/html\.spec\.whatwg\.org\//);
  });

  it("produces no fatal errors in buffered mode", () => {
    expect(invalidVnu.messages.some(isFatalParseError)).toBe(false);
  });
});

describe("parseVnuResponse", () => {
  it("rejects bodies without a messages array", () => {
    expect(() => parseVnuResponse("{}")).toThrow(/messages/);
    expect(() => parseVnuResponse("<html>")).toThrow(/invalid JSON/);
  });

  it("drops non-document errors", () => {
    const res = parseVnuResponse(JSON.stringify({ messages: [{ type: "non-document-error", message: "IO" }] }));
    expect(vnuResponseToFindings(res, "")).toEqual([]);
  });
});
