/**
 * Engine-neutral model shared by every validation engine and rule.
 *
 * Nothing in this file depends on the `vscode` module so that engines,
 * preprocessors and rules can be unit-tested with plain Node.
 */

export type Severity = "error" | "warning" | "info";

/** Zero-based line and UTF-16 code-unit column, same convention as VS Code. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface Fix {
  title: string;
  edits: TextEdit[];
}

/** The common result type produced by all engines and rules. */
export interface Finding {
  /** Stable identifier, e.g. `vnu:img-missing-alt` or `custom/no-inline-styles`. */
  ruleId: string;
  /** Human-readable origin shown in the Problems panel, e.g. `Nu Html Checker`. */
  source: string;
  severity: Severity;
  message: string;
  range: Range;
  fix?: Fix;
  docsUrl?: string;
}

/** A snapshot of a document handed to an engine. */
export interface SourceDocument {
  /** String form of the document URI. */
  uri: string;
  /** VS Code language id, e.g. `html`, `jsp`. */
  languageId: string;
  text: string;
  version: number;
}

export type EngineState = "idle" | "starting" | "ready" | "unavailable" | "error";

export interface EngineStatus {
  state: EngineState;
  /** Short human-readable explanation, e.g. "Java 17+ not found". */
  detail?: string;
}

export interface Engine {
  /** Short id used for diagnostic collections and logs, e.g. `vnu`. */
  readonly id: string;
  readonly displayName: string;
  readonly status: EngineStatus;
  supports(languageId: string): boolean;
  /**
   * Validate a document. Implementations must reject with an `AbortError`
   * (or resolve early) when `signal` is aborted and must never throw for
   * ordinary validation problems — those are findings.
   */
  validate(doc: SourceDocument, signal: AbortSignal): Promise<Finding[]>;
  onStatusChange(listener: (status: EngineStatus) => void): { dispose(): void };
  dispose(): void | Promise<void>;
}

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "CanceledError");
}

export function abortError(): Error {
  const err = new Error("Validation was cancelled");
  err.name = "AbortError";
  return err;
}
