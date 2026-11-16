import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadConfig, normalizeRoles, registerRepo, registryPath } from "../src/config.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlc-cfg-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("normalizes alias and object roles", () => {
  expect(normalizeRoles({ a: "sonnet", b: { model: "opus", effort: "high", x: 1 }, c: 5 })).toEqual(
    {
      a: { model: "sonnet" },
      b: { model: "opus", effort: "high" },
    },
  );
});

test("user < repo < flags, roles merged per field", () => {
  const home = join(root, "h");
  const repo = join(root, "r");
  mkdirSync(join(home, ".config", "tlc"), { recursive: true });
  mkdirSync(join(repo, ".specs"), { recursive: true });
  writeFileSync(
    join(home, ".config", "tlc", "config.json"),
    JSON.stringify({ retries: 1, roles: { implementer: "haiku", advisor: { model: "opus" } } }),
  );
  writeFileSync(
    join(repo, ".specs", "tlc-execute.json"),
    JSON.stringify({ retries: 2, roles: { implementer: { effort: "low" } } }),
  );
  const c = loadConfig({
    repoDir: repo,
    env: { HOME: home },
    flags: { roles: { advisor: "sonnet" } },
  });
  expect(c.retries).toBe(2);
  expect(c.roles).toEqual({
    implementer: { model: "haiku", effort: "low" },
    advisor: { model: "sonnet" },
  });
});

test("registerRepo dedupes", () => {
  const env = { HOME: root };
  registerRepo("/a", env, 1);
  registerRepo("/b", env, 2);
  registerRepo("/a", env, 3);
  const reg = JSON.parse(readFileSync(registryPath(env), "utf8"));
  expect(reg.repos).toEqual([
    { path: "/b", lastSeen: 2 },
    { path: "/a", lastSeen: 3 },
  ]);
});
