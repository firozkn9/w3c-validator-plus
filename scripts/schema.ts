// The JSON schema for .webvalidator.json (schemas/webvalidator.schema.json),
// with every known rule id listed for autocompletion. test/unit/schema.test.ts
// checks the file is current; run it with UPDATE_SCHEMA=1 to rewrite it.
import { PRESETS } from "../src/config";
import { ESLINT_DEFAULT_RULES, ESLINT_PREFIX, JQUERY_RULE_ID, SYNTAX_ERROR_RULE } from "../src/eslint";
import { BUILTIN_RULES } from "../src/rules";
import { VNU_RULE_IDS } from "../src/vnuMessages";

const SEVERITY_VALUES = ["off", "info", "warning", "error", "warn", 0, 1, 2];

export function buildConfigSchema(): Record<string, unknown> {
  const ruleSetting = { $ref: "#/definitions/ruleSetting" };
  const known: Record<string, unknown> = {};
  const add = (id: string, description: string) => {
    known[id] ??= { ...ruleSetting, description };
  };
  for (const id of VNU_RULE_IDS) add(id, "Nu Html Checker (HTML/CSS)");
  add(SYNTAX_ERROR_RULE, "JavaScript syntax errors");
  for (const name of Object.keys(ESLINT_DEFAULT_RULES)) add(ESLINT_PREFIX + name, `ESLint core rule ${name} (on by default)`);
  for (const name of ["no-unused-vars", "eqeqeq", "no-var", "no-undef", "no-implicit-globals", "no-eval", "prefer-const"]) {
    add(ESLINT_PREFIX + name, `ESLint core rule ${name} (off by default)`);
  }
  add(JQUERY_RULE_ID, "jQuery selectors that match the whole page instead of the current process/tab. Options: { allowContextArgument, functionNames }");
  for (const r of BUILTIN_RULES) add(r.id, r.meta?.description ?? r.id);

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Web Standards Validator configuration",
    type: "object",
    additionalProperties: false,
    definitions: {
      severity: { enum: ["off", "info", "warning", "error"] },
      ruleSetting: {
        description: 'Severity, or [severity, options]. Also accepts ESLint-style "warn", 0, 1, 2.',
        anyOf: [{ enum: SEVERITY_VALUES }, { type: "array", items: [{ enum: SEVERITY_VALUES }], minItems: 1 }],
      },
    },
    properties: {
      $schema: { type: "string" },
      extends: {
        description: "Presets to start from. Default: recommended.",
        anyOf: [{ enum: Object.keys(PRESETS) }, { type: "array", items: { enum: Object.keys(PRESETS) } }],
      },
      rules: {
        description: 'Rule severities by id. Wildcards are allowed, e.g. "vnu:css-*": "off". ESLint core rules use "eslint:<name>".',
        type: "object",
        properties: known,
        additionalProperties: ruleSetting,
      },
      rulesDirectories: {
        description: "Folders with custom rule files (.js, .cjs, .mjs), relative to this file. Loaded only in trusted workspaces.",
        type: "array",
        items: { type: "string" },
      },
      jsp: {
        type: "object",
        additionalProperties: false,
        properties: {
          customTagPrefixes: { description: "Extra custom tag prefixes, in addition to taglib prefixes and settings.", type: "array", items: { type: "string" } },
          documentStructure: { description: "Skip (ignore) or check (validate) <!DOCTYPE>, <html>, <head>, <body> in JSP files.", enum: ["ignore", "validate"] },
        },
      },
      ignoreMessages: { description: "Regular expressions; matching messages from any engine are hidden.", type: "array", items: { type: "string" } },
      exclude: { description: "Glob patterns (relative to this file) of files not to validate.", type: "array", items: { type: "string" } },
      customRules: {
        description: "Rules declared without code: a CSS selector or a regular expression.",
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "message"],
          properties: {
            id: { type: "string", description: "Unique id, e.g. custom/img-needs-alt" },
            message: { type: "string" },
            severity: { enum: ["info", "warning", "error"], default: "warning" },
            languages: { type: "array", items: { enum: ["html", "jsp", "javascript"] }, default: ["html", "jsp"] },
            selector: { type: "string", description: 'CSS selector matched against elements, e.g. "img:not([alt])"' },
            pattern: { type: "string", description: "Regular expression matched against the file text (trusted workspaces only)" },
            flags: { type: "string", description: 'Regular expression flags, e.g. "i"' },
            docsUrl: { type: "string" },
          },
          oneOf: [{ required: ["selector"] }, { required: ["pattern"] }],
        },
      },
    },
  };
}
