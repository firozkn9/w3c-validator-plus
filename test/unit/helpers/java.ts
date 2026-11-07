import { spawnSync } from "node:child_process";
import {
  candidateJavaExecutables,
  MIN_JAVA_MAJOR,
  nodeJavaHost,
  parseJavaVersion,
  type JavaLookupResult,
} from "../../../src/java/javaLocator";

/**
 * Synchronous Java lookup so suites can be skipped at collection time.
 *
 * Suites are skipped only when no java executable exists at all. When one
 * exists but `-version` keeps failing, this throws instead of silently skipping
 * (parallel test files starting JVMs at once can make a single probe fail).
 */
export function findJavaSync(): JavaLookupResult {
  const failures: string[] = [];
  for (const c of candidateJavaExecutables(nodeJavaHost, {})) {
    if (!nodeJavaHost.isFile(c.executable)) continue;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = spawnSync(c.executable, ["-version"], { encoding: "utf8", timeout: 30_000 });
      const v = parseJavaVersion(`${r.stderr ?? ""}\n${r.stdout ?? ""}`);
      if (v) {
        if (v.major >= MIN_JAVA_MAJOR) return { runtime: { ...c, major: v.major, versionLine: v.line }, attempts: [] };
        break; // too old: try the next candidate
      }
      failures.push(`${c.executable} (attempt ${attempt}): ${r.error?.message ?? `exit ${r.status}`}`);
    }
  }
  if (failures.length > 0) throw new Error(`Java was found but could not be run:\n${failures.join("\n")}`);
  return { attempts: [] };
}

export const vnuJarPath = String(require("vnu-jar"));
