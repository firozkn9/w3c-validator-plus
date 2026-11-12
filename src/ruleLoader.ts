// Loads custom rule code from rulesDirectories and from webvalidator-rules-*
// packages in the workspace package.json. This runs the files, so it is only
// used in trusted workspaces. Also the files "Create Custom Rule" writes.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuleLanguage, RuleModule } from "./rules";

export interface LoadedRule {
  rule: RuleModule;
  origin: string;
}

export interface LoadResult {
  rules: LoadedRule[];
  errors: string[];
  files: string[];
}

const LANGUAGES = new Set<RuleLanguage>(["html", "jsp", "javascript"]);
const RULE_FILE = /\.(c?js|mjs)$/i;
const PACK_NAME = /^(@[^/]+\/)?webvalidator-rules-[\w.-]+$/;

const nodeRequire = createRequire(__filename);
// A real import() for .mjs files; the bundler would rewrite a plain one.
const importModule = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, unknown>>;

function validateRule(value: unknown, origin: string): RuleModule {
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

// module.exports = rule, = [rules], = { rules: [...] }, or an ES default export.
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
      // In a VM sandbox (the unit-test runner) Function-made code has no import
      // hook, but this module's own import() works.
      if (!String((err as Error).message).includes("dynamic import callback")) throw err;
      return import(/* @vite-ignore */ url);
    }
  }
  // skip Node's module cache so edits are picked up
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

// Loaded rules per (directories, workspace root), until invalidate().
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

  // Directories asked for so far, to tell which file changes matter.
  directories(): string[] {
    const dirs = new Set<string>();
    for (const key of this.cache.keys()) for (const d of (JSON.parse(key) as [string[], string])[0]) dirs.add(d);
    return [...dirs];
  }
}

// --- "Create Custom Rule" ---

export const RULE_ID_PATTERN = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i;

export function ruleFileName(ruleId: string): string {
  return `${ruleId.split("/").pop()!.replace(/[^\w.-]/g, "-")}.js`;
}

export function ruleTemplate(ruleId: string, languages: RuleLanguage[]): string {
  const html = languages.includes("html") || languages.includes("jsp");
  const js = languages.includes("javascript");
  return `// @ts-check
// Custom rule for the Web Standards Validator extension.
// Rules in this folder run only in trusted workspaces. Save the file to reload it.
// Turn the rule off or change its severity in .webvalidator.json:
//   "rules": { "${ruleId}": "error" }          or  ["warning", { ...options }]
// Suppress it on one line with a comment:
//   <!-- webvalidator-disable-next-line ${ruleId} -->

/** @param {import("./webvalidator").RuleModule} rule */
const defineRule = (rule) => rule;

module.exports = defineRule({
  id: ${JSON.stringify(ruleId)},
  languages: ${JSON.stringify(languages)},
  meta: {
    description: "Describe what this rule checks",
    defaultSeverity: "warning", // "error" | "warning" | "info" | "off"
    // docsUrl: "https://wiki.example.com/web-rules#my-rule",
  },

  create(ctx) {
    // ctx.text      original document text      ctx.options  options from the config
    // ctx.language  "html" | "jsp" | "javascript"
    // ctx.querySelectorAll("img:not([alt])")   CSS selector over the document's elements
    // ctx.report({ node | range | loc | offset+length, message, attribute?, fix?, suggestions? })
    return {
${
  html
    ? `      // Called for every element written in the page (JSP tags and EL are already masked).
      element(el) {
        // el.tagName, el.attrs (lower-case names), el.parent, el.children, el.textContent,
        // el.startTag / el.endTag / el.range, el.attrRanges[name]
        if (el.tagName === "a" && el.attrs.target === "_blank" && !/\\bnoopener\\b/.test(el.attrs.rel ?? "")) {
          ctx.report({
            node: el,
            attribute: "target",
            message: 'Add rel="noopener" to links that open a new tab',
          });
        }
      },
`
    : ""
}${
  js
    ? `
      // Called for every inline <script> and for whole .js files.
      script(script) {
        // script.code, script.range, script.ast (ESTree Program; undefined on syntax errors)
        // AST nodes have .loc with 1-based lines: ctx.report({ loc: node.loc, message })
        if (/\\bconsole\\.log\\(/.test(script.code)) {
          const offset = ctx.offsetAt(script.range.start) + script.code.indexOf("console.log(");
          ctx.report({ offset, length: "console.log".length, message: "Remove console.log before release" });
        }
      },
`
    : ""
}    };
  },
});
`;
}

// Written next to the rules so plain JavaScript gets IntelliSense.
export const RULE_TYPES_DTS = `// Types for Web Standards Validator custom rules (generated; safe to overwrite).
export type Severity = "error" | "warning" | "info";
export type RuleLanguage = "html" | "jsp" | "javascript";
export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface TextEdit { range: Range; newText: string }
export interface Fix { title: string; edits: TextEdit[] }

export interface RuleElement {
  tagName: string;
  attrs: Readonly<Record<string, string>>;
  parent?: RuleElement;
  children: RuleElement[];
  hasText: boolean;
  textContent: string;
  startTag: Range;
  endTag?: Range;
  range: Range;
  attrRanges: Readonly<Record<string, Range>>;
}
export interface RuleTextNode { value: string; range: Range; parent?: RuleElement }
export interface RuleComment { value: string; range: Range }
export interface RuleScript { code: string; range: Range; module: boolean; ast?: any }

export interface ReportDescriptor {
  message: string;
  node?: RuleElement | RuleTextNode | RuleComment;
  attribute?: string;
  range?: Range;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  offset?: number;
  length?: number;
  severity?: Severity;
  fix?: Fix;
  suggestions?: Fix[];
}

export interface RuleContext {
  readonly uri: string;
  readonly fileName: string;
  readonly language: RuleLanguage;
  readonly text: string;
  readonly options: readonly unknown[];
  readonly elements: readonly RuleElement[];
  querySelectorAll(selector: string): RuleElement[];
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
  report(descriptor: ReportDescriptor): void;
}

export interface RuleVisitors {
  element?(element: RuleElement): void;
  text?(node: RuleTextNode): void;
  comment?(node: RuleComment): void;
  script?(script: RuleScript): void;
  end?(): void;
}

export interface RuleModule {
  id: string;
  languages?: RuleLanguage[];
  meta?: { description: string; defaultSeverity?: Severity | "off"; docsUrl?: string };
  create(context: RuleContext): RuleVisitors | void;
}
`;
