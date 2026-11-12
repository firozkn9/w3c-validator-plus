// HTML and CSS checks with the Nu Html Checker (vnu.jar).
//
// Local mode keeps one JVM running vnu's HTTP service on 127.0.0.1. Its
// streaming parser stops at the first fatal parse error (usually mis-nested
// table content); the document is then checked once more with the buffered
// CLI so later errors are not lost.
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import {
  abortError,
  delay,
  describeError,
  Emitter,
  EngineUnavailableError,
  isAbortError,
  Semaphore,
  type Engine,
  type EngineStatus,
  type Finding,
  type Logger,
  type SourceDocument,
  type ValidationContext,
} from "./core";
import { MIN_JAVA_MAJOR, type JavaLookupResult, type JavaRuntime } from "./java";
import { DEFAULT_JSP_OPTIONS, isJspDocument, mapJspFindings, prepareJsp, type JspOptions } from "./jsp";
import { isFatalParseError, parseVnuResponse, vnuResponseToFindings, type VnuResponse } from "./vnuMessages";

export type VnuInputKind = "html" | "css";

export interface VnuEngineOptions {
  mode: "local" | "server";
  serverUrl: string;
  jarPath: string;
  timeoutMs: number;
}

export interface VnuEngineDeps {
  logger: Logger;
  findJava(): Promise<JavaLookupResult>; // called the first time a local check is needed
  jspOptions?(uri: string): JspOptions;
}

const MAX_CRASH_RESTARTS = 3;
const USER_AGENT = "w3c-validator-plus (VS Code extension)";

// The documented 512k stack overflows while vnu loads its schema on recent JDKs.
const VNU_JVM_ARGS = ["-Xss4m", "-Dnu.validator.servlet.bind-address=127.0.0.1"] as const;

export class VnuEngine implements Engine {
  readonly id = "vnu";
  readonly displayName = "Nu Html Checker";

  private _status: EngineStatus = { state: "idle" };
  private readonly statusEmitter = new Emitter<EngineStatus>();
  private service: VnuService | undefined;
  private pendingService: VnuService | undefined; // JVM still starting
  private generation = 0; // bumped by restart()/dispose() so stale start-ups give up
  private starting: Promise<VnuService> | undefined;
  private java: JavaRuntime | undefined;
  private crashes = 0;
  private readonly httpLimit = new Semaphore(4);
  private readonly cliLimit = new Semaphore(2);

  constructor(
    private options: VnuEngineOptions,
    private readonly deps: VnuEngineDeps,
  ) {}

  get status(): EngineStatus {
    return this._status;
  }

  onStatusChange(listener: (status: EngineStatus) => void) {
    return this.statusEmitter.event(listener);
  }

  supports(languageId: string): boolean {
    return languageId === "html" || languageId === "jsp";
  }

  async updateOptions(options: VnuEngineOptions): Promise<void> {
    const old = this.options;
    this.options = options;
    if (options.mode !== old.mode || options.serverUrl !== old.serverUrl || options.jarPath !== old.jarPath) await this.restart();
  }

  // Also forgets the Java runtime, so the next run looks for it again.
  async restart(): Promise<void> {
    this.java = undefined;
    this.crashes = 0;
    await this.stopAll();
    this.setStatus({ state: "idle" });
  }

  async validate(doc: SourceDocument, signal: AbortSignal, ctx?: ValidationContext): Promise<Finding[]> {
    if (!isJspDocument(doc.languageId, doc.uri)) return this.validateHtml(doc.uri, doc.text, signal);
    const prepared = prepareJsp(doc.text, ctx?.jsp ?? this.deps.jspOptions?.(doc.uri) ?? DEFAULT_JSP_OPTIONS);
    const findings = await this.validateHtml(doc.uri, prepared.text, signal);
    return mapJspFindings(findings, prepared, doc.text);
  }

  private async validateHtml(uri: string, text: string, signal: AbortSignal): Promise<Finding[]> {
    let response = await this.check(text, "html", signal);
    if (response.messages.some(isFatalParseError)) response = await this.recheckBuffered(uri, text, signal, response);
    return vnuResponseToFindings(response, text);
  }

