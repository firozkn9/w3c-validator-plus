// Bundles the extension into dist/extension.js and puts vnu.jar next to it.
// A production build also regenerates THIRD_PARTY_NOTICES.md from what ended
// up in the bundle.
//
//   node scripts/build.ts [--production] [--watch]
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeThirdPartyNotices } from "./notices.ts";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options: esbuild.BuildOptions = {
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

async function main(): Promise<void> {
  mkdirSync("dist", { recursive: true });
  // The vnu-jar package exports the path of its vnu.jar.
  const require = createRequire(resolve("package.json"));
  copyFileSync(String(require("vnu-jar")), "dist/vnu.jar");

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return;
  }
  const result = await esbuild.build(options);
  if (production && result.metafile) {
    const count = writeThirdPartyNotices(result.metafile);
    console.log(`THIRD_PARTY_NOTICES.md: ${count} bundled packages + vnu.jar`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
