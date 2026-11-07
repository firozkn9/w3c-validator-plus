// Generates THIRD_PARTY_NOTICES.md from an esbuild metafile: one section per npm
// package bundled into dist/extension.js, plus the separately shipped vnu.jar.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// LICENSE, LICENSE.md, LICENSE.BSD, LICENSE-MIT, COPYING, NOTICE.txt …
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]+)?$/i;

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * For packages that ship no license file: the README's "License" section, or
 * its trailing copyright lines. A bare MIT reference gets the standard MIT text.
 */
function licenseFromReadme(root, license) {
  const readme = readdirSync(root).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f));
  if (!readme) return [];
  const lines = readFileSync(join(root, readme), "utf8").split(/\r?\n/);
  let start = lines.findIndex((l) => /^#+\s*licen[cs]e\b/i.test(l));
  let end = lines.length;
  if (start >= 0) {
    const level = /^#+/.exec(lines[start])[0].length;
    const next = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
    if (next > 0) end = next;
    start++;
  } else {
    start = lines.findIndex((l) => /copyright/i.test(l));
    if (start < 0) return [];
  }
  let text = lines.slice(start, end).join("\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  if (/^MIT$/i.test(license) && !/Permission is hereby granted/.test(text)) text += `\n\n${MIT_TEXT}`;
  return text ? [`(From the package README)\n\n${text}`] : [];
}

/** "node_modules/@scope/pkg/lib/x.js" → "node_modules/@scope/pkg" (innermost node_modules). */
function packageRoot(input) {
  const parts = input.split("/");
  const idx = parts.lastIndexOf("node_modules");
  if (idx < 0) return undefined;
  const name = parts[idx + 1]?.startsWith("@") ? parts.slice(idx + 1, idx + 3) : parts.slice(idx + 1, idx + 2);
  return [...parts.slice(0, idx + 1), ...name].join("/");
}

function licenseTexts(root) {
  return readdirSync(root)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(root, f), "utf8").trim());
}

export function writeThirdPartyNotices(metafile, outFile = "THIRD_PARTY_NOTICES.md") {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const root = packageRoot(input.replace(/\\/g, "/"));
    if (root && existsSync(join(root, "package.json"))) roots.add(root);
  }

  const packages = [...roots]
    .map((root) => {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "see package";
      const files = licenseTexts(root);
      return { name: pkg.name, version: pkg.version, license, texts: files.length ? files : licenseFromReadme(root, license) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Packages without a license file are a release blocker: fail loudly.
  const missing = packages.filter((p) => p.texts.length === 0).map((p) => `${p.name}@${p.version}`);
  if (missing.length) throw new Error(`No license file found for bundled packages: ${missing.join(", ")}`);

  const vnu = JSON.parse(readFileSync("node_modules/vnu-jar/package.json", "utf8"));
  const lines = [
    "# Third-party notices",
    "",
    "This extension includes third-party software. Their licenses are reproduced below.",
    "",
    `## Nu Html Checker (vnu.jar ${vnu.version})`,
    "",
    "Shipped unmodified as `dist/vnu.jar`, from the [`vnu-jar`](https://www.npmjs.com/package/vnu-jar) npm package",
    "([source](https://github.com/validator/validator)). License: MIT.",
    "",
    "vnu.jar bundles further libraries; their license and notice files are included inside the jar",
    "(e.g. `LICENSE`, `LICENSE.txt`, `NOTICE.txt`, `META-INF/LICENSE*`, `META-INF/NOTICE*`) and apply to those libraries.",
    "",
    "```",
    readFileSync("node_modules/vnu-jar/LICENSE", "utf8").trim(),
    "```",
    "",
    "## JavaScript packages bundled into dist/extension.js",
    "",
    ...packages.map((p) => `- ${p.name} ${p.version} (${p.license})`),
    "",
  ];
  for (const p of packages) {
    lines.push(`### ${p.name} ${p.version}`, "", `License: ${p.license}`, "");
    for (const t of p.texts) lines.push("```", t, "```", "");
  }
  writeFileSync(outFile, lines.join("\n"));
  return packages.length;
}
