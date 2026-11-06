# Changelog

## 0.1.0 (unreleased)

- HTML and CSS validation with the bundled Nu Html Checker, run locally.
- JSP validation: JSP constructs are masked with position-preserving filler; custom tags
  are stripped and their bodies validated. `.jsp`, `.jspf`, `.tag` files are recognised
  even when associated with `html`.
- `webValidator.jsp.documentStructure` (default `ignore`): skip `<!DOCTYPE>`, `<html>`,
  `<head>`, `<body>` checks so includes, SPA partials and header/footer files validate cleanly.
- Java detection: setting, `JAVA_HOME`, `PATH`, Red Hat Java extension.
- Validate on open/save, or manually; optional self-hosted checker server.
