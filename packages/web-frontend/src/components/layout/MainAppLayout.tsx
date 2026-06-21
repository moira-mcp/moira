/**
 * Main App Layout
 * Layout for /* routes - main application for all users
 * Handles beta agreement modal and warning banner
 */

import React, { useState, useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../services/api-client";
import { BetaAgreementModal } from "../BetaAgreementModal";
import { BetaWarningBanner } from "../BetaWarningBanner";
import { AnimatedPage } from "../AnimatedPage";
import { useBetaAgreement } from "../../hooks/useBetaAgreement";
import { useSession, signOut } from "../../auth/better-auth-client";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar, type NavRoute } from "./AppSidebar";
import { ROUTES, APP_PREFIX } from "../../constants/routes";

export const MainAppLayout: React.FC = () => {
  const { t, i18n } = useTranslation();

  // Get docs path based on current language (default to /docs/ for English)
  const getDocsPath = () => {
    const lang = i18n.language?.substring(0, 2);
    return lang === "ru" ? "/ru/docs/" : "/docs/";
  };

  const MAIN_APP_ROUTES: NavRoute[] = [
    { path: ROUTES.DASHBOARD, label: t("layout.nav.home"), icon: "🏠" },
    { path: ROUTES.WORKFLOWS, label: t("layout.nav.workflows"), icon: "⚡" },
    { path: ROUTES.EXECUTIONS, label: t("layout.nav.executions"), icon: "📊" },
    { path: ROUTES.NOTES, label: t("layout.nav.notes"), icon: "📝" },
    { path: `${APP_PREFIX}/artifacts`, label: t("layout.nav.artifacts"), icon: "📄" },
    { path: ROUTES.SETTINGS, label: t("layout.userMenu.settings"), icon: "⚙️" },
    { path: ROUTES.ADMIN, label: t("layout.nav.admin"), icon: "🔧", adminOnly: true },
    {
      path: getDocsPath(),
      label: t("layout.nav.docs"),
      icon: "📚",
      external: true,
      sameWindow: true,
    },
  ];

  const [isAdmin, setIsAdmin] = useState(false);
  const navigate = useNavigate();
  const { data: session } = useSession();

  const { showModal, acceptAgreement, declineAgreement, showBanner, dismissBanner } =
    useBetaAgreement(!!session?.user);

  // Fetch admin status once on mount
  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const userInfo = await apiClient.getUserInfo();
        setIsAdmin(userInfo.isAdmin);
      } catch (error) {
        setIsAdmin(false);
      }
    };

    fetchUserInfo();
  }, []);

  const handleDecline = async () => {
    declineAgreement();
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  return (
    <>
      <BetaAgreementModal open={showModal} onAccept={acceptAgreement} onDecline={handleDecline} />

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md"
      >
        {t("accessibility.skipToContent", { defaultValue: "Skip to main content" })}
      </a>

      <SidebarProvider>
        <AppSidebar routes={MAIN_APP_ROUTES} isAdmin={isAdmin} />
        <SidebarInset className="flex flex-col h-screen overflow-hidden">
          {/* Mobile header with sidebar trigger */}
          <header className="flex md:hidden items-center h-14 px-4 border-b bg-background shrink-0">
            <SidebarTrigger className="min-h-[44px] min-w-[44px]" />
            <span className="ml-2 font-semibold">MCP Moira</span>
          </header>
          <main id="main-content" className="flex-1 overflow-y-auto">
            <AnimatedPage>
              <Outlet />
            </AnimatedPage>
          </main>
          {showBanner && <BetaWarningBanner onDismiss={dismissBanner} />}
        </SidebarInset>
      </SidebarProvider>
    </>
  );
};
