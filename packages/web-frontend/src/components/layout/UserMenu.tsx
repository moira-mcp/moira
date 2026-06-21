/**
 * User Menu Dropdown Component
 * Avatar-based dropdown menu with user info, theme toggle, settings, logout
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { useSession, signOut } from "../../auth/better-auth-client";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../../hooks/useTheme";
import { Moon, Sun, Monitor, LogOut } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROUTES } from "../../constants/routes";
import { LanguageSwitcher } from "../LanguageSwitcher";

interface UserMenuProps {
  compact?: boolean;
}

export const UserMenu: React.FC<UserMenuProps> = ({ compact = false }) => {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  const handleLogout = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const cycleTheme = () => {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };

  const getInitials = (name?: string, email?: string) => {
    if (name) {
      const parts = name.split(" ");
      if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    return "U";
  };

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  if (!session?.user) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`flex items-center focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-lg p-2 hover:bg-sidebar-accent transition-colors ${
            compact ? "justify-center w-full" : "gap-3 w-full"
          }`}
        >
          <Avatar className="w-8 h-8 cursor-pointer flex-shrink-0">
            <AvatarFallback className="bg-primary text-primary-foreground text-sm">
              {getInitials(session.user.name, session.user.email)}
            </AvatarFallback>
          </Avatar>
          {!compact && (
            <div className="flex flex-col items-start text-left flex-1 min-w-0">
              <p className="text-sm font-medium leading-none truncate w-full text-sidebar-foreground">
                {session.user.name || t("layout.userMenu.user")}
              </p>
              <p className="text-xs text-muted-foreground leading-none mt-1 truncate w-full">
                {session.user.email}
              </p>
            </div>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">
              {session.user.name || t("layout.userMenu.user")}
            </p>
            <p className="text-xs leading-none text-muted-foreground">{session.user.email}</p>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={cycleTheme} className="cursor-pointer">
          <ThemeIcon className="mr-2 h-4 w-4" />
          <span>
            {t("layout.userMenu.theme")}: {theme}
          </span>
        </DropdownMenuItem>

        <DropdownMenuItem className="cursor-pointer p-0">
          <LanguageSwitcher variant="menu-item" className="w-full px-2 py-1.5" />
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleLogout} className="cursor-pointer">
          <LogOut className="mr-2 h-4 w-4" />
          <span>{t("layout.userMenu.logout")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
