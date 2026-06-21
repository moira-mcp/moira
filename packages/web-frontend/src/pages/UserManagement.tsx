/**
 * User Management Page
 * Admin panel for managing users at /admin/users
 */

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { useDynamicPageSize } from "../hooks/useDynamicPageSize";
import { useDebounce } from "../hooks/useDebounce";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageShell } from "@/components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { DataListView } from "@/components/DataListView";
import { UserCard, normalizeUser } from "@/components/cards";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface User {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  emailVerified: boolean;
  blocked: boolean;
  createdAt: string;
  workflowsCount: number;
}

export const UserManagement: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<{ id: string; email: string } | null>(null);

  // Edit dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; isAdmin: boolean }>({
    name: "",
    isAdmin: false,
  });

  const { pageSize, containerRef } = useDynamicPageSize();

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (currentPage - 1) * pageSize;
      const usersData = await apiClient.getAdminUsers({
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset,
      });
      setUsers(usersData.users);
      setTotal(usersData.total);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [currentPage, pageSize, debouncedSearch, t]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleEdit = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (!user) return;
    setEditUser(user);
    setEditForm({ name: user.name || "", isAdmin: user.isAdmin });
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;
    try {
      await apiClient.updateUser(editUser.id, editForm);
      setEditDialogOpen(false);
      setEditUser(null);
      await loadUsers();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update user";
      toast.error(message);
    }
  };

  const handleDeleteClick = (userId: string, email: string) => {
    setUserToDelete({ id: userId, email });
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!userToDelete) return;
    try {
      await apiClient.deleteUser(userToDelete.id);
      setUserToDelete(null);
      await loadUsers();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete user";
      toast.error(message);
      throw err;
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  if (loading && users.length === 0) {
    return <PageShell title={t("admin.userManagement.title")} loading />;
  }

  if (error) {
    return <PageShell title={t("admin.userManagement.title")} error={error} onRetry={loadUsers} />;
  }

  return (
    <PageShell title={t("admin.userManagement.title")}>
      <FilterBar
        search={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder={t("admin.userManagement.searchPlaceholder")}
        searchTestId="user-management-search"
        onReset={() => {
          setSearchTerm("");
          setCurrentPage(1);
        }}
      />

      <DataListView
        items={users}
        renderCard={(user, viewMode) => (
          <UserCard
            user={normalizeUser(user)}
            compact={viewMode === "grid"}
            onClick={() => navigate(`${ROUTES.ADMIN_USERS}/${user.id}`)}
            onView={() => navigate(`${ROUTES.ADMIN_USERS}/${user.id}`)}
            onEdit={() => handleEdit(user.id)}
            onDelete={() => handleDeleteClick(user.id, user.email)}
          />
        )}
        keyExtractor={(u) => u.id}
        storageKey="user-management-view-mode"
        loading={loading}
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          pageSize,
          totalItems: total,
          onPageChange: setCurrentPage,
        }}
        emptyIcon={Users}
        emptyTitle={
          searchTerm ? t("admin.userManagement.noSearchResults") : t("admin.userManagement.noUsers")
        }
        className="flex-1 min-h-0 flex flex-col"
      />

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("admin.userManagement.actions.edit")} — {editUser?.email}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium text-foreground">
                {t("admin.userManagement.table.name")}
              </label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className="mt-1"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={editForm.isAdmin}
                onCheckedChange={(checked) =>
                  setEditForm({ ...editForm, isAdmin: checked === true })
                }
              />
              <span className="text-sm">{t("admin.userManagement.role.admin")}</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              {t("admin.userManagement.actions.cancel")}
            </Button>
            <Button onClick={handleSaveEdit}>{t("admin.userManagement.actions.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("admin.userManagement.actions.delete")}
        description={t("admin.userManagement.confirmDelete", { email: userToDelete?.email })}
        confirmLabel={t("admin.userManagement.actions.delete")}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="destructive"
        onConfirm={handleDeleteConfirm}
      />
    </PageShell>
  );
};
