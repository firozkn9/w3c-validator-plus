// VS Code settings, and the merged configuration for a document: settings
// plus the nearest .webvalidator.json between the document and its workspace
// folder. Problems in a config file show up as diagnostics on that file.
import * as path from "node:path";
import * as vscode from "vscode";
import { CONFIG_FILE_NAME, JsoncError, normalizeLayer, parseJsonc, resolveConfig, type ConfigLayer, type ResolvedConfig } from "./config";
import type { Logger, TraceLevel } from "./core";
import { DEFAULT_CUSTOM_TAG_PREFIXES, type JspDocumentStructure } from "./jsp";

export const SECTION = "webValidator";

export interface Settings {
  enable: boolean;
  run: "onSave" | "onType" | "manual";
  onTypeDelayMs: number;
  languages: string[];
  maxFileSizeKb: number;
  javaHome: string;
  vnuMode: "local" | "server";
  vnuServerUrl: string;
  vnuValidateOnType: boolean;
  vnuTimeoutMs: number;
  jsp: {
    mode: "masked" | "rendered";
    documentStructure: JspDocumentStructure;
    customTagPrefixes: string[];
    renderedBaseUrl: string;
    webRoot: string;
  };
  ecmaVersion: "latest" | number;
  configLayer: Record<string, unknown>; // the rule settings, shaped like a .webvalidator.json
  trace: TraceLevel;
}

// For settings that run a program, load code or send data somewhere. VS Code
// already drops their workspace values in untrusted workspaces
// (restrictedConfigurations in package.json); this is a second check.
function machineValue<T>(config: vscode.WorkspaceConfiguration, key: string, fallback: T): T {
  if (vscode.workspace.isTrusted) return config.get<T>(key, fallback);
  const inspected = config.inspect<T>(key);
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}

function ecmaVersionOf(value: unknown): "latest" | number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 3 ? n : "latest";
}

export function readSettings(scope?: vscode.ConfigurationScope): Settings {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  const configLayer: Record<string, unknown> = {};
  const rules = c.get<Record<string, unknown>>("rules", {});
  if (rules && Object.keys(rules).length) configLayer.rules = rules;
  for (const key of ["ignoreMessages", "exclude", "customRules"]) {
    const v = c.get<unknown[]>(key, []);
    if (Array.isArray(v) && v.length) configLayer[key] = v;
  }
  const dirs = machineValue<string[]>(c, "rulesDirectories", []);
  if (Array.isArray(dirs) && dirs.length) configLayer.rulesDirectories = dirs;

  return {
    enable: c.get("enable", true),
    run: c.get<Settings["run"]>("run", "onSave"),
    onTypeDelayMs: Math.max(100, c.get("onTypeDelayMs", 800)),
    languages: c.get<string[]>("languages", ["html", "jsp", "javascript"]),
    maxFileSizeKb: Math.max(1, c.get("maxFileSizeKb", 1024)),
    javaHome: machineValue(c, "java.home", ""),
    vnuMode: c.get<"local" | "server">("vnu.mode", "local"),
    vnuServerUrl: machineValue(c, "vnu.serverUrl", ""),
    vnuValidateOnType: c.get("vnu.validateOnType", false),
    vnuTimeoutMs: Math.max(1000, c.get("vnu.timeoutMs", 20_000)),
    jsp: {
      mode: c.get<string>("jsp.mode", "masked") === "rendered" ? "rendered" : "masked",
      documentStructure: c.get<string>("jsp.documentStructure", "ignore") === "validate" ? "validate" : "ignore",
      customTagPrefixes: c.get<string[]>("jsp.customTagPrefixes", [...DEFAULT_CUSTOM_TAG_PREFIXES]),
      renderedBaseUrl: machineValue(c, "jsp.renderedBaseUrl", ""),
      webRoot: c.get("jsp.webRoot", "src/main/webapp"),
    },
    ecmaVersion: ecmaVersionOf(c.get("javascript.ecmaVersion", "latest")),
    configLayer,
    trace: c.get<TraceLevel>("trace", "info"),
  };
}

// The Red Hat Java extension's JDK settings (user level only unless trusted).
export function redhatJavaHomes(): string[] {
  const c = vscode.workspace.getConfiguration("java");
  return ["jdt.ls.java.home", "home"].map((k) => machineValue<string>(c, k, "")).filter((v) => typeof v === "string" && v.length > 0);
}

