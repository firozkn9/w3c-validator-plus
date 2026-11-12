import * as path from "node:path";
import * as vscode from "vscode";
import { createCustomRule, disableRuleInConfig, openConfig, validateRunningPage, validateWorkspace, type CreateRuleArgs } from "./commands";
import { describeError, type Engine, type EngineStatus, type Logger, type TraceLevel } from "./core";
import { DiagnosticsManager, WebValidatorCodeActions } from "./diagnostics";
import { EslintEngine } from "./eslint";
import { locateJava, MIN_JAVA_MAJOR, nodeJavaHost } from "./java";
import { RuleStore } from "./ruleLoader";
import { RulesEngine } from "./rules";
import { ConfigLoader, readSettings, redhatJavaHomes, SECTION, type Settings } from "./settings";
import { PAGE_SCHEME, PageStore, ValidationService } from "./validationService";
import { VnuEngine, type VnuEngineOptions } from "./vnu";

let vnuEngine: VnuEngine | undefined;

// Returned from activate() for the integration tests.
export interface WebValidatorApi {
  service: ValidationService;
  diagnostics: DiagnosticsManager;
}

function vnuOptions(context: vscode.ExtensionContext, s: Settings): VnuEngineOptions {
  return { mode: s.vnuMode, serverUrl: s.vnuServerUrl, jarPath: path.join(context.extensionPath, "dist", "vnu.jar"), timeoutMs: s.vnuTimeoutMs };
}

export function activate(context: vscode.ExtensionContext): WebValidatorApi {
  const settings = readSettings();
  const logger = new OutputLogger(settings.trace);
  logger.info(`Web Standards Validator ${context.extension.packageJSON.version} activated`);

  const vnu = new VnuEngine(vnuOptions(context, settings), {
    logger,
    findJava: () =>
      locateJava(nodeJavaHost, {
        settingJavaHome: readSettings().javaHome,
        redhatJavaExtensionPath: vscode.extensions.getExtension("redhat.java")?.extensionPath,
        redhatJavaHomes: redhatJavaHomes(),
      }),
  });
  vnuEngine = vnu;
  const eslint = new EslintEngine({ logger });
  const store = new RuleStore();
  const rules = new RulesEngine({
    logger,
    eslint,
    store,
    onLoadErrors: (errors) => {
      void vscode.window.showWarningMessage(`Web Validator: ${errors.length} custom rule problem(s): ${errors[0]}`, "Show Output").then((c) => {
        if (c) logger.show();
      });
    },
  });
  const engines: Engine[] = [vnu, eslint, rules];

  const diagnostics = new DiagnosticsManager();
  const configLoader = new ConfigLoader(logger);
  const pages = new PageStore();
  const service = new ValidationService({
    engines,
    diagnostics,
    logger,
    configLoader,
    pages,
    runsOnType: (engine, s) => engine.id !== "vnu" || s.vnuValidateOnType,
    onEngineUnavailable: (engine) => {
      if (engine.id === "vnu" && engine.status.detail?.startsWith("Java")) void showJavaMissing(() => logger.show());
    },
  });
  const statusBar = new StatusBar(engines, diagnostics, (doc) => service.isRelevant(doc) || doc.uri.scheme === PAGE_SCHEME);

  const reloadRules = () => {
    store.invalidate();
    rules.resetErrors();
  };

  // Custom rule code changed: reload it (debounced).
  let reloadTimer: NodeJS.Timeout | undefined;
  const onRuleFileChange = (changed: vscode.Uri) => {
    const p = changed.fsPath;
    const relevant =
      path.basename(p) === "package.json" ||
      /[\\/]node_modules[\\/](@[^\\/]+[\\/])?webvalidator-rules-/.test(p) ||
      store.directories().some((d) => !path.relative(d, p).startsWith(".."));
    if (!relevant) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      logger.info("Custom rule files changed; reloading rules");
      reloadRules();
      service.revalidateAll();
    }, 300);
  };
  const ruleWatcher = vscode.workspace.createFileSystemWatcher("**/*.{js,cjs,mjs,json}");

  const selector: vscode.DocumentSelector = [{ language: "html" }, { language: "jsp" }, { language: "javascript" }, { scheme: PAGE_SCHEME }];
  const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(`webValidator.${id}`, fn);

  context.subscriptions.push(
    logger,
    diagnostics,
    configLoader,
    pages,
    service,
    statusBar,
    { dispose: () => void vnu.dispose() },
    eslint,
    rules,
    ruleWatcher,
    ruleWatcher.onDidChange(onRuleFileChange),
    ruleWatcher.onDidCreate(onRuleFileChange),
    ruleWatcher.onDidDelete(onRuleFileChange),
    vscode.workspace.registerTextDocumentContentProvider(PAGE_SCHEME, pages),
    vscode.languages.registerCodeActionsProvider(selector, new WebValidatorCodeActions(diagnostics), WebValidatorCodeActions.metadata),

    command("validateFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Web Validator: open an HTML, JSP or JavaScript file to validate it.");
        return;
      }
      const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Validating…" }, () =>
        service.validate(editor.document, "manual"),
      );
      if (outcome.skipped) void vscode.window.showInformationMessage(`Web Validator: ${outcome.skipped}`);
      return outcome;
    }),
    command("validateWorkspace", () => validateWorkspace(service, configLoader, logger)),
    command("clearProblems", () => service.clearWorkspaceResults()),
    command("validateRunningPage", (url?: string, options?: { open?: boolean }) => validateRunningPage(service, url, options)),
    command("showRenderedPage", async (jspUri?: vscode.Uri) => {
      const uri = jspUri ?? vscode.window.activeTextEditor?.document.uri;
      const page = uri && service.renderedPageFor(uri);
      if (!page) {
        void vscode.window.showInformationMessage('Web Validator: no rendered page yet. Set webValidator.jsp.mode to "rendered" and save the JSP.');
        return;
      }
      await vscode.window.showTextDocument(page, { preview: true });
    }),
    command("createCustomRule", (args?: CreateRuleArgs) => createCustomRule(configLoader, args)),
    command("disableRuleInConfig", async (uri: vscode.Uri | undefined, ruleId: string) => {
      const file = await disableRuleInConfig(configLoader, uri, ruleId);
      if (file) logger.info(`Disabled ${ruleId} in ${file.fsPath}`);
      return file;
    }),
    command("openConfig", () => openConfig(configLoader)),
    command("restartEngines", async () => {
      javaNoticeShown = false;
      await vnu.restart();
      reloadRules();
      configLoader.invalidate();
      logger.info("Engines restarted");
      service.revalidateAll();
    }),
    command("showOutput", () => logger.show()),

    configLoader.onDidChange(() => service.revalidateAll()),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION) && !e.affectsConfiguration("java")) return;
      const s = readSettings();
      logger.level = s.trace;
      if (e.affectsConfiguration(`${SECTION}.java.home`) || e.affectsConfiguration("java")) {
        javaNoticeShown = false;
        await vnu.restart();
      }
      await vnu.updateOptions(vnuOptions(context, s));
      if (e.affectsConfiguration(`${SECTION}.rulesDirectories`)) store.invalidate();
      if (!s.enable) diagnostics.clearAll();
      configLoader.invalidate(); // settings are part of the merged config, so this revalidates
    }),

    // Workspace values for java.home, serverUrl and rule code count only once trusted.
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await vnu.updateOptions(vnuOptions(context, readSettings()));
      await vnu.restart();
      reloadRules();
      configLoader.invalidate();
    }),
  );

  service.start();
  return { service, diagnostics };
}

