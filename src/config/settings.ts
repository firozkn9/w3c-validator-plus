import * as vscode from "vscode";
import type { JspDocumentStructure, JspOptions } from "../preprocess/jspDocument";
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
  jsp: JspOptions;
  trace: TraceLevel;
}

export const SECTION = "webValidator";

/**
 * Settings that cause a program to run or data to be sent somewhere. VS Code
 * already ignores workspace values for them in untrusted workspaces (see
 * `restrictedConfigurations` in package.json); this re-checks it defensively.
 */
function machineValue<T>(config: vscode.WorkspaceConfiguration, key: string, fallback: T): T {
  if (vscode.workspace.isTrusted) return config.get<T>(key, fallback);
  const inspected = config.inspect<T>(key);
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}

export function readSettings(scope?: vscode.ConfigurationScope): Settings {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return {
    enable: c.get("enable", true),
    run: c.get<RunMode>("run", "onSave"),
    onTypeDelayMs: Math.max(100, c.get("onTypeDelayMs", 800)),
    languages: c.get<string[]>("languages", ["html", "jsp"]),
    maxFileSizeKb: Math.max(1, c.get("maxFileSizeKb", 1024)),
    javaHome: machineValue(c, "java.home", ""),
    vnuMode: c.get<"local" | "server">("vnu.mode", "local"),
    vnuServerUrl: machineValue(c, "vnu.serverUrl", ""),
    vnuValidateOnType: c.get("vnu.validateOnType", false),
    vnuTimeoutMs: Math.max(1000, c.get("vnu.timeoutMs", 20_000)),
    jsp: {
      documentStructure: c.get<JspDocumentStructure>("jsp.documentStructure", "ignore") === "validate" ? "validate" : "ignore",
      customTagPrefixes: c.get<string[]>("jsp.customTagPrefixes", [...DEFAULT_CUSTOM_TAG_PREFIXES]),
    },
    trace: c.get<TraceLevel>("trace", "info"),
  };
}

/** Values of the Red Hat Java extension's JDK settings, user-level only unless trusted. */
export function redhatJavaHomes(): string[] {
  const c = vscode.workspace.getConfiguration("java");
  const values = ["jdt.ls.java.home", "home"].map((k) => machineValue<string>(c, k, ""));
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}
