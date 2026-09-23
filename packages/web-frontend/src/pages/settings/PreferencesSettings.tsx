/**
 * How the website looks and speaks for this reader: the colour theme and the interface language,
 * wired to the same state the rest of the application uses (the theme provider and i18next), so a
 * change here is the change everywhere. Both are kept in this browser.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { LANGUAGES } from "@/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const THEMES = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

export function PreferencesSettings(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = i18n.language?.slice(0, 2) || "en";

  return (
    <Card>
      <CardContent className="divide-y p-0">
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
          <div className="space-y-0.5">
            <p className="text-sm font-medium" id="preferences-theme-label">
              {t("pages.settings.preferences.theme")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("pages.settings.preferences.themeDescription")}
            </p>
          </div>
          <div
            role="group"
            aria-labelledby="preferences-theme-label"
            className="inline-flex rounded-lg border bg-muted/40 p-1"
            data-testid="preferences-theme"
          >
            {THEMES.map(({ value, icon: Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
                data-testid={`preferences-theme-${value}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  theme === value
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {t(`pages.settings.preferences.themes.${value}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
          <div className="space-y-0.5">
            <Label htmlFor="preferences-language" className="text-sm font-medium">
              {t("pages.settings.preferences.language")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("pages.settings.preferences.languageDescription")}
            </p>
          </div>
          <Select value={language} onValueChange={(code) => void i18n.changeLanguage(code)}>
            <SelectTrigger
              id="preferences-language"
              className="w-44"
              data-testid="preferences-language"
            >
              <Languages className="size-4 text-muted-foreground" aria-hidden="true" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map(({ code, flag }) => (
                <SelectItem key={code} value={code}>
                  <span aria-hidden="true">{flag}</span> {t(`layout.languages.${code}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
