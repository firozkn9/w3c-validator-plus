import * as vscode from "vscode";
import { readSettings, type Settings } from "./config/settings";
import type { DiagnosticsManager } from "./diagnostics/diagnostics";
import { EngineUnavailableError, isAbortError, type Engine, type SourceDocument } from "./engines/Engine";
import type { Logger } from "./util/logger";
import { utf8ByteLength } from "./util/text";

export type Trigger = "open" | "save" | "type" | "manual";

/** URI schemes we validate; others (git, output, diff views…) are ignored. */
const SCHEMES = new Set(["file", "untitled", "vscode-remote", "vscode-vfs"]);

export interface ValidationServiceOptions {
  engines: readonly Engine[];
  diagnostics: DiagnosticsManager;
  logger: Logger;
  /** Engines that may run on every keystroke (debounced) when `run` is `onType`. */
  runsOnType(engine: Engine, settings: Settings): boolean;
  onEngineUnavailable(engine: Engine, err: EngineUnavailableError): void;
}

export interface ValidationOutcome {
  ran: string[];
  skipped?: string;
}

/** Decides when to validate, runs engines, cancels stale runs and publishes diagnostics. */
export class ValidationService implements vscode.Disposable {
  private readonly running = new Map<string, AbortController>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly opts: ValidationServiceOptions) {}

  start(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, "open")),
      vscode.workspace.onDidSaveTextDocument((d) => this.schedule(d, "save")),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.schedule(e.document, "type");
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d)),
    );
    this.revalidateOpenDocuments();
  }

  /** Whether this document is one we would validate at all (language + scheme). */
  isRelevant(doc: vscode.TextDocument, settings: Settings = readSettings(doc.uri)): boolean {
    return settings.enable && SCHEMES.has(doc.uri.scheme) && settings.languages.includes(doc.languageId);
  }

  revalidateOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) this.schedule(doc, "open");
  }

  private schedule(doc: vscode.TextDocument, trigger: Exclude<Trigger, "manual">): void {
    const settings = readSettings(doc.uri);
    if (!this.isRelevant(doc, settings) || settings.run === "manual") return;
    if (trigger === "type") {
      if (settings.run !== "onType") return;
      const key = doc.uri.toString();
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          void this.validate(doc, "type");
        }, settings.onTypeDelayMs),
      );
      return;
    }
    void this.validate(doc, trigger);
  }

  async validate(doc: vscode.TextDocument, trigger: Trigger): Promise<ValidationOutcome> {
    const settings = readSettings(doc.uri);
    const key = doc.uri.toString();
    const { logger, diagnostics } = this.opts;

    if (!settings.enable) return { ran: [], skipped: "Validation is disabled (webValidator.enable)." };
    if (!SCHEMES.has(doc.uri.scheme)) return { ran: [], skipped: `Documents with the '${doc.uri.scheme}' scheme are not validated.` };
    if (!settings.languages.includes(doc.languageId)) {
      return { ran: [], skipped: `Language '${doc.languageId}' is not in webValidator.languages.` };
    }

    const text = doc.getText();
    const sizeKb = utf8ByteLength(text) / 1024;
    if (sizeKb > settings.maxFileSizeKb) {
      diagnostics.clear(doc.uri);
      const reason = `File is ${Math.round(sizeKb)} KB, above webValidator.maxFileSizeKb (${settings.maxFileSizeKb} KB).`;
      logger.info(`Skipping ${key}: ${reason}`);
      return { ran: [], skipped: reason };
    }

    const engines = this.opts.engines.filter(
      (e) => e.supports(doc.languageId) && (trigger !== "type" || this.opts.runsOnType(e, settings)),
    );
    if (engines.length === 0) return { ran: [], skipped: `No engine handles '${doc.languageId}' yet.` };

    // A newer run for the same document supersedes the older one.
    this.running.get(key)?.abort();
    const controller = new AbortController();
    this.running.set(key, controller);

    const snapshot: SourceDocument = { uri: key, languageId: doc.languageId, text, version: doc.version };
    logger.verbose(`Validating ${key} (v${doc.version}, ${trigger}) with ${engines.map((e) => e.id).join(", ")}`);

    await Promise.all(
      engines.map(async (engine) => {
        const started = Date.now();
        try {
          const findings = await engine.validate(snapshot, controller.signal);
          if (controller.signal.aborted || doc.isClosed) return;
          // Edits made while validating would shift positions; wait for the next run.
          if (doc.version !== snapshot.version && trigger !== "manual") return;
          diagnostics.set(doc.uri, engine.id, findings);
          logger.verbose(`${engine.id}: ${findings.length} finding(s) for ${key} in ${Date.now() - started} ms`);
        } catch (err) {
          if (isAbortError(err)) return;
          diagnostics.clearEngine(doc.uri, engine.id);
          if (err instanceof EngineUnavailableError) {
            logger.warn(`${engine.displayName} unavailable: ${err.message}`);
            this.opts.onEngineUnavailable(engine, err);
          } else {
            logger.error(`${engine.displayName} failed on ${key}`, err);
          }
        }
      }),
    );

    if (this.running.get(key) === controller) this.running.delete(key);
    return { ran: engines.map((e) => e.id) };
  }

  private forget(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.running.get(key)?.abort();
    this.running.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.opts.diagnostics.clear(doc.uri);
  }

  dispose(): void {
    for (const c of this.running.values()) c.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
