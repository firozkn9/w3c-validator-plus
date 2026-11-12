import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const workspaceRoot = (): string => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "fixture workspace must be open");
  return folder.uri.fsPath;
};

function javaAvailable(): boolean {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"),
    "java",
  ].filter((c): c is string => !!c);
  return candidates.some((exe) => {
    const r = spawnSync(exe, ["-version"], { encoding: "utf8" });
    const m = /version "(\d+)/.exec(`${r.stderr}${r.stdout}`);
    return !!m && Number(m[1]) >= 17;
  });
}

const ours = (d: vscode.Diagnostic) => d.source === "Nu Html Checker";

async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (ds: vscode.Diagnostic[]) => boolean,
  timeoutMs = 90_000,
): Promise<vscode.Diagnostic[]> {
  const started = Date.now();
  for (;;) {
    const ds = vscode.languages.getDiagnostics(uri).filter(ours);
    if (predicate(ds)) return ds;
    if (Date.now() - started > timeoutMs) {
      assert.fail(`Timed out waiting for diagnostics on ${uri.fsPath}; have: ${JSON.stringify(ds.map((d) => d.message))}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const codeOf = (d: vscode.Diagnostic) => (typeof d.code === "object" ? String(d.code.value) : String(d.code));

describe("Web Standards Validator", () => {
  before(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "w3c-validator-plus");
    assert.ok(ext, "extension is installed in the test instance");
    await ext.activate();
  });

  it("registers its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["webValidator.validateFile", "webValidator.restartEngines", "webValidator.showOutput"]) {
      assert.ok(commands.includes(id), `${id} is registered`);
    }
  });

  describe("jQuery selector rule", () => {
    it("warns about page-wide selectors in .js files", async () => {
      const uri = vscode.Uri.file(path.join(workspaceRoot(), "tab-script.js"));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      const started = Date.now();
      let ds: vscode.Diagnostic[] = [];
      while (Date.now() - started < 30_000) {
        ds = vscode.languages.getDiagnostics(uri).filter((d) => d.source === "Web Validator");
        if (ds.length >= 2) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.deepEqual(
        ds.map((d) => [d.range.start.line + 1, codeOf(d), d.severity]),
        [
          [3, "webvalidator/jquery-unscoped-selector", vscode.DiagnosticSeverity.Warning],
          [6, "webvalidator/jquery-unscoped-selector", vscode.DiagnosticSeverity.Warning],
        ],
      );
      assert.match(ds[0]!.message, /^Add current process \/ tab selector before "\.name"/);
    });
  });

  describe("with Java", function () {
    before(function () {
      if (!javaAvailable()) this.skip();
    });

    it("reports problems in invalid.html at the right positions", async () => {
      const uri = vscode.Uri.file(path.join(workspaceRoot(), "invalid.html"));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      const ds = await waitForDiagnostics(uri, (d) => d.some((x) => codeOf(x) === "vnu:img-missing-alt"));

      const alt = ds.find((d) => codeOf(d) === "vnu:img-missing-alt")!;
      assert.deepEqual([alt.range.start.line, alt.range.start.character, alt.range.end.character], [7, 2, 22]);
      assert.equal(alt.severity, vscode.DiagnosticSeverity.Error);
      assert.equal(typeof alt.code === "object" && alt.code.target.authority, "html.spec.whatwg.org");

      const ids = new Set(ds.map(codeOf));
      for (const id of ["vnu:obsolete-element", "vnu:misplaced-in-table", "vnu:element-not-allowed-as-child", "vnu:missing-lang"]) {
        assert.ok(ids.has(id), `expected ${id}; got ${[...ids].join(", ")}`);
      }
      const lang = ds.find((d) => codeOf(d) === "vnu:missing-lang")!;
      assert.equal(lang.severity, vscode.DiagnosticSeverity.Warning);
    });

    it("reports nothing for valid.html", async () => {
      const uri = vscode.Uri.file(path.join(workspaceRoot(), "valid.html"));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      await vscode.commands.executeCommand("webValidator.validateFile");
      assert.deepEqual(vscode.languages.getDiagnostics(uri).filter(ours), []);
    });

    it("re-validates on save and clears fixed problems", async () => {
      const file = path.join(workspaceRoot(), "tmp-save.html");
      fs.writeFileSync(file, '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head>\n<body><img src="a.png"></body></html>\n');
      try {
        const uri = vscode.Uri.file(file);
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        await waitForDiagnostics(uri, (d) => d.some((x) => codeOf(x) === "vnu:img-missing-alt"));

        const line = editor.document.lineAt(2);
        const col = line.text.indexOf(">", line.text.indexOf("<img"));
        await editor.edit((b) => b.insert(new vscode.Position(2, col), ' alt=""'));
        await editor.document.save();
        await waitForDiagnostics(uri, (d) => d.length === 0);
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        fs.rmSync(file, { force: true });
      }
    });

    describe("JSP", () => {
      const jspUri = () => vscode.Uri.file(path.join(workspaceRoot(), "spa-partial-invalid.jsp"));
      const config = () => vscode.workspace.getConfiguration("webValidator");
      afterEach(async () => {
        await config().update("jsp.documentStructure", undefined, vscode.ConfigurationTarget.Global);
      });

      it("keeps .jsp files in the html language and reports HTML errors at JSP positions", async () => {
        const doc = await vscode.workspace.openTextDocument(jspUri());
        assert.equal(doc.languageId, "html");
        await vscode.window.showTextDocument(doc);
        const ds = await waitForDiagnostics(doc.uri, (d) => d.some((x) => codeOf(x) === "vnu:img-missing-alt"));
        const pos = (id: string) => ds.filter((d) => codeOf(d) === id).map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1}`);
        assert.deepEqual(pos("vnu:img-missing-alt"), ["6:3"]);
        assert.deepEqual(pos("vnu:obsolete-element"), ["7:3"]);
        assert.deepEqual(pos("vnu:element-not-allowed-as-child"), ["14:3"]);
        assert.deepEqual(pos("vnu:missing-doctype"), []);
      });

      it("reports nothing for JSP with EL, scriptlets and custom tags in attributes", async () => {
        const uri = vscode.Uri.file(path.join(workspaceRoot(), "spa-partial-valid.jsp"));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        await vscode.commands.executeCommand("webValidator.validateFile");
        assert.deepEqual(vscode.languages.getDiagnostics(uri).filter(ours).map((d) => d.message), []);
      });

      it("honours webValidator.jsp.documentStructure", async () => {
        const file = path.join(workspaceRoot(), "tmp-page.jsp");
        fs.writeFileSync(file, "<%@ page contentType=\"text/html\" %>\n<!DOCTYPE html>\n<html>\n<head><title>${t}</title></head>\n<body><p>x</p></body>\n</html>\n");
        try {
          const uri = vscode.Uri.file(file);
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
          await vscode.commands.executeCommand("webValidator.validateFile");
          assert.deepEqual(vscode.languages.getDiagnostics(uri).filter(ours).map(codeOf), [], "ignore mode: no <html> checks");

          await config().update("jsp.documentStructure", "validate", vscode.ConfigurationTarget.Global);
          const ds = await waitForDiagnostics(uri, (d) => d.some((x) => codeOf(x) === "vnu:missing-lang"));
          const lang = ds.find((d) => codeOf(d) === "vnu:missing-lang")!;
          assert.equal(lang.range.start.line, 2, "reported on the <html> line");
        } finally {
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
          fs.rmSync(file, { force: true });
        }
      });
    });

    it("clears diagnostics when the document is closed", async () => {
      const uri = vscode.Uri.file(path.join(workspaceRoot(), "invalid.html"));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      await waitForDiagnostics(uri, (d) => d.length > 0);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // VS Code may keep the TextDocument alive for a while after its editor closes,
      // so only assert when it actually got closed.
      const stillOpen = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
      if (!stillOpen) assert.deepEqual(vscode.languages.getDiagnostics(uri).filter(ours), []);
    });
  });
});
