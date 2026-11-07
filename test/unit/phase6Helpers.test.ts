import * as http from "node:http";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addHtmlFixes } from "../../src/codeActions/htmlFixes";
import { commentStyleAt, disableForFileFix, disableForLineFix } from "../../src/codeActions/suppressionEdits";
import { applyReplacement, setRuleInConfigText } from "../../src/config/configEdit";
import { parseJsonc } from "../../src/config/jsonc";
import type { Fix } from "../../src/engines/Engine";
import { vnuResponseToFindings, type VnuResponse } from "../../src/engines/vnu/vnuMessages";
import { applySuppressions } from "../../src/rules/suppressions";
import { fetchPage, isLocalUrl, renderedUrlFor } from "../../src/util/fetchPage";
import { globToRegExp, isExcluded } from "../../src/util/glob";
import { LineIndex } from "../../src/rules/dom";

/** Applies a fix's edits (non-overlapping, any order) to text. */
function apply(text: string, fix: Fix): string {
  const lines = new LineIndex(text);
  const edits = fix.edits
    .map((e) => ({ s: lines.offsetAt(e.range.start), e: lines.offsetAt(e.range.end), t: e.newText }))
    .sort((a, b) => b.s - a.s);
  let out = text;
  for (const e of edits) out = out.slice(0, e.s) + e.t + out.slice(e.e);
  return out;
}

describe("HTML quick fixes", () => {
  const fixtures = join(__dirname, "..", "fixtures", "html");
  const html = readFileSync(join(fixtures, "invalid.html"), "utf8");
  const vnu = JSON.parse(readFileSync(join(fixtures, "invalid.vnu.json"), "utf8")) as VnuResponse;
  const findings = addHtmlFixes(vnuResponseToFindings(vnu, html), html, { locale: "de-CH", fragment: false });
  const fixFor = (id: string) => findings.find((f) => f.ruleId === id)?.fix;

  it('adds alt="" to the image on the real vnu position', () => {
    const fix = fixFor("vnu:img-missing-alt")!;
    expect(fix.title).toBe('Add alt="" (decorative image)');
    expect(apply(html, fix).split("\n")[7]).toBe('  <img src="logo.png" alt="">');
  });

  it("adds lang from the editor locale to <html>", () => {
    expect(apply(html, fixFor("vnu:missing-lang")!).split("\n")[1]).toBe('<html lang="de">');
  });

  it("handles self-closing tags and adds a doctype only for full pages", () => {
    const text = '<p>\n<img src="a.png"/>';
    const f = { ruleId: "vnu:img-missing-alt", source: "s", severity: "error" as const, message: "m", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 18 } } };
    expect(apply(text, addHtmlFixes([f], text, { locale: "en", fragment: false })[0]!.fix!)).toBe('<p>\n<img src="a.png" alt=""/>');
    const doctype = { ...f, ruleId: "vnu:missing-doctype", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
    expect(addHtmlFixes([doctype], text, { locale: "en", fragment: true })[0]!.fix).toBeUndefined();
    expect(apply(text, addHtmlFixes([doctype], text, { locale: "en", fragment: false })[0]!.fix!)).toBe(`<!DOCTYPE html>\n${text}`);
  });
});

describe("suppression quick fixes", () => {
  const f = (ruleId: string, line: number) => ({ ruleId, source: "s", severity: "error" as const, message: "m", range: { start: { line, character: 2 }, end: { line, character: 5 } } });

  it("picks the comment syntax for the position", () => {
    const html = '<p>x</p>\n<script>\n  $(".a");\n</script>';
    expect(commentStyleAt(html, "html", "file:///a.html", 0)).toBe("html");
    expect(commentStyleAt(html, "html", "file:///a.html", html.indexOf("$"))).toBe("js");
    expect(commentStyleAt(html, "html", "file:///a.jsp", 0)).toBe("jsp");
    expect(commentStyleAt("x()", "javascript", "file:///a.js", 0)).toBe("js");
  });

  it.each([
    ["html", "file:///a.html", "<div>\n  <img src=x>\n</div>", 1, "<div>\n  <!-- webvalidator-disable-next-line vnu:img-missing-alt -->\n  <img src=x>\n</div>"],
    ["jsp", "file:///a.jsp", "<div>\n  <img src=x>\n</div>", 1, "<div>\n  <%-- webvalidator-disable-next-line vnu:img-missing-alt --%>\n  <img src=x>\n</div>"],
    ["html", "file:///a.html", "<script>\n    go();\n</script>", 1, "<script>\n    // webvalidator-disable-next-line vnu:img-missing-alt\n    go();\n</script>"],
  ])("disables a rule for one line (%s)", (languageId, uri, text, line, expected) => {
    const fixed = apply(text, disableForLineFix(text, languageId, uri, line, "vnu:img-missing-alt"));
    expect(fixed).toBe(expected);
    // and the inserted comment really suppresses the finding on the (moved) line
    expect(applySuppressions([f("vnu:img-missing-alt", line + 1)], fixed)).toEqual([]);
  });

  it("disables a rule for the whole file, keeping CRLF and a shebang first", () => {
    expect(apply("<p>\r\n", disableForFileFix("<p>\r\n", "html", "file:///a.html", "vnu:x"))).toBe("<!-- webvalidator-disable vnu:x -->\r\n<p>\r\n");
    expect(apply("#!/usr/bin/env node\nrun();", disableForFileFix("#!/usr/bin/env node\nrun();", "javascript", "file:///a.js", "eslint:x"))).toBe(
      "#!/usr/bin/env node\n/* webvalidator-disable eslint:x */\nrun();",
    );
    const fixed = apply("<p>\n<img>", disableForFileFix("<p>\n<img>", "jsp", "file:///a.jsp", "vnu:x"));
    expect(applySuppressions([f("vnu:x", 2)], fixed)).toEqual([]);
  });
});

