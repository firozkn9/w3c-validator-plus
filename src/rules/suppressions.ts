/**
 * Inline suppression comments, recognised in any comment syntax:
 *
 *   <!-- webvalidator-disable-next-line vnu:img-missing-alt -->
 *   <%-- webvalidator-disable vnu:obsolete-element --%>      (until enable / end of file)
 *   <%-- webvalidator-enable vnu:obsolete-element --%>
 *   $(".x"); // webvalidator-disable-line webvalidator/jquery-unscoped-selector
 *   /* webvalidator-disable *\/                              (no ids: every rule)
 *
 * Several ids may be separated by commas or spaces; `*` wildcards work as in
 * the config (`vnu:css-*`). A reason may follow ` -- `.
 */
import type { Finding } from "../engines/Engine";

export type DirectiveKind = "disable" | "enable" | "disable-line" | "disable-next-line";

export interface Directive {
  kind: DirectiveKind;
  /** Zero-based line of the comment. */
  line: number;
  /** Empty: every rule. */
  ruleIds: string[];
}

const DIRECTIVE_RE =
  /(?:<!--|<%--|\/\/|\/\*)[ \t]*webvalidator-(disable-next-line|disable-line|disable|enable)(?=[\s,]|-->|--%>|\*\/|$)([^\r\n]*)/g;

export function parseDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, line) => {
    for (const m of lineText.matchAll(DIRECTIVE_RE)) {
      let rest = m[2] ?? "";
      const close = rest.search(/--%>|-->|\*\//);
      if (close >= 0) rest = rest.slice(0, close);
      rest = rest.split(/\s--\s/)[0] ?? ""; // drop the reason
      const ruleIds = rest
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      out.push({ kind: m[1] as DirectiveKind, line, ruleIds });
    }
  });
  return out;
}

function idMatches(pattern: string, ruleId: string): boolean {
  if (!pattern.includes("*")) return pattern === ruleId;
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
  return re.test(ruleId);
}

const covers = (ids: readonly string[], ruleId: string) => ids.length === 0 || ids.some((p) => idMatches(p, ruleId));

/** Returns a predicate telling whether a finding is suppressed by the directives. */
export function suppressionFilter(directives: readonly Directive[]): (f: Finding) => boolean {
  if (directives.length === 0) return () => false;
  const sorted = [...directives].sort((a, b) => a.line - b.line);
  return (f: Finding) => {
    const line = f.range.start.line;
    let blockDisabled = false;
    for (const d of sorted) {
      if (d.line > line) break;
      if (d.kind === "disable" && covers(d.ruleIds, f.ruleId)) blockDisabled = true;
      else if (d.kind === "enable" && covers(d.ruleIds, f.ruleId)) blockDisabled = false;
    }
    if (blockDisabled) return true;
    return sorted.some(
      (d) =>
        ((d.kind === "disable-line" && d.line === line) || (d.kind === "disable-next-line" && d.line === line - 1)) &&
        covers(d.ruleIds, f.ruleId),
    );
  };
}

export function applySuppressions(findings: readonly Finding[], text: string): Finding[] {
  const suppressed = suppressionFilter(parseDirectives(text));
  return findings.filter((f) => !suppressed(f));
}
