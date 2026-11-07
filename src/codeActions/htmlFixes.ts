/**
 * Safe automatic fixes for Nu Html Checker findings.
 */
import type { Finding, Fix } from "../engines/Engine";
import { LineIndex } from "../rules/dom";

export interface HtmlFixOptions {
  /** Language for `lang="…"`, e.g. "en" (from the editor's display language). */
  locale: string;
  /** No doctype fix for fragments (JSP includes, partials). */
  fragment: boolean;
}

function insertAt(lines: LineIndex, offset: number, text: string, title: string): Fix {
  const p = lines.positionAt(offset);
  return { title, edits: [{ range: { start: p, end: p }, newText: text }] };
}

/** Adds `fix` to findings that have a safe automatic fix. Returns new objects only where changed. */
export function addHtmlFixes(findings: readonly Finding[], text: string, opts: HtmlFixOptions): Finding[] {
  const lines = new LineIndex(text);
  return findings.map((f) => {
    if (f.fix) return f;
    const start = lines.offsetAt(f.range.start);
    const end = lines.offsetAt(f.range.end);
    switch (f.ruleId) {
      case "vnu:img-missing-alt": {
        // The range covers the <img …> start tag.
        if (!/^<img\b/i.test(text.slice(start, start + 4)) || text[end - 1] !== ">") return f;
        const at = text[end - 2] === "/" ? end - 2 : end - 1;
        const needsSpace = !/\s/.test(text[at - 1] ?? "");
        return { ...f, fix: insertAt(lines, at, `${needsSpace ? " " : ""}alt=""`, 'Add alt="" (decorative image)') };
      }
      case "vnu:missing-lang": {
        if (!/^<html\b/i.test(text.slice(start, start + 5))) return f;
        const lang = opts.locale.split(/[-_]/)[0]?.toLowerCase() || "en";
        return { ...f, fix: insertAt(lines, start + 5, ` lang="${lang}"`, `Add lang="${lang}"`) };
      }
      case "vnu:missing-doctype": {
        if (opts.fragment) return f;
        const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
        return { ...f, fix: insertAt(lines, bom, "<!DOCTYPE html>\n", "Add <!DOCTYPE html>") };
      }
      default:
        return f;
    }
  });
}
