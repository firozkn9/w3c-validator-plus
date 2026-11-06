import type { Position } from "../engines/Engine";

/** Byte length of a string when encoded as UTF-8 (used for the file size cap). */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Number of lines in `text` (a trailing newline starts a new, empty line). */
export function lineCount(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/** Returns the text of each line without its terminator ("\n" or "\r\n"). */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Clamp a position so it lies inside the document. */
export function clampPosition(pos: Position, lines: readonly string[]): Position {
  if (lines.length === 0) return { line: 0, character: 0 };
  const line = Math.min(Math.max(pos.line, 0), lines.length - 1);
  const max = lines[line]?.length ?? 0;
  return { line, character: Math.min(Math.max(pos.character, 0), max) };
}
