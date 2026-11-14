// Decides when to validate, runs the engines, drops results that went stale
// while running, and publishes diagnostics.
import * as path from "node:path";
import * as vscode from "vscode";
import { applyRuleConfig, isExcluded } from "./config";
import { EngineUnavailableError, isAbortError, type Engine, type Finding, type Logger, type SourceDocument, type ValidationContext } from "./core";
import type { DiagnosticsManager } from "./diagnostics";
import { isJspDocument, prepareJsp } from "./jsp";
import { readSettings, type ConfigForUri, type ConfigLoader, type Settings } from "./settings";
import { applySuppressions } from "./suppressions";
import { addHtmlFixes } from "./vnuMessages";

export type Trigger = "open" | "save" | "type" | "manual" | "workspace";

// Other schemes (git, output, diff views, ...) are never validated automatically.
const SCHEMES = new Set(["file", "untitled", "vscode-remote", "vscode-vfs"]);

// For files read from disk, which have no language id yet.
export function languageForPath(fsPath: string): string | undefined {
  const ext = path.extname(fsPath).toLowerCase();
  if (ext === ".html" || ext === ".htm" || ext === ".xhtml") return "html";
  if (ext === ".jsp" || ext === ".jspf" || ext === ".tag") return "jsp";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
  return undefined;
}

// The id webValidator.languages uses: VS Code opens JSP files as "html", but they count as "jsp".
function settingsLanguage(languageId: string, uri: string): string {
  return languageId !== "javascript" && isJspDocument(languageId, uri) ? "jsp" : languageId;
}

export interface ValidationTarget {
  uri: vscode.Uri;
  languageId: string;
  text: string;
  version: number;
  document?: vscode.TextDocument; // set for editor contents, to detect edits made meanwhile
}

export interface ValidationOutcome {
  ran: string[];
  skipped?: string;
  counts?: { errors: number; warnings: number; infos: number };
}

export interface ValidationServiceOptions {
  engines: readonly Engine[];
  diagnostics: DiagnosticsManager;
  logger: Logger;
  configLoader: ConfigLoader;
  onEngineUnavailable(engine: Engine, err: EngineUnavailableError): void;
}

function countFindings(findings: readonly Finding[]) {
  const c = { errors: 0, warnings: 0, infos: 0 };
  for (const f of findings) {
    if (f.severity === "error") c.errors++;
    else if (f.severity === "warning") c.warnings++;
    else c.infos++;
  }
  return c;
}

const isOpen = (key: string) => vscode.workspace.textDocuments.some((d) => d.uri.toString() === key);

