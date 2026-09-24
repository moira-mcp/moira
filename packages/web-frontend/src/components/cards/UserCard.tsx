/**
 * A user as a CardShell item: the name (or email) as the title, the email as the description,
 * states that matter (administrator, unverified, blocked, awaiting approval) as badges, and
 * verification, workflow count and sign-up date as the meta line. Handles 2 data interfaces via
 * normalizeUser().
 */

import React, { useMemo, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  Shield,
  CheckCircle,
  XCircle,
  Ban,
  GitBranch,
  Eye,
  Edit2,
  Trash2,
  UserCheck,
  Clock3,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { type NormalizedUser } from "./normalize-user";
import { formatDate } from "./format-utils";
import { CardShell, type CardAction } from "./CardShell";

interface UserCardProps {
  user: NormalizedUser;
  onClick?: (user: NormalizedUser) => void;
  onView?: (user: NormalizedUser) => void;
  onEdit?: (user: NormalizedUser) => void;
  onDelete?: (user: NormalizedUser) => void;
  onApprove?: (user: NormalizedUser) => void;
  accountApprovalEnabled?: boolean;
  approvalStatusRef?: RefObject<HTMLSpanElement | null>;
  compact?: boolean;
}

function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.split(" ");
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export const UserCard: React.FC<UserCardProps> = ({
  user,
  onClick,
  onView,
  onEdit,
  onDelete,
  onApprove,
  accountApprovalEnabled = false,
  approvalStatusRef,
  compact = false,
}) => {
  const { t } = useTranslation();

  const actions = useMemo(() => {
    const list: CardAction[] = [];
    if (onView)
      list.push({
        icon: <Eye className="w-3.5 h-3.5" />,
        label: t("common.view", { defaultValue: "View" }),
        onClick: () => onView(user),
      });
    if (onEdit)
      list.push({
        icon: <Edit2 className="w-3.5 h-3.5" />,
        label: t("common.edit", { defaultValue: "Edit" }),
        onClick: () => onEdit(user),
      });
    if (onDelete)
      list.push({
        icon: <Trash2 className="w-3.5 h-3.5" />,
        label: t("common.delete", { defaultValue: "Delete" }),
        onClick: () => onDelete(user),
        variant: "destructive",
      });
    if (accountApprovalEnabled && onApprove && user.approvedAt === null)
      list.unshift({
        icon: <UserCheck className="w-3.5 h-3.5" />,
        label: t("admin.userManagement.actions.approveAccessible", { email: user.email }),
        onClick: () => onApprove(user),
        variant: "success",
        testId: "approve-user-action",
      });
    return list;
  }, [onView, onEdit, onDelete, onApprove, accountApprovalEnabled, user, t]);

  const badge = "h-5 gap-1 px-1.5 text-[11px]";
  // Pending approval needs the administrator's attention and is a badge; an approved account is the
  // normal state and reads as a quiet fact. Either way it is the one focus target the approval
  // action returns to.
  const approval =
    accountApprovalEnabled && user.approvedAt !== undefined
      ? user.approvedAt === null
        ? "pending"
        : "approved"
      : null;
  const approvalStatus = approval && (
    <span
      ref={approvalStatusRef}
      tabIndex={-1}
      data-testid="approval-list-focus-target"
      className="rounded-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      {approval === "pending" ? (
        <Badge
          variant="outline"
          className={cn(badge, "border-warning/30 text-warning")}
          data-testid="approval-status-pending"
        >
          <Clock3 className="size-3" aria-hidden="true" />
          {t("admin.userManagement.status.pendingApproval")}
        </Badge>
      ) : (
        <span
          className="inline-flex items-center gap-1 text-success"
          data-testid="approval-status-approved"
        >
          <UserCheck className="size-3" aria-hidden="true" />
          {t("admin.userManagement.status.approved")}
        </span>
      )}
    </span>
  );
  return (
    <CardShell
      compact={compact}
      onClick={onClick ? () => onClick(user) : undefined}
      actions={actions}
      className={cn(user.blocked && "opacity-60")}
      testId="user-card"
      icon={
        <Avatar className="size-5">
          <AvatarFallback className="bg-primary text-[9px] text-primary-foreground">
            {getInitials(user.name, user.email)}
          </AvatarFallback>
        </Avatar>
      }
      title={user.name || user.email}
      description={user.name ? user.email : undefined}
      badges={
        <>
          {user.isAdmin && (
            <Badge className={cn(badge, "border-warning/30 bg-warning/10 text-warning")}>
              <Shield className="size-3" aria-hidden="true" />
              {t("common.admin", { defaultValue: "Admin" })}
            </Badge>
          )}
          {user.emailVerified === false && (
            <Badge
              variant="outline"
              className={cn(badge, "border-destructive/30 text-destructive")}
            >
              <XCircle className="size-3" aria-hidden="true" />
              {t("common.unverified", { defaultValue: "Unverified" })}
            </Badge>
          )}
          {user.blocked && (
            <Badge
              variant="outline"
              className={cn(badge, "border-destructive/30 text-destructive")}
            >
              <Ban className="size-3" aria-hidden="true" />
              {t("common.blocked", { defaultValue: "Blocked" })}
            </Badge>
          )}
          {approval === "pending" && approvalStatus}
        </>
      }
      meta={
        <>
          {approval === "approved" && approvalStatus}
          {user.emailVerified && (
            <span className="inline-flex items-center gap-1 text-success">
              <CheckCircle className="size-3" aria-hidden="true" />
              {t("common.verified", { defaultValue: "Verified" })}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" aria-hidden="true" />
            {user.workflowsCount}
          </span>
          <span>{formatDate(user.createdAt)}</span>
        </>
      }
    />
  );
};