export async function deactivate(): Promise<void> {
  // don't leave the JVM running after the extension host goes away
  await vnuEngine?.dispose();
  vnuEngine = undefined;
}

class OutputLogger implements Logger, vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Web Validator");

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

  // always written, whatever the trace level
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

const STATE_LABEL: Record<EngineStatus["state"], string> = {
  idle: "idle",
  starting: "starting…",
  ready: "ready",
  unavailable: "unavailable",
  error: "error",
};

// Problem counts for the active file, and a warning when an engine is down.
class StatusBar implements vscode.Disposable {
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
    const engines = this.engines.filter((e) => e.supports(doc.languageId));
    const broken = engines.find((e) => e.status.state === "unavailable" || e.status.state === "error");
    const { errors, warnings } = this.diagnostics.counts(doc.uri);

    let text = `$(error) ${errors} $(warning) ${warnings}`;
    if (engines.some((e) => e.status.state === "starting")) text = `$(sync~spin) ${text}`;
    if (broken) text = `$(alert) ${broken.status.detail ?? broken.displayName} · ${text}`;
    this.item.text = text;
    this.item.backgroundColor = broken ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("**Web Standards Validator**\n\n");
    for (const { displayName, status } of engines) {
      const label = STATE_LABEL[status.state];
      tooltip.appendMarkdown(`- ${displayName}: ${status.detail ? `${label} (${status.detail})` : label}\n`);
    }
    tooltip.appendMarkdown("\nClick to show the log.");
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

let javaNoticeShown = false; // once per session, until the Java settings change

async function showJavaMissing(showOutput: () => void): Promise<void> {
  if (javaNoticeShown) return;
  javaNoticeShown = true;
  const install = "Install Java";
  const setPath = "Set Java Path";
  const log = "Show Log";
  const choice = await vscode.window.showWarningMessage(
    `Web Validator: HTML and CSS checks need Java ${MIN_JAVA_MAJOR} or newer to run the bundled Nu Html Checker, ` +
      "and none was found in webValidator.java.home, JAVA_HOME, PATH or the Red Hat Java extension. " +
      "Other checks keep working.",
    install,
    setPath,
    log,
  );
  if (choice === install) await vscode.env.openExternal(vscode.Uri.parse("https://adoptium.net/temurin/releases/"));
  else if (choice === setPath) await vscode.commands.executeCommand("workbench.action.openSettings", "webValidator.java.home");
  else if (choice === log) showOutput();
}
