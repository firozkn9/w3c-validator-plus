import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/** A token as returned by VS Code's internal `_workbench.captureSyntaxTokens` command. */
interface Token {
  c: string;
  t: string;
}

const root = (): string => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "fixture workspace must be open");
  return folder.uri.fsPath;
};

const created: string[] = [];
function write(name: string, text: string): vscode.Uri {
  const file = path.join(root(), name);
  fs.writeFileSync(file, text);
  created.push(file);
  return vscode.Uri.file(file);
}

async function tokens(uri: vscode.Uri): Promise<Token[]> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const result = await vscode.commands.executeCommand<Token[]>("_workbench.captureSyntaxTokens", uri);
  assert.ok(Array.isArray(result) && result.length > 0, "syntax tokens were captured");
  return result;
}

/** Scopes of the first token whose text is exactly `text`. */
function scopesOf(ts: Token[], text: string): string {
  const t = ts.find((x) => x.c === text);
  assert.ok(t, `token "${text}" exists; tokens: ${JSON.stringify(ts.map((x) => x.c))}`);
  return t.t;
}

describe("JSP colouring", () => {
  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const f of created) fs.rmSync(f, { force: true });
  });

  it("opens .jsp and .jspf files as HTML", async () => {
    for (const name of ["colors-a.jsp", "colors-b.jspf"]) {
      const doc = await vscode.workspace.openTextDocument(write(name, "<p>hi</p>\n"));
      assert.equal(doc.languageId, "html", name);
    }
  });

  it("colours JSP tags, Java inside them, EL, and keeps HTML colours", async () => {
    const uri = write(
      "colors-c.jsp",
      [
        '<%@ page contentType="text/html" %>',
        "<%-- hidden note --%>",
        '<input value="<%= user.getName() %>" title="${order.total}">',
        "<% if (admin) { %><b>Admin</b><% } %>",
        "<p>${empty items ? 'none' : items}</p>",
        "",
      ].join("\n"),
    );
    const ts = await tokens(uri);

    assert.match(scopesOf(ts, "<%@"), /punctuation\.section\.embedded\.begin\.jsp/);
    assert.match(scopesOf(ts, "page"), /keyword\.control\.directive\.jsp/);
    assert.match(scopesOf(ts, "contentType"), /entity\.other\.attribute-name\.jsp/);
    assert.match(scopesOf(ts, " hidden note "), /comment\.block\.jsp/);
    assert.match(scopesOf(ts, "<%="), /punctuation\.section\.embedded\.begin\.jsp/);
    assert.match(scopesOf(ts, "if"), /source\.java/);
    assert.match(scopesOf(ts, "if"), /keyword/);
    assert.match(scopesOf(ts, "${"), /punctuation\.definition\.template-expression\.begin\.el/);
    assert.match(scopesOf(ts, "empty"), /keyword\.operator\.word\.el/);
    assert.match(scopesOf(ts, "total"), /variable\.other\.el/);
    // Ordinary HTML is still coloured by the built-in HTML grammar.
    assert.match(scopesOf(ts, "input"), /entity\.name\.tag/);
    assert.match(scopesOf(ts, "Admin"), /text\.html/);
  });

  it("leaves JavaScript template literals in <script> alone", async () => {
    const uri = write("colors-d.html", "<script>\nconst s = `Hi ${name}`;\n</script>\n");
    const ts = await tokens(uri);
    for (const t of ts) assert.doesNotMatch(t.t, /\.el\b|\.jsp\b/, `token "${t.c}" has no JSP scopes`);
  });

  it("validates a .jsp file as JSP only while 'jsp' is in webValidator.languages", async () => {
    const config = vscode.workspace.getConfiguration("webValidator");
    const uri = write("colors-e.jsp", '<%@ page contentType="text/html" %>\n<img src="${img}">\n');
    const doc = await vscode.workspace.openTextDocument(uri);
    try {
      await config.update("languages", ["html", "javascript"], vscode.ConfigurationTarget.Global);
      const api = vscode.extensions.all.find((e) => e.packageJSON.name === "w3c-validator-plus")!.exports as {
        service: { validate(d: vscode.TextDocument, trigger: string): Promise<{ skipped?: string }> };
      };
      const outcome = await api.service.validate(doc, "manual");
      assert.match(outcome.skipped ?? "", /Language 'jsp' is not in webValidator\.languages/);
    } finally {
      await config.update("languages", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
