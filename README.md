# Web Standards Validator for HTML & JSP

> Project: `w3c-validator-plus` · Status: **Phase 2 of 7** (HTML/CSS and JSP validation). Not yet published.

Validates HTML5, CSS and the HTML inside JSP files locally in VS Code and shows the results as editor diagnostics.
The HTML and CSS checks are powered by the Nu Html Checker (the engine behind
validator.w3.org/nu), bundled with the extension and run on your machine. This
project is not affiliated with or endorsed by W3C.

## Requirements

- Java 17 or newer. The extension looks in `webValidator.java.home`, then `JAVA_HOME`,
  then `PATH`, then the JRE bundled with the Red Hat Java extension.

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

## Privacy

By default nothing leaves your machine: documents are checked by a Nu Html Checker
process bound to `127.0.0.1`. Documents are sent elsewhere only if you set
`webValidator.vnu.mode` to `server` and point `webValidator.vnu.serverUrl` at a server.

## Development

```sh
npm install
npm run build              # bundle to dist/ and copy vnu.jar
npm run test:unit          # vitest (real-engine tests skip when Java 17+ is missing)
npm run test:integration   # VS Code + mocha against test/fixtures/workspace
npm run lint && npm run typecheck
```

Press F5 ("Run Extension") to open the fixture workspace in a development host.
