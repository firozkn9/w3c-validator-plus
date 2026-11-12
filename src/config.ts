// The configuration model: .webvalidator.json files and the matching VS Code
// settings, normalized and merged. Also JSONC parsing and comment-preserving
// edits of the config file. No vscode import.
import * as path from "node:path";
import { RULE_ERROR_RULE, type Finding, type Severity, type ValidationContext } from "./core";
import { DEFAULT_JSP_OPTIONS, type JspDocumentStructure } from "./jsp";
import { parseSelector } from "./selector";

export const CONFIG_FILE_NAME = ".webvalidator.json";

export type RuleSeverity = Severity | "off";
// As users write it: "warning", or ["warning", { ...options }]. ESLint-style values work too.
export type RuleSettingInput = RuleSeverity | "warn" | 0 | 1 | 2 | [RuleSeverity | "warn" | 0 | 1 | 2, ...unknown[]];

export interface RuleSetting {
  severity: RuleSeverity;
  options: unknown[];
}

// A rule declared in JSON: a CSS selector or a regular expression, no code.
export interface JsonRuleDefinition {
  id: string;
  message: string;
  severity: Severity;
  languages: string[];
  pattern?: string;
  flags?: string;
  selector?: string;
  docsUrl?: string;
}

type ExcludePattern = { baseDir: string; glob: string };

// One config source (a file, or the VS Code settings) after validation.
export interface ConfigLayer {
  source: string;
  extends?: string[];
  rules?: Record<string, RuleSetting>;
  rulesDirectories?: string[]; // absolute
  customTagPrefixes?: string[];
  documentStructure?: JspDocumentStructure;
  ignoreMessages?: string[];
  exclude?: ExcludePattern[];
  customRules?: JsonRuleDefinition[];
}

export interface ResolvedConfig {
  rules: ReadonlyMap<string, RuleSetting>;
  wildcardRules: ReadonlyArray<{ id: string; pattern: RegExp; setting: RuleSetting }>; // most specific first
  rulesDirectories: string[];
  customTagPrefixes: string[];
  documentStructure?: JspDocumentStructure;
  ignoreMessages: RegExp[];
  exclude: ExcludePattern[];
  customRules: JsonRuleDefinition[];
  sources: string[];
  errors: string[];
}

// Presets for "extends". "recommended" is simply the built-in defaults.
export const PRESETS: Readonly<Record<string, Readonly<Record<string, RuleSettingInput>>>> = {
  recommended: {},
  strict: {
    "eslint:no-unused-vars": "warning",
    "eslint:eqeqeq": "warning",
    "eslint:no-var": "warning",
    "webvalidator/no-inline-styles": "warning",
    "webvalidator/require-button-type": "warning",
  },
};

const SEVERITIES = new Set(["off", "info", "warning", "error"]);
const KNOWN_KEYS = new Set(["$schema", "extends", "rules", "rulesDirectories", "jsp", "ignoreMessages", "exclude", "customRules"]);

function toSeverity(value: unknown): RuleSeverity | undefined {
  if (value === 0) return "off";
  if (value === 1 || value === "warn") return "warning";
  if (value === 2) return "error";
  return typeof value === "string" && SEVERITIES.has(value) ? (value as RuleSeverity) : undefined;
}

