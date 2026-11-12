// Fails when package.json or the shipped files are not ready to publish.
//   node scripts/check-release.ts
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const icon: string = pkg.icon ?? "images/icon.png";
const problems: string[] = [];

if (/your-publisher-id|your-github-user/.test(JSON.stringify(pkg))) problems.push("package.json still contains placeholder publisher or GitHub URLs");
for (const f of ["LICENSE", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", icon]) {
  if (!existsSync(f)) problems.push(`missing ${f}`);
}
if (!icon.endsWith(".png")) problems.push("icon must be a PNG");

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
