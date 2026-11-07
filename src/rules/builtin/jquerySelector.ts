/**
 * Decides whether a jQuery selector string is limited to the current
 * process/tab or matches the whole page.
 *
 * The selector may contain `DYNAMIC` characters where the source code had an
 * expression (a variable, `${…}`, or masked JSP EL). A selector segment that
 * starts with a dynamic part is considered scoped ("starts with a variable").
 */

/** Stands for a run-time value inside a selector string. */
export const DYNAMIC = "\u0000";

/** Whole-selector tags that are unique in a page and therefore not "too wide". */
const UNIQUE_TAGS = /^(html|body|head)$/i;

/** Splits a selector on top-level commas (not inside (), [] or quotes). */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
    } else if ((ch === ")" || ch === "]") && depth > 0) {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Human-readable form: runs of dynamic characters become `${…}`. */
export function displaySelector(selector: string): string {
  return selector.split(DYNAMIC).reduce((acc, part, i) => (i > 0 && !acc.endsWith("${…}") ? acc + "${…}" : acc) + part, "").trim();
}

/**
 * Returns the comma-separated segments of `selector` that are not scoped,
 * i.e. that do not start with an `#id` or with a dynamic (variable) part.
 * HTML strings such as `"<div>"` create elements and are never flagged.
 */
export function unscopedSegments(selector: string): string[] {
  if (selector.trimStart().startsWith("<")) return [];
  const out: string[] = [];
  for (const raw of splitSelectorList(selector)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith(DYNAMIC) || s.startsWith("#")) continue;
    if (UNIQUE_TAGS.test(s)) continue;
    out.push(displaySelector(s));
  }
  return out;
}

/** True for selectors that mean "the whole page" when used as a receiver of `.find()`. */
export function isPageWideReceiverSelector(selector: string): boolean {
  return /^\s*(html|body|document|:root)\s*$/i.test(selector);
}
