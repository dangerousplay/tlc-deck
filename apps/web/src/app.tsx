import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { connectStore, useDeck } from "@/lib/store";
import { NEXT, useTheme } from "@/lib/theme";
import { Overview } from "@/pages/overview";
import { RunPage } from "@/routes/run/run-page";
import { SessionPage } from "@/routes/sessions/session-page";
import { SessionsPage } from "@/routes/sessions/sessions-page";

const NAV = [
  { label: "Overview", href: "/" },
  { label: "Runs", href: "/#runs" },
  { label: "Sessions", href: "/sessions" },
];

const ICON = { light: Sun, dark: Moon, system: Monitor };

export function App({
  connect = true,
  path = window.location.pathname,
}: {
  connect?: boolean;
  path?: string;
}) {
  const [theme, setTheme] = useTheme();
  const connection = useDeck((s) => s.connection);
  useEffect(() => (connect ? connectStore() : undefined), [connect]);
  const Icon = ICON[theme];
  const runId = /^\/runs\/([^/]+)/.exec(path)?.[1];
  const sessionId = /^\/sessions\/([^/]+)/.exec(path)?.[1];
  const sessionsList = /^\/sessions\/?$/.test(path);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex items-center gap-4 border-b p-3 md:w-52 md:flex-col md:items-stretch md:border-r md:border-b-0">
        <span className="font-semibold">tlc deck</span>
        <nav className="flex gap-2 md:flex-col" aria-label="Main">
          {NAV.map((n) => (
            <a key={n.label} href={n.href} className="rounded-md px-2 py-1 text-sm hover:bg-muted">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-0 md:mt-auto">
          <span className="text-xs text-muted-foreground" data-testid="connection">
            {connection}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Theme: ${theme}`}
            onClick={() => setTheme(NEXT[theme])}
          >
            <Icon className="size-4" />
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-6">
        {runId ? (
          <RunPage id={decodeURIComponent(runId)} />
        ) : sessionId ? (
          <SessionPage id={decodeURIComponent(sessionId)} />
        ) : sessionsList ? (
          <SessionsPage />
        ) : (
          <Overview />
        )}
      </main>
    </div>
  );
}
