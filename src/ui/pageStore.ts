import * as vscode from "vscode";

export const PAGE_SCHEME = "webvalidator-page";

/** Read-only virtual documents holding fetched (rendered) pages. */
export class PageStore implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly pages = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  /** A stable virtual URI for a page URL, e.g. webvalidator-page:/localhost:8080/app/page.jsp.html?url=… */
  static uriFor(pageUrl: string): vscode.Uri {
    const u = new URL(pageUrl);
    const name = `${u.host}${u.pathname}`.replace(/[^\w./-]+/g, "_");
    return vscode.Uri.from({ scheme: PAGE_SCHEME, path: `/${name}${name.endsWith(".html") ? "" : ".html"}`, query: `url=${encodeURIComponent(pageUrl)}` });
  }

  static pageUrlOf(uri: vscode.Uri): string | undefined {
    const m = /(?:^|&)url=([^&]+)/.exec(uri.query);
    return m?.[1] ? decodeURIComponent(m[1]) : undefined;
  }

  set(uri: vscode.Uri, text: string): void {
    this.pages.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  has(uri: vscode.Uri): boolean {
    return this.pages.has(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.pages.get(uri.toString()) ?? "<!-- This page is no longer available. Validate it again. -->";
  }

  dispose(): void {
    this.changed.dispose();
  }
}
