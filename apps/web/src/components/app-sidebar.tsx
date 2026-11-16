import { LayoutDashboard, ListChecks, MonitorDot } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const NAV = [
  { label: "Overview", href: "/", icon: LayoutDashboard, match: (p: string) => p === "/" },
  { label: "Runs", href: "/#runs", icon: ListChecks, match: (p: string) => p.startsWith("/runs") },
  {
    label: "Sessions",
    href: "/sessions",
    icon: MonitorDot,
    match: (p: string) => p.startsWith("/sessions"),
  },
];

export function AppSidebar({ path }: { path: string }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground">
                  tlc
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">tlc deck</span>
                  <span className="truncate text-xs text-muted-foreground">live progress</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu aria-label="Main">
              {NAV.map((n) => (
                <SidebarMenuItem key={n.label}>
                  <SidebarMenuButton
                    asChild
                    tooltip={n.label}
                    isActive={n.label !== "Runs" && n.match(path)}
                  >
                    <a href={n.href}>
                      <n.icon />
                      <span>{n.label}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <p className="px-2 text-xs text-muted-foreground">Read-only dashboard</p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