export interface ConfigForUri {
  config: ResolvedConfig;
  folder?: vscode.WorkspaceFolder;
  configFile?: vscode.Uri;
}

type FileLayer = { layer?: ConfigLayer; errors: string[] };

export class ConfigLoader implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<ConfigForUri>>();
  private readonly fileLayers = new Map<string, Promise<FileLayer>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("webValidator.config");
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly logger: Logger) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`);
    const onFile = () => this.invalidate();
    this.disposables.push(watcher, watcher.onDidChange(onFile), watcher.onDidCreate(onFile), watcher.onDidDelete(onFile), this.changed, this.diagnostics);
  }

  invalidate(): void {
    this.cache.clear();
    this.fileLayers.clear();
    this.changed.fire();
  }

  forUri(uri: vscode.Uri): Promise<ConfigForUri> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const dir = uri.scheme === "file" ? path.dirname(uri.fsPath) : (folder?.uri.fsPath ?? "");
    const key = `${folder?.uri.toString() ?? ""}|${dir}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.load(uri, folder, dir);
      this.cache.set(key, entry);
    }
    return entry;
  }

  // The nearest config file from `dir` up to the workspace folder.
  async findConfigFile(folder: vscode.WorkspaceFolder | undefined, dir: string): Promise<vscode.Uri | undefined> {
    if (!folder || folder.uri.scheme !== "file") return undefined;
    const root = folder.uri.fsPath;
    let current = dir && !path.relative(root, dir).startsWith("..") ? dir : root;
    for (;;) {
      const candidate = vscode.Uri.file(path.join(current, CONFIG_FILE_NAME));
      try {
        await vscode.workspace.fs.stat(candidate);
        return candidate;
      } catch {}
      if (path.resolve(current) === path.resolve(root)) return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  private async load(uri: vscode.Uri, folder: vscode.WorkspaceFolder | undefined, dir: string): Promise<ConfigForUri> {
    const settingsLayer = normalizeLayer(readSettings(uri).configLayer, "settings", folder?.uri.fsPath);
    const layers: ConfigLayer[] = [settingsLayer.layer];
    const errors = [...settingsLayer.errors];
    const configFile = await this.findConfigFile(folder, dir);
    if (configFile) {
      const file = await this.readFile(configFile);
      if (file.layer) layers.push(file.layer);
      errors.push(...file.errors);
    }
    for (const e of settingsLayer.errors) this.logger.warn(`Configuration: ${e}`);
    return { config: resolveConfig(layers, errors), ...(folder ? { folder } : {}), ...(configFile ? { configFile } : {}) };
  }

  private readFile(file: vscode.Uri): Promise<FileLayer> {
    const key = file.toString();
    let entry = this.fileLayers.get(key);
    if (!entry) {
      entry = this.parseFile(file);
      this.fileLayers.set(key, entry);
    }
    return entry;
  }

  private async parseFile(file: vscode.Uri): Promise<FileLayer> {
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    } catch (err) {
      return { errors: [`${file.fsPath}: ${(err as Error).message}`] };
    }
    try {
      const { layer, errors } = normalizeLayer(parseJsonc(text), file.fsPath, path.dirname(file.fsPath));
      const diags = errors.map((e) => {
        const message = e.slice(file.fsPath.length + 2);
        // Point at the line of the offending key when it can be found.
        const key = /^"([^".[]+)/.exec(message)?.[1];
        const line = key ? Math.max(0, text.split("\n").findIndex((l) => l.includes(`"${key}"`))) : 0;
        this.logger.warn(`Configuration: ${e}`);
        return this.diag(line, message);
      });
      this.diagnostics.set(file, diags);
      return { layer, errors };
    } catch (err) {
      const message = (err as Error).message;
      this.diagnostics.set(file, [this.diag(err instanceof JsoncError ? err.line : 0, message)]);
      this.logger.warn(`Configuration: ${file.fsPath}: ${message}`);
      return { errors: [`${file.fsPath}: ${message}`] };
    }
  }

  private diag(line: number, message: string): vscode.Diagnostic {
    const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), message, vscode.DiagnosticSeverity.Warning);
    d.source = "Web Validator";
    return d;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
