import type { RunState, RunStatus } from "@tlc-deck/protocol";
import { Badge } from "@/components/ui/badge";
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
} from "@/lib/format";

const VARIANT: Record<RunStatus, "default" | "success" | "destructive" | "warning" | "secondary"> =
  {
    running: "default",
    finished: "success",
    failed: "destructive",
    interrupted: "warning",
    stale: "secondary",
  };

export function RunsTable({ runs, now = Date.now() }: { runs: RunState[]; now?: number }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Milestones</TableHead>
          <TableHead>Tasks</TableHead>
          <TableHead>Blockers</TableHead>
          <TableHead>Elapsed</TableHead>
          <TableHead>Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.runId} data-testid="run-row">
            <TableCell className="font-mono">
              <a href={`/runs/${encodeURIComponent(r.runId)}`} className="hover:underline">
                {r.runId}
              </a>
            </TableCell>
            <TableCell>
              <Badge variant={VARIANT[r.status]} data-testid="status">
                {r.status}
              </Badge>
            </TableCell>
            <TableCell data-testid="milestones">{milestoneProgress(r)}</TableCell>
            <TableCell data-testid="tasks">{taskProgress(r)}</TableCell>
            <TableCell data-testid="blockers">{openBlockers(r)}</TableCell>
            <TableCell>{elapsed(r, now)}</TableCell>
            <TableCell data-testid="cost">{formatCost(runCost(r))}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
