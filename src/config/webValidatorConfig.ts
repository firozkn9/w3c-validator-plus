/**
 * The validator configuration model: `.webvalidator.json` files and the
 * matching VS Code settings, normalized, merged and queried by rule id.
 * Pure logic (no `vscode` import).
 */
import * as path from "node:path";
import type { Severity } from "../engines/Engine";
import type { JspDocumentStructure } from "../preprocess/jspDocument";
import { parseSelector } from "../rules/selector";

export type RuleSeverity = Severity | "off";
/** As written by users: `"warning"`, or `["warning", { ...options }]`. */
export type RuleSettingInput = RuleSeverity | "warn" | 0 | 1 | 2 | [RuleSeverity | "warn" | 0 | 1 | 2, ...unknown[]];

export interface RuleSetting {
  severity: RuleSeverity;
  options: unknown[];
}

/** A rule declared purely in JSON (no code), matched by regex or CSS selector. */
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

/** One normalized configuration source (a file or the VS Code settings). */
export interface ConfigLayer {
  source: string;
  extends?: string[];
  rules?: Record<string, RuleSetting>;
  /** Absolute paths. */
  rulesDirectories?: string[];
  customTagPrefixes?: string[];
  documentStructure?: JspDocumentStructure;
  ignoreMessages?: string[];
  exclude?: Array<{ baseDir: string; glob: string }>;
  customRules?: JsonRuleDefinition[];
}

export interface ResolvedConfig {
  rules: ReadonlyMap<string, RuleSetting>;
  /** Wildcard rule ids (e.g. `vnu:css-*`), most specific first. */
  wildcardRules: ReadonlyArray<{ id: string; pattern: RegExp; setting: RuleSetting }>;
  rulesDirectories: string[];
  customTagPrefixes: string[];
  documentStructure?: JspDocumentStructure;
  ignoreMessages: RegExp[];
  exclude: Array<{ baseDir: string; glob: string }>;
  customRules: JsonRuleDefinition[];
  sources: string[];
  errors: string[];
}

export const CONFIG_FILE_NAME = ".webvalidator.json";

/** Presets usable in `"extends"`. `recommended` is the built-in default behaviour. */
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

/**
 * Validates and normalizes a raw config object.
 * @param baseDir folder that relative paths and globs are resolved against
 */
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

  const paths = (key: string): string[] | undefined => {
    const v = r[key];
    if (v === undefined) return undefined;
    if (!isStringArray(v)) {
      err(key, "must be an array of strings");
      return undefined;
    }
    return v;
  };

  const dirs = paths("rulesDirectories");
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

  const ignore = paths("ignoreMessages");
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

  const exclude = paths("exclude");
  if (exclude) {
    if (!baseDir) err("exclude", "needs a workspace folder");
    else layer.exclude = exclude.map((glob) => ({ baseDir, glob }));
  }

  if (r.customRules !== undefined) {
    if (!Array.isArray(r.customRules)) err("customRules", "must be an array");
    else {
      layer.customRules = [];
      (r.customRules as unknown[]).forEach((def, i) => {
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
        layer.customRules!.push({
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
    }
  }

  const known = new Set(["$schema", "extends", "rules", "rulesDirectories", "jsp", "ignoreMessages", "exclude", "customRules"]);
  for (const key of Object.keys(r)) if (!known.has(key)) err(key, "is not a known setting");
  return { layer, errors };
}

function wildcardToRegExp(id: string): RegExp {
  return new RegExp(`^${id.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
}

/** Merges layers from lowest to highest precedence (later layers win). */
export function resolveConfig(layers: readonly ConfigLayer[], errors: readonly string[] = []): ResolvedConfig {
  const extendsList = layers.flatMap((l) => l.extends ?? []);
  const presetNames = extendsList.length ? extendsList : ["recommended"];
  const rules = new Map<string, RuleSetting>();
  for (const name of presetNames) {
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
    if (id.includes("*")) {
      wildcards.push({ id, pattern: wildcardToRegExp(id), setting });
      rules.delete(id);
    }
  }
  // Most specific (longest literal part) first.
  wildcards.sort((a, b) => b.id.replace(/\*/g, "").length - a.id.replace(/\*/g, "").length);
  config.wildcardRules = wildcards;
  return config;
}

/** The configured setting for a rule id: exact match first, then the most specific wildcard. */
export function ruleSettingFor(config: ResolvedConfig, ruleId: string): RuleSetting | undefined {
  const exact = config.rules.get(ruleId);
  if (exact) return exact;
  return config.wildcardRules.find((w) => w.pattern.test(ruleId))?.setting;
}

export const EMPTY_CONFIG: ResolvedConfig = resolveConfig([]);
