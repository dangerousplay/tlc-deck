import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureDaemon, health, pidfilePath, stopDaemon } from "../src/daemon.js";
import { type Io, run } from "../src/main.js";

let root: string;
let env: Record<string, string>;
let port: number;
const pids = new Set<number>();

const FAKE = `
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((q, r) => {
  r.setHeader("content-type", "application/json");
  r.end(JSON.stringify({ app: "tlc-deck", version: "t", pid: process.pid }));
}).listen(port, "127.0.0.1");
`;

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tlc-daemon-"));
  port = await freePort();
  env = {
    HOME: root,
    TLC_STATE_DIR: join(root, "state"),
    TLC_PORT: String(port),
    PATH: process.env.PATH ?? "",
  };
  writeFileSync(join(root, "fake.mjs"), FAKE);
});
afterEach(async () => {
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  pids.clear();
  rmSync(root, { recursive: true, force: true });
});

const cliPath = () => join(root, "fake.mjs");

test("ensure starts one daemon, second reuses it", async () => {
  const a = await ensureDaemon({ env, cliPath: cliPath() });
  expect(a.ok && a.started).toBe(true);
  pids.add(a.pid as number);
  const b = await ensureDaemon({ env, cliPath: cliPath() });
  expect(b).toMatchObject({ ok: true, started: false, pid: a.pid });
});

test("two concurrent ensures yield one pid", async () => {
  const [a, b] = await Promise.all([
    ensureDaemon({ env, cliPath: cliPath() }),
    ensureDaemon({ env, cliPath: cliPath() }),
  ]);
  pids.add(a.pid as number);
  expect(a.ok && b.ok).toBe(true);
  expect(a.pid).toBe(b.pid);
  expect([a.started, b.started].filter(Boolean)).toHaveLength(1);
});

test("stop kills only our pid", async () => {
  const a = await ensureDaemon({ env, cliPath: cliPath() });
  pids.add(a.pid as number);
  // pidfile names an unrelated pid (this test process): must not be signalled
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    pidfilePath(env),
    JSON.stringify({ pid: process.pid, port, version: "t", startedAt: 0 }),
  );
  const r = await stopDaemon(env);
  expect(r.stopped).toBe(false);
  expect(await health(port)).toBeDefined();
  // matching pidfile: stopped
  writeFileSync(pidfilePath(env), JSON.stringify({ pid: a.pid, port, version: "t", startedAt: 0 }));
  expect((await stopDaemon(env)).stopped).toBe(true);
  expect(await health(port)).toBeUndefined();
});

test("serve refuses a second instance, --force does not", async () => {
  const a = await ensureDaemon({ env, cliPath: cliPath() });
  pids.add(a.pid as number);
  let out = "";
  const io: Io = {
    cwd: root,
    env,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      out += t;
    },
    version: "0",
  };
  expect(await run(["serve", "--port", String(port)], io)).toBe(0);
  expect(out).toContain("already running");
  expect(out).toContain(String(a.pid));
});

test("daemon status reports not running", async () => {
  let out = "";
  const io: Io = {
    cwd: root,
    env,
    stdout: (t) => {
      out += t;
    },
    stderr: () => {},
    version: "0",
  };
  expect(await run(["daemon", "status"], io)).toBe(1);
  expect(out).toContain("not running");
});

test("install --systemd writes the unit and calls systemctl; uninstall removes it", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "systemctl.log");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${log}\n`, { mode: 0o755 });
  let out = "";
  const io: Io = {
    cwd: root,
    env: { HOME: root, PATH: `${bin}:${process.env.PATH}`, TLC_URL: "off" },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      out += t;
    },
    version: "0",
  };
  expect(await run(["install", "claude-code", "--systemd"], io)).toBe(0);
  const unit = readFileSync(join(root, ".config/systemd/user/tlc-deck.service"), "utf8");
  expect(unit).toContain("ExecStart=");
  expect(unit).toContain(" serve\n");
  expect(readFileSync(log, "utf8")).toContain("--user enable --now tlc-deck.service");
  expect(await run(["uninstall", "claude-code", "--systemd"], io)).toBe(0);
  expect(readFileSync(log, "utf8")).toContain("--user disable --now tlc-deck.service");
  expect(out).toContain("removing");
});

test("installer adds the SessionStart ensure hook; uninstall removes it", async () => {
  const io: Io = {
    cwd: root,
    env: { HOME: root, PATH: "", TLC_URL: "off" },
    stdout: () => {},
    stderr: () => {},
    version: "0",
  };
  await run(["install", "claude-code", "--hooks"], io);
  const j = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  expect(j.hooks.SessionStart[1].hooks[0]).toEqual({
    type: "command",
    command: "tlc daemon ensure --quiet",
    timeout: 5,
    tlcDeck: true,
  });
  await run(["uninstall", "claude-code", "--hooks"], io);
  expect(() => readFileSync(join(root, ".claude/settings.json"))).toThrow();
});
