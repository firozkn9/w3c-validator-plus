/**
 * Parses JSON with comments and trailing commas (like VS Code settings files).
 * Comments and trailing commas are blanked in place, so error offsets stay correct.
 */
export class JsoncError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "JsoncError";
  }
}

export function stripJsonc(text: string): string {
  const out = text.split("");
  const blank = (s: number, e: number) => {
    for (let k = s; k < e; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let lastComma = -1; // index of a comma that may turn out to be trailing
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

function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) };
}

export function parseJsonc(text: string): unknown {
  const stripped = stripJsonc(text);
  if (!stripped.trim()) return {};
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const m = /position (\d+)/.exec(message);
    const { line, column } = m ? positionOf(text, Number(m[1])) : { line: 0, column: 0 };
    throw new JsoncError(`Invalid JSON at line ${line + 1}, column ${column + 1}: ${message}`, line, column);
  }
}
