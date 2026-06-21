import React from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import { Button } from "@/components/ui/button";

export const ThemeToggle: React.FC = () => {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={cycleTheme}
      className="gap-2"
      title={`Theme: ${theme}`}
    >
      <Icon className="w-4 h-4" />
      <span className="text-xs capitalize">{theme}</span>
    </Button>
  );
};