  private async check(text: string, kind: VnuInputKind, signal: AbortSignal): Promise<VnuResponse> {
    const { timeoutMs, serverUrl } = this.options;
    if (this.options.mode === "server") {
      if (!serverUrl) {
        this.setStatus({ state: "unavailable", detail: "webValidator.vnu.serverUrl is not set" });
        throw new EngineUnavailableError("webValidator.vnu.mode is 'server' but webValidator.vnu.serverUrl is empty");
      }
      try {
        const res = await this.httpLimit.run(() => postToVnu(serverUrl, text, kind, { signal, timeoutMs }), signal);
        this.setStatus({ state: "ready", detail: serverUrl });
        return res;
      } catch (err) {
        if (!isAbortError(err)) this.setStatus({ state: "error", detail: (err as Error).message });
        throw err;
      }
    }

    for (let attempt = 0; ; attempt++) {
      const service = await this.ensureService(signal);
      try {
        return await this.httpLimit.run(() => postToVnu(service.baseUrl, text, kind, { signal, timeoutMs }), signal);
      } catch (err) {
        // The JVM may have died since the last request: start it again, once.
        if (attempt === 0 && err instanceof VnuConnectionError && err.code !== "ETIMEDOUT" && !service.running) {
          this.deps.logger.warn(`Nu Html Checker service connection failed (${err.message}); restarting`);
          if (this.service === service) this.service = undefined;
          continue;
        }
        throw err;
      }
    }
  }

