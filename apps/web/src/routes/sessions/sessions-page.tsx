import { useDeck } from "@/lib/store";
import { SessionsGrid } from "./sessions-grid";

export function SessionsPage() {
  const sessions = useDeck((s) => s.sessions);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Sessions</h2>
      <SessionsGrid sessions={sessions} />
    </section>
  );
}
