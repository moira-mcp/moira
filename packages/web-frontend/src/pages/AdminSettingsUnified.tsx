/**
 * Admin Settings Unified Page
 * Combines Values (AdminSettings), Definitions (SystemSettings), and Maintenance
 * into a single tabbed interface at /admin/settings
 */

import React from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminSettings } from "./AdminSettings";
import { SystemSettings, MaintenanceContent } from "./SystemSettings";

interface AdminSettingsUnifiedProps {
  defaultTab?: string;
}

export const AdminSettingsUnified: React.FC<AdminSettingsUnifiedProps> = ({
  defaultTab = "definitions",
}) => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || defaultTab;

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value }, { replace: true });
  };

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold text-foreground mb-6">
        {t("admin.settingsUnified.title")}
      </h1>
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="definitions" data-testid="tab-definitions">
            {t("admin.settingsUnified.tabs.definitions")}
          </TabsTrigger>
          <TabsTrigger value="values" data-testid="tab-values">
            {t("admin.settingsUnified.tabs.values")}
          </TabsTrigger>
          <TabsTrigger value="maintenance" data-testid="tab-maintenance">
            {t("admin.settingsUnified.tabs.maintenance")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="definitions" className="mt-6">
          <SystemSettings embedded hideMaintenance />
        </TabsContent>
        <TabsContent value="values" className="mt-6">
          <AdminSettings embedded />
        </TabsContent>
        <TabsContent value="maintenance" className="mt-6">
          <MaintenanceContent />
        </TabsContent>
      </Tabs>
    </div>
  );
};
