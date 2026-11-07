/**
 * Fetches a rendered page (e.g. from a local dev server) for validation.
 */
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { abortError } from "../engines/Engine";

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** localhost, 127.x.x.x, [::1] and *.localhost. */
export function isLocalUrl(url: URL): boolean {
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(h) || h === "::1";
}

export function fetchPage(rawUrl: string, opts: FetchOptions = {}, redirects = 3): Promise<FetchedPage> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return Promise.reject(new Error(`Only http and https URLs are supported: ${rawUrl}`));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (err: Error) => {
      finish(() => reject(err));
      req.destroy();
    };
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "w3c-validator-plus (VS Code extension)", Accept: "text/html,*/*" } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        const next = new URL(location, url);
        // Follow redirects only on the same host, so a local page cannot send us elsewhere.
        if (next.host !== url.host) return fail(new Error(`Redirect to another host was not followed: ${next.href}`));
        finish(() => fetchPage(next.href, opts, redirects - 1).then(resolve, reject));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) return fail(new Error(`Page is larger than ${Math.round(maxBytes / 1024)} KB`));
        chunks.push(c);
      });
      res.on("end", () =>
        finish(() => resolve({ url: url.href, status, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") })),
      );
      res.on("error", fail);
    });
    const timer = setTimeout(() => fail(new Error(`No answer from ${url.host} within ${timeoutMs} ms`)), timeoutMs);
    opts.signal?.addEventListener("abort", () => fail(abortError()), { once: true });
    req.on("error", fail);
  });
}

/**
 * URL of a JSP in the running application: `<baseUrl>/<path relative to webRoot>`.
 * Files under WEB-INF cannot be requested directly.
 */
export function renderedUrlFor(fileFsPath: string, webRootFsPath: string, baseUrl: string): { url: string } | { error: string } {
  if (!baseUrl) return { error: "Set webValidator.jsp.renderedBaseUrl to the URL of your running application (e.g. http://localhost:8080/app)." };
  const rel = path.relative(webRootFsPath, fileFsPath).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: `This file is not inside the web root ${webRootFsPath} (webValidator.jsp.webRoot).` };
  if (/^web-inf\//i.test(rel)) return { error: "Files under WEB-INF are not served directly; validate a page that includes this file instead." };
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return { url: new URL(rel.split("/").map(encodeURIComponent).join("/"), base).href };
}
