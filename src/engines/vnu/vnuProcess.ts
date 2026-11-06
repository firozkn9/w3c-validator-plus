import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { abortError } from "../Engine";
import { Emitter } from "../../util/emitter";
import type { Logger } from "../../util/logger";
import { delay } from "../../util/async";
import { isVnuReachable, type VnuInputKind } from "./vnuHttp";
import { parseVnuResponse, type VnuResponse } from "./vnuMessages";

/**
 * JVM flags for vnu. The documented 512k stack is not enough on recent JDKs
 * (vnu reports a StackOverflowError while loading the schema on Java 26),
 * so a larger stack is used.
 */
export const VNU_JVM_ARGS = ["-Xss4m", "-Dnu.validator.servlet.bind-address=127.0.0.1"] as const;

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a port"))));
    });
  });
}

export interface VnuServiceOptions {
  javaExecutable: string;
  jarPath: string;
  logger: Logger;
  startupTimeoutMs?: number;
}

/** A long-lived local vnu HTTP service bound to 127.0.0.1 on a random port. */
export class VnuService {
  private child: ChildProcess | undefined;
  private port = 0;
  private stopping = false;
  private readonly exitEmitter = new Emitter<{ code: number | null; signal: NodeJS.Signals | null }>();
  readonly onExit = this.exitEmitter.event;

  constructor(private readonly opts: VnuServiceOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  async start(signal?: AbortSignal): Promise<void> {
    const { logger } = this.opts;
    this.port = await findFreePort();
    const args = [...VNU_JVM_ARGS, "-cp", this.opts.jarPath, "nu.validator.servlet.Main", String(this.port)];
    logger.info(`Starting Nu Html Checker service: ${this.opts.javaExecutable} ${args.join(" ")}`);
    const started = Date.now();

    const child = spawn(this.opts.javaExecutable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    let exited = false;
    let spawnError: Error | undefined;
    const tail: string[] = [];
    const onOutput = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        logger.verbose(`[vnu] ${line}`);
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", (err) => {
      spawnError = err;
      exited = true;
    });
    child.on("exit", (code, sig) => {
      exited = true;
      if (this.child === child) this.child = undefined;
      if (!this.stopping) {
        logger.warn(`Nu Html Checker service exited (code ${code ?? "none"}, signal ${sig ?? "none"})`);
        this.exitEmitter.fire({ code, signal: sig });
      }
    });

    const timeoutMs = this.opts.startupTimeoutMs ?? 60_000;
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) {
        await this.stop();
        throw abortError();
      }
      if (exited) {
        const why = spawnError ? spawnError.message : tail.slice(-5).join("\n");
        throw new Error(`Nu Html Checker service failed to start: ${why}`);
      }
      if (await isVnuReachable(this.baseUrl, { timeoutMs: 2_000 })) {
        logger.info(`Nu Html Checker service ready on port ${this.port} after ${Date.now() - started} ms`);
        return;
      }
      await delay(250);
    }
    await this.stop();
    throw new Error(`Nu Html Checker service did not start within ${timeoutMs} ms`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    this.stopping = false;
  }

  dispose(): void {
    void this.stop();
    this.exitEmitter.dispose();
  }
}

export interface VnuCliOptions {
  javaExecutable: string;
  jarPath: string;
  kind: VnuInputKind;
  signal?: AbortSignal;
  timeoutMs: number;
}

/**
 * One-shot `java -jar vnu.jar --no-stream -` run. Slower (JVM start-up) but it
 * parses in buffered mode, so it reports errors past points where the
 * streaming service gives up with a fatal "Cannot recover" error.
 */
export function runVnuCli(text: string, opts: VnuCliOptions): Promise<VnuResponse> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const args = [
      VNU_JVM_ARGS[0],
      "-jar",
      opts.jarPath,
      "--format",
      "json",
      "--stdout",
      "--exit-zero-always",
      "--no-stream",
      ...(opts.kind === "css" ? ["--css"] : []),
      "-",
    ];
    const child = spawn(opts.javaExecutable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(abortError()));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Nu Html Checker CLI did not finish within ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() => {
        const body = Buffer.concat(out).toString("utf8").trim();
        if (!body) {
          reject(new Error(`Nu Html Checker CLI exited with code ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 500)}`));
          return;
        }
        try {
          resolve(parseVnuResponse(body));
        } catch (e) {
          reject(e);
        }
      }),
    );
    child.stdin.on("error", () => {
      /* reported via close */
    });
    child.stdin.end(text, "utf8");
  });
}
