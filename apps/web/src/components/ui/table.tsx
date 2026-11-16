import type * as React from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}
export const TableHeader = (p: React.ComponentProps<"thead">) => <thead {...p} />;
export const TableBody = (p: React.ComponentProps<"tbody">) => <tbody {...p} />;
export const TableRow = ({ className, ...p }: React.ComponentProps<"tr">) => (
  <tr className={cn("border-b", className)} {...p} />
);
export const TableHead = ({ className, ...p }: React.ComponentProps<"th">) => (
  <th className={cn("px-3 py-2 text-left font-medium text-muted-foreground", className)} {...p} />
);
export const TableCell = ({ className, ...p }: React.ComponentProps<"td">) => (
  <td className={cn("px-3 py-2", className)} {...p} />
);
