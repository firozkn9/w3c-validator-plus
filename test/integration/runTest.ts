import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // Set when the tests are started from inside VS Code; it would make the test
  // instance start as plain Node instead of as the editor.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Compiled to out/test/integration/runTest.js
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspace = path.resolve(extensionDevelopmentPath, "test/fixtures/workspace");
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
