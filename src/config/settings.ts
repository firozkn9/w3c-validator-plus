import * as vscode from "vscode";
import type { JspDocumentStructure } from "../preprocess/jspDocument";
import { DEFAULT_CUSTOM_TAG_PREFIXES } from "../preprocess/jspMasker";
import type { TraceLevel } from "../util/logger";

export type RunMode = "onSave" | "onType" | "manual";

export interface Settings {
  enable: boolean;
  run: RunMode;
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
  /** Raw rule-related settings, normalized like a .webvalidator.json file. */
  configLayer: Record<string, unknown>;
  trace: TraceLevel;
}

export const SECTION = "webValidator";

/**
 * Settings that cause a program to run, code to load, or data to be sent
 * somewhere. VS Code already ignores workspace values for most of them in
 * untrusted workspaces (`restrictedConfigurations` in package.json); this
 * re-checks it defensively.
 */
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
    run: c.get<RunMode>("run", "onSave"),
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
      documentStructure: c.get<JspDocumentStructure>("jsp.documentStructure", "ignore") === "validate" ? "validate" : "ignore",
      customTagPrefixes: c.get<string[]>("jsp.customTagPrefixes", [...DEFAULT_CUSTOM_TAG_PREFIXES]),
      renderedBaseUrl: machineValue(c, "jsp.renderedBaseUrl", ""),
      webRoot: c.get("jsp.webRoot", "src/main/webapp"),
    },
    ecmaVersion: ecmaVersionOf(c.get("javascript.ecmaVersion", "latest")),
    configLayer,
    trace: c.get<TraceLevel>("trace", "info"),
  };
}

/** Values of the Red Hat Java extension's JDK settings, user-level only unless trusted. */
export function redhatJavaHomes(): string[] {
  const c = vscode.workspace.getConfiguration("java");
  const values = ["jdt.ls.java.home", "home"].map((k) => machineValue<string>(c, k, ""));
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}
