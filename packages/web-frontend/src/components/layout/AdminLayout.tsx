/**
 * Admin Layout
 * Layout for /admin/* routes - admin panel for system management
 */

import React from "react";
import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar, type NavRoute } from "./AppSidebar";
import { AnimatedPage } from "../AnimatedPage";
import { ROUTES } from "../../constants/routes";

export const AdminLayout: React.FC = () => {
  const { t } = useTranslation();

  const ADMIN_ROUTES: NavRoute[] = [
    { path: ROUTES.ADMIN, label: t("layout.adminNav.dashboard"), icon: "📊" },
    {
      path: ROUTES.ADMIN_USERS,
      label: t("layout.adminNav.users"),
      icon: "👥",
      multiUserAdmin: true,
    },
    {
      path: ROUTES.ADMIN_EXECUTIONS,
      label: t("layout.adminNav.executions"),
      icon: "🔄",
      multiUserAdmin: true,
    },
    {
      path: ROUTES.ADMIN_WORKFLOWS,
      label: t("layout.adminNav.workflows"),
      icon: "📋",
      multiUserAdmin: true,
    },
    {
      path: `${ROUTES.ADMIN}/artifacts`,
      label: t("layout.adminNav.artifacts"),
      icon: "📦",
      multiUserAdmin: true,
    },
    {
      path: `${ROUTES.ADMIN}/artifacts/reported`,
      label: t("layout.adminNav.reportedArtifacts"),
      icon: "🚩",
      multiUserAdmin: true,
    },
    { path: `${ROUTES.ADMIN}/audit-log`, label: t("layout.adminNav.auditLog"), icon: "📋" },
    { path: ROUTES.ADMIN_TOKENS, label: t("layout.adminNav.tokens"), icon: "🔑" },
    { path: ROUTES.ADMIN_SETTINGS, label: t("layout.adminNav.settingsManager"), icon: "⚙️" },
    {
      path: ROUTES.ADMIN_DELETED_WORKFLOWS,
      label: t("layout.adminNav.deletedWorkflows"),
      icon: "🗑️",
    },
    { path: ROUTES.ADMIN_MONITORING_TEST, label: t("layout.adminNav.monitoringTest"), icon: "📡" },
    {
      path: `${ROUTES.ADMIN}/operational`,
      label: t("layout.adminNav.operational"),
      icon: "⚡",
    },
    {
      path: ROUTES.DASHBOARD,
      label: t("layout.adminNav.backToApp"),
      icon: "←",
      external: true,
      sameWindow: true,
    },
  ];

  return (
    <SidebarProvider>
      <AppSidebar routes={ADMIN_ROUTES} isAdmin={true} title="Admin Panel" />
      <SidebarInset className="flex flex-col h-screen overflow-hidden">
        {/* Mobile header with sidebar trigger */}
        <header className="flex md:hidden items-center h-14 px-4 border-b bg-background shrink-0">
          <SidebarTrigger className="min-h-[44px] min-w-[44px]" />
          <span className="ml-2 font-semibold">Admin Panel</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <AnimatedPage>
            <Outlet />
          </AnimatedPage>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};
