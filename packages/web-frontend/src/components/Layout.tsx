/**
 * Application Layout Component
 * Main layout structure with sidebar and content area
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  className?: string;
}

/**
 * Main application layout component
 */
export const Layout: React.FC<LayoutProps> = ({
  children,
  sidebar,
  header,
  footer,
  sidebarOpen = true,
  onToggleSidebar,
  className = "",
}) => {
  const { t } = useTranslation();

  return (
    <div className={cn("h-screen flex flex-col overflow-hidden bg-background", className)}>
      {header && <header>{header}</header>}

      <div className="flex flex-1 overflow-hidden">
        {sidebar && (
          <aside
            className={cn(
              "bg-card border-r border-border flex flex-col transition-all duration-200 ease-in-out overflow-hidden shrink-0",
              sidebarOpen ? "w-80" : "w-12",
            )}
          >
            <div
              className={cn(
                "border-b border-border bg-muted flex items-center transition-all duration-200",
                sidebarOpen ? "justify-between p-4" : "justify-center py-3 px-2",
              )}
            >
              {sidebarOpen ? (
                <>
                  <h1 className="text-lg font-semibold text-foreground m-0 flex items-center gap-2">
                    <span>⚡</span>
                    MCP Moira
                  </h1>
                  {onToggleSidebar && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onToggleSidebar}
                      title={t("layout.sidebar.collapse")}
                    >
                      ◀
                    </Button>
                  )}
                </>
              ) : (
                onToggleSidebar && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onToggleSidebar}
                    title={t("layout.sidebar.expand")}
                  >
                    ⚡
                  </Button>
                )
              )}
            </div>

            <div
              className={cn(
                "flex-1 transition-opacity duration-200",
                sidebarOpen ? "opacity-100" : "opacity-0 hidden",
              )}
            >
              {sidebar}
            </div>
          </aside>
        )}

        <main className="flex-1 flex flex-col relative overflow-hidden bg-muted/30">
          {!sidebarOpen && onToggleSidebar && (
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleSidebar}
              title={t("layout.sidebar.show")}
              className="absolute top-4 left-4 z-20 shadow-lg"
            >
              ▶
            </Button>
          )}

          <div className="flex-1 relative overflow-y-auto">{children}</div>
        </main>
      </div>

      {footer && <footer>{footer}</footer>}
    </div>
  );
};

export default Layout;
