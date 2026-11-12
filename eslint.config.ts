import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "out/**", ".vscode-test/**", "node_modules/**", "test/fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