export function normalizeRuleSetting(value: unknown): RuleSetting | undefined {
  if (Array.isArray(value)) {
    const severity = toSeverity(value[0]);
    return severity ? { severity, options: value.slice(1) } : undefined;
  }
  const severity = toSeverity(value);
  return severity ? { severity, options: [] } : undefined;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// `baseDir` is what relative paths and globs in this layer resolve against.
export function normalizeLayer(raw: unknown, source: string, baseDir: string | undefined): { layer: ConfigLayer; errors: string[] } {
  const errors: string[] = [];
  const layer: ConfigLayer = { source };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { layer, errors: [`${source}: the configuration must be a JSON object`] };
  }
  const r = raw as Record<string, unknown>;
  const err = (key: string, msg: string) => errors.push(`${source}: "${key}" ${msg}`);

  if (r.extends !== undefined) {
    const ext = typeof r.extends === "string" ? [r.extends] : r.extends;
    if (!isStringArray(ext)) err("extends", "must be a string or an array of strings");
    else {
      for (const p of ext) if (!(p in PRESETS)) err("extends", `has unknown preset "${p}" (known: ${Object.keys(PRESETS).join(", ")})`);
      layer.extends = ext.filter((p) => p in PRESETS);
    }
  }

  if (r.rules !== undefined) {
    if (!r.rules || typeof r.rules !== "object" || Array.isArray(r.rules)) err("rules", "must be an object");
    else {
      layer.rules = {};
      for (const [id, value] of Object.entries(r.rules as Record<string, unknown>)) {
        const setting = normalizeRuleSetting(value);
        if (setting) layer.rules[id] = setting;
        else err(`rules.${id}`, 'must be "off", "info", "warning", "error" or [severity, options]');
      }
    }
  }

  const strings = (key: string): string[] | undefined => {
    const v = r[key];
    if (v === undefined) return undefined;
    if (isStringArray(v)) return v;
    err(key, "must be an array of strings");
    return undefined;
  };

  const dirs = strings("rulesDirectories");
  if (dirs) {
    layer.rulesDirectories = dirs.map((d) => (baseDir ? path.resolve(baseDir, d) : d)).filter((d) => {
      if (path.isAbsolute(d)) return true;
      err("rulesDirectories", `entry "${d}" is relative but there is no workspace folder`);
      return false;
    });
  }

  if (r.jsp !== undefined) {
    if (!r.jsp || typeof r.jsp !== "object") err("jsp", "must be an object");
    else {
      const jsp = r.jsp as Record<string, unknown>;
      if (jsp.customTagPrefixes !== undefined) {
        if (isStringArray(jsp.customTagPrefixes)) layer.customTagPrefixes = jsp.customTagPrefixes;
        else err("jsp.customTagPrefixes", "must be an array of strings");
      }
      if (jsp.documentStructure !== undefined) {
        if (jsp.documentStructure === "ignore" || jsp.documentStructure === "validate") layer.documentStructure = jsp.documentStructure;
        else err("jsp.documentStructure", 'must be "ignore" or "validate"');
      }
    }
  }

  const ignore = strings("ignoreMessages");
  if (ignore) {
    layer.ignoreMessages = ignore.filter((p) => {
      try {
        new RegExp(p);
        return true;
      } catch (e) {
        err("ignoreMessages", `has an invalid regular expression "${p}": ${(e as Error).message}`);
        return false;
      }
    });
  }

  const exclude = strings("exclude");
  if (exclude) {
    if (!baseDir) err("exclude", "needs a workspace folder");
    else layer.exclude = exclude.map((glob) => ({ baseDir, glob }));
  }

  if (r.customRules !== undefined) {
    if (!Array.isArray(r.customRules)) err("customRules", "must be an array");
    else layer.customRules = parseCustomRules(r.customRules, err);
  }

  for (const key of Object.keys(r)) if (!KNOWN_KEYS.has(key)) err(key, "is not a known setting");
  return { layer, errors };
}

function parseCustomRules(list: unknown[], err: (key: string, msg: string) => void): JsonRuleDefinition[] {
  const out: JsonRuleDefinition[] = [];
  list.forEach((def, i) => {
    const key = `customRules[${i}]`;
    if (!def || typeof def !== "object") return err(key, "must be an object");
    const d = def as Record<string, unknown>;
    if (typeof d.id !== "string" || !d.id) return err(key, 'needs an "id"');
    if (typeof d.message !== "string" || !d.message) return err(key, 'needs a "message"');
    if ((d.pattern === undefined) === (d.selector === undefined)) return err(key, 'needs exactly one of "pattern" or "selector"');
    const severity = toSeverity(d.severity ?? "warning");
    if (!severity || severity === "off") return err(`${key}.severity`, 'must be "info", "warning" or "error"');
    if (d.pattern !== undefined) {
      if (typeof d.pattern !== "string") return err(`${key}.pattern`, "must be a string");
      try {
        new RegExp(d.pattern, typeof d.flags === "string" ? d.flags.replace(/g/g, "") : "");
      } catch (e) {
        return err(`${key}.pattern`, `is not a valid regular expression: ${(e as Error).message}`);
      }
    }
    if (d.selector !== undefined) {
      if (typeof d.selector !== "string") return err(`${key}.selector`, "must be a string");
      try {
        parseSelector(d.selector);
      } catch (e) {
        return err(`${key}.selector`, (e as Error).message);
      }
    }
    const languages = d.languages === undefined ? ["html", "jsp"] : d.languages;
    if (!isStringArray(languages)) return err(`${key}.languages`, "must be an array of strings");
    out.push({
      id: d.id,
      message: d.message,
      severity,
      languages,
      ...(typeof d.pattern === "string" ? { pattern: d.pattern } : {}),
      ...(typeof d.flags === "string" ? { flags: d.flags } : {}),
      ...(typeof d.selector === "string" ? { selector: d.selector } : {}),
      ...(typeof d.docsUrl === "string" ? { docsUrl: d.docsUrl } : {}),
    });
  });
  return out;
}

