import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** vnu.jar 26.x states "On any system with Java17+ installed". */
export const MIN_JAVA_MAJOR = 17;

export type JavaOrigin = "setting" | "JAVA_HOME" | "PATH" | "redhat.java";

export interface JavaCandidate {
  executable: string;
  origin: JavaOrigin;
}

export interface JavaRuntime extends JavaCandidate {
  major: number;
  versionLine: string;
}

export interface JavaAttempt {
  candidate: JavaCandidate;
  problem: string;
}

export interface JavaLookupResult {
  runtime?: JavaRuntime;
  /** Candidates that were tried and rejected, in order. */
  attempts: JavaAttempt[];
}

/** Side-effecting operations, injectable for tests. */
export interface JavaLocatorHost {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isFile(p: string): boolean;
  isDirectory(p: string): boolean;
  readDir(p: string): string[];
  /** Runs `<exe> -version` and resolves with its combined output. */
  getVersionOutput(executable: string): Promise<string>;
}

export interface JavaLocatorOptions {
  /** Value of `webValidator.java.home` (JDK home or a java executable). */
  settingJavaHome?: string;
  /** Install folder of the `redhat.java` extension, if installed. */
  redhatJavaExtensionPath?: string;
  /** Values of `java.jdt.ls.java.home` / `java.home`, checked before redhat.java's bundled JRE. */
  redhatJavaHomes?: string[];
  minMajor?: number;
}

export function parseJavaVersion(output: string): { major: number; line: string } | undefined {
  const match = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(output);
  if (!match) return undefined;
  let major = Number(match[1]);
  // Java 8 and older report "1.8.0_292".
  if (major === 1 && match[2] !== undefined) major = Number(match[2]);
  const line = output.split(/\r?\n/).find((l) => l.includes(match[0])) ?? match[0];
  return { major, line: line.trim() };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function envValue(host: JavaLocatorHost, name: string): string | undefined {
  if (host.platform !== "win32") return host.env[name];
  const key = Object.keys(host.env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : host.env[key];
}

/** Lists java executables to try, in priority order, without touching the processes. */
export function candidateJavaExecutables(host: JavaLocatorHost, opts: JavaLocatorOptions): JavaCandidate[] {
  const p = host.platform === "win32" ? path.win32 : path.posix;
  const exeName = host.platform === "win32" ? "java.exe" : "java";
  const out: JavaCandidate[] = [];
  const seen = new Set<string>();

  const add = (executable: string, origin: JavaOrigin) => {
    const key = host.platform === "win32" ? p.normalize(executable).toLowerCase() : p.normalize(executable);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ executable, origin });
  };

  const fromHome = (raw: string | undefined, origin: JavaOrigin) => {
    if (!raw || !unquote(raw)) return;
    const home = unquote(raw);
    const base = p.basename(home).toLowerCase();
    if ((base === "java" || base === "java.exe") && host.isFile(home)) {
      add(home, origin);
    } else {
      add(p.join(home, "bin", exeName), origin);
    }
  };

  fromHome(opts.settingJavaHome, "setting");
  fromHome(envValue(host, "JAVA_HOME"), "JAVA_HOME");

  const pathVar = envValue(host, "PATH");
  if (pathVar) {
    const delimiter = host.platform === "win32" ? ";" : ":";
    for (const entry of pathVar.split(delimiter)) {
      const dir = unquote(entry);
      if (dir) add(p.join(dir, exeName), "PATH");
    }
  }

  for (const home of opts.redhatJavaHomes ?? []) fromHome(home, "redhat.java");

  if (opts.redhatJavaExtensionPath) {
    const jreRoot = p.join(opts.redhatJavaExtensionPath, "jre");
    if (host.isDirectory(jreRoot)) {
      const versions = host
        .readDir(jreRoot)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) add(p.join(jreRoot, v, "bin", exeName), "redhat.java");
    }
  }

  return out;
}

/** Finds the first Java runtime that satisfies the minimum version. */
export async function locateJava(host: JavaLocatorHost, opts: JavaLocatorOptions): Promise<JavaLookupResult> {
  const minMajor = opts.minMajor ?? MIN_JAVA_MAJOR;
  const attempts: JavaAttempt[] = [];

  for (const candidate of candidateJavaExecutables(host, opts)) {
    // PATH entries that don't contain java are noise; don't report them as attempts.
    if (candidate.origin === "PATH" && !host.isFile(candidate.executable)) continue;
    let output: string;
    try {
      output = await host.getVersionOutput(candidate.executable);
    } catch (err) {
      attempts.push({ candidate, problem: `could not run: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const version = parseJavaVersion(output);
    if (!version) {
      attempts.push({ candidate, problem: "could not determine the Java version" });
      continue;
    }
    if (version.major < minMajor) {
      attempts.push({ candidate, problem: `found Java ${version.major}, but ${minMajor} or newer is required` });
      continue;
    }
    return { runtime: { ...candidate, major: version.major, versionLine: version.line }, attempts };
  }
  return { attempts };
}

/** Real host backed by the file system and child processes. */
export const nodeJavaHost: JavaLocatorHost = {
  platform: process.platform,
  env: process.env,
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readDir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
  getVersionOutput: (executable) =>
    new Promise((resolve, reject) => {
      execFile(executable, ["-version"], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
        // `java -version` writes to stderr; some builds exit non-zero with useful output.
        const output = `${stderr}\n${stdout}`;
        if (err && !parseJavaVersion(output)) reject(err);
        else resolve(output);
      });
    }),
};
