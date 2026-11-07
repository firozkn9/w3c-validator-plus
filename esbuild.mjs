// Bundles the extension into dist/extension.js and copies the vnu jar next to it.
// Production builds also regenerate THIRD_PARTY_NOTICES.md from the bundle contents.
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { writeThirdPartyNotices } from "./scripts/third-party-notices.mjs";

const require = createRequire(import.meta.url);
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

function copyVnuJar() {
  mkdirSync("dist", { recursive: true });
  // `vnu-jar` exports the absolute path of vnu.jar inside node_modules.
  copyFileSync(String(require("vnu-jar")), "dist/vnu.jar");
}

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  metafile: production,
  logLevel: "info",
};

copyVnuJar();
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const result = await esbuild.build(options);
  if (production) {
    const count = writeThirdPartyNotices(result.metafile);
    console.log(`THIRD_PARTY_NOTICES.md: ${count} bundled packages + vnu.jar`);
  }
}