  private async recheckBuffered(uri: string, text: string, signal: AbortSignal, streamed: VnuResponse): Promise<VnuResponse> {
    const java = this.java;
    if (this.options.mode !== "local" || !java) return streamed;
    this.deps.logger.verbose(`Streaming parser gave up on ${uri}; re-checking in buffered mode`);
    try {
      const timeoutMs = Math.max(this.options.timeoutMs, 30_000);
      return await this.cliLimit.run(
        () => runVnuCli(text, { javaExecutable: java.executable, jarPath: this.options.jarPath, kind: "html", signal, timeoutMs }),
        signal,
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.deps.logger.warn(`Buffered re-check failed, showing partial results: ${describeError(err)}`);
      return streamed;
    }
  }

  private ensureService(signal: AbortSignal): Promise<VnuService> {
    if (this.service?.running) return Promise.resolve(this.service);
    this.starting ??= this.startService().finally(() => {
      this.starting = undefined;
    });
    const starting = this.starting;
    // Everyone shares one start-up, but each caller can stop waiting on its own.
    return new Promise<VnuService>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      starting.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async startService(): Promise<VnuService> {
    if (this.crashes > MAX_CRASH_RESTARTS) {
      throw new EngineUnavailableError(
        "Nu Html Checker service crashed repeatedly. Run 'Web Validator: Restart Validation Engines' after fixing the cause.",
      );
    }
    this.setStatus({ state: "starting", detail: "Starting Nu Html Checker" });

    if (!this.java) {
      const lookup = await this.deps.findJava();
      for (const a of lookup.attempts) {
        this.deps.logger.info(`Java candidate rejected (${a.candidate.origin}) ${a.candidate.executable}: ${a.problem}`);
      }
      if (!lookup.runtime) {
        const detail = `Java ${MIN_JAVA_MAJOR}+ not found`;
        this.setStatus({ state: "unavailable", detail });
        throw new EngineUnavailableError(`${detail}. HTML/CSS validation needs Java ${MIN_JAVA_MAJOR} or newer; set webValidator.java.home or JAVA_HOME.`);
      }
      this.java = lookup.runtime;
      this.deps.logger.info(`Using Java ${lookup.runtime.major} from ${lookup.runtime.origin}: ${lookup.runtime.executable}`);
    }

    const generation = this.generation;
    const service = new VnuService(this.java.executable, this.options.jarPath, this.deps.logger);
    this.pendingService = service;
    try {
      await service.start();
    } catch (err) {
      if (generation !== this.generation) throw abortError();
      this.crashes++;
      this.setStatus({ state: "error", detail: "Nu Html Checker failed to start" });
      throw err;
    } finally {
      if (this.pendingService === service) this.pendingService = undefined;
    }
    if (generation !== this.generation) {
      // restart() or dispose() ran while the JVM was starting
      await service.stop();
      throw abortError();
    }
    service.onExit(() => {
      this.crashes++;
      if (this.service === service) this.service = undefined;
      this.setStatus({ state: "idle", detail: "Nu Html Checker stopped; it restarts on the next validation" });
    });
    this.service = service;
    this.setStatus({ state: "ready", detail: `Java ${this.java.major}` });
    return service;
  }

  private setStatus(status: EngineStatus): void {
    if (status.state === this._status.state && status.detail === this._status.detail) return;
    this._status = status;
    this.statusEmitter.fire(status);
  }

  private async stopAll(): Promise<void> {
    this.generation++;
    this.starting = undefined;
    const services = [this.service, this.pendingService];
    this.service = undefined;
    this.pendingService = undefined;
    await Promise.all(services.map((s) => s?.stop()));
  }

  async dispose(): Promise<void> {
    await this.stopAll();
    this.statusEmitter.dispose();
  }
}

// --- the long-running local service ---

function findFreePort(): Promise<number> {
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

class VnuService {
  private child: ChildProcess | undefined;
  private port = 0;
  private stopping = false;
  private readonly exitEmitter = new Emitter<{ code: number | null; signal: NodeJS.Signals | null }>();
  readonly onExit = this.exitEmitter.event;

  constructor(
    private readonly javaExecutable: string,
    private readonly jarPath: string,
    private readonly logger: Logger,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  async start(timeoutMs = 60_000): Promise<void> {
    const { logger } = this;
    this.port = await findFreePort();
    const args = [...VNU_JVM_ARGS, "-cp", this.jarPath, "nu.validator.servlet.Main", String(this.port)];
    logger.info(`Starting Nu Html Checker service: ${this.javaExecutable} ${args.join(" ")}`);
    const started = Date.now();

    const child = spawn(this.javaExecutable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

    while (Date.now() - started < timeoutMs) {
      if (exited) {
        const why = spawnError ? spawnError.message : tail.slice(-5).join("\n");
        throw new Error(`Nu Html Checker service failed to start: ${why}`);
      }
      if (await isVnuReachable(this.baseUrl)) {
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
}

// --- one-shot CLI run: slow (a JVM per call) but parses in buffered mode ---

export interface VnuCliOptions {
  javaExecutable: string;
  jarPath: string;
  kind: VnuInputKind;
  signal?: AbortSignal;
  timeoutMs: number;
}

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
    child.stdin.on("error", () => {}); // the close handler reports it
    child.stdin.end(text, "utf8");
  });
}

// --- HTTP ---

export class VnuConnectionError extends Error {
  override name = "VnuConnectionError";

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

function request(url: URL, body: string | undefined, headers: Record<string, string>, opts: RequestOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const lib = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    // vnu answers 400 when there is no User-Agent.
    const method = body === undefined ? "GET" : "POST";
    const req = lib.request(url, { method, headers: { "User-Agent": USER_AGENT, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", (err) => finish(() => reject(new VnuConnectionError(err.message))));
    });
    const onAbort = () => {
      req.destroy();
      finish(() => reject(abortError()));
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new VnuConnectionError(`Nu Html Checker did not answer within ${opts.timeoutMs} ms`, "ETIMEDOUT")));
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err: NodeJS.ErrnoException) =>
      finish(() => reject(new VnuConnectionError(`Cannot reach Nu Html Checker at ${url.origin}: ${err.message}`, err.code))),
    );
    if (body !== undefined) req.write(body, "utf8");
    req.end();
  });
}

async function postToVnu(baseUrl: string, text: string, kind: VnuInputKind, opts: RequestOptions): Promise<VnuResponse> {
  const url = new URL(baseUrl);
  url.searchParams.set("out", "json");
  const headers = {
    "Content-Type": kind === "css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
  };
  const res = await request(url, text, headers, opts);
  if (res.status !== 200) throw new VnuConnectionError(`Nu Html Checker answered HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  return parseVnuResponse(res.body);
}

async function isVnuReachable(baseUrl: string): Promise<boolean> {
  try {
    return (await request(new URL(baseUrl), undefined, {}, { timeoutMs: 2_000 })).status === 200;
  } catch {
    return false;
  }
}
