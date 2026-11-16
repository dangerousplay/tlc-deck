import { useDeck } from "@/lib/store";
import { SessionsGrid } from "./sessions-grid";

export function SessionsPage() {
  const sessions = useDeck((s) => s.sessions);
  return (
    <section className="mx-auto max-w-7xl space-y-3">
      <h2 className="text-base font-semibold">Live sessions</h2>
      <SessionsGrid sessions={sessions} />
    </section>
  );
}
