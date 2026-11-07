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

/** Identity of a diagnostic that survives VS Code copying it (code actions get copies). */
export function diagnosticKey(d: vscode.Diagnostic): string {
  const code = typeof d.code === "object" ? String(d.code.value) : String(d.code ?? "");
  const r = d.range;
  return `${code}|${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}|${d.message}`;
}

/** One DiagnosticCollection per engine so engines can update independently. */
export class DiagnosticsManager implements vscode.Disposable {
  private readonly collections = new Map<string, vscode.DiagnosticCollection>();
  /** uri → engine → diagnostic key → finding */
  private readonly findings = new Map<string, Map<string, Map<string, Finding>>>();
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

  /** The finding behind a diagnostic (also for copies VS Code passes to code actions). */
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

  /** URIs that currently have diagnostics from this extension. */
  uris(): vscode.Uri[] {
    return [...this.findings.keys()].map((u) => vscode.Uri.parse(u));
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
