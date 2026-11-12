// The CSS selector subset used by selector rules and ctx.querySelectorAll():
// type and *, #id, .class, [attr] with = ~= ^= $= *= |= (and the " i" flag),
// :not(), :first-child, :last-child, :empty, descendant and child
// combinators, and selector lists.

export interface SelectableElement {
  tagName: string; // lower case
  attrs: Readonly<Record<string, string>>; // lower-case names
  parent?: SelectableElement;
  children?: readonly SelectableElement[];
  hasText?: boolean;
}

type AttrOp = "exists" | "=" | "~=" | "^=" | "$=" | "*=" | "|=";

interface Compound {
  tag?: string;
  ids: string[];
  classes: string[];
  attrs: Array<{ name: string; op: AttrOp; value: string; insensitive: boolean }>;
  nots: Complex[][];
  pseudos: Array<"first-child" | "last-child" | "empty">;
}

// Stored right to left: the subject comes first.
interface Complex {
  compounds: Compound[];
  combinators: Array<" " | ">">;
}

export type Selector = Complex[];

const IDENT = /[A-Za-z0-9_\-\u00a0-\uffff]+/y;

export function parseSelector(source: string): Selector {
  let i = 0;
  const s = source;
  const fail = (msg: string): never => {
    throw new Error(`Invalid selector "${source}": ${msg} at position ${i + 1}`);
  };
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const ident = (): string => {
    IDENT.lastIndex = i;
    const m = IDENT.exec(s);
    if (!m) fail("expected a name");
    i = IDENT.lastIndex;
    return m![0];
  };
  const value = (): string => {
    const q = s[i];
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, i + 1);
      if (end < 0) fail("unterminated string");
      const v = s.slice(i + 1, end);
      i = end + 1;
      return v;
    }
    return ident();
  };

  const compound = (): Compound => {
    const c: Compound = { ids: [], classes: [], attrs: [], nots: [], pseudos: [] };
    let any = false;
    if (s[i] === "*") {
      i++;
      any = true;
    } else if (/[A-Za-z_\u00a0-\uffff]/.test(s[i] ?? "")) {
      c.tag = ident().toLowerCase();
      any = true;
    }
    for (;;) {
      const ch = s[i];
      if (ch === "#") {
        i++;
        c.ids.push(ident());
      } else if (ch === ".") {
        i++;
        c.classes.push(ident());
      } else if (ch === "[") {
        i++;
        skipWs();
        const name = ident().toLowerCase();
        skipWs();
        let op: AttrOp = "exists";
        let v = "";
        let insensitive = false;
        const m = /^(~=|\^=|\$=|\*=|\|=|=)/.exec(s.slice(i));
        if (m) {
          op = m[1] as AttrOp;
          i += m[1]!.length;
          skipWs();
          v = value();
          skipWs();
          if (/^[iI]\b/.test(s.slice(i))) {
            insensitive = true;
            i++;
            skipWs();
          }
        }
        if (s[i] !== "]") fail('expected "]"');
        i++;
        c.attrs.push({ name, op, value: v, insensitive });
      } else if (ch === ":") {
        i++;
        const name = ident().toLowerCase();
        if (name === "not") {
          if (s[i] !== "(") fail('expected "(" after :not');
          i++;
          c.nots.push(list(")"));
          i++;
        } else if (name === "first-child" || name === "last-child" || name === "empty") {
          c.pseudos.push(name);
        } else {
          fail(`unsupported pseudo-class :${name}`);
        }
      } else {
        break;
      }
      any = true;
    }
    if (!any) fail("expected a selector");
    return c;
  };

  const complex = (): Complex => {
    const compounds: Compound[] = [compound()];
    const combinators: Array<" " | ">"> = [];
    for (;;) {
      const start = i;
      skipWs();
      if (s[i] === ">") {
        i++;
        skipWs();
        combinators.push(">");
        compounds.push(compound());
      } else if (i > start && i < s.length && s[i] !== "," && s[i] !== ")") {
        combinators.push(" ");
        compounds.push(compound());
      } else {
        break;
      }
    }
    return { compounds: compounds.reverse(), combinators: combinators.reverse() };
  };

  function list(terminator?: string): Complex[] {
    const out: Complex[] = [];
    skipWs();
    out.push(complex());
    skipWs();
    while (s[i] === ",") {
      i++;
      skipWs();
      out.push(complex());
      skipWs();
    }
    if (terminator ? s[i] !== terminator : i < s.length) fail(terminator ? `expected "${terminator}"` : "unexpected character");
    return out;
  }

  return list();
}

function attrMatches(actual: string | undefined, a: Compound["attrs"][number]): boolean {
  if (actual === undefined) return false;
  if (a.op === "exists") return true;
  const v = a.insensitive ? a.value.toLowerCase() : a.value;
  const x = a.insensitive ? actual.toLowerCase() : actual;
  switch (a.op) {
    case "=":
      return x === v;
    case "~=":
      return x.split(/\s+/).includes(v);
    case "^=":
      return v !== "" && x.startsWith(v);
    case "$=":
      return v !== "" && x.endsWith(v);
    case "*=":
      return v !== "" && x.includes(v);
    case "|=":
      return x === v || x.startsWith(`${v}-`);
  }
}

function compoundMatches(el: SelectableElement, c: Compound): boolean {
  if (c.tag && c.tag !== el.tagName) return false;
  if (c.ids.length && !c.ids.every((id) => el.attrs.id === id)) return false;
  if (c.classes.length) {
    const classes = (el.attrs.class ?? "").split(/\s+/);
    if (!c.classes.every((k) => classes.includes(k))) return false;
  }
  for (const a of c.attrs) if (!attrMatches(el.attrs[a.name], a)) return false;
  for (const n of c.nots) if (n.some((cx) => complexMatches(el, cx))) return false;
  for (const p of c.pseudos) {
    const siblings = el.parent?.children;
    if (p === "first-child" && siblings && siblings[0] !== el) return false;
    if (p === "last-child" && siblings && siblings[siblings.length - 1] !== el) return false;
    if (p === "empty" && ((el.children?.length ?? 0) > 0 || el.hasText)) return false;
  }
  return true;
}

function complexMatches(el: SelectableElement, cx: Complex, index = 0): boolean {
  if (!compoundMatches(el, cx.compounds[index]!)) return false;
  if (index === cx.compounds.length - 1) return true;
  const combinator = cx.combinators[index];
  if (combinator === ">") return !!el.parent && complexMatches(el.parent, cx, index + 1);
  for (let p = el.parent; p; p = p.parent) {
    if (complexMatches(p, cx, index + 1)) return true;
  }
  return false;
}

export function matchesSelector(el: SelectableElement, selector: Selector): boolean {
  return selector.some((cx) => complexMatches(el, cx));
}
