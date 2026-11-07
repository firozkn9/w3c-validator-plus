import * as path from "node:path";
import * as vscode from "vscode";
import { addHtmlFixes } from "./codeActions/htmlFixes";
import type { ConfigForUri, ConfigLoader } from "./config/configLoader";
import { readSettings, type Settings } from "./config/settings";
import type { DiagnosticsManager } from "./diagnostics/diagnostics";
import { EngineUnavailableError, isAbortError, type Engine, type Finding, type SourceDocument, type ValidationContext } from "./engines/Engine";
import { isJspDocument, prepareJsp } from "./preprocess/jspDocument";
import { applyRuleConfig } from "./rules/registry";
import { applySuppressions } from "./rules/suppressions";
import { PageStore, PAGE_SCHEME } from "./ui/pageStore";
import { fetchPage, renderedUrlFor } from "./util/fetchPage";
import { isExcluded } from "./util/glob";
import type { Logger } from "./util/logger";
import { utf8ByteLength } from "./util/text";

export type Trigger = "open" | "save" | "type" | "manual" | "workspace";

/** URI schemes validated automatically; others (git, output, diff views…) are ignored. */
const SCHEMES = new Set(["file", "untitled", "vscode-remote", "vscode-vfs"]);

export const RENDERED_PAGE_RULE = "webvalidator/rendered-page";
const RENDERED_ENGINE = "rendered";

/** Language id for a file path, used for files validated from disk. */
export function languageForPath(fsPath: string): string | undefined {
  const ext = path.extname(fsPath).toLowerCase();
  if (ext === ".html" || ext === ".htm" || ext === ".xhtml") return "html";
  if (ext === ".jsp" || ext === ".jspf" || ext === ".tag") return "jsp";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
  return undefined;
}

export interface ValidationTarget {
  uri: vscode.Uri;
  languageId: string;
  text: string;
  version: number;
  /** The open document, when validating editor contents (used to drop stale results). */
  document?: vscode.TextDocument;
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
  pages: PageStore;
  /** Engines that may run on every keystroke (debounced) when `run` is `onType`. */
  runsOnType(engine: Engine, settings: Settings): boolean;
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

/** Decides when to validate, runs engines, cancels stale runs and publishes diagnostics. */
export class ValidationService implements vscode.Disposable {
  private readonly running = new Map<string, AbortController>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Files whose diagnostics came from "Validate Workspace" (kept after their editor closes). */
  private readonly fromDisk = new Set<string>();
  /** JSP uri → virtual document of its rendered page (rendered mode). */
  private readonly renderedPages = new Map<string, vscode.Uri>();
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

  /** Whether this document is one we would validate at all (language + scheme). */
  isRelevant(doc: vscode.TextDocument, settings: Settings = readSettings(doc.uri)): boolean {
    return settings.enable && SCHEMES.has(doc.uri.scheme) && settings.languages.includes(doc.languageId);
  }

  revalidateOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) this.schedule(doc, "open");
  }

  /** Re-validates everything that currently has diagnostics or is open (after config changes). */
  revalidateAll(): void {
    this.revalidateOpenDocuments();
    for (const key of this.fromDisk) {
      const uri = vscode.Uri.parse(key);
      if (!vscode.workspace.textDocuments.some((d) => d.uri.toString() === key)) void this.validateFile(uri, "workspace");
    }
  }

  private schedule(doc: vscode.TextDocument, trigger: Exclude<Trigger, "manual" | "workspace">): void {
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

  validate(doc: vscode.TextDocument, trigger: Trigger): Promise<ValidationOutcome> {
    return this.validateTarget({ uri: doc.uri, languageId: doc.languageId, text: doc.getText(), version: doc.version, document: doc }, trigger);
  }

  /** Validates a file from disk (or its open editor) and keeps the results after it is closed. */
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
    const internal = uri.scheme === PAGE_SCHEME;

    if (!settings.enable) return { ran: [], skipped: "Validation is disabled (webValidator.enable)." };
    if (!internal && !SCHEMES.has(uri.scheme)) return { ran: [], skipped: `Documents with the '${uri.scheme}' scheme are not validated.` };
    if (!internal && !settings.languages.includes(target.languageId)) {
      return { ran: [], skipped: `Language '${target.languageId}' is not in webValidator.languages.` };
    }
    const sizeKb = utf8ByteLength(target.text) / 1024;
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

    // A newer run for the same document supersedes the older one.
    this.running.get(key)?.abort();
    const controller = new AbortController();
    outerSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.running.set(key, controller);
    try {
      const jsp = isJspDocument(target.languageId, key);
      if (jsp && settings.jsp.mode === "rendered" && uri.scheme === "file") {
        if (trigger === "type") return { ran: [] };
        return await this.validateRenderedJsp(target, settings, ctx, controller.signal);
      }
      diagnostics.clearEngine(uri, RENDERED_ENGINE);
      return await this.runEngines(target, ctx, trigger, controller.signal, settings);
    } finally {
      if (this.running.get(key) === controller) this.running.delete(key);
    }
  }

  private async runEngines(
    target: ValidationTarget,
    ctx: ValidationContext,
    trigger: Trigger,
    signal: AbortSignal,
    settings: Settings,
  ): Promise<ValidationOutcome> {
    const { uri, text } = target;
    const key = uri.toString();
    const { logger, diagnostics } = this.opts;
    const engines = this.opts.engines.filter(
      (e) => e.supports(target.languageId) && (trigger !== "type" || this.opts.runsOnType(e, settings)),
    );
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
          // Edits made while validating would shift positions; wait for the next run.
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

  /** Fetches a page and validates it as a read-only virtual HTML document. */
  async validatePage(pageUrl: string, html: string, signal?: AbortSignal): Promise<{ uri: vscode.Uri; outcome: ValidationOutcome }> {
    const uri = PageStore.uriFor(pageUrl);
    this.opts.pages.set(uri, html);
    const outcome = await this.validateTarget({ uri, languageId: "html", text: html, version: Date.now() }, "manual", signal);
    return { uri, outcome };
  }

  /** `webValidator.jsp.mode: "rendered"`: validate the page the running app serves for this JSP. */
  private async validateRenderedJsp(target: ValidationTarget, settings: Settings, ctx: ValidationContext, signal: AbortSignal): Promise<ValidationOutcome> {
    const { uri } = target;
    const { diagnostics } = this.opts;
    for (const e of this.opts.engines) diagnostics.clearEngine(uri, e.id);
    const summary = (message: string, severity: Finding["severity"] = "info") =>
      diagnostics.set(uri, RENDERED_ENGINE, [
        { ruleId: RENDERED_PAGE_RULE, source: "Web Validator", severity, message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
      ]);

    const folder = ctx.workspaceRoot;
    if (!folder) {
      summary("Rendered mode needs the JSP to be inside a workspace folder.");
      return { ran: [] };
    }
    const mapped = renderedUrlFor(uri.fsPath, path.join(folder, settings.jsp.webRoot), settings.jsp.renderedBaseUrl);
    if ("error" in mapped) {
      summary(`Rendered mode: ${mapped.error}`);
      return { ran: [], skipped: mapped.error };
    }
    let page;
    try {
      page = await fetchPage(mapped.url, { signal });
    } catch (err) {
      if (isAbortError(err)) return { ran: [] };
      summary(`Rendered mode: could not load ${mapped.url}: ${(err as Error).message}. Is the application running?`, "warning");
      return { ran: [] };
    }
    if (page.status >= 400) {
      summary(`Rendered mode: ${mapped.url} answered HTTP ${page.status}.`, "warning");
      return { ran: [] };
    }
    const { uri: pageUri, outcome } = await this.validatePage(page.url, page.body, signal);
    this.renderedPages.set(uri.toString(), pageUri);
    const c = outcome.counts ?? { errors: 0, warnings: 0, infos: 0 };
    summary(
      `Rendered page ${page.url}: ${c.errors} error(s), ${c.warnings} warning(s), ${c.infos} info(s). ` +
        'Use the quick fix "Show rendered page" to see them.',
      c.errors ? "warning" : "info",
    );
    return outcome;
  }

  renderedPageFor(jspUri: vscode.Uri): vscode.Uri | undefined {
    return this.renderedPages.get(jspUri.toString());
  }

  private onClose(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.running.get(key)?.abort();
    this.running.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (this.fromDisk.has(key) && doc.uri.scheme === "file") {
      // Keep workspace results: re-check the saved file instead of clearing.
      void this.validateFile(doc.uri, "workspace");
      return;
    }
    if (doc.uri.scheme !== PAGE_SCHEME) this.opts.diagnostics.clear(doc.uri);
  }

  /** Forget results from "Validate Workspace" and clear their diagnostics. */
  clearWorkspaceResults(): void {
    for (const key of this.fromDisk) {
      if (!vscode.workspace.textDocuments.some((d) => d.uri.toString() === key)) this.opts.diagnostics.clear(vscode.Uri.parse(key));
    }
    this.fromDisk.clear();
  }

  dispose(): void {
    for (const c of this.running.values()) c.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
