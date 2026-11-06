import * as vscode from "vscode";
import { describeError, type Logger, type TraceLevel } from "../util/logger";

/** Logger backed by the "Web Validator" output channel. */
export class OutputLogger implements Logger, vscode.Disposable {
  readonly channel = vscode.window.createOutputChannel("Web Validator");

  constructor(public level: TraceLevel) {}

  private write(tag: string, message: string): void {
    const time = new Date().toISOString().slice(11, 23);
    this.channel.appendLine(`[${time}] ${tag} ${message}`);
  }

  info(message: string): void {
    if (this.level !== "off") this.write("INFO ", message);
  }

  warn(message: string): void {
    if (this.level !== "off") this.write("WARN ", message);
  }

  /** Errors are always logged, regardless of the trace level. */
  error(message: string, err?: unknown): void {
    this.write("ERROR", err === undefined ? message : `${message}\n${describeError(err)}`);
  }

  verbose(message: string): void {
    if (this.level === "verbose") this.write("TRACE", message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
