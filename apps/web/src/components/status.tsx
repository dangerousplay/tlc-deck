import type { RunStatus } from "@tlc-deck/protocol";
import {
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader2,
  type LucideIcon,
  PauseCircle,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SessionState } from "@/lib/store";
import { cn } from "@/lib/utils";

const TONE = {
  blue: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  green: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  red: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  muted: "border-transparent bg-muted text-muted-foreground",
} as const;

export type Tone = keyof typeof TONE;
export const toneClass = (t: Tone) => TONE[t];

const RUN: Record<RunStatus, { tone: Tone; icon: LucideIcon; spin?: boolean }> = {
  running: { tone: "blue", icon: Loader2, spin: true },
  finished: { tone: "green", icon: CheckCircle2 },
  failed: { tone: "red", icon: XCircle },
  interrupted: { tone: "amber", icon: PauseCircle },
  stale: { tone: "muted", icon: Clock },
};

export function RunStatusBadge({ status, testId }: { status: RunStatus; testId?: string }) {
  const { tone, icon: Icon, spin } = RUN[status];
  return (
    <Badge variant="outline" className={cn("gap-1", TONE[tone])} data-testid={testId ?? "status"}>
      <Icon className={cn(spin && "animate-spin")} aria-hidden />
      {status}
    </Badge>
  );
}

const SESSION: Record<SessionState, { tone: Tone; pulse?: boolean; outline?: boolean }> = {
  working: { tone: "blue", pulse: true },
  waiting: { tone: "amber" },
  idle: { tone: "muted" },
  ended: { tone: "muted", outline: true },
};

export function SessionStateBadge({ state }: { state: SessionState }) {
  const { tone, pulse, outline } = SESSION[state];
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        outline ? "border-border bg-transparent text-muted-foreground" : TONE[tone],
      )}
      data-testid="session-state"
    >
      <span className="relative flex size-1.5">
        {pulse && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        )}
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      {state}
    </Badge>
  );
}

export function EmptyState({
  icon: Icon = CircleDashed,
  children,
}: {
  icon?: LucideIcon;
  children: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center">
      <div className="rounded-full bg-muted p-2.5">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
