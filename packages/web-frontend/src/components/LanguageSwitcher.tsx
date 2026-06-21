/**
 * Universal Language Switcher Component
 * Used on auth pages (standalone) and in UserMenu (as menu item)
 * Reads language config from centralized i18n.ts
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LANGUAGES } from "../i18n";

export type LanguageSwitcherVariant = "button" | "menu-item";

interface LanguageSwitcherProps {
  className?: string;
  variant?: LanguageSwitcherVariant;
  buttonVariant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  showLabel?: boolean;
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({
  className = "",
  variant = "button",
  buttonVariant = "ghost",
  size = "sm",
  showLabel = true,
}) => {
  const { t, i18n } = useTranslation();

  const getCurrentLanguageCode = () => {
    return i18n.language?.substring(0, 2) || "en";
  };

  const getCurrentLanguage = () => {
    const code = getCurrentLanguageCode();
    return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
  };

  const cycleLanguage = () => {
    const currentCode = getCurrentLanguageCode();
    const currentIndex = LANGUAGES.findIndex((l) => l.code === currentCode);
    const nextIndex = (currentIndex + 1) % LANGUAGES.length;
    i18n.changeLanguage(LANGUAGES[nextIndex].code);
  };

  const currentLang = getCurrentLanguage();
  const currentLabel = t(`layout.languages.${currentLang.code}`);

  // Menu item variant - for use in dropdowns (UserMenu)
  if (variant === "menu-item") {
    return (
      <div className={`flex items-center cursor-pointer ${className}`} onClick={cycleLanguage}>
        <span className="mr-2">{currentLang.flag}</span>
        <span>
          {t("layout.userMenu.language")}: {currentLabel}
        </span>
      </div>
    );
  }

  // Button variant - for standalone use on auth pages
  return (
    <Button
      variant={buttonVariant}
      size={size}
      onClick={cycleLanguage}
      className={className}
      title={t("layout.userMenu.language")}
    >
      <span className="text-base mr-1">{currentLang.flag}</span>
      {showLabel && <span className="text-xs uppercase">{getCurrentLanguageCode()}</span>}
    </Button>
  );
};
