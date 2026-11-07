import * as path from "node:path";
import * as vscode from "vscode";
import { JsoncError, parseJsonc } from "./jsonc";
import { readSettings } from "./settings";
import { CONFIG_FILE_NAME, normalizeLayer, resolveConfig, type ConfigLayer, type ResolvedConfig } from "./webValidatorConfig";
import type { Logger } from "../util/logger";

export interface ConfigForUri {
  config: ResolvedConfig;
  folder?: vscode.WorkspaceFolder;
  /** The .webvalidator.json that applies, if any. */
  configFile?: vscode.Uri;
}

/**
 * Finds and caches the configuration for a document: VS Code settings merged
 * with the nearest .webvalidator.json (searched from the document's folder up
 * to its workspace folder). Problems in config files are shown as diagnostics
 * on the file itself.
 */
export class ConfigLoader implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<ConfigForUri>>();
  private readonly fileLayers = new Map<string, Promise<{ layer?: ConfigLayer; errors: string[] }>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("webValidator.config");
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly logger: Logger) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`);
    const onFile = () => this.invalidate();
    this.disposables.push(
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      this.changed,
      this.diagnostics,
    );
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

  /** Nearest config file from `dir` up to the workspace folder root. */
  async findConfigFile(folder: vscode.WorkspaceFolder | undefined, dir: string): Promise<vscode.Uri | undefined> {
    if (!folder || folder.uri.scheme !== "file") return undefined;
    const root = folder.uri.fsPath;
    let current = dir && !path.relative(root, dir).startsWith("..") ? dir : root;
    for (;;) {
      const candidate = vscode.Uri.file(path.join(current, CONFIG_FILE_NAME));
      try {
        await vscode.workspace.fs.stat(candidate);
        return candidate;
      } catch {
        // not here
      }
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

  private readFile(file: vscode.Uri): Promise<{ layer?: ConfigLayer; errors: string[] }> {
    const key = file.toString();
    let entry = this.fileLayers.get(key);
    if (!entry) {
      entry = (async () => {
        let text: string;
        try {
          text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
        } catch (err) {
          return { errors: [`${file.fsPath}: ${(err as Error).message}`] };
        }
        const diags: vscode.Diagnostic[] = [];
        try {
          const raw = parseJsonc(text);
          const { layer, errors } = normalizeLayer(raw, file.fsPath, path.dirname(file.fsPath));
          for (const e of errors) {
            const message = e.slice(file.fsPath.length + 2);
            const keyMatch = /^"([^".[]+)/.exec(message);
            const line = keyMatch ? Math.max(0, text.split("\n").findIndex((l) => l.includes(`"${keyMatch[1]}"`))) : 0;
            diags.push(this.diag(line, message));
            this.logger.warn(`Configuration: ${e}`);
          }
          this.diagnostics.set(file, diags);
          return { layer, errors };
        } catch (err) {
          const line = err instanceof JsoncError ? err.line : 0;
          diags.push(this.diag(line, (err as Error).message));
          this.diagnostics.set(file, diags);
          this.logger.warn(`Configuration: ${file.fsPath}: ${(err as Error).message}`);
          return { errors: [`${file.fsPath}: ${(err as Error).message}`] };
        }
      })();
      this.fileLayers.set(key, entry);
    }
    return entry;
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
