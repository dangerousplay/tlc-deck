import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch,
  writeSync,
} from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { parseLine, type TlcEvent } from "@tlc-deck/protocol";

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // lock vanished or was replaced; retry
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`timed out locking ${lock}`);
      sleepSync(5 + Math.random() * 10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already removed
    }
  }
}

/** Input event: `metadata.seq` is optional and always overwritten. */
export type NewEvent = Omit<TlcEvent, "metadata"> & {
  metadata: { runId: string; seq?: number } & Record<string, unknown>;
};

/**
 * Append one event as a single line. Takes `<file>.lock`, assigns the next `seq` for the
 * event's runId (max existing + 1, starting at 1) and appends the whole line in one write.
 * Returns the event as written.
 */
export function appendEvent(file: string, event: NewEvent): TlcEvent {
  mkdirSync(dirname(file), { recursive: true });
  return withLock(file, () => {
    let max = 0;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const runId = event.metadata.runId;
    for (const line of text.split("\n")) {
      if (!line.includes(runId)) continue;
      const r = parseLine(line);
      if (r.ok && r.event.metadata.runId === runId) max = Math.max(max, r.event.metadata.seq);
    }
    const out = { ...event, metadata: { ...event.metadata, seq: max + 1 } } as TlcEvent;
    // Never glue onto a previous partial line.
    const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    appendFileSync(file, `${prefix}${JSON.stringify(out)}\n`);
    return out;
  });
}

/** Read all valid events of a file in file order. Missing file gives []. Invalid lines are skipped. */
export function readEvents(file: string): TlcEvent[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: TlcEvent[] = [];
  for (const line of text.split("\n")) {
    const r = parseLine(line);
    if (r.ok) events.push(r.event);
  }
  return events;
}

export interface TailOptions {
  signal?: AbortSignal;
  /** Skip events already in the file and only deliver new ones. Default false. */
  fromEnd?: boolean;
  pollMs?: number;
  onInvalid?: (line: string, reason: string) => void;
}

/**
 * Follow a file (DD-05): fs.watch + stat poll, byte offset, partial-line buffer, reset to 0 on
 * truncation or inode change. Resolves when `signal` aborts.
 */
export function tail(
  file: string,
  onEvent: (event: TlcEvent) => void,
  opts: TailOptions = {},
): Promise<void> {
  const { signal, pollMs = 250 } = opts;
  return new Promise<void>((resolve) => {
    let offset = 0;
    let ino: number | undefined;
    let partial: Buffer = Buffer.alloc(0);
    let busy = false;
    let again = false;
    let first = true;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let done = false;

    const emitLines = (chunk: Buffer) => {
      let buf = partial.length ? Buffer.concat([partial, chunk]) : chunk;
      let nl = buf.indexOf(0x0a);
      while (nl !== -1) {
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        if (line.trim()) {
          const r = parseLine(line);
          if (r.ok) onEvent(r.event);
          else opts.onInvalid?.(line, r.reason);
        }
        nl = buf.indexOf(0x0a);
      }
      partial = Buffer.from(buf);
    };

    const poll = async () => {
      if (done) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          let st: Awaited<ReturnType<typeof stat>>;
          try {
            st = await stat(file);
          } catch {
            // missing: wait for it to appear; a new file starts from 0
            ino = undefined;
            offset = 0;
            partial = Buffer.alloc(0);
            first = false;
            continue;
          }
          if (first) {
            first = false;
            ino = st.ino;
            if (opts.fromEnd) {
              offset = st.size;
              continue;
            }
          }
          if (ino !== undefined && st.ino !== ino) {
            offset = 0;
            partial = Buffer.alloc(0);
          } else if (st.size < offset) {
            offset = 0;
            partial = Buffer.alloc(0);
          }
          ino = st.ino;
          if (st.size > offset) {
            const fh = await open(file, "r");
            try {
              const len = st.size - offset;
              const buf = Buffer.alloc(len);
              const { bytesRead } = await fh.read(buf, 0, len, offset);
              offset += bytesRead;
              emitLines(buf.subarray(0, bytesRead));
            } finally {
              await fh.close();
            }
          }
        } while (again && !done);
      } catch {
        // transient fs error; next tick retries
      } finally {
        busy = false;
      }
    };

    const startWatcher = () => {
      try {
        watcher = watch(dirname(file), { persistent: true }, () => void poll());
        watcher.on("error", () => {});
      } catch {
        // polling alone is enough
      }
    };

    const stop = () => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      watcher?.close();
      signal?.removeEventListener("abort", stop);
      resolve();
    };

    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop);
    startWatcher();
    timer = setInterval(() => void poll(), pollMs);
    void poll();
  });
}
