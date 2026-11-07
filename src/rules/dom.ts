/**
 * Builds the rule DOM (RuleElement tree) from HTML using parse5 with source
 * locations. Elements implied by the parser (e.g. <html>/<body> around a
 * fragment) are kept as parents but not visited and have no positions.
 */
import type { Position, Range } from "../engines/Engine";
import type { RuleComment, RuleElement, RuleTextNode } from "./RuleApi";

export interface RuleDom {
  /** Elements present in the source, in document order. */
  elements: RuleElement[];
  texts: RuleTextNode[];
  comments: RuleComment[];
}

/** Converts offsets to positions for a given text. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }

  positionAt(offset: number): Position {
    const o = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: o - this.starts[lo]! };
  }

  offsetAt(p: Position): number {
    const start = this.starts[Math.max(0, Math.min(p.line, this.starts.length - 1))] ?? 0;
    return Math.min(start + Math.max(0, p.character), this.text.length);
  }

  range(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }
}

interface P5Location {
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}

interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: P5Node; // <template> contents
  value?: string; // text
  data?: string; // comment
  sourceCodeLocation?: P5Location | null;
}

const NO_RANGE: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

export async function buildDom(html: string): Promise<RuleDom> {
  const { parse } = await import("parse5");
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const lines = new LineIndex(html);
  const dom: RuleDom = { elements: [], texts: [], comments: [] };

  /** Walks children of `node`, returning their concatenated text content. */
  const walk = (node: P5Node, parent: RuleElement | undefined): string => {
    let text = "";
    for (const child of [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])]) {
      const loc = child.sourceCodeLocation ?? undefined;
      if (child.nodeName === "#text") {
        const value = child.value ?? "";
        text += value;
        if (loc) dom.texts.push({ value, range: lines.range(loc.startOffset, loc.endOffset), ...(parent ? { parent } : {}) });
        if (parent && /\S/.test(value)) parent.hasText = true;
        continue;
      }
      if (child.nodeName === "#comment") {
        if (loc) dom.comments.push({ value: child.data ?? "", range: lines.range(loc.startOffset, loc.endOffset) });
        continue;
      }
      if (!child.tagName) continue;
      const attrs: Record<string, string> = {};
      for (const a of child.attrs ?? []) attrs[a.name.toLowerCase()] = a.value;
      const attrRanges: Record<string, Range> = {};
      for (const [name, l] of Object.entries(loc?.attrs ?? {})) attrRanges[name.toLowerCase()] = lines.range(l.startOffset, l.endOffset);
      const el: RuleElement = {
        tagName: child.tagName.toLowerCase(),
        attrs,
        children: [],
        hasText: false,
        textContent: "",
        startTag: loc?.startTag ? lines.range(loc.startTag.startOffset, loc.startTag.endOffset) : NO_RANGE,
        range: loc ? lines.range(loc.startOffset, loc.endOffset) : NO_RANGE,
        attrRanges,
        ...(parent ? { parent } : {}),
      };
      if (loc?.endTag) el.endTag = lines.range(loc.endTag.startOffset, loc.endTag.endOffset);
      parent?.children.push(el);
      // Only elements written in the source are visited.
      if (loc?.startTag) dom.elements.push(el);
      el.textContent = walk(child, el);
      text += el.textContent;
    }
    return text;
  };
  walk(document, undefined);
  return dom;
}
