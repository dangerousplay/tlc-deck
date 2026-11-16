import { useDeck } from "@/lib/store";
import { SessionsGrid } from "@/routes/sessions/sessions-grid";
import { RunsTable } from "./runs-table";

export function Overview() {
  const runs = useDeck((s) => s.runs);
  const sessions = useDeck((s) => s.sessions);
  return (
    <div className="space-y-8">
      <section id="runs" className="space-y-3">
        <h2 className="text-lg font-semibold">Runs</h2>
        <RunsTable runs={runs} />
      </section>
      <section id="sessions" className="space-y-3">
        <h2 className="text-lg font-semibold">Sessions</h2>
        <SessionsGrid sessions={sessions} />
      </section>
    </div>
  );
}
