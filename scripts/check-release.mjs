// Fails when package.json or the shipped files are not ready to publish.
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];
const text = JSON.stringify(pkg);

if (/your-publisher-id|your-github-user/.test(text)) problems.push("package.json still contains placeholder publisher or GitHub URLs");
for (const f of ["LICENSE", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", pkg.icon ?? "images/icon.png"]) {
  if (!existsSync(f)) problems.push(`missing ${f}`);
}
if (pkg.icon && !pkg.icon.endsWith(".png")) problems.push("icon must be a PNG");
const changelog = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "";
if (!changelog.includes(`## ${pkg.version}`)) problems.push(`CHANGELOG.md has no "## ${pkg.version}" section`);
if (/\(unreleased\)/i.test(changelog.split("\n## ")[1] ?? changelog)) problems.push(`CHANGELOG.md: ${pkg.version} is still marked "unreleased"`);
const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== pkg.version) problems.push(`tag ${tag} does not match package.json version ${pkg.version}`);

if (problems.length) {
  console.error("Not ready to release:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Ready to release ${pkg.publisher}.${pkg.name}@${pkg.version}`);
