import * as vscode from "vscode";
import type { Engine, EngineStatus } from "../engines/Engine";
import type { DiagnosticsManager } from "../diagnostics/diagnostics";

/** Shows problem counts for the active file and the state of each engine. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("webValidator.status", vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly engines: readonly Engine[],
    private readonly diagnostics: DiagnosticsManager,
    private readonly isRelevant: (doc: vscode.TextDocument) => boolean,
  ) {
    this.item.name = "Web Validator";
    this.item.command = "webValidator.showOutput";
    this.disposables.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      diagnostics.onDidChange(() => this.update()),
      ...engines.map((e) => e.onStatusChange(() => this.update())),
    );
    this.update();
  }

  update(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !this.isRelevant(doc)) {
      this.item.hide();
      return;
    }
    const statuses = this.engines.filter((e) => e.supports(doc.languageId)).map((e) => [e, e.status] as const);
    const problem = statuses.find(([, s]) => s.state === "unavailable" || s.state === "error");
    const starting = statuses.some(([, s]) => s.state === "starting");
    const { errors, warnings } = this.diagnostics.counts(doc.uri);

    let text = `$(error) ${errors} $(warning) ${warnings}`;
    if (starting) text = `$(sync~spin) ${text}`;
    if (problem) text = `$(alert) ${problem[1].detail ?? problem[0].displayName} · ${text}`;
    this.item.text = text;
    this.item.backgroundColor = problem ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("**Web Standards Validator**\n\n");
    for (const [engine, status] of statuses) {
      tooltip.appendMarkdown(`- ${engine.displayName}: ${describe(status)}\n`);
    }
    tooltip.appendMarkdown("\nClick to show the log.");
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function describe(status: EngineStatus): string {
  const label: Record<EngineStatus["state"], string> = {
    idle: "idle",
    starting: "starting…",
    ready: "ready",
    unavailable: "unavailable",
    error: "error",
  };
  return status.detail ? `${label[status.state]} (${status.detail})` : label[status.state];
}