export class ValidationService implements vscode.Disposable {
  private readonly running = new Map<string, AbortController>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly fromDisk = new Set<string>(); // from Validate Workspace; kept after the editor closes
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly opts: ValidationServiceOptions) {}

  start(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, "open")),
      vscode.workspace.onDidSaveTextDocument((d) => this.schedule(d, "save")),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.schedule(e.document, "type");
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.onClose(d)),
    );
    this.revalidateOpenDocuments();
  }

  isRelevant(doc: vscode.TextDocument, settings: Settings = readSettings(doc.uri)): boolean {
    return settings.enable && SCHEMES.has(doc.uri.scheme) && settings.languages.includes(settingsLanguage(doc.languageId, doc.uri.toString()));
  }

  revalidateOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) this.schedule(doc, "open");
  }

  // Everything that is open or has workspace results (after a config change).
  revalidateAll(): void {
    this.revalidateOpenDocuments();
    for (const key of this.fromDisk) {
      if (!isOpen(key)) void this.validateFile(vscode.Uri.parse(key), "workspace");
    }
  }

  private schedule(doc: vscode.TextDocument, trigger: "open" | "save" | "type"): void {
    const settings = readSettings(doc.uri);
    if (!this.isRelevant(doc, settings) || settings.run === "manual") return;
    if (trigger !== "type") {
      void this.validate(doc, trigger);
      return;
    }
    if (settings.run !== "onType") return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.validate(doc, "type");
    }, settings.onTypeDelayMs);
    this.timers.set(key, timer);
  }

  validate(doc: vscode.TextDocument, trigger: Trigger): Promise<ValidationOutcome> {
    return this.validateTarget({ uri: doc.uri, languageId: doc.languageId, text: doc.getText(), version: doc.version, document: doc }, trigger);
  }

  // Uses the open editor when there is one. Results stay after the file is closed.
  async validateFile(uri: vscode.Uri, trigger: Trigger, signal?: AbortSignal): Promise<ValidationOutcome> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return this.validate(open, trigger);
    const languageId = languageForPath(uri.fsPath);
    if (!languageId) return { ran: [], skipped: "Unsupported file type" };
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    this.fromDisk.add(uri.toString());
    return this.validateTarget({ uri, languageId, text, version: 0 }, trigger, signal);
  }

  async contextFor(uri: vscode.Uri, settings: Settings = readSettings(uri)): Promise<{ ctx: ValidationContext; info: ConfigForUri }> {
    const info = await this.opts.configLoader.forUri(uri);
    const { config } = info;
    const ctx: ValidationContext = {
      config,
      jsp: {
        documentStructure: config.documentStructure ?? settings.jsp.documentStructure,
        customTagPrefixes: [...new Set([...settings.jsp.customTagPrefixes, ...config.customTagPrefixes])],
      },
      ecmaVersion: settings.ecmaVersion,
      trusted: vscode.workspace.isTrusted,
      locale: vscode.env.language,
      ...(info.folder?.uri.scheme === "file" ? { workspaceRoot: info.folder.uri.fsPath } : {}),
    };
    return { ctx, info };
  }

  async validateTarget(target: ValidationTarget, trigger: Trigger, outerSignal?: AbortSignal): Promise<ValidationOutcome> {
    const { uri } = target;
    const settings = readSettings(uri);
    const key = uri.toString();
    const { logger, diagnostics } = this.opts;

    if (!settings.enable) return { ran: [], skipped: "Validation is disabled (webValidator.enable)." };
    if (!SCHEMES.has(uri.scheme)) return { ran: [], skipped: `Documents with the '${uri.scheme}' scheme are not validated.` };
    const language = settingsLanguage(target.languageId, key);
    if (!settings.languages.includes(language)) return { ran: [], skipped: `Language '${language}' is not in webValidator.languages.` };
    const sizeKb = Buffer.byteLength(target.text, "utf8") / 1024;
    if (sizeKb > settings.maxFileSizeKb) {
      diagnostics.clear(uri);
      const reason = `File is ${Math.round(sizeKb)} KB, above webValidator.maxFileSizeKb (${settings.maxFileSizeKb} KB).`;
      logger.info(`Skipping ${key}: ${reason}`);
      return { ran: [], skipped: reason };
    }

    const { ctx } = await this.contextFor(uri, settings);
    if (uri.scheme === "file" && isExcluded(uri.fsPath, ctx.config.exclude)) {
      diagnostics.clear(uri);
      return { ran: [], skipped: "This file matches an `exclude` pattern in the configuration." };
    }

    // A newer run for the same document replaces the older one.
    this.running.get(key)?.abort();
    const controller = new AbortController();
    outerSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.running.set(key, controller);
    try {
      return await this.runEngines(target, ctx, trigger, controller.signal);
    } finally {
      if (this.running.get(key) === controller) this.running.delete(key);
    }
  }

  private async runEngines(target: ValidationTarget, ctx: ValidationContext, trigger: Trigger, signal: AbortSignal): Promise<ValidationOutcome> {
    const { uri, text } = target;
    const key = uri.toString();
    const { logger, diagnostics } = this.opts;
    // The Nu Html Checker is too slow to run on every keystroke; it waits for a save.
    const engines = this.opts.engines.filter((e) => e.supports(target.languageId) && (trigger !== "type" || e.id !== "vnu"));
    if (engines.length === 0) return { ran: [], skipped: `No engine handles '${target.languageId}'.` };

    const snapshot: SourceDocument = { uri: key, languageId: target.languageId, text, version: target.version };
    const jsp = isJspDocument(target.languageId, key);
    logger.verbose(`Validating ${key} (v${target.version}, ${trigger}) with ${engines.map((e) => e.id).join(", ")}`);
    const all: Finding[] = [];

    await Promise.all(
      engines.map(async (engine) => {
        const started = Date.now();
        try {
          let findings = await engine.validate(snapshot, signal, ctx);
          if (signal.aborted || target.document?.isClosed) return;
          // Edits made meanwhile would shift the positions; the next run will catch up.
          if (target.document && target.document.version !== target.version && trigger !== "manual") return;
          if (engine.id === "vnu") {
            const fragment = jsp && prepareJsp(text, ctx.jsp).fragment;
            findings = addHtmlFixes(findings, text, { locale: ctx.locale ?? "en", fragment });
          }
          findings = applySuppressions(applyRuleConfig(findings, ctx.config), text);
          diagnostics.set(uri, engine.id, findings);
          all.push(...findings);
          logger.verbose(`${engine.id}: ${findings.length} finding(s) for ${key} in ${Date.now() - started} ms`);
        } catch (err) {
          if (isAbortError(err)) return;
          diagnostics.clearEngine(uri, engine.id);
          if (err instanceof EngineUnavailableError) {
            logger.warn(`${engine.displayName} unavailable: ${err.message}`);
            this.opts.onEngineUnavailable(engine, err);
          } else {
            logger.error(`${engine.displayName} failed on ${key}`, err);
          }
        }
      }),
    );
    return { ran: engines.map((e) => e.id), counts: countFindings(all) };
  }

  private onClose(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.running.get(key)?.abort();
    this.running.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (this.fromDisk.has(key) && doc.uri.scheme === "file") {
      // keep workspace results: check the saved file instead of clearing
      void this.validateFile(doc.uri, "workspace");
      return;
    }
    this.opts.diagnostics.clear(doc.uri);
  }

  clearWorkspaceResults(): void {
    for (const key of this.fromDisk) {
      if (!isOpen(key)) this.opts.diagnostics.clear(vscode.Uri.parse(key));
    }
    this.fromDisk.clear();
  }

  dispose(): void {
    for (const c of this.running.values()) c.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

