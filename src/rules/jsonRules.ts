/**
 * Rules declared in JSON (`customRules` in .webvalidator.json or settings),
 * turned into RuleModules: a CSS `selector` matched against elements, or a
 * regular expression `pattern` matched against the document text.
 */
import type { JsonRuleDefinition } from "../config/webValidatorConfig";
import type { RuleLanguage, RuleModule } from "./RuleApi";
import { matchesSelector, parseSelector } from "./selector";

const MAX_MATCHES = 500;

export function jsonRuleModule(def: JsonRuleDefinition): RuleModule {
  const meta = { description: def.message, defaultSeverity: def.severity, ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}) };
  const languages = def.languages as RuleLanguage[];
  if (def.selector !== undefined) {
    const selector = parseSelector(def.selector);
    return {
      id: def.id,
      languages,
      meta,
      create: (ctx) => ({
        element(el) {
          if (matchesSelector(el, selector)) ctx.report({ node: el, message: def.message });
        },
      }),
    };
  }
  const flags = `${(def.flags ?? "").replace(/g/g, "")}g`;
  return {
    id: def.id,
    languages,
    meta,
    create: (ctx) => ({
      end() {
        const re = new RegExp(def.pattern ?? "(?!)", flags);
        let count = 0;
        for (let m = re.exec(ctx.text); m && count < MAX_MATCHES; m = re.exec(ctx.text), count++) {
          if (m[0].length === 0) {
            re.lastIndex++; // avoid an endless loop on empty matches
            continue;
          }
          ctx.report({ offset: m.index, length: m[0].length, message: def.message });
        }
      },
    }),
  };
}