describe("setRuleInConfigText", () => {
  const set = (text: string, id = "vnu:x", value = "off") => applyReplacement(text, setRuleInConfigText(text, id, value));

  it("creates a file", () => {
    expect(parseJsonc(set(""))).toEqual({ rules: { "vnu:x": "off" } });
  });

  it("adds rules to an existing object, keeping comments", () => {
    const text = '{\n  // team config\n  "extends": ["recommended"]\n}';
    const out = set(text);
    expect(out).toContain("// team config");
    expect(parseJsonc(out)).toEqual({ rules: { "vnu:x": "off" }, extends: ["recommended"] });
    expect(parseJsonc(set("{}"))).toEqual({ rules: { "vnu:x": "off" } });
  });

  it("adds to or replaces inside an existing rules object", () => {
    const text = '{\n  "rules": {\n    "a": "warning", // keep\n    "vnu:x": ["error", { "o": 1 }]\n  },\n  "exclude": []\n}';
    const replaced = set(text);
    expect(parseJsonc(replaced)).toEqual({ rules: { a: "warning", "vnu:x": "off" }, exclude: [] });
    expect(replaced).toContain("// keep");
    expect(parseJsonc(set(text, "eslint:no-var"))).toEqual({ rules: { "eslint:no-var": "off", a: "warning", "vnu:x": ["error", { o: 1 }] }, exclude: [] });
    expect(parseJsonc(set('{ "rules": {} }'))).toEqual({ rules: { "vnu:x": "off" } });
  });

  it("refuses broken files instead of corrupting them", () => {
    expect(() => set('{ "rules": ')).toThrow(/Invalid JSON/);
    expect(() => set('{ "rules": [] }')).toThrow(/must be an object/);
  });
});

describe("glob", () => {
  it.each([
    ["**/generated/**", "src/generated/a.html", true],
    ["**/generated/**", "generated/a.html", true],
    ["**/generated/**", "src/gen/a.html", false],
    ["*.min.js", "a.min.js", true],
    ["*.min.js", "lib/a.min.js", false],
    ["**/*.min.js", "lib/a.min.js", true],
    ["src/{a,b}/*.jsp", "src/b/x.jsp", true],
    ["src/{a,b}/*.jsp", "src/c/x.jsp", false],
    ["file?.html", "file1.html", true],
  ])("%s ~ %s → %s", (glob, p, expected) => {
    expect(globToRegExp(glob).test(p)).toBe(expected);
  });

  it("matches relative to the pattern's base folder", () => {
    const base = path.resolve("/ws");
    expect(isExcluded(path.join(base, "dist", "x.html"), [{ baseDir: base, glob: "dist/**" }])).toBe(true);
    expect(isExcluded(path.resolve("/other/dist/x.html"), [{ baseDir: base, glob: "dist/**" }])).toBe(false);
  });
});

describe("running pages", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (!req.headers["user-agent"]) return void res.writeHead(400).end();
      if (req.url === "/app/old") return void res.writeHead(302, { Location: "/app/page.jsp" }).end();
      if (req.url === "/app/away") return void res.writeHead(302, { Location: "http://example.com/" }).end();
      if (req.url === "/app/big") return void res.writeHead(200).end("x".repeat(2000));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!DOCTYPE html><title>t</title><p>é</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("fetches pages, follows same-host redirects and limits size", async () => {
    const page = await fetchPage(`${base}/app/old`);
    expect(page).toMatchObject({ status: 200, url: `${base}/app/page.jsp`, contentType: "text/html; charset=utf-8" });
    expect(page.body).toContain("é");
    await expect(fetchPage(`${base}/app/away`)).rejects.toThrow(/another host/);
    await expect(fetchPage(`${base}/app/big`, { maxBytes: 1000 })).rejects.toThrow(/larger than/);
  });

  it("recognises local URLs", () => {
    for (const u of ["http://localhost:8080/", "http://127.0.0.1/", "http://[::1]:3000/", "http://app.localhost/"]) expect(isLocalUrl(new URL(u))).toBe(true);
    for (const u of ["http://example.com/", "http://10.0.0.5/", "http://localhost.evil.com/"]) expect(isLocalUrl(new URL(u))).toBe(false);
  });

  it("maps a JSP to its URL in the running application", () => {
    const webRoot = path.resolve("/ws/src/main/webapp");
    expect(renderedUrlFor(path.join(webRoot, "orders", "list page.jsp"), webRoot, "http://localhost:8080/shop")).toEqual({
      url: "http://localhost:8080/shop/orders/list%20page.jsp",
    });
    expect(renderedUrlFor(path.join(webRoot, "WEB-INF", "views", "a.jsp"), webRoot, "http://localhost:8080")).toEqual({
      error: expect.stringMatching(/WEB-INF/),
    });
    expect(renderedUrlFor(path.resolve("/elsewhere/a.jsp"), webRoot, "http://localhost:8080")).toEqual({ error: expect.stringMatching(/not inside the web root/) });
    expect(renderedUrlFor(path.join(webRoot, "a.jsp"), webRoot, "")).toEqual({ error: expect.stringMatching(/renderedBaseUrl/) });
  });
});
