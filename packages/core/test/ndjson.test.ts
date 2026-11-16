import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TlcEvent } from "@tlc-deck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendEvent, readEvents, tail } from "../src/ndjson.js";

const meta = (runId: string, extra = {}) => ({
  v: 1,
  runId,
  threadId: "repo#f",
  harness: "claude-code",
  driver: "workflow",
  source: "test",
  ...extra,
});
const ev = (runId: string, n = 0) => ({
  type: "CUSTOM",
  timestamp: 1,
  name: "tlc.log",
  value: { level: "info", message: `m${n}` },
  metadata: meta(runId),
});
const wireLine = (runId: string, seq: number) =>
  JSON.stringify({ ...ev(runId), metadata: meta(runId, { seq }) });

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlc-ndjson-"));
  file = join(dir, "progress.ndjson");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await sleep(20);
  }
}

describe("appendEvent / readEvents", () => {
  test("assigns increasing seq per run", () => {
    expect(appendEvent(file, ev("a")).metadata.seq).toBe(1);
    expect(appendEvent(file, ev("a")).metadata.seq).toBe(2);
    expect(appendEvent(file, ev("b")).metadata.seq).toBe(1);
    expect(appendEvent(file, ev("a")).metadata.seq).toBe(3);
    expect(readEvents(file).map((e) => e.metadata.seq)).toEqual([1, 2, 1, 3]);
  });

  test("readEvents tolerates missing file and bad lines", () => {
    expect(readEvents(file)).toEqual([]);
    appendEvent(file, ev("a"));
    appendFileSync(file, "garbage\n");
    appendEvent(file, ev("a"));
    expect(readEvents(file)).toHaveLength(2);
  });

  test("lock file is released", () => {
    appendEvent(file, ev("a"));
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("4 concurrent processes keep unique increasing seq and whole lines", async () => {
    const root = resolve(import.meta.dirname, "..");
    const built = join(root, "dist", "ndjson.js");
    if (!existsSync(built)) execFileSync("pnpm", ["build"], { cwd: root, stdio: "ignore" });
    const script = `
      import { appendEvent } from ${JSON.stringify(pathToFileURL(built).href)};
      const [file, who] = process.argv.slice(1);
      for (let i = 0; i < 25; i++) appendEvent(file, {
        type: "CUSTOM", timestamp: 1, name: "tlc.log", value: { level: "info", message: who + ":" + i + ":" + "x".repeat(2000) },
        metadata: { v: 1, runId: "run", threadId: "t", harness: "h", driver: "d", source: who },
      });`;
    const procs = ["p1", "p2", "p3", "p4"].map(
      (who) =>
        new Promise<number | null>((res) => {
          const c = spawn(process.execPath, ["--input-type=module", "-e", script, file, who], {
            stdio: "inherit",
          });
          c.on("exit", res);
        }),
    );
    expect(await Promise.all(procs)).toEqual([0, 0, 0, 0]);
    const raw = (await import("node:fs")).readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(100);
    const seqs = lines.map((l) => (JSON.parse(l) as TlcEvent).metadata.seq);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  }, 60_000);
});

describe("tail", () => {
  async function run(opts: { fromEnd?: boolean } = {}) {
    const got: number[] = [];
    const ac = new AbortController();
    const done = tail(file, (e) => got.push(e.metadata.seq), {
      signal: ac.signal,
      pollMs: 20,
      ...opts,
    });
    return {
      got,
      stop: async () => {
        ac.abort();
        return done;
      },
    };
  }

  test("delivers existing then new events; fromEnd skips existing", async () => {
    appendEvent(file, ev("a"));
    const t = await run();
    const t2 = await run({ fromEnd: true });
    await until(() => t.got.length === 1);
    appendEvent(file, ev("a"));
    await until(() => t.got.length === 2 && t2.got.length === 1);
    expect(t.got).toEqual([1, 2]);
    expect(t2.got).toEqual([2]);
    await t.stop();
    await t2.stop();
  });

  test("waits for a file that does not exist yet", async () => {
    const t = await run();
    await sleep(60);
    appendEvent(file, ev("a"));
    await until(() => t.got.length === 1);
    await t.stop();
  });

  test("buffers partial lines", async () => {
    const t = await run();
    const l = wireLine("a", 1);
    appendFileSync(file, l.slice(0, 30));
    await sleep(100);
    expect(t.got).toEqual([]);
    appendFileSync(file, `${l.slice(30)}\n`);
    await until(() => t.got.length === 1);
    await t.stop();
  });

  test("survives truncation", async () => {
    const t = await run();
    appendFileSync(file, `${wireLine("a", 1)}\n${wireLine("a", 2)}\n`);
    await until(() => t.got.length === 2);
    writeFileSync(file, `${wireLine("b", 7)}\n`);
    await until(() => t.got.length === 3);
    expect(t.got).toEqual([1, 2, 7]);
    await t.stop();
  });

  test("survives file replacement", async () => {
    const t = await run();
    appendFileSync(file, `${wireLine("a", 1)}\n${wireLine("a", 2)}\n${wireLine("a", 3)}\n`);
    await until(() => t.got.length === 3);
    const next = join(dir, "next.ndjson");
    writeFileSync(
      next,
      `${wireLine("c", 8)}\n${wireLine("c", 9)}\n${wireLine("c", 10)}\n${wireLine("c", 11)}\n`,
    );
    renameSync(next, file);
    await until(() => t.got.length === 7);
    expect(t.got.slice(3)).toEqual([8, 9, 10, 11]);
    await t.stop();
  });

  test("abort resolves", async () => {
    const t = await run();
    await t.stop();
  });
});
