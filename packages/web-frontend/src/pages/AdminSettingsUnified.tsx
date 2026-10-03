/**
 * Admin Settings Unified Page
 * Combines Values (AdminSettings), Definitions (SystemSettings), and Maintenance
 * into a single tabbed interface at /admin/settings
 */

import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { PageHeader } from "@/components/page-header";
import { BookOpen, SlidersHorizontal, Wrench, Cloud } from "lucide-react";
import { AdminSettings } from "./AdminSettings";
import { SystemSettings, MaintenanceContent } from "./SystemSettings";
import { AdminCodespaceControls } from "./AdminCodespaceControls";

interface AdminSettingsUnifiedProps {
  defaultTab?: string;
}

export const AdminSettingsUnified: React.FC<AdminSettingsUnifiedProps> = ({
  defaultTab = "definitions",
}) => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabs = [
    { id: "definitions", icon: BookOpen },
    { id: "values", icon: SlidersHorizontal },
    { id: "maintenance", icon: Wrench },
    { id: "codespaces", icon: Cloud },
  ];
  const requestedTab = searchParams.get("tab") || defaultTab;
  const activeTab = tabs.some((tab) => tab.id === requestedTab) ? requestedTab : "definitions";
  const [visited, setVisited] = useState<string[]>([activeTab]);
  useEffect(() => {
    setVisited((current) => (current.includes(activeTab) ? current : [...current, activeTab]));
  }, [activeTab]);

  const handleTabChange = (value: string) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8">
      <PageHeader title={t("admin.settingsUnified.title")} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsNav
          items={tabs.map((tab) => ({ ...tab, label: t(`admin.settingsUnified.tabs.${tab.id}`) }))}
          active={activeTab}
          onSelect={handleTabChange}
          label={t("admin.settingsRegions.navLabel")}
          testIdPrefix="admin-settings-nav"
          getHref={(id) => {
            const next = new URLSearchParams(searchParams);
            next.set("tab", id);
            return `?${next}`;
          }}
        />
        <div className="min-w-0 space-y-8">
          {tabs
            .filter((tab) => visited.includes(tab.id) || tab.id === activeTab)
            .map((tab) => (
              <div key={tab.id} hidden={tab.id !== activeTab}>
                <SettingsSection
                  id={`admin-settings-${tab.id}`}
                  icon={tab.icon}
                  title={t(`admin.settingsUnified.tabs.${tab.id}`)}
                  description={t(`admin.settingsRegions.${tab.id}Description`)}
                  data-testid={`tab-${tab.id}`}
                >
                  {tab.id === "definitions" ? (
                    <SystemSettings embedded hideMaintenance active={tab.id === activeTab} />
                  ) : tab.id === "values" ? (
                    <AdminSettings embedded active={tab.id === activeTab} />
                  ) : tab.id === "maintenance" ? (
                    <MaintenanceContent />
                  ) : (
                    <AdminCodespaceControls active={tab.id === activeTab} />
                  )}
                </SettingsSection>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};
