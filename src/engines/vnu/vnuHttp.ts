import * as http from "node:http";
import * as https from "node:https";
import { abortError } from "../Engine";
import { parseVnuResponse, type VnuResponse } from "./vnuMessages";

export type VnuInputKind = "html" | "css";

const USER_AGENT = "w3c-validator-plus (VS Code extension)";

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export class VnuConnectionError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "VnuConnectionError";
  }
}

function request(
  url: URL,
  method: "GET" | "POST",
  body: string | undefined,
  headers: Record<string, string>,
  opts: RequestOptions,
): Promise<{ status: number; body: string }> {
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

    // vnu answers HTTP 400 to requests without a User-Agent header.
    const req = lib.request(url, { method, headers: { "User-Agent": USER_AGENT, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })),
      );
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

/** POSTs a document to a vnu HTTP service (`nu.validator.servlet.Main` or a self-hosted checker). */
export async function postToVnu(
  baseUrl: string,
  text: string,
  kind: VnuInputKind,
  opts: RequestOptions,
): Promise<VnuResponse> {
  const url = new URL(baseUrl);
  url.searchParams.set("out", "json");
  const contentType = kind === "css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
  const res = await request(
    url,
    "POST",
    text,
    { "Content-Type": contentType, "Content-Length": String(Buffer.byteLength(text, "utf8")) },
    opts,
  );
  if (res.status !== 200) {
    throw new VnuConnectionError(`Nu Html Checker answered HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  return parseVnuResponse(res.body);
}

/** True when the service answers a GET with HTTP 200. */
export async function isVnuReachable(baseUrl: string, opts: RequestOptions): Promise<boolean> {
  try {
    const res = await request(new URL(baseUrl), "GET", undefined, {}, opts);
    return res.status === 200;
  } catch {
    return false;
  }
}
