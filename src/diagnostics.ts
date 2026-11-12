// Publishes findings as diagnostics (one collection per engine, so engines
// update independently) and offers quick fixes for them.
import * as vscode from "vscode";
import { RULE_ERROR_RULE, type Finding, type Fix, type Severity } from "./core";
import { disableForFileFix, disableForLineFix } from "./suppressions";
import { PAGE_SCHEME, RENDERED_PAGE_RULE } from "./validationService";

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(f: Finding): vscode.Diagnostic {
  const { start, end } = f.range;
  const d = new vscode.Diagnostic(new vscode.Range(start.line, start.character, end.line, end.character), f.message, SEVERITY[f.severity]);
  d.source = f.source;
  d.code = f.docsUrl ? { value: f.ruleId, target: vscode.Uri.parse(f.docsUrl) } : f.ruleId;
  return d;
}

// Code actions get copies of our diagnostics, so they are matched by content.
function diagnosticKey(d: vscode.Diagnostic): string {
  const code = typeof d.code === "object" ? String(d.code.value) : String(d.code ?? "");
  const r = d.range;
  return `${code}|${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}|${d.message}`;
}

export class DiagnosticsManager implements vscode.Disposable {
  private readonly collections = new Map<string, vscode.DiagnosticCollection>();
  private readonly findings = new Map<string, Map<string, Map<string, Finding>>>(); // uri -> engine -> key -> finding
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  private collection(engineId: string): vscode.DiagnosticCollection {
    let c = this.collections.get(engineId);
    if (!c) {
      c = vscode.languages.createDiagnosticCollection(`webValidator.${engineId}`);
      this.collections.set(engineId, c);
    }
    return c;
  }

  set(uri: vscode.Uri, engineId: string, findings: readonly Finding[]): void {
    const byKey = new Map<string, Finding>();
    const diagnostics = findings.map((f) => {
      const d = toDiagnostic(f);
      byKey.set(diagnosticKey(d), f);
      return d;
    });
    this.collection(engineId).set(uri, diagnostics);
    let perUri = this.findings.get(uri.toString());
    if (!perUri) this.findings.set(uri.toString(), (perUri = new Map()));
    perUri.set(engineId, byKey);
    this.changed.fire(uri);
  }

  findingFor(uri: vscode.Uri, d: vscode.Diagnostic): Finding | undefined {
    const key = diagnosticKey(d);
    for (const byKey of this.findings.get(uri.toString())?.values() ?? []) {
      const f = byKey.get(key);
      if (f) return f;
    }
    return undefined;
  }

  clearEngine(uri: vscode.Uri, engineId: string): void {
    this.collections.get(engineId)?.delete(uri);
    this.findings.get(uri.toString())?.delete(engineId);
    this.changed.fire(uri);
  }

  clear(uri: vscode.Uri): void {
    for (const c of this.collections.values()) c.delete(uri);
    this.findings.delete(uri.toString());
    this.changed.fire(uri);
  }

  clearAll(): void {
    for (const c of this.collections.values()) c.clear();
    this.findings.clear();
  }

  get(uri: vscode.Uri): vscode.Diagnostic[] {
    return [...this.collections.values()].flatMap((c) => [...(c.get(uri) ?? [])]);
  }

  counts(uri: vscode.Uri): { errors: number; warnings: number; infos: number } {
    const counts = { errors: 0, warnings: 0, infos: 0 };
    for (const d of this.get(uri)) {
      if (d.severity === vscode.DiagnosticSeverity.Error) counts.errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) counts.warnings++;
      else counts.infos++;
    }
    return counts;
  }

  dispose(): void {
    for (const c of this.collections.values()) c.dispose();
    this.collections.clear();
    this.changed.dispose();
  }
}

function toEdit(uri: vscode.Uri, fix: Fix): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const { range: r, newText } of fix.edits) {
    edit.replace(uri, new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character), newText);
  }
  return edit;
}

function action(title: string, diagnostic: vscode.Diagnostic, what: { edit?: vscode.WorkspaceEdit; command?: vscode.Command }): vscode.CodeAction {
  const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  a.diagnostics = [diagnostic];
  if (what.edit) a.edit = what.edit;
  if (what.command) a.command = what.command;
  return a;
}

export class WebValidatorCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

  constructor(private readonly diagnostics: DiagnosticsManager) {}

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const disabled = new Set<string>();
    const text = doc.getText();
    const uri = doc.uri.toString();
    const readOnly = doc.uri.scheme === PAGE_SCHEME;

    for (const d of context.diagnostics) {
      const f = this.diagnostics.findingFor(doc.uri, d);
      if (!f) continue;

      if (f.ruleId === RENDERED_PAGE_RULE) {
        const command = { command: "webValidator.showRenderedPage", title: "Show rendered page", arguments: [doc.uri] };
        actions.push(action("Show rendered page", d, { command }));
        continue;
      }
      if (f.ruleId === RULE_ERROR_RULE) {
        actions.push(action("Show the error in the Web Validator output", d, { command: { command: "webValidator.showOutput", title: "Show output" } }));
        continue;
      }
      if (readOnly) continue;

      if (f.fix) {
        const a = action(f.fix.title, d, { edit: toEdit(doc.uri, f.fix) });
        a.isPreferred = true;
        actions.push(a);
      }
      for (const s of f.suggestions ?? []) actions.push(action(s.title, d, { edit: toEdit(doc.uri, s) }));

      // The disable actions once per rule, not once per diagnostic.
      if (disabled.has(f.ruleId)) continue;
      disabled.add(f.ruleId);
      const line = disableForLineFix(text, doc.languageId, uri, f.range.start.line, f.ruleId);
      const file = disableForFileFix(text, doc.languageId, uri, f.ruleId);
      const configTitle = `Disable ${f.ruleId} in .webvalidator.json`;
      actions.push(
        action(line.title, d, { edit: toEdit(doc.uri, line) }),
        action(file.title, d, { edit: toEdit(doc.uri, file) }),
        action(configTitle, d, { command: { command: "webValidator.disableRuleInConfig", title: configTitle, arguments: [doc.uri, f.ruleId] } }),
      );
    }
    return actions;
  }
}
