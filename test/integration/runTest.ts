import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // Set when the tests are started from inside VS Code; it would make the test
  // instance start as plain Node instead of as the editor.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Compiled to out/test/integration/runTest.js
  const root = path.resolve(__dirname, "../../..");
  // Set WEBVALIDATOR_EXTENSION_PATH to an unpacked .vsix (an installed extension
  // folder) to run the same tests against the packaged production build.
  const extensionDevelopmentPath = process.env.WEBVALIDATOR_EXTENSION_PATH ?? root;
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspace = path.resolve(root, "test/fixtures/workspace");
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
