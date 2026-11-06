import * as vscode from "vscode";
import type { Finding, Range, Severity } from "../engines/Engine";

export function toVsRange(r: Range): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function toVsSeverity(s: Severity): vscode.DiagnosticSeverity {
  switch (s) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

export function toDiagnostic(f: Finding): vscode.Diagnostic {
  const d = new vscode.Diagnostic(toVsRange(f.range), f.message, toVsSeverity(f.severity));
  d.source = f.source;
  d.code = f.docsUrl ? { value: f.ruleId, target: vscode.Uri.parse(f.docsUrl) } : f.ruleId;
  return d;
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
}

/** One DiagnosticCollection per engine so engines can update independently. */
export class DiagnosticsManager implements vscode.Disposable {
  private readonly collections = new Map<string, vscode.DiagnosticCollection>();
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
    this.collection(engineId).set(uri, findings.map(toDiagnostic));
    this.changed.fire(uri);
  }

  clearEngine(uri: vscode.Uri, engineId: string): void {
    this.collections.get(engineId)?.delete(uri);
    this.changed.fire(uri);
  }

  clear(uri: vscode.Uri): void {
    for (const c of this.collections.values()) c.delete(uri);
    this.changed.fire(uri);
  }

  clearAll(): void {
    for (const c of this.collections.values()) c.clear();
  }

  get(uri: vscode.Uri): vscode.Diagnostic[] {
    return [...this.collections.values()].flatMap((c) => [...(c.get(uri) ?? [])]);
  }

  counts(uri: vscode.Uri): DiagnosticCounts {
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
