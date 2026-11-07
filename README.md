# Web Standards Validator for HTML & JSP

Validate HTML5, CSS and the HTML inside JSP pages as you work, with every problem shown
in the editor and the Problems panel. HTML and CSS checks are powered by the
**Nu Html Checker** (the engine behind validator.w3.org/nu), bundled with the extension and
run **on your machine**.

This extension is not affiliated with or endorsed by W3C.

<!-- Screenshot: replace with a real capture before publishing, e.g. images/screenshot.png -->

## Features

- **HTML5 and CSS validation** with the Nu Html Checker, on open and save (or on demand).
- **JSP support**: scriptlets, EL and JSTL/custom tags are skipped, and the HTML around
  them is validated at the exact line and column of your `.jsp` file.
- **Fragments and includes**: SPA partials, `<jsp:include>` files and header/footer files
  validate cleanly without `<!DOCTYPE>`, `<html>`, `<head>` or `<body>`.
- **jQuery check** for selectors that match the whole page instead of the current
  process/tab, in `.js` files and inline `<script>` blocks.
- **Stable rule ids** with links to the HTML specification in the Problems panel.
- **Private by default**: nothing is sent over the network.

## Requirements

- **Java 17 or newer** for the HTML/CSS checks. The extension looks in
  `webValidator.java.home`, then `JAVA_HOME`, then `PATH`, then the JRE bundled with the
  [Red Hat Java extension](https://marketplace.visualstudio.com/items?itemName=redhat.java).
  Your projects can keep using another Java version (e.g. Java 8); only the validator needs 17+.
- Without Java, the JavaScript checks still work and the status bar explains what is missing.

## Getting started

1. Install the extension and open a `.html`, `.jsp` or `.js` file.
2. Problems appear after the first save (the validator needs a few seconds to start the
   first time, then checks are fast).
3. Click the status bar item (bottom right) to see the log, or run
   **Web Validator: Validate Current File** from the Command Palette.

## JSP files

`.jsp`, `.jspf` and `.tag` files are validated even if you associate them with the
`html` language. Before validation, JSP-only constructs are replaced with filler of the
same length, so every problem is reported at its exact line and column in your file:

| Construct | Replaced by |
|---|---|
| `<%-- --%>`, `<%@ %>`, `<%! %>`, `<% %>` | spaces |
| `<%= %>`, `${…}`, `#{…}` in an attribute value | a unique placeholder (`xxxa`), so the attribute stays non-empty |
| `<%= %>`, `${…}`, `#{…}` in text | a placeholder where text is allowed (`<title>`, `<td>`…), spaces elsewhere |
| Custom tags (`<c:forEach>`, `<fmt:message/>`, `<jsp:include/>`…) | the tag markup is removed, the body is validated |

All other HTML is validated exactly as written. Problems caused only by a placeholder,
such as `type="${t}"` being "a bad value" or `<label for="${id}">` pointing at no element,
are not reported.

### Document structure (`webValidator.jsp.documentStructure`)

Many JSPs are not complete pages: SPA partials loaded into an existing `<div>`,
`<jsp:include>` fragments, and header/footer files that open or close `<body>`.

- **`ignore` (default):** `<!DOCTYPE>`, `<html>`, `<head>` and `<body>` tags are skipped,
  and every JSP is validated as a fragment inside a hidden synthetic page. Missing doctype,
  title, `lang` and "no `<h1>`" problems are not reported. Everything inside those tags is
  still validated.
- **`validate`:** full pages are checked including their structure. Files without
  `<html>` or `<!DOCTYPE>` are still treated as fragments.

Custom tag prefixes come from `<%@ taglib prefix="…" %>` directives, `jsp:`, and
`webValidator.jsp.customTagPrefixes`.

### Known limitations

- **Conditional branches are all validated together.** `<c:choose>`, `<c:if>` and
  `<% if %>` bodies are validated as if every branch were output, so markup that is valid
  only on one branch can be reported.
- **Includes are not resolved.** Each file is validated on its own. An element opened in
  one file and closed in another (e.g. `<div class="wrapper">` in a header, `</div>` in
  the footer) is reported as unclosed in the first file and stray in the second.
- **EL inside `<script>` and `<style>`** is replaced with spaces. CSS errors on a line that
  contains EL are not reported.
- **HTML produced by EL or custom tags** (e.g. `${rowsHtml}`) is not visible to the
  validator.

## jQuery: selectors scoped to the current process/tab

In single-page applications the same partial is often loaded into several tabs, so
`$(".name")` finds elements in **every** tab. The rule
`webvalidator/jquery-unscoped-selector` (setting `webValidator.jquery.unscopedSelector`,
default `warning`) reports such selectors in `.js` files and in inline `<script>` blocks of
HTML and JSP files:

> Add current process / tab selector before ".name": it matches the whole page.
> Example: $(tabSelector + " .name") or $tab.find(".name").

| Reported | Not reported |
|---|---|
| `$(".name")`, `jQuery(".name")` | `$(tabSelector + " .name")` (starts with a variable) |
| `$("input")`, `$("[name=x]")`, `$(":checked")` | `` $(`${tab} .name`) `` |
| `$(".row-" + id)`, `` $(`.row-${id}`) `` | `$tab.find(".name")`, `$(this).find(".name")` |
| `$(".name", $tab)` (context argument) | `$("#saveBtn")`, `$("#" + id)` (starts with an `#id`) |
| `$(document).find(".name")`, `$("body").find(".name")` | `$("<div>")`, `$("body")`, `$(document)`, `$(el)` |
| `$("#a, .b")` (the `.b` part) | JSP: `$("${tabSel} .name")`, `$("<%= sel %> .name")` |

To accept a single line, add
`// eslint-disable-next-line webvalidator/jquery-unscoped-selector` above it, or
`// eslint-disable-line webvalidator/jquery-unscoped-selector` at its end.

Not detected: selectors held in variables (`var s = ".name"; $(s)`), and delegated events
bound page-wide (`$(document).on("click", ".name", …)`).

## Settings

| Setting | Default | Description |
|---|---|---|
| `webValidator.enable` | `true` | Turn validation on or off. |
| `webValidator.run` | `onSave` | `onSave`, `onType` (debounced) or `manual`. |
| `webValidator.onTypeDelayMs` | `800` | Debounce delay for `onType`. |
| `webValidator.languages` | `html`, `jsp`, `javascript` | Language ids to validate. |
| `webValidator.maxFileSizeKb` | `1024` | Larger files are skipped. |
| `webValidator.java.home` | | Java 17+ home folder or `java` executable. |
| `webValidator.vnu.mode` | `local` | `local` (bundled checker) or `server` (your own checker server). |
| `webValidator.vnu.serverUrl` | | Self-hosted Nu Html Checker URL, used in `server` mode. |
| `webValidator.vnu.validateOnType` | `false` | Also run the HTML checker while typing. |
| `webValidator.vnu.timeoutMs` | `20000` | Timeout for one HTML check. |
| `webValidator.jsp.documentStructure` | `ignore` | `ignore` or `validate` `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` in JSP. |
| `webValidator.jsp.customTagPrefixes` | `c`, `fmt`, `fn`, … | Extra custom tag prefixes (taglib prefixes are detected automatically). |
| `webValidator.jquery.unscopedSelector` | `warning` | Severity of the jQuery selector check, or `off`. |
| `webValidator.javascript.ecmaVersion` | `latest` | ECMAScript version used to parse JavaScript. |
| `webValidator.trace` | `info` | Log level of the **Web Validator** output channel. |

## Commands

- **Web Validator: Validate Current File**
- **Web Validator: Restart Validation Engines** (after installing Java or changing its path)
- **Web Validator: Show Output**

## Privacy

All validation runs locally. The HTML checker runs as a process on your computer that
only accepts connections from `127.0.0.1`; your code is never sent anywhere. Documents
leave your machine only if you set `webValidator.vnu.mode` to `server` and point
`webValidator.vnu.serverUrl` at a server. The extension collects no telemetry.

In [untrusted workspaces](https://code.visualstudio.com/docs/editor/workspace-trust),
workspace values for `webValidator.java.home` and `webValidator.vnu.serverUrl` are ignored.

## License

[MIT](LICENSE). The bundled Nu Html Checker and JavaScript libraries are covered by their
own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
