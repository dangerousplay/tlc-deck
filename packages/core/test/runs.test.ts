import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findProgressFiles } from "../src/runs.js";

test("findProgressFiles lists feature progress files", () => {
  const d = mkdtempSync(join(tmpdir(), "tlc-runs-"));
  try {
    expect(findProgressFiles(d)).toEqual([]);
    for (const f of ["b", "a"]) mkdirSync(join(d, ".specs/features", f), { recursive: true });
    mkdirSync(join(d, ".specs/features/none"), { recursive: true });
    writeFileSync(join(d, ".specs/features/a/progress.ndjson"), "");
    writeFileSync(join(d, ".specs/features/b/progress.ndjson"), "");
    expect(findProgressFiles(d)).toEqual([
      join(d, ".specs/features/a/progress.ndjson"),
      join(d, ".specs/features/b/progress.ndjson"),
    ]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
