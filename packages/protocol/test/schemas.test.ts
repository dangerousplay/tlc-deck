import { describe, expect, it } from "vitest";
import {
  advisorOutputJsonSchema,
  reviewerOutputJsonSchema,
  statusOutputJsonSchema,
} from "../src/index.js";

describe("harness JSON schemas", () => {
  it("omit $schema (claude --json-schema rejects the 2020-12 meta-schema URI)", () => {
    for (const s of [statusOutputJsonSchema, reviewerOutputJsonSchema, advisorOutputJsonSchema]) {
      expect(s).not.toHaveProperty("$schema");
      expect(s.type).toBe("object");
    }
  });
});
