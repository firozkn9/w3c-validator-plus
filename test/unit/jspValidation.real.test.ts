/**
 * JSP files through the real Nu Html Checker. Skipped when no Java 17+ runtime is found.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "../../src/engines/Engine";
import { VnuEngine } from "../../src/engines/vnuEngine";
import type { JspDocumentStructure } from "../../src/preprocess/jspDocument";
import { nullLogger } from "../../src/util/logger";
import { findJavaSync, vnuJarPath } from "./helpers/java";

const lookup = findJavaSync();
const dir = join(__dirname, "..", "fixtures", "jsp");

function engineFor(documentStructure: JspDocumentStructure) {
  return new VnuEngine(
    { mode: "local", serverUrl: "", jarPath: vnuJarPath, timeoutMs: 30_000 },
    {
      logger: nullLogger,
      findJava: async () => lookup,
      jspOptions: () => ({ documentStructure, customTagPrefixes: ["c", "fmt", "fn"] }),
    },
  );
}

async function check(engine: VnuEngine, file: string, languageId = "jsp"): Promise<Finding[]> {
  const text = readFileSync(join(dir, file), "utf8");
  return engine.validate({ uri: `file:///app/${file}`, languageId, text, version: 1 }, new AbortController().signal);
}

/** 1-based "line:col" of a finding's start, as shown in the editor. */
const at = (f: Finding) => `${f.range.start.line + 1}:${f.range.start.character + 1}`;
const where = (fs: Finding[], ruleId: string) => fs.filter((f) => f.ruleId === ruleId).map(at);
const STRUCTURE_RULES = ["vnu:missing-doctype", "vnu:missing-lang", "vnu:missing-required-child", "vnu:missing-h1", "vnu:stray-end-tag"];

describe.skipIf(!lookup.runtime)("JSP validation (real JVM)", () => {
  const ignore = engineFor("ignore");
  const validate = engineFor("validate");
  afterAll(async () => {
    await ignore.dispose();
    await validate.dispose();
  });

  describe("invalid HTML inside a JSP fragment is reported at the right line and column", () => {
    let findings: Finding[] = [];
    it("validates", async () => {
      findings = await check(ignore, "spa-partial-invalid.jsp");
      expect(findings.length).toBeGreaterThan(0);
    });
    it("missing alt (line 6)", () => expect(where(findings, "vnu:img-missing-alt")).toEqual(["6:3"]));
    it("obsolete <center> (line 7)", () => expect(where(findings, "vnu:obsolete-element")).toEqual(["7:3"]));
    it("<div> inside <table> (line 12, after a <c:forEach>)", () =>
      expect(where(findings, "vnu:misplaced-in-table")).toContain("12:5"));
    it("<li> outside a list (line 14)", () => expect(where(findings, "vnu:element-not-allowed-as-child")).toEqual(["14:3"]));
    it("unclosed elements (lines 4 and 15)", () =>
      expect(where(findings, "vnu:unclosed-element").sort()).toEqual(["15:3", "4:1"]));
    it("no document-structure findings for a fragment", () => {
      for (const id of ["vnu:missing-doctype", "vnu:missing-lang", "vnu:missing-required-child", "vnu:missing-h1"]) {
        expect(where(findings, id), id).toEqual([]);
      }
    });
    it("no findings inside the JSP-only lines (directives, comment)", () => {
      expect(findings.filter((f) => f.range.start.line < 3)).toEqual([]);
    });
  });

  it("EL, scriptlets and custom tags in attributes do not cause false errors", async () => {
    expect(await check(ignore, "spa-partial-valid.jsp")).toEqual([]);
  });

  it("a header that opens <body> without closing it is clean", async () => {
    expect(await check(ignore, "header.jsp")).toEqual([]);
  });

  it("a footer that closes </body></html> without opening them is clean", async () => {
    expect(await check(ignore, "footer.jsp")).toEqual([]);
  });

  it("documentStructure=ignore skips <html> checks on full pages but still checks content", async () => {
    const fs = await check(ignore, "full-page.jsp");
    expect(fs.map((f) => f.ruleId)).toEqual(["vnu:img-missing-alt"]);
    expect(fs.map(at)).toEqual(["9:3"]);
    for (const id of STRUCTURE_RULES) expect(where(fs, id)).toEqual([]);
  });

  it("documentStructure=validate checks full pages, e.g. the missing lang on <html>", async () => {
    const fs = await check(validate, "full-page.jsp");
    expect(where(fs, "vnu:missing-lang")).toEqual(["3:1"]);
    expect(where(fs, "vnu:img-missing-alt")).toEqual(["9:3"]);
  });

  it("documentStructure=validate still treats files without <html> as fragments", async () => {
    expect(await check(validate, "footer.jsp")).toEqual([]);
    const fs = await check(validate, "spa-partial-invalid.jsp");
    expect(where(fs, "vnu:missing-doctype")).toEqual([]);
  });

  it("treats *.jsp as JSP even when the editor language is html", async () => {
    expect(await check(ignore, "spa-partial-valid.jsp", "html")).toEqual([]);
  });
});
