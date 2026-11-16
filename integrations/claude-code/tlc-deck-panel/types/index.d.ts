export type TlcTask = {
  id: string;
  title?: string;
  status: string;
  stage?: string;
  attempt?: number;
};
export type TlcUsage = { costUsd: number | null };

/** The object `tlc status --json` prints (a folded RunState subset). */
export type TlcRun = {
  runId: string;
  status: string;
  tasks: Record<string, TlcTask>;
  milestones: { name: string; reached: boolean }[];
  blockers: {
    id: string;
    task: string;
    kind: string;
    reason: string;
    advice?: string;
    open: boolean;
  }[];
  usageByRole: Record<string, TlcUsage>;
};

declare module "claude-code" {
  interface PluginState {
    "tlc-deck-panel": { run: Shaped<TlcRun | null> };
  }
}
