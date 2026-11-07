import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";

const root = (): string => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const codeOf = (d: vscode.Diagnostic) => (typeof d.code === "object" ? String(d.code.value) : String(d.code));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) assert.fail(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}
const diags = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri);
const has = (uri: vscode.Uri, id: string) => diags(uri).some((d) => codeOf(d) === id);

function javaAvailable(): boolean {
  const exe = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
  const r = spawnSync(exe, ["-version"], { encoding: "utf8" });
  const m = /version "(\d+)/.exec(`${r.stderr}${r.stdout}`);
  return !!m && Number(m[1]) >= 17;
}

/** Writes a file in the fixture workspace and removes it after the test. */
const created: string[] = [];
function write(rel: string, content: string): vscode.Uri {
  const file = path.join(root(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  created.push(file);
  return vscode.Uri.file(file);
}
async function open(uri: vscode.Uri): Promise<vscode.TextEditor> {
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

describe("Phase 3–6 features", function () {
  before(function () {
    if (!javaAvailable()) this.skip();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const f of created.splice(0)) fs.rmSync(f, { recursive: true, force: true });
    fs.rmSync(path.join(root(), ".webvalidator.json"), { force: true });
    fs.rmSync(path.join(root(), ".webvalidator"), { recursive: true, force: true });
    const c = vscode.workspace.getConfiguration("webValidator");
    for (const key of ["rules", "jsp.mode", "jsp.renderedBaseUrl", "jsp.webRoot"]) await c.update(key, undefined, vscode.ConfigurationTarget.Global);
    await sleep(300);
  });

  it("reports JavaScript syntax errors and ESLint core rules with ECMAScript/ESLint as source", async () => {
    const uri = write("tmp-syntax.js", "var o = { a: 1, a: 2 };\nfunction f() {\n  var x = ;\n}\n");
    await open(uri);
    await waitFor("syntax error", () => has(uri, "eslint:syntax-error"));
    const d = diags(uri).find((x) => codeOf(x) === "eslint:syntax-error")!;
    assert.equal(d.source, "ECMAScript/ESLint");
    assert.equal(d.range.start.line, 2);
  });

  it("applies .webvalidator.json severities and 'off', and reloads when it changes", async () => {
    const uri = write("tmp-config.html", '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head>\n<body><img src="a.png"><center>x</center></body></html>\n');
    await open(uri);
    await waitFor("initial vnu diagnostics", () => has(uri, "vnu:obsolete-element") && has(uri, "vnu:img-missing-alt"));
    write(".webvalidator.json", '{\n  // comments are allowed\n  "rules": { "vnu:obsolete-element": "off", "vnu:img-missing-alt": "info" }\n}\n');
    await waitFor("config applied", () => !has(uri, "vnu:obsolete-element") && diags(uri).find((d) => codeOf(d) === "vnu:img-missing-alt")?.severity === vscode.DiagnosticSeverity.Information);
  });

  it("shows problems in .webvalidator.json itself", async () => {
    const cfg = write(".webvalidator.json", '{ "rules": { "vnu:x": "loud" }, "typo": 1 }');
    await open(write("tmp-trigger.html", "<p>x</p>"));
    const ds = await waitFor("config diagnostics", () => (diags(cfg).length >= 2 ? diags(cfg) : undefined));
    assert.ok(ds.some((d) => /rules\.vnu:x/.test(d.message)));
    assert.ok(ds.some((d) => /"typo" is not a known setting/.test(d.message)));
  });

  it("honours suppression comments", async () => {
    const uri = write("tmp-suppress.html", '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head><body>\n<!-- webvalidator-disable-next-line vnu:img-missing-alt -->\n<img src="a.png">\n<img src="b.png">\n</body></html>\n');
    await open(uri);
    const alts = await waitFor("alt diagnostics", () => {
      const a = diags(uri).filter((d) => codeOf(d) === "vnu:img-missing-alt");
      return a.length ? a : undefined;
    });
    assert.deepEqual(alts.map((d) => d.range.start.line), [4]);
  });

  it("offers quick fixes that work: add alt, disable for line, disable in config", async () => {
    const uri = write("tmp-fix.html", '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head><body>\n<img src="a.png">\n</body></html>\n');
    const editor = await open(uri);
    const d = await waitFor("alt diagnostic", () => diags(uri).find((x) => codeOf(x) === "vnu:img-missing-alt"));
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, d.range);
    const titles = actions.map((a) => a.title);
    for (const t of ['Add alt="" (decorative image)', "Disable vnu:img-missing-alt for this line", "Disable vnu:img-missing-alt for this file", "Disable vnu:img-missing-alt in .webvalidator.json"]) {
      assert.ok(titles.includes(t), `missing action ${t}; got ${titles.join(" | ")}`);
    }
    const fix = actions.find((a) => a.title.startsWith("Add alt"))!;
    assert.equal(fix.isPreferred, true);
    await vscode.workspace.applyEdit(fix.edit!);
    await editor.document.save();
    assert.equal(editor.document.lineAt(2).text, '<img src="a.png" alt="">');
    await waitFor("alt fixed", () => !has(uri, "vnu:img-missing-alt"));

    // "Disable in .webvalidator.json" creates the file and turns the rule off
    const other = write("tmp-fix2.html", '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head><body><center>x</center></body></html>\n');
    await open(other);
    await waitFor("obsolete diagnostic", () => has(other, "vnu:obsolete-element"));
    await vscode.commands.executeCommand("webValidator.disableRuleInConfig", other, "vnu:obsolete-element");
    const cfg = JSON.parse(fs.readFileSync(path.join(root(), ".webvalidator.json"), "utf8"));
    assert.deepEqual(cfg, { rules: { "vnu:obsolete-element": "off" } });
    await waitFor("rule off", () => !has(other, "vnu:obsolete-element"));
  });

  it("creates a custom rule that runs, including .mjs rules", async () => {
    const ruleFile = await vscode.commands.executeCommand<vscode.Uri>("webValidator.createCustomRule", {
      id: "custom/new-tab-noopener",
      languages: ["html", "jsp"],
      folder: vscode.workspace.workspaceFolders![0]!.uri,
      noOpen: true,
    });
    assert.ok(ruleFile && fs.existsSync(ruleFile.fsPath));
    assert.ok(fs.existsSync(path.join(path.dirname(ruleFile.fsPath), "webvalidator.d.ts")));
    const cfg = JSON.parse(fs.readFileSync(path.join(root(), ".webvalidator.json"), "utf8"));
    assert.deepEqual(cfg, { rules: { "custom/new-tab-noopener": "warning" }, rulesDirectories: [".webvalidator/rules"] });
    write(
      ".webvalidator/rules/esm-rule.mjs",
      'export default { id: "custom/esm-marquee", meta: { description: "x" }, create(ctx) { return { element(e) { if (e.tagName === "marquee") ctx.report({ node: e, message: "no marquee (esm)" }); } }; } };',
    );
    const page = write("tmp-rule.html", '<p><a href="x" target="_blank">x</a><marquee>m</marquee></p>\n');
    await open(page);
    await vscode.commands.executeCommand("webValidator.restartEngines");
    await waitFor("custom rule diagnostics", () => has(page, "custom/new-tab-noopener") && has(page, "custom/esm-marquee"));
    const d = diags(page).find((x) => codeOf(x) === "custom/new-tab-noopener")!;
    assert.equal(d.source, "Custom rule");
    assert.equal(d.range.start.character, 15); // the target attribute
  });

  it("validates the whole workspace with progress and keeps results for closed files", async () => {
    // A file that has never been opened in an editor.
    const unopened = write("tmp-unopened.html", '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head><body><img src="x.png"></body></html>\n');
    const summary = await vscode.commands.executeCommand<{ files: number; errors: number; cancelled: boolean }>("webValidator.validateWorkspace");
    assert.ok(summary.files >= 5, `files: ${summary.files}`);
    assert.ok(summary.errors > 0);
    assert.ok(has(unopened, "vnu:img-missing-alt"), "a file that is not open has diagnostics");
    await vscode.commands.executeCommand("webValidator.clearProblems");
    assert.ok(!has(unopened, "vnu:img-missing-alt"), "cleared");
  });

  describe("running pages", () => {
    let server: http.Server;
    let base = "";
    before(async () => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(req.url?.includes("orders")
          ? '<!DOCTYPE html>\n<html lang="en"><head><title>Orders</title></head><body>\n<img src="rendered.png">\n</body></html>\n'
          : '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head><body><center>live</center></body></html>\n');
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    after(() => new Promise<void>((r) => server.close(() => r())));

    it("validates a page from a local URL in a virtual document", async () => {
      const uri = await vscode.commands.executeCommand<vscode.Uri>("webValidator.validateRunningPage", `${base}/home`, { open: false });
      assert.equal(uri.scheme, "webvalidator-page");
      await waitFor("page diagnostics", () => has(uri, "vnu:obsolete-element"));
      const doc = await vscode.workspace.openTextDocument(uri);
      assert.match(doc.getText(), /<center>live<\/center>/);
    });

    it('validates the rendered page of a JSP in jsp.mode "rendered"', async () => {
      const c = vscode.workspace.getConfiguration("webValidator");
      await c.update("jsp.mode", "rendered", vscode.ConfigurationTarget.Global);
      await c.update("jsp.renderedBaseUrl", `${base}/app`, vscode.ConfigurationTarget.Global);
      await c.update("jsp.webRoot", ".", vscode.ConfigurationTarget.Global);
      const jsp = write("orders.jsp", "<%@ page contentType=\"text/html\" %>\n<img src=\"${img}\">\n");
      await open(jsp);
      await vscode.commands.executeCommand("webValidator.validateFile");
      const summary = await waitFor("rendered summary", () => diags(jsp).find((d) => codeOf(d) === "webvalidator/rendered-page"));
      assert.match(summary.message, /orders\.jsp: 1 error/);
      assert.ok(!has(jsp, "vnu:img-missing-alt"), "masked validation is replaced by rendered validation");
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", jsp, summary.range);
      assert.ok(actions.some((a) => a.title === "Show rendered page"));
      await vscode.commands.executeCommand("webValidator.showRenderedPage", jsp);
      const active = vscode.window.activeTextEditor!.document;
      assert.equal(active.uri.scheme, "webvalidator-page");
      await waitFor("rendered page diagnostics", () => has(active.uri, "vnu:img-missing-alt"));
    });
  });
});
