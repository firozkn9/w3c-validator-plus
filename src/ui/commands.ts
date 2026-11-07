import * as path from "node:path";
import * as vscode from "vscode";
import type { ConfigLoader } from "../config/configLoader";
import { addRulesDirectoryText, applyReplacement, setRuleInConfigText, type TextReplacement } from "../config/configEdit";
import { readSettings } from "../config/settings";
import { CONFIG_FILE_NAME } from "../config/webValidatorConfig";
import type { RuleLanguage } from "../rules/RuleApi";
import { RULE_ID_PATTERN, RULE_TYPES_DTS, ruleFileName, ruleTemplate } from "../rules/scaffold";
import { Semaphore } from "../util/async";
import { fetchPage, isLocalUrl } from "../util/fetchPage";
import { isExcluded } from "../util/glob";
import type { Logger } from "../util/logger";
import { languageForPath, type ValidationService } from "../validationService";

const DEFAULT_RULES_DIR = ".webvalidator/rules";
const MAX_WORKSPACE_FILES = 5000;

async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

/** Applies a text replacement to a file, through the editor if it is open, then saves. */
async function editFile(uri: vscode.Uri, before: string, r: TextReplacement): Promise<void> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(open.positionAt(r.start), open.positionAt(r.end)), r.text);
    await vscode.workspace.applyEdit(edit);
    await open.save();
  } else {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(applyReplacement(before, r), "utf8"));
  }
}

async function pickFolder(uri?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  if (uri) {
    const f = vscode.workspace.getWorkspaceFolder(uri);
    if (f) return f;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: "Workspace folder" });
}

/** The config file for a document: the nearest existing one, or a new one at the folder root. */
async function configFileFor(loader: ConfigLoader, uri: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
  const folder = await pickFolder(uri);
  if (!folder) {
    void vscode.window.showWarningMessage("Web Validator: open a folder to create a .webvalidator.json file.");
    return undefined;
  }
  const dir = uri?.scheme === "file" ? path.dirname(uri.fsPath) : folder.uri.fsPath;
  return (await loader.findConfigFile(folder, dir)) ?? vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME);
}

export async function disableRuleInConfig(loader: ConfigLoader, uri: vscode.Uri | undefined, ruleId: string): Promise<vscode.Uri | undefined> {
  const file = await configFileFor(loader, uri);
  if (!file) return undefined;
  const text = await readText(file);
  try {
    await editFile(file, text, setRuleInConfigText(text, ruleId, "off"));
  } catch (err) {
    void vscode.window.showErrorMessage(`Web Validator: could not update ${file.fsPath}: ${(err as Error).message}`);
    return undefined;
  }
  loader.invalidate();
  return file;
}

export async function openConfig(loader: ConfigLoader): Promise<void> {
  const file = await configFileFor(loader, vscode.window.activeTextEditor?.document.uri);
  if (!file) return;
  if (!(await readText(file)).trim()) {
    await vscode.workspace.fs.writeFile(file, Buffer.from('{\n  "extends": ["recommended"],\n  "rules": {}\n}\n', "utf8"));
  }
  await vscode.window.showTextDocument(file);
}

export interface CreateRuleArgs {
  id?: string;
  languages?: RuleLanguage[];
  folder?: vscode.Uri;
  /** Skip opening the created file (tests). */
  noOpen?: boolean;
}

export async function createCustomRule(loader: ConfigLoader, args: CreateRuleArgs = {}): Promise<vscode.Uri | undefined> {
  const folder = args.folder ? vscode.workspace.getWorkspaceFolder(args.folder) : await pickFolder(vscode.window.activeTextEditor?.document.uri);
  if (!folder) {
    void vscode.window.showWarningMessage("Web Validator: open a folder to create custom rules.");
    return undefined;
  }
  const id =
    args.id ??
    (await vscode.window.showInputBox({
      title: "Create Custom Rule",
      prompt: "Rule id in the form scope/name",
      value: "custom/my-rule",
      validateInput: (v) => (RULE_ID_PATTERN.test(v) ? undefined : "Use scope/name, e.g. custom/no-inline-handlers"),
    }));
  if (!id) return undefined;
  if (!RULE_ID_PATTERN.test(id)) {
    void vscode.window.showErrorMessage(`Web Validator: "${id}" is not a valid rule id (use scope/name).`);
    return undefined;
  }
  let languages = args.languages;
  if (!languages) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "html", picked: true },
        { label: "jsp", picked: true },
        { label: "javascript", picked: false },
      ],
      { title: "Languages the rule checks", canPickMany: true },
    );
    if (!picked?.length) return undefined;
    languages = picked.map((p) => p.label as RuleLanguage);
  }

  const configFile = (await loader.findConfigFile(folder, folder.uri.fsPath)) ?? vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME);
  const { config } = await loader.forUri(configFile);
  const rulesDir = config.rulesDirectories[0] ? vscode.Uri.file(config.rulesDirectories[0]) : vscode.Uri.joinPath(folder.uri, DEFAULT_RULES_DIR);
  await vscode.workspace.fs.createDirectory(rulesDir);
  const ruleFile = vscode.Uri.joinPath(rulesDir, ruleFileName(id));
  try {
    await vscode.workspace.fs.stat(ruleFile);
    void vscode.window.showWarningMessage(`Web Validator: ${ruleFile.fsPath} already exists; it was not changed.`);
  } catch {
    await vscode.workspace.fs.writeFile(ruleFile, Buffer.from(ruleTemplate(id, languages), "utf8"));
  }
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(rulesDir, "webvalidator.d.ts"), Buffer.from(RULE_TYPES_DTS, "utf8"));

  // Register the folder and the rule in .webvalidator.json.
  let text = await readText(configFile);
  const relDir = path.relative(path.dirname(configFile.fsPath), rulesDir.fsPath).split(path.sep).join("/") || ".";
  const addDir = addRulesDirectoryText(text, relDir);
  if (addDir) {
    await editFile(configFile, text, addDir);
    text = await readText(configFile);
  }
  if (!config.rules.has(id)) await editFile(configFile, text, setRuleInConfigText(text, id, "warning"));
  loader.invalidate();

  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Web Validator: custom rule code only runs in trusted workspaces. Trust this workspace to use the new rule.");
  }
  if (!args.noOpen) await vscode.window.showTextDocument(ruleFile);
  return ruleFile;
}

