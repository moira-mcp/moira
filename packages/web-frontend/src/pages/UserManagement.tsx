/**
 * User Management Page
 * Admin panel for managing users at /admin/users
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { useListPageSize } from "../hooks/useListPageSize";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { useDebounce } from "../hooks/useDebounce";
import { useFeatures } from "../hooks/useFeatures";
import { useReadOwnerGuard } from "../auth/ReadScopeBoundary";
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

type User = Awaited<ReturnType<typeof apiClient.getAdminUsers>>["users"][number];

export const UserManagement: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isEnabled } = useFeatures();
  const accountApprovalEnabled = isEnabled("accountApproval");
  const captureOwner = useReadOwnerGuard();
  const [accepted, setAccepted] = useState<{
    users: User[];
    total: number;
    page: number;
    pageSize: number;
    search: string;
  } | null>(null);
  const users = accepted?.users ?? [];
  const total = accepted?.total ?? 0;
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<{ id: string; email: string } | null>(null);
  const [userToApprove, setUserToApprove] = useState<{ id: string; email: string } | null>(null);
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const approvalStatusRef = useRef<HTMLSpanElement>(null);

  // Edit dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editForm, setEditForm] = useState<{ name: string; isAdmin: boolean }>({
    name: "",
    isAdmin: false,
  });

  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  const beginRequest = useLatestRequest();
  const loadUsers = useCallback(async () => {
    const isCurrent = beginRequest();
    setLoading(true);
    try {
      const offset = (currentPage - 1) * pageSize;
      const usersData = await apiClient.getAdminUsers({
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset,
      });
      if (!isCurrent()) return;
      setAccepted({
        users: usersData.users,
        total: usersData.total,
        page: currentPage,
        pageSize,
        search: debouncedSearch,
      });
      setError(null);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, currentPage, pageSize, debouncedSearch, t]);
  const loadUsersRef = useRef(loadUsers);
  loadUsersRef.current = loadUsers;

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
      setSavingEdit(true);
      await apiClient.updateUser(editUser.id, editForm);
      setEditDialogOpen(false);
      setEditUser(null);
      await loadUsers();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToUpdate");
      toast.error(message);
    } finally {
      setSavingEdit(false);
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
      const message = err instanceof Error ? err.message : t("common.errors.failedToDelete");
      toast.error(message);
      throw err;
    }
  };

  const handleApproveClick = (userId: string, email: string) => {
    if (!accountApprovalEnabled) return;
    setUserToApprove({ id: userId, email });
    setApproveDialogOpen(true);
  };

  const handleApproveConfirm = async () => {
    if (!accountApprovalEnabled || !userToApprove) return;
    const ownsOperation = captureOwner(false);
    const ownsAuthority = captureOwner();
    try {
      const result = await apiClient.approveUser(userToApprove.id);
      if (!ownsOperation()) return;
      beginRequest();
      setAccepted((current) =>
        current
          ? {
              ...current,
              users: current.users.map((user) =>
                user.id === userToApprove.id ? { ...user, approvedAt: result.approvedAt } : user,
              ),
            }
          : current,
      );
      if (ownsAuthority()) {
        toast.success(t("admin.userManagement.approvalSuccess", { email: userToApprove.email }));
      }
      await loadUsersRef.current();
    } catch (err: unknown) {
      if (!ownsOperation()) return;
      if (ownsAuthority()) toast.error(t("admin.userManagement.approvalError"));
      throw err;
    }
  };

  const totalPages = Math.ceil(total / (accepted?.pageSize ?? pageSize));

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
        onViewModeChange={onViewModeChange}
        items={users}
        renderCard={(user, viewMode) => (
          <UserCard
            user={normalizeUser(user)}
            compact={viewMode === "grid"}
            onClick={() => navigate(`${ROUTES.ADMIN_USERS}/${user.id}`)}
            onView={() => navigate(`${ROUTES.ADMIN_USERS}/${user.id}`)}
            onEdit={() => handleEdit(user.id)}
            onDelete={() => handleDeleteClick(user.id, user.email)}
            onApprove={
              accountApprovalEnabled ? () => handleApproveClick(user.id, user.email) : undefined
            }
            accountApprovalEnabled={accountApprovalEnabled}
            approvalStatusRef={userToApprove?.id === user.id ? approvalStatusRef : undefined}
          />
        )}
        keyExtractor={(u) => u.id}
        storageKey="user-management-view-mode"
        loading={loading}
        hasResult={accepted !== null}
        error={error}
        onRetry={loadUsers}
        onRefresh={loadUsers}
        resultScope={
          accepted && (
            <span>
              {t("common.pagination.page", {
                current: accepted.page,
                total: Math.max(1, totalPages),
              })}
              {accepted.search && (
                <>
                  {" "}
                  · {t("common.filters.search")}: {accepted.search}
                </>
              )}
            </span>
          )
        }
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage: accepted?.page ?? currentPage,
          totalPages,
          pageSize: accepted?.pageSize ?? pageSize,
          totalItems: total,
          onPageChange: setCurrentPage,
        }}
        emptyIcon={Users}
        emptyTitle={
          accepted?.search
            ? t("admin.userManagement.noSearchResults")
            : t("admin.userManagement.noUsers")
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
              <label htmlFor="admin-user-edit-name" className="text-sm font-medium text-foreground">
                {t("admin.userManagement.table.name")}
              </label>
              <Input
                id="admin-user-edit-name"
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
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit ? t("common.saving") : t("admin.userManagement.actions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={accountApprovalEnabled && approveDialogOpen}
        onOpenChange={setApproveDialogOpen}
        title={t("admin.userManagement.actions.approve")}
        description={t("admin.userManagement.confirmApprove", { email: userToApprove?.email })}
        confirmLabel={t("admin.userManagement.actions.approve")}
        cancelLabel={t("common.cancel")}
        onConfirm={handleApproveConfirm}
        onReturnFocus={() => {
          approvalStatusRef.current?.focus();
          setUserToApprove(null);
        }}
      />

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
