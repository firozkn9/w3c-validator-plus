/**
 * Sets `"rules": { "<id>": <value> }` in .webvalidator.json text with a
 * minimal text edit, so comments and formatting are kept.
 */
import { parseJsonc } from "./jsonc";

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/** Scans an object starting at `open` (the `{`), returning its members and closing index. */
function scanObject(text: string, open: number): { members: Member[]; close: number } {
  const members: Member[] = [];
  let i = open + 1;
  const skip = () => {
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
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      i++;
      return;
    }
    if (c === "{" || c === "[") {
      let depth = 0;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
          for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
        } else if (text.startsWith("//", i)) {
          i = text.indexOf("\n", i);
          if (i < 0) i = text.length;
        } else if (text.startsWith("/*", i)) {
          i = text.indexOf("*/", i + 2) + 1;
        } else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) {
            i++;
            return;
          }
        }
      }
      return;
    }
    while (i < text.length && !/[\s,}\]/]/.test(text[i]!)) i++;
  };
  for (;;) {
    skip();
    if (i >= text.length || text[i] === "}") return { members, close: i };
    const keyStart = i;
    skipValue(); // the key string
    const key = JSON.parse(text.slice(keyStart, i)) as string;
    skip();
    i++; // ':'
    skip();
    const valueStart = i;
    skipValue();
    members.push({ key, keyStart, valueStart, valueEnd: i });
  }
}

export interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

/** Returns the edit that sets the rule, or a whole new file when `text` is empty. */
export function setRuleInConfigText(text: string, ruleId: string, value: string): TextReplacement {
  const valueJson = JSON.stringify(value);
  const idJson = JSON.stringify(ruleId);
  if (!text.trim()) {
    const content = `{\n  "rules": {\n    ${idJson}: ${valueJson}\n  }\n}\n`;
    return { start: 0, end: text.length, text: content };
  }
  parseJsonc(text); // throws a readable error for broken files
  const open = text.indexOf("{");
  if (open < 0) throw new Error("The configuration file must contain a JSON object");
  const root = scanObject(text, open);
  const rules = root.members.find((m) => m.key === "rules");
  if (!rules) {
    const sep = root.members.length ? "," : "";
    return { start: open + 1, end: open + 1, text: `\n  "rules": {\n    ${idJson}: ${valueJson}\n  }${sep}` };
  }
  if (text[rules.valueStart] !== "{") throw new Error('"rules" must be an object');
  const inner = scanObject(text, rules.valueStart);
  const existing = inner.members.find((m) => m.key === ruleId);
  if (existing) return { start: existing.valueStart, end: existing.valueEnd, text: valueJson };
  const sep = inner.members.length ? "," : "";
  return { start: rules.valueStart + 1, end: rules.valueStart + 1, text: `\n    ${idJson}: ${valueJson}${sep}` };
}

/** Adds `dir` to the top-level "rulesDirectories" array (creating it if needed). */
export function addRulesDirectoryText(text: string, dir: string): TextReplacement | undefined {
  if (!text.trim()) return { start: 0, end: text.length, text: `{\n  "rulesDirectories": [${JSON.stringify(dir)}]\n}\n` };
  const raw = parseJsonc(text) as { rulesDirectories?: unknown };
  const open = text.indexOf("{");
  const root = scanObject(text, open);
  const member = root.members.find((m) => m.key === "rulesDirectories");
  if (!member) {
    const sep = root.members.length ? "," : "";
    return { start: open + 1, end: open + 1, text: `\n  "rulesDirectories": [${JSON.stringify(dir)}]${sep}` };
  }
  const current = Array.isArray(raw.rulesDirectories) ? (raw.rulesDirectories as unknown[]) : [];
  if (current.includes(dir)) return undefined;
  return { start: member.valueStart, end: member.valueEnd, text: JSON.stringify([...current, dir]) };
}

export function applyReplacement(text: string, r: TextReplacement): string {
  return text.slice(0, r.start) + r.text + text.slice(r.end);
}
