import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { connectStore, useDeck } from "@/lib/store";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Overview } from "@/pages/overview";
import { RunPage } from "@/routes/run/run-page";
import { SessionPage } from "@/routes/sessions/session-page";
import { SessionsPage } from "@/routes/sessions/sessions-page";
import { TaskPage } from "@/routes/task/task-page";

const ICON = { light: Sun, dark: Moon, system: Monitor };
const THEMES: Theme[] = ["light", "dark", "system"];

function ConnectionIndicator() {
  const connection = useDeck((s) => s.connection);
  const open = connection === "open";
  return (
    <div className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs">
      <span className="relative flex size-2">
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60",
            open ? "bg-emerald-500" : "bg-amber-500",
          )}
        />
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            open ? "bg-emerald-500" : "bg-amber-500",
          )}
        />
      </span>
      <span className="text-muted-foreground" data-testid="connection">
        {connection}
      </span>
    </div>
  );
}

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <fieldset className="flex items-center gap-0.5 rounded-lg border p-0.5" aria-label="Theme">
      {THEMES.map((t) => {
        const Icon = ICON[t];
        return (
          <Button
            key={t}
            variant={theme === t ? "secondary" : "ghost"}
            size="icon"
            className="size-7"
            aria-label={`Theme: ${t}`}
            aria-pressed={theme === t}
            title={t}
            onClick={() => setTheme(t)}
          >
            <Icon className="size-3.5" />
          </Button>
        );
      })}
    </fieldset>
  );
}

function titleFor(path: string): string {
  if (/^\/runs\/[^/]+\/tasks\//.test(path)) return "Task detail";
  if (/^\/runs\//.test(path)) return "Run detail";
  if (/^\/sessions\/[^/]+/.test(path)) return "Session detail";
  if (/^\/sessions\/?$/.test(path)) return "Sessions";
  return "Overview";
}

export function App({
  connect = true,
  path = window.location.pathname,
}: {
  connect?: boolean;
  path?: string;
}) {
  const [theme, setTheme] = useTheme();
  useEffect(() => (connect ? connectStore() : undefined), [connect]);
  const taskRoute = /^\/runs\/([^/]+)\/tasks\/([^/]+)/.exec(path);
  const runId = /^\/runs\/([^/]+)/.exec(path)?.[1];
  const sessionId = /^\/sessions\/([^/]+)/.exec(path)?.[1];
  const sessionsList = /^\/sessions\/?$/.test(path);
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar path={path} />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 h-4" />
            <h1 className="text-sm font-semibold">{titleFor(path)}</h1>
            <div className="ml-auto flex items-center gap-2">
              <ConnectionIndicator />
              <ThemeToggle theme={theme} setTheme={setTheme} />
            </div>
          </header>
          <main className="flex-1 p-4 md:p-6">
            {taskRoute?.[1] && taskRoute[2] ? (
              <TaskPage
                runId={decodeURIComponent(taskRoute[1])}
                taskId={decodeURIComponent(taskRoute[2])}
              />
            ) : runId ? (
              <RunPage id={decodeURIComponent(runId)} />
            ) : sessionId ? (
              <SessionPage id={decodeURIComponent(sessionId)} />
            ) : sessionsList ? (
              <SessionsPage />
            ) : (
              <Overview />
            )}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
