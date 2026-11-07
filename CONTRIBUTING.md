# Contributing

## Setup

Requirements: Node.js 20+, and Java 17+ for the HTML checker tests.

```sh
npm install
npm run build              # bundle to dist/ and copy vnu.jar
npm run test:unit          # vitest (real-engine tests skip when Java 17+ is missing)
npm run test:integration   # VS Code + mocha against test/fixtures/workspace
npm run lint && npm run typecheck
```

Press F5 ("Run Extension") to open `test/fixtures/workspace` in a development host.

## Project layout

- `src/engines/` – validation engines (Nu Html Checker, ESLint) producing `Finding`s
- `src/preprocess/` – JSP masking and `<script>` extraction (positions are preserved)
- `src/rules/builtin/` – built-in rules such as `jquery-unscoped-selector`
- `src/java/` – Java runtime detection
- `scripts/` – build helpers (third-party notices, icon, release check)

## Releasing

See [RELEASING.md](RELEASING.md).
