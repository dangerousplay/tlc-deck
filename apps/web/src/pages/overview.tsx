import { Activity, AlertTriangle, CircleDollarSign, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCost, isToday, openBlockers, runCost } from "@/lib/format";
import { useDeck } from "@/lib/store";
import { SessionsGrid } from "@/routes/sessions/sessions-grid";
import { RunsTable } from "./runs-table";

function Kpi({
  label,
  value,
  hint,
  icon,
  testId,
}: {
  label: string;
  value: ReactNode;
  hint: string;
  icon: ReactNode;
  testId: string;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardDescription>{label}</CardDescription>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent className="px-4">
        <div className="text-2xl font-semibold tabular-nums" data-testid={testId}>
          {value}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export function Overview() {
  const runs = useDeck((s) => s.runs);
  const sessions = useDeck((s) => s.sessions);
  const connection = useDeck((s) => s.connection);
  const loading = connection === "connecting" && runs.length === 0 && sessions.length === 0;
  const now = Date.now();
  const active = runs.filter((r) => r.status === "running").length;
  const working = sessions.filter((s) => s.state === "working").length;
  const waiting = sessions.filter((s) => s.state === "waiting").length;
  const blockers = runs.reduce((n, r) => n + openBlockers(r), 0);
  const cost =
    runs.filter((r) => isToday(r.startedAt, now)).reduce((n, r) => n + (runCost(r) ?? 0), 0) +
    sessions
      .filter((s) => !s.linkedRun && isToday(s.startedAt, now))
      .reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading ? (
          ["a", "b", "c", "d"].map((k) => <Skeleton key={k} className="h-[112px] rounded-xl" />)
        ) : (
          <>
            <Kpi
              testId="kpi-active"
              label="Active runs"
              value={active}
              hint={`${runs.length} total`}
              icon={<Activity className="size-4" />}
            />
            <Kpi
              testId="kpi-sessions"
              label="Live sessions"
              value={
                <>
                  {working}{" "}
                  <span className="text-base font-normal text-muted-foreground">working</span> /{" "}
                  {waiting}{" "}
                  <span className="text-base font-normal text-muted-foreground">waiting</span>
                </>
              }
              hint={`${sessions.length} tracked`}
              icon={<Radio className="size-4" />}
            />
            <Kpi
              testId="kpi-blockers"
              label="Open blockers"
              value={blockers}
              hint={blockers > 0 ? "needs attention" : "all clear"}
              icon={<AlertTriangle className="size-4" />}
            />
            <Kpi
              testId="kpi-cost"
              label="Cost today"
              value={formatCost(cost)}
              hint="runs and unlinked sessions"
              icon={<CircleDollarSign className="size-4" />}
            />
          </>
        )}
      </div>
      <Card id="runs" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardDescription>Orchestrated feature runs across repositories</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-40 w-full" /> : <RunsTable runs={runs} now={now} />}
        </CardContent>
      </Card>
      <section id="sessions" className="space-y-3">
        <h2 className="text-base font-semibold">Sessions</h2>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-36 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        ) : (
          <SessionsGrid sessions={sessions} />
        )}
      </section>
    </div>
  );
}
