import * as vscode from "vscode";
import { MIN_JAVA_MAJOR } from "../java/javaLocator";

const INSTALL_URL = "https://adoptium.net/temurin/releases/";
let shownThisSession = false;

/** Explains how to get HTML/CSS validation working when no suitable Java is found (once per session). */
export async function showJavaMissing(showOutput: () => void): Promise<void> {
  if (shownThisSession) return;
  shownThisSession = true;
  const install = "Install Java";
  const setPath = "Set Java Path";
  const log = "Show Log";
  const choice = await vscode.window.showWarningMessage(
    `Web Validator: HTML and CSS checks need Java ${MIN_JAVA_MAJOR} or newer to run the bundled Nu Html Checker, ` +
      "and none was found in webValidator.java.home, JAVA_HOME, PATH or the Red Hat Java extension. " +
      "Other checks keep working.",
    install,
    setPath,
    log,
  );
  if (choice === install) {
    await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
  } else if (choice === setPath) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "webValidator.java.home");
  } else if (choice === log) {
    showOutput();
  }
}

/** Allows the message to be shown again (after the user changes the Java settings). */
export function resetJavaMissingNotice(): void {
  shownThisSession = false;
}
