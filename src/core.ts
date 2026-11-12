// Types and small helpers shared by the engines and rules. Nothing here may
// import `vscode`, so the engines can be unit-tested with plain Node.
import type { ResolvedConfig } from "./config";
import type { JspOptions } from "./jsp";

export type Severity = "error" | "warning" | "info";

// Zero-based line and UTF-16 column, like VS Code.
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

export interface Finding {
  ruleId: string; // e.g. vnu:img-missing-alt
  source: string; // shown in the Problems panel
  severity: Severity;
  message: string;
  range: Range;
  fix?: Fix; // offered as the preferred quick fix
  suggestions?: Fix[];
  docsUrl?: string;
}

export interface ValidationContext {
  config: ResolvedConfig;
  jsp: JspOptions;
  ecmaVersion: "latest" | number;
  trusted: boolean; // custom rule code only runs in trusted workspaces
  workspaceRoot?: string; // where package.json lists rule packs
  locale?: string; // for fixes like lang="…"
}

export interface SourceDocument {
  uri: string;
  languageId: string;
  text: string;
  version: number;
}

export interface EngineStatus {
  state: "idle" | "starting" | "ready" | "unavailable" | "error";
  detail?: string;
}

export interface Engine {
  readonly id: string;
  readonly displayName: string;
  readonly status: EngineStatus;
  supports(languageId: string): boolean;
  // Problems in the document are findings, not exceptions. Rejects with an
  // AbortError when `signal` fires.
  validate(doc: SourceDocument, signal: AbortSignal, ctx?: ValidationContext): Promise<Finding[]>;
  onStatusChange(listener: (status: EngineStatus) => void): { dispose(): void };
  dispose(): void | Promise<void>;
}

export const RULE_ERROR_RULE = "webvalidator/rule-error";

export class EngineUnavailableError extends Error {
  override name = "EngineUnavailableError";
}

export function abortError(): Error {
  const err = new Error("Validation was cancelled");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "CanceledError");
}

export type TraceLevel = "off" | "info" | "verbose";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  verbose(message: string): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {}, verbose() {} };

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

// Same shape as vscode.EventEmitter, without depending on vscode.
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {}
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        this.queue = this.queue.filter((g) => g !== grant);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Offset <-> position conversion for one text.
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }

  positionAt(offset: number): Position {
    const o = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: o - this.starts[lo]! };
  }

  offsetAt(p: Position): number {
    const start = this.starts[Math.max(0, Math.min(p.line, this.starts.length - 1))] ?? 0;
    return Math.min(start + Math.max(0, p.character), this.text.length);
  }

  range(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }
}
