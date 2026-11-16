import { fold, groupByRun, newestActiveRun, readEvents, tail } from "@tlc-deck/core";
import type { RunState, TlcEvent } from "@tlc-deck/protocol";
import { render, Text } from "ink";
import { exitCodeFor, formatEventLine, isTerminal, summaryLines } from "./model.js";
import { WatchView } from "./view.js";

export interface WatchOptions {
  /** Absolute path of progress.ndjson. */
  file: string;
  run?: string;
  tty: boolean;
  stdout: (text: string) => void;
  signal?: AbortSignal;
  now?: () => number;
  /** Passed to ink's render (tests may supply fake streams). */
  inkStdout?: NodeJS.WriteStream;
}

/** Run to follow: --run id, else newest active run, else newest run, else the first one to appear. */
function pickRunId(events: TlcEvent[], flag: string | undefined, now: number): string | undefined {
  if (flag) return flag;
  if (events.length === 0) return undefined;
  const runs = [...groupByRun(events).keys()].map((runId) => fold(events, { runId, now }));
  const byRecency = (r: RunState) => r.lastEventAt ?? r.startedAt ?? 0;
  const sorted = [...runs].sort((a, b) => byRecency(b) - byRecency(a));
  return (newestActiveRun(sorted) ?? sorted[0])?.runId;
}

const LOG_LIMIT = 5;

/** `tlc watch`: follows the NDJSON file until the chosen run ends. Resolves to the exit code. */
export async function runWatch(opts: WatchOptions): Promise<number> {
  const clock = opts.now ?? Date.now;
  let runId = pickRunId(readEvents(opts.file), opts.run, clock());
  const events: TlcEvent[] = [];
  const logs: string[] = [];
  let harness: string | undefined;
  let tick = 0;
  let ended = false;

  const stop = new AbortController();
  opts.signal?.addEventListener("abort", () => stop.abort());

  const current = (): RunState => fold(events, { runId: runId ?? "", now: clock() });
  const frame = () => (
    <WatchView run={current()} harness={harness} logs={logs} now={clock()} tick={tick} />
  );

  let instance: ReturnType<typeof render> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let result = 0;
  let userExit = false;

  const finish = (code: number) => {
    if (ended) return;
    ended = true;
    result = code;
    stop.abort();
  };

  const onEvent = (ev: TlcEvent) => {
    if (ended) return;
    if (runId === undefined) runId = ev.metadata.runId;
    if (ev.metadata.runId !== runId) return;
    events.push(ev);
    harness ??= ev.metadata.harness;
    if (!opts.tty) opts.stdout(`${formatEventLine(ev)}\n`);
    else {
      if (ev.type === "CUSTOM" && ev.name === "tlc.log") {
        const v = ev.value as { level?: string; message?: string };
        logs.push(`${v.level ?? "info"}: ${v.message ?? ""}`);
        if (logs.length > LOG_LIMIT) logs.shift();
      }
      instance?.rerender(frame());
    }
    if (isTerminal(ev)) finish(exitCodeFor(current()));
  };

  if (opts.tty) {
    instance = render(
      events.length === 0 ? <Text>waiting for events...</Text> : frame(),
      opts.inkStdout ? { stdout: opts.inkStdout } : undefined,
    );
    timer = setInterval(() => {
      tick++;
      if (runId !== undefined && events.length > 0) instance?.rerender(frame());
    }, 500);
    void instance.waitUntilExit().then(
      () => {
        if (!ended) {
          userExit = true;
          finish(130);
        }
      },
      () => {},
    );
  }

  await tail(opts.file, onEvent, { signal: stop.signal });
  if (timer) clearInterval(timer);
  if (opts.signal?.aborted && !ended) result = 130;
  if (instance) {
    if (events.length > 0) instance.rerender(frame());
    if (!userExit) instance.unmount();
    await instance.waitUntilExit().catch(() => {});
  }
  if (events.length > 0 && !(opts.signal?.aborted && result === 130)) {
    for (const l of summaryLines(current(), clock())) opts.stdout(`${l}\n`);
  }
  return result;
}
