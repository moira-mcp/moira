/**
 * An API token as a CardShell item for the administrator's token list: its name as the title with
 * its prefix beside it, whose token it is as the description, and when it was created, expires and
 * was last used as the meta line. Only a state that needs attention — revoked or expired — carries
 * a badge; revoking is the action while the token still works.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Ban, KeyRound, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "./format-utils";
import { CardShell } from "./CardShell";

export interface TokenCardData {
  id: string;
  name: string;
  tokenPrefix: string;
  userEmail: string;
  userName: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  isExpired: boolean;
  isRevoked: boolean;
}

interface TokenCardProps {
  token: TokenCardData;
  onRevoke?: (token: TokenCardData) => void;
  compact?: boolean;
}

const BADGE = "h-5 px-1.5 text-[11px]";

export const TokenCard: React.FC<TokenCardProps> = ({ token, onRevoke, compact = false }) => {
  const { t } = useTranslation();
  return (
    <CardShell
      compact={compact}
      testId={`token-row-${token.id}`}
      icon={<KeyRound aria-hidden="true" />}
      title={<span data-testid="token-name">{token.name}</span>}
      titleAside={
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono" data-testid="token-prefix">
          {token.tokenPrefix}...
        </code>
      }
      description={
        <span className="inline-flex items-center gap-1">
          <User className="size-3.5" aria-hidden="true" />
          <span data-testid="token-user">{token.userEmail}</span>
          {token.userName && <span className="text-muted-foreground/60">({token.userName})</span>}
        </span>
      }
      badges={
        token.isRevoked ? (
          <Badge variant="outline" className={`${BADGE} border-destructive/30 text-destructive`}>
            {t("admin.tokens.statusRevoked")}
          </Badge>
        ) : token.isExpired ? (
          <Badge variant="outline" className={`${BADGE} border-warning/30 text-warning`}>
            {t("admin.tokens.statusExpired")}
          </Badge>
        ) : undefined
      }
      meta={
        <>
          <span>
            {t("admin.tokens.created")}: {formatDate(token.createdAt)}
          </span>
          {token.expiresAt && (
            <span>
              {t("admin.tokens.expires")}: {formatDate(token.expiresAt)}
            </span>
          )}
          {token.lastUsedAt && (
            <span>
              {t("admin.tokens.lastUsed")}: {formatDate(token.lastUsedAt)}
            </span>
          )}
        </>
      }
      actions={
        token.isRevoked || !onRevoke
          ? []
          : [
              {
                icon: <Ban className="h-3.5 w-3.5" />,
                label: t("admin.tokens.revoke"),
                onClick: () => onRevoke(token),
                variant: "destructive",
                testId: `revoke-token-${token.id}`,
              },
            ]
      }
    />
  );
};
