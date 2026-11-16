import type { RunState } from "@tlc-deck/protocol";
import { ListChecks } from "lucide-react";
import { EmptyState, RunStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  elapsed,
  formatCost,
  milestoneProgress,
  openBlockers,
  runCost,
  taskProgress,
  timeAgo,
} from "@/lib/format";

function pct(frac: string): number {
  const [a, b] = frac.split("/").map(Number);
  return b ? ((a ?? 0) / b) * 100 : 0;
}

function ProgressCell({ text, testId }: { text: string; testId: string }) {
  return (
    <TableCell data-testid={testId}>
      <div className="flex min-w-28 items-center gap-2">
        <Progress value={pct(text)} className="h-1.5 flex-1" />
        <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{text}</span>
      </div>
    </TableCell>
  );
}

export function RunsTable({ runs, now = Date.now() }: { runs: RunState[]; now?: number }) {
  if (runs.length === 0) {
    return <EmptyState icon={ListChecks}>No runs yet.</EmptyState>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Repo / feature</TableHead>
          <TableHead>Harness</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Milestones</TableHead>
          <TableHead>Tasks</TableHead>
          <TableHead>Blockers</TableHead>
          <TableHead>Elapsed</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => {
          const blockers = openBlockers(r);
          return (
            <TableRow key={r.runId} data-testid="run-row">
              <TableCell className="font-mono text-xs">
                <a
                  href={`/runs/${encodeURIComponent(r.runId)}`}
                  className="font-medium hover:underline"
                >
                  {r.runId}
                </a>
              </TableCell>
              <TableCell>
                <div className="font-medium" data-testid="repo">
                  {r.repo ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground" data-testid="feature">
                  {r.feature ?? "—"}
                </div>
              </TableCell>
              <TableCell data-testid="harness">
                {r.harness ? <Badge variant="secondary">{r.harness}</Badge> : "—"}
              </TableCell>
              <TableCell>
                <RunStatusBadge status={r.status} />
              </TableCell>
              <ProgressCell text={milestoneProgress(r)} testId="milestones" />
              <ProgressCell text={taskProgress(r)} testId="tasks" />
              <TableCell data-testid="blockers" className="tabular-nums">
                {blockers > 0 ? (
                  <Badge
                    variant="outline"
                    className="border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                  >
                    {blockers}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </TableCell>
              <TableCell className="tabular-nums">
                <div>{elapsed(r, now)}</div>
                <div className="text-xs text-muted-foreground">{timeAgo(r.startedAt, now)}</div>
              </TableCell>
              <TableCell data-testid="cost" className="text-right tabular-nums">
                {formatCost(runCost(r))}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
