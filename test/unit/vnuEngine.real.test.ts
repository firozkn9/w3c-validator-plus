/**
 * Runs the real Nu Html Checker. Skipped when no Java 17+ runtime is found.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isAbortError } from "../../src/engines/Engine";
import { VnuEngine } from "../../src/engines/vnuEngine";
import { VnuConnectionError } from "../../src/engines/vnu/vnuHttp";
import { runVnuCli } from "../../src/engines/vnu/vnuProcess";
import { nullLogger } from "../../src/util/logger";
import { findJavaSync, vnuJarPath as jarPath } from "./helpers/java";

const fixtures = join(__dirname, "..", "fixtures", "html");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

const lookup = findJavaSync();
const java = lookup.runtime;

const doc = (text: string, version = 1) => ({ uri: "file:///test.html", languageId: "html", text, version });
const signal = () => new AbortController().signal;

describe.skipIf(!java)("Nu Html Checker (real JVM)", () => {
  const engine = new VnuEngine(
    { mode: "local", serverUrl: "", jarPath, timeoutMs: 30_000 },
    { logger: nullLogger, findJava: async () => lookup },
  );
  afterAll(() => engine.dispose());

  it("reports nothing for a valid document", async () => {
    expect(await engine.validate(doc(read("valid.html")), signal())).toEqual([]);
    expect(engine.status.state).toBe("ready");
  });

  it("reports every problem in invalid.html, including those after the fatal table error", async () => {
    const findings = await engine.validate(doc(read("invalid.html")), signal());
    const ids = new Set(findings.map((f) => f.ruleId));
    for (const id of [
      "vnu:img-missing-alt",
      "vnu:obsolete-element",
      "vnu:misplaced-in-table",
      "vnu:element-not-allowed-as-child", // after the table: only seen thanks to the buffered re-check
      "vnu:css-invalid-value",
      "vnu:duplicate-id",
      "vnu:unclosed-element",
      "vnu:missing-lang",
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(ids).not.toContain("vnu:fatal-parse-error");
    const li = findings.find((f) => f.ruleId === "vnu:element-not-allowed-as-child");
    expect(li?.range).toEqual({ start: { line: 10, character: 2 }, end: { line: 10, character: 6 } });
  });

  it("uses UTF-16 columns that match VS Code for non-ASCII text", async () => {
    const text = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>\n<p>é😀 <img src="x.png"></p>\n</body></html>';
    const [alt] = (await engine.validate(doc(text), signal())).filter((f) => f.ruleId === "vnu:img-missing-alt");
    // "<p>é😀 " is 3 + 1 + 2 (surrogate pair) + 1 = 7 UTF-16 code units
    expect(alt?.range.start).toEqual({ line: 1, character: 7 });
  });

  it("handles CRLF line endings", async () => {
    const text = read("invalid.html").replace(/\n/g, "\r\n");
    const alt = (await engine.validate(doc(text), signal())).find((f) => f.ruleId === "vnu:img-missing-alt");
    expect(alt?.range).toEqual({ start: { line: 7, character: 2 }, end: { line: 7, character: 22 } });
  });

  it("serves concurrent requests from one JVM", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => engine.validate(doc(read("invalid.html")), signal())),
    );
    for (const r of results) expect(r.length).toBeGreaterThan(5);
  });

  it("rejects with AbortError when cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(engine.validate(doc(read("valid.html")), ac.signal)).rejects.toSatisfy(isAbortError);
  });

  it("recovers when the JVM is killed", async () => {
    // Reach into the private service to simulate a crash.
    const service = (engine as unknown as { service: { stop(): Promise<void> } }).service;
    await service.stop();
    expect(await engine.validate(doc(read("valid.html")), signal())).toEqual([]);
  });

  it("CLI buffered mode works standalone", async () => {
    const res = await runVnuCli(read("invalid.html"), {
      javaExecutable: java!.executable,
      jarPath,
      kind: "html",
      timeoutMs: 60_000,
    });
    expect(res.messages.length).toBeGreaterThan(5);
  });
});

describe("server mode", () => {
  it("reports a connection error for an unreachable server", async () => {
    const engine = new VnuEngine(
      { mode: "server", serverUrl: "http://127.0.0.1:9/", jarPath, timeoutMs: 3_000 },
      { logger: nullLogger, findJava: async () => ({ attempts: [] }) },
    );
    await expect(engine.validate(doc("<p>x"), signal())).rejects.toBeInstanceOf(VnuConnectionError);
    expect(engine.status.state).toBe("error");
  });

  it("is unavailable without a server URL", async () => {
    const engine = new VnuEngine(
      { mode: "server", serverUrl: "", jarPath, timeoutMs: 3_000 },
      { logger: nullLogger, findJava: async () => ({ attempts: [] }) },
    );
    await expect(engine.validate(doc("<p>x"), signal())).rejects.toThrow(/serverUrl/);
    expect(engine.status.state).toBe("unavailable");
  });
});

describe("Java missing", () => {
  it("reports the engine as unavailable instead of crashing", async () => {
    const engine = new VnuEngine(
      { mode: "local", serverUrl: "", jarPath, timeoutMs: 3_000 },
      { logger: nullLogger, findJava: async () => ({ attempts: [] }) },
    );
    await expect(engine.validate(doc("<p>x"), signal())).rejects.toThrow(/Java 17\+ not found/);
    expect(engine.status).toEqual({ state: "unavailable", detail: "Java 17+ not found" });
  });
});
