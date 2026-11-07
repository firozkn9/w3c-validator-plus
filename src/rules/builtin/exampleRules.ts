/**
 * Built-in rules written with the public custom-rule API (see RuleApi.ts).
 * They are off by default; enable them in the config or with `"extends": "strict"`.
 */
import { defineRule, type RuleModule } from "../RuleApi";

export const noInlineStyles = defineRule({
  id: "webvalidator/no-inline-styles",
  languages: ["html", "jsp"],
  meta: {
    description: "Disallow style attributes; use CSS classes instead.",
    defaultSeverity: "off",
  },
  create(ctx) {
    return {
      element(el) {
        if (el.attrs.style !== undefined) {
          ctx.report({ node: el, attribute: "style", message: "Move this inline style into a CSS class." });
        }
      },
    };
  },
});

export const requireButtonType = defineRule({
  id: "webvalidator/require-button-type",
  languages: ["html", "jsp"],
  meta: {
    description: 'Require a type on <button>; without it, a button inside a form submits the form.',
    defaultSeverity: "off",
  },
  create(ctx) {
    return {
      element(el) {
        if (el.tagName !== "button" || el.attrs.type !== undefined) return;
        const at = { line: el.startTag.start.line, character: el.startTag.start.character + "<button".length };
        ctx.report({
          node: el,
          message: 'Add a type to this <button> ("button", "submit" or "reset"); the default is "submit".',
          fix: { title: 'Add type="button"', edits: [{ range: { start: at, end: at }, newText: ' type="button"' }] },
          suggestions: [{ title: 'Add type="submit"', edits: [{ range: { start: at, end: at }, newText: ' type="submit"' }] }],
        });
      },
    };
  },
});

export const BUILTIN_RULES: readonly RuleModule[] = [noInlineStyles, requireButtonType];
