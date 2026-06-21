/**
 * Application Sidebar Component
 * Config-driven navigation with shadcn Sidebar and collapsed mode with tooltips
 */

import React from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Home,
  Zap,
  BarChart3,
  Settings,
  Shield,
  Users,
  RefreshCw,
  ClipboardList,
  Trash2,
  ArrowLeft,
  BookOpen,
  ExternalLink,
  FileCode,
  StickyNote,
  TrendingUp,
  Package,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { UserMenu } from "./UserMenu";
import { cn } from "@/lib/utils";
import { useFeatures } from "@/hooks/useFeatures";
import { ROUTES } from "@/constants/routes";

// Icon mapping for routes
const iconMap: Record<string, LucideIcon> = {
  // Main app icons
  "🏠": Home,
  "⚡": Zap,
  "📊": BarChart3,
  "⚙️": Settings,
  "🔧": Shield,
  "📚": BookOpen,
  "📝": StickyNote,
  "📄": FileCode,
  // Admin icons
  "📈": TrendingUp,
  "👥": Users,
  "🔄": RefreshCw,
  "📦": Package,
  "📋": ClipboardList,
  "🗑️": Trash2,
  "←": ArrowLeft,
};

export interface NavRoute {
  path: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  multiUserAdmin?: boolean; // Hidden when the multiUserAdmin feature is off (self-host)
  external?: boolean;
  sameWindow?: boolean; // For external links that should open in same window (e.g., Back to App)
}

interface AppSidebarProps {
  routes: NavRoute[];
  isAdmin?: boolean;
  title?: string;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  routes,
  isAdmin = false,
  title = "MCP Moira",
}) => {
  const location = useLocation();
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const { isEnabled: isFeatureEnabled } = useFeatures();
  const multiUserAdmin = isFeatureEnabled("multiUserAdmin");

  const filteredRoutes = routes.filter(
    (route) => (!route.adminOnly || isAdmin) && (!route.multiUserAdmin || multiUserAdmin),
  );

  const isRouteActive = (path: string) => {
    // Exact match for index routes (dashboard and admin root)
    if (path === ROUTES.DASHBOARD || path === ROUTES.ADMIN) {
      return location.pathname === path;
    }
    // Prefix match for nested routes
    return location.pathname.startsWith(path);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-2",
            isCollapsed ? "justify-center" : "justify-between",
          )}
        >
          {!isCollapsed && (
            <h1 className="text-lg font-semibold text-sidebar-foreground flex items-center gap-2">
              <Zap className="h-5 w-5" />
              {title}
            </h1>
          )}
          <SidebarTrigger className={cn(isCollapsed && "mx-auto")} />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {filteredRoutes.map((route) => {
                const Icon = iconMap[route.icon] || Home;
                const isActive = !route.external && isRouteActive(route.path);

                // External links - may open in new tab or same window
                if (route.external) {
                  const openInNewTab = !route.sameWindow;
                  return (
                    <SidebarMenuItem key={route.path}>
                      <SidebarMenuButton asChild tooltip={route.label}>
                        <a
                          href={route.path}
                          target={openInNewTab ? "_blank" : undefined}
                          rel={openInNewTab ? "noopener noreferrer" : undefined}
                          className="flex items-center gap-2"
                        >
                          <Icon className="h-4 w-4" />
                          <span className="flex-1">{route.label}</span>
                          {!isCollapsed && openInNewTab && (
                            <ExternalLink className="h-3 w-3 text-muted-foreground" />
                          )}
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                }

                return (
                  <SidebarMenuItem key={route.path}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={route.label}>
                      <NavLink to={route.path}>
                        <Icon className="h-4 w-4" />
                        <span>{route.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <UserMenu compact={isCollapsed} />
      </SidebarFooter>
    </Sidebar>
  );
};
