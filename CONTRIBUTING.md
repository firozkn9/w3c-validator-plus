# Contributing

## Setup

Requirements: Node.js 22.18+ (it runs the TypeScript build scripts directly), and Java 17+ for the HTML checker tests.

```sh
npm install
npm run build              # bundle to dist/ and copy vnu.jar
npm run test:unit          # vitest (real-engine tests skip when Java 17+ is missing)
npm run test:integration   # VS Code + mocha against test/fixtures/workspace
npm run lint && npm run typecheck
```

Press F5 ("Run Extension") to open `test/fixtures/workspace` in a development host.

## Project layout

Everything in `src/` is flat. The modules that don't import `vscode` can be unit-tested with plain Node:

- `core.ts` – shared types (`Finding`, `Engine`) and small helpers
- `config.ts` – `.webvalidator.json` model, JSONC parsing and comment-preserving edits
- `jsp.ts` – JSP masking and `<script>` extraction (positions are preserved)
- `vnu.ts`, `vnuMessages.ts` – Nu Html Checker engine and message mapping
- `eslint.ts` – JavaScript engine and the `jquery-unscoped-selector` rule
- `rules.ts`, `ruleLoader.ts`, `selector.ts` – custom rule API, runner and loader
- `suppressions.ts` – `webvalidator-disable` comments
- `java.ts`, `pages.ts` – Java detection, fetching pages from a running app

VS Code glue: `extension.ts`, `validationService.ts`, `settings.ts`, `diagnostics.ts`, `commands.ts`.

`scripts/` holds the build (`build.ts`), third-party notices, the config schema, the icon and the
release check. Node runs them directly (`node scripts/build.ts`); no compile step.

## Releasing

See [RELEASING.md](RELEASING.md).
