/* eslint-disable no-console */
/**
 * Admin Page
 * Admin panel with tabs for Settings Definitions, Users, System Stats
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "../services/api-client";
import { UserCard } from "@/components/cards/UserCard";
import { normalizeUser } from "@/components/cards/normalize-user";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "../components/PageShell";
import { PageLoader } from "@/components/page-loader";
import { ConfirmDialog } from "../components/confirm-dialog";

interface SettingDefinition {
  key: string;
  type: string;
  category: string;
  label: string;
  description: string | null;
  defaultValue: string | null;
  required: boolean;
  validation: string | null;
  adminOnly: boolean;
}

interface SystemStats {
  totalWorkflows: number;
  totalExecutions: number;
  totalDefinitions: number;
}

interface User {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  createdAt: string;
  workflowsCount: number;
}

type TabType = "definitions" | "users" | "stats";

export const Admin: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabType>("definitions");
  const [definitions, setDefinitions] = useState<SettingDefinition[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [_editingKey, setEditingKey] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<SettingDefinition>>({});
  const [deleteKey, setDeleteKey] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab === "definitions") {
      loadDefinitions();
    } else if (activeTab === "users") {
      loadUsers();
    } else if (activeTab === "stats") {
      loadStats();
    }
  }, [activeTab]);

  const loadDefinitions = async () => {
    setLoading(true);
    try {
      const defs = await apiClient.getSettingDefinitions();
      setDefinitions(defs);
    } catch (error) {
      console.error("Failed to load definitions:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    setLoading(true);
    try {
      const usersData = await apiClient.getAdminUsers();
      setUsers(usersData.users);
    } catch (error) {
      console.error("Failed to load users:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    setLoading(true);
    try {
      const statsData = await apiClient.getAdminStats();
      setStats(statsData);
    } catch (error) {
      console.error("Failed to load stats:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDefinition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.key || !formData.type || !formData.category || !formData.label) {
      toast.error(t("admin.panel.definitions.fillRequired"));
      return;
    }
    try {
      await apiClient.createSettingDefinition(
        formData as Required<Pick<SettingDefinition, "key" | "type" | "category" | "label">> &
          Partial<SettingDefinition>,
      );
      setFormData({});
      setEditingKey(null);
      await loadDefinitions();
    } catch (error) {
      console.error("Failed to create definition:", error);
    }
  };

  const handleDeleteDefinition = async (key: string) => {
    setDeleteKey(key);
  };

  const confirmDeleteDefinition = async () => {
    if (!deleteKey) return;
    try {
      await apiClient.deleteSettingDefinition(deleteKey);
      await loadDefinitions();
    } catch (error) {
      console.error("Failed to delete definition:", error);
    } finally {
      setDeleteKey(null);
    }
  };

  const _startEdit = (def: SettingDefinition) => {
    setEditingKey(def.key);
    setFormData(def);
  };

  const _cancelEdit = () => {
    setEditingKey(null);
    setFormData({});
  };

  return (
    <>
      <PageShell title={t("admin.panel.title")}>
        {/* Tabs */}
        <div className="border-b border-border mb-6">
          <div className="flex gap-4">
            <button
              className={`px-4 py-2 border-b-2 transition-colors ${
                activeTab === "definitions"
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("definitions")}
            >
              {t("admin.panel.tabs.definitions")}
            </button>
            <button
              className={`px-4 py-2 border-b-2 transition-colors ${
                activeTab === "users"
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("users")}
            >
              {t("admin.panel.tabs.users")}
            </button>
            <button
              className={`px-4 py-2 border-b-2 transition-colors ${
                activeTab === "stats"
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("stats")}
            >
              {t("admin.panel.tabs.stats")}
            </button>
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === "definitions" && (
          <div>
            <h2 className="text-2xl font-semibold mb-4">{t("admin.panel.definitions.title")}</h2>

            {/* Create New Form */}
            <div className="bg-card border border-border rounded-lg p-4 mb-6">
              <h3 className="font-medium mb-3">{t("admin.panel.definitions.createNew")}</h3>
              <form onSubmit={handleCreateDefinition} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    placeholder={t("admin.panel.definitions.keyPlaceholder")}
                    className="px-3 py-2 border border-border rounded bg-background"
                    value={formData.key || ""}
                    onChange={(e) => setFormData({ ...formData, key: e.target.value })}
                    required
                  />
                  <select
                    className="px-3 py-2 border border-border rounded bg-background"
                    value={formData.type || ""}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                    required
                  >
                    <option value="">{t("admin.panel.definitions.selectType")}</option>
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="encrypted">encrypted</option>
                  </select>
                  <input
                    type="text"
                    placeholder={t("admin.panel.definitions.categoryPlaceholder")}
                    className="px-3 py-2 border border-border rounded bg-background"
                    value={formData.category || ""}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                    required
                  />
                  <input
                    type="text"
                    placeholder={t("admin.panel.definitions.labelPlaceholder")}
                    className="px-3 py-2 border border-border rounded bg-background"
                    value={formData.label || ""}
                    onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                    required
                  />
                </div>
                <input
                  type="text"
                  placeholder={t("admin.panel.definitions.descriptionPlaceholder")}
                  className="w-full px-3 py-2 border border-border rounded bg-background"
                  value={formData.description || ""}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
                <div className="flex gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.required || false}
                      onChange={(e) => setFormData({ ...formData, required: e.target.checked })}
                    />
                    <span className="text-sm">{t("admin.panel.definitions.required")}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.adminOnly || false}
                      onChange={(e) => setFormData({ ...formData, adminOnly: e.target.checked })}
                    />
                    <span className="text-sm">{t("admin.panel.definitions.adminOnly")}</span>
                  </label>
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
                >
                  {t("admin.panel.definitions.createButton")}
                </button>
              </form>
            </div>

            {/* Definitions List */}
            {loading ? (
              <p className="text-muted-foreground">{t("admin.panel.loading")}</p>
            ) : (
              <div className="space-y-2">
                {definitions.map((def) => (
                  <div key={def.key} className="bg-card border border-border rounded-lg p-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-medium">{def.key}</div>
                        <div className="text-sm text-muted-foreground">
                          {t("admin.panel.definitions.type")}: {def.type} |{" "}
                          {t("admin.panel.definitions.category")}: {def.category}
                        </div>
                        {def.description && (
                          <div className="text-sm text-muted-foreground mt-1">
                            {def.description}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground mt-1">
                          {def.required && (
                            <span className="mr-2">• {t("admin.panel.definitions.required")}</span>
                          )}
                          {def.adminOnly && <span>• {t("admin.panel.definitions.adminOnly")}</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteDefinition(def.key)}
                        className="px-3 py-1 text-sm bg-destructive text-destructive-foreground rounded hover:bg-destructive/90"
                      >
                        {t("admin.panel.definitions.delete")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "users" && (
          <div>
            <h2 className="text-2xl font-semibold mb-4">{t("admin.panel.users.title")}</h2>
            {loading ? (
              <PageLoader />
            ) : users.length === 0 ? (
              <EmptyState
                title={t("admin.panel.users.noUsers")}
                description={t("admin.panel.users.title")}
              />
            ) : (
              <div className="space-y-0">
                {users.map((user) => (
                  <UserCard key={user.id} user={normalizeUser(user)} />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "stats" && (
          <div>
            <h2 className="text-2xl font-semibold mb-4">{t("admin.panel.stats.title")}</h2>
            {loading ? (
              <p className="text-muted-foreground">{t("admin.panel.loading")}</p>
            ) : stats ? (
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-card border border-border rounded-lg p-6">
                  <div className="text-3xl font-bold">{stats.totalWorkflows}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("admin.panel.stats.totalWorkflows")}
                  </div>
                </div>
                <div className="bg-card border border-border rounded-lg p-6">
                  <div className="text-3xl font-bold">{stats.totalExecutions}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("admin.panel.stats.totalExecutions")}
                  </div>
                </div>
                <div className="bg-card border border-border rounded-lg p-6">
                  <div className="text-3xl font-bold">{stats.totalDefinitions}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("admin.panel.stats.settingDefinitions")}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">{t("admin.panel.stats.failedToLoad")}</p>
            )}
          </div>
        )}
      </PageShell>

      <ConfirmDialog
        open={!!deleteKey}
        onOpenChange={(open) => !open && setDeleteKey(null)}
        title={t("admin.panel.definitions.confirmDeleteTitle", {
          defaultValue: "Delete Definition",
        })}
        description={t("admin.panel.definitions.confirmDelete", { key: deleteKey })}
        confirmLabel={t("common.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="destructive"
        onConfirm={confirmDeleteDefinition}
      />
    </>
  );
};
