import * as path from "node:path";
import * as vscode from "vscode";
import { WebValidatorCodeActions } from "./codeActions/codeActionProvider";
import { ConfigLoader } from "./config/configLoader";
import { readSettings, redhatJavaHomes, SECTION, type Settings } from "./config/settings";
import { DiagnosticsManager } from "./diagnostics/diagnostics";
import type { Engine } from "./engines/Engine";
import { EslintEngine } from "./engines/eslintEngine";
import { RulesEngine } from "./engines/rulesEngine";
import { VnuEngine, type VnuEngineOptions } from "./engines/vnuEngine";
import { locateJava, nodeJavaHost } from "./java/javaLocator";
import { RuleStore } from "./rules/ruleLoader";
import { createCustomRule, disableRuleInConfig, openConfig, validateRunningPage, validateWorkspace, type CreateRuleArgs } from "./ui/commands";
import { resetJavaMissingNotice, showJavaMissing } from "./ui/javaGuidance";
import { OutputLogger } from "./ui/outputLogger";
import { PageStore, PAGE_SCHEME } from "./ui/pageStore";
import { StatusBar } from "./ui/statusBar";
import { ValidationService } from "./validationService";

let vnuEngine: VnuEngine | undefined;

function vnuOptions(context: vscode.ExtensionContext, s: Settings): VnuEngineOptions {
  return {
    mode: s.vnuMode,
    serverUrl: s.vnuServerUrl,
    jarPath: path.join(context.extensionPath, "dist", "vnu.jar"),
    timeoutMs: s.vnuTimeoutMs,
  };
}

/** Exposed for integration tests. */
export interface WebValidatorApi {
  service: ValidationService;
  diagnostics: DiagnosticsManager;
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

  // Reload custom rule code when it changes (debounced).
  let reloadTimer: NodeJS.Timeout | undefined;
  const reloadRules = (changed: vscode.Uri) => {
    const p = changed.fsPath;
    const relevant =
      path.basename(p) === "package.json" ||
      /[\\/]node_modules[\\/](@[^\\/]+[\\/])?webvalidator-rules-/.test(p) ||
      store.directories().some((d) => !path.relative(d, p).startsWith(".."));
    if (!relevant) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      logger.info("Custom rule files changed; reloading rules");
      store.invalidate();
      rules.resetErrors();
      service.revalidateAll();
    }, 300);
  };
  const ruleWatcher = vscode.workspace.createFileSystemWatcher("**/*.{js,cjs,mjs,json}");

  const selector: vscode.DocumentSelector = [
    { language: "html" },
    { language: "jsp" },
    { language: "javascript" },
    { scheme: PAGE_SCHEME },
  ];

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
    ruleWatcher.onDidChange(reloadRules),
    ruleWatcher.onDidCreate(reloadRules),
    ruleWatcher.onDidDelete(reloadRules),
    vscode.workspace.registerTextDocumentContentProvider(PAGE_SCHEME, pages),
    vscode.languages.registerCodeActionsProvider(selector, new WebValidatorCodeActions(diagnostics), WebValidatorCodeActions.metadata),

    vscode.commands.registerCommand("webValidator.validateFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Web Validator: open an HTML, JSP or JavaScript file to validate it.");
        return;
      }
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Validating…" },
        () => service.validate(editor.document, "manual"),
      );
      if (outcome.skipped) void vscode.window.showInformationMessage(`Web Validator: ${outcome.skipped}`);
      return outcome;
    }),
    vscode.commands.registerCommand("webValidator.validateWorkspace", () => validateWorkspace(service, configLoader, logger)),
    vscode.commands.registerCommand("webValidator.clearProblems", () => {
      service.clearWorkspaceResults();
    }),
    vscode.commands.registerCommand("webValidator.validateRunningPage", (url?: string, options?: { open?: boolean }) =>
      validateRunningPage(service, url, options),
    ),
    vscode.commands.registerCommand("webValidator.showRenderedPage", async (jspUri?: vscode.Uri) => {
      const uri = jspUri ?? vscode.window.activeTextEditor?.document.uri;
      const page = uri && service.renderedPageFor(uri);
      if (!page) {
        void vscode.window.showInformationMessage('Web Validator: no rendered page yet. Set webValidator.jsp.mode to "rendered" and save the JSP.');
        return;
      }
      await vscode.window.showTextDocument(page, { preview: true });
    }),
    vscode.commands.registerCommand("webValidator.createCustomRule", (args?: CreateRuleArgs) => createCustomRule(configLoader, args)),
    vscode.commands.registerCommand("webValidator.disableRuleInConfig", async (uri: vscode.Uri | undefined, ruleId: string) => {
      const file = await disableRuleInConfig(configLoader, uri, ruleId);
      if (file) logger.info(`Disabled ${ruleId} in ${file.fsPath}`);
      return file;
    }),
    vscode.commands.registerCommand("webValidator.openConfig", () => openConfig(configLoader)),
    vscode.commands.registerCommand("webValidator.restartEngines", async () => {
      resetJavaMissingNotice();
      await vnu.restart();
      store.invalidate();
      rules.resetErrors();
      configLoader.invalidate();
      logger.info("Engines restarted");
      service.revalidateAll();
    }),
    vscode.commands.registerCommand("webValidator.showOutput", () => logger.show()),

    configLoader.onDidChange(() => service.revalidateAll()),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION) && !e.affectsConfiguration("java")) return;
      const s = readSettings();
      logger.level = s.trace;
      if (e.affectsConfiguration(`${SECTION}.java.home`) || e.affectsConfiguration("java")) {
        resetJavaMissingNotice();
        await vnu.restart();
      }
      await vnu.updateOptions(vnuOptions(context, s));
      if (e.affectsConfiguration(`${SECTION}.rulesDirectories`)) store.invalidate();
      if (!s.enable) diagnostics.clearAll();
      configLoader.invalidate(); // settings are part of the merged config; this revalidates
    }),

    // Workspace values for java.home / serverUrl / rule code become usable once trusted.
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await vnu.updateOptions(vnuOptions(context, readSettings()));
      await vnu.restart();
      store.invalidate();
      rules.resetErrors();
      configLoader.invalidate();
    }),
  );

  service.start();
  return { service, diagnostics };
}

export async function deactivate(): Promise<void> {
  // Make sure the JVM does not outlive the extension host.
  await vnuEngine?.dispose();
  vnuEngine = undefined;
}
