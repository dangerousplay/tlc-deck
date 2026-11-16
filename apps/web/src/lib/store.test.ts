import { afterEach, describe, expect, test, vi } from "vitest";
import { connectStore, useDeck } from "./store";

class FakeES {
  static all: FakeES[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  closed = false;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(t: string, f: (e: MessageEvent) => void) {
    this.listeners.set(t, f);
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  FakeES.all = [];
  vi.useRealTimers();
});

describe("connectStore", () => {
  test("snapshot fills runs; error reconnects", () => {
    vi.useFakeTimers();
    const dispose = connectStore({
      EventSourceCtor: FakeES as unknown as typeof EventSource,
      reconnectMs: 100,
    });
    const first = FakeES.all[0];
    first?.listeners.get("STATE_SNAPSHOT")?.({
      data: JSON.stringify({ snapshot: { runs: [{ runId: "r" }] } }),
    } as MessageEvent);
    expect(useDeck.getState().runs).toHaveLength(1);
    expect(useDeck.getState().connection).toBe("open");
    first?.onerror?.();
    expect(useDeck.getState().connection).toBe("closed");
    vi.advanceTimersByTime(100);
    expect(FakeES.all).toHaveLength(2);
    dispose();
    expect(FakeES.all[1]?.closed).toBe(true);
  });
});
