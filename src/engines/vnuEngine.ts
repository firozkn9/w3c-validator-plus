import {
  abortError,
  EngineUnavailableError,
  isAbortError,
  type Engine,
  type EngineStatus,
  type Finding,
  type SourceDocument,
} from "./Engine";
import { MIN_JAVA_MAJOR, type JavaLookupResult, type JavaRuntime } from "../java/javaLocator";
import {
  DEFAULT_JSP_OPTIONS,
  isJspDocument,
  mapJspFindings,
  prepareJsp,
  type JspOptions,
} from "../preprocess/jspDocument";
import { Semaphore } from "../util/async";
import { Emitter } from "../util/emitter";
import { describeError, type Logger } from "../util/logger";
import { postToVnu, VnuConnectionError, type VnuInputKind } from "./vnu/vnuHttp";
import { isFatalParseError, vnuResponseToFindings, type VnuResponse } from "./vnu/vnuMessages";
import { runVnuCli, VnuService } from "./vnu/vnuProcess";

export interface VnuEngineOptions {
  mode: "local" | "server";
  /** Used when `mode` is `server`. */
  serverUrl: string;
  /** Absolute path of the bundled vnu.jar. */
  jarPath: string;
  timeoutMs: number;
}

export interface VnuEngineDeps {
  logger: Logger;
  /** Resolves a Java runtime; called lazily the first time local validation is needed. */
  findJava(): Promise<JavaLookupResult>;
  /** JSP settings for a document URI (defaults are used when omitted). */
  jspOptions?(uri: string): JspOptions;
}

const MAX_CRASH_RESTARTS = 3;

/**
 * HTML + CSS validation with the Nu Html Checker.
 *
 * Local mode keeps one JVM running vnu's HTTP service on 127.0.0.1 (fast,
 * streaming parser). vnu's streaming parser stops at the first "fatal" parse
 * error (typically mis-nested table content); in that case the document is
 * re-checked once with the buffered CLI so no later errors are lost.
 */
export class VnuEngine implements Engine {
  readonly id = "vnu";
  readonly displayName = "Nu Html Checker";

  private _status: EngineStatus = { state: "idle" };
  private readonly statusEmitter = new Emitter<EngineStatus>();
  private service: VnuService | undefined;
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

  /** Applies new settings; restarts the local service only if something relevant changed. */
  async updateOptions(options: VnuEngineOptions): Promise<void> {
    const changed =
      options.mode !== this.options.mode ||
      options.serverUrl !== this.options.serverUrl ||
      options.jarPath !== this.options.jarPath;
    this.options = options;
    if (changed) await this.restart();
  }

  /** Stops the service and forgets the resolved Java so the next run re-detects it. */
  async restart(): Promise<void> {
    this.java = undefined;
    this.crashes = 0;
    this.starting = undefined;
    const service = this.service;
    this.service = undefined;
    await service?.stop();
    this.setStatus({ state: "idle" });
  }

  async validate(doc: SourceDocument, signal: AbortSignal): Promise<Finding[]> {
    if (isJspDocument(doc.languageId, doc.uri)) {
      const prepared = prepareJsp(doc.text, this.deps.jspOptions?.(doc.uri) ?? DEFAULT_JSP_OPTIONS);
      const findings = await this.validateHtml(doc.uri, prepared.text, signal);
      return mapJspFindings(findings, prepared, doc.text);
    }
    return this.validateHtml(doc.uri, doc.text, signal);
  }

  private async validateHtml(uri: string, text: string, signal: AbortSignal): Promise<Finding[]> {
    const kind: VnuInputKind = "html";
    const response = await this.check(text, kind, signal);
    let result = response;
    if (response.messages.some(isFatalParseError)) {
      result = await this.recheckBuffered(uri, text, kind, signal, response);
    }
    return vnuResponseToFindings(result, text);
  }

  private async check(text: string, kind: VnuInputKind, signal: AbortSignal): Promise<VnuResponse> {
    const { timeoutMs } = this.options;
    if (this.options.mode === "server") {
      if (!this.options.serverUrl) {
        this.setStatus({ state: "unavailable", detail: "webValidator.vnu.serverUrl is not set" });
        throw new EngineUnavailableError("webValidator.vnu.mode is 'server' but webValidator.vnu.serverUrl is empty");
      }
      try {
        const res = await this.httpLimit.run(() => postToVnu(this.options.serverUrl, text, kind, { signal, timeoutMs }), signal);
        this.setStatus({ state: "ready", detail: this.options.serverUrl });
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
        // The JVM may have died between requests; restart once and retry.
        if (attempt === 0 && err instanceof VnuConnectionError && err.code !== "ETIMEDOUT" && !service.running) {
          this.deps.logger.warn(`Nu Html Checker service connection failed (${err.message}); restarting`);
          if (this.service === service) this.service = undefined;
          continue;
        }
        throw err;
      }
    }
  }

  private async recheckBuffered(
    uri: string,
    text: string,
    kind: VnuInputKind,
    signal: AbortSignal,
    streamed: VnuResponse,
  ): Promise<VnuResponse> {
    const java = this.java;
    if (this.options.mode !== "local" || !java) return streamed;
    this.deps.logger.verbose(`Streaming parser gave up on ${uri}; re-checking in buffered mode`);
    try {
      return await this.cliLimit.run(
        () =>
          runVnuCli(text, {
            javaExecutable: java.executable,
            jarPath: this.options.jarPath,
            kind,
            signal,
            timeoutMs: Math.max(this.options.timeoutMs, 30_000),
          }),
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
    if (!this.starting) {
      this.starting = this.startService().finally(() => {
        this.starting = undefined;
      });
    }
    // Callers wait for the shared start-up but can individually cancel the wait.
    return new Promise<VnuService>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      this.starting!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
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
        throw new EngineUnavailableError(
          `${detail}. HTML/CSS validation needs Java ${MIN_JAVA_MAJOR} or newer; set webValidator.java.home or JAVA_HOME.`,
        );
      }
      this.java = lookup.runtime;
      this.deps.logger.info(
        `Using Java ${lookup.runtime.major} from ${lookup.runtime.origin}: ${lookup.runtime.executable}`,
      );
    }

    const service = new VnuService({
      javaExecutable: this.java.executable,
      jarPath: this.options.jarPath,
      logger: this.deps.logger,
    });
    try {
      await service.start();
    } catch (err) {
      this.crashes++;
      this.setStatus({ state: "error", detail: "Nu Html Checker failed to start" });
      throw err;
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

  async dispose(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    await service?.stop();
    this.statusEmitter.dispose();
  }
}