// "vnu:css-*" -> /^vnu:css-.*$/
export function wildcardToRegExp(id: string): RegExp {
  return new RegExp(`^${id.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
}

// Later layers win.
export function resolveConfig(layers: readonly ConfigLayer[], errors: readonly string[] = []): ResolvedConfig {
  const extendsList = layers.flatMap((l) => l.extends ?? []);
  const rules = new Map<string, RuleSetting>();
  for (const name of extendsList.length ? extendsList : ["recommended"]) {
    for (const [id, value] of Object.entries(PRESETS[name] ?? {})) {
      const s = normalizeRuleSetting(value);
      if (s) rules.set(id, s);
    }
  }
  const config: ResolvedConfig = {
    rules,
    wildcardRules: [],
    rulesDirectories: [],
    customTagPrefixes: [],
    ignoreMessages: [],
    exclude: [],
    customRules: [],
    sources: layers.map((l) => l.source),
    errors: [...errors],
  };
  const customById = new Map<string, JsonRuleDefinition>();
  for (const l of layers) {
    for (const [id, s] of Object.entries(l.rules ?? {})) rules.set(id, s);
    for (const d of l.rulesDirectories ?? []) if (!config.rulesDirectories.includes(d)) config.rulesDirectories.push(d);
    for (const p of l.customTagPrefixes ?? []) if (!config.customTagPrefixes.includes(p)) config.customTagPrefixes.push(p);
    if (l.documentStructure) config.documentStructure = l.documentStructure;
    for (const p of l.ignoreMessages ?? []) config.ignoreMessages.push(new RegExp(p));
    config.exclude.push(...(l.exclude ?? []));
    for (const r of l.customRules ?? []) customById.set(r.id, r);
  }
  config.customRules = [...customById.values()];

  const wildcards: Array<{ id: string; pattern: RegExp; setting: RuleSetting }> = [];
  for (const [id, setting] of rules) {
    if (!id.includes("*")) continue;
    wildcards.push({ id, pattern: wildcardToRegExp(id), setting });
    rules.delete(id);
  }
  // The longest literal part is the most specific.
  wildcards.sort((a, b) => b.id.replace(/\*/g, "").length - a.id.replace(/\*/g, "").length);
  config.wildcardRules = wildcards;
  return config;
}

export function ruleSettingFor(config: ResolvedConfig, ruleId: string): RuleSetting | undefined {
  return config.rules.get(ruleId) ?? config.wildcardRules.find((w) => w.pattern.test(ruleId))?.setting;
}

export const EMPTY_CONFIG: ResolvedConfig = resolveConfig([]);

export function defaultContext(): ValidationContext {
  return { config: EMPTY_CONFIG, jsp: DEFAULT_JSP_OPTIONS, ecmaVersion: "latest", trusted: false };
}

// Severity overrides, "off" and ignoreMessages. A crashed custom rule is
// always shown, even when a wildcard turns everything off.
export function applyRuleConfig(findings: readonly Finding[], config: ResolvedConfig): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    if (f.ruleId === RULE_ERROR_RULE) {
      out.push(f);
      continue;
    }
    const setting = ruleSettingFor(config, f.ruleId);
    if (setting?.severity === "off") continue;
    if (config.ignoreMessages.some((re) => re.test(f.message))) continue;
    out.push(setting && setting.severity !== f.severity ? { ...f, severity: setting.severity } : f);
  }
  return out;
}

// --- exclude globs: **, *, ?, {a,b}, [abc] ---

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" is zero or more folders, a trailing "**" is anything
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      const alternatives = glob.slice(i + 1, end).split(",").map((alt) => globToRegExp(alt).source.slice(1, -1));
      re += `(?:${alternatives.join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      re += `[${glob.slice(i + 1, end).replace(/^!/, "^")}]`;
      i = end;
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

export function isExcluded(fsPath: string, patterns: readonly ExcludePattern[]): boolean {
  for (const { baseDir, glob } of patterns) {
    const rel = path.relative(baseDir, fsPath).split(path.sep).join("/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (globToRegExp(glob.replace(/^\.\//, "")).test(rel)) return true;
  }
  return false;
}

// --- JSONC: comments and trailing commas are blanked in place so error offsets stay right ---

export class JsoncError extends Error {
  override name = "JsoncError";

  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

function stripJsonc(text: string): string {
  const out = text.split("");
  const blank = (s: number, e: number) => {
    for (let k = s; k < e; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let lastComma = -1; // a comma that may turn out to be trailing
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      lastComma = -1;
    } else if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      const end = e < 0 ? text.length : e;
      blank(i, end);
      i = end - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? text.length : e + 2;
      blank(i, end);
      i = end - 1;
    } else if (c === ",") {
      lastComma = i;
    } else if (c === "}" || c === "]") {
      if (lastComma >= 0) out[lastComma] = " ";
      lastComma = -1;
    } else if (c !== undefined && !/\s/.test(c)) {
      lastComma = -1;
    }
  }
  return out.join("");
}

export function parseJsonc(text: string): unknown {
  const stripped = stripJsonc(text);
  if (!stripped.trim()) return {};
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const m = /position (\d+)/.exec(message);
    const before = m ? text.slice(0, Number(m[1])) : "";
    const line = m ? before.split("\n").length - 1 : 0;
    const column = m ? before.length - (before.lastIndexOf("\n") + 1) : 0;
    throw new JsoncError(`Invalid JSON at line ${line + 1}, column ${column + 1}: ${message}`, line, column);
  }
}

// --- minimal text edits to .webvalidator.json that keep comments and formatting ---

export interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

interface Member {
  key: string;
  valueStart: number;
  valueEnd: number;
}

// Members of the object whose "{" is at `open`.
function scanObject(text: string, open: number): Member[] {
  const members: Member[] = [];
  let i = open + 1;
  const skipString = () => {
    for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
  };
  const skipBlank = () => {
    for (;;) {
      while (i < text.length && /\s|,/.test(text[i]!)) i++;
      if (text.startsWith("//", i)) {
        const e = text.indexOf("\n", i);
        i = e < 0 ? text.length : e + 1;
      } else if (text.startsWith("/*", i)) {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? text.length : e + 2;
      } else return;
    }
  };
  const skipValue = () => {
    const c = text[i];
    if (c === '"') {
      skipString();
      i++;
      return;
    }
    if (c === "{" || c === "[") {
      let depth = 0;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') skipString();
        else if (text.startsWith("//", i)) {
          i = text.indexOf("\n", i);
          if (i < 0) i = text.length;
        } else if (text.startsWith("/*", i)) {
          i = text.indexOf("*/", i + 2) + 1;
        } else if (ch === "{" || ch === "[") depth++;
        else if ((ch === "}" || ch === "]") && --depth === 0) {
          i++;
          return;
        }
      }
      return;
    }
    while (i < text.length && !/[\s,}\]/]/.test(text[i]!)) i++;
  };
  for (;;) {
    skipBlank();
    if (i >= text.length || text[i] === "}") return members;
    const keyStart = i;
    skipValue();
    const key = JSON.parse(text.slice(keyStart, i)) as string;
    skipBlank();
    i++; // ':'
    skipBlank();
    const valueStart = i;
    skipValue();
    members.push({ key, valueStart, valueEnd: i });
  }
}

// The edit that sets "rules": { "<id>": <value> }, or a whole new file when `text` is empty.
export function setRuleInConfigText(text: string, ruleId: string, value: string): TextReplacement {
  const entry = `${JSON.stringify(ruleId)}: ${JSON.stringify(value)}`;
  if (!text.trim()) return { start: 0, end: text.length, text: `{\n  "rules": {\n    ${entry}\n  }\n}\n` };
  parseJsonc(text); // throws a readable error for a broken file
  const open = text.indexOf("{");
  if (open < 0) throw new Error("The configuration file must contain a JSON object");
  const root = scanObject(text, open);
  const rules = root.find((m) => m.key === "rules");
  if (!rules) {
    const sep = root.length ? "," : "";
    return { start: open + 1, end: open + 1, text: `\n  "rules": {\n    ${entry}\n  }${sep}` };
  }
  if (text[rules.valueStart] !== "{") throw new Error('"rules" must be an object');
  const inner = scanObject(text, rules.valueStart);
  const existing = inner.find((m) => m.key === ruleId);
  if (existing) return { start: existing.valueStart, end: existing.valueEnd, text: JSON.stringify(value) };
  const sep = inner.length ? "," : "";
  return { start: rules.valueStart + 1, end: rules.valueStart + 1, text: `\n    ${entry}${sep}` };
}

// Adds `dir` to "rulesDirectories". Returns undefined when it is already listed.
export function addRulesDirectoryText(text: string, dir: string): TextReplacement | undefined {
  const dirJson = JSON.stringify(dir);
  if (!text.trim()) return { start: 0, end: text.length, text: `{\n  "rulesDirectories": [${dirJson}]\n}\n` };
  const raw = parseJsonc(text) as { rulesDirectories?: unknown };
  const open = text.indexOf("{");
  const root = scanObject(text, open);
  const member = root.find((m) => m.key === "rulesDirectories");
  if (!member) {
    const sep = root.length ? "," : "";
    return { start: open + 1, end: open + 1, text: `\n  "rulesDirectories": [${dirJson}]${sep}` };
  }
  const current = Array.isArray(raw.rulesDirectories) ? (raw.rulesDirectories as unknown[]) : [];
  if (current.includes(dir)) return undefined;
  return { start: member.valueStart, end: member.valueEnd, text: JSON.stringify([...current, dir]) };
}

export function applyReplacement(text: string, r: TextReplacement): string {
  return text.slice(0, r.start) + r.text + text.slice(r.end);
}
