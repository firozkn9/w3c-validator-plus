/**
 * Minimal glob matching for `exclude` patterns: `**`, `*`, `?`, `{a,b}`, `[abc]`.
 * Patterns are matched against forward-slash paths relative to a base folder.
 */
import * as path from "node:path";

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more folders; "**" at the end matches everything
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((alt) => globToRegExp(alt).source.slice(1, -1))
        .join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      re += `[${glob.slice(i + 1, end).replace(/^!/, "^")}]`;
      i = end;
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

/** True when `fsPath` matches any pattern relative to its base folder. */
export function isExcluded(fsPath: string, patterns: ReadonlyArray<{ baseDir: string; glob: string }>): boolean {
  for (const { baseDir, glob } of patterns) {
    const rel = path.relative(baseDir, fsPath).split(path.sep).join("/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (globToRegExp(glob.replace(/^\.\//, "")).test(rel)) return true;
  }
  return false;
}
