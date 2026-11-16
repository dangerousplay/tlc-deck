import { useDeck } from "@/lib/store";
import { RunsTable } from "./runs-table";

export function Overview() {
  const runs = useDeck((s) => s.runs);
  return (
    <div className="space-y-8">
      <section id="runs" className="space-y-3">
        <h2 className="text-lg font-semibold">Runs</h2>
        <RunsTable runs={runs} />
      </section>
      <section id="sessions" className="space-y-3">
        <h2 className="text-lg font-semibold">Sessions</h2>
        <p className="text-sm text-muted-foreground">No live sessions.</p>
      </section>
    </div>
  );
}
