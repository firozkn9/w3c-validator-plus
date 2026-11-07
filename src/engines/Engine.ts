/**
 * Engine-neutral model shared by every validation engine and rule.
 *
 * Nothing in this file depends on the `vscode` module so that engines,
 * preprocessors and rules can be unit-tested with plain Node.
 */
import { EMPTY_CONFIG, type ResolvedConfig } from "../config/webValidatorConfig";
import { DEFAULT_JSP_OPTIONS, type JspOptions } from "../preprocess/jspDocument";

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
  /** A safe automatic fix (offered as the preferred quick fix). */
  fix?: Fix;
  /** Alternative fixes the user may choose from (e.g. ESLint suggestions). */
  suggestions?: Fix[];
  docsUrl?: string;
}

/** Per-run settings shared by all engines. */
export interface ValidationContext {
  config: ResolvedConfig;
  jsp: JspOptions;
  ecmaVersion: "latest" | number;
  /** Workspace trust: custom rule code only runs when true. */
  trusted: boolean;
  /** Folder whose package.json lists rule packs. */
  workspaceRoot?: string;
  /** Language for fixes such as adding lang="…" (default "en"). */
  locale?: string;
}

export function defaultContext(): ValidationContext {
  return { config: EMPTY_CONFIG, jsp: DEFAULT_JSP_OPTIONS, ecmaVersion: "latest", trusted: false };
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
  validate(doc: SourceDocument, signal: AbortSignal, ctx?: ValidationContext): Promise<Finding[]>;
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
