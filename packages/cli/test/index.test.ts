import { expect, test } from "vitest";
import { version } from "../src/index.js";

test("reads version", () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
});
