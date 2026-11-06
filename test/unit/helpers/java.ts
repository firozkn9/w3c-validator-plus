import { spawnSync } from "node:child_process";
import {
  candidateJavaExecutables,
  MIN_JAVA_MAJOR,
  nodeJavaHost,
  parseJavaVersion,
  type JavaLookupResult,
} from "../../../src/java/javaLocator";

/** Synchronous Java lookup so suites can be skipped at collection time. */
export function findJavaSync(): JavaLookupResult {
  for (const c of candidateJavaExecutables(nodeJavaHost, {})) {
    if (!nodeJavaHost.isFile(c.executable)) continue;
    const r = spawnSync(c.executable, ["-version"], { encoding: "utf8" });
    const v = parseJavaVersion(`${r.stderr ?? ""}\n${r.stdout ?? ""}`);
    if (v && v.major >= MIN_JAVA_MAJOR) return { runtime: { ...c, major: v.major, versionLine: v.line }, attempts: [] };
  }
  return { attempts: [] };
}

export const vnuJarPath = String(require("vnu-jar"));
