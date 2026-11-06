import { describe, expect, it } from "vitest";
import {
  candidateJavaExecutables,
  locateJava,
  parseJavaVersion,
  type JavaLocatorHost,
} from "../../src/java/javaLocator";

describe("parseJavaVersion", () => {
  it.each([
    ['java version "1.8.0_292"', 8],
    ['openjdk version "11.0.20" 2023-07-18', 11],
    ['openjdk version "17.0.2" 2022-01-18', 17],
    ['openjdk version "21" 2023-09-19 LTS', 21],
    ['java version "26.0.1" 2026-04-21\nJava(TM) SE Runtime Environment', 26],
    ['openjdk version "23-ea" 2024-09-17', 23],
  ])("parses %s", (output, major) => {
    expect(parseJavaVersion(output)?.major).toBe(major);
  });

  it("returns undefined for unrelated output", () => {
    expect(parseJavaVersion("command not found")).toBeUndefined();
  });
});

/** Fake file system + process host. Paths are matched exactly. */
function fakeHost(opts: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  files?: Record<string, string>; // executable -> `-version` output
  dirs?: Record<string, string[]>;
}): JavaLocatorHost {
  const files = opts.files ?? {};
  const dirs = opts.dirs ?? {};
  return {
    platform: opts.platform ?? "linux",
    env: opts.env ?? {},
    isFile: (p) => p in files,
    isDirectory: (p) => p in dirs,
    readDir: (p) => dirs[p] ?? [],
    getVersionOutput: async (exe) => {
      const out = files[exe];
      if (out === undefined) throw new Error("ENOENT");
      return out;
    },
  };
}

const V17 = 'openjdk version "17.0.9" 2023-10-17';
const V21 = 'openjdk version "21.0.1" 2023-10-17';
const V8 = 'java version "1.8.0_292"';

describe("candidateJavaExecutables", () => {
  it("orders setting, JAVA_HOME, PATH, then redhat.java", () => {
    const host = fakeHost({
      env: { JAVA_HOME: "/opt/jdk", PATH: "/usr/bin:/usr/local/bin" },
      dirs: { "/ext/redhat/jre": ["17.0.1-linux-x86_64", "21.0.2-linux-x86_64"] },
    });
    const c = candidateJavaExecutables(host, {
      settingJavaHome: "/my/jdk",
      redhatJavaExtensionPath: "/ext/redhat",
    });
    expect(c.map((x) => `${x.origin}:${x.executable}`)).toEqual([
      "setting:/my/jdk/bin/java",
      "JAVA_HOME:/opt/jdk/bin/java",
      "PATH:/usr/bin/java",
      "PATH:/usr/local/bin/java",
      // newest bundled JRE first
      "redhat.java:/ext/redhat/jre/21.0.2-linux-x86_64/bin/java",
      "redhat.java:/ext/redhat/jre/17.0.1-linux-x86_64/bin/java",
    ]);
  });

  it("accepts a setting that points directly at the executable", () => {
    const host = fakeHost({ files: { "/my/jdk/bin/java": V17 } });
    const c = candidateJavaExecutables(host, { settingJavaHome: "/my/jdk/bin/java" });
    expect(c[0]).toEqual({ executable: "/my/jdk/bin/java", origin: "setting" });
  });

  it("uses Windows paths, java.exe and a case-insensitive Path variable", () => {
    const host = fakeHost({
      platform: "win32",
      env: { Path: "C:\\Windows;C:\\jdk\\bin", JAVA_HOME: "C:\\jdk" },
    });
    const c = candidateJavaExecutables(host, {});
    expect(c.map((x) => x.executable)).toEqual([
      "C:\\jdk\\bin\\java.exe",
      "C:\\Windows\\java.exe",
      // C:\jdk\bin\java.exe from PATH is a duplicate of JAVA_HOME and is dropped
    ]);
  });

  it("strips surrounding quotes from PATH entries and JAVA_HOME", () => {
    const host = fakeHost({ platform: "win32", env: { JAVA_HOME: '"C:\\Program Files\\jdk"' } });
    expect(candidateJavaExecutables(host, {})[0]?.executable).toBe("C:\\Program Files\\jdk\\bin\\java.exe");
  });
});

describe("locateJava", () => {
  it("returns the first candidate that meets the minimum version", async () => {
    const host = fakeHost({
      env: { JAVA_HOME: "/old", PATH: "/usr/bin" },
      files: { "/old/bin/java": V8, "/usr/bin/java": V21 },
    });
    const result = await locateJava(host, {});
    expect(result.runtime).toMatchObject({ executable: "/usr/bin/java", origin: "PATH", major: 21 });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.problem).toMatch(/Java 8.*17 or newer/);
  });

  it("reports every candidate when nothing usable is found", async () => {
    const host = fakeHost({ env: { JAVA_HOME: "/nope", PATH: "/usr/bin" } });
    const result = await locateJava(host, { settingJavaHome: "/also-nope" });
    expect(result.runtime).toBeUndefined();
    // Explicit locations are reported; PATH folders without java are skipped silently.
    expect(result.attempts.map((a) => a.candidate.origin)).toEqual(["setting", "JAVA_HOME"]);
  });

  it("falls back to the JRE bundled with redhat.java", async () => {
    const jre = "/ext/redhat/jre/21.0.2-linux-x86_64/bin/java";
    const host = fakeHost({
      dirs: { "/ext/redhat/jre": ["21.0.2-linux-x86_64"] },
      files: { [jre]: V21 },
    });
    const result = await locateJava(host, { redhatJavaExtensionPath: "/ext/redhat" });
    expect(result.runtime).toMatchObject({ executable: jre, origin: "redhat.java" });
  });

  it("honours redhat.java's configured java home before its bundled JRE", async () => {
    const host = fakeHost({
      dirs: { "/ext/redhat/jre": ["21.0.2-linux-x86_64"] },
      files: { "/configured/bin/java": V17, "/ext/redhat/jre/21.0.2-linux-x86_64/bin/java": V21 },
    });
    const result = await locateJava(host, {
      redhatJavaExtensionPath: "/ext/redhat",
      redhatJavaHomes: ["/configured"],
    });
    expect(result.runtime?.executable).toBe("/configured/bin/java");
  });
});
