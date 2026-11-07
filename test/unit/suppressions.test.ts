import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/engines/Engine";
import { applySuppressions, parseDirectives } from "../../src/rules/suppressions";

const f = (ruleId: string, line: number): Finding => ({
  ruleId,
  line,
  source: "s",
  severity: "error",
  message: "m",
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
} as Finding & { line: number });
const kept = (text: string, findings: Finding[]) => applySuppressions(findings, text).map((x) => `${x.ruleId}@${x.range.start.line}`);

describe("parseDirectives", () => {
  it("recognises HTML, JSP, line and block comments", () => {
    const text = [
      "<!-- webvalidator-disable-next-line vnu:img-missing-alt -->",
      "<%-- webvalidator-disable vnu:a, vnu:b --%>",
      "x(); // webvalidator-disable-line",
      "/* webvalidator-enable vnu:a */",
      "<!-- webvalidator-disable-line vnu:c -- legacy markup, fix in 2027 -->",
      "<!-- webvalidator-disabled is not a directive -->",
    ].join("\n");
    expect(parseDirectives(text)).toEqual([
      { kind: "disable-next-line", line: 0, ruleIds: ["vnu:img-missing-alt"] },
      { kind: "disable", line: 1, ruleIds: ["vnu:a", "vnu:b"] },
      { kind: "disable-line", line: 2, ruleIds: [] },
      { kind: "enable", line: 3, ruleIds: ["vnu:a"] },
      { kind: "disable-line", line: 4, ruleIds: ["vnu:c"] },
    ]);
  });
});

describe("applySuppressions", () => {
  it("disable-next-line and disable-line only affect their line and rules", () => {
    const text = "<!-- webvalidator-disable-next-line vnu:alt -->\n<img>\n<img> <!-- webvalidator-disable-line -->\n<img>";
    expect(kept(text, [f("vnu:alt", 1), f("vnu:other", 1), f("vnu:alt", 2), f("vnu:any", 2), f("vnu:alt", 3)])).toEqual([
      "vnu:other@1",
      "vnu:alt@3",
    ]);
  });

  it("disable … enable covers a block; disable without enable covers the rest of the file", () => {
    const text = ["a", "<%-- webvalidator-disable vnu:x --%>", "b", "<%-- webvalidator-enable vnu:x --%>", "c", "// webvalidator-disable", "d"].join("\n");
    expect(kept(text, [f("vnu:x", 0), f("vnu:x", 2), f("vnu:y", 2), f("vnu:x", 4), f("vnu:y", 6), f("eslint:z", 6)])).toEqual([
      "vnu:x@0",
      "vnu:y@2",
      "vnu:x@4",
    ]);
  });

  it("supports wildcards", () => {
    const text = "<!-- webvalidator-disable-next-line vnu:css-* -->\n<p style='color: nope'>";
    expect(kept(text, [f("vnu:css-invalid-value", 1), f("vnu:img-missing-alt", 1)])).toEqual(["vnu:img-missing-alt@1"]);
  });

  it("returns findings unchanged when there are no directives", () => {
    expect(kept("<p>x</p>", [f("a", 0)])).toEqual(["a@0"]);
  });
});
