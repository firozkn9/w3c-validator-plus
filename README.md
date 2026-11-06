# Web Standards Validator for HTML & JSP

> Project: `w3c-validator-plus` · Status: **Phase 1 of 7** (HTML/CSS validation). Not yet published.

Validates HTML5 and CSS locally in VS Code and shows the results as editor diagnostics.
The HTML and CSS checks are powered by the Nu Html Checker (the engine behind
validator.w3.org/nu), bundled with the extension and run on your machine. This
project is not affiliated with or endorsed by W3C.

## Requirements

- Java 17 or newer. The extension looks in `webValidator.java.home`, then `JAVA_HOME`,
  then `PATH`, then the JRE bundled with the Red Hat Java extension.

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
