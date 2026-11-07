import * as vscode from "vscode";
import type { DiagnosticsManager } from "../diagnostics/diagnostics";
import type { Fix } from "../engines/Engine";
import { RULE_ERROR_RULE } from "../rules/registry";
import { PAGE_SCHEME } from "../ui/pageStore";
import { RENDERED_PAGE_RULE } from "../validationService";
import { disableForFileFix, disableForLineFix } from "./suppressionEdits";

function toEdit(uri: vscode.Uri, fix: Fix): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const e of fix.edits) {
    edit.replace(uri, new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText);
  }
  return edit;
}

/** Quick fixes, suggestions and "disable rule" actions for this extension's diagnostics. */
export class WebValidatorCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

  constructor(private readonly diagnostics: DiagnosticsManager) {}

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const disabled = new Set<string>();
    const text = doc.getText();
    const readOnly = doc.uri.scheme === PAGE_SCHEME;

    for (const d of context.diagnostics) {
      const f = this.diagnostics.findingFor(doc.uri, d);
      if (!f) continue;

      if (f.ruleId === RENDERED_PAGE_RULE) {
        const a = new vscode.CodeAction("Show rendered page", vscode.CodeActionKind.QuickFix);
        a.command = { command: "webValidator.showRenderedPage", title: "Show rendered page", arguments: [doc.uri] };
        a.diagnostics = [d];
        actions.push(a);
        continue;
      }
      if (f.ruleId === RULE_ERROR_RULE) {
        const a = new vscode.CodeAction("Show the error in the Web Validator output", vscode.CodeActionKind.QuickFix);
        a.command = { command: "webValidator.showOutput", title: "Show output" };
        a.diagnostics = [d];
        actions.push(a);
        continue;
      }

      if (!readOnly) {
        if (f.fix) {
          const a = new vscode.CodeAction(f.fix.title, vscode.CodeActionKind.QuickFix);
          a.edit = toEdit(doc.uri, f.fix);
          a.diagnostics = [d];
          a.isPreferred = true;
          actions.push(a);
        }
        for (const s of f.suggestions ?? []) {
          const a = new vscode.CodeAction(s.title, vscode.CodeActionKind.QuickFix);
          a.edit = toEdit(doc.uri, s);
          a.diagnostics = [d];
          actions.push(a);
        }
      }

      if (readOnly || disabled.has(f.ruleId)) continue;
      disabled.add(f.ruleId);
      const line = disableForLineFix(text, doc.languageId, doc.uri.toString(), f.range.start.line, f.ruleId);
      const lineAction = new vscode.CodeAction(line.title, vscode.CodeActionKind.QuickFix);
      lineAction.edit = toEdit(doc.uri, line);
      lineAction.diagnostics = [d];
      const file = disableForFileFix(text, doc.languageId, doc.uri.toString(), f.ruleId);
      const fileAction = new vscode.CodeAction(file.title, vscode.CodeActionKind.QuickFix);
      fileAction.edit = toEdit(doc.uri, file);
      fileAction.diagnostics = [d];
      const configAction = new vscode.CodeAction(`Disable ${f.ruleId} in .webvalidator.json`, vscode.CodeActionKind.QuickFix);
      configAction.command = {
        command: "webValidator.disableRuleInConfig",
        title: configAction.title,
        arguments: [doc.uri, f.ruleId],
      };
      configAction.diagnostics = [d];
      actions.push(lineAction, fileAction, configAction);
    }
    return actions;
  }
}
