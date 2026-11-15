import { expect, test } from "vitest";
import { name } from "../src/index.js";

test("exports name", () => {
  expect(name).toBe("@tlc-deck/protocol");
});
