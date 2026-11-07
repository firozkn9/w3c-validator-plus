/**
 * Loads custom rule code: files in `rulesDirectories` and npm packages named
 * `webvalidator-rules-*` (or `@scope/webvalidator-rules-*`) listed in the
 * workspace package.json. Only call this for trusted workspaces: it executes
 * the files.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuleLanguage, RuleModule } from "./RuleApi";

export interface LoadedRule {
  rule: RuleModule;
  origin: string;
}

export interface LoadResult {
  rules: LoadedRule[];
  errors: string[];
  /** Files that were loaded (for file watching). */
  files: string[];
}

const LANGUAGES = new Set<RuleLanguage>(["html", "jsp", "javascript"]);
const RULE_FILE = /\.(c?js|mjs)$/i;
const PACK_NAME = /^(@[^/]+\/)?webvalidator-rules-[\w.-]+$/;

const nodeRequire = createRequire(__filename);
/** Real dynamic import (not rewritten by the bundler) for .mjs files. */
const importModule = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, unknown>>;

/** Validates one exported rule object. */
export function validateRule(value: unknown, origin: string): RuleModule {
  if (!value || typeof value !== "object") throw new Error(`${origin}: a rule must be an object`);
  const r = value as Partial<RuleModule>;
  if (typeof r.id !== "string" || !r.id.trim()) throw new Error(`${origin}: a rule needs a string "id"`);
  if (typeof r.create !== "function") throw new Error(`${origin}: rule "${r.id}" needs a create(context) function`);
  if (r.languages !== undefined && (!Array.isArray(r.languages) || !r.languages.every((l) => LANGUAGES.has(l)))) {
    throw new Error(`${origin}: rule "${r.id}" has invalid languages (use "html", "jsp", "javascript")`);
  }
  if (r.meta !== undefined && (typeof r.meta !== "object" || r.meta === null)) throw new Error(`${origin}: rule "${r.id}" has an invalid meta`);
  const sev = r.meta?.defaultSeverity;
  if (sev !== undefined && !["off", "info", "warning", "error"].includes(sev)) {
    throw new Error(`${origin}: rule "${r.id}" has an invalid meta.defaultSeverity "${String(sev)}"`);
  }
  return r as RuleModule;
}

/** Accepts `module.exports = rule`, `= [rules]`, `= { rules: [...] }` and ES `default` exports. */
export function rulesFromExports(exported: unknown, origin: string): RuleModule[] {
  let value = exported as Record<string, unknown> | unknown[] | undefined;
  if (value && !Array.isArray(value) && "default" in value && value.default !== undefined && !("create" in value)) {
    value = value.default as typeof value;
  }
  if (value && !Array.isArray(value) && Array.isArray((value as { rules?: unknown }).rules)) value = (value as { rules: unknown[] }).rules;
  const list = Array.isArray(value) ? value : [value];
  return list.map((r, i) => validateRule(r, list.length > 1 ? `${origin}[${i}]` : origin));
}

async function loadFile(file: string): Promise<unknown> {
  if (/\.mjs$/i.test(file)) {
    const url = `${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`;
    try {
      return await importModule(url);
    } catch (err) {
      // Inside VM sandboxes (e.g. the unit-test runner) Function-created code has no
      // import hook; the module-level import() works there instead.
      if (!String((err as Error).message).includes("dynamic import callback")) throw err;
      return import(/* @vite-ignore */ url);
    }
  }
  // Re-read edited files instead of using Node's module cache.
  const resolved = nodeRequire.resolve(file);
  delete nodeRequire.cache[resolved];
  return nodeRequire(resolved);
}

export async function loadRulesFromDirectories(dirs: readonly string[]): Promise<LoadResult> {
  const result: LoadResult = { rules: [], errors: [], files: [] };
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).sort();
    } catch {
      result.errors.push(`Rules directory not found: ${dir}`);
      continue;
    }
    for (const name of entries) {
      const file = path.join(dir, name);
      if (/\.ts$/i.test(name) && !/\.d\.ts$/i.test(name)) {
        result.errors.push(`${file}: TypeScript rules must be compiled to .js first`);
        continue;
      }
      if (!RULE_FILE.test(name)) continue;
      result.files.push(file);
      try {
        for (const rule of rulesFromExports(await loadFile(file), file)) result.rules.push({ rule, origin: file });
      } catch (err) {
        result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}

/** Rule packs: dependencies named webvalidator-rules-* in `<root>/package.json`. */
export async function loadRulePacks(root: string): Promise<LoadResult> {
  const result: LoadResult = { rules: [], errors: [], files: [] };
  const pkgFile = path.join(root, "package.json");
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  } catch {
    return result;
  }
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter((n) => PACK_NAME.test(n));
  const req = createRequire(pkgFile);
  for (const name of [...new Set(names)]) {
    let entry: string;
    try {
      entry = req.resolve(name);
    } catch {
      result.errors.push(`Rule pack "${name}" is listed in package.json but not installed (run npm install)`);
      continue;
    }
    result.files.push(entry);
    try {
      for (const rule of rulesFromExports(await loadFile(entry), name)) result.rules.push({ rule, origin: name });
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/**
 * Caches loaded code rules per (directories, workspace root). Call
 * `invalidate()` when rule files change.
 */
export class RuleStore {
  private cache = new Map<string, Promise<LoadResult>>();

  get(dirs: readonly string[], packRoot: string | undefined): Promise<LoadResult> {
    const key = JSON.stringify([dirs, packRoot ?? ""]);
    let entry = this.cache.get(key);
    if (!entry) {
      entry = (async () => {
        const fromDirs = await loadRulesFromDirectories(dirs);
        const fromPacks = packRoot ? await loadRulePacks(packRoot) : { rules: [], errors: [], files: [] };
        return {
          rules: [...fromPacks.rules, ...fromDirs.rules],
          errors: [...fromPacks.errors, ...fromDirs.errors],
          files: [...fromPacks.files, ...fromDirs.files],
        };
      })();
      this.cache.set(key, entry);
    }
    return entry;
  }

  invalidate(): void {
    this.cache.clear();
  }

  /** Rules directories requested so far (to decide which file changes matter). */
  directories(): string[] {
    const dirs = new Set<string>();
    for (const key of this.cache.keys()) for (const d of (JSON.parse(key) as [string[], string])[0]) dirs.add(d);
    return [...dirs];
  }
}
