/**
 * User Card Component
 * Displays user info in list (compact) or grid mode using CardShell
 * Handles 2 data interfaces via normalizeUser()
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Shield, CheckCircle, XCircle, Ban, GitBranch, Eye, Edit2, Trash2 } from "lucide-react";
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
    return list;
  }, [onView, onEdit, onDelete, user, t]);

  if (compact) {
    return (
      <CardShell
        compact
        onClick={() => onClick?.(user)}
        actions={actions}
        className={cn(user.blocked && "opacity-60")}
        testId="user-card"
      >
        <div className="flex items-start gap-3">
          <Avatar className="w-8 h-8 flex-shrink-0">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs">
              {getInitials(user.name, user.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm text-foreground truncate">
              {user.name || user.email}
            </p>
            {user.name && <p className="text-xs text-muted-foreground truncate">{user.email}</p>}
          </div>
        </div>

        <div className="flex items-center gap-1 mt-auto flex-wrap">
          {user.isAdmin && (
            <Badge className="text-[10px] px-1 py-0 h-4 bg-warning/10 text-warning border-warning/30">
              <Shield className="w-3 h-3 mr-0.5" />
              {t("common.admin", { defaultValue: "Admin" })}
            </Badge>
          )}
          {user.emailVerified !== undefined &&
            (user.emailVerified ? (
              <Badge
                variant="outline"
                className="text-[10px] px-1 py-0 h-4 border-success/30 text-success"
              >
                <CheckCircle className="w-3 h-3 mr-0.5" />
                {t("common.verified", { defaultValue: "Verified" })}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive"
              >
                <XCircle className="w-3 h-3 mr-0.5" />
                {t("common.unverified", { defaultValue: "Unverified" })}
              </Badge>
            ))}
          {user.blocked && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive"
            >
              <Ban className="w-3 h-3 mr-0.5" />
              {t("common.blocked", { defaultValue: "Blocked" })}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto flex items-center gap-0.5">
            <GitBranch className="w-3 h-3" />
            {user.workflowsCount}
          </span>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      onClick={() => onClick?.(user)}
      actions={actions}
      className={cn(user.blocked && "opacity-60")}
      testId="user-card"
    >
      <Avatar className="w-6 h-6 flex-shrink-0">
        <AvatarFallback className="bg-primary text-primary-foreground text-[10px]">
          {getInitials(user.name, user.email)}
        </AvatarFallback>
      </Avatar>

      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="font-medium text-sm text-foreground truncate">
          {user.name || user.email}
        </span>
        {user.name && (
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">
            {user.email}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        {user.isAdmin && (
          <Badge className="text-[10px] px-1 py-0 h-4 bg-warning/10 text-warning border-warning/30">
            <Shield className="w-3 h-3" />
          </Badge>
        )}
        {user.blocked && (
          <Badge
            variant="outline"
            className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive"
          >
            <Ban className="w-3 h-3" />
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
          <GitBranch className="w-3 h-3" />
          {user.workflowsCount}
        </span>
        <span className="text-[10px] text-muted-foreground hidden sm:block">
          {formatDate(user.createdAt)}
        </span>
      </div>
    </CardShell>
  );
};