export interface WorkspaceSummary {
  files: number;
  errors: number;
  warnings: number;
  infos: number;
  cancelled: boolean;
}

export async function validateWorkspace(service: ValidationService, loader: ConfigLoader, logger: Logger): Promise<WorkspaceSummary> {
  const settings = readSettings();
  const exts = [
    ...(settings.languages.includes("html") ? ["html", "htm", "xhtml"] : []),
    ...(settings.languages.includes("jsp") ? ["jsp", "jspf", "tag"] : []),
    ...(settings.languages.includes("javascript") ? ["js", "mjs", "cjs"] : []),
  ];
  const summary: WorkspaceSummary = { files: 0, errors: 0, warnings: 0, infos: 0, cancelled: false };
  if (exts.length === 0) return summary;

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Web Validator: validating workspace", cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      // files.exclude applies; node_modules is always skipped.
      const found = await vscode.workspace.findFiles(`**/*.{${exts.join(",")}}`, "**/node_modules/**", MAX_WORKSPACE_FILES + 1, token);
      if (found.length > MAX_WORKSPACE_FILES) {
        void vscode.window.showWarningMessage(`Web Validator: only the first ${MAX_WORKSPACE_FILES} files are validated.`);
      }
      const files: vscode.Uri[] = [];
      for (const uri of found.slice(0, MAX_WORKSPACE_FILES)) {
        if (!languageForPath(uri.fsPath)) continue;
        const { config } = await loader.forUri(uri);
        if (!isExcluded(uri.fsPath, config.exclude)) files.push(uri);
      }
      const limit = new Semaphore(4);
      let done = 0;
      await Promise.all(
        files.map((uri) =>
          limit
            .run(async () => {
              const outcome = await service.validateFile(uri, "workspace", controller.signal);
              done++;
              summary.files++;
              summary.errors += outcome.counts?.errors ?? 0;
              summary.warnings += outcome.counts?.warnings ?? 0;
              summary.infos += outcome.counts?.infos ?? 0;
              progress.report({ increment: 100 / files.length, message: `${done}/${files.length} ${path.basename(uri.fsPath)}` });
            }, controller.signal)
            .catch((err) => {
              if (!controller.signal.aborted) logger.error(`Could not validate ${uri.fsPath}`, err);
            }),
        ),
      );
      summary.cancelled = token.isCancellationRequested;
      const msg = `Web Validator: ${summary.cancelled ? "cancelled after" : "validated"} ${summary.files} file(s): ${summary.errors} error(s), ${summary.warnings} warning(s).`;
      logger.info(msg);
      void vscode.window.showInformationMessage(msg, "Show Problems").then((c) => {
        if (c) void vscode.commands.executeCommand("workbench.actions.view.problems");
      });
      return summary;
    },
  );
}

export async function validateRunningPage(service: ValidationService, url?: string, options: { open?: boolean } = {}): Promise<vscode.Uri | undefined> {
  const settings = readSettings();
  const target =
    url ??
    (await vscode.window.showInputBox({
      title: "Validate Running Page",
      prompt: "URL of a page served by your local application",
      value: settings.jsp.renderedBaseUrl || "http://localhost:8080/",
      validateInput: (v) => {
        try {
          const u = new URL(v);
          return u.protocol === "http:" || u.protocol === "https:" ? undefined : "Use an http or https URL";
        } catch {
          return "Enter a valid URL";
        }
      },
    }));
  if (!target) return undefined;
  if (!isLocalUrl(new URL(target))) {
    const go = await vscode.window.showWarningMessage(
      `${new URL(target).host} is not a local address. The extension will request this page from your computer. Continue?`,
      { modal: true },
      "Validate",
    );
    if (go !== "Validate") return undefined;
  }
  try {
    const page = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Web Validator: loading ${target}` },
      () => fetchPage(target),
    );
    if (page.status >= 400) {
      void vscode.window.showWarningMessage(`Web Validator: ${target} answered HTTP ${page.status}; validating the response anyway.`);
    }
    const { uri } = await service.validatePage(page.url, page.body);
    if (options.open !== false) await vscode.window.showTextDocument(uri, { preview: true });
    return uri;
  } catch (err) {
    void vscode.window.showErrorMessage(`Web Validator: could not load ${target}: ${(err as Error).message}`);
    return undefined;
  }
}
