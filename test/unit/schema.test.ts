import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "../../src/config/schema";

const file = join(__dirname, "..", "..", "schemas", "webvalidator.schema.json");

describe("schemas/webvalidator.schema.json", () => {
  it("is up to date with the code (run with UPDATE_SCHEMA=1 to regenerate)", () => {
    const expected = `${JSON.stringify(buildConfigSchema(), null, 2)}\n`;
    if (process.env.UPDATE_SCHEMA) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, expected);
    }
    expect(existsSync(file), "schema file exists").toBe(true);
    expect(readFileSync(file, "utf8")).toBe(expected);
  });

  it("lists rule ids for autocompletion", () => {
    const rules = (buildConfigSchema().properties as Record<string, { properties: Record<string, unknown> }>).rules!.properties;
    for (const id of ["vnu:img-missing-alt", "eslint:no-dupe-keys", "eslint:syntax-error", "webvalidator/jquery-unscoped-selector", "webvalidator/require-button-type"]) {
      expect(rules, id).toHaveProperty([id]);
    }
  });
});
