import * as path from "node:path";
import * as vscode from "vscode";
import { readSettings, redhatJavaHomes, SECTION, type Settings } from "./config/settings";
import { DiagnosticsManager } from "./diagnostics/diagnostics";
import type { Engine } from "./engines/Engine";
import { EslintEngine } from "./engines/eslintEngine";
import { VnuEngine, type VnuEngineOptions } from "./engines/vnuEngine";
import { locateJava, nodeJavaHost } from "./java/javaLocator";
import { resetJavaMissingNotice, showJavaMissing } from "./ui/javaGuidance";
import { OutputLogger } from "./ui/outputLogger";
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

export function activate(context: vscode.ExtensionContext): void {
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
    jspOptions: (uri) => readSettings(vscode.Uri.parse(uri)).jsp,
  });
  vnuEngine = vnu;
  const eslint = new EslintEngine({
    logger,
    options: (uri) => {
      const s = readSettings(vscode.Uri.parse(uri));
      return { ecmaVersion: s.ecmaVersion, jqueryUnscopedSelector: s.jqueryUnscopedSelector, jsp: s.jsp };
    },
  });
  const engines: Engine[] = [vnu, eslint];

  const diagnostics = new DiagnosticsManager();
  const service = new ValidationService({
    engines,
    diagnostics,
    logger,
    runsOnType: (engine, s) => engine.id !== "vnu" || s.vnuValidateOnType,
    onEngineUnavailable: (engine) => {
      if (engine.id === "vnu" && engine.status.detail?.startsWith("Java")) void showJavaMissing(() => logger.show());
    },
  });
  const statusBar = new StatusBar(engines, diagnostics, (doc) => service.isRelevant(doc));

  context.subscriptions.push(
    logger,
    diagnostics,
    service,
    statusBar,
    { dispose: () => void vnu.dispose() },
    eslint,

    vscode.commands.registerCommand("webValidator.validateFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Web Validator: open an HTML file to validate it.");
        return;
      }
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Validating…" },
        () => service.validate(editor.document, "manual"),
      );
      if (outcome.skipped) void vscode.window.showInformationMessage(`Web Validator: ${outcome.skipped}`);
      return outcome;
    }),

    vscode.commands.registerCommand("webValidator.restartEngines", async () => {
      resetJavaMissingNotice();
      await vnu.restart();
      logger.info("Engines restarted");
      service.revalidateOpenDocuments();
    }),

    vscode.commands.registerCommand("webValidator.showOutput", () => logger.show()),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION) && !e.affectsConfiguration("java")) return;
      const s = readSettings();
      logger.level = s.trace;
      if (e.affectsConfiguration(`${SECTION}.java.home`) || e.affectsConfiguration("java")) {
        resetJavaMissingNotice();
        await vnu.restart();
      }
      await vnu.updateOptions(vnuOptions(context, s));
      if (!s.enable) diagnostics.clearAll();
      service.revalidateOpenDocuments();
    }),

    // Workspace values for java.home / serverUrl become usable once the workspace is trusted.
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await vnu.updateOptions(vnuOptions(context, readSettings()));
      await vnu.restart();
      service.revalidateOpenDocuments();
    }),
  );

  service.start();
}

export async function deactivate(): Promise<void> {
  // Make sure the JVM does not outlive the extension host.
  await vnuEngine?.dispose();
  vnuEngine = undefined;
}
