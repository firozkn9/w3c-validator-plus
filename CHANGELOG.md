# Changelog

## 0.1.0 (2026-11-08)

First release.

- **HTML and CSS** validation with the bundled Nu Html Checker, run locally (Java 17+;
  found via setting, `JAVA_HOME`, `PATH` or the Red Hat Java extension). Optional
  self-hosted checker server.
- **JSP** validation: JSP constructs are masked with position-preserving filler; custom tags
  are stripped and their bodies validated. `.jsp`, `.jspf`, `.tag` files are recognised even
  when associated with `html`. `webValidator.jsp.documentStructure` (default `ignore`) skips
  `<!DOCTYPE>`, `<html>`, `<head>`, `<body>` so includes and SPA partials validate cleanly.
  `webValidator.jsp.mode: "rendered"` validates the page served by the running application.
- **JavaScript** checks with ESLint in `.js` files and inline scripts: syntax errors, a set of
  likely-bug core rules, and `webvalidator/jquery-unscoped-selector` for jQuery selectors that
  match the whole page instead of the current process/tab.
- **Configuration**: `.webvalidator.json` (with schema and autocompletion) or settings:
  severities and `off` for any rule id (wildcards supported), `extends` presets, `exclude`,
  `ignoreMessages`, JSP options.
- **Suppression comments**: `webvalidator-disable-next-line`, `-disable-line`, `-disable` /
  `-enable` in HTML, JSP and JavaScript comments.
- **Custom rules**: JSON rules (CSS selector or regular expression), rule files in
  `rulesDirectories` (`.js`, `.cjs`, `.mjs`) with a typed API, `webvalidator-rules-*` rule
  packs, the **Create Custom Rule** command. Rule code runs only in trusted workspaces.
- **Quick fixes**: add `alt=""`, add `lang`, add a doctype, ESLint fixes and suggestions, and
  disable a rule for a line, a file or in `.webvalidator.json`.
- **Commands**: Validate Current File, Validate Workspace (progress, cancellation),
  Validate Running Page, Show Rendered Page, Open Configuration File, Clear Workspace Problems.
- Status bar with problem counts and engine status; output channel with log levels.
