// Note: console.warn used for browser debugging of theme persistence failures
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  actualTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Get system theme immediately
  const getSystemTheme = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  const [theme, setTheme] = useState<Theme>(() => {
    // Initialize from localStorage synchronously to avoid flash
    const stored = localStorage.getItem("theme") as Theme;
    if (stored && (stored === "light" || stored === "dark" || stored === "system")) {
      return stored;
    }
    return "system";
  });
  const [actualTheme, setActualTheme] = useState<"light" | "dark">(getSystemTheme());

  // Apply theme to DOM immediately and on changes
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (theme === "system") {
      const systemTheme = getSystemTheme();
      root.classList.add(systemTheme);
      setActualTheme(systemTheme);
    } else {
      root.classList.add(theme);
      setActualTheme(theme);
    }

    // Save to localStorage
    localStorage.setItem("theme", theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, actualTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
