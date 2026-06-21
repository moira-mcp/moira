/**
 * Shared layout for authentication pages.
 * Centered card with optional LanguageSwitcher.
 */

import React from "react";
import { LanguageSwitcher } from "./LanguageSwitcher";

interface AuthLayoutProps {
  children: React.ReactNode;
  /** Max width class (default: max-w-sm) */
  maxWidth?: string;
  /** Show language switcher in top-right corner */
  showLanguageSwitcher?: boolean;
}

export const AuthLayout: React.FC<AuthLayoutProps> = ({
  children,
  maxWidth = "max-w-sm",
  showLanguageSwitcher = true,
}) => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      {showLanguageSwitcher && (
        <div className="absolute top-4 right-4">
          <LanguageSwitcher />
        </div>
      )}
      <div className={`w-full ${maxWidth}`}>{children}</div>
    </div>
  );
};
